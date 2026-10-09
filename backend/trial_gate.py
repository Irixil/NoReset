"""Default-closed, persisted allowance for one explicitly approved synthetic trial.

Authorization is a trusted local receipt, never request data or an environment
flag. Hard-bound scopes reserve reviewed worst-case nano-USD before sending.
An explicitly accepted informed-risk scope limits requests and parameters with
a disclosed non-hard estimate; its zero hard reserve does not mean free usage.
This local meter does not control supplier billing or guarantee final charges.
"""
from __future__ import annotations

import hashlib
import base64
import io
import ipaddress
import json
import re
import socket
import sqlite3
import wave
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_CEILING
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
RECEIPT_PATH = ROOT / 'runtime/synthetic-trial/authorization.json'
STATE_PATH = ROOT / 'runtime/synthetic-trial/ledger.sqlite3'
CONTINUATION_CLAIM_ROOT = ROOT / 'runtime/synthetic-trial'
CAPS = {'llm': (3, 2048, 0), 'asr': (1, 1024, 0), 'ocr': (1, 4096, 1024)}
MAX_WIRE_BYTES = {'llm': 24000, 'asr': 3 * 1024 * 1024, 'ocr': 3 * 1024 * 1024}
HASH = re.compile(r'^[a-f0-9]{64}$')
SCHEMA = 'noreset-synthetic-trial-v2'
SCHEMA_V3 = 'noreset-synthetic-trial-v3'
SCHEMA_RISK = 'noreset-synthetic-trial-informed-risk-v1'
SCHEMA_RISK_SEQUENCE = 'noreset-synthetic-trial-informed-risk-v2'
RISK_SCHEMAS = {SCHEMA_RISK, SCHEMA_RISK_SEQUENCE}
APPEND_SCHEMAS = {SCHEMA_V3, *RISK_SCHEMAS}
USD_UNITS = Decimal('1000000000')  # Integer nano-USD, never a float ledger.


class TrialGateError(RuntimeError):
    def __init__(self, code='trial_authorization_required'):
        self.code = code
        super().__init__('合成试验尚未获得有效预算授权，原始资料已保留。' if code == 'trial_authorization_required'
                         else '合成试验请求预算已用完，原始资料已保留。')


def _deny():
    raise TrialGateError()


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate field')
        value[key] = item
    return value


def _decimal(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d+(?:\.\d{1,9})?', value):
        _deny()
    result = Decimal(value)
    if not result.is_finite() or result <= 0:
        _deny()
    return result


def _usd(units):
    return format(Decimal(units) / USD_UNITS, 'f')


def _quote(kind, profile, *, historical=False):
    billing = profile['billing']
    if isinstance(billing, dict) and 'charge_contract' in billing:
        base = dict(profile, billing={k: v for k, v in billing.items() if k != 'charge_contract'})
        quoted = _quote(kind, base, historical=historical)
        if quoted is None:
            _deny()
        contract = billing['charge_contract']
        required = {'status', 'approval_ref', 'evidence_url', 'expires_at', 'complete_input',
                    'complete_generated', 'includes_reasoning', 'includes_internal_attempts',
                    'includes_failed_and_partial_attempts', 'includes_all_routes_and_models',
                    'no_additional_charges', 'mode'}
        if not isinstance(contract, dict):
            _deny()
        mode = contract.get('mode')
        extra = {'max_billable_attempts'} if mode == 'bounded_attempts' else {'max_total_usd'}
        if (mode not in {'bounded_attempts', 'single_post_amount'} or set(contract) != required | extra
                or contract['status'] != 'verified'
                or any(contract[field] is not True for field in required - {'status', 'approval_ref', 'evidence_url', 'expires_at', 'mode'})
                or not isinstance(contract['approval_ref'], str) or not contract['approval_ref'].strip()):
            _deny()
        evidence = urlsplit(contract['evidence_url'])
        expires = datetime.fromisoformat(contract['expires_at'].replace('Z', '+00:00'))
        if (evidence.scheme != 'https' or evidence.hostname not in {'docs.aihubmix.com', 'aihubmix.com', 'api-docs.deepseek.com'}
                or evidence.username or evidence.password or not expires.tzinfo
                or (not historical and expires <= datetime.now(timezone.utc))):
            _deny()
        if mode == 'bounded_attempts':
            attempts = contract['max_billable_attempts']
            if type(attempts) is not int or not 0 < attempts < 2**31:
                _deny()
            units = quoted[1] * attempts  # Bounds/rates cover each possible internal attempt.
        else:
            units = int((_decimal(contract['max_total_usd']) * USD_UNITS).to_integral_value(rounding=ROUND_CEILING))
        if not 0 < units < 2**63:
            _deny()
        return billing, units
    if billing == {'status': 'pending'}:
        return None
    fields = {'status', 'currency', 'model', 'evidence_url', 'evidence_date', 'expires_at',
              'approval_ref', 'usd_per_million_input_tokens', 'usd_per_million_generated_tokens',
              'max_billable_input_tokens', 'max_billable_generated_tokens',
              'completion_tokens_include_reasoning', 'returned_models'}
    if not isinstance(billing, dict) or set(billing) != fields or billing['status'] != 'verified' or billing['currency'] != 'USD':
        _deny()
    if billing['model'] != profile['model'] or billing['completion_tokens_include_reasoning'] is not True:
        _deny()
    evidence = urlsplit(billing['evidence_url'])
    if evidence.scheme != 'https' or not evidence.hostname or evidence.username or evidence.password:
        _deny()
    if not isinstance(billing['approval_ref'], str) or not billing['approval_ref'].strip():
        _deny()
    dated = datetime.fromisoformat(billing['evidence_date']).date()
    expires = datetime.fromisoformat(billing['expires_at'].replace('Z', '+00:00'))
    if dated > datetime.now(timezone.utc).date() or not expires.tzinfo or (not historical and expires <= datetime.now(timezone.utc)):
        _deny()
    if (type(billing['max_billable_input_tokens']) is not int or not 0 < billing['max_billable_input_tokens'] < 2**63
            or type(billing['max_billable_generated_tokens']) is not int
            or not profile['max_output_tokens'] <= billing['max_billable_generated_tokens'] < 2**63):
        _deny()
    aliases = billing['returned_models']
    if not isinstance(aliases, list) or not aliases or any(not isinstance(alias, str) or not alias.strip() for alias in aliases) or len(set(aliases)) != len(aliases):
        _deny()
    incoming = _decimal(billing['usd_per_million_input_tokens'])
    generated = _decimal(billing['usd_per_million_generated_tokens'])
    if kind == 'llm' and (profile['model'] != 'deepseek-flash' or evidence.hostname != 'api-docs.deepseek.com'
            or incoming != Decimal('0.30') or generated != Decimal('1.20')
            or billing['max_billable_input_tokens'] != 1048576 or billing['max_billable_generated_tokens'] != 2048):
        _deny()  # Only this reviewed text snapshot is supported by this slice.
    if kind == 'llm' and not set(aliases) <= {'deepseek-flash', 'deepseek-v4-flash'}:
        _deny()
    if kind in {'asr', 'ocr'} and evidence.hostname not in {'docs.aihubmix.com', 'aihubmix.com'}:
        _deny()
    worst = (incoming * billing['max_billable_input_tokens'] + generated * billing['max_billable_generated_tokens']) / Decimal('1000000')
    units = int((worst * USD_UNITS).to_integral_value(rounding=ROUND_CEILING))
    if not 0 < units < 2**63:
        _deny()
    return billing, units


def _official_endpoint(kind, profile):
    endpoint = urlsplit(profile['url'])
    if endpoint.scheme != 'https' or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment or endpoint.port not in {None, 443}:
        return False
    if kind == 'llm':
        return (profile['provider'] in {'deepseek', 'deepseek-ai'} and endpoint.hostname == 'api.deepseek.com'
                and endpoint.path in {'/chat/completions', '/v1/chat/completions'})
    if profile['provider'] != 'aihubmix' or endpoint.hostname != 'aihubmix.com':
        return False
    if kind == 'ocr':
        return endpoint.path == '/v1/chat/completions'
    from urllib.parse import quote
    return endpoint.path == '/gemini/v1beta/models/' + quote(profile['model'], safe='-._') + ':generateContent'


def is_loopback_url(url):
    """No proxies or redirects may be used by a permitted local transport."""
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password:
            return False
        host = parsed.hostname
        if host.lower() == 'localhost':
            addresses = {row[4][0] for row in socket.getaddrinfo(host, parsed.port or 80, type=socket.SOCK_STREAM)}
            return bool(addresses) and all(ipaddress.ip_address(address).is_loopback for address in addresses)
        return ipaddress.ip_address(host).is_loopback
    except (ValueError, OSError):
        return False


def _receipt(path):
    try:
        return _parse_receipt(Path(path).read_bytes())
    except OSError:
        raise TrialGateError() from None


def _parse_receipt(raw, *, historical=False):
    try:
        if len(raw) > 65536:
            _deny()
        data = json.loads(raw, object_pairs_hook=_unique_object)
        if isinstance(data, dict) and data.get('schema_version') in APPEND_SCHEMAS:
            _validate_v3(data, historical=historical)
            return data, hashlib.sha256(raw).hexdigest()
        required = {'schema_version', 'receipt_id', 'status', 'authorization_source', 'approval_ref',
                    'synthetic_only', 'expires_at', 'total_requests', 'planned_text_requests', 'spend_authorization', 'profiles'}
        if not isinstance(data, dict) or set(data) != required or data['schema_version'] != SCHEMA:
            _deny()
        if data['status'] != 'approved' or data['authorization_source'] != 'explicit_owner_approval' or data['synthetic_only'] is not True:
            _deny()
        spend = data['spend_authorization']
        if (not isinstance(spend, dict) or set(spend) != {'currency', 'amount', 'hard_currency_cap', 'billing_limitations_accepted'}
                or spend['currency'] != 'USD' or _decimal(spend['amount']) > Decimal('1')
                or spend['hard_currency_cap'] is not True or spend['billing_limitations_accepted'] is not False):
            _deny()
        if any(not isinstance(data[field], str) or not data[field].strip() for field in ('receipt_id', 'approval_ref', 'expires_at')):
            _deny()
        expires = datetime.fromisoformat(data['expires_at'].replace('Z', '+00:00'))
        if not expires.tzinfo or (not historical and expires <= datetime.now(timezone.utc)) or type(data['total_requests']) is not int or data['total_requests'] != 5 or type(data['planned_text_requests']) is not int or data['planned_text_requests'] != 3:
            _deny()
        if not isinstance(data['profiles'], dict) or set(data['profiles']) != set(CAPS):
            _deny()
        for kind, profile in data['profiles'].items():
            fields = {'provider', 'model', 'url', 'requests', 'max_input_bytes', 'max_output_tokens',
                      'max_thinking_tokens', 'source_sha256', 'request_sha256', 'billing'}
            if not isinstance(profile, dict) or set(profile) != fields:
                _deny()
            if any(not isinstance(profile[field], str) or not profile[field].strip() for field in ('provider', 'model', 'url')):
                _deny()
            if not _official_endpoint(kind, profile):
                _deny()
            count, output, thinking = CAPS[kind]
            if (type(profile['requests']) is not int or not 0 < profile['requests'] <= count
                    or type(profile['max_input_bytes']) is not int or not 0 < profile['max_input_bytes'] <= MAX_WIRE_BYTES[kind]
                    or type(profile['max_output_tokens']) is not int or not 0 < profile['max_output_tokens'] <= output
                    or type(profile['max_thinking_tokens']) is not int or not 0 <= profile['max_thinking_tokens'] <= thinking):
                _deny()
            for field in ('source_sha256', 'request_sha256'):
                values = profile[field]
                if not isinstance(values, list) or not 1 <= len(values) <= 5 or any(not isinstance(value, str) or not HASH.fullmatch(value) for value in values) or len(set(values)) != len(values):
                    _deny()
            _quote(kind, profile, historical=historical)
        return data, hashlib.sha256(raw).hexdigest()
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError, InvalidOperation):
        raise TrialGateError() from None


def _snapshot(receipt):
    return json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _budget_digest(receipt):
    frozen = json.loads(_snapshot(receipt))
    frozen.pop('approval_ref')
    for profile in frozen['profiles'].values():
        profile.pop('source_sha256')
        profile.pop('request_sha256')
        profile.pop('billing')  # Existing verified quotes are checked separately.
    return hashlib.sha256(_snapshot(frozen).encode()).hexdigest()


def initialize_trial(receipt_path=RECEIPT_PATH, state_path=STATE_PATH):
    """Explicit trusted setup only; reserve never recreates missing state.

    The caller must first record the owner's actual approval in the receipt.
    Existing ledgers are not reset or replaced by this operation.
    """
    receipt, digest = _receipt(receipt_path)
    if receipt['schema_version'] != SCHEMA:
        _deny()  # v3 must append to an existing cumulative ledger.
    target = Path(state_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with target.open('xb'):
            pass
        with sqlite3.connect(target) as connection:
            connection.execute('CREATE TABLE metadata (receipt_sha256 TEXT NOT NULL, budget_sha256 TEXT NOT NULL, receipt_json TEXT NOT NULL, frozen_reason TEXT)')
            connection.execute('INSERT INTO metadata VALUES (?,?,?,NULL)', (digest, _budget_digest(receipt), _snapshot(receipt)))
            connection.execute('CREATE TABLE attempts (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, request_sha256 TEXT NOT NULL, source_sha256 TEXT NOT NULL, wire_bytes INTEGER NOT NULL, output_limit INTEGER NOT NULL, thinking_limit INTEGER NOT NULL, input_bound INTEGER NOT NULL, generated_bound INTEGER NOT NULL, reserved_nano_usd INTEGER NOT NULL, pricing_json TEXT NOT NULL, usage_json TEXT)')
    except (OSError, sqlite3.Error):
        raise TrialGateError() from None


def amend_trial(receipt_path=RECEIPT_PATH, state_path=STATE_PATH):
    """Explicit local approval of derived synthetic hashes; never called by HTTP.

    A human must inspect the new wire/source and record a new approval_ref first.
    Every budget/profile field stays frozen. Only hash-list suffixes may be added;
    the existing durable attempts table is never changed or reset.
    """
    try:
        receipt, digest = _receipt(receipt_path)
        if receipt['schema_version'] in APPEND_SCHEMAS:
            return _amend_v3(receipt, digest, state_path)
        with sqlite3.connect(Path(state_path).resolve().as_uri() + '?mode=rw', uri=True, timeout=10) as connection:
            connection.execute('BEGIN IMMEDIATE')
            rows = connection.execute('SELECT receipt_sha256,budget_sha256,receipt_json FROM metadata').fetchall()
            if len(rows) != 1:
                _deny()
            old_sha, budget_sha, old_json = rows[0]
            old = json.loads(old_json, object_pairs_hook=_unique_object)
            if (not isinstance(old_sha, str) or not HASH.fullmatch(old_sha) or digest == old_sha
                    or _budget_digest(old) != budget_sha or _budget_digest(receipt) != budget_sha
                    or receipt['approval_ref'] == old['approval_ref']):
                _deny()
            added = False
            for kind in CAPS:
                previous_quote, current_quote = old['profiles'][kind]['billing'], receipt['profiles'][kind]['billing']
                if previous_quote != current_quote:
                    if previous_quote != {'status': 'pending'} or _quote(kind, receipt['profiles'][kind]) is None:
                        _deny()
                    added = True
                for field in ('source_sha256', 'request_sha256'):
                    previous, current = old['profiles'][kind][field], receipt['profiles'][kind][field]
                    if not isinstance(previous, list) or current[:len(previous)] != previous:
                        _deny()
                    added |= len(current) > len(previous)
            if not added:
                _deny()
            connection.execute('UPDATE metadata SET receipt_sha256=?,receipt_json=?', (digest, _snapshot(receipt)))
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError, AttributeError):
        raise TrialGateError() from None


def _history(connection, receipt, *, historical=False, _validation_path=None, _depth=0):
    """Recheck each durable reserve; damaged but readable rows fail closed."""
    if receipt['schema_version'] in APPEND_SCHEMAS:
        return _history_v3(connection, receipt, _validation_path=_validation_path, _depth=_depth)
    rows = connection.execute('SELECT kind,request_sha256,source_sha256,wire_bytes,output_limit,thinking_limit,input_bound,generated_bound,reserved_nano_usd,pricing_json,usage_json FROM attempts').fetchall()
    counts, occupied = {}, 0
    for kind, wire_sha, source_sha, wire_bytes, output, thinking, incoming_bound, generated_bound, cost, pricing_json, usage_json in rows:
        if kind not in CAPS:
            _deny()
        profile = receipt['profiles'][kind]
        quoted = _quote(kind, profile, historical=historical)
        if quoted is None:
            _deny()
        pricing, expected_cost = quoted
        if (type(cost) is not int or cost != expected_cost or pricing_json != _snapshot(pricing)
                or incoming_bound != pricing['max_billable_input_tokens'] or generated_bound != pricing['max_billable_generated_tokens']
                or wire_sha not in profile['request_sha256'] or source_sha not in profile['source_sha256']
                or type(wire_bytes) is not int or not 0 < wire_bytes <= profile['max_input_bytes']
                or type(output) is not int or not 0 < output <= profile['max_output_tokens']
                or type(thinking) is not int or not 0 <= thinking <= profile['max_thinking_tokens']
                or usage_json is None):
            _deny()
        usage = json.loads(usage_json, object_pairs_hook=_unique_object)
        if (not isinstance(usage, dict) or set(usage) != {'returned_model','prompt_tokens','completion_tokens','reasoning_tokens','verified'}
                or usage['verified'] is not True or usage['returned_model'] not in pricing['returned_models']
                or type(usage['prompt_tokens']) is not int or not 0 <= usage['prompt_tokens'] <= incoming_bound
                or type(usage['completion_tokens']) is not int or not 0 <= usage['completion_tokens'] <= generated_bound
                or type(usage['reasoning_tokens']) is not int or not 0 <= usage['reasoning_tokens'] <= usage['completion_tokens']):
            _deny()
        counts[kind] = counts.get(kind, 0) + 1
        occupied += cost
    if (sum(counts.values()) > receipt['total_requests'] or any(count > receipt['profiles'][kind]['requests'] for kind,count in counts.items())
            or occupied > int(_decimal(receipt['spend_authorization']['amount']) * USD_UNITS)):
        _deny()
    return counts, occupied


class TrialGate:
    def __init__(self, receipt_path=RECEIPT_PATH, state_path=STATE_PATH):
        self.receipt_path, self.state_path = Path(receipt_path), Path(state_path)

    def reserve(self, *, kind, provider, model, url, wire, source_sha256, output_tokens, thinking_tokens):
        try:
            receipt, digest = _receipt(self.receipt_path)
            if receipt['schema_version'] in APPEND_SCHEMAS:
                return _reserve_v3(self, receipt, digest, kind=kind, provider=provider, model=model,
                    url=url, wire=wire, source_sha256=source_sha256,
                    output_tokens=output_tokens, thinking_tokens=thinking_tokens)
            if kind not in CAPS or not isinstance(wire, bytes):
                _deny()
            profile = receipt['profiles'][kind]
            quote = _quote(kind, profile)
            if quote is None:
                _deny()  # No reviewed media/token price upper bound, no request.
            pricing, reservation = quote
            request_hash = hashlib.sha256(wire).hexdigest()
            if ((provider, model, url) != (profile['provider'], profile['model'], profile['url'])
                    or len(wire) > profile['max_input_bytes']
                    or request_hash not in profile['request_sha256'] or source_sha256 not in profile['source_sha256']
                    or type(output_tokens) is not int or not 0 < output_tokens <= profile['max_output_tokens']
                    or type(thinking_tokens) is not int or not 0 <= thinking_tokens <= profile['max_thinking_tokens']):
                _deny()
            # mode=rw refuses missing files. A lost counter must never restart at 0.
            with sqlite3.connect(self.state_path.resolve().as_uri() + '?mode=rw', uri=True, timeout=10) as connection:
                connection.execute('BEGIN IMMEDIATE')
                if connection.execute('SELECT receipt_sha256,budget_sha256,receipt_json FROM metadata').fetchall() != [(digest, _budget_digest(receipt), _snapshot(receipt))]:
                    _deny()
                if connection.execute('SELECT frozen_reason FROM metadata').fetchone() != (None,):
                    _deny()
                counts, occupied = _history(connection, receipt)
                if sum(counts.values()) >= receipt['total_requests'] or counts.get(kind, 0) >= profile['requests']:
                    raise TrialGateError('trial_budget_exhausted')
                if occupied + reservation > int(_decimal(receipt['spend_authorization']['amount']) * USD_UNITS):
                    raise TrialGateError('trial_budget_exhausted')
                cursor = connection.execute('INSERT INTO attempts(kind,request_sha256,source_sha256,wire_bytes,output_limit,thinking_limit,input_bound,generated_bound,reserved_nano_usd,pricing_json) VALUES (?,?,?,?,?,?,?,?,?,?)',
                                   (kind, request_hash, source_sha256, len(wire), output_tokens, thinking_tokens,
                                    pricing['max_billable_input_tokens'], pricing['max_billable_generated_tokens'], reservation, _snapshot(pricing)))
                attempt_id = cursor.lastrowid
                # Commit before network. Failure, timeout and automatic follow-on
                # requests consume the same durable allowance without refunds.
            return attempt_id
        except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
            raise TrialGateError() from None


def validate_trial_authorization(*, receipt_path=RECEIPT_PATH, state_path=STATE_PATH):
    """Read-only preflight before any credential/config loading."""
    try:
        receipt, digest = _receipt(receipt_path)
        with sqlite3.connect(Path(state_path).resolve().as_uri() + '?mode=ro', uri=True) as connection:
            if connection.execute('SELECT receipt_sha256,budget_sha256,receipt_json,frozen_reason FROM metadata').fetchall() != [(digest, _budget_digest(receipt), _snapshot(receipt), None)]:
                _deny()
            counts, occupied = _history(connection, receipt)
            if receipt['schema_version'] in RISK_SCHEMAS:
                result = {'receipt': receipt, 'receipt_sha256': digest, 'remaining_usd': None,
                        'cost_bound_known': False, 'estimated_new_usd': receipt['spend_authorization']['estimated_new_usd'],
                        'historical_reserved_usd': _usd(occupied),
                        'remaining_requests': receipt['total_requests'] - sum(counts.values()), 'frozen': False}
                if receipt['schema_version'] == SCHEMA_RISK_SEQUENCE:
                    try:
                        from . import trial_budget
                        result['cumulative_budget_status'] = trial_budget.validate_batch(receipt['cumulative_budget'], receipt=receipt)
                    except (ImportError, OSError, RuntimeError, ValueError, AttributeError):
                        _deny()
                    steps = _risk_scope_attempts(connection, receipt)
                    closed = _closed_context(connection, receipt)
                    result.update(scope_used_requests=len(steps),
                        next_kind=receipt['request_sequence'][len(steps)] if len(steps) < len(receipt['request_sequence']) else None,
                        manual_review_required=bool(steps and not _has_trial_review(connection, steps[-1][0])),
                        protected_through_attempt_id=closed.get('protected_through_attempt_id', closed['failed_attempt_id']) if closed else 0)
                return result
            budget = int(_decimal(receipt['spend_authorization']['amount']) * USD_UNITS)
            return {'receipt': receipt, 'receipt_sha256': digest, 'remaining_usd': _usd(budget - occupied),
                    'remaining_requests': receipt['total_requests'] - sum(counts.values()), 'frozen': False}
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError, InvalidOperation):
        raise TrialGateError() from None


def trial_journal(*, state_path=STATE_PATH):
    """Non-secret audit metadata only; never raw prompts, media or keys."""
    try:
        with sqlite3.connect(Path(state_path).resolve().as_uri() + '?mode=ro', uri=True) as connection:
            closed = _closed_context(connection)
            connection.row_factory = sqlite3.Row
            rows = connection.execute('SELECT * FROM attempts ORDER BY id').fetchall()
            result = []
            for row in rows:
                item = dict(row)
                item['reserved_usd'] = _usd(item.pop('reserved_nano_usd'))
                item['pricing'] = json.loads(item.pop('pricing_json'))
                usage_raw = item.pop('usage_json')
                item['usage'] = json.loads(usage_raw) if usage_raw else None
                if closed and item['id'] in closed.get('closed_unverified_attempt_ids', [closed['failed_attempt_id']]):
                    item['closed_status'] = 'failed_usage_unverified'
                if item['pricing'].get('status') == 'disclosed_estimate':
                    item['estimated_usd'] = item['pricing']['estimated_usd']
                    item['cost_bound_known'] = False
                result.append(item)
            return result
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
        raise TrialGateError() from None


def report_usage(attempt_id, returned_model, usage, *, state_path=STATE_PATH, transport_metadata=None):
    """Verify usage against its reserved quote. Nothing refunds the reserve.

    Missing/unknown/oversized usage freezes future sends permanently. A valid
    usage report remains valid even if later business-output validation fails.
    """
    try:
        if type(attempt_id) is not int or attempt_id <= 0:
            _deny()
        frozen = False
        with sqlite3.connect(Path(state_path).resolve().as_uri() + '?mode=rw', uri=True, timeout=10) as connection:
            connection.execute('BEGIN IMMEDIATE')
            closed = _closed_context(connection)
            if closed and attempt_id <= closed.get('protected_through_attempt_id', closed['failed_attempt_id']):
                _deny()  # Historical closure is never a late usage-report target.
            row = connection.execute('SELECT input_bound,generated_bound,pricing_json,usage_json,thinking_limit,output_limit FROM attempts WHERE id=?', (attempt_id,)).fetchone()
            if row is None:
                _deny()
            incoming_bound, generated_bound, pricing_json, previous, thinking_limit, output_limit = row
            pricing = json.loads(pricing_json)
            current_receipt, _ = _parse_receipt(connection.execute('SELECT receipt_json FROM metadata').fetchone()[0].encode(), historical=True)
            risk = pricing.get('status') == 'disclosed_estimate'
            strict = 'charge_contract' in pricing or risk
            prompt = usage.get('prompt_tokens') if isinstance(usage, dict) else None
            generated = usage.get('completion_tokens') if isinstance(usage, dict) else None
            details = usage.get('completion_tokens_details') if isinstance(usage, dict) else None
            thinking = details.get('reasoning_tokens', 0) if isinstance(details, dict) else 0
            valid = (returned_model in pricing['returned_models'] and pricing['completion_tokens_include_reasoning'] is True
                     and (details is None or isinstance(details, dict))
                     and (not strict or isinstance(details, dict) and 'reasoning_tokens' in details)
                     and type(prompt) is int and 0 <= prompt <= incoming_bound
                     and type(generated) is int and 0 <= generated <= generated_bound
                     and type(thinking) is int and 0 <= thinking <= generated
                     and (not strict or thinking <= thinking_limit and generated <= output_limit))
            if valid and risk:
                observed_cost = (_decimal(pricing['usd_per_million_input_tokens']) * prompt
                                 + _decimal(pricing['usd_per_million_generated_tokens']) * generated) / Decimal('1000000')
                valid = observed_cost <= _decimal(pricing['estimated_usd'])
            normalized = {'returned_model': returned_model if isinstance(returned_model, str) else None,
                          'prompt_tokens': prompt if type(prompt) is int and 0 <= prompt < 2**63 else None,
                          'completion_tokens': generated if type(generated) is int and 0 <= generated < 2**63 else None,
                          'reasoning_tokens': thinking if type(thinking) is int and 0 <= thinking < 2**63 else None,
                          'verified': bool(valid)}
            encoded = _snapshot(normalized)
            stopped = connection.execute('SELECT frozen_reason FROM metadata').fetchone()[0]
            if stopped is not None and previous != encoded:
                _deny()  # A late callback cannot replace a stopped unknown fact.
            if previous is not None and previous != encoded:
                valid = False
            if not valid:
                connection.execute('UPDATE metadata SET frozen_reason=COALESCE(frozen_reason,?)', ('usage_unverified_or_over_bound',))
                current_receipt, _ = _parse_receipt(connection.execute('SELECT receipt_json FROM metadata').fetchone()[0].encode(), historical=True)
                frozen = True
            if previous is None:
                connection.execute('UPDATE attempts SET usage_json=? WHERE id=?', (encoded, attempt_id))
            if transport_metadata is not None:
                _save_transport_metadata(connection, attempt_id, transport_metadata)
            elif previous is not None and _table_exists(connection, 'transport_metadata'):
                saved = connection.execute('SELECT metadata_json FROM transport_metadata WHERE attempt_id=?', (attempt_id,)).fetchone()
                transport_metadata = json.loads(saved[0]) if saved else None
            observation = None
            if valid and 'cumulative_budget' in current_receipt:
                scope_steps = _risk_scope_attempts(connection, current_receipt)
                indices = [i for i, (ident, _) in enumerate(scope_steps) if ident == attempt_id]
                if (len(indices) != 1 or not isinstance(transport_metadata, dict)
                        or not HASH.fullmatch(str(transport_metadata.get('response_sha256', '')))):
                    connection.execute("UPDATE metadata SET frozen_reason=COALESCE(frozen_reason,'usage_unverified')")
                    frozen = True
                else:
                    kind, wire_sha, source_sha = connection.execute('SELECT kind,request_sha256,source_sha256 FROM attempts WHERE id=?', (attempt_id,)).fetchone()
                    observation = dict(receipt_id=current_receipt['receipt_id'], slot=indices[0], kind=kind,
                        source_sha256=source_sha, request_sha256=wire_sha, returned_model=returned_model,
                        usage=usage, response_sha256=transport_metadata['response_sha256'])
        if frozen:
            with sqlite3.connect(Path(state_path)) as connection:
                reason = connection.execute('SELECT frozen_reason FROM metadata').fetchone()[0]
            _close_cumulative_budget(current_receipt, reason)
            _deny()  # Raise after the freeze transaction has committed.
        if observation is not None:
            try:
                from . import trial_budget
                trial_budget.mark_observed(current_receipt['cumulative_budget'], **observation)
            except (ImportError, OSError, RuntimeError, ValueError, AttributeError):
                with sqlite3.connect(Path(state_path)) as connection:
                    connection.execute("UPDATE metadata SET frozen_reason=COALESCE(frozen_reason,'usage_unverified')")
                    reason = connection.execute('SELECT frozen_reason FROM metadata').fetchone()[0]
                _close_cumulative_budget(current_receipt, reason)
                _deny()
        return normalized
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
        raise TrialGateError() from None


def _validate_v3(data, *, historical=False):
    risk = data['schema_version'] in RISK_SCHEMAS
    ordered = data['schema_version'] == SCHEMA_RISK_SEQUENCE
    fields = {'schema_version', 'receipt_id', 'status', 'authorization_source', 'approval_ref',
              'synthetic_only', 'expires_at', 'total_requests', 'planned_text_requests',
              'spend_authorization', 'profiles', 'previous_receipt_sha256'}
    if risk:
        fields.add('approved_at')
    if ordered:
        fields.update({'request_sequence', 'cumulative_budget'})
        descriptor = data.get('cumulative_budget')
        if (not isinstance(descriptor, dict) or set(descriptor) != {'authorization_sha256', 'authorization_path', 'state_path'}
                or not isinstance(descriptor['authorization_sha256'], str) or not HASH.fullmatch(descriptor['authorization_sha256'])):
            _deny()
        for key in ('authorization_path', 'state_path'):
            value = descriptor[key]
            if not isinstance(value, str) or not Path(value).is_absolute() or str(Path(value).resolve()) != value:
                _deny()
        if descriptor['authorization_path'] == descriptor['state_path']:
            _deny()
    if (set(data) != fields or data['status'] != 'approved'
            or data['authorization_source'] != 'explicit_owner_approval' or data['synthetic_only'] is not True
            or not isinstance(data['previous_receipt_sha256'], str) or not HASH.fullmatch(data['previous_receipt_sha256'])):
        _deny()
    for field in ('receipt_id', 'approval_ref', 'expires_at'):
        if not isinstance(data[field], str) or not data[field].strip():
            _deny()
    expires = datetime.fromisoformat(data['expires_at'].replace('Z', '+00:00'))
    if not expires.tzinfo or not historical and expires <= datetime.now(timezone.utc):
        _deny()
    spend = data['spend_authorization']
    if risk:
        approved = datetime.fromisoformat(data['approved_at'].replace('Z', '+00:00'))
        if (not approved.tzinfo or approved >= expires or expires - approved > timedelta(minutes=60)
                or not historical and approved > datetime.now(timezone.utc)
                or not isinstance(spend, dict) or set(spend) != {'currency', 'estimated_new_usd', 'hard_currency_cap',
                    'billing_limitations_accepted', 'scope', 'unknown_final_cost_accepted'}
                or spend['currency'] != 'USD' or spend['hard_currency_cap'] is not False
                or spend['billing_limitations_accepted'] is not True or spend['unknown_final_cost_accepted'] is not True
                or spend['scope'] != 'limited_requests_with_disclosed_non_hard_estimate'):
            _deny()
    elif (not isinstance(spend, dict) or set(spend) != {'currency', 'amount', 'hard_currency_cap', 'billing_limitations_accepted', 'scope'}
            or spend['currency'] != 'USD' or spend['hard_currency_cap'] is not True
            or spend['billing_limitations_accepted'] is not False
            or spend['scope'] != 'cumulative_reservations_and_new_contract_bounds'
            or not 0 < _decimal(spend['amount']) * USD_UNITS < 2**63):
        _deny()
    if (type(data['total_requests']) is not int or not 0 < data['total_requests'] < 2**31
            or type(data['planned_text_requests']) is not int):
        _deny()
    if (not isinstance(data['profiles'], dict)
            or (not ordered and set(data['profiles']) != {'llm', 'asr'})
            or (ordered and (not data['profiles'] or not set(data['profiles']) <= {'llm', 'asr'}))):
        _deny()
    if data['planned_text_requests'] != data['profiles'].get('llm', {}).get('requests', 0):
        _deny()
    for kind, profile in data['profiles'].items():
        expected = {'provider', 'model', 'url', 'requests', 'max_input_bytes', 'max_output_tokens',
                    'max_thinking_tokens', 'source_sha256', 'request_sha256', 'billing'}
        if (not isinstance(profile, dict) or set(profile) != expected or not _official_endpoint(kind, profile)
                or kind == 'asr' and profile['model'] != 'gemini-2.5-flash-lite'
                or risk and kind == 'llm' and (profile['provider'] != 'deepseek' or profile['url'] != 'https://api.deepseek.com/chat/completions')
                or type(profile['requests']) is not int or not 0 < profile['requests'] <= 2
                or type(profile['max_input_bytes']) is not int or not 0 < profile['max_input_bytes'] <= MAX_WIRE_BYTES[kind]
                or type(profile['max_output_tokens']) is not int or not 0 < profile['max_output_tokens'] <= CAPS[kind][1]
                or type(profile['max_thinking_tokens']) is not int or profile['max_thinking_tokens'] != 0):
            _deny()
        for field in ('source_sha256', 'request_sha256'):
            values = profile[field]
            minimum, maximum = (0, profile['requests']) if ordered else (0, 2) if risk and kind == 'llm' else (1, 2) if risk else (1, 5)
            if (not isinstance(values, list) or not minimum <= len(values) <= maximum
                    or any(not isinstance(value, str) or not HASH.fullmatch(value) for value in values)
                    or len(set(values)) != len(values)):
                _deny()
        if ordered and len(profile['source_sha256']) != len(profile['request_sha256']):
            _deny()
        if not risk and (not isinstance(profile['billing'], dict) or 'charge_contract' not in profile['billing']):
            _deny()  # Legacy estimates do not become new hard contracts.
        _profile_quote(data, kind, historical=historical)
    if ordered:
        sequence = data['request_sequence']
        if (not isinstance(sequence, list) or not 1 <= len(sequence) <= 4
                or any(not isinstance(kind, str) or kind not in data['profiles'] for kind in sequence)
                or any(sequence.count(kind) != profile['requests'] for kind, profile in data['profiles'].items())):
            _deny()
    if risk and ((not ordered and data['profiles']['asr']['requests'] != data['profiles']['llm']['requests'])
            or _decimal(spend['estimated_new_usd']) != sum(_decimal(p['billing']['estimated_usd']) * p['requests'] for p in data['profiles'].values())):
        _deny()


def _risk_quote(kind, profile, *, historical=False):
    """Planning figures and observed stop thresholds; never a billing bound."""
    billing = profile['billing']
    fields = {'status', 'currency', 'model', 'evidence_url', 'evidence_date', 'expires_at', 'approval_ref',
              'usd_per_million_input_tokens', 'usd_per_million_generated_tokens', 'estimated_input_tokens',
              'estimated_usd', 'observed_input_tokens_limit', 'observed_generated_tokens_limit',
              'completion_tokens_include_reasoning', 'returned_models', 'complete_cost_bound_known',
              'internal_billable_attempts_known'}
    if (not isinstance(billing, dict) or set(billing) != fields or billing['status'] != 'disclosed_estimate'
            or billing['currency'] != 'USD' or billing['model'] != profile['model']
            or billing['complete_cost_bound_known'] is not False or billing['internal_billable_attempts_known'] is not False
            or billing['completion_tokens_include_reasoning'] is not True
            or not isinstance(billing['approval_ref'], str) or not billing['approval_ref'].strip()):
        _deny()
    evidence = urlsplit(billing['evidence_url'])
    expires = datetime.fromisoformat(billing['expires_at'].replace('Z', '+00:00'))
    if (evidence.scheme != 'https' or evidence.username or evidence.password
            or evidence.hostname not in ({'api-docs.deepseek.com'} if kind == 'llm' else {'docs.aihubmix.com', 'aihubmix.com'})
            or datetime.fromisoformat(billing['evidence_date']).date() > datetime.now(timezone.utc).date()
            or not expires.tzinfo or not historical and expires <= datetime.now(timezone.utc)):
        _deny()
    incoming, generated = (24000, 2048) if kind == 'llm' else (2048, 1024)
    if (type(billing['estimated_input_tokens']) is not int or billing['estimated_input_tokens'] != incoming
            or type(billing['observed_input_tokens_limit']) is not int or billing['observed_input_tokens_limit'] != incoming
            or type(billing['observed_generated_tokens_limit']) is not int or billing['observed_generated_tokens_limit'] != generated
            or _decimal(billing['usd_per_million_input_tokens']) != Decimal('0.30')
            or _decimal(billing['usd_per_million_generated_tokens']) != (Decimal('1.20') if kind == 'llm' else Decimal('0.40'))):
        _deny()
    expected = (Decimal('0.30') * incoming + _decimal(billing['usd_per_million_generated_tokens']) * generated) / Decimal('1000000')
    aliases = billing['returned_models']
    if (not isinstance(aliases, list) or not aliases or len(set(aliases)) != len(aliases)
            or any(not isinstance(alias, str) or not alias.strip() for alias in aliases)
            or kind == 'llm' and not set(aliases) <= {'deepseek-flash', 'deepseek-v4-flash'}
            or _decimal(billing['estimated_usd']) != expected):
        _deny()
    return billing, 0  # A zero hard reserve is explicitly NOT a zero charge claim.


def _profile_quote(receipt, kind, *, historical=False):
    function = _risk_quote if receipt['schema_version'] in RISK_SCHEMAS else _quote
    return function(kind, receipt['profiles'][kind], historical=historical)


def _usage_bounds(pricing):
    if pricing.get('status') == 'disclosed_estimate':
        return pricing['observed_input_tokens_limit'], pricing['observed_generated_tokens_limit']
    return pricing['max_billable_input_tokens'], pricing['max_billable_generated_tokens']


def _authority_tables(connection):
    connection.execute('CREATE TABLE IF NOT EXISTS authorization_snapshots (receipt_sha256 TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, previous_sha256 TEXT, receipt_json TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL)')
    connection.execute('CREATE TABLE IF NOT EXISTS attempt_authorizations (attempt_id INTEGER PRIMARY KEY, receipt_sha256 TEXT NOT NULL)')


def _save_authority(connection, digest, receipt, previous):
    snapshot = _snapshot(receipt)
    connection.execute('INSERT INTO authorization_snapshots VALUES (?,?,?,?,?)',
        (digest, receipt['receipt_id'], previous, snapshot, hashlib.sha256(snapshot.encode()).hexdigest()))


def _authority_history(connection, head):
    values = connection.execute('SELECT receipt_sha256,receipt_id,previous_sha256,receipt_json,snapshot_sha256 FROM authorization_snapshots').fetchall()
    authorities = {}
    for sha, receipt_id, previous, raw, snapshot_sha in values:
        if (not isinstance(sha, str) or not HASH.fullmatch(sha)
                or hashlib.sha256(raw.encode()).hexdigest() != snapshot_sha):
            _deny()
        receipt, _ = _parse_receipt(raw.encode(), historical=True)
        if receipt['receipt_id'] != receipt_id or sha in authorities:
            _deny()
        authorities[sha] = (receipt, previous)
    seen = set()
    while head is not None:
        if head in seen or head not in authorities:
            _deny()
        seen.add(head)
        receipt, previous = authorities[head]
        if previous is not None:
            if previous not in authorities:
                _deny()
            old = authorities[previous][0]
            if receipt['receipt_id'] != old['receipt_id']:
                ancestors, cursor = set(), previous
                while cursor is not None:
                    if cursor in ancestors or cursor not in authorities:
                        _deny()
                    ancestors.add(cursor)
                    cursor = authorities[cursor][1]
                prior_count = sum(sha in ancestors for (sha,) in connection.execute('SELECT receipt_sha256 FROM attempt_authorizations'))
                if (receipt.get('previous_receipt_sha256') != previous
                        or receipt['total_requests'] != prior_count + sum(p['requests'] for p in receipt['profiles'].values())):
                    _deny()
            elif _budget_digest(receipt) != _budget_digest(old):
                _deny()
        elif receipt['schema_version'] != SCHEMA:
            _deny()
        head = previous
    if seen != set(authorities):
        _deny()
    return authorities


def _history_v3(connection, receipt, *, _closed_failure=None, _validation_path=None, _depth=0, _closed_unverified_ids=()):
    metadata = connection.execute('SELECT receipt_sha256 FROM metadata').fetchall()
    if len(metadata) != 1:
        _deny()
    authorities = _authority_history(connection, metadata[0][0])
    if _snapshot(authorities[metadata[0][0]][0]) != _snapshot(receipt):
        _deny()
    rows = connection.execute('SELECT * FROM attempts ORDER BY id').fetchall()
    links = dict(connection.execute('SELECT attempt_id,receipt_sha256 FROM attempt_authorizations').fetchall())
    if set(links) != {row[0] for row in rows}:
        _deny()
    counts, scoped, occupied = {}, {}, 0
    closed = _closed_context(connection, receipt, _validation_path=_validation_path, _depth=_depth)
    failed = closed['failed_attempt_id'] if closed else _closed_failure
    failed_ids = set(closed.get('closed_unverified_attempt_ids', [failed]) if closed else [failed]) | set(_closed_unverified_ids)
    for row in rows:
        ident, kind, wire_sha, source_sha, size, output, thinking, incoming, generated, cost, price_json, usage_json = row
        if links[ident] not in authorities:
            _deny()
        authorization = authorities[links[ident]][0]
        profile = authorization['profiles'].get(kind)
        if profile is None:
            _deny()
        quoted = _profile_quote(authorization, kind, historical=True)
        if quoted is None:
            _deny()
        pricing, reserve = quoted
        if (type(cost) is not int or cost != reserve or price_json != _snapshot(pricing)
                or (incoming, generated) != _usage_bounds(pricing)
                or wire_sha not in profile['request_sha256'] or source_sha not in profile['source_sha256']
                or type(size) is not int or not 0 < size <= profile['max_input_bytes']
                or type(output) is not int or not 0 < output <= profile['max_output_tokens']
                or type(thinking) is not int or not 0 <= thinking <= profile['max_thinking_tokens']
                or usage_json is None and ident not in failed_ids):
            _deny()
        usage = json.loads(usage_json, object_pairs_hook=_unique_object) if usage_json is not None else None
        if ident in failed_ids:
            if usage is not None and (not isinstance(usage, dict)
                    or set(usage) != {'returned_model', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'verified'}
                    or usage['verified'] is not False):
                _deny()
        elif (not isinstance(usage, dict) or set(usage) != {'returned_model', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'verified'}
                or usage['verified'] is not True or usage['returned_model'] not in pricing['returned_models']
                or type(usage['prompt_tokens']) is not int or not 0 <= usage['prompt_tokens'] <= incoming
                or type(usage['completion_tokens']) is not int or not 0 <= usage['completion_tokens'] <= generated
                or type(usage['reasoning_tokens']) is not int or not 0 <= usage['reasoning_tokens'] <= usage['completion_tokens']
                or authorization['schema_version'] in APPEND_SCHEMAS
                and (usage['reasoning_tokens'] > thinking or usage['completion_tokens'] > output)):
            _deny()
        scope = (authorization['receipt_id'], kind)
        scoped[scope] = scoped.get(scope, 0) + 1
        if scoped[scope] > profile['requests']:
            _deny()
        counts[kind] = counts.get(kind, 0) + 1
        occupied += cost
    if (sum(counts.values()) > receipt['total_requests']
            or receipt['schema_version'] not in RISK_SCHEMAS and occupied > int(_decimal(receipt['spend_authorization']['amount']) * USD_UNITS)):
        _deny()
    return counts, occupied


def append_trial(receipt_path=RECEIPT_PATH, state_path=STATE_PATH):
    """Trusted explicit new scope; preserve historical estimates, never reprice them."""
    try:
        receipt, digest = _receipt(receipt_path)
        if receipt['schema_version'] not in APPEND_SCHEMAS:
            _deny()
        with sqlite3.connect(Path(state_path).resolve().as_uri() + '?mode=rw', uri=True, timeout=10) as connection:
            connection.execute('BEGIN IMMEDIATE')
            rows = connection.execute('SELECT receipt_sha256,budget_sha256,receipt_json,frozen_reason FROM metadata').fetchall()
            if len(rows) != 1 or rows[0][3] is not None:
                _deny()
            previous, budget_sha, raw, _ = rows[0]
            old, _ = _parse_receipt(raw.encode(), historical=True)
            if _closed_context(connection, old):
                _deny()  # This explicitly approved pair cannot become another scope.
            if 'cumulative_budget' in old and receipt.get('cumulative_budget') != old['cumulative_budget']:
                _deny()  # Append cannot discard or replace the cumulative authorization.
            if _budget_digest(old) != budget_sha:
                _deny()
            _, occupied = _history(connection, old, historical=True)
            prior_count = connection.execute('SELECT COUNT(*) FROM attempts').fetchone()[0]
            if (receipt['previous_receipt_sha256'] != previous or digest == previous
                    or receipt['receipt_id'] == old['receipt_id'] or receipt['approval_ref'] == old['approval_ref']
                    or receipt['total_requests'] != prior_count + sum(p['requests'] for p in receipt['profiles'].values())
                    or receipt['schema_version'] not in RISK_SCHEMAS and (old['schema_version'] in RISK_SCHEMAS
                        or _decimal(receipt['spend_authorization']['amount']) < _decimal(old['spend_authorization']['amount'])
                        or occupied > int(_decimal(receipt['spend_authorization']['amount']) * USD_UNITS))):
                _deny()
            _authority_tables(connection)
            if old['schema_version'] == SCHEMA:
                _save_authority(connection, previous, old, None)
                connection.execute('INSERT INTO attempt_authorizations SELECT id,? FROM attempts', (previous,))
            if connection.execute('SELECT 1 FROM authorization_snapshots WHERE receipt_id=?', (receipt['receipt_id'],)).fetchone():
                _deny()
            _save_authority(connection, digest, receipt, previous)
            connection.execute('UPDATE metadata SET receipt_sha256=?,budget_sha256=?,receipt_json=?',
                (digest, _budget_digest(receipt), _snapshot(receipt)))
        return {'receipt_sha256': digest, 'historical_reserved_usd': _usd(occupied)}
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError, AttributeError, InvalidOperation):
        raise TrialGateError() from None


def _amend_v3(receipt, digest, state_path):
    with sqlite3.connect(Path(state_path).resolve().as_uri() + '?mode=rw', uri=True, timeout=10) as connection:
        connection.execute('BEGIN IMMEDIATE')
        rows = connection.execute('SELECT receipt_sha256,budget_sha256,receipt_json,frozen_reason FROM metadata').fetchall()
        if len(rows) != 1 or rows[0][3] is not None:
            _deny()
        previous, budget, raw, _ = rows[0]
        old, _ = _parse_receipt(raw.encode(), historical=True)
        _history_v3(connection, old)
        if digest == previous or _budget_digest(receipt) != budget or receipt['approval_ref'] == old['approval_ref']:
            _deny()
        added = False
        for kind, profile in old['profiles'].items():
            if profile['billing'] != receipt['profiles'][kind]['billing']:
                _deny()
            for field in ('source_sha256', 'request_sha256'):
                new = receipt['profiles'][kind][field]
                if new[:len(profile[field])] != profile[field]:
                    _deny()
                added |= len(new) > len(profile[field])
        if not added:
            _deny()
        _save_authority(connection, digest, receipt, previous)
        connection.execute('UPDATE metadata SET receipt_sha256=?,receipt_json=?', (digest, _snapshot(receipt)))


def _wire_limits_v3(kind, wire, output, thinking, model):
    body = json.loads(wire, object_pairs_hook=_unique_object)
    if kind == 'llm':
        if (not isinstance(body, dict) or body.get('model') != model or body.get('stream', False) is not False
                or body.get('thinking') != {'type': 'disabled'} or body.get('max_tokens') != output
                or type(body.get('max_tokens')) is not int
                or set(body) - {'model', 'temperature', 'stream', 'max_tokens', 'messages', 'response_format', 'thinking'}
                or thinking != 0):
            _deny()
    else:
        generation = body['generationConfig']
        config = generation['thinkingConfig']
        if (set(generation) - {'maxOutputTokens', 'temperature', 'thinkingConfig'}
                or set(config) - {'thinkingBudget', 'includeThoughts'}
                or type(generation['maxOutputTokens']) is not int or generation['maxOutputTokens'] != output
                or type(config.get('thinkingBudget')) is not int or config.get('thinkingBudget') != 0
                or config.get('includeThoughts') is not False or thinking != 0):
            _deny()


def _reserve_v3(meter, receipt, digest, **args):
    kind, wire = args['kind'], args['wire']
    if kind not in receipt['profiles'] or not isinstance(wire, bytes):
        _deny()
    profile = receipt['profiles'][kind]
    output, thinking = args['output_tokens'], args['thinking_tokens']
    request_sha = hashlib.sha256(wire).hexdigest()
    if ((args['provider'], args['model'], args['url']) != (profile['provider'], profile['model'], profile['url'])
            or not 0 < len(wire) <= profile['max_input_bytes'] or request_sha not in profile['request_sha256']
            or args['source_sha256'] not in profile['source_sha256']
            or type(output) is not int or not 0 < output <= profile['max_output_tokens']
            or type(thinking) is not int or thinking != 0):
        _deny()
    _wire_limits_v3(kind, wire, output, thinking, args['model'])
    risk = receipt['schema_version'] in RISK_SCHEMAS
    if risk and kind == 'asr':
        _risk_audio(wire, args['source_sha256'])
    pricing, cost = _profile_quote(receipt, kind)
    with sqlite3.connect(meter.state_path.resolve().as_uri() + '?mode=rw', uri=True, timeout=10) as connection:
        connection.execute('BEGIN IMMEDIATE')
        if connection.execute('SELECT receipt_sha256,budget_sha256,receipt_json,frozen_reason FROM metadata').fetchall() != [(digest, _budget_digest(receipt), _snapshot(receipt), None)]:
            _deny()
        counts, occupied = _history_v3(connection, receipt)
        if risk:
            _risk_stage(connection, receipt, kind)
        used = connection.execute('SELECT COUNT(*) FROM attempts a JOIN attempt_authorizations l ON l.attempt_id=a.id JOIN authorization_snapshots s ON s.receipt_sha256=l.receipt_sha256 WHERE s.receipt_id=? AND a.kind=?', (receipt['receipt_id'], kind)).fetchone()[0]
        if receipt['schema_version'] == SCHEMA_RISK_SEQUENCE and (used >= len(profile['source_sha256'])
                or args['source_sha256'] != profile['source_sha256'][used]
                or request_sha != profile['request_sha256'][used]):
            _deny()
        if (used >= profile['requests'] or sum(counts.values()) >= receipt['total_requests']
                or not risk and occupied + cost > int(_decimal(receipt['spend_authorization']['amount']) * USD_UNITS)):
            raise TrialGateError('trial_budget_exhausted')
        if 'cumulative_budget' in receipt:
            try:
                from . import trial_budget
                trial_budget.reserve_estimate(receipt['cumulative_budget'], receipt=receipt,
                    slot=len(_risk_scope_attempts(connection, receipt)), kind=kind,
                    source_sha256=args['source_sha256'], request_sha256=request_sha,
                    estimated_upper_usd=pricing['estimated_usd'])
            except (ImportError, OSError, RuntimeError, ValueError):
                _deny()  # No durable cumulative allocation means no local send.
        cursor = connection.execute('INSERT INTO attempts(kind,request_sha256,source_sha256,wire_bytes,output_limit,thinking_limit,input_bound,generated_bound,reserved_nano_usd,pricing_json) VALUES (?,?,?,?,?,?,?,?,?,?)',
            (kind, request_sha, args['source_sha256'], len(wire), output, thinking, *_usage_bounds(pricing), cost, _snapshot(pricing)))
        ident = cursor.lastrowid
        connection.execute('INSERT INTO attempt_authorizations VALUES (?,?)', (ident, digest))
    return ident


def _risk_audio(wire, source_sha):
    body = json.loads(wire)
    if set(body) - {'contents', 'systemInstruction', 'generationConfig'}:
        _deny()
    if ('temperature' in body['generationConfig'] and
            (type(body['generationConfig']['temperature']) not in {int, float} or body['generationConfig']['temperature'] != 0)):
        _deny()
    contents = body['contents']
    if (not isinstance(contents, list) or len(contents) != 1 or not isinstance(contents[0], dict)
            or set(contents[0]) - {'role', 'parts'} or contents[0].get('role', 'user') != 'user'):
        _deny()
    parts = contents[0]['parts']
    if not isinstance(parts, list) or any(not isinstance(part, dict) or set(part) not in ({'text'}, {'inlineData'}) for part in parts):
        _deny()
    if 'systemInstruction' in body:
        system = body['systemInstruction']
        if (not isinstance(system, dict) or set(system) - {'role', 'parts'}
                or any(not isinstance(part, dict) or set(part) != {'text'} or not isinstance(part['text'], str) for part in system['parts'])):
            _deny()
    media = [part['inlineData'] for part in parts if 'inlineData' in part]
    if len(media) != 1 or set(media[0]) != {'mimeType', 'data'} or media[0]['mimeType'] != 'audio/wav':
        _deny()
    raw = base64.b64decode(media[0]['data'], validate=True)
    if len(raw) > 640044 or hashlib.sha256(raw).hexdigest() != source_sha:
        _deny()
    try:
        with wave.open(io.BytesIO(raw), 'rb') as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, 16000, 'NONE'):
                _deny()
            frames = wav.getnframes()
            if not 0 < frames <= 320000 or len(wav.readframes(frames)) != frames * 2:
                _deny()
    except (wave.Error, EOFError):
        _deny()


def _risk_scope_attempts(connection, receipt):
    return connection.execute('SELECT a.id,a.kind FROM attempts a JOIN attempt_authorizations l ON l.attempt_id=a.id JOIN authorization_snapshots s ON s.receipt_sha256=l.receipt_sha256 WHERE s.receipt_id=? ORDER BY a.id', (receipt['receipt_id'],)).fetchall()


def _risk_stage(connection, receipt, kind):
    rows = _risk_scope_attempts(connection, receipt)
    pattern = receipt['request_sequence'] if receipt['schema_version'] == SCHEMA_RISK_SEQUENCE else ['asr', 'llm'] * receipt['profiles']['asr']['requests']
    if [row[1] for row in rows] != pattern[:len(rows)] or len(rows) >= len(pattern) or kind != pattern[len(rows)]:
        _deny()
    if rows:
        if not _has_trial_review(connection, rows[-1][0]):
            _deny()


def _has_trial_review(connection, attempt_id):
    # The first human confirmation lazily creates this table. Absence means
    # pending review; a read-only preflight must not create it or assume consent.
    return (_table_exists(connection, 'trial_reviews') and
            connection.execute('SELECT 1 FROM trial_reviews WHERE attempt_id=?', (attempt_id,)).fetchone() == (1,))


def confirm_trial_review(attempt_id, approval_ref, *, state_path=STATE_PATH):
    """Trusted local human review, never automatically called by a UI button."""
    try:
        if type(attempt_id) is not int or not isinstance(approval_ref, str) or not approval_ref.strip() or len(approval_ref.encode()) > 4096:
            _deny()
        with sqlite3.connect(Path(state_path).resolve().as_uri() + '?mode=rw', uri=True, timeout=10) as connection:
            connection.execute('BEGIN IMMEDIATE')
            row = connection.execute('SELECT receipt_json,frozen_reason FROM metadata').fetchall()
            if len(row) != 1 or row[0][1] is not None:
                _deny()
            receipt, _ = _parse_receipt(row[0][0].encode())
            if receipt['schema_version'] not in RISK_SCHEMAS:
                _deny()
            _history_v3(connection, receipt)
            rows = _risk_scope_attempts(connection, receipt)
            if not rows or rows[-1][0] != attempt_id:
                _deny()
            connection.execute('CREATE TABLE IF NOT EXISTS trial_reviews (attempt_id INTEGER PRIMARY KEY, approval_ref TEXT NOT NULL)')
            previous = connection.execute('SELECT approval_ref FROM trial_reviews WHERE attempt_id=?', (attempt_id,)).fetchone()
            if previous is not None and previous != (approval_ref,):
                _deny()
            connection.execute('INSERT OR IGNORE INTO trial_reviews VALUES (?,?)', (attempt_id, approval_ref))
        return {'reviewed': True, 'attempt_id': attempt_id}
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
        raise TrialGateError() from None


def _save_transport_metadata(connection, ident, metadata):
    if (not isinstance(metadata, dict) or set(metadata) - {'trace_id', 'response_sha256', 'response_bytes', 'protocol'}
            or len(_snapshot(metadata).encode()) > 2048
            or 'trace_id' in metadata and (not isinstance(metadata['trace_id'], str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,256}', metadata['trace_id']))
            or 'response_sha256' in metadata and (not isinstance(metadata['response_sha256'], str) or not HASH.fullmatch(metadata['response_sha256']))
            or 'response_bytes' in metadata and (type(metadata['response_bytes']) is not int or not 0 <= metadata['response_bytes'] <= 2 * 1024 * 1024)
            or 'protocol' in metadata and metadata['protocol'] not in {'openai', 'gemini', 'chat_completions'}):
        _deny()
    connection.execute('CREATE TABLE IF NOT EXISTS transport_metadata (attempt_id INTEGER PRIMARY KEY, metadata_json TEXT NOT NULL)')
    old = connection.execute('SELECT metadata_json FROM transport_metadata WHERE attempt_id=?', (ident,)).fetchone()
    encoded = _snapshot(metadata)
    if old is not None and old[0] != encoded:
        _deny()
    connection.execute('INSERT OR IGNORE INTO transport_metadata VALUES (?,?)', (ident, encoded))


def stop_trial(attempt_id, reason_code, *, state_path=STATE_PATH):
    """Durable stop of the shared trial; no receipt operation clears this flag."""
    try:
        if type(attempt_id) is not int or attempt_id <= 0 or reason_code not in {
                'owner_stop', 'business_validation_failed', 'transport_failed',
                'response_too_large', 'response_invalid', 'usage_unverified'}:
            _deny()
        with sqlite3.connect(Path(state_path).resolve().as_uri() + '?mode=rw', uri=True, timeout=10) as connection:
            connection.execute('BEGIN IMMEDIATE')
            closed = _closed_context(connection)
            if closed and attempt_id <= closed.get('protected_through_attempt_id', closed['failed_attempt_id']):
                _deny()
            if connection.execute('SELECT 1 FROM attempts WHERE id=?', (attempt_id,)).fetchone() != (1,):
                _deny()
            if connection.execute('SELECT COUNT(*) FROM metadata').fetchone() != (1,):
                _deny()
            connection.execute('UPDATE metadata SET frozen_reason=COALESCE(frozen_reason,?)', (reason_code,))
            current_receipt, _ = _parse_receipt(connection.execute('SELECT receipt_json FROM metadata').fetchone()[0].encode(), historical=True)
            stopped_reason = connection.execute('SELECT frozen_reason FROM metadata').fetchone()[0]
        _close_cumulative_budget(current_receipt, stopped_reason)
        return {'stopped': True, 'attempt_id': attempt_id}
    except (OSError, sqlite3.Error, ValueError, TypeError):
        raise TrialGateError() from None


def _close_cumulative_budget(receipt, reason_code):
    if 'cumulative_budget' in receipt:
        try:
            from . import trial_budget
            trial_budget.close_batch(receipt['cumulative_budget'], receipt_id=receipt['receipt_id'], reason=reason_code)
        except (ImportError, OSError, RuntimeError, ValueError):
            _deny()  # The local stop stays committed, even if the other meter fails.


def close_trial_scope(receipt_path=RECEIPT_PATH, state_path=STATE_PATH, reason_code='owner_stop'):
    """Trusted local stop, including before the new scope's first reservation.

    Expiry does not prevent containment. This operation never clears an earlier
    reason, reports usage, touches old attempts or creates any authorization.
    """
    try:
        receipt, digest = _parse_receipt(Path(receipt_path).read_bytes(), historical=True)
        if receipt['schema_version'] != SCHEMA_RISK_SEQUENCE or reason_code not in {
                'owner_stop', 'business_validation_failed', 'transport_failed',
                'response_too_large', 'response_invalid', 'usage_unverified'}:
            _deny()
        with sqlite3.connect(Path(state_path).resolve().as_uri()+'?mode=rw', uri=True, timeout=10) as connection:
            connection.execute('BEGIN IMMEDIATE')
            rows = connection.execute('SELECT receipt_sha256,budget_sha256,receipt_json,frozen_reason FROM metadata').fetchall()
            if len(rows) != 1 or rows[0][:3] != (digest, _budget_digest(receipt), _snapshot(receipt)):
                _deny()
            _closed_context(connection, receipt)
            connection.execute('UPDATE metadata SET frozen_reason=COALESCE(frozen_reason,?)', (reason_code,))
            stopped_reason = connection.execute('SELECT frozen_reason FROM metadata').fetchone()[0]
        _close_cumulative_budget(receipt, stopped_reason)
        return {'stopped': True, 'receipt_id': receipt['receipt_id'], 'reason': stopped_reason}
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
        raise TrialGateError() from None


def _table_exists(connection, name):
    return connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() == (1,)


def _successor_claim_name(closure):
    identity = {field: closure[field] for field in ('previous_receipt_sha256', 'previous_attempts_sha256')}
    return 'scope-successor-' + hashlib.sha256(_snapshot(identity).encode()).hexdigest() + '.json'


def _successor_source(state_raw, receipt_raw, closure_raw, evidence_raw, new_raw, source_path, *, _depth=0):
    """Validate an already stopped predecessor, including its inherited proofs.

    Unknown usage needs both the immutable stopped history and the independent
    non-refundable allocation's closed/unknown proof. It never becomes verified.
    """
    closure = json.loads(closure_raw, object_pairs_hook=_unique_object)
    fields = {'schema_version', 'status', 'authorization_source', 'approval_ref',
              'previous_state_sha256', 'previous_receipt_sha256', 'previous_attempts_sha256',
              'new_receipt_sha256', 'last_attempt_id', 'freeze_reason', 'last_request_sha256',
              'last_source_sha256', 'failure_evidence_sha256'}
    reasons = {'owner_stop', 'business_validation_failed', 'transport_failed', 'response_too_large',
               'response_invalid', 'usage_unverified', 'usage_unverified_or_over_bound'}
    if (not isinstance(closure, dict) or set(closure) != fields
            or closure['schema_version'] != 'noreset-closed-scope-successor-v1'
            or closure['status'] != 'permanently_closed'
            or closure['authorization_source'] != 'explicit_owner_approval'
            or type(closure['last_attempt_id']) is not int or closure['last_attempt_id'] <= 0
            or closure['freeze_reason'] not in reasons):
        _deny()
    for key, raw in [('previous_state_sha256', state_raw), ('previous_receipt_sha256', receipt_raw),
                     ('new_receipt_sha256', new_raw), ('failure_evidence_sha256', evidence_raw)]:
        if closure[key] != hashlib.sha256(raw).hexdigest():
            _deny()
    old, old_sha = _parse_receipt(receipt_raw, historical=True)
    new, _ = _parse_receipt(new_raw, historical=True)
    if (old['schema_version'] not in APPEND_SCHEMAS or new['schema_version'] != SCHEMA_RISK_SEQUENCE
            or new['previous_receipt_sha256'] != old_sha or new['receipt_id'] == old['receipt_id']
            or new['approval_ref'] != closure['approval_ref'] or new['approval_ref'] == old['approval_ref']):
        _deny()
    if 'cumulative_budget' in old and new.get('cumulative_budget') != old['cumulative_budget']:
        _deny()  # New scopes cannot discard the already approved cumulative cap.
    with sqlite3.connect(':memory:') as origin:
        origin.deserialize(state_raw)
        if origin.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            _deny()
        metadata = origin.execute('SELECT * FROM metadata').fetchall()
        if metadata != [(old_sha, _budget_digest(old), _snapshot(old), closure['freeze_reason'])]:
            _deny()
        rows = origin.execute('SELECT * FROM attempts ORDER BY id').fetchall()
        if (not rows or [row[0] for row in rows] != list(range(1, len(rows)+1))
                or closure['last_attempt_id'] != rows[-1][0]
                or closure['previous_attempts_sha256'] != hashlib.sha256(_snapshot(rows).encode()).hexdigest()
                or closure['last_request_sha256'] != rows[-1][2] or closure['last_source_sha256'] != rows[-1][3]
                or new['total_requests'] != len(rows) + len(new['request_sequence'])):
            _deny()
        closed = _closed_context(origin, old, _validation_path=source_path, _depth=_depth+1)
        failed_ids = set(closed.get('closed_unverified_attempt_ids', [closed['failed_attempt_id']]) if closed else [])
        latest_usage = json.loads(rows[-1][-1], object_pairs_hook=_unique_object) if rows[-1][-1] is not None else None
        if (latest_usage is None or isinstance(latest_usage, dict) and latest_usage.get('verified') is False) and rows[-1][0] not in failed_ids:
            # An owner stop or a new receipt alone cannot close an in-flight
            # unknown request. Only an actual failure and its prior durable
            # cumulative allocation allow a different future request.
            if (old['schema_version'] != SCHEMA_RISK_SEQUENCE or closure['freeze_reason'] not in {
                    'transport_failed', 'response_too_large', 'response_invalid',
                    'usage_unverified', 'usage_unverified_or_over_bound'}):
                _deny()
            steps = _risk_scope_attempts(origin, old)
            if not steps or steps[-1][0] != rows[-1][0]:
                _deny()
            ident, kind = steps[-1]
            try:
                from . import trial_budget
                allocation = trial_budget.allocation_status(old['cumulative_budget'], receipt_id=old['receipt_id'],
                    slot=len(steps)-1, kind=kind, source_sha256=rows[-1][3], request_sha256=rows[-1][2])
            except (ImportError, OSError, RuntimeError, ValueError, AttributeError):
                _deny()
            if (allocation['status'] != 'reserved_unknown' or allocation['batch_closed'] is not True
                    or allocation['closure_reason'] != closure['freeze_reason'] or allocation['observation'] is not None
                    or allocation['refundable'] is not False
                    or allocation['reserved_estimate_usd'] != old['profiles'][kind]['billing']['estimated_usd']):
                _deny()
            failed_ids.add(ident)
        _, occupied = _history_v3(origin, old, _validation_path=source_path, _depth=_depth+1,
                                  _closed_unverified_ids=failed_ids)
        closed = {**(closed or {'failed_attempt_id': 0}), 'closed_unverified_attempt_ids': sorted(failed_ids)}
        authorities = origin.execute('SELECT * FROM authorization_snapshots ORDER BY receipt_sha256').fetchall()
        if any(row[1] == new['receipt_id'] for row in authorities):
            _deny()
        evidence = json.loads(evidence_raw, object_pairs_hook=_unique_object)
        expected = {'schema_version': 'noreset-closed-scope-evidence-v1', 'status': 'permanently_closed',
                    'last_attempt_id': rows[-1][0], 'freeze_reason': closure['freeze_reason'],
                    'last_request_sha256': rows[-1][2], 'last_source_sha256': rows[-1][3],
                    'cumulative_attempt_rows': len(rows), 'historical_reserved_usd': _usd(occupied),
                    'supplier_final_charge_known': False}
        if (not isinstance(evidence, dict) or set(evidence) != set(expected) or evidence != expected
                or type(evidence['last_attempt_id']) is not int or type(evidence['cumulative_attempt_rows']) is not int
                or evidence['supplier_final_charge_known'] is not False):
            _deny()
        tables = {}
        for name, schema in origin.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
            if not re.fullmatch('[a-z_]+', name):
                _deny()
            tables[name] = (schema, origin.execute(f'SELECT * FROM {name} ORDER BY rowid').fetchall())
    return closure, tables, occupied, closed


def _successor_context(connection, receipt=None, *, _validation_path=None, _depth=0):
    rows = connection.execute('SELECT * FROM scope_successors ORDER BY id').fetchall()
    if not rows or [row[0] for row in rows] != list(range(1, len(rows)+1)):
        _deny()
    _, state_raw, old_raw, new_raw, closure_raw, evidence_raw, claim_path, source_path = rows[-1]
    if not isinstance(source_path, str) or str(Path(source_path).resolve()) != source_path:
        _deny()
    closure, tables, _, closed = _successor_source(state_raw, old_raw, closure_raw, evidence_raw, new_raw,
                                                  source_path, _depth=_depth)
    new, new_sha = _parse_receipt(new_raw, historical=True)
    if receipt is None:
        values = connection.execute('SELECT receipt_json FROM metadata').fetchall()
        if len(values) != 1:
            _deny()
        receipt, _ = _parse_receipt(values[0][0].encode(), historical=True)
    if receipt['receipt_id'] != new['receipt_id'] or _budget_digest(receipt) != _budget_digest(new):
        _deny()
    for kind, profile in new['profiles'].items():
        if receipt['profiles'][kind]['billing'] != profile['billing']:
            _deny()
        for field in ('source_sha256', 'request_sha256'):
            if receipt['profiles'][kind][field][:len(profile[field])] != profile[field]:
                _deny()
    state_path = _validation_path or connection.execute('PRAGMA database_list').fetchone()[2]
    expected_claim_path = CONTINUATION_CLAIM_ROOT.resolve() / _successor_claim_name(closure)
    if Path(claim_path).absolute() != expected_claim_path or Path(claim_path).resolve() != expected_claim_path:
        _deny()
    expected_claim = {'schema_version': 'noreset-scope-successor-claim-v1',
        'previous_receipt_sha256': closure['previous_receipt_sha256'],
        'previous_attempts_sha256': closure['previous_attempts_sha256'],
        'previous_state_sha256': closure['previous_state_sha256'],
        'new_receipt_sha256': new_sha, 'closure_sha256': hashlib.sha256(closure_raw).hexdigest(),
        'state_path': str(Path(state_path).resolve())}
    if json.loads(Path(claim_path).read_bytes(), object_pairs_hook=_unique_object) != expected_claim:
        _deny()
    # Original schemas and every original row survive, including proof chains,
    # usage, reviews and response metadata. Only this scope's new rows may grow.
    cutoff = closure['last_attempt_id']
    for table, (schema, old_rows) in tables.items():
        if table == 'metadata':
            expected = (closure['previous_receipt_sha256'], *old_rows[0])
            if connection.execute('SELECT * FROM closed_scope_metadata WHERE receipt_sha256=?', (expected[0],)).fetchall() != [expected]:
                _deny()
            continue
        if connection.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() != (schema,):
            _deny()
        current = connection.execute(f'SELECT * FROM {table} ORDER BY rowid').fetchall()
        if table in {'attempts', 'attempt_authorizations', 'trial_reviews', 'transport_metadata'}:
            current = [row for row in current if row[0] <= cutoff]
            if current != old_rows:
                _deny()
        elif table in {'authorization_snapshots', 'closed_scope_metadata'}:
            if any(row not in current for row in old_rows):
                _deny()
        elif table == 'scope_successors':
            if current[:-1] != old_rows:
                _deny()
        elif current != old_rows:
            _deny()
    for table in ('trial_reviews', 'transport_metadata'):
        old_rows = tables.get(table, (None, []))[1]
        if _table_exists(connection, table) and connection.execute(f'SELECT * FROM {table} WHERE attempt_id<=? ORDER BY rowid', (cutoff,)).fetchall() != old_rows:
            _deny()  # A new audit table cannot attach a late record to old IDs.
    if connection.execute('SELECT receipt_json FROM authorization_snapshots WHERE receipt_sha256=?', (new_sha,)).fetchone() != (_snapshot(new),):
        _deny()
    return {**(closed or {'failed_attempt_id': 0}), 'protected_through_attempt_id': cutoff}


def succeed_informed_trial(receipt_path, state_path, *, previous_receipt_path, previous_state_path,
                           closure_path, failure_evidence_path):
    """Explicit local new approval, independent state, immutable stopped history.

    No HTTP handler can create this successor. Closed unknown attempts retain
    their full failure/allocation proof and cannot be reported or replayed.
    """
    target, created = Path(state_path).resolve(), False
    try:
        source, old_receipt_path = Path(previous_state_path).resolve(), Path(previous_receipt_path).resolve()
        receipt_path = Path(receipt_path).resolve()
        if (target in {source, old_receipt_path, receipt_path} or receipt_path == old_receipt_path or target.exists()
                or any(Path(str(source)+suffix).exists() for suffix in ('-wal', '-shm', '-journal'))):
            _deny()
        state_raw, old_raw, new_raw = source.read_bytes(), old_receipt_path.read_bytes(), receipt_path.read_bytes()
        receipt, digest = _parse_receipt(new_raw)
        closure_raw, evidence_raw = Path(closure_path).read_bytes(), Path(failure_evidence_path).read_bytes()
        if len(closure_raw) > 65536 or len(evidence_raw) > 65536:
            _deny()
        closure, tables, _, _ = _successor_source(state_raw, old_raw, closure_raw, evidence_raw, new_raw, str(source))
        claim_path = CONTINUATION_CLAIM_ROOT.resolve() / _successor_claim_name(closure)
        claim = {'schema_version': 'noreset-scope-successor-claim-v1',
            'previous_receipt_sha256': closure['previous_receipt_sha256'],
            'previous_attempts_sha256': closure['previous_attempts_sha256'],
            'previous_state_sha256': closure['previous_state_sha256'], 'new_receipt_sha256': digest,
            'closure_sha256': hashlib.sha256(closure_raw).hexdigest(), 'state_path': str(target)}
        claim_path.parent.mkdir(parents=True, exist_ok=True)
        with claim_path.open('xb') as stream:
            stream.write(_snapshot(claim).encode())
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(state_raw)
        created = True
        with sqlite3.connect(target) as connection:
            connection.execute('BEGIN IMMEDIATE')
            connection.execute('CREATE TABLE IF NOT EXISTS scope_successors (id INTEGER PRIMARY KEY,state_raw BLOB NOT NULL,receipt_raw BLOB NOT NULL,new_receipt_raw BLOB NOT NULL,closure_json BLOB NOT NULL,evidence_raw BLOB NOT NULL,claim_path TEXT NOT NULL,source_path TEXT NOT NULL)')
            connection.execute('INSERT INTO scope_successors(state_raw,receipt_raw,new_receipt_raw,closure_json,evidence_raw,claim_path,source_path) VALUES (?,?,?,?,?,?,?)',
                (state_raw, old_raw, new_raw, closure_raw, evidence_raw, str(claim_path), str(source)))
            connection.execute('CREATE TABLE IF NOT EXISTS closed_scope_metadata (receipt_sha256 TEXT PRIMARY KEY,old_receipt_sha256 TEXT NOT NULL,budget_sha256 TEXT NOT NULL,receipt_json TEXT NOT NULL,frozen_reason TEXT NOT NULL)')
            connection.execute('INSERT INTO closed_scope_metadata VALUES (?,?,?,?,?)', (closure['previous_receipt_sha256'], *tables['metadata'][1][0]))
            _save_authority(connection, digest, receipt, closure['previous_receipt_sha256'])
            connection.execute('UPDATE metadata SET receipt_sha256=?,budget_sha256=?,receipt_json=?,frozen_reason=NULL',
                (digest, _budget_digest(receipt), _snapshot(receipt)))
            _history_v3(connection, receipt)
        if (source.read_bytes() != state_raw or old_receipt_path.read_bytes() != old_raw
                or any(Path(str(source)+suffix).exists() for suffix in ('-wal', '-shm', '-journal'))):
            _deny()
        result = validate_trial_authorization(receipt_path=receipt_path, state_path=target)
        return {key:result[key] for key in ('receipt_sha256','remaining_requests','remaining_usd','cost_bound_known','historical_reserved_usd')} | {
            'state_path':str(target), 'claim_path':str(claim_path), 'protected_through_attempt_id':closure['last_attempt_id']}
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError, AttributeError, InvalidOperation, TrialGateError):
        if created:
            with sqlite3.connect(target) as connection:
                connection.execute("UPDATE metadata SET frozen_reason='successor_setup_failed'")
        raise TrialGateError() from None


def _continuation_claim_name(closure):
    # Logical origin identity survives harmless SQLite serialization changes.
    identity = {field: closure[field] for field in ('previous_receipt_sha256', 'previous_attempts_sha256')}
    return 'continuation-' + hashlib.sha256(_snapshot(identity).encode()).hexdigest() + '.json'


def _continuation_source(state_raw, receipt_raw, closure_raw, evidence_raw, new_raw):
    """Validate the complete frozen predecessor in memory, never open its file."""
    closure = json.loads(closure_raw, object_pairs_hook=_unique_object)
    fields = {'schema_version', 'status', 'authorization_source', 'approval_ref', 'previous_state_sha256',
              'previous_receipt_sha256', 'previous_attempts_sha256', 'new_receipt_sha256', 'failed_attempt_id',
              'freeze_reason', 'failed_request_sha256', 'failed_source_sha256', 'failure_evidence_sha256'}
    if (not isinstance(closure, dict) or set(closure) != fields
            or closure['schema_version'] != 'noreset-closed-trial-continuation-v1'
            or closure['status'] != 'permanently_closed_failed'
            or closure['authorization_source'] != 'explicit_owner_approval'
            or type(closure['failed_attempt_id']) is not int or closure['failed_attempt_id'] != 4
            or closure['freeze_reason'] != 'response_invalid'):
        _deny()
    for key, raw in [('previous_state_sha256', state_raw), ('previous_receipt_sha256', receipt_raw),
                     ('new_receipt_sha256', new_raw), ('failure_evidence_sha256', evidence_raw)]:
        if closure[key] != hashlib.sha256(raw).hexdigest():
            _deny()
    old, old_sha = _parse_receipt(receipt_raw, historical=True)
    new, _ = _parse_receipt(new_raw, historical=True)
    if (old['schema_version'] != SCHEMA_RISK or new['schema_version'] != SCHEMA_RISK
            or new['previous_receipt_sha256'] != old_sha or new['receipt_id'] == old['receipt_id']
            or new['approval_ref'] != closure['approval_ref'] or new['approval_ref'] == old['approval_ref']
            or new['total_requests'] != 6 or new['planned_text_requests'] != 1
            or any(profile['requests'] != 1 for profile in new['profiles'].values())):
        _deny()
    evidence = json.loads(evidence_raw, object_pairs_hook=_unique_object)
    if (not isinstance(evidence, dict) or evidence.get('status') != 'failed_first_asr_stopped_without_retry'
            or evidence.get('freeze_reason') != 'response_invalid'
            or type(evidence.get('new_attempt_id')) is not int or evidence['new_attempt_id'] != 4
            or evidence.get('actual_new_posts') != {'asr': 1, 'llm': 0, 'ocr': 0}
            or any(type(value) is not int for value in evidence['actual_new_posts'].values())
            or type(evidence.get('cumulative_attempt_rows')) is not int or evidence['cumulative_attempt_rows'] != 4
            or evidence.get('historical_three_rows_unchanged') is not True
            or evidence.get('historical_reserved_usd') != '0.9510912'
            or evidence.get('supplier_final_charge_known') is not False):
        _deny()
    with sqlite3.connect(':memory:') as origin:
        origin.deserialize(state_raw)
        if origin.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or _table_exists(origin, 'closed_origin'):
            _deny()
        metadata = origin.execute('SELECT * FROM metadata').fetchall()
        if metadata != [(old_sha, _budget_digest(old), _snapshot(old), 'response_invalid')]:
            _deny()
        rows = origin.execute('SELECT * FROM attempts ORDER BY id').fetchall()
        if ([row[0] for row in rows] != [1, 2, 3, 4] or [row[1] for row in rows] != ['llm', 'llm', 'llm', 'asr']
                or rows[-1][-1] is not None
                or closure['previous_attempts_sha256'] != hashlib.sha256(_snapshot(rows).encode()).hexdigest()
                or closure['failed_request_sha256'] != rows[-1][2] or closure['failed_source_sha256'] != rows[-1][3]):
            _deny()
        counts, occupied = _history_v3(origin, old, _closed_failure=4)
        if counts != {'llm': 3, 'asr': 1} or _usd(occupied) != '0.9510912':
            _deny()
        authorities = origin.execute('SELECT * FROM authorization_snapshots ORDER BY receipt_sha256').fetchall()
        links = origin.execute('SELECT * FROM attempt_authorizations ORDER BY attempt_id').fetchall()
    return closure, metadata, rows, authorities, links


def _closed_context(connection, receipt=None, *, _validation_path=None, _depth=0):
    """Only an exact inherited failed row gets an exception; preserve all totals."""
    if _depth > 16:
        _deny()
    if _table_exists(connection, 'scope_successors'):
        return _successor_context(connection, receipt, _validation_path=_validation_path, _depth=_depth)
    exists, metadata_exists = _table_exists(connection, 'closed_origin'), _table_exists(connection, 'closed_metadata')
    if not exists and not metadata_exists:
        return None
    if not exists or not metadata_exists:
        _deny()
    proofs = connection.execute('SELECT * FROM closed_origin').fetchall()
    if len(proofs) != 1:
        _deny()
    state_raw, old_raw, new_raw, closure_raw, evidence_raw, claim_path = proofs[0]
    closure, metadata, old_rows, authorities, links = _continuation_source(state_raw, old_raw, closure_raw, evidence_raw, new_raw)
    new, new_sha = _parse_receipt(new_raw, historical=True)
    if receipt is None:
        current = connection.execute('SELECT receipt_json FROM metadata').fetchall()
        if len(current) != 1:
            _deny()
        receipt, _ = _parse_receipt(current[0][0].encode(), historical=True)
    if receipt['schema_version'] != SCHEMA_RISK or receipt['receipt_id'] != new['receipt_id'] or _budget_digest(receipt) != _budget_digest(new):
        _deny()
    for kind, profile in new['profiles'].items():
        if receipt['profiles'][kind]['billing'] != profile['billing']:
            _deny()
        for field in ('source_sha256', 'request_sha256'):
            if receipt['profiles'][kind][field][:len(profile[field])] != profile[field]:
                _deny()
    state_path = _validation_path or connection.execute('PRAGMA database_list').fetchone()[2]
    expected_claim = {'schema_version': 'noreset-continuation-claim-v1',
                      'previous_state_sha256': closure['previous_state_sha256'],
                      'previous_receipt_sha256': closure['previous_receipt_sha256'],
                      'new_receipt_sha256': new_sha,
                      'closure_sha256': hashlib.sha256(closure_raw).hexdigest(),
                      'state_path': str(Path(state_path).resolve())}
    if json.loads(Path(claim_path).read_bytes(), object_pairs_hook=_unique_object) != expected_claim:
        _deny()
    expected_claim_path = CONTINUATION_CLAIM_ROOT.resolve() / _continuation_claim_name(closure)
    if Path(claim_path).absolute() != expected_claim_path or Path(claim_path).resolve() != expected_claim_path:
        _deny()
    if (connection.execute('SELECT * FROM closed_metadata').fetchall() != metadata
            or connection.execute('SELECT * FROM attempts WHERE id<=4 ORDER BY id').fetchall() != old_rows
            or connection.execute('SELECT * FROM attempt_authorizations WHERE attempt_id<=4 ORDER BY attempt_id').fetchall() != links):
        _deny()
    for row in authorities:
        if connection.execute('SELECT * FROM authorization_snapshots WHERE receipt_sha256=?', (row[0],)).fetchall() != [row]:
            _deny()
    if connection.execute('SELECT receipt_json FROM authorization_snapshots WHERE receipt_sha256=?', (new_sha,)).fetchone() != (_snapshot(new),):
        _deny()
    return closure


def continue_informed_trial(receipt_path, state_path, *, previous_receipt_path, previous_state_path,
                            closure_path, failure_evidence_path):
    """Trusted one-pair continuation in an independent copy; never called by HTTP.

    Old files and failed usage remain unchanged. A unique source claim prevents
    creating another allowance from the same permanently closed predecessor.
    """
    created = False
    target = Path(state_path).resolve()
    try:
        source, old_receipt_path = Path(previous_state_path).resolve(), Path(previous_receipt_path).resolve()
        new_receipt_path = Path(receipt_path).resolve()
        if (target in {source, old_receipt_path, new_receipt_path} or new_receipt_path == old_receipt_path
                or target.exists() or any(Path(str(source) + suffix).exists() for suffix in ('-wal', '-shm', '-journal'))):
            _deny()
        state_raw, old_raw = source.read_bytes(), old_receipt_path.read_bytes()
        new_raw = new_receipt_path.read_bytes()
        receipt, digest = _parse_receipt(new_raw)  # Only current authorization must be valid now.
        closure_raw, evidence_raw = Path(closure_path).read_bytes(), Path(failure_evidence_path).read_bytes()
        if len(closure_raw) > 65536 or len(evidence_raw) > 65536:
            _deny()
        closure, _, _, _, _ = _continuation_source(state_raw, old_raw, closure_raw, evidence_raw, new_raw)
        claim_path = CONTINUATION_CLAIM_ROOT / _continuation_claim_name(closure)
        claim = {'schema_version': 'noreset-continuation-claim-v1',
                 'previous_state_sha256': closure['previous_state_sha256'],
                 'previous_receipt_sha256': closure['previous_receipt_sha256'], 'new_receipt_sha256': digest,
                 'closure_sha256': hashlib.sha256(closure_raw).hexdigest(), 'state_path': str(target)}
        # Claim is exclusive and remains even after failure; never silently retry elsewhere.
        claim_path.parent.mkdir(parents=True, exist_ok=True)
        with claim_path.open('xb') as stream:
            stream.write(_snapshot(claim).encode())
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(state_raw)
        created = True
        with sqlite3.connect(target) as connection:
            connection.execute('BEGIN IMMEDIATE')
            connection.execute('ALTER TABLE metadata RENAME TO closed_metadata')
            connection.execute('CREATE TABLE metadata (receipt_sha256 TEXT NOT NULL,budget_sha256 TEXT NOT NULL,receipt_json TEXT NOT NULL,frozen_reason TEXT)')
            connection.execute('INSERT INTO metadata VALUES (?,?,?,NULL)', (digest, _budget_digest(receipt), _snapshot(receipt)))
            connection.execute('CREATE TABLE closed_origin (state_raw BLOB NOT NULL,receipt_raw BLOB NOT NULL,new_receipt_raw BLOB NOT NULL,closure_json BLOB NOT NULL,evidence_raw BLOB NOT NULL,claim_path TEXT NOT NULL)')
            connection.execute('INSERT INTO closed_origin VALUES (?,?,?,?,?,?)', (state_raw, old_raw, new_raw, closure_raw, evidence_raw, str(claim_path)))
            _save_authority(connection, digest, receipt, closure['previous_receipt_sha256'])
            _history_v3(connection, receipt)
        if (source.read_bytes() != state_raw or old_receipt_path.read_bytes() != old_raw
                or any(Path(str(source) + suffix).exists() for suffix in ('-wal', '-shm', '-journal'))):
            _deny()
        result = validate_trial_authorization(receipt_path=new_receipt_path, state_path=target)
        return {'state_path': str(target), 'receipt_sha256': digest, 'claim_path': str(claim_path),
                'remaining_requests': result['remaining_requests'], 'remaining_usd': None, 'cost_bound_known': False,
                'historical_reserved_usd': result['historical_reserved_usd'], 'closed_failed_attempt_id': 4}
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError, AttributeError, InvalidOperation, TrialGateError):
        if created:
            try:
                with sqlite3.connect(target) as connection:
                    connection.execute("UPDATE metadata SET frozen_reason='continuation_setup_failed'")
            except sqlite3.Error:
                pass
        raise TrialGateError() from None


def authorize_request(request):
    if is_loopback_url(request.full_url):
        return
    try:
        if request.get_method() != 'POST':
            _deny()
        profile = getattr(request, '_noreset_trial_profile', None)
        if not isinstance(profile, dict) or set(profile) != {'kind', 'provider', 'model', 'source_sha256'}:
            _deny()
        body = json.loads(request.data)
        kind = profile['kind']
        if kind == 'asr':
            if profile['provider'] != 'aihubmix':
                _deny()  # multipart/WS cannot prove the trial's output/thinking cap.
            generation = body['generationConfig']
            output = generation['maxOutputTokens']
            thinking = generation['thinkingConfig']['thinkingBudget']
        else:
            if kind not in {'llm', 'ocr'} or body.get('model') != profile['model']:
                _deny()
            if set(body) - {'model', 'temperature', 'stream', 'max_tokens', 'messages', 'response_format',
                            'enable_thinking', 'thinking_budget', 'thinking', 'reasoning_effort'}:
                _deny()
            if kind == 'llm' and body.get('thinking') != {'type': 'disabled'}:
                _deny()  # Absent reasoning settings do not prove thinking is off.
            if kind == 'ocr' and (body.get('reasoning_effort') != 'none' or 'enable_thinking' in body or 'thinking_budget' in body):
                _deny()  # Only the documented gateway off switch is requested.
            output = body['max_tokens']
            thinking = body.get('thinking_budget', 0)
            if body.get('enable_thinking') is True and 'thinking_budget' not in body:
                _deny()
            if body.get('reasoning_effort') not in {None, 'none'} or body.get('thinking') not in (None, {'type': 'disabled'}):
                _deny()
        meter = TrialGate()
        attempt_id = meter.reserve(kind=kind, provider=profile['provider'], model=profile['model'], url=request.full_url,
            wire=request.data, source_sha256=profile['source_sha256'], output_tokens=output, thinking_tokens=thinking)
        request._noreset_trial_attempt_id = attempt_id
        request._noreset_trial_state_path = meter.state_path
        return attempt_id
    except (ValueError, TypeError, AttributeError, KeyError):
        raise TrialGateError() from None
