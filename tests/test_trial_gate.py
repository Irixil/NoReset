"""Synthetic allowance tests: no test may send an external network request."""
import copy
import hashlib
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from urllib.request import Request

import pytest

from backend import model_client, trial_gate
from backend.trial_gate import TrialGate, TrialGateError, initialize_trial, amend_trial, authorize_request


def digest(value): return hashlib.sha256(value).hexdigest()


def wire_for(kind):
    if kind == 'asr':
        body = {'generationConfig': {'maxOutputTokens': 1024, 'thinkingConfig': {'thinkingBudget': 0}}}
    else:
        body = {'model': 'deepseek-flash' if kind == 'llm' else 'qwen3.7-plus',
            'max_tokens': 2048 if kind == 'llm' else 4096, 'messages': []}
        body.update({'thinking': {'type': 'disabled'}} if kind == 'llm' else {'reasoning_effort': 'none'})
    return json.dumps(body).encode()


def receipt_document():
    urls = {'llm': 'https://api.deepseek.com/v1/chat/completions',
        'asr': 'https://aihubmix.com/gemini/v1beta/models/gemini-2.5-flash-lite:generateContent',
        'ocr': 'https://aihubmix.com/v1/chat/completions'}
    models = {'llm': 'deepseek-flash', 'asr': 'gemini-2.5-flash-lite', 'ocr': 'qwen3.7-plus'}
    return {'schema_version': trial_gate.SCHEMA, 'receipt_id': 'synthetic-test-only', 'status': 'approved',
        'authorization_source': 'explicit_owner_approval', 'approval_ref': 'synthetic-fixture-no-real-approval',
        'synthetic_only': True, 'expires_at': (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        'spend_authorization': {'currency': 'USD', 'amount': 1, 'hard_currency_cap': False, 'billing_limitations_accepted': True},
        'total_requests': 5, 'profiles': {kind: {
            'provider': 'deepseek' if kind == 'llm' else 'aihubmix', 'model': models[kind], 'url': urls[kind],
            'requests': values[0], 'max_input_bytes': trial_gate.MAX_WIRE_BYTES[kind],
            'max_output_tokens': values[1], 'max_thinking_tokens': values[2],
            'source_sha256': [digest(b'explicitly synthetic source')], 'request_sha256': [digest(wire_for(kind))],
        } for kind, values in trial_gate.CAPS.items()}}


@pytest.fixture
def approved(tmp_path):
    receipt, state = tmp_path / 'receipt.json', tmp_path / 'ledger.sqlite3'
    document = receipt_document()
    receipt.write_text(json.dumps(document))
    initialize_trial(receipt, state)
    return TrialGate(receipt, state), document


def reserve(gate, document, kind='llm', **changes):
    profile = document['profiles'][kind]
    args = dict(kind=kind, provider=profile['provider'], model=profile['model'], url=profile['url'],
        wire=wire_for(kind), source_sha256=profile['source_sha256'][0],
        output_tokens=profile['max_output_tokens'], thinking_tokens=0)
    args.update(changes)
    gate.reserve(**args)


def count(gate):
    with sqlite3.connect(gate.state_path) as db:
        return db.execute('SELECT COUNT(*) FROM attempts').fetchone()[0]


def external_request(document, kind='llm', wire=None):
    profile = document['profiles'][kind]
    request = Request(profile['url'], data=wire if wire is not None else wire_for(kind))
    request._noreset_trial_profile = {'kind': kind, 'provider': profile['provider'], 'model': profile['model'], 'source_sha256': profile['source_sha256'][0]}
    return request


def test_default_missing_authorization_stops_before_transport(monkeypatch):
    monkeypatch.setattr(model_client.urllib.request, 'build_opener', lambda *args: pytest.fail('external transport was opened'))
    request = external_request(receipt_document())
    with pytest.raises(model_client.ModelClientError) as error:
        model_client._open_request(request, 1)
    assert error.value.code == 'trial_authorization_required'
    assert 'api.deepseek.com' not in str(error.value)


def test_exact_split_and_restart_does_not_reset_count(approved):
    gate, document = approved
    for kind in ['llm', 'llm', 'llm', 'asr', 'ocr']:
        reserve(TrialGate(gate.receipt_path, gate.state_path), document, kind)
    assert count(gate) == 5
    with pytest.raises(TrialGateError) as error: reserve(gate, document)
    assert error.value.code == 'trial_budget_exhausted'


def test_concurrent_callers_reserve_only_the_three_llm_slots(approved):
    gate, document = approved
    def attempt(_):
        try: reserve(TrialGate(gate.receipt_path, gate.state_path), document); return True
        except TrialGateError: return False
    with ThreadPoolExecutor(max_workers=12) as pool:
        assert sum(pool.map(attempt, range(20))) == 3
    assert count(gate) == 3


def test_failure_after_reservation_still_consumes_slot(approved, monkeypatch):
    gate, document = approved
    monkeypatch.setattr(trial_gate, 'TrialGate', lambda: gate)
    class Opener:
        def open(self, *args, **kwargs): raise TimeoutError('synthetic-only')
    monkeypatch.setattr(model_client.urllib.request, 'build_opener', lambda *args: Opener())
    for _ in range(3):
        with pytest.raises(TimeoutError): model_client._open_request(external_request(document), 1)
    assert count(gate) == 3
    with pytest.raises(model_client.ModelClientError) as error:
        model_client._open_request(external_request(document), 1)
    assert error.value.code == 'trial_budget_exhausted'


@pytest.mark.parametrize('changes', [
    {'provider': 'other'}, {'model': 'other'}, {'url': 'https://other.invalid'},
    {'wire': b'undeclared hidden automatic chain'}, {'source_sha256': digest(b'undeclared source')},
    {'output_tokens': 2049}, {'thinking_tokens': 1}, {'output_tokens': True},
])
def test_mismatch_never_consumes_or_sends(approved, changes):
    gate, document = approved
    with pytest.raises(TrialGateError): reserve(gate, document, **changes)
    assert count(gate) == 0


@pytest.mark.parametrize('mutation', [
    lambda d: d.update(status='pending'), lambda d: d.update(synthetic_only=False),
    lambda d: d.update(total_requests=6), lambda d: d.update(expires_at='2000-01-01T00:00:00Z'),
    lambda d: d.update(authorization_source='request_payload'),
    lambda d: d['profiles']['llm'].update(max_input_bytes=24001),
    lambda d: d['profiles']['asr'].update(max_input_bytes=3*1024*1024+1),
    lambda d: d['profiles']['ocr'].update(provider='custom'),
    lambda d: d['profiles']['llm'].update(url='https://evil.invalid/chat/completions'),
    lambda d: d['spend_authorization'].update(amount=None),
    lambda d: d['spend_authorization'].update(amount=float('inf')),
    lambda d: d['spend_authorization'].update(amount=True),
    lambda d: d['spend_authorization'].update(amount=0),
    lambda d: d['spend_authorization'].update(currency='BTC'),
    lambda d: d['spend_authorization'].update(hard_currency_cap=True),
    lambda d: d['spend_authorization'].update(billing_limitations_accepted=False),
])
def test_invalid_receipt_cannot_initialize(tmp_path, mutation):
    document = receipt_document(); mutation(document)
    path, state = tmp_path / 'receipt.json', tmp_path / 'state.sqlite3'
    path.write_text(json.dumps(document))
    with pytest.raises(TrialGateError): initialize_trial(path, state)
    assert not state.exists()


def test_corrupt_missing_changed_or_reinitialized_state_fails_closed(approved):
    gate, document = approved
    with pytest.raises(TrialGateError): initialize_trial(gate.receipt_path, gate.state_path)
    assert count(gate) == 0
    document['approval_ref'] += '-changed'
    gate.receipt_path.write_text(json.dumps(document))
    with pytest.raises(TrialGateError): reserve(gate, document)
    gate.state_path.write_bytes(b'corrupt')
    with pytest.raises(TrialGateError): reserve(gate, document)
    gate.state_path.unlink()
    with pytest.raises(TrialGateError): reserve(gate, document)
    assert not gate.state_path.exists()


def test_request_body_cannot_supply_its_own_receipt(monkeypatch):
    request = Request('https://api.deepseek.com/v1/chat/completions', data=json.dumps(receipt_document()).encode())
    with pytest.raises(TrialGateError): authorize_request(request)


def test_absent_llm_thinking_setting_is_not_zero(approved, monkeypatch):
    gate, document = approved; monkeypatch.setattr(trial_gate, 'TrialGate', lambda: gate)
    body = json.loads(wire_for('llm')); body.pop('thinking')
    with pytest.raises(TrialGateError): authorize_request(external_request(document, wire=json.dumps(body).encode()))
    assert count(gate) == 0


def test_ocr_positive_undocumented_thinking_setting_is_blocked(approved, monkeypatch):
    gate, document = approved; monkeypatch.setattr(trial_gate, 'TrialGate', lambda: gate)
    body = json.loads(wire_for('ocr')); body.update(enable_thinking=True, thinking_budget=1024)
    with pytest.raises(TrialGateError): authorize_request(external_request(document, 'ocr', json.dumps(body).encode()))
    assert count(gate) == 0


def test_local_test_has_no_proxy_or_redirect_and_no_external_authority(monkeypatch):
    captured = []
    class Opener:
        def open(self, request, timeout): return 'synthetic-response'
    def build(*handlers): captured.extend(handlers); return Opener()
    monkeypatch.setattr(model_client.urllib.request, 'build_opener', build)
    assert model_client._open_request(Request('http://127.0.0.1:19844/fixture'), 1) == 'synthetic-response'
    proxy = next(handler for handler in captured if isinstance(handler, model_client.urllib.request.ProxyHandler))
    assert proxy.proxies == {}
    assert any(isinstance(handler, model_client.NoRedirectHandler) for handler in captured)
    assert not trial_gate.is_loopback_url('https://localhost.evil.invalid')
    assert not trial_gate.is_loopback_url('https://127.0.0.1.evil.invalid')


def test_audit_records_bytes_and_output_thinking_caps_without_content(approved):
    gate, document = approved; reserve(gate, document)
    with sqlite3.connect(gate.state_path) as db:
        assert db.execute('SELECT wire_bytes,output_limit,thinking_limit FROM attempts').fetchone() == (len(wire_for('llm')), 2048, 0)
        assert b'explicitly synthetic source' not in gate.state_path.read_bytes()


def derived_amendment(document):
    amended = copy.deepcopy(document)
    wire = json.loads(wire_for('llm')); wire['messages'] = [{'role': 'user', 'content': 'derived synthetic source'}]
    wire = json.dumps(wire).encode()
    source = digest(b'derived explicitly synthetic source')
    amended['profiles']['llm']['request_sha256'].append(digest(wire))
    amended['profiles']['llm']['source_sha256'].append(source)
    amended['approval_ref'] = 'synthetic-fixture-explicit-derived-review-no-real-approval'
    return amended, wire, source


def test_explicit_amend_adds_derived_hashes_without_resetting_any_allowance(approved):
    gate, document = approved
    reserve(gate, document)
    amended, wire, source = derived_amendment(document)
    gate.receipt_path.write_text(json.dumps(amended))
    with pytest.raises(TrialGateError): reserve(gate, amended, wire=wire, source_sha256=source)
    assert count(gate) == 1
    amend_trial(gate.receipt_path, gate.state_path)
    reserve(gate, amended, wire=wire, source_sha256=source)
    reserve(gate, amended)  # Original hashes are still authorized, same old budget.
    with pytest.raises(TrialGateError) as error: reserve(gate, amended, wire=wire, source_sha256=source)
    assert error.value.code == 'trial_budget_exhausted'
    reserve(gate, amended, 'asr'); reserve(gate, amended, 'ocr')
    assert count(gate) == 5
    reserve_gate = TrialGate(gate.receipt_path, gate.state_path)
    with pytest.raises(TrialGateError): reserve(reserve_gate, amended)


@pytest.mark.parametrize('mutation', [
    lambda d: d.update(receipt_id='another-trial'),
    lambda d: d['profiles']['llm'].update(model='deepseek-v4-pro'),
    lambda d: d['profiles']['llm'].update(requests=4),
    lambda d: d['profiles']['llm'].update(max_input_bytes=23999),
    lambda d: d['spend_authorization'].update(amount=2),
    lambda d: d['profiles']['llm']['source_sha256'].pop(0),
    lambda d: d['profiles']['llm']['request_sha256'].reverse(),
])
def test_amend_cannot_change_budget_profiles_or_remove_reorder_old_hashes(approved, mutation):
    gate, document = approved; reserve(gate, document)
    amended, _, _ = derived_amendment(document); mutation(amended)
    gate.receipt_path.write_text(json.dumps(amended))
    with pytest.raises(TrialGateError): amend_trial(gate.receipt_path, gate.state_path)
    assert count(gate) == 1
    gate.receipt_path.write_text(json.dumps(document))
    reserve(gate, document)
    assert count(gate) == 2


def test_amend_requires_new_explicit_review_reference(approved):
    gate, document = approved
    amended, _, _ = derived_amendment(document); amended['approval_ref'] = document['approval_ref']
    gate.receipt_path.write_text(json.dumps(amended))
    with pytest.raises(TrialGateError): amend_trial(gate.receipt_path, gate.state_path)
    assert count(gate) == 0
