"""Local cumulative planning reservations; never supplier billing authority.

Trusted setup must record the actual owner's approval before registering a
bounded trial receipt. Every reservation is durable and non-refundable, even
when a caller fails before transport. Unknown final supplier charges remain
unknown. This module imports no provider, credentials, transport, or HTTP code.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import stat
import uuid
from contextlib import closing
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

SCHEMA = 'noreset-cumulative-trial-budget-v1'
RECEIPT_SCHEMA = 'noreset-synthetic-trial-informed-risk-v2'
CLAIM_ROOT = Path(__file__).resolve().parents[1] / 'runtime/synthetic-trial/cumulative-budget-claims'
NANO_USD = Decimal('1000000000')
HASH = re.compile(r'^[a-f0-9]{64}$')
SERVICES = {
    'asr': {'provider': 'aihubmix', 'model': 'gemini-2.5-flash-lite', 'estimated_upper_usd': '0.001024'},
    'llm': {'provider': 'deepseek', 'model': 'deepseek-flash', 'estimated_upper_usd': '0.0096576'},
}
URLS = {'asr': 'https://aihubmix.com/gemini/v1beta/models/gemini-2.5-flash-lite:generateContent',
        'llm': 'https://api.deepseek.com/chat/completions'}
STOP_BUFFER_UNITS = 9657600  # Keep one largest reviewed request estimate unused.
NATIVE_ROOT_SCHEMA = 'noreset-standalone-cumulative-binding-v1'
NATIVE_ROOT_SQL = ('CREATE TABLE native_roots (receipt_id TEXT PRIMARY KEY, root_id TEXT NOT NULL UNIQUE, '
                   'state_path TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL)')
IDENTITY_RECOVERY_SCHEMA = 'noreset-cumulative-device-identity-recovery-v1'
IDENTITY_RECOVERY_APPROVAL_SCHEMA = 'noreset-device-identity-owner-approval-v1'
IDENTITY_RECOVERY_PATH_NAME = 'device-identity-recovery.json'


class TrialBudgetError(RuntimeError):
    def __init__(self, code='trial_cumulative_budget_required'):
        self.code = code
        super().__init__('累计测试预算记录无效或接近限额，未允许新的服务请求。')


def _deny(code='trial_cumulative_budget_required'):
    raise TrialBudgetError(code)


def _encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _deny()
        result[key] = value
    return result


def _units(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d+(?:\.\d{1,9})?', value):
        _deny()
    result = Decimal(value) * NANO_USD
    if not 0 < result < 2**63:
        _deny()
    return int(result)


def _usd(value):
    return format(Decimal(value) / NANO_USD, 'f')


def _time(value):
    if not isinstance(value, str):
        _deny()
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        _deny()
    if not result.tzinfo:
        _deny()
    return result


def _path(value):
    if not isinstance(value, (str, Path)):
        _deny()
    result = Path(value)
    if not result.is_absolute() or result.resolve() != result or result.is_symlink():
        _deny()
    return result


def _text(value):
    if not isinstance(value, str) or not value.strip() or len(value.encode()) > 4096:
        _deny()
    return value


def _validate_authorization(value):
    expected = {'schema_version', 'authorization_id', 'status', 'authorization_source', 'approval_ref',
                'effective_at', 'project', 'currency', 'total_estimated_usd', 'synthetic_only',
                'hard_currency_cap', 'billing_limitations_accepted', 'unknown_final_cost_accepted', 'services'}
    if (not isinstance(value, dict) or set(value) != expected or value['schema_version'] != SCHEMA
            or value['status'] != 'approved' or value['authorization_source'] != 'explicit_owner_approval'
            or value['project'] != 'NoReset' or value['currency'] != 'USD'
            or _units(value['total_estimated_usd']) != 1000000000
            or value['synthetic_only'] is not True or value['hard_currency_cap'] is not False
            or value['billing_limitations_accepted'] is not True or value['unknown_final_cost_accepted'] is not True
            or value['services'] != SERVICES or _time(value['effective_at']) > datetime.now(timezone.utc)):
        _deny()
    _text(value['authorization_id']); _text(value['approval_ref'])


def initialize_authorization(authorization, *, authorization_path, state_path):
    """Explicit trusted local setup, exclusive creation; never implicit activation.

    Existing files are never overwritten or reset. Input is an approval record,
    not proof that an external system or the owner actually granted permission.
    The caller must supply that proof and separately satisfy the provider gate.
    """
    _validate_authorization(authorization)
    authority_path, database_path = _path(authorization_path), _path(state_path)
    if authority_path == database_path or authority_path.exists() or database_path.exists():
        _deny()
    try:
        claim_root = _path(CLAIM_ROOT)
        claim_root.mkdir(parents=True, exist_ok=True)
        state_identity = uuid.uuid4().hex
        claim = {'authorization_id': authorization['authorization_id'], 'approval_ref': authorization['approval_ref'],
                 'authorization_path': str(authority_path), 'state_path': str(database_path),
                 'state_identity': state_identity, 'project': authorization['project']}
        claim_raw = _encode(claim).encode()
        claim_paths = []
        for field in ('authorization_id', 'approval_ref'):
            identity = hashlib.sha256(_encode({'project': authorization['project'], field: authorization[field]}).encode()).hexdigest()
            claim_path = claim_root / f'{field}-{identity}.json'
            claim_paths.append(str(claim_path))
            claim_fd = os.open(claim_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(claim_fd, 'wb') as output:
                output.write(claim_raw); output.flush(); os.fsync(output.fileno())
        database_fd = os.open(database_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(database_fd)
        stat = database_path.stat()
        record = dict(authorization, authorization_path=str(authority_path), state_path=str(database_path),
                      state_identity=state_identity, state_device=stat.st_dev, state_inode=stat.st_ino,
                      claim_paths=claim_paths, claim_sha256=hashlib.sha256(claim_raw).hexdigest())
        raw = _encode(record).encode()
        digest = hashlib.sha256(raw).hexdigest()
        descriptor = {'authorization_sha256': digest, 'authorization_path': str(authority_path),
                      'state_path': str(database_path)}
        with sqlite3.connect(database_path) as db:
            db.executescript('''
                CREATE TABLE metadata (authorization_sha256 TEXT NOT NULL, record_json TEXT NOT NULL);
                CREATE TABLE batches (receipt_id TEXT PRIMARY KEY, binding_sha256 TEXT NOT NULL,
                    registered_json TEXT NOT NULL, status TEXT NOT NULL, closure_reason TEXT);
                CREATE UNIQUE INDEX one_active_batch ON batches(status) WHERE status='active';
                CREATE TABLE allocations (id INTEGER PRIMARY KEY, receipt_id TEXT NOT NULL,
                    slot INTEGER NOT NULL, kind TEXT NOT NULL, source_sha256 TEXT NOT NULL,
                    request_sha256 TEXT NOT NULL, reserved_units INTEGER NOT NULL, reserved_at TEXT NOT NULL,
                    observation_json TEXT, UNIQUE(receipt_id,slot));
                CREATE INDEX request_replay ON allocations(kind,source_sha256,request_sha256);
            ''')
            db.execute('INSERT INTO metadata VALUES (?,?)', (digest, _encode(record)))
        fd = os.open(authority_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(raw); output.flush(); os.fsync(output.fileno())
        return descriptor
    except (OSError, sqlite3.Error):
        # Partial setup remains default-closed; do not silently destroy records.
        raise TrialBudgetError() from None


def _authority(descriptor):
    try:
        if (not isinstance(descriptor, dict) or set(descriptor) != {'authorization_sha256', 'authorization_path', 'state_path'}
                or not isinstance(descriptor['authorization_sha256'], str) or not HASH.fullmatch(descriptor['authorization_sha256'])):
            _deny()
        authority_path, database_path = _path(descriptor['authorization_path']), _path(descriptor['state_path'])
        raw = authority_path.read_bytes()
        if len(raw) > 65536 or hashlib.sha256(raw).hexdigest() != descriptor['authorization_sha256']:
            _deny()
        record = json.loads(raw, object_pairs_hook=_unique)
        if not isinstance(record, dict):
            _deny()
        binding = {'authorization_path', 'state_path', 'state_identity', 'state_device', 'state_inode',
                   'claim_paths', 'claim_sha256'}
        _validate_authorization({k: v for k, v in record.items() if k not in binding})
        state_stat = database_path.stat()
        if (record.get('authorization_path') != str(authority_path) or record.get('state_path') != str(database_path)
                or not isinstance(record.get('state_identity'), str)
                or not re.fullmatch(r'[a-f0-9]{32}', record['state_identity']) or state_stat.st_nlink != 1
                or not stat.S_ISREG(state_stat.st_mode) or record.get('state_inode') != state_stat.st_ino):
            _deny()
        recovery_path = _identity_recovery_path(authority_path)
        if state_stat.st_dev != record.get('state_device'):
            _validate_identity_recovery(descriptor, record, database_path, state_stat)
        elif recovery_path.exists() or recovery_path.is_symlink():
            _deny('trial_identity_recovery_transition_reversed')
        claim = {'authorization_id': record['authorization_id'], 'approval_ref': record['approval_ref'],
                 'authorization_path': str(authority_path), 'state_path': str(database_path),
                 'state_identity': record['state_identity'], 'project': record['project']}
        claim_raw = _encode(claim).encode()
        expected_claims = []
        for field in ('authorization_id', 'approval_ref'):
            identity = hashlib.sha256(_encode({'project': record['project'], field: record[field]}).encode()).hexdigest()
            claim_path = _path(CLAIM_ROOT) / f'{field}-{identity}.json'
            expected_claims.append(str(claim_path))
            if claim_path.is_symlink() or claim_path.read_bytes() != claim_raw:
                _deny()
        if record.get('claim_paths') != expected_claims or record.get('claim_sha256') != hashlib.sha256(claim_raw).hexdigest():
            _deny()
        return record, database_path
    except (OSError, ValueError, TypeError, KeyError):
        raise TrialBudgetError() from None


def _connect(descriptor, *, readonly=False):
    record, path = _authority(descriptor)
    db = sqlite3.connect(path.as_uri() + ('?mode=ro' if readonly else '?mode=rw'), uri=True, timeout=10)
    try:
        if db.execute('SELECT authorization_sha256,record_json FROM metadata').fetchall() != [
                (descriptor['authorization_sha256'], _encode(record))]:
            _deny()
        return db, record
    except BaseException:
        db.close()
        raise


def _receipt_binding(descriptor, receipt, authority, *, historical=False):
    if (not isinstance(receipt, dict) or receipt.get('schema_version') != RECEIPT_SCHEMA
            or receipt.get('status') != 'approved' or receipt.get('authorization_source') != 'explicit_owner_approval'
            or receipt.get('synthetic_only') is not True or receipt.get('cumulative_budget') != descriptor):
        _deny()
    _text(receipt.get('receipt_id')); _text(receipt.get('approval_ref'))
    approved, expires = _time(receipt.get('approved_at')), _time(receipt.get('expires_at'))
    now = datetime.now(timezone.utc)
    if (not _time(authority['effective_at']) <= approved <= now
            or (not historical and now >= expires)
            or expires - approved > timedelta(minutes=60) or expires <= approved):
        _deny()
    sequence, profiles = receipt.get('request_sequence'), receipt.get('profiles')
    if (not isinstance(sequence, list) or not 1 <= len(sequence) <= 4
            or not isinstance(profiles, dict) or set(profiles) != set(sequence) or not set(profiles) <= set(SERVICES)):
        _deny()
    if type(receipt.get('total_requests')) is not int or receipt['total_requests'] < len(sequence):
        _deny()
    if type(receipt.get('planned_text_requests')) is not int or receipt['planned_text_requests'] != sequence.count('llm'):
        _deny()
    planned = 0
    for kind, profile in profiles.items():
        if (not isinstance(profile, dict) or type(profile.get('requests')) is not int
                or not 0 < profile['requests'] <= 2 or sequence.count(kind) != profile['requests']
                or profile.get('provider') != SERVICES[kind]['provider'] or profile.get('model') != SERVICES[kind]['model']
                or profile.get('url') != URLS[kind] or type(profile.get('max_thinking_tokens')) is not int
                or profile['max_thinking_tokens'] != 0
                or type(profile.get('max_input_bytes')) is not int
                or not 0 < profile['max_input_bytes'] <= (24000 if kind == 'llm' else 3 * 1024 * 1024)
                or type(profile.get('max_output_tokens')) is not int
                or not 0 < profile['max_output_tokens'] <= (2048 if kind == 'llm' else 1024)):
            _deny()
        sources, requests = profile.get('source_sha256'), profile.get('request_sha256')
        if (not isinstance(sources, list) or not isinstance(requests, list) or len(sources) != len(requests)
                or not 0 <= len(sources) <= profile['requests']
                or any(not isinstance(item, str) or not HASH.fullmatch(item) for item in sources + requests)
                or len(set(sources)) != len(sources) or len(set(requests)) != len(requests)):
            _deny()
        billing = profile.get('billing')
        incoming, generated = (24000, 2048) if kind == 'llm' else (2048, 1024)
        if (not isinstance(billing, dict) or billing.get('status') != 'disclosed_estimate'
                or billing.get('currency') != 'USD' or billing.get('model') != SERVICES[kind]['model']
                or billing.get('estimated_usd') != SERVICES[kind]['estimated_upper_usd']
                or billing.get('estimated_input_tokens') != incoming
                or billing.get('observed_input_tokens_limit') != incoming
                or billing.get('observed_generated_tokens_limit') != generated
                or billing.get('usd_per_million_input_tokens') != '0.30'
                or billing.get('usd_per_million_generated_tokens') != ('1.20' if kind == 'llm' else '0.40')
                or billing.get('complete_cost_bound_known') is not False
                or billing.get('internal_billable_attempts_known') is not False
                or billing.get('completion_tokens_include_reasoning') is not True
                or (_time(billing.get('expires_at')) <= now and not historical)):
            _deny()
        aliases = billing.get('returned_models')
        allowed_aliases = {'deepseek-flash', 'deepseek-v4-flash'} if kind == 'llm' else {'gemini-2.5-flash-lite'}
        evidence = urlsplit(billing.get('evidence_url', ''))
        if (not isinstance(aliases, list) or not aliases
                or any(not isinstance(alias, str) or alias not in allowed_aliases for alias in aliases)
                or len(set(aliases)) != len(aliases) or evidence.scheme != 'https' or evidence.username or evidence.password
                or evidence.hostname not in ({'api-docs.deepseek.com'} if kind == 'llm' else {'aihubmix.com', 'docs.aihubmix.com'})):
            _deny()
        planned += _units(billing['estimated_usd']) * profile['requests']
    spend = receipt.get('spend_authorization')
    if (not isinstance(spend, dict) or spend.get('currency') != 'USD' or spend.get('hard_currency_cap') is not False
            or spend.get('billing_limitations_accepted') is not True or spend.get('unknown_final_cost_accepted') is not True
            or spend.get('scope') != 'limited_requests_with_disclosed_non_hard_estimate'
            or _units(spend.get('estimated_new_usd')) != planned):
        _deny()
    frozen = json.loads(_encode(receipt))
    frozen.pop('approval_ref')
    for profile in frozen['profiles'].values():
        profile.pop('source_sha256'); profile.pop('request_sha256')
    return hashlib.sha256(_encode(frozen).encode()).hexdigest(), planned


def _occupied(db):
    return db.execute('SELECT COALESCE(SUM(reserved_units),0) FROM allocations').fetchone()[0]


def validate_batch(descriptor, *, receipt):
    """Read-only preflight; never register, initialize, or allocate implicitly."""
    try:
        db, authority = _connect(descriptor)
        with closing(db), db:
            db.execute('BEGIN')
            binding, _ = _receipt_binding(descriptor, receipt, authority)
            previous = db.execute('SELECT binding_sha256,status FROM batches WHERE receipt_id=?',
                                  (receipt['receipt_id'],)).fetchone()
            if previous != (binding, 'active'):
                _deny()
        return budget_snapshot(descriptor)
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError, AttributeError):
        raise TrialBudgetError() from None


def batch_status(descriptor, *, receipt):
    """Read a closed batch's frozen binding and counts in one read transaction.

    Historical expiry permits inspection only; live register/reserve validation
    stays strict. Native recovery must separately bind the original receipt
    bytes, since the frozen budget digest excludes approval/source/wire amends.
    No missing allocation or exception is interpreted as a zero count.
    """
    try:
        db, authority = _connect(descriptor, readonly=True)
        with closing(db), db:
            db.execute('BEGIN')
            if not isinstance(receipt, dict):
                _deny()
            ident = receipt.get('receipt_id')
            _text(ident)
            previous = db.execute(
                'SELECT binding_sha256,status,closure_reason,registered_json FROM batches WHERE receipt_id=?',
                (ident,)).fetchone()
            if previous is None or previous[1] != 'closed':
                _deny()
            _text(previous[2])
            binding, _ = _receipt_binding(descriptor, receipt, authority, historical=True)
            registered = json.loads(previous[3], object_pairs_hook=_unique)
            stored_binding, _ = _receipt_binding(descriptor, registered, authority, historical=True)
            if previous[0] != binding or previous[0] != stored_binding or registered['receipt_id'] != ident:
                _deny()
            count = db.execute('SELECT COUNT(*) FROM allocations WHERE receipt_id=?', (ident,)).fetchone()[0]
            active = db.execute("SELECT COUNT(*) FROM batches WHERE status='active'").fetchone()[0]
        return {'receipt_id': ident, 'binding_sha256': binding, 'closed': True,
                'closure_reason': previous[2], 'allocations': count, 'global_active_batches': active}
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError, AttributeError):
        raise TrialBudgetError() from None


def allocation_status(descriptor, *, receipt_id, slot, kind, source_sha256, request_sha256):
    """Exact persisted allocation observation; final charges still unknown."""
    try:
        if type(slot) is not int or slot < 0:
            _deny()
        with closing(_connect(descriptor)[0]) as db, db:
            db.execute('BEGIN')
            row = db.execute('''SELECT a.kind,a.source_sha256,a.request_sha256,a.reserved_units,
                a.observation_json,b.status,b.closure_reason FROM allocations a
                JOIN batches b ON b.receipt_id=a.receipt_id WHERE a.receipt_id=? AND a.slot=?''',
                (receipt_id, slot)).fetchone()
            if row is None or row[:3] != (kind, source_sha256, request_sha256):
                _deny()
            return {'receipt_id': receipt_id, 'slot': slot, 'kind': kind,
                    'source_sha256': source_sha256, 'request_sha256': request_sha256,
                    'status': 'observed_known' if row[4] is not None else 'reserved_unknown',
                    'reserved_estimate_usd': _usd(row[3]), 'batch_closed': row[5] == 'closed',
                    'closure_reason': row[6], 'observation': json.loads(row[4]) if row[4] is not None else None,
                    'supplier_final_cost_usd': None, 'refundable': False}
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
        raise TrialBudgetError() from None


def _row_seal(db, descriptor, baseline=None):
    """Seal immutable prefixes; future allocations are not historical rewrites."""
    fields = {'schema_version', 'authorization_sha256', 'batch_count', 'allocation_count',
              'reserved_units', 'unknown_allocation_ids', 'rows_sha256'}
    if baseline is not None and (not isinstance(baseline, dict) or set(baseline) != fields
            or baseline['schema_version'] != 'noreset-cumulative-row-seal-v1'
            or baseline['authorization_sha256'] != descriptor['authorization_sha256']
            or any(type(baseline[k]) is not int or baseline[k] < 0
                   for k in ('batch_count', 'allocation_count', 'reserved_units'))):
        _deny()
    batches = db.execute('SELECT rowid,* FROM batches ORDER BY rowid').fetchall()
    allocations = db.execute('SELECT * FROM allocations ORDER BY id').fetchall()
    if baseline is not None:
        if len(batches) < baseline['batch_count'] or len(allocations) < baseline['allocation_count']:
            _deny()
        batches, allocations = batches[:baseline['batch_count']], allocations[:baseline['allocation_count']]
    if ([r[0] for r in batches] != list(range(1, len(batches)+1))
            or [r[0] for r in allocations] != list(range(1, len(allocations)+1))):
        _deny()
    schemas = db.execute("SELECT type,name,sql FROM sqlite_master WHERE name!='native_roots' "
        "AND name NOT LIKE 'sqlite_autoindex_native_roots_%' ORDER BY name").fetchall()
    rows = {'metadata': db.execute('SELECT * FROM metadata').fetchall(),
            'schemas': schemas, 'batches': batches, 'allocations': allocations}
    return {'schema_version': 'noreset-cumulative-row-seal-v1',
            'authorization_sha256': descriptor['authorization_sha256'],
            'batch_count': len(batches), 'allocation_count': len(allocations),
            'reserved_units': sum(r[6] for r in allocations),
            'unknown_allocation_ids': [r[0] for r in allocations if r[8] is None],
            'rows_sha256': hashlib.sha256(_encode(rows).encode()).hexdigest()}


def _read_identity_file(path, limit):
    path = Path(path)
    if not path.is_absolute() or path != path.resolve() or path.is_symlink():
        _deny('trial_identity_recovery_path_invalid')
    before = path.stat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
        _deny('trial_identity_recovery_file_identity_invalid')
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        opened = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
                opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns):
            _deny('trial_identity_recovery_file_changed')
        chunks = []
        while True:
            part = os.read(fd, min(1024 * 1024, limit + 1 - sum(map(len, chunks))))
            if not part:
                break
            chunks.append(part)
            if sum(map(len, chunks)) > limit:
                _deny('trial_identity_recovery_file_too_large')
        after = path.stat()
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            _deny('trial_identity_recovery_file_changed')
        return b''.join(chunks), before
    finally:
        os.close(fd)


def _identity_recovery_path(authority_path):
    return Path(authority_path).with_name(IDENTITY_RECOVERY_PATH_NAME)


def _check_identity_recovery_baseline(descriptor, record, db_path, native_ids, seal, native_sha,
                                     old_device, new_device, *, require_closed):
    """Verify immutable original prefixes and only stat historical native files."""
    with closing(sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True)) as db:
        db.execute('BEGIN')
        if db.execute('PRAGMA integrity_check').fetchone() != ('ok',):
            _deny('trial_identity_recovery_database_invalid')
        if db.execute('SELECT authorization_sha256,record_json FROM metadata').fetchall() != [
                (descriptor['authorization_sha256'], _encode(record))]:
            _deny('trial_identity_recovery_metadata_changed')
        if _row_seal(db, descriptor, seal) != seal:
            _deny('trial_identity_recovery_prefix_changed')
        batch_rows = db.execute('SELECT rowid,receipt_id,status,closure_reason FROM batches ORDER BY rowid').fetchall()
        if len(batch_rows) < 41 or [row[0] for row in batch_rows[:41]] != list(range(1, 42)) or any(
                row[2] != 'closed' or not row[3] for row in batch_rows[:41]):
            _deny('trial_identity_recovery_closed_prefix_changed')
        if require_closed and db.execute("SELECT 1 FROM batches WHERE status='active'").fetchone():
            _deny('trial_identity_recovery_active_batch')
        if db.execute("SELECT sql FROM sqlite_master WHERE name='native_roots'").fetchone() != (NATIVE_ROOT_SQL,):
            _deny('trial_identity_recovery_native_schema_changed')
        all_roots = db.execute('SELECT receipt_id,root_id,state_path,record_json FROM native_roots ORDER BY receipt_id').fetchall()
        roots = [row for row in all_roots if row[0] in set(native_ids)]
        if (len(native_ids) != 26 or len(roots) != 26
                or [row[0] for row in roots] != sorted(native_ids)
                or hashlib.sha256(_encode(roots).encode()).hexdigest() != native_sha):
            _deny('trial_identity_recovery_native_prefix_changed')
        for receipt_id, _root_id, state_path_text, record_json in roots:
            binding = json.loads(record_json, object_pairs_hook=_unique)
            if (binding.get('receipt_id') != receipt_id or binding.get('state_path') != state_path_text
                    or binding.get('state_device') != old_device
                    or type(binding.get('state_inode')) is not int or binding['state_inode'] <= 0):
                _deny('trial_identity_recovery_native_binding_changed')
            state_path = _path(state_path_text)
            state_stat = state_path.stat()
            if (not stat.S_ISREG(state_stat.st_mode) or state_stat.st_nlink != 1
                    or state_stat.st_dev != new_device
                    or state_stat.st_ino != binding['state_inode']
                    or any(os.path.lexists(str(state_path) + suffix) for suffix in ('-wal', '-shm', '-journal'))):
                _deny('trial_identity_recovery_native_file_changed')
            manifest_path = _path(binding['manifest_path'])
            manifest_raw, _ = _read_identity_file(manifest_path, 2 * 1024 * 1024)
            if hashlib.sha256(manifest_raw).hexdigest() != binding.get('manifest_sha256'):
                _deny('trial_identity_recovery_manifest_changed')
            manifest = json.loads(manifest_raw, object_pairs_hook=_unique)
            receipt_path = _path(manifest.get('receipt_path'))
            if (manifest.get('state_path') != state_path_text
                    or manifest.get('receipt_sha256') != binding.get('receipt_sha256')):
                _deny('trial_identity_recovery_manifest_binding_changed')
            receipt_raw, _ = _read_identity_file(receipt_path, 65536)
            if hashlib.sha256(receipt_raw).hexdigest() != binding.get('receipt_sha256'):
                _deny('trial_identity_recovery_receipt_changed')
            receipt = json.loads(receipt_raw, object_pairs_hook=_unique)
            batch = db.execute('SELECT binding_sha256,status,closure_reason,registered_json FROM batches WHERE receipt_id=?',
                               (receipt_id,)).fetchone()
            if (receipt.get('receipt_id') != receipt_id or receipt.get('cumulative_budget') != descriptor
                    or batch is None or batch[1] != 'closed' or not batch[2]):
                _deny('trial_identity_recovery_receipt_scope_changed')
            # Compare both the raw linked receipt and the cumulative registration
            # through the same receipt-binding rules; registered_json has no path.
            raw_binding, _ = _receipt_binding(descriptor, receipt, record, historical=True)
            registered = json.loads(batch[3], object_pairs_hook=_unique)
            stored_binding, _ = _receipt_binding(descriptor, registered, record, historical=True)
            if raw_binding != batch[0] or stored_binding != batch[0]:
                _deny('trial_identity_recovery_registration_changed')
        current_native_ids = {row[0] for row in all_roots}
        if not set(native_ids).issubset(current_native_ids):
            _deny('trial_identity_recovery_native_prefix_changed')


def _validate_identity_recovery(descriptor, record, db_path, actual_stat):
    path = _identity_recovery_path(descriptor['authorization_path'])
    raw, info = _read_identity_file(path, 65536)
    if stat.S_IMODE(info.st_mode) != 0o600:
        _deny('trial_identity_recovery_permissions_invalid')
    sidecar = json.loads(raw, object_pairs_hook=_unique)
    fields = {'schema', 'status', 'authorization_source', 'approval_ref', 'authorization_sha256',
              'authorization_path', 'state_path', 'state_identity', 'old_device', 'new_device',
              'inode', 'budget_seal', 'native_count', 'native_rows_sha256', 'native_receipt_ids'}
    if (not isinstance(sidecar, dict) or set(sidecar) != fields
            or sidecar.get('schema') != IDENTITY_RECOVERY_SCHEMA or sidecar.get('status') != 'approved'
            or sidecar.get('authorization_source') != 'explicit_owner_approval'
            or not isinstance(sidecar.get('approval_ref'), str) or not sidecar['approval_ref'].startswith('user-reply:')
            or sidecar.get('authorization_sha256') != descriptor['authorization_sha256']
            or sidecar.get('authorization_path') != descriptor['authorization_path']
            or sidecar.get('state_path') != descriptor['state_path']
            or sidecar.get('state_identity') != record.get('state_identity')
            or sidecar.get('old_device') != record.get('state_device')
            or type(sidecar.get('new_device')) is not int
            or sidecar.get('new_device') == sidecar.get('old_device')
            or sidecar.get('inode') != record.get('state_inode')
            or not isinstance(sidecar.get('budget_seal'), dict)
            or sidecar['budget_seal'].get('authorization_sha256') != descriptor['authorization_sha256']
            or sidecar['budget_seal'].get('batch_count') != 41
            or sidecar['budget_seal'].get('allocation_count') != 31
            or sidecar['budget_seal'].get('unknown_allocation_ids') != [2]
            or sidecar.get('native_count') != 26 or not HASH.fullmatch(str(sidecar.get('native_rows_sha256', '')))
            or not isinstance(sidecar.get('native_receipt_ids'), list)
            or len(sidecar['native_receipt_ids']) != sidecar['native_count']
            or len(set(sidecar['native_receipt_ids'])) != sidecar['native_count']
            or actual_stat.st_dev != sidecar['new_device'] or actual_stat.st_ino != sidecar['inode']):
        _deny('trial_identity_recovery_binding_invalid')
    _check_identity_recovery_baseline(descriptor, record, db_path, sidecar['native_receipt_ids'],
        sidecar['budget_seal'], sidecar['native_rows_sha256'], sidecar['old_device'], sidecar['new_device'],
        require_closed=False)
    return sidecar


def _validate_identity_recovery_approval(approval, descriptor, record, state_stat, auth_sha):
    fields = {'schema', 'status', 'authorization_source', 'approval_ref', 'observed_at',
              'verbatim_owner_reply', 'scope', 'original_authorization_sha256', 'authorization_path',
              'state_path', 'state_identity', 'old_device', 'new_device', 'unchanged_inode',
              'original_seal', 'original_native_count', 'original_native_rows_sha256',
              'actual_sidecar_created', 'actual_recovery_performed', 'new_provider_calls'}
    if (not isinstance(approval, dict) or set(approval) != fields
            or approval.get('schema') != IDENTITY_RECOVERY_APPROVAL_SCHEMA
            or approval.get('status') != 'approved'
            or approval.get('authorization_source') != 'explicit_owner_approval'
            or not isinstance(approval.get('approval_ref'), str)
            or not approval['approval_ref'].startswith('user-reply:')
            or approval.get('verbatim_owner_reply') != '允许恢复原账本身份，保留全部记录'
            or not isinstance(approval.get('scope'), str) or not approval['scope'].strip()
            or approval.get('original_authorization_sha256') != auth_sha
            or approval.get('authorization_path') != descriptor['authorization_path']
            or approval.get('state_path') != descriptor['state_path']
            or approval.get('state_identity') != record.get('state_identity')
            or approval.get('old_device') != record.get('state_device')
            or approval.get('new_device') != state_stat.st_dev
            or approval.get('new_device') == approval.get('old_device')
            or approval.get('unchanged_inode') != state_stat.st_ino
            or approval.get('unchanged_inode') != record.get('state_inode')
            or not isinstance(approval.get('original_seal'), dict)
            or approval['original_seal'].get('authorization_sha256') != auth_sha
            or approval['original_seal'].get('batch_count') != 41
            or approval['original_seal'].get('allocation_count') != 31
            or approval['original_seal'].get('unknown_allocation_ids') != [2]
            or approval.get('original_native_count') != 26
            or not HASH.fullmatch(str(approval.get('original_native_rows_sha256', '')))
            or approval.get('actual_sidecar_created') is not False
            or approval.get('actual_recovery_performed') is not False
            or approval.get('new_provider_calls') != 0):
        _deny('trial_identity_recovery_approval_invalid')
    if (not HASH.fullmatch(str(approval['original_seal'].get('rows_sha256', '')))
            or type(approval.get('original_native_count')) is not int
            or type(approval.get('new_provider_calls')) is not int):
        _deny('trial_identity_recovery_approval_invalid')
    return approval


def restore_device_identity(descriptor, *, approval):
    """Append an explicitly approved one-time migration; never edits old authority or rows.

    The trusted local caller supplies the observed human approval record. Like
    initialize_authorization, this is a local trust boundary, not a signature system.
    """
    try:
        if (not isinstance(descriptor, dict) or set(descriptor) !=
                {'authorization_sha256', 'authorization_path', 'state_path'}):
            _deny('trial_identity_recovery_descriptor_invalid')
        authority_path, db_path = _path(descriptor['authorization_path']), _path(descriptor['state_path'])
        sidecar_path = _identity_recovery_path(authority_path)
        if sidecar_path.exists() or sidecar_path.is_symlink():
            _deny('trial_identity_recovery_already_exists')
        auth_raw, _ = _read_identity_file(authority_path, 65536)
        auth_sha = hashlib.sha256(auth_raw).hexdigest()
        if auth_sha != descriptor['authorization_sha256']:
            _deny('trial_identity_recovery_authority_changed')
        record = json.loads(auth_raw, object_pairs_hook=_unique)
        binding_fields = {'authorization_path', 'state_path', 'state_identity', 'state_device', 'state_inode',
                          'claim_paths', 'claim_sha256'}
        _validate_authorization({k: v for k, v in record.items() if k not in binding_fields})
        state_stat = db_path.stat()
        if (record.get('authorization_path') != str(authority_path) or record.get('state_path') != str(db_path)
                or record.get('state_device') == state_stat.st_dev
                or not stat.S_ISREG(state_stat.st_mode) or state_stat.st_nlink != 1):
            _deny('trial_identity_recovery_file_identity_mismatch')
        approval = _validate_identity_recovery_approval(approval, descriptor, record, state_stat, auth_sha)
        claim = {'authorization_id': record['authorization_id'], 'approval_ref': record['approval_ref'],
                 'authorization_path': str(authority_path), 'state_path': str(db_path),
                 'state_identity': record['state_identity'], 'project': record['project']}
        claim_raw = _encode(claim).encode()
        if record.get('claim_sha256') != hashlib.sha256(claim_raw).hexdigest():
            _deny('trial_identity_recovery_claim_changed')
        for field in ('authorization_id', 'approval_ref'):
            ident = hashlib.sha256(_encode({'project': record['project'], field: record[field]}).encode()).hexdigest()
            expected = _path(CLAIM_ROOT) / f'{field}-{ident}.json'
            if str(expected) not in record.get('claim_paths', []):
                _deny('trial_identity_recovery_claim_changed')
            claim_bytes, _ = _read_identity_file(expected, 16384)
            if claim_bytes != claim_raw:
                _deny('trial_identity_recovery_claim_changed')
        descriptor = dict(descriptor)
        with closing(sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True)) as db:
            db.execute('BEGIN')
            if db.execute('PRAGMA integrity_check').fetchone() != ('ok',):
                _deny('trial_identity_recovery_database_invalid')
            if db.execute("SELECT 1 FROM batches WHERE status='active'").fetchone():
                _deny('trial_identity_recovery_active_batch')
            rows = db.execute('SELECT receipt_id,root_id,state_path,record_json FROM native_roots ORDER BY receipt_id').fetchall()
        native_ids = [row[0] for row in rows]
        _check_identity_recovery_baseline(descriptor, record, db_path, native_ids,
            approval['original_seal'], approval['original_native_rows_sha256'], record['state_device'],
            state_stat.st_dev, require_closed=True)
        sidecar = {'schema': IDENTITY_RECOVERY_SCHEMA, 'status': 'approved',
            'authorization_source': approval['authorization_source'], 'approval_ref': approval['approval_ref'],
            'authorization_sha256': descriptor['authorization_sha256'],
            'authorization_path': str(authority_path), 'state_path': str(db_path),
            'state_identity': record['state_identity'], 'old_device': record['state_device'],
            'new_device': state_stat.st_dev, 'inode': state_stat.st_ino,
            'budget_seal': approval['original_seal'], 'native_count': approval['original_native_count'],
            'native_rows_sha256': approval['original_native_rows_sha256'], 'native_receipt_ids': native_ids}
        fd = os.open(sidecar_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write((_encode(sidecar) + '\n').encode()); output.flush(); os.fsync(output.fileno())
            dir_fd = os.open(sidecar_path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except BaseException:
            raise
        # This also proves future normal _authority/_connect calls consume this exact record.
        verified, _ = _authority(descriptor)
        if verified != record:
            _deny('trial_identity_recovery_postwrite_mismatch')
        return {'recovered': True, 'sidecar_path': str(sidecar_path), 'authorization_sha256': descriptor['authorization_sha256'],
                'budget_writes': 0, 'provider_calls': 0}
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
        raise TrialBudgetError() from None


def identity_recovery_transition(descriptor):
    """Return the verified one-time alias for closed historical references only."""
    record, path = _authority(descriptor)
    stat = path.stat()
    sidecar = _validate_identity_recovery(descriptor, record, path, stat)
    return {'old_device': sidecar['old_device'], 'new_device': sidecar['new_device'],
            'inode': sidecar['inode'], 'native_receipt_ids': tuple(sidecar['native_receipt_ids'])}


def cumulative_row_seal(descriptor, *, baseline=None):
    """Read-only exact historical rows, including unknown usage and closure."""
    try:
        with closing(_connect(descriptor, readonly=True)[0]) as db, db:
            db.execute('BEGIN')
            return _row_seal(db, descriptor, baseline)
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
        raise TrialBudgetError() from None


def native_root_binding(descriptor, *, receipt_id, required=True, include_scope=False):
    """Read an exclusive native identity held by the original cumulative DB."""
    try:
        with closing(_connect(descriptor, readonly=True)[0]) as db, db:
            db.execute('BEGIN')
            schema = db.execute("SELECT sql FROM sqlite_master WHERE name='native_roots'").fetchone()
            if schema is None and not required:
                return None
            if schema != (NATIVE_ROOT_SQL,):
                _deny()
            row = db.execute('SELECT record_json FROM native_roots WHERE receipt_id=?', (receipt_id,)).fetchone()
            if row is None and not required:
                return None
            if row is None:
                _deny()
            binding = json.loads(row[0], object_pairs_hook=_unique)
            if not include_scope:
                return binding
            scope = db.execute('SELECT registered_json,status,closure_reason FROM batches WHERE receipt_id=?',
                               (receipt_id,)).fetchone()
            if scope is None:
                _deny()
            return {'binding': binding, 'receipt': json.loads(scope[0], object_pairs_hook=_unique),
                    'status': scope[1], 'closure_reason': scope[2],
                    'allocations': db.execute('SELECT slot,kind,source_sha256,request_sha256,reserved_units,observation_json '
                                             'FROM allocations WHERE receipt_id=? ORDER BY slot', (receipt_id,)).fetchall()}
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
        raise TrialBudgetError() from None


def _guard_native_budget(db, descriptor, receipt_id, receipt=None):
    """Recheck frozen prefixes in the same transaction that spends or closes."""
    schema = db.execute("SELECT sql FROM sqlite_master WHERE name='native_roots'").fetchone()
    if schema is None:
        return
    if schema != (NATIVE_ROOT_SQL,):
        _deny()
    row = db.execute('SELECT record_json FROM native_roots WHERE receipt_id=?', (receipt_id,)).fetchone()
    if row is None:
        return  # Historical batches keep their existing public behavior.
    binding = json.loads(row[0], object_pairs_hook=_unique)
    if _row_seal(db, descriptor, binding['budget_baseline']) != binding['budget_baseline']:
        _deny()
    state = _path(binding['state_path'])
    info = state.stat()
    if (not stat.S_ISREG(info.st_mode) or info.st_ino != binding['state_inode'] or info.st_nlink != 1
            or any(os.path.lexists(str(state) + suffix) for suffix in ('-wal', '-shm', '-journal'))):
        _deny()
    scope = db.execute('SELECT registered_json,status FROM batches WHERE receipt_id=?', (receipt_id,)).fetchone()
    if scope is None:
        _deny()
    if info.st_dev != binding['state_device']:
        transition = identity_recovery_transition(descriptor)
        if (receipt_id not in transition['native_receipt_ids'] or scope[1] != 'closed'
                or binding['state_device'] != transition['old_device'] or info.st_dev != transition['new_device']
                or info.st_ino != binding['state_inode']):
            _deny('trial_native_legacy_device_alias_denied')
    elif binding['state_device'] != info.st_dev:
        _deny()
    approved = json.loads(scope[0], object_pairs_hook=_unique)
    if receipt is not None and receipt != approved:
        _deny()
    allocations = db.execute('SELECT slot,kind,source_sha256,request_sha256,reserved_units FROM allocations '
                             'WHERE receipt_id=? ORDER BY slot', (receipt_id,)).fetchall()
    if len(allocations) > len(approved['request_sequence']):
        _deny()
    for slot, allocation in enumerate(allocations):
        kind = approved['request_sequence'][slot]
        index = approved['request_sequence'][:slot].count(kind)
        profile = approved['profiles'][kind]
        if allocation != (slot, kind, profile['source_sha256'][index], profile['request_sha256'][index],
                           _units(profile['billing']['estimated_usd'])):
            _deny()


def register_batch(descriptor, *, receipt, expected_previous_seal=None, native_binding=None):
    """Trusted local registration of one bounded approved receipt, not a send."""
    try:
        with closing(_connect(descriptor)[0]) as db, db:
            db.execute('BEGIN IMMEDIATE')
            authority, _ = _authority(descriptor)
            binding, planned = _receipt_binding(descriptor, receipt, authority)
            if (native_binding is None) != (expected_previous_seal is None):
                _deny()
            if native_binding is not None:
                fields = {'schema_version', 'receipt_id', 'root_id', 'manifest_path', 'manifest_sha256',
                          'receipt_sha256', 'state_path', 'state_device', 'state_inode', 'state_identity',
                          'budget_baseline'}
                if (not isinstance(native_binding, dict) or set(native_binding) != fields
                        or native_binding['schema_version'] != NATIVE_ROOT_SCHEMA
                        or native_binding['receipt_id'] != receipt['receipt_id']
                        or native_binding['budget_baseline'] != expected_previous_seal
                        or _row_seal(db, descriptor) != expected_previous_seal
                        or any(r[0] != 'closed' for r in db.execute('SELECT status FROM batches'))
                        or receipt['request_sequence'] not in (['llm'], ['llm', 'llm'], ['asr'], ['asr', 'llm'])
                        or set(receipt['profiles']) != set(receipt['request_sequence'])
                        or not 1 <= len(receipt['request_sequence']) <= 2
                        or receipt['total_requests'] != len(receipt['request_sequence'])
                        or any(not HASH.fullmatch(str(native_binding[k]))
                               for k in ('root_id', 'manifest_sha256', 'receipt_sha256'))
                        or not re.fullmatch(r'[a-f0-9]{32}', str(native_binding['state_identity']))
                        or any(type(native_binding[k]) is not int or native_binding[k] <= 0
                               for k in ('state_device', 'state_inode'))):
                    _deny()
                for key in ('state_path', 'manifest_path'):
                    _path(native_binding[key])
                # Dedicated roots never replay a previous allocated tuple, even
                # when a closed known request could otherwise be explicitly rerun.
                for kind, profile in receipt['profiles'].items():
                    for source, wire in zip(profile['source_sha256'], profile['request_sha256']):
                        if db.execute('SELECT 1 FROM allocations WHERE kind=? AND source_sha256=? AND request_sha256=?',
                                      (kind, source, wire)).fetchone() is not None:
                            _deny('trial_cumulative_unknown_replay')
            previous = db.execute('SELECT binding_sha256,status FROM batches WHERE receipt_id=?', (receipt['receipt_id'],)).fetchone()
            if previous is not None:
                if native_binding is not None:
                    _deny()
                if previous != (binding, 'active'):
                    _deny()
                return budget_snapshot(descriptor)
            if db.execute("SELECT 1 FROM batches WHERE status='active'").fetchone() is not None:
                _deny('trial_cumulative_batch_active')
            if _occupied(db) + planned + STOP_BUFFER_UNITS > _units(authority['total_estimated_usd']):
                _deny('trial_cumulative_budget_exhausted')
            if native_binding is not None:
                schema = db.execute("SELECT sql FROM sqlite_master WHERE name='native_roots'").fetchone()
                if schema is None:
                    db.execute(NATIVE_ROOT_SQL)
                elif schema != (NATIVE_ROOT_SQL,):
                    _deny()
                db.execute('INSERT INTO native_roots VALUES (?,?,?,?)',
                    (receipt['receipt_id'], native_binding['root_id'], native_binding['state_path'], _encode(native_binding)))
            db.execute('INSERT INTO batches VALUES (?,?,?,\'active\',NULL)',
                       (receipt['receipt_id'], binding, _encode(receipt)))
        return budget_snapshot(descriptor)
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
        raise TrialBudgetError() from None


def reserve_estimate(descriptor, *, receipt, slot, kind, source_sha256, request_sha256, estimated_upper_usd):
    """Commit a non-refundable planning reserve BEFORE any provider transport."""
    try:
        if (type(slot) is not int or slot < 0 or kind not in SERVICES
                or not isinstance(source_sha256, str) or not HASH.fullmatch(source_sha256)
                or not isinstance(request_sha256, str) or not HASH.fullmatch(request_sha256)
                or estimated_upper_usd != SERVICES[kind]['estimated_upper_usd']):
            _deny()
        db, authority = _connect(descriptor)
        with closing(db), db:
            db.execute('BEGIN IMMEDIATE')
            _guard_native_budget(db, descriptor, receipt['receipt_id'], receipt)
            binding, _ = _receipt_binding(descriptor, receipt, authority)
            registered = db.execute('SELECT binding_sha256,status FROM batches WHERE receipt_id=?', (receipt['receipt_id'],)).fetchone()
            rows = db.execute('SELECT slot,kind FROM allocations WHERE receipt_id=? ORDER BY slot', (receipt['receipt_id'],)).fetchall()
            sequence = receipt['request_sequence']
            if (registered != (binding, 'active') or slot != len(rows) or slot >= len(sequence)
                    or rows != list(enumerate(sequence[:slot])) or kind != sequence[slot]):
                _deny()
            index = sequence[:slot].count(kind)
            profile = receipt['profiles'][kind]
            if (len(profile['source_sha256']) <= index or profile['source_sha256'][index] != source_sha256
                    or profile['request_sha256'][index] != request_sha256):
                _deny()
            reserve = _units(estimated_upper_usd)
            if _occupied(db) + reserve + STOP_BUFFER_UNITS > _units(authority['total_estimated_usd']):
                _deny('trial_cumulative_budget_exhausted')
            previous = db.execute('''SELECT a.observation_json,b.status FROM allocations a
                JOIN batches b ON b.receipt_id=a.receipt_id
                WHERE a.kind=? AND a.source_sha256=? AND a.request_sha256=?''',
                (kind, source_sha256, request_sha256)).fetchall()
            if any(observation is None or status != 'closed' for observation, status in previous):
                _deny('trial_cumulative_unknown_replay')
            cursor = db.execute('INSERT INTO allocations(receipt_id,slot,kind,source_sha256,request_sha256,reserved_units,reserved_at) VALUES (?,?,?,?,?,?,?)',
                                (receipt['receipt_id'], slot, kind, source_sha256, request_sha256, reserve,
                                 datetime.now(timezone.utc).isoformat()))
            result = {'allocation_id': cursor.lastrowid, 'receipt_id': receipt['receipt_id'], 'slot': slot,
                      'reserved_estimate_usd': _usd(reserve), 'refundable': False,
                      'supplier_final_cost_usd': None, 'supplier_hard_cap': False}
        return result
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
        raise TrialBudgetError() from None


def mark_observed(descriptor, *, receipt_id, slot, kind, source_sha256, request_sha256,
                  returned_model, usage, response_sha256):
    """Trusted same-attempt response/valid usage observation, never a refund.

    Call only from captured provider response handling. A UI-supplied statement
    or HTTP success alone cannot establish this observation. Clinical or business
    output validity is separate; the final supplier invoice remains unknown.
    """
    try:
        if (type(slot) is not int or slot < 0 or kind not in SERVICES
                or not isinstance(response_sha256, str) or not HASH.fullmatch(response_sha256)
                or not isinstance(usage, dict)):
            _deny()
        with closing(_connect(descriptor)[0]) as db, db:
            db.execute('BEGIN IMMEDIATE')
            _guard_native_budget(db, descriptor, receipt_id)
            row = db.execute('''SELECT a.kind,a.source_sha256,a.request_sha256,a.observation_json,b.registered_json
                FROM allocations a JOIN batches b ON b.receipt_id=a.receipt_id
                WHERE a.receipt_id=? AND a.slot=?''', (receipt_id, slot)).fetchone()
            if row is None or row[:3] != (kind, source_sha256, request_sha256):
                _deny()
            receipt = json.loads(row[4])
            profile = receipt['profiles'][kind]
            prompt, generated = usage.get('prompt_tokens'), usage.get('completion_tokens')
            details = usage.get('completion_tokens_details')
            thinking = details.get('reasoning_tokens') if isinstance(details, dict) else None
            if (returned_model not in profile['billing'].get('returned_models', [])
                    or type(prompt) is not int or not 0 <= prompt <= profile['billing']['observed_input_tokens_limit']
                    or type(generated) is not int or not 0 <= generated <= profile['max_output_tokens']
                    or type(thinking) is not int or thinking != 0):
                _deny()
            observed = {'response_sha256': response_sha256, 'returned_model': returned_model,
                        'prompt_tokens': prompt, 'completion_tokens': generated, 'reasoning_tokens': thinking,
                        'supplier_final_cost_usd': None, 'reservation_released': False}
            encoded = _encode(observed)
            if row[3] is not None and row[3] != encoded:
                _deny()
            db.execute('UPDATE allocations SET observation_json=? WHERE receipt_id=? AND slot=?',
                       (encoded, receipt_id, slot))
        return observed
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
        raise TrialBudgetError() from None


def close_batch(descriptor, *, receipt_id, reason):
    """Explicit local close; prior allocations are never removed or refunded."""
    _text(receipt_id); _text(reason)
    try:
        with closing(_connect(descriptor)[0]) as db, db:
            db.execute('BEGIN IMMEDIATE')
            _guard_native_budget(db, descriptor, receipt_id)
            previous = db.execute('SELECT status,closure_reason FROM batches WHERE receipt_id=?', (receipt_id,)).fetchone()
            if previous is None or previous[0] == 'closed' and previous[1] != reason:
                _deny()
            db.execute("UPDATE batches SET status='closed',closure_reason=? WHERE receipt_id=?", (reason, receipt_id))
        return budget_snapshot(descriptor)
    except (OSError, sqlite3.Error):
        raise TrialBudgetError() from None


def budget_snapshot(descriptor):
    """Planning figures only; no token usage is interpreted as a refund or zero."""
    try:
        db, authority = _connect(descriptor)
        with closing(db), db:
            db.execute('BEGIN')
            occupied = _occupied(db)
            batches = db.execute('SELECT receipt_id,status,closure_reason FROM batches ORDER BY rowid').fetchall()
            count = db.execute('SELECT COUNT(*) FROM allocations').fetchone()[0]
            known = db.execute('SELECT COUNT(*) FROM allocations WHERE observation_json IS NOT NULL').fetchone()[0]
        total = _units(authority['total_estimated_usd'])
        return {'authorization_id': authority['authorization_id'], 'effective_at': authority['effective_at'],
                'total_planning_usd': _usd(total), 'reserved_estimate_usd': _usd(occupied),
                'available_planning_usd': _usd(total - occupied), 'stop_buffer_usd': _usd(STOP_BUFFER_UNITS),
                'available_for_new_reservations_usd': _usd(max(0, total - occupied - STOP_BUFFER_UNITS)),
                'attempt_allocations': count, 'response_usage_known': known, 'response_usage_unknown': count - known,
                'batches': [{'receipt_id': ident, 'status': status, 'closure_reason': reason}
                                                        for ident, status, reason in batches],
                'prior_authorization_consumption_included': False, 'refunds_allowed': False,
                'supplier_final_cost_usd': None, 'supplier_hard_cap': False}
    except (OSError, sqlite3.Error):
        raise TrialBudgetError() from None
