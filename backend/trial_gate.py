"""Default-closed, persisted allowance for one explicitly approved synthetic trial.

Authorization is a trusted local receipt, never request data or an environment
flag. This bounds calls and wire bytes; it is not a tokenizer or currency meter.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import re
import socket
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
RECEIPT_PATH = ROOT / 'runtime/synthetic-trial/authorization.json'
STATE_PATH = ROOT / 'runtime/synthetic-trial/ledger.sqlite3'
CAPS = {'llm': (3, 2048, 0), 'asr': (1, 1024, 0), 'ocr': (1, 4096, 1024)}
MAX_WIRE_BYTES = {'llm': 24000, 'asr': 3 * 1024 * 1024, 'ocr': 3 * 1024 * 1024}
HASH = re.compile(r'^[a-f0-9]{64}$')
SCHEMA = 'noreset-synthetic-trial-v1'


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
                    'synthetic_only', 'expires_at', 'total_requests', 'spend_authorization', 'profiles'}
        if not isinstance(data, dict) or set(data) != required or data['schema_version'] != SCHEMA:
            _deny()
        if data['status'] != 'approved' or data['authorization_source'] != 'explicit_owner_approval' or data['synthetic_only'] is not True:
            _deny()
        spend = data['spend_authorization']
        if (not isinstance(spend, dict) or set(spend) != {'currency', 'amount', 'hard_currency_cap', 'billing_limitations_accepted'}
                or spend['currency'] not in {'USD', 'CNY'} or type(spend['amount']) not in {int, float}
                or not math.isfinite(spend['amount']) or spend['amount'] <= 0
                or spend['hard_currency_cap'] is not False or spend['billing_limitations_accepted'] is not True):
            _deny()
        if any(not isinstance(data[field], str) or not data[field].strip() for field in ('receipt_id', 'approval_ref', 'expires_at')):
            _deny()
        expires = datetime.fromisoformat(data['expires_at'].replace('Z', '+00:00'))
        if not expires.tzinfo or expires <= datetime.now(timezone.utc) or type(data['total_requests']) is not int or data['total_requests'] != 5:
            _deny()
        if not isinstance(data['profiles'], dict) or set(data['profiles']) != set(CAPS):
            _deny()
        for kind, profile in data['profiles'].items():
            fields = {'provider', 'model', 'url', 'requests', 'max_input_bytes', 'max_output_tokens',
                      'max_thinking_tokens', 'source_sha256', 'request_sha256'}
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
        return data, hashlib.sha256(raw).hexdigest()
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        raise TrialGateError() from None


def _snapshot(receipt):
    return json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _budget_digest(receipt):
    frozen = json.loads(_snapshot(receipt))
    frozen.pop('approval_ref')
    for profile in frozen['profiles'].values():
        profile.pop('source_sha256')
        profile.pop('request_sha256')
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
            connection.execute('CREATE TABLE metadata (receipt_sha256 TEXT NOT NULL, budget_sha256 TEXT NOT NULL, receipt_json TEXT NOT NULL)')
            connection.execute('INSERT INTO metadata VALUES (?,?,?)', (digest, _budget_digest(receipt), _snapshot(receipt)))
            connection.execute('CREATE TABLE attempts (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, request_sha256 TEXT NOT NULL, source_sha256 TEXT NOT NULL, wire_bytes INTEGER NOT NULL, output_limit INTEGER NOT NULL, thinking_limit INTEGER NOT NULL)')
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


class TrialGate:
    def __init__(self, receipt_path=RECEIPT_PATH, state_path=STATE_PATH):
        self.receipt_path, self.state_path = Path(receipt_path), Path(state_path)

    def reserve(self, *, kind, provider, model, url, wire, source_sha256, output_tokens, thinking_tokens):
        try:
            receipt, digest = _receipt(self.receipt_path)
            if kind not in CAPS or not isinstance(wire, bytes):
                _deny()
            profile = receipt['profiles'][kind]
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
                rows = connection.execute('SELECT kind, COUNT(*) FROM attempts GROUP BY kind').fetchall()
                counts = dict(rows)
                if any(key not in CAPS for key in counts):
                    _deny()
                if sum(counts.values()) >= receipt['total_requests'] or counts.get(kind, 0) >= profile['requests']:
                    raise TrialGateError('trial_budget_exhausted')
                connection.execute('INSERT INTO attempts(kind,request_sha256,source_sha256,wire_bytes,output_limit,thinking_limit) VALUES (?,?,?,?,?,?)',
                                   (kind, request_hash, source_sha256, len(wire), output_tokens, thinking_tokens))
                # Commit before network. Failure, timeout and automatic follow-on
                # requests consume the same durable allowance without refunds.
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
        TrialGate().reserve(kind=kind, provider=profile['provider'], model=profile['model'], url=request.full_url,
            wire=request.data, source_sha256=profile['source_sha256'], output_tokens=output, thinking_tokens=thinking)
    except (ValueError, TypeError, AttributeError, KeyError):
        raise TrialGateError() from None
