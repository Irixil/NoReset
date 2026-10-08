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


def _quote(kind, profile):
    billing = profile['billing']
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
    if dated > datetime.now(timezone.utc).date() or not expires.tzinfo or expires <= datetime.now(timezone.utc):
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
        raw = Path(path).read_bytes()
        if len(raw) > 65536:
            _deny()
        data = json.loads(raw, object_pairs_hook=_unique_object)
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
        if not expires.tzinfo or expires <= datetime.now(timezone.utc) or type(data['total_requests']) is not int or data['total_requests'] != 5 or type(data['planned_text_requests']) is not int or data['planned_text_requests'] != 3:
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
            _quote(kind, profile)
        return data, hashlib.sha256(raw).hexdigest()
    except (OSError, ValueError, TypeError, KeyError, OverflowError, InvalidOperation):
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


def _history(connection, receipt):
    """Recheck each durable reserve; damaged but readable rows fail closed."""
    rows = connection.execute('SELECT kind,request_sha256,source_sha256,wire_bytes,output_limit,thinking_limit,input_bound,generated_bound,reserved_nano_usd,pricing_json,usage_json FROM attempts').fetchall()
    counts, occupied = {}, 0
    for kind, wire_sha, source_sha, wire_bytes, output, thinking, incoming_bound, generated_bound, cost, pricing_json, usage_json in rows:
        if kind not in CAPS:
            _deny()
        profile = receipt['profiles'][kind]
        quoted = _quote(kind, profile)
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


def report_usage(attempt_id, returned_model, usage, *, state_path=STATE_PATH):
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
            row = connection.execute('SELECT input_bound,generated_bound,pricing_json,usage_json FROM attempts WHERE id=?', (attempt_id,)).fetchone()
            if row is None:
                _deny()
            incoming_bound, generated_bound, pricing_json, previous = row
            pricing = json.loads(pricing_json)
            prompt = usage.get('prompt_tokens') if isinstance(usage, dict) else None
            generated = usage.get('completion_tokens') if isinstance(usage, dict) else None
            details = usage.get('completion_tokens_details') if isinstance(usage, dict) else None
            thinking = details.get('reasoning_tokens', 0) if isinstance(details, dict) else 0
            valid = (returned_model in pricing['returned_models'] and pricing['completion_tokens_include_reasoning'] is True
                     and (details is None or isinstance(details, dict))
                     and type(prompt) is int and 0 <= prompt <= incoming_bound
                     and type(generated) is int and 0 <= generated <= generated_bound
                     and type(thinking) is int and 0 <= thinking <= generated)
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
        if frozen:
            _deny()  # Raise after the freeze transaction has committed.
        return normalized
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
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
        attempt_id = TrialGate().reserve(kind=kind, provider=profile['provider'], model=profile['model'], url=request.full_url,
            wire=request.data, source_sha256=profile['source_sha256'], output_tokens=output, thinking_tokens=thinking)
        request._noreset_trial_attempt_id = attempt_id
        return attempt_id
    except (ValueError, TypeError, AttributeError, KeyError):
        raise TrialGateError() from None
