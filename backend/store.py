"""Durable, versioned state transitions for one local household.

Every mutating operation is a short SQLite transaction. Model/network work stays
outside these transactions; organize() compares the version again at commit.
Family review acknowledges record accuracy and cannot clear clinical concerns.
"""
from __future__ import annotations

import hashlib
import base64
import hmac
import json
import math
import secrets
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat()


def uid(prefix=''):
    return prefix + str(uuid.uuid4())


try:
    from .safety import scan_danger, reconcile_safety, document_needs_review
except ImportError:
    from safety import scan_danger, reconcile_safety, document_needs_review

class StoreError(RuntimeError):
    status = 400


class NotFound(StoreError):
    status = 404


class Conflict(StoreError):
    status = 409


class Unauthorized(StoreError):
    status = 401


class Forbidden(StoreError):
    status = 403


SOURCES = {
    'elder', 'family_observation', 'family_report', 'caregiver',
    'clinician_evidence', 'document', 'audio_transcript', 'system', 'unknown',
}
MEDIA_KINDS = {'audio', 'image'}
MEDIA_SAVE_STATES = {'uploading', 'saved', 'failed'}
MEDIA_RECOGNITION_STATES = {
    'not_started', 'processing', 'succeeded', 'failed', 'interrupted',
}
MEDIA_LINK_STATES = {'not_linked', 'pending', 'linked', 'link_failed'}
RECOGNITION_FAILURES = {
    'provider_mock': ('当前是模拟识别，不能生成真实转写', True),
    'provider_not_configured': ('识别服务未配置', False),
    'unsupported_format': ('不支持的媒体类型或格式', False),
    'invalid_media': ('媒体文件无效或无法读取', False),
    'limit_exceeded': ('媒体超过当前识别服务的资源限制', False),
    'no_text_detected': ('没有识别到可用文字', False),
    'provider_timeout': ('识别服务超时，可稍后重试', True),
    'provider_unavailable': ('识别服务暂时不可用，可稍后重试', True),
    'provider_auth_failed': ('识别服务鉴权失败，请检查配置', False),
    'provider_rate_limited': ('识别服务请求过于频繁，可稍后重试', True),
    'invalid_provider_response': ('识别服务返回了无法使用的结果', False),
    'incomplete_provider_response': ('识别返回被截断，未作为完整结果保存；原件仍保留，可重试', True),
}
SNAPSHOT_FIELDS = (
    'record_id', 'raw_text', 'source_kind', 'actor_name', 'occurred_time',
    'recorded_at', 'state', 'version', 'draft', 'result_meta', 'review_notes',
    'local_safety', 'source_review',
    'related_record_ids', 'supersedes_id', 'confirmation_scope',
)


def expected_version(value):
    # bool is an int subclass; it must never count as version 1.
    if type(value) is not int or value < 1:
        raise StoreError('expected_version_must_positive_integer')
    return value


def text_field(value, name, maximum, required=True):
    if value is None and not required:
        return None
    if not isinstance(value, str) or (required and not value.strip()):
        raise StoreError(name + '_required')
    if len(value) > maximum:
        raise StoreError(name + '_too_long')
    return value


class SQLiteStore:
    # Local transition defaults.  These values are deliberately explicit so a
    # later PostgreSQL service can carry the same account policy forward.
    PASSWORD_ALGORITHM = 'pbkdf2_sha256'
    PASSWORD_ITERATIONS = 310_000
    PASSWORD_SALT_BYTES = 16
    MAX_LOGIN_FAILURES = 5
    LOCKOUT_SECONDS = 15 * 60

    def __init__(self, path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.init()

    def conn(self):
        c = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        try:
            c.row_factory = sqlite3.Row
            c.execute('PRAGMA foreign_keys=ON')
            c.execute('PRAGMA busy_timeout=10000')
            return c
        except BaseException:
            c.close()
            raise

    @contextmanager
    def connection(self):
        c = self.conn()
        try:
            yield c
        except BaseException:
            if c.in_transaction:
                c.rollback()
            raise
        finally:
            c.close()

    @contextmanager
    def transaction(self):
        # BEGIN IMMEDIATE also serializes writers from separate processes or
        # distinct Store instances; the Python lock alone is insufficient.
        with self.lock, self.connection() as c:
            c.execute('BEGIN IMMEDIATE')
            yield c
            c.commit()

    def init(self):
        with self.lock, self.connection() as c:
            c.execute('PRAGMA journal_mode=WAL')
            c.executescript('''
                CREATE TABLE IF NOT EXISTS events (
                    record_id TEXT PRIMARY KEY,
                    raw_text TEXT NOT NULL, source_kind TEXT NOT NULL,
                    actor_name TEXT NOT NULL, occurred_time TEXT,
                    recorded_at TEXT NOT NULL, state TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1, draft_json TEXT,
                    result_meta_json TEXT, review_notes TEXT,
                    related_record_ids_json TEXT, supersedes_id TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    FOREIGN KEY(supersedes_id) REFERENCES events(record_id)
                );
                CREATE TABLE IF NOT EXISTS revisions (
                    revision_id TEXT PRIMARY KEY, record_id TEXT NOT NULL,
                    action TEXT NOT NULL, version INTEGER NOT NULL,
                    snapshot_json TEXT NOT NULL, actor_name TEXT, at TEXT NOT NULL,
                    FOREIGN KEY(record_id) REFERENCES events(record_id)
                );
                CREATE TABLE IF NOT EXISTS audit (
                    audit_id TEXT PRIMARY KEY, record_id TEXT, action TEXT NOT NULL,
                    version INTEGER, actor_name TEXT, at TEXT NOT NULL,
                    details_json TEXT
                );
                CREATE TABLE IF NOT EXISTS idempotency (
                    idem_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
                    record_id TEXT NOT NULL,
                    FOREIGN KEY(record_id) REFERENCES events(record_id)
                );
                CREATE TABLE IF NOT EXISTS handoffs (
                    handoff_id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    household_id TEXT
                );
                CREATE TABLE IF NOT EXISTS households (
                    household_id TEXT PRIMARY KEY, name TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS users (
                    user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
                    external_key TEXT UNIQUE, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS household_members (
                    household_id TEXT NOT NULL, user_id TEXT NOT NULL,
                    role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (household_id, user_id),
                    FOREIGN KEY(household_id) REFERENCES households(household_id),
                    FOREIGN KEY(user_id) REFERENCES users(user_id)
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
                    household_id TEXT NOT NULL, expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL, revoked_at TEXT,
                    FOREIGN KEY(user_id) REFERENCES users(user_id),
                    FOREIGN KEY(household_id) REFERENCES households(household_id)
                );
                CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
                CREATE UNIQUE INDEX IF NOT EXISTS one_revision_per_version
                    ON revisions(record_id, version);
                CREATE UNIQUE INDEX IF NOT EXISTS one_replacement_per_event
                    ON events(supersedes_id) WHERE supersedes_id IS NOT NULL;
                CREATE INDEX IF NOT EXISTS event_creation_order
                    ON events(recorded_at, created_at);
                CREATE INDEX IF NOT EXISTS audit_event_order
                    ON audit(record_id, at);
                CREATE TABLE IF NOT EXISTS media (
                    media_id TEXT PRIMARY KEY,
                    household_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    content_type TEXT NOT NULL,
                    original_filename TEXT NOT NULL,
                    actor_name TEXT NOT NULL DEFAULT '老人',
                    occurred_time TEXT,
                    save_status TEXT NOT NULL DEFAULT 'uploading',
                    recognition_status TEXT NOT NULL DEFAULT 'not_started',
                    link_status TEXT NOT NULL DEFAULT 'not_linked',
                    link_pending_reason TEXT,
                    version INTEGER NOT NULL DEFAULT 1,
                    size_bytes INTEGER,
                    sha256 TEXT,
                    relative_path TEXT,
                    saved_at TEXT,
                    safety_json TEXT,
                    current_attempt_id TEXT,
                    upload_error_code TEXT,
                    upload_error_message TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(household_id) REFERENCES households(household_id)
                );
                CREATE TABLE IF NOT EXISTS media_uploads (
                    upload_id TEXT PRIMARY KEY,
                    media_id TEXT NOT NULL UNIQUE,
                    idem_key TEXT NOT NULL UNIQUE,
                    payload_hash TEXT NOT NULL,
                    expected_parts INTEGER NOT NULL,
                    expected_size INTEGER,
                    expected_sha256 TEXT,
                    complete_idem_key TEXT,
                    complete_payload_hash TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(media_id) REFERENCES media(media_id)
                );
                CREATE TABLE IF NOT EXISTS media_upload_parts (
                    upload_id TEXT NOT NULL,
                    part_index INTEGER NOT NULL,
                    idem_key TEXT,
                    relative_path TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(upload_id, part_index),
                    FOREIGN KEY(upload_id) REFERENCES media_uploads(upload_id)
                );
                CREATE TABLE IF NOT EXISTS media_upload_idempotency (
                    idem_key TEXT PRIMARY KEY,
                    payload_hash TEXT NOT NULL,
                    upload_id TEXT NOT NULL,
                    FOREIGN KEY(upload_id) REFERENCES media_uploads(upload_id)
                );
                CREATE TABLE IF NOT EXISTS recognition_attempts (
                    attempt_id TEXT PRIMARY KEY,
                    media_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    provider TEXT,
                    model TEXT,
                    is_mock INTEGER,
                    text TEXT,
                    error_code TEXT,
                    error_message TEXT,
                    retryable INTEGER,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(media_id) REFERENCES media(media_id)
                );
                CREATE TABLE IF NOT EXISTS recognition_requests (
                    idem_key TEXT PRIMARY KEY,
                    payload_hash TEXT NOT NULL,
                    attempt_id TEXT NOT NULL,
                    FOREIGN KEY(attempt_id) REFERENCES recognition_attempts(attempt_id)
                );
                CREATE TABLE IF NOT EXISTS media_event_links (
                    media_id TEXT PRIMARY KEY,
                    attempt_id TEXT NOT NULL UNIQUE,
                    record_id TEXT NOT NULL UNIQUE,
                    linked_at TEXT NOT NULL,
                    FOREIGN KEY(media_id) REFERENCES media(media_id),
                    FOREIGN KEY(attempt_id) REFERENCES recognition_attempts(attempt_id),
                    FOREIGN KEY(record_id) REFERENCES events(record_id)
                );
                CREATE INDEX IF NOT EXISTS media_creation_order
                    ON media(created_at, media_id);
                CREATE INDEX IF NOT EXISTS recognition_media_order
                    ON recognition_attempts(media_id, created_at, attempt_id);
                CREATE TRIGGER IF NOT EXISTS preserve_event_evidence
                BEFORE UPDATE OF raw_text, source_kind, actor_name, occurred_time,
                    recorded_at, related_record_ids_json, supersedes_id, created_at
                ON events BEGIN
                    SELECT RAISE(ABORT, 'event_evidence_immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS preserve_revision_update
                BEFORE UPDATE ON revisions BEGIN
                    SELECT RAISE(ABORT, 'revision_immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS preserve_revision_delete
                BEFORE DELETE ON revisions BEGIN
                    SELECT RAISE(ABORT, 'revision_immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS preserve_audit_update
                BEFORE UPDATE ON audit BEGIN
                    SELECT RAISE(ABORT, 'audit_immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS preserve_audit_delete
                BEFORE DELETE ON audit BEGIN
                    SELECT RAISE(ABORT, 'audit_immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS preserve_handoff_update
                BEFORE UPDATE ON handoffs BEGIN
                    SELECT RAISE(ABORT, 'handoff_immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS preserve_handoff_delete
                BEFORE DELETE ON handoffs BEGIN
                    SELECT RAISE(ABORT, 'handoff_immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS preserve_saved_media_original
                BEFORE UPDATE OF household_id,kind,content_type,original_filename,
                    size_bytes,sha256,relative_path,created_at ON media
                WHEN OLD.save_status='saved' BEGIN
                    SELECT RAISE(ABORT, 'media_original_immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS preserve_media_part_update
                BEFORE UPDATE ON media_upload_parts BEGIN
                    SELECT RAISE(ABORT, 'media_part_immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS preserve_media_part_delete
                BEFORE DELETE ON media_upload_parts BEGIN
                    SELECT RAISE(ABORT, 'media_part_immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS preserve_final_recognition
                BEFORE UPDATE ON recognition_attempts
                WHEN OLD.status IN ('succeeded','failed','interrupted') BEGIN
                    SELECT RAISE(ABORT, 'recognition_attempt_immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS preserve_media_event_link_update
                BEFORE UPDATE ON media_event_links BEGIN
                    SELECT RAISE(ABORT, 'media_event_link_immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS preserve_media_event_link_delete
                BEFORE DELETE ON media_event_links BEGIN
                    SELECT RAISE(ABORT, 'media_event_link_immutable');
                END;
            ''')
            # Existing databases predate household ownership. Add the nullable
            # column and attach old records to a deterministic local household.
            cols = {r['name'] for r in c.execute('PRAGMA table_info(events)')}
            if 'safety_json' not in cols:
                c.execute('ALTER TABLE events ADD COLUMN safety_json TEXT')
            if 'household_id' not in cols:
                c.execute('ALTER TABLE events ADD COLUMN household_id TEXT')
            if 'source_review_json' not in cols:
                c.execute('ALTER TABLE events ADD COLUMN source_review_json TEXT')
            # Account credentials were added after the first local auth
            # prototype.  Migrate in place and never store a raw password.
            user_cols = {r['name'] for r in c.execute('PRAGMA table_info(users)')}
            migrations = (
                ('password_hash', 'TEXT'),
                ('password_salt', 'TEXT'),
                ('password_iterations', 'INTEGER NOT NULL DEFAULT 0'),
                ('password_algorithm', "TEXT NOT NULL DEFAULT 'legacy'"),
                ('failed_attempts', 'INTEGER NOT NULL DEFAULT 0'),
                ('locked_until', 'TEXT'),
                ('last_login_at', 'TEXT'),
            )
            for column, declaration in migrations:
                if column not in user_cols:
                    c.execute(f'ALTER TABLE users ADD COLUMN {column} {declaration}')
            if c.execute("SELECT 1 FROM households WHERE household_id='hh_local_default'").fetchone() is None:
                at = now(); hid = 'hh_local_default'; uid0 = 'usr_local_default'
                c.execute('INSERT OR IGNORE INTO households VALUES(?,?,?)', (hid, '本地默认家庭', at))
                c.execute('''INSERT OR IGNORE INTO users(
                    user_id,display_name,external_key,created_at,password_hash,password_salt,
                    password_iterations,password_algorithm,failed_attempts,locked_until,last_login_at
                ) VALUES(?,?,?,?,NULL,NULL,0,'legacy',0,NULL,NULL)''',
                          (uid0, '本地用户', 'local-default', at))
                c.execute('INSERT OR IGNORE INTO household_members VALUES(?,?,?,?,?)', (hid, uid0, 'owner', 'active', at))
            c.execute("UPDATE events SET household_id='hh_local_default' WHERE household_id IS NULL")
            hcols = {r['name'] for r in c.execute('PRAGMA table_info(handoffs)')}
            if 'household_id' not in hcols:
                c.execute('ALTER TABLE handoffs ADD COLUMN household_id TEXT')

            media_cols = {r['name'] for r in c.execute('PRAGMA table_info(media)')}
            media_migrations = (
                ('actor_name', "TEXT NOT NULL DEFAULT '老人'"),
                ('occurred_time', 'TEXT'),
                ('link_pending_reason', 'TEXT'),
                ('saved_at', 'TEXT'),
                ('safety_json', 'TEXT'),
            )
            for column, declaration in media_migrations:
                if column not in media_cols:
                    c.execute(f'ALTER TABLE media ADD COLUMN {column} {declaration}')
            upload_cols = {r['name'] for r in c.execute('PRAGMA table_info(media_uploads)')}
            for column, declaration in (
                ('expected_size', 'INTEGER'),
                ('expected_sha256', 'TEXT'),
                ('complete_idem_key', 'TEXT'),
                ('complete_payload_hash', 'TEXT'),
            ):
                if column not in upload_cols:
                    c.execute(f'ALTER TABLE media_uploads ADD COLUMN {column} {declaration}')
            part_cols = {r['name'] for r in c.execute('PRAGMA table_info(media_upload_parts)')}
            if 'idem_key' not in part_cols:
                c.execute('ALTER TABLE media_upload_parts ADD COLUMN idem_key TEXT')

            # Keep original evidence immutable after publication, including the
            # actor and occurrence time captured before the upload completed.
            c.execute('DROP TRIGGER IF EXISTS preserve_saved_media_original')
            c.execute('''CREATE TRIGGER preserve_saved_media_original
                BEFORE UPDATE OF household_id,kind,content_type,original_filename,
                    actor_name,occurred_time,size_bytes,sha256,relative_path,
                    saved_at,created_at ON media
                WHEN OLD.save_status='saved' BEGIN
                    SELECT RAISE(ABORT, 'media_original_immutable');
                END''')

            # A process cannot know whether an in-flight external recognition
            # finished while it was down. Preserve that uncertainty explicitly;
            # callers may retry with a new idempotency key after inspecting it.
            interrupted_at = now()
            c.execute('BEGIN IMMEDIATE')
            c.execute('''UPDATE recognition_attempts
                SET status='interrupted',finished_at=? WHERE status='processing' ''',
                      (interrupted_at,))
            c.execute('''UPDATE media SET recognition_status='interrupted',
                version=version+1,updated_at=? WHERE recognition_status='processing' ''',
                      (interrupted_at,))
            c.commit()

    @staticmethod
    def dec(row):
        if row is None:
            return None
        event = dict(row)
        for db_field, field in (
            ('draft_json', 'draft'), ('result_meta_json', 'result_meta'),
            ('related_record_ids_json', 'related_record_ids'),
            ('source_review_json', 'source_review'),
        ):
            raw = event.pop(db_field, None)
            event[field] = json.loads(raw) if raw else ([] if field == 'related_record_ids' else None)
        saved_safety = event.pop('safety_json', None)
        event['local_safety'] = reconcile_safety(event['raw_text'], json.loads(saved_safety) if saved_safety else None)
        event['confirmation_scope'] = 'record_accuracy' if event['state'] == 'recorded' else None
        return event

    @staticmethod
    def snap(event):
        return {k: event.get(k) for k in SNAPSHOT_FIELDS}

    def rev(self, c, event, action, actor):
        c.execute('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)', (
            uid('rev_'), event['record_id'], action, event['version'],
            json.dumps(self.snap(event), ensure_ascii=False), actor, now(),
        ))

    def aud(self, c, rid, action, version, actor, details=None):
        c.execute('INSERT INTO audit VALUES(?,?,?,?,?,?,?)', (
            uid('aud_'), rid, action, version, actor, now(),
            json.dumps(details or {}, ensure_ascii=False),
        ))

    @staticmethod
    def exists(c, rid):
        return c.execute('SELECT 1 FROM events WHERE record_id=?', (rid,)).fetchone() is not None

    def _get(self, c, rid):
        event = self.dec(c.execute('SELECT * FROM events WHERE record_id=?', (rid,)).fetchone())
        if event is None:
            raise NotFound('event_not_found')
        previous, seen = event.get('supersedes_id'), {rid}
        while previous and previous not in seen and event['source_kind'] != 'document':
            seen.add(previous)
            ancestor = c.execute('SELECT source_kind,supersedes_id FROM events WHERE record_id=?', (previous,)).fetchone()
            if ancestor is None:
                break
            if ancestor['source_kind'] == 'document':
                event.update(source_kind='document')
            previous = ancestor['supersedes_id']
        return event

    def _versioned(self, c, rid, expected):
        event = self._get(c, rid)
        if event['version'] != expected:
            raise Conflict('stale_version')
        return event

    @staticmethod
    def _payload(payload):
        if not isinstance(payload, dict):
            raise StoreError('body_must_object')
        if 'recorded_at' in payload:
            raise StoreError('recorded_at_read_only')
        text_field(payload.get('raw_text'), 'raw_text', 10000)
        text_field(payload.get('source_kind'), 'source_kind', 40)
        if payload['source_kind'] not in SOURCES:
            raise StoreError('invalid_source_kind')
        text_field(payload.get('actor_name'), 'actor_name', 80)
        text_field(payload.get('occurred_time'), 'occurred_time', 120, required=False)
        related = payload.get('related_record_ids', [])
        if not isinstance(related, list) or len(related) > 10:
            raise StoreError('related_record_ids_must_bounded_list')
        if any(not isinstance(r, str) or not r or len(r) > 80 for r in related):
            raise StoreError('invalid_related_record_id')
        if len(related) != len(set(related)):
            raise StoreError('duplicate_related_record_id')
        return related

    def _insert(self, c, payload, related, supersedes_id=None, reason=None):
        at = now()
        rid = uid('rec_')
        c.execute('''INSERT INTO events
            (record_id,raw_text,source_kind,actor_name,occurred_time,recorded_at,
             state,version,draft_json,result_meta_json,review_notes,
             related_record_ids_json,supersedes_id,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
            rid, payload['raw_text'], payload['source_kind'], payload['actor_name'],
            payload.get('occurred_time'), at,
            'inbox', 1, None, None, reason, json.dumps(related), supersedes_id, at, at,
        ))
        safety = scan_danger(payload['raw_text'])
        c.execute('UPDATE events SET safety_json=? WHERE record_id=?', (json.dumps(safety, ensure_ascii=False), rid))
        return self._get(c, rid)

    def get(self, rid, household_id=None):
        with self.connection() as c:
            try:
                event = self._get(c, rid)
            except NotFound:
                return None
            return event if not household_id or event['household_id'] == household_id else None

    def list(self, household_id=None):
        with self.connection() as c:
            if household_id:
                return [self._get(c, r['record_id']) for r in c.execute('SELECT record_id FROM events WHERE household_id=? ORDER BY recorded_at,created_at,record_id', (household_id,))]
            return [self._get(c, r['record_id']) for r in c.execute('SELECT record_id FROM events ORDER BY recorded_at,created_at,record_id')]

    # --- Durable media ingestion and recognition state ---

    @staticmethod
    def _media_upload_payload(payload):
        if not isinstance(payload, dict):
            raise StoreError('body_must_object')
        kind = text_field(payload.get('kind'), 'kind', 20)
        if kind not in MEDIA_KINDS:
            raise StoreError('invalid_media_kind')
        content_type = text_field(payload.get('content_type'), 'content_type', 120)
        expected_prefix = 'audio/' if kind == 'audio' else 'image/'
        if not content_type.lower().startswith(expected_prefix):
            raise StoreError('content_type_kind_mismatch')
        filename = text_field(payload.get('original_filename'), 'original_filename', 255)
        if Path(filename).name != filename or '/' in filename or '\\' in filename or '\x00' in filename:
            raise StoreError('invalid_original_filename')
        actor_name = text_field(payload.get('actor_name', '老人'), 'actor_name', 80)
        occurred_time = text_field(
            payload.get('occurred_time'), 'occurred_time', 120, required=False,
        )
        parts = payload.get('total_parts', payload.get('expected_parts'))
        if type(parts) is not int or parts < 1:
            raise StoreError('expected_parts_must_positive_integer')
        expected_size = payload.get('expected_size')
        if expected_size not in (None, '') and (
            type(expected_size) is not int or expected_size < 1
        ):
            raise StoreError('expected_size_must_positive_integer')
        expected_sha256 = payload.get('expected_sha256')
        if expected_sha256 not in (None, ''):
            if not isinstance(expected_sha256, str) or len(expected_sha256) != 64 or any(
                ch not in '0123456789abcdef' for ch in expected_sha256.lower()
            ):
                raise StoreError('invalid_sha256')
            expected_sha256 = expected_sha256.lower()
        return {
            'kind': kind,
            'content_type': content_type,
            'original_filename': filename,
            'actor_name': actor_name,
            'occurred_time': occurred_time,
            'expected_parts': parts,
            'expected_size': expected_size,
            'expected_sha256': expected_sha256,
        }

    @staticmethod
    def _trusted_media_identifier(value, prefix):
        if not isinstance(value, str) or not value.startswith(prefix + '_') or len(value) > 100:
            raise StoreError('invalid_' + prefix + '_id')
        suffix = value[len(prefix) + 1:]
        if not suffix or any(ch not in '0123456789abcdef-' for ch in suffix.lower()):
            raise StoreError('invalid_' + prefix + '_id')
        return value

    @staticmethod
    def _media_sha256(value):
        if not isinstance(value, str) or len(value) != 64 or any(
            ch not in '0123456789abcdef' for ch in value.lower()
        ):
            raise StoreError('invalid_sha256')
        return value.lower()

    @staticmethod
    def _media_relative_path(value):
        if not isinstance(value, str) or not value or '\x00' in value:
            raise StoreError('invalid_storage_reference')
        path = Path(value)
        if path.is_absolute() or '..' in path.parts:
            raise StoreError('invalid_storage_reference')
        return path.as_posix()

    @staticmethod
    def _decode_attempt(row):
        if row is None:
            return None
        attempt = dict(row)
        if attempt.get('is_mock') is not None:
            attempt['is_mock'] = bool(attempt['is_mock'])
        if attempt.get('retryable') is not None:
            attempt['retryable'] = bool(attempt['retryable'])
        if attempt.get('error_code'):
            attempt['error'] = {
                'code': attempt['error_code'],
                'message': attempt['error_message'],
                'retryable': attempt['retryable'],
            }
        else:
            attempt['error'] = None
        return attempt

    def _decode_media(self, c, row):
        if row is None:
            return None
        media = dict(row)
        # Storage references are deliberately absent from the public media
        # representation. Trusted file code can request them separately.
        media.pop('relative_path', None)
        saved_safety = media.pop('safety_json', None)
        media['local_safety'] = json.loads(saved_safety) if saved_safety else None
        media['upload_status'] = media['save_status']
        upload = c.execute('''SELECT upload_id,expected_parts,expected_size,expected_sha256 FROM media_uploads
            WHERE media_id=?''', (media['media_id'],)).fetchone()
        media['upload_id'] = upload['upload_id'] if upload else None
        media['expected_parts'] = upload['expected_parts'] if upload else None
        media['expected_size'] = upload['expected_size'] if upload else None
        media['expected_sha256'] = upload['expected_sha256'] if upload else None
        if upload:
            media['uploaded_parts'] = c.execute('''SELECT COUNT(*) FROM media_upload_parts
                WHERE upload_id=?''', (upload['upload_id'],)).fetchone()[0]
        else:
            media['uploaded_parts'] = 0
        attempts = [self._decode_attempt(item) for item in c.execute('''
            SELECT * FROM recognition_attempts WHERE media_id=?
            ORDER BY created_at,attempt_id''', (media['media_id'],))]
        for item in attempts:
            item['local_safety'] = (
                media['local_safety']
                if item['attempt_id'] == media.get('current_attempt_id') else None
            )
        media['attempts'] = attempts
        attempt = next((item for item in attempts
                        if item['attempt_id'] == media.get('current_attempt_id')), None)
        media['recognition'] = attempt
        media['latest_attempt'] = attempt
        link = c.execute('SELECT record_id,attempt_id,linked_at FROM media_event_links WHERE media_id=?',
                         (media['media_id'],)).fetchone()
        media['event_link'] = dict(link) if link else None
        media['record_id'] = link['record_id'] if link else None
        return media

    def _get_media(self, c, media_id):
        media = self._decode_media(
            c, c.execute('SELECT * FROM media WHERE media_id=?', (media_id,)).fetchone(),
        )
        if media is None:
            raise NotFound('media_not_found')
        return media

    def create_media_upload(
        self, payload, key, household_id='hh_local_default', *,
        upload_id=None, media_id=None,
    ):
        normalized = self._media_upload_payload(payload)
        text_field(key, 'idempotency_key', 200)
        text_field(household_id, 'household_id', 100)
        if upload_id is not None:
            upload_id = self._trusted_media_identifier(upload_id, 'upload')
        if media_id is not None:
            media_id = self._trusted_media_identifier(media_id, 'media')
        identity = {'upload_id': upload_id, 'media_id': media_id}
        encoded = json.dumps({**normalized, **identity}, ensure_ascii=False, sort_keys=True,
                             separators=(',', ':'), allow_nan=False)
        digest = hashlib.sha256(encoded.encode()).hexdigest()
        with self.transaction() as c:
            prior = c.execute('SELECT * FROM media_uploads WHERE idem_key=?', (key,)).fetchone()
            if prior:
                if prior['payload_hash'] != digest:
                    raise Conflict('idempotency_key_payload_mismatch')
                return self._get_media(c, prior['media_id']), False
            if c.execute('SELECT 1 FROM households WHERE household_id=?',
                         (household_id,)).fetchone() is None:
                raise NotFound('household_not_found')
            at = now()
            media_id = media_id or 'media_' + uuid.uuid4().hex
            upload_id = upload_id or 'upload_' + uuid.uuid4().hex
            if c.execute('SELECT 1 FROM media WHERE media_id=?', (media_id,)).fetchone():
                raise Conflict('media_id_conflict')
            if c.execute('SELECT 1 FROM media_uploads WHERE upload_id=?', (upload_id,)).fetchone():
                raise Conflict('upload_id_conflict')
            c.execute('''INSERT INTO media(
                media_id,household_id,kind,content_type,original_filename,actor_name,
                occurred_time,
                save_status,recognition_status,link_status,version,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,'uploading','not_started','not_linked',1,?,?)''', (
                media_id, household_id, normalized['kind'], normalized['content_type'],
                normalized['original_filename'], normalized['actor_name'],
                normalized['occurred_time'], at, at,
            ))
            c.execute('''INSERT INTO media_uploads(
                upload_id,media_id,idem_key,payload_hash,expected_parts,expected_size,
                expected_sha256,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?)''', (
                upload_id, media_id, key, digest, normalized['expected_parts'],
                normalized['expected_size'], normalized['expected_sha256'], at, at,
            ))
            return self._get_media(c, media_id), True

    def record_media_part(
        self, upload_id, index, *, relative_path, size_bytes, sha256,
        idempotency_key=None,
    ):
        self._trusted_media_identifier(upload_id, 'upload')
        if type(index) is not int or index < 0:
            raise StoreError('invalid_part_index')
        if type(size_bytes) is not int or size_bytes < 1:
            raise StoreError('invalid_part_size')
        relative_path = self._media_relative_path(relative_path)
        sha256 = self._media_sha256(sha256)
        if idempotency_key is not None:
            text_field(idempotency_key, 'idempotency_key', 200)
        with self.transaction() as c:
            upload = c.execute('SELECT * FROM media_uploads WHERE upload_id=?',
                               (upload_id,)).fetchone()
            if upload is None:
                raise NotFound('upload_not_found')
            media = self._get_media(c, upload['media_id'])
            if media['save_status'] != 'uploading':
                raise Conflict('upload_not_open')
            if index >= upload['expected_parts']:
                raise StoreError('invalid_part_index')
            prior = c.execute('''SELECT * FROM media_upload_parts
                WHERE upload_id=? AND part_index=?''', (upload_id, index)).fetchone()
            if idempotency_key:
                keyed = c.execute('''SELECT * FROM media_upload_parts
                    WHERE upload_id=? AND idem_key=?''',
                    (upload_id, idempotency_key)).fetchone()
                if keyed and keyed['part_index'] != index:
                    raise Conflict('idempotency_key_payload_mismatch')
            public = {
                'upload_id': upload_id, 'index': index,
                'size_bytes': size_bytes, 'sha256': sha256,
            }
            if prior:
                if (
                    prior['relative_path'] != relative_path
                    or prior['size_bytes'] != size_bytes
                    or prior['sha256'] != sha256
                    or (idempotency_key and prior['idem_key'] not in (None, idempotency_key))
                ):
                    raise Conflict('media_part_conflict')
                public['created_at'] = prior['created_at']
                return public, False
            at = now()
            c.execute('''INSERT INTO media_upload_parts(
                upload_id,part_index,idem_key,relative_path,size_bytes,sha256,created_at
            ) VALUES(?,?,?,?,?,?,?)''', (
                upload_id, index, idempotency_key, relative_path, size_bytes, sha256, at,
            ))
            c.execute('''UPDATE media SET version=version+1,updated_at=?
                WHERE media_id=?''', (at, upload['media_id']))
            c.execute('UPDATE media_uploads SET updated_at=? WHERE upload_id=?',
                      (at, upload_id))
            public['created_at'] = at
            return public, True

    def complete_media_upload(
        self, upload_id, *, size_bytes, sha256, relative_path,
        content_type=None, saved_at=None, idempotency_key=None,
    ):
        self._trusted_media_identifier(upload_id, 'upload')
        if type(size_bytes) is not int or size_bytes < 1:
            raise StoreError('invalid_media_size')
        sha256 = self._media_sha256(sha256)
        relative_path = self._media_relative_path(relative_path)
        if saved_at is not None:
            saved_at = text_field(saved_at, 'saved_at', 120)
        if idempotency_key is not None:
            text_field(idempotency_key, 'idempotency_key', 200)
        complete_hash = hashlib.sha256(json.dumps({
            'upload_id': upload_id,
            'size_bytes': size_bytes,
            'sha256': sha256,
            'content_type': content_type,
        }, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        with self.transaction() as c:
            if idempotency_key is not None:
                prior_key = c.execute('''SELECT payload_hash,upload_id
                    FROM media_upload_idempotency WHERE idem_key=?''',
                                      (idempotency_key,)).fetchone()
                if prior_key:
                    if prior_key['payload_hash'] != complete_hash or prior_key['upload_id'] != upload_id:
                        raise Conflict('idempotency_key_payload_mismatch')
            upload = c.execute('SELECT * FROM media_uploads WHERE upload_id=?',
                               (upload_id,)).fetchone()
            if upload is None:
                raise NotFound('upload_not_found')
            media = self._get_media(c, upload['media_id'])
            final_type = content_type or media['content_type']
            text_field(final_type, 'content_type', 120)
            prefix = 'audio/' if media['kind'] == 'audio' else 'image/'
            if not final_type.lower().startswith(prefix):
                raise StoreError('content_type_kind_mismatch')
            if media['save_status'] == 'saved':
                if (
                    media['size_bytes'] != size_bytes
                    or media['sha256'] != sha256
                    or media['content_type'] != final_type
                ):
                    raise Conflict('completed_upload_conflict')
                if idempotency_key is not None:
                    prior_key = upload['complete_idem_key']
                    prior_hash = upload['complete_payload_hash']
                    if prior_key == idempotency_key and prior_hash not in (None, complete_hash):
                        raise Conflict('idempotency_key_payload_mismatch')
                    if prior_key is None:
                        c.execute('''UPDATE media_uploads SET complete_idem_key=?,
                            complete_payload_hash=?,updated_at=? WHERE upload_id=?''',
                                  (idempotency_key, complete_hash, now(), upload_id))
                return media, False
            if media['save_status'] != 'uploading':
                raise Conflict('upload_not_open')
            parts = list(c.execute('''SELECT part_index FROM media_upload_parts
                WHERE upload_id=? ORDER BY part_index''', (upload_id,)))
            if [row['part_index'] for row in parts] != list(range(upload['expected_parts'])):
                raise Conflict('upload_incomplete')
            at = saved_at or now()
            c.execute('''UPDATE media SET content_type=?,save_status='saved',
                size_bytes=?,sha256=?,relative_path=?,saved_at=?,version=version+1,
                updated_at=? WHERE media_id=?''', (
                final_type, size_bytes, sha256, relative_path, at, at,
                upload['media_id'],
            ))
            c.execute('UPDATE media_uploads SET updated_at=? WHERE upload_id=?',
                      (at, upload_id))
            if idempotency_key is not None:
                c.execute('''UPDATE media_uploads SET complete_idem_key=?,
                    complete_payload_hash=? WHERE upload_id=?''',
                          (idempotency_key, complete_hash, upload_id))
                c.execute('''INSERT OR IGNORE INTO media_upload_idempotency(
                    idem_key,payload_hash,upload_id) VALUES(?,?,?)''',
                          (idempotency_key, complete_hash, upload_id))
            return self._get_media(c, upload['media_id']), True

    def _media_recognition_result(self, c, media_id, action=None):
        media = self._get_media(c, media_id)
        result = {
            'accepted': True,
            'media': media,
            'attempt': media['latest_attempt'],
            'attempt_id': (
                media['latest_attempt']['attempt_id']
                if media['latest_attempt'] else None
            ),
        }
        if action is not None:
            result['action'] = action
        if media['event_link']:
            result['event'] = self._get(c, media['event_link']['record_id'])
            result['event_created'] = False
        return result

    def claim_media_recognition(
        self, media_id, *, expected_version, idempotency_key, actor,
    ):
        text_field(media_id, 'media_id', 100)
        expected = expected_version if type(expected_version) is int else None
        if expected is None or expected < 1:
            raise StoreError('expected_version_must_positive_integer')
        text_field(idempotency_key, 'idempotency_key', 200)
        text_field(actor, 'actor_name', 80)
        digest = hashlib.sha256(json.dumps({
            'media_id': media_id,
            'expected_version': expected,
            'actor': actor,
        }, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        with self.transaction() as c:
            prior = c.execute('''SELECT rr.payload_hash,ra.media_id
                FROM recognition_requests rr JOIN recognition_attempts ra
                ON ra.attempt_id=rr.attempt_id WHERE rr.idem_key=?''',
                (idempotency_key,)).fetchone()
            if prior:
                if prior['payload_hash'] != digest or prior['media_id'] != media_id:
                    raise Conflict('idempotency_key_payload_mismatch')
                return self._media_recognition_result(c, media_id, 'existing')
            media = self._get_media(c, media_id)
            if media['save_status'] != 'saved':
                raise Conflict('media_not_saved')
            current = media['latest_attempt']
            if media['recognition_status'] == 'processing' and current:
                c.execute('INSERT INTO recognition_requests VALUES(?,?,?)', (
                    idempotency_key, digest, current['attempt_id'],
                ))
                return self._media_recognition_result(c, media_id, 'existing')
            if media['recognition_status'] == 'succeeded' and current:
                c.execute('INSERT INTO recognition_requests VALUES(?,?,?)', (
                    idempotency_key, digest, current['attempt_id'],
                ))
                action = 'existing' if media['link_status'] == 'linked' else 'resume_link'
                return self._media_recognition_result(c, media_id, action)
            if (
                media['recognition_status'] == 'failed'
                and current and current['retryable'] is False
            ):
                raise Conflict('recognition_not_retryable')
            if media['version'] != expected:
                raise Conflict('stale_version')
            at = now()
            attempt_id = uid('attempt_')
            c.execute('''INSERT INTO recognition_attempts(
                attempt_id,media_id,status,started_at,created_at
            ) VALUES(?,?,'processing',?,?)''', (attempt_id, media_id, at, at))
            c.execute('INSERT INTO recognition_requests VALUES(?,?,?)', (
                idempotency_key, digest, attempt_id,
            ))
            c.execute('''UPDATE media SET recognition_status='processing',
                current_attempt_id=?,link_status='not_linked',link_pending_reason=NULL,
                safety_json=NULL,version=version+1,updated_at=? WHERE media_id=?''',
                (attempt_id, at, media_id))
            return self._media_recognition_result(c, media_id, 'claimed')

    def save_media_recognition_text(
        self, media_id, attempt_id, *, text, provider, model, is_mock, actor,
    ):
        text_field(media_id, 'media_id', 100)
        text_field(attempt_id, 'attempt_id', 100)
        text = text_field(text, 'recognition_text', 10_000_000)
        provider = text_field(provider, 'provider', 120)
        model = text_field(model, 'model', 200, required=False)
        if type(is_mock) is not bool:
            raise StoreError('is_mock_must_boolean')
        text_field(actor, 'actor_name', 80)
        with self.transaction() as c:
            media = self._get_media(c, media_id)
            attempt = c.execute('SELECT * FROM recognition_attempts WHERE attempt_id=?',
                                (attempt_id,)).fetchone()
            if (
                attempt is None or attempt['media_id'] != media_id
                or media['current_attempt_id'] != attempt_id
                or attempt['status'] != 'processing'
            ):
                raise Conflict('stale_recognition_attempt')
            at = now()
            c.execute('''UPDATE recognition_attempts SET status='succeeded',provider=?,
                model=?,is_mock=?,text=?,finished_at=? WHERE attempt_id=?''',
                (provider, model, int(is_mock), text, at, attempt_id))
            c.execute('''UPDATE media SET recognition_status='succeeded',
                link_status='pending',link_pending_reason='safety_scan_pending',
                version=version+1,updated_at=? WHERE media_id=?''', (at, media_id))
            return self._media_recognition_result(c, media_id)

    def save_media_recognition_safety(
        self, media_id, attempt_id, *, safety, actor,
    ):
        if not isinstance(safety, dict):
            raise StoreError('safety_must_object')
        text_field(actor, 'actor_name', 80)
        with self.transaction() as c:
            media = self._get_media(c, media_id)
            attempt = c.execute('SELECT * FROM recognition_attempts WHERE attempt_id=?',
                                (attempt_id,)).fetchone()
            if (
                attempt is None or attempt['media_id'] != media_id
                or media['current_attempt_id'] != attempt_id
                or attempt['status'] != 'succeeded' or not attempt['text']
            ):
                raise Conflict('stale_recognition_attempt')
            at = now()
            c.execute('''UPDATE media SET safety_json=?,link_status='pending',
                link_pending_reason='event_link_pending',version=version+1,
                updated_at=? WHERE media_id=?''',
                (json.dumps(safety, ensure_ascii=False), at, media_id))
            return self._media_recognition_result(c, media_id)

    def save_media_recognition_failure(
        self, media_id, attempt_id, *, code, message, retryable, actor,
    ):
        text_field(code, 'recognition_error_code', 120)
        text_field(actor, 'actor_name', 80)
        if type(retryable) is not bool:
            raise StoreError('retryable_must_boolean')
        public_message, expected_retryable = RECOGNITION_FAILURES.get(
            code, ('识别服务未能完成', retryable),
        )
        retryable = expected_retryable if code in RECOGNITION_FAILURES else retryable
        with self.transaction() as c:
            media = self._get_media(c, media_id)
            attempt = c.execute('SELECT * FROM recognition_attempts WHERE attempt_id=?',
                                (attempt_id,)).fetchone()
            if (
                attempt is None or attempt['media_id'] != media_id
                or media['current_attempt_id'] != attempt_id
                or attempt['status'] != 'processing'
            ):
                raise Conflict('stale_recognition_attempt')
            at = now()
            c.execute('''UPDATE recognition_attempts SET status='failed',error_code=?,
                error_message=?,retryable=?,finished_at=? WHERE attempt_id=?''',
                (code, public_message, int(retryable), at, attempt_id))
            c.execute('''UPDATE media SET recognition_status='failed',
                link_status='not_linked',link_pending_reason=NULL,
                version=version+1,updated_at=? WHERE media_id=?''', (at, media_id))
            return self._media_recognition_result(c, media_id)

    def create_and_link_media_event(
        self, media_id, attempt_id, *, payload, idempotency_key, actor,
        household_id, expected_version=None,
    ):
        text_field(idempotency_key, 'idempotency_key', 200)
        text_field(actor, 'actor_name', 80)
        text_field(household_id, 'household_id', 100)
        if not isinstance(payload, dict):
            raise StoreError('body_must_object')
        with self.transaction() as c:
            media = self._get_media(c, media_id)
            if media['household_id'] != household_id:
                raise Forbidden('household_access_denied')
            if media['event_link']:
                return self._media_recognition_result(c, media_id) | {'linked': True}
            if expected_version is not None:
                expected = expected_version if type(expected_version) is int else None
                if expected is None or expected < 1:
                    raise StoreError('expected_version_must_positive_integer')
                if media['version'] != expected:
                    raise Conflict('stale_version')
            attempt = c.execute('SELECT * FROM recognition_attempts WHERE attempt_id=?',
                                (attempt_id,)).fetchone()
            if (
                attempt is None or attempt['media_id'] != media_id
                or media['current_attempt_id'] != attempt_id
                or attempt['status'] != 'succeeded' or not attempt['text']
            ):
                raise Conflict('stale_recognition_attempt')
            if attempt['is_mock']:
                raise Conflict('mock_recognition_not_linkable')
            if media['local_safety'] is None:
                raise Conflict('safety_scan_required')
            if len(attempt['text']) > 10000:
                at = now()
                c.execute('''UPDATE media SET link_status='pending',
                    link_pending_reason='raw_text_too_long',version=version+1,
                    updated_at=? WHERE media_id=?''', (at, media_id))
                return self._media_recognition_result(c, media_id) | {'linked': False}
            event_payload = {
                'raw_text': attempt['text'],
                'source_kind': (
                    'audio_transcript' if media['kind'] == 'audio' else 'document'
                ),
                'actor_name': media['actor_name'],
                'occurred_time': media['occurred_time'],
                'related_record_ids': payload.get('related_record_ids', []),
            }
            try:
                related = self._payload(event_payload)
            except StoreError:
                at = now()
                c.execute('''UPDATE media SET link_status='pending',
                    link_pending_reason='event_validation_failed',version=version+1,
                    updated_at=? WHERE media_id=?''', (at, media_id))
                return self._media_recognition_result(c, media_id) | {'linked': False}
            for related_id in related:
                related_row = c.execute('''SELECT household_id FROM events
                    WHERE record_id=?''', (related_id,)).fetchone()
                if related_row is None:
                    raise NotFound('related_record_not_found')
                if related_row['household_id'] not in (None, household_id):
                    raise Forbidden('cross_household_reference_denied')
            event = self._insert(c, event_payload, related)
            c.execute('UPDATE events SET household_id=? WHERE record_id=?',
                      (household_id, event['record_id']))
            event = self._get(c, event['record_id'])
            self.rev(c, event, 'created', actor)
            self.aud(c, event['record_id'], 'created', 1, actor, {
                'idempotency_key': idempotency_key, 'media_id': media_id,
                'attempt_id': attempt_id,
            })
            digest = hashlib.sha256(
                json.dumps(event_payload, ensure_ascii=False, sort_keys=True,
                           separators=(',', ':')).encode()
            ).hexdigest()
            c.execute('INSERT INTO idempotency VALUES(?,?,?)',
                      (idempotency_key, digest, event['record_id']))
            at = now()
            c.execute('INSERT INTO media_event_links VALUES(?,?,?,?)',
                      (media_id, attempt_id, event['record_id'], at))
            c.execute('''UPDATE media SET link_status='linked',
                link_pending_reason=NULL,version=version+1,updated_at=?
                WHERE media_id=?''', (at, media_id))
            result = self._media_recognition_result(c, media_id)
            result.update(linked=True, event_created=True)
            return result

    def get_media(self, media_id, household_id=None):
        text_field(media_id, 'media_id', 100)
        with self.connection() as c:
            row = c.execute('SELECT * FROM media WHERE media_id=?', (media_id,)).fetchone()
            media = self._decode_media(c, row)
            if media is None or (household_id and media['household_id'] != household_id):
                return None
            return media

    def list_media(self, household_id=None):
        with self.connection() as c:
            if household_id:
                rows = c.execute('''SELECT * FROM media WHERE household_id=?
                    ORDER BY created_at,media_id''', (household_id,))
            else:
                rows = c.execute('SELECT * FROM media ORDER BY created_at,media_id')
            return [self._decode_media(c, row) for row in rows]

    def create(self, payload, key, actor='system', household_id='hh_local_default'):
        # Legacy callers may omit household_id; account-aware callers pass the
        # authenticated household explicitly and are checked by the API layer.
        text_field(household_id, 'household_id', 100)
        related = self._payload(payload)
        text_field(key, 'idempotency_key', 200)
        text_field(actor, 'actor_name', 80)
        try:
            encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise StoreError('invalid_json_payload') from exc
        digest = hashlib.sha256(encoded.encode()).hexdigest()
        with self.transaction() as c:
            prior = c.execute('SELECT * FROM idempotency WHERE idem_key=?', (key,)).fetchone()
            if prior:
                if prior['payload_hash'] != digest:
                    raise Conflict('idempotency_key_payload_mismatch')
                return self._get(c, prior['record_id']), False
            for r in related:
                rr = c.execute('SELECT household_id FROM events WHERE record_id=?', (r,)).fetchone()
                if rr is None: raise NotFound('related_record_not_found')
                if rr['household_id'] not in (None, household_id): raise Forbidden('cross_household_reference_denied')
            event = self._insert(c, payload, related)
            c.execute('UPDATE events SET household_id=? WHERE record_id=?', (household_id, event['record_id']))
            event['household_id'] = household_id
            self.rev(c, event, 'created', actor)
            self.aud(c, event['record_id'], 'created', 1, actor, {'idempotency_key': key})
            c.execute('INSERT INTO idempotency VALUES(?,?,?)', (key, digest, event['record_id']))
            return event, True

    # --- Household identity and authorization (local SQLite transition layer) ---
    ROLES = {'owner', 'elder', 'family', 'caregiver', 'clinician'}
    PERMISSIONS = {
        'read': {'owner', 'elder', 'family', 'caregiver', 'clinician'},
        'create': {'owner', 'elder', 'family', 'caregiver'},
        'organize': {'owner', 'family', 'caregiver', 'clinician'},
        'review': {'owner', 'elder', 'family', 'caregiver', 'clinician'},
        'revise': {'owner', 'family', 'caregiver'},
        'export': {'owner', 'family', 'caregiver', 'clinician'},
        'manage_members': {'owner'},
    }

    @staticmethod
    def _hash_token(token):
        return hashlib.sha256(str(token).encode()).hexdigest()

    def _auth_audit(self, c, action, user_id=None, household_id=None, details=None):
        self.aud(c, None, action, None, user_id or 'system', {
            'household_id': household_id, **(details or {})
        })

    @classmethod
    def _password_record(cls, password):
        if password is None:
            return (None, None, 0, 'legacy')
        password = text_field(password, 'password', 256)
        if len(password) < 8:
            raise StoreError('password_too_short')
        salt = secrets.token_bytes(cls.PASSWORD_SALT_BYTES)
        digest = hashlib.pbkdf2_hmac(
            'sha256', password.encode('utf-8'), salt, cls.PASSWORD_ITERATIONS,
        )
        return (
            base64.b64encode(digest).decode('ascii'),
            base64.b64encode(salt).decode('ascii'),
            cls.PASSWORD_ITERATIONS,
            cls.PASSWORD_ALGORITHM,
        )

    @classmethod
    def _verify_password(cls, password, row):
        if not row['password_hash'] or row['password_algorithm'] == 'legacy':
            # Existing local accounts are intentionally kept usable during
            # migration.  New accounts should always pass a password.
            return password is None
        if not isinstance(password, str):
            return False
        try:
            salt = base64.b64decode(row['password_salt'], validate=True)
            expected = base64.b64decode(row['password_hash'], validate=True)
            actual = hashlib.pbkdf2_hmac(
                'sha256', password.encode('utf-8'), salt,
                int(row['password_iterations'] or cls.PASSWORD_ITERATIONS),
            )
        except (ValueError, TypeError):
            return False
        return hmac.compare_digest(actual, expected)

    def create_household(self, name, display_name, role='owner', external_key=None, password=None):
        name = text_field(name, 'household_name', 120)
        display_name = text_field(display_name, 'display_name', 80)
        if role not in self.ROLES: raise StoreError('invalid_role')
        password_hash, password_salt, password_iterations, password_algorithm = self._password_record(password)
        at = now(); hid, user_id = uid('hh_'), uid('usr_')
        with self.transaction() as c:
            c.execute('INSERT INTO households VALUES(?,?,?)', (hid, name, at))
            c.execute('''INSERT INTO users(
                user_id,display_name,external_key,created_at,password_hash,password_salt,
                password_iterations,password_algorithm,failed_attempts,locked_until,last_login_at
            ) VALUES(?,?,?,?,?,?,?,?,0,NULL,NULL)''', (
                user_id, display_name, external_key, at, password_hash, password_salt,
                password_iterations, password_algorithm,
            ))
            c.execute('INSERT INTO household_members VALUES(?,?,?,?,?)', (hid, user_id, role, 'active', at))
            self._auth_audit(c, 'household_created', user_id, hid, {'role': role})
        return {'household_id': hid, 'name': name, 'user_id': user_id, 'display_name': display_name, 'role': role}

    def add_member(self, household_id, display_name, role='family', external_key=None, password=None):
        text_field(household_id, 'household_id', 100); display_name = text_field(display_name, 'display_name', 80)
        if role not in self.ROLES: raise StoreError('invalid_role')
        password_hash, password_salt, password_iterations, password_algorithm = self._password_record(password)
        at = now(); user_id = uid('usr_')
        with self.transaction() as c:
            if c.execute('SELECT 1 FROM households WHERE household_id=?', (household_id,)).fetchone() is None: raise NotFound('household_not_found')
            c.execute('''INSERT INTO users(
                user_id,display_name,external_key,created_at,password_hash,password_salt,
                password_iterations,password_algorithm,failed_attempts,locked_until,last_login_at
            ) VALUES(?,?,?,?,?,?,?,?,0,NULL,NULL)''', (
                user_id, display_name, external_key, at, password_hash, password_salt,
                password_iterations, password_algorithm,
            ))
            c.execute('INSERT INTO household_members VALUES(?,?,?,?,?)', (household_id, user_id, role, 'active', at))
            self._auth_audit(c, 'member_added', user_id, household_id, {'role': role})
        return {'user_id': user_id, 'display_name': display_name, 'household_id': household_id, 'role': role, 'status': 'active'}

    def list_members(self, household_id):
        with self.connection() as c:
            return [dict(r) for r in c.execute('''SELECT u.user_id,u.display_name,u.external_key,
                m.household_id,m.role,m.status,m.created_at FROM household_members m
                JOIN users u ON u.user_id=m.user_id WHERE m.household_id=? ORDER BY m.created_at''', (household_id,))]

    def login(self, user_id=None, display_name=None, household_id=None, ttl_seconds=86400, password=None):
        if not user_id and not display_name: raise StoreError('user_id_or_display_name_required')
        if type(ttl_seconds) is not int or ttl_seconds <= 0 or ttl_seconds > 30 * 86400:
            raise StoreError('invalid_session_ttl')
        with self.transaction() as c:
            q = '''SELECT m.*,u.display_name,u.password_hash,u.password_salt,
                u.password_iterations,u.password_algorithm,u.failed_attempts,u.locked_until,
                u.last_login_at FROM household_members m JOIN users u ON u.user_id=m.user_id
                WHERE m.status='active' '''
            args = []
            if user_id: q += ' AND m.user_id=?'; args.append(user_id)
            else: q += ' AND u.display_name=?'; args.append(display_name)
            if household_id: q += ' AND m.household_id=?'; args.append(household_id)
            row = c.execute(q + ' LIMIT 1', args).fetchone()
            if row is None: raise Unauthorized('invalid_credentials')
            current = datetime.now(timezone.utc)
            if row['locked_until'] and row['locked_until'] > current.isoformat():
                self._auth_audit(c, 'login_locked', row['user_id'], row['household_id'], {
                    'failed_attempts': row['failed_attempts'] or 0,
                })
                # The transaction context rolls back when an exception leaves
                # the block.  Commit the audit before returning the auth error.
                c.commit()
                raise Unauthorized('account_locked')
            if not self._verify_password(password, row):
                failures = int(row['failed_attempts'] or 0) + 1
                locked_until = None
                if failures >= self.MAX_LOGIN_FAILURES:
                    locked_until = datetime.fromtimestamp(
                        current.timestamp() + self.LOCKOUT_SECONDS, timezone.utc,
                    ).isoformat()
                c.execute('''UPDATE users SET failed_attempts=?,locked_until=? WHERE user_id=?''',
                          (failures, locked_until, row['user_id']))
                self._auth_audit(c, 'login_failed', row['user_id'], row['household_id'], {
                    'failed_attempts': failures, 'locked': bool(locked_until),
                })
                c.commit()
                raise Unauthorized('account_locked' if locked_until else 'invalid_credentials')
            token = secrets.token_urlsafe(32); at = now(); exp = datetime.fromtimestamp(current.timestamp()+ttl_seconds, timezone.utc).isoformat()
            c.execute('''UPDATE users SET failed_attempts=0,locked_until=NULL,last_login_at=?
                WHERE user_id=?''', (at, row['user_id']))
            c.execute('INSERT INTO sessions VALUES(?,?,?,?,?,NULL)', (self._hash_token(token), row['user_id'], row['household_id'], exp, at))
            self._auth_audit(c, 'login', row['user_id'], row['household_id'])
            return {'token': token, 'expires_at': exp, 'user_id': row['user_id'], 'household_id': row['household_id'], 'role': row['role'], 'display_name': row['display_name']}

    def authenticate(self, token):
        if not token: raise Unauthorized('auth_token_required')
        with self.connection() as c:
            row = c.execute('''SELECT s.*,u.display_name,m.role FROM sessions s
                JOIN users u ON u.user_id=s.user_id JOIN household_members m
                ON m.user_id=s.user_id AND m.household_id=s.household_id
                WHERE s.token_hash=? AND s.revoked_at IS NULL''', (self._hash_token(token),)).fetchone()
            if row is None: raise Unauthorized('invalid_session')
            if row['expires_at'] <= now(): raise Unauthorized('session_expired')
            return dict(row)

    def revoke_session(self, token):
        with self.transaction() as c:
            row = c.execute('SELECT user_id,household_id FROM sessions WHERE token_hash=?', (self._hash_token(token),)).fetchone()
            if row: c.execute('UPDATE sessions SET revoked_at=? WHERE token_hash=?', (now(), self._hash_token(token)))
            if row: self._auth_audit(c, 'logout', row['user_id'], row['household_id'])

    def authorize(self, token, permission, household_id=None):
        ctx = self.authenticate(token)
        if household_id and ctx['household_id'] != household_id: raise Forbidden('household_access_denied')
        if permission not in self.PERMISSIONS or ctx['role'] not in self.PERMISSIONS[permission]: raise Forbidden('permission_denied')
        return ctx

    def history(self, rid):
        with self.connection() as c:
            # A read transaction ensures the history and audit share one snapshot.
            c.execute('BEGIN')
            self._get(c, rid)
            history = []
            for row in c.execute('SELECT * FROM revisions WHERE record_id=? ORDER BY version,at', (rid,)):
                item = dict(row)
                item['snapshot'] = json.loads(item.pop('snapshot_json'))
                history.append(item)
            audit = []
            for row in c.execute('SELECT * FROM audit WHERE record_id=? ORDER BY at,audit_id', (rid,)):
                item = dict(row)
                item['details'] = json.loads(item.pop('details_json') or '{}')
                audit.append(item)
            return history, audit

    def organize(self, rid, expected, result, actor='system'):
        expected = expected_version(expected)
        text_field(actor, 'actor_name', 80)
        if not isinstance(result, dict):
            raise StoreError('validated_output_required')
        output = result.get('output')
        text_meta = ('trace_id', 'provider', 'prompt_version')
        latency = result.get('latency_ms')
        if (
            result.get('ok') is not True
            or result.get('ai_failed') is not False
            or not isinstance(output, dict)
            or not output
            or any(not isinstance(result.get(k), str) or not result[k].strip() for k in text_meta)
            or result.get('schema_version') != 'event-v0.3'
            or isinstance(latency, bool)
            or not isinstance(latency, (int, float))
            or not math.isfinite(latency)
            or latency < 0
            or not isinstance(result.get('safety_guard_applied'), bool)
        ):
            raise StoreError('validated_output_required')
        with self.transaction() as c:
            event = self._versioned(c, rid, expected)
            if document_needs_review(event):
                raise Conflict('document_source_review_required')
            if event['state'] not in {'inbox', 'needs_review', 'draft'}:
                raise Conflict('organize_state_invalid')
            related = [item for related_id in event.get('related_record_ids', []) if not document_needs_review(item := self._get(c, related_id))]
            try:
                try:
                    from .adapter import AdapterError, validate_output
                except ImportError:
                    from adapter import AdapterError, validate_output
                validate_output(output, event['raw_text'], {**event, 'history': related})
                draft_json = json.dumps(output, ensure_ascii=False, allow_nan=False)
                meta = {k: result.get(k) for k in (
                    'trace_id', 'provider', 'model_id', 'prompt_version',
                    'prompt_sha256', 'input_sha256', 'schema_version',
                    'latency_ms', 'safety_guard_applied',
                )}
                meta_json = json.dumps(meta, ensure_ascii=False, allow_nan=False)
            except (AdapterError, TypeError, ValueError) as exc:
                raise StoreError('validated_output_required') from exc
            c.execute('''UPDATE events SET state='draft',version=version+1,
                draft_json=?,result_meta_json=?,updated_at=?
                WHERE record_id=? AND version=?''', (draft_json, meta_json, now(), rid, expected))
            event = self._get(c, rid)
            self.rev(c, event, 'organized', actor)
            self.aud(c, rid, 'organized', event['version'], actor, {'provider': meta.get('provider')})
            return event

    def fail(self, rid, expected, action, actor, details):
        expected = expected_version(expected)
        text_field(actor, 'actor_name', 80)
        with self.transaction() as c:
            event = self._versioned(c, rid, expected)
            self.aud(c, rid, action, event['version'], actor, details)

    def source_review(self, rid, expected, compared_with_original, actor):
        expected = expected_version(expected)
        text_field(actor, 'actor_name', 80)
        if compared_with_original is not True:
            raise StoreError('source_review_confirmation_required')
        with self.transaction() as c:
            event = self._versioned(c, rid, expected)
            if event['source_kind'] != 'document' or event['state'] == 'superseded':
                raise Conflict('source_review_not_available')
            review = {'method': 'original_comparison', 'text': event['raw_text'], 'confirmed_at': now()}
            c.execute('''UPDATE events SET source_review_json=?,state='inbox',draft_json=NULL,
                result_meta_json=NULL,review_notes=NULL,version=version+1,updated_at=? WHERE record_id=?''',
                (json.dumps(review, ensure_ascii=False), now(), rid))
            event = self._get(c, rid)
            self.rev(c, event, 'source_reviewed', actor)
            self.aud(c, rid, 'source_reviewed', event['version'], actor, {'method': 'original_comparison'})
            return event

    def review(self, rid, expected, action, actor, note):
        expected = expected_version(expected)
        text_field(actor, 'actor_name', 80)
        if action not in {'confirm', 'return'}:
            raise StoreError('invalid_review_action')
        if note is not None:
            text_field(note, 'note', 2000, required=False)
        if action == 'return' and (not isinstance(note, str) or not note.strip()):
            raise StoreError('return_note_required')
        with self.transaction() as c:
            event = self._versioned(c, rid, expected)
            if document_needs_review(event):
                raise Conflict('document_source_review_required')
            if action == 'confirm':
                if event['state'] != 'draft':
                    raise Conflict('confirm_state_invalid')
                if not event['draft']:
                    raise Conflict('draft_required')
                state = 'recorded'
            else:
                if event['state'] not in {'draft', 'recorded'}:
                    raise Conflict('return_state_invalid')
                state = 'needs_review'
            # Draft safety and review fields are intentionally unchanged.
            c.execute('''UPDATE events SET state=?,version=version+1,
                review_notes=?,updated_at=? WHERE record_id=? AND version=?''',
                (state, note or '', now(), rid, expected))
            event = self._get(c, rid)
            self.rev(c, event, 'review_' + action, actor)
            self.aud(c, rid, 'review_' + action, event['version'], actor, {
                'confirmation_scope': 'record_accuracy', 'note': note or '',
            })
            return event

    def revise(self, rid, expected, payload, actor):
        expected = expected_version(expected)
        related = self._payload(payload)
        reason = text_field(payload.get('reason'), 'revision_reason', 2000)
        text_field(actor, 'actor_name', 80)
        with self.transaction() as c:
            old = self._versioned(c, rid, expected)
            if old['state'] == 'superseded':
                raise Conflict('already_superseded')
            for r in related:
                rr = c.execute('SELECT household_id FROM events WHERE record_id=?', (r,)).fetchone()
                if rr is None: raise NotFound('related_record_not_found')
                if rr['household_id'] not in (None, old.get('household_id')): raise Forbidden('cross_household_reference_denied')
            # The old evidence is never edited. Its state/version and a newly
            # appended snapshot record which replacement superseded it.
            if old['source_kind'] == 'document':
                payload = {**payload, 'source_kind': 'document'}
            new = self._insert(c, payload, related, supersedes_id=rid, reason=reason)
            c.execute('''UPDATE events SET state='superseded',version=version+1,
                updated_at=? WHERE record_id=? AND version=?''', (now(), rid, expected))
            old = self._get(c, rid)
            self.rev(c, old, 'superseded_by_revision', actor)
            self.aud(c, rid, 'superseded_by_revision', old['version'], actor, {
                'new_record_id': new['record_id'], 'reason': reason,
            })
            c.execute('UPDATE events SET household_id=? WHERE record_id=?', (old.get('household_id'), new['record_id']))
            new = self._get(c, new['record_id'])
            self.rev(c, new, 'revised_from', actor)
            self.aud(c, new['record_id'], 'revised_from', new['version'], actor, {
                'supersedes_id': rid, 'superseded_version': expected, 'reason': reason,
            })
            return new

    @staticmethod
    def unresolved_reasons(event):
        reasons = []
        if event.get('local_safety', {}).get('danger_detected'):
            reasons.append('local_danger_detected')
        if event.get('local_safety', {}).get('clinical_review_required'):
            reasons.append('clinical_measurement_review_required')
        if event['state'] != 'recorded':
            reasons.append('record_not_confirmed')
        draft = event.get('draft') or {}
        if not draft:
            reasons.append('draft_missing')
        if draft.get('event_kind') in {'medication', 'instruction'}:
            reasons.append('professional_review_required')
        elif draft.get('review_role') in {'clinician_or_pharmacist', 'emergency_services'}:
            reasons.append('professional_review_required')
        if draft.get('escalation_level', 'none') != 'none':
            reasons.append('escalation_not_cleared')
        if draft.get('conflict', {}).get('present'):
            reasons.append('conflict_not_resolved')
        return reasons

    def handoff(self, household_id=None):
        with self.transaction() as c:
            # Superseded evidence stays in history but is not counted twice.
            if household_id:
                rows = c.execute('''SELECT * FROM events
                    WHERE household_id=? AND state IN ('recorded','draft','needs_review','inbox')
                    ORDER BY recorded_at,created_at,record_id''', (household_id,))
            else:
                rows = c.execute('''SELECT * FROM events
                    WHERE state IN ('recorded','draft','needs_review','inbox')
                    ORDER BY recorded_at,created_at,record_id''')
            events = [self._get(c, r['record_id']) for r in rows]
            pending = [event for event in events if document_needs_review(event)]
            pending_ids = {event['record_id'] for event in pending}
            for event in pending:
                previous = event.get('supersedes_id')
                while previous and previous not in pending_ids:
                    pending_ids.add(previous)
                    previous = self._get(c, previous).get('supersedes_id')
            events = [event for event in events if not document_needs_review(event)]
            for event in events:
                event['unresolved_reasons'] = self.unresolved_reasons(event)
                event['unresolved'] = bool(event['unresolved_reasons'])
            if household_id:
                media_rows = c.execute('''SELECT * FROM media WHERE household_id=?
                    ORDER BY created_at,media_id''', (household_id,))
            else:
                media_rows = c.execute('''SELECT * FROM media
                    ORDER BY created_at,media_id''')
            media_attachments = []
            for row in media_rows:
                media = self._decode_media(c, row)
                attempt = media.get('latest_attempt') or {}
                reasons = []
                unreviewed = media.get('record_id') in pending_ids
                if unreviewed:
                    reasons.append('document_source_review_required')
                if media['recognition_status'] == 'failed':
                    reasons.append('media_recognition_failed')
                elif media['recognition_status'] in {'not_started', 'processing', 'interrupted'}:
                    reasons.append('media_recognition_incomplete')
                if media['link_status'] != 'linked':
                    reasons.append('media_event_not_linked')
                pending_reason = (
                    media.get('link_pending_reason')
                    or attempt.get('error_code')
                )
                media_attachments.append({
                    'media_id': media['media_id'],
                    'kind': media['kind'],
                    'save_status': media['save_status'],
                    'recognition_status': media['recognition_status'],
                    'is_mock': attempt.get('is_mock'),
                    'link_status': media['link_status'],
                    'record_id': media.get('record_id'),
                    'pending_reason': pending_reason,
                    'has_text': bool(attempt.get('text')),
                    'local_safety': None if unreviewed else media.get('local_safety'),
                    'unresolved': bool(reasons),
                    'unresolved_reasons': reasons,
                })
            handoff = {
                'handoff_id': uid('handoff_'), 'created_at': now(), 'household_id': household_id, 'items': events,
                'pending_documents': [{'record_id': event['record_id'], 'recorded_at': event['recorded_at'], 'reason': 'document_source_review_required'} for event in pending],
                'unresolved_count': (
                    len(pending) + sum(event['unresolved'] for event in events)
                    + sum(item['unresolved'] for item in media_attachments)
                ),
            }
            if media_attachments:
                handoff['media_attachments'] = media_attachments
            c.execute('INSERT INTO handoffs(handoff_id,created_at,snapshot_json,household_id) VALUES(?,?,?,?)', (
                handoff['handoff_id'], handoff['created_at'],
                json.dumps(handoff, ensure_ascii=False), household_id,
            ))
            return handoff

    def get_handoff(self, hid):
        with self.connection() as c:
            row = c.execute('SELECT snapshot_json FROM handoffs WHERE handoff_id=?', (hid,)).fetchone()
            if row is None:
                raise NotFound('handoff_not_found')
            saved = json.loads(row['snapshot_json'])
            # Historical snapshots may predate source inheritance in _get and
            # label a document-derived revision as patient speech. Normalize
            # only the source identity for this response; keep its text, review
            # attestation, and timestamps frozen at snapshot time.
            for item in saved.get('items', []):
                if item.get('source_kind') == 'document' or not item.get('supersedes_id'):
                    continue
                try:
                    current = self._get(c, item.get('record_id'))
                except NotFound:
                    continue
                if current.get('source_kind') == 'document':
                    item['source_kind'] = 'document'
            pending = [event for event in saved['items'] if document_needs_review(event)]
            if pending:
                saved['items'] = [event for event in saved['items'] if not document_needs_review(event)]
                saved['pending_documents'] = saved.get('pending_documents', []) + [{'record_id': event['record_id'], 'recorded_at': event['recorded_at'], 'reason': 'document_source_review_required'} for event in pending]
                for item in saved.get('media_attachments', []):
                    if item.get('kind') == 'image':
                        item.update(local_safety=None, unresolved=True)
                saved['unresolved_count'] = len(saved['pending_documents']) + sum(bool(item.get('unresolved')) for item in saved['items'] + saved.get('media_attachments', []))
            return saved
