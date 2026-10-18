"""Real HTTP + gate + cumulative ledger, invented provider replies only.

This exercises the authorized shape, not real speech or model quality. External
transport is replaced at its sole native opener; loopback HTTP remains real.
"""
import copy
import hashlib
import json
import sqlite3

import pytest

from backend import conversation, model_client, recognition, trial_budget, trial_gate
from scripts.run_text_trial import encoded, prepare_job
from tests.test_trial_append_20261009 import history
from tests.test_trial_continuation_20261009 import closed
from tests.test_trial_scope_successor_20261009 import five, proposal, succeed
from tests.test_trial_voice_controls_http_20261009 import local_server, media_body, synthetic_wav


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


@pytest.fixture(autouse=True)
def isolated_claim_roots(monkeypatch, tmp_path):
    # Imported fixture functions do not bring their module's autouse fixture.
    # Both registries must remain inside this test's temporary directory.
    monkeypatch.setattr(trial_gate, 'CONTINUATION_CLAIM_ROOT', tmp_path / 'gate-claims')
    monkeypatch.setattr(trial_budget, 'CLAIM_ROOT', tmp_path / 'budget-claims')


def persist_proposal(case):
    raw = encoded(case['document'])
    case['receipt'].write_bytes(raw)
    case['closure']['new_receipt_sha256'] = sha(raw)
    case['closure_path'].write_bytes(encoded(case['closure']))


def bind_llm(meter, payload):
    preview = prepare_job({'job_id': 'invented-minimum-http', 'engine': 'conversation', 'native_input': payload})
    document = json.loads(meter.receipt_path.read_bytes())
    document['approval_ref'] += '-reviewed-next-source'
    document['profiles']['llm']['source_sha256'].append(preview['profile']['source_sha256'])
    document['profiles']['llm']['request_sha256'].append(preview['profile']['request_sha256'])
    meter.receipt_path.write_bytes(encoded(document))
    trial_gate.amend_trial(meter.receipt_path, meter.state_path)
    return encoded(preview['wire_body'])


@pytest.mark.parametrize('fail_second_llm', [False, True])
def test_http_voice_then_text_correction_shares_three_slots_and_cumulative_reserves(
        monkeypatch, five, local_server, fail_second_llm):
    case = proposal(five)
    audio = synthetic_wav()
    provider = recognition._OpenAICompatibleProvider(recognition._ProviderConfig(
        'aihubmix', case['document']['profiles']['asr']['url'],
        'gemini-2.5-flash-lite', 'invented-key-no-account', 1, 2048))
    audio_wire = provider._audio_request(audio, 'audio/wav', 'synthetic.wav').data
    case['document']['profiles']['asr'].update(source_sha256=[sha(audio)], request_sha256=[sha(audio_wire)])
    case['document']['profiles']['llm'].update(source_sha256=[], request_sha256=[])
    persist_proposal(case)
    meter, _ = succeed(case)
    monkeypatch.setattr(trial_gate, 'TrialGate', lambda: meter)
    calls, expected_wires, payloads = [], [audio_wire], []

    class Response:
        status = 200
        headers = {}
        def __init__(self, body):
            self.raw = encoded(body)
        def read(self, limit):
            return self.raw[:limit]
        def __enter__(self):
            return self
        def __exit__(self, *_):
            return False

    class InventedSupplier:
        def open(self, request, **_):
            index = len(calls)
            assert index < 3 and request.data == expected_wires[index]
            with sqlite3.connect(meter.state_path) as db:
                assert db.execute('SELECT COUNT(*) FROM attempts').fetchone() == (6 + index,)
            budget = trial_budget.budget_snapshot(case['document']['cumulative_budget'])
            assert budget['attempt_allocations'] == index + 1
            calls.append(request.full_url)
            if index == 0:
                return Response({'modelVersion': 'gemini-2.5-flash-lite',
                    'responseId': 'invented-first-asr',
                    'usageMetadata': {'promptTokenCount': 20, 'candidatesTokenCount': 10, 'totalTokenCount': 30},
                    'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': '我咳嗽两天了，晚上明显些。'}]}}]})
            payload = payloads[index - 1]
            body = conversation._mock_assessment(payload['turns'], conversation._controller_state(payload))
            content = '{}' if index == 2 and fail_second_llm else json.dumps(body, ensure_ascii=False)
            return Response({'id': 'invented-model-response-' + str(index), 'model': 'deepseek-flash',
                'usage': {'prompt_tokens': 40, 'completion_tokens': 20,
                          'completion_tokens_details': {'reasoning_tokens': 0}},
                'choices': [{'finish_reason': 'stop', 'message': {'content': content}}]})

    monkeypatch.setattr(model_client.urllib.request, 'build_opener', lambda *_: InventedSupplier())
    raw, content_type = media_body(audio)
    first = local_server.request('POST', '/api/ai/media/recognize', raw_body=raw,
                                 headers={'Content-Type': content_type})
    assert first.status == 200 and first.body['trial_control'] == {'review_required': True}
    assert len(calls) == 1
    trial_gate.confirm_trial_review(6, 'invented-asr-business-source-review', state_path=meter.state_path)
    turns = [{'turn_id': 'turn_invented_n01_first', 'version': 1,
              'text': first.body['recognition']['text']}]
    payloads.append({'turns': copy.deepcopy(turns)})
    expected_wires.append(bind_llm(meter, payloads[-1]))
    second = local_server.request('POST', '/api/ai/conversation-turn', payloads[-1])
    assert second.status == 200 and not second.body.get('ai_failed')
    assert len(calls) == 2
    trial_gate.confirm_trial_review(7, 'invented-first-llm-business-source-review', state_path=meter.state_path)
    turns.append({'turn_id': 'turn_invented_n01_correction', 'version': 1,
                  'text': '我刚才说错了，不是两天，是三天。'})
    payloads.append({'turns': copy.deepcopy(turns)})
    expected_wires.append(bind_llm(meter, payloads[-1]))
    third = local_server.request('POST', '/api/ai/conversation-turn', payloads[-1])
    assert third.status == (422 if fail_second_llm else 200)
    assert len(calls) == 3
    if fail_second_llm:
        assert third.body['trial_control']['stopped'] is True
    else:
        assert not third.body.get('ai_failed')
        current = third.body['completeness']['clinical_state']['onset_course']
        assert current['status'] == 'known' and '三天' in current['summary']
        trial_gate.close_trial_scope(meter.receipt_path, meter.state_path)
    fourth = local_server.request('POST', '/api/ai/conversation-turn', payloads[-1])
    assert fourth.status == 422 and len(calls) == 3
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT * FROM attempts WHERE id<=5 ORDER BY id').fetchall() == case['old_rows']
        assert db.execute('SELECT usage_json FROM attempts WHERE id=4').fetchone() == (None,)
        assert db.execute('SELECT COUNT(*) FROM attempts').fetchone() == (8,)
    budget = trial_budget.budget_snapshot(case['document']['cumulative_budget'])
    assert budget['reserved_estimate_usd'] == '0.0203392'
    assert budget['supplier_final_cost_usd'] is None
    assert case['previous'].state_path.read_bytes() == case['old_state']
    assert case['previous'].receipt_path.read_bytes() == case['old_receipt']
