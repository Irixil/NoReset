"""Invented informed-risk approval, synthetic WAV, temporary DB; no provider."""
import base64
import copy
import io
import json
import sqlite3
import wave
from datetime import datetime, timedelta, timezone

import pytest

from backend import trial_gate as gate
from tests.test_trial_append_20261009 import history
from tests.test_trial_gate import digest


def audio(seconds=1, rate=16000, channels=1):
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as wav:
        wav.setnchannels(channels); wav.setsampwidth(2); wav.setframerate(rate)
        wav.writeframes(b'\0\0' * int(seconds * rate) * channels)
    return stream.getvalue()


def wire(kind, wav=None):
    if kind == 'llm':
        value = {'model': 'deepseek-flash', 'messages': [{'role': 'user', 'content': '原创虚构：我想记清原话。'}],
            'max_tokens': 2048, 'stream': False, 'thinking': {'type': 'disabled'}}
    else:
        value = {'contents': [{'role': 'user', 'parts': [{'text': '原创合成语音测试'},
            {'inlineData': {'mimeType': 'audio/wav', 'data': base64.b64encode(wav or audio()).decode()}}]}],
            'generationConfig': {'maxOutputTokens': 1024,
                'thinkingConfig': {'thinkingBudget': 0, 'includeThoughts': False}}}
    return json.dumps(value, ensure_ascii=False).encode()


def informed(old, previous):
    value = copy.deepcopy(old)
    now = datetime.now(timezone.utc)
    value.update(schema_version='noreset-synthetic-trial-informed-risk-v1', receipt_id='invented-informed-risk',
        approval_ref='synthetic-fixture-human-accepts-unknown-final-charge', approved_at=now.isoformat(),
        expires_at=(now + timedelta(minutes=50)).isoformat(), previous_receipt_sha256=previous,
        total_requests=7, planned_text_requests=2)
    value['spend_authorization'] = {'currency': 'USD', 'estimated_new_usd': '0.0213632',
        'hard_currency_cap': False, 'billing_limitations_accepted': True,
        'scope': 'limited_requests_with_disclosed_non_hard_estimate', 'unknown_final_cost_accepted': True}
    value['profiles'].pop('ocr')
    for kind, profile in value['profiles'].items():
        profile['requests'] = 2
        if kind == 'llm': profile['url'] = 'https://api.deepseek.com/chat/completions'
        profile['request_sha256'] = [digest(wire(kind))]
        profile['source_sha256'] = [digest(audio()) if kind == 'asr' else digest(b'original synthetic typed source')]
        billing = profile['billing']
        billing.update(status='disclosed_estimate', usd_per_million_input_tokens='0.30',
            usd_per_million_generated_tokens='1.20' if kind == 'llm' else '0.40',
            estimated_input_tokens=24000 if kind == 'llm' else 2048,
            estimated_usd='0.0096576' if kind == 'llm' else '0.001024',
            observed_input_tokens_limit=24000 if kind == 'llm' else 2048,
            observed_generated_tokens_limit=profile['max_output_tokens'],
            complete_cost_bound_known=False, internal_billable_attempts_known=False)
        billing.pop('max_billable_input_tokens'); billing.pop('max_billable_generated_tokens')
    return value


def activate(history):
    meter, old, rows, previous_fixture = history
    document = informed(old, previous_fixture['previous_receipt_sha256'])
    meter.receipt_path.write_text(json.dumps(document))
    gate.append_trial(meter.receipt_path, meter.state_path)
    return meter, document


def send(meter, document, kind, report=True, **changes):
    profile = document['profiles'][kind]
    args = dict(kind=kind, provider=profile['provider'], model=profile['model'], url=profile['url'],
        wire=wire(kind), source_sha256=changes.get('source_sha256') or (profile['source_sha256'][0] if profile['source_sha256'] else None),
        output_tokens=profile['max_output_tokens'], thinking_tokens=0)
    args.update(changes)
    ident = meter.reserve(**args)
    if report:
        gate.report_usage(ident, profile['model'], {'prompt_tokens': 1, 'completion_tokens': 1,
            'completion_tokens_details': {'reasoning_tokens': 0}}, state_path=meter.state_path)
    return ident


def review(meter, ident):
    return gate.confirm_trial_review(ident, 'invented-human-compared-original-and-output', state_path=meter.state_path)


def test_informed_scope_preserves_history_but_never_claims_money_remaining(history):
    meter, document = activate(history)
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT * FROM attempts ORDER BY id').fetchall() == history[2]
    preflight = gate.validate_trial_authorization(receipt_path=meter.receipt_path, state_path=meter.state_path)
    assert preflight['remaining_usd'] is None and preflight['cost_bound_known'] is False
    assert preflight['historical_reserved_usd'] == '0.9510912'
    for kind in ('asr', 'llm', 'asr', 'llm'): review(meter, send(meter, document, kind))
    journal = gate.trial_journal(state_path=meter.state_path)
    assert len(journal) == 7
    assert journal[-1]['reserved_usd'] == '0'
    assert journal[-1]['estimated_usd'] == '0.0096576' and journal[-1]['cost_bound_known'] is False
    with pytest.raises(gate.TrialGateError): send(meter, document, 'asr')


@pytest.mark.parametrize('mutation', [
    lambda x: x['spend_authorization'].update(hard_currency_cap=True),
    lambda x: x['spend_authorization'].update(unknown_final_cost_accepted=False),
    lambda x: x['spend_authorization'].update(billing_limitations_accepted=False),
    lambda x: x['spend_authorization'].update(estimated_new_usd='1'),
    lambda x: x.update(expires_at=(datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()),
    lambda x: x.update(expires_at='2000-01-01T00:00:00Z'),
    lambda x: x['profiles']['asr']['billing'].update(complete_cost_bound_known=True),
    lambda x: x['profiles']['asr']['billing'].update(charge_contract={'status': 'verified'}),
    lambda x: x['profiles']['llm'].update(requests=3),
    lambda x: x.update(previous_receipt_sha256='0' * 64),
])
def test_false_hardcap_or_changed_scope_never_activates(history, mutation):
    meter, old, rows, previous = history
    document = informed(old, previous['previous_receipt_sha256']); mutation(document)
    meter.receipt_path.write_text(json.dumps(document))
    with pytest.raises(gate.TrialGateError): gate.append_trial(meter.receipt_path, meter.state_path)
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT * FROM attempts ORDER BY id').fetchall() == rows


def test_stage_order_and_manual_review_are_required(history):
    meter, document = activate(history)
    with pytest.raises(gate.TrialGateError): send(meter, document, 'llm')
    ident = send(meter, document, 'asr')
    with pytest.raises(gate.TrialGateError): send(meter, document, 'llm')
    review(meter, ident)
    send(meter, document, 'llm', report=False)
    with pytest.raises(gate.TrialGateError): send(meter, document, 'asr')
    with pytest.raises(gate.TrialGateError): review(meter, ident + 1)


@pytest.mark.parametrize('tokens', [2049, True, None])
def test_observed_input_outside_disclosed_estimate_freezes(history, tokens):
    meter, document = activate(history)
    ident = send(meter, document, 'asr', report=False)
    with pytest.raises(gate.TrialGateError):
        gate.report_usage(ident, 'gemini-2.5-flash-lite', {'prompt_tokens': tokens, 'completion_tokens': 1,
            'completion_tokens_details': {'reasoning_tokens': 0}}, state_path=meter.state_path)
    with pytest.raises(gate.TrialGateError): review(meter, ident)


@pytest.mark.parametrize('wav', [audio(20.001), audio(rate=8000), audio(channels=2)])
def test_approved_sha_cannot_bypass_audio_envelope(history, wav):
    meter, old, _, previous = history
    document = informed(old, previous['previous_receipt_sha256'])
    document['profiles']['asr']['source_sha256'] = [digest(wav)]
    document['profiles']['asr']['request_sha256'] = [digest(wire('asr', wav))]
    meter.receipt_path.write_text(json.dumps(document)); gate.append_trial(meter.receipt_path, meter.state_path)
    with pytest.raises(gate.TrialGateError): send(meter, document, 'asr', wire=wire('asr', wav))


def test_hash_amend_cannot_clear_stop_or_add_calls(history):
    meter, document = activate(history)
    ident = send(meter, document, 'asr'); gate.stop_trial(ident, 'business_validation_failed', state_path=meter.state_path)
    document['approval_ref'] = 'different-invented-hash-review'
    document['profiles']['llm']['source_sha256'].append(digest(b'another original synthetic source'))
    meter.receipt_path.write_text(json.dumps(document))
    with pytest.raises(gate.TrialGateError): gate.amend_trial(meter.receipt_path, meter.state_path)
    with pytest.raises(gate.TrialGateError): send(meter, document, 'llm')


def test_pending_llm_hashes_are_empty_then_added_after_real_asr_review(history):
    meter, old, _, previous = history
    document = informed(old, previous['previous_receipt_sha256'])
    source = document['profiles']['llm']['source_sha256'].pop()
    request = document['profiles']['llm']['request_sha256'].pop()
    meter.receipt_path.write_text(json.dumps(document)); gate.append_trial(meter.receipt_path, meter.state_path)
    review(meter, send(meter, document, 'asr'))
    with pytest.raises(gate.TrialGateError): send(meter, document, 'llm', source_sha256=source)
    document['approval_ref'] = 'invented-human-review-of-actual-derived-wire'
    document['profiles']['llm']['source_sha256'].append(source)
    document['profiles']['llm']['request_sha256'].append(request)
    meter.receipt_path.write_text(json.dumps(document)); gate.amend_trial(meter.receipt_path, meter.state_path)
    review(meter, send(meter, document, 'llm'))
    send(meter, document, 'asr')
    assert len(gate.trial_journal(state_path=meter.state_path)) == 6


@pytest.mark.parametrize('bad', ['tools', 'fileData', 'thoughts', 'source'])
def test_even_approved_wire_rejects_extra_or_mismatched_asr_input(history, bad):
    meter, old, _, previous = history
    document = informed(old, previous['previous_receipt_sha256'])
    body = json.loads(wire('asr'))
    if bad == 'tools': body['tools'] = [{'functionDeclarations': []}]
    elif bad == 'fileData': body['contents'][0]['parts'].append({'fileData': {'fileUri': 'https://synthetic.invalid/no-fetch'}})
    elif bad == 'thoughts': body['generationConfig']['thinkingConfig']['includeThoughts'] = True
    elif bad == 'source': document['profiles']['asr']['source_sha256'] = [digest(b'not this synthetic audio')]
    frozen = json.dumps(body).encode()
    document['profiles']['asr']['request_sha256'] = [digest(frozen)]
    meter.receipt_path.write_text(json.dumps(document)); gate.append_trial(meter.receipt_path, meter.state_path)
    with pytest.raises(gate.TrialGateError): send(meter, document, 'asr', wire=frozen)
