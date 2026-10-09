"""Default-closed, persisted allowance for one explicitly approved synthetic trial.

Authorization is a trusted local receipt, never request data or an environment
flag. Reviewed price/context bounds reserve worst-case nano-USD before sending.
This is a conservative local reservation meter, not an account/billing control.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import socket
import sqlite3
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_CEILING
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
RECEIPT_PATH = ROOT / 'runtime/synthetic-trial/authorization.json'
STATE_PATH = ROOT / 'runtime/synthetic-trial/ledger.sqlite3'
CAPS = {'llm': (3, 2048, 0), 'asr': (1, 1024, 0), 'ocr': (1, 4096, 1024)}
MAX_WIRE_BYTES = {'llm': 24000, 'asr': 3 * 1024 * 1024, 'ocr': 3 * 1024 * 1024}
HASH = re.compile(r'^[a-f0-9]{64}$')
SCHEMA = 'noreset-synthetic-trial-v2'
SCHEMA_V3 = 'noreset-synthetic-trial-v3'
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
        if isinstance(data, dict) and data.get('schema_version') == SCHEMA_V3:
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
        if receipt['schema_version'] == SCHEMA_V3:
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


def _history(connection, receipt, *, historical=False):
    """Recheck each durable reserve; damaged but readable rows fail closed."""
    if receipt['schema_version'] == SCHEMA_V3:
        return _history_v3(connection, receipt)
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
            if receipt['schema_version'] == SCHEMA_V3:
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
            budget = int(_decimal(receipt['spend_authorization']['amount']) * USD_UNITS)
            return {'receipt': receipt, 'receipt_sha256': digest, 'remaining_usd': _usd(budget - occupied),
                    'remaining_requests': receipt['total_requests'] - sum(counts.values()), 'frozen': False}
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError, InvalidOperation):
        raise TrialGateError() from None


def trial_journal(*, state_path=STATE_PATH):
    """Non-secret audit metadata only; never raw prompts, media or keys."""
    try:
        with sqlite3.connect(Path(state_path).resolve().as_uri() + '?mode=ro', uri=True) as connection:
            connection.row_factory = sqlite3.Row
            rows = connection.execute('SELECT * FROM attempts ORDER BY id').fetchall()
            result = []
            for row in rows:
                item = dict(row)
                item['reserved_usd'] = _usd(item.pop('reserved_nano_usd'))
                item['pricing'] = json.loads(item.pop('pricing_json'))
                usage_raw = item.pop('usage_json')
                item['usage'] = json.loads(usage_raw) if usage_raw else None
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
            row = connection.execute('SELECT input_bound,generated_bound,pricing_json,usage_json,thinking_limit,output_limit FROM attempts WHERE id=?', (attempt_id,)).fetchone()
            if row is None:
                _deny()
            incoming_bound, generated_bound, pricing_json, previous, thinking_limit, output_limit = row
            pricing = json.loads(pricing_json)
            strict = 'charge_contract' in pricing
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
            normalized = {'returned_model': returned_model if isinstance(returned_model, str) else None,
                          'prompt_tokens': prompt if type(prompt) is int and 0 <= prompt < 2**63 else None,
                          'completion_tokens': generated if type(generated) is int and 0 <= generated < 2**63 else None,
                          'reasoning_tokens': thinking if type(thinking) is int and 0 <= thinking < 2**63 else None,
                          'verified': bool(valid)}
            encoded = _snapshot(normalized)
            if previous is not None and previous != encoded:
                valid = False
            if not valid:
                connection.execute('UPDATE metadata SET frozen_reason=?', ('usage_unverified_or_over_bound',))
                frozen = True
            if previous is None:
                connection.execute('UPDATE attempts SET usage_json=? WHERE id=?', (encoded, attempt_id))
            if transport_metadata is not None:
                _save_transport_metadata(connection, attempt_id, transport_metadata)
        if frozen:
            _deny()  # Raise after the freeze transaction has committed.
        return normalized
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
        raise TrialGateError() from None


def _validate_v3(data, *, historical=False):
    fields = {'schema_version', 'receipt_id', 'status', 'authorization_source', 'approval_ref',
              'synthetic_only', 'expires_at', 'total_requests', 'planned_text_requests',
              'spend_authorization', 'profiles', 'previous_receipt_sha256'}
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
    if (not isinstance(spend, dict) or set(spend) != {'currency', 'amount', 'hard_currency_cap', 'billing_limitations_accepted', 'scope'}
            or spend['currency'] != 'USD' or spend['hard_currency_cap'] is not True
            or spend['billing_limitations_accepted'] is not False
            or spend['scope'] != 'cumulative_reservations_and_new_contract_bounds'
            or not 0 < _decimal(spend['amount']) * USD_UNITS < 2**63
            or type(data['total_requests']) is not int or not 0 < data['total_requests'] < 2**31
            or type(data['planned_text_requests']) is not int):
        _deny()
    if not isinstance(data['profiles'], dict) or set(data['profiles']) != {'llm', 'asr'}:
        _deny()
    if data['planned_text_requests'] != data['profiles']['llm'].get('requests'):
        _deny()
    for kind, profile in data['profiles'].items():
        expected = {'provider', 'model', 'url', 'requests', 'max_input_bytes', 'max_output_tokens',
                    'max_thinking_tokens', 'source_sha256', 'request_sha256', 'billing'}
        if (not isinstance(profile, dict) or set(profile) != expected or not _official_endpoint(kind, profile)
                or kind == 'asr' and profile['model'] != 'gemini-2.5-flash-lite'
                or type(profile['requests']) is not int or not 0 < profile['requests'] <= 2
                or type(profile['max_input_bytes']) is not int or not 0 < profile['max_input_bytes'] <= MAX_WIRE_BYTES[kind]
                or type(profile['max_output_tokens']) is not int or not 0 < profile['max_output_tokens'] <= CAPS[kind][1]
                or type(profile['max_thinking_tokens']) is not int or profile['max_thinking_tokens'] != 0):
            _deny()
        for field in ('source_sha256', 'request_sha256'):
            values = profile[field]
            if (not isinstance(values, list) or not 1 <= len(values) <= 5
                    or any(not isinstance(value, str) or not HASH.fullmatch(value) for value in values)
                    or len(set(values)) != len(values)):
                _deny()
        if not isinstance(profile['billing'], dict) or 'charge_contract' not in profile['billing']:
            _deny()  # Legacy estimates do not become new hard contracts.
        _quote(kind, profile, historical=historical)


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


def _history_v3(connection, receipt):
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
    for row in rows:
        ident, kind, wire_sha, source_sha, size, output, thinking, incoming, generated, cost, price_json, usage_json = row
        if links[ident] not in authorities:
            _deny()
        authorization = authorities[links[ident]][0]
        profile = authorization['profiles'].get(kind)
        if profile is None:
            _deny()
        quoted = _quote(kind, profile, historical=True)
        if quoted is None:
            _deny()
        pricing, reserve = quoted
        if (type(cost) is not int or cost != reserve or price_json != _snapshot(pricing)
                or incoming != pricing['max_billable_input_tokens'] or generated != pricing['max_billable_generated_tokens']
                or wire_sha not in profile['request_sha256'] or source_sha not in profile['source_sha256']
                or type(size) is not int or not 0 < size <= profile['max_input_bytes']
                or type(output) is not int or not 0 < output <= profile['max_output_tokens']
                or type(thinking) is not int or not 0 <= thinking <= profile['max_thinking_tokens'] or usage_json is None):
            _deny()
        usage = json.loads(usage_json, object_pairs_hook=_unique_object)
        if (not isinstance(usage, dict) or set(usage) != {'returned_model', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'verified'}
                or usage['verified'] is not True or usage['returned_model'] not in pricing['returned_models']
                or type(usage['prompt_tokens']) is not int or not 0 <= usage['prompt_tokens'] <= incoming
                or type(usage['completion_tokens']) is not int or not 0 <= usage['completion_tokens'] <= generated
                or type(usage['reasoning_tokens']) is not int or not 0 <= usage['reasoning_tokens'] <= usage['completion_tokens']
                or authorization['schema_version'] == SCHEMA_V3
                and (usage['reasoning_tokens'] > thinking or usage['completion_tokens'] > output)):
            _deny()
        scope = (authorization['receipt_id'], kind)
        scoped[scope] = scoped.get(scope, 0) + 1
        if scoped[scope] > profile['requests']:
            _deny()
        counts[kind] = counts.get(kind, 0) + 1
        occupied += cost
    if sum(counts.values()) > receipt['total_requests'] or occupied > int(_decimal(receipt['spend_authorization']['amount']) * USD_UNITS):
        _deny()
    return counts, occupied


def append_trial(receipt_path=RECEIPT_PATH, state_path=STATE_PATH):
    """Trusted explicit new scope; preserve historical estimates, never reprice them."""
    try:
        receipt, digest = _receipt(receipt_path)
        if receipt['schema_version'] != SCHEMA_V3:
            _deny()
        with sqlite3.connect(Path(state_path).resolve().as_uri() + '?mode=rw', uri=True, timeout=10) as connection:
            connection.execute('BEGIN IMMEDIATE')
            rows = connection.execute('SELECT receipt_sha256,budget_sha256,receipt_json,frozen_reason FROM metadata').fetchall()
            if len(rows) != 1 or rows[0][3] is not None:
                _deny()
            previous, budget_sha, raw, _ = rows[0]
            old, _ = _parse_receipt(raw.encode(), historical=True)
            if _budget_digest(old) != budget_sha:
                _deny()
            _, occupied = _history(connection, old, historical=True)
            prior_count = connection.execute('SELECT COUNT(*) FROM attempts').fetchone()[0]
            if (receipt['previous_receipt_sha256'] != previous or digest == previous
                    or receipt['receipt_id'] == old['receipt_id'] or receipt['approval_ref'] == old['approval_ref']
                    or receipt['total_requests'] != prior_count + sum(p['requests'] for p in receipt['profiles'].values())
                    or _decimal(receipt['spend_authorization']['amount']) < _decimal(old['spend_authorization']['amount'])
                    or occupied > int(_decimal(receipt['spend_authorization']['amount']) * USD_UNITS)):
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
    pricing, cost = _quote(kind, profile)
    with sqlite3.connect(meter.state_path.resolve().as_uri() + '?mode=rw', uri=True, timeout=10) as connection:
        connection.execute('BEGIN IMMEDIATE')
        if connection.execute('SELECT receipt_sha256,budget_sha256,receipt_json,frozen_reason FROM metadata').fetchall() != [(digest, _budget_digest(receipt), _snapshot(receipt), None)]:
            _deny()
        counts, occupied = _history_v3(connection, receipt)
        used = connection.execute('SELECT COUNT(*) FROM attempts a JOIN attempt_authorizations l ON l.attempt_id=a.id JOIN authorization_snapshots s ON s.receipt_sha256=l.receipt_sha256 WHERE s.receipt_id=? AND a.kind=?', (receipt['receipt_id'], kind)).fetchone()[0]
        if (used >= profile['requests'] or sum(counts.values()) >= receipt['total_requests']
                or occupied + cost > int(_decimal(receipt['spend_authorization']['amount']) * USD_UNITS)):
            raise TrialGateError('trial_budget_exhausted')
        cursor = connection.execute('INSERT INTO attempts(kind,request_sha256,source_sha256,wire_bytes,output_limit,thinking_limit,input_bound,generated_bound,reserved_nano_usd,pricing_json) VALUES (?,?,?,?,?,?,?,?,?,?)',
            (kind, request_sha, args['source_sha256'], len(wire), output, thinking, pricing['max_billable_input_tokens'], pricing['max_billable_generated_tokens'], cost, _snapshot(pricing)))
        ident = cursor.lastrowid
        connection.execute('INSERT INTO attempt_authorizations VALUES (?,?)', (ident, digest))
    return ident


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
            if connection.execute('SELECT 1 FROM attempts WHERE id=?', (attempt_id,)).fetchone() != (1,):
                _deny()
            if connection.execute('SELECT COUNT(*) FROM metadata').fetchone() != (1,):
                _deny()
            connection.execute('UPDATE metadata SET frozen_reason=COALESCE(frozen_reason,?)', (reason_code,))
        return {'stopped': True, 'attempt_id': attempt_id}
    except (OSError, sqlite3.Error, ValueError, TypeError):
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
