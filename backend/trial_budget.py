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
        stat = database_path.stat()
        if (record.get('authorization_path') != str(authority_path) or record.get('state_path') != str(database_path)
                or not isinstance(record.get('state_identity'), str)
                or not re.fullmatch(r'[a-f0-9]{32}', record['state_identity']) or stat.st_nlink != 1
                or record.get('state_device') != stat.st_dev or record.get('state_inode') != stat.st_ino):
            _deny()
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


def register_batch(descriptor, *, receipt):
    """Trusted local registration of one bounded approved receipt, not a send."""
    try:
        with closing(_connect(descriptor)[0]) as db, db:
            db.execute('BEGIN IMMEDIATE')
            authority, _ = _authority(descriptor)
            binding, planned = _receipt_binding(descriptor, receipt, authority)
            previous = db.execute('SELECT binding_sha256,status FROM batches WHERE receipt_id=?', (receipt['receipt_id'],)).fetchone()
            if previous is not None:
                if previous != (binding, 'active'):
                    _deny()
                return budget_snapshot(descriptor)
            if db.execute("SELECT 1 FROM batches WHERE status='active'").fetchone() is not None:
                _deny('trial_cumulative_batch_active')
            if _occupied(db) + planned + STOP_BUFFER_UNITS > _units(authority['total_estimated_usd']):
                _deny('trial_cumulative_budget_exhausted')
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
