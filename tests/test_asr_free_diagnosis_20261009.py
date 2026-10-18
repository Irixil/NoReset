"""Free diagnosis only: synthetic responses/WAV and temp stores, no provider."""
import copy
import json
import sqlite3
from decimal import Decimal
from types import SimpleNamespace
from urllib.request import Request

import pytest

from backend import conversation, model_client, recognition, trial_gate
from backend.media_backend import LocalMediaBackend
from backend.media_service import MediaRecognitionService
from backend.store import SQLiteStore
from tests.test_conversation import model_draft
from tests.test_trial_append_20261009 import history
from tests.test_trial_gate import digest
from tests.test_trial_informed_risk_20261009 import activate, audio, send, wire


def response():
    return {'modelVersion': 'gemini-2.5-flash-lite',
        'usageMetadata': {'promptTokenCount': 180, 'candidatesTokenCount': 10, 'totalTokenCount': 190},
        'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': '原创虚构：我咳嗽两天了。'}]}}]}


def local_pipeline(history, monkeypatch, body):
    meter, document = activate(history)
    class Response:
        status = 200
        def read(self, limit): return json.dumps(body, ensure_ascii=False).encode()[:limit]
        def __enter__(self): return self
        def __exit__(self, *_): return False
    sends = []
    class Opener:
        def open(self, request, **kwargs): sends.append(request); return Response()
    monkeypatch.setattr(trial_gate, 'TrialGate', lambda: meter)
    monkeypatch.setattr(model_client.urllib.request, 'build_opener', lambda *_: Opener())
    request = Request(document['profiles']['asr']['url'], data=wire('asr'))
    request._noreset_trial_profile = {'kind': 'asr', 'provider': 'aihubmix', 'model': 'gemini-2.5-flash-lite',
                                     'source_sha256': document['profiles']['asr']['source_sha256'][0]}
    # _send needs only these limits; no credentials/config loader is constructed.
    provider = recognition._OpenAICompatibleProvider.__new__(recognition._OpenAICompatibleProvider)
    provider._config = SimpleNamespace(timeout_seconds=1, max_response_bytes=4096)
    return provider, request, sends, meter, document


def test_balanced_omitted_thoughts_keep_money_unknown_and_block_unreviewed_llm(history, monkeypatch):
    body = response(); before = copy.deepcopy(body)
    provider, request, sends, meter, document = local_pipeline(history, monkeypatch, body)
    assert provider._send(request) == body['candidates'][0]['content']['parts'][0]['text']
    assert body == before and provider.trial_control == {'review_required': True}
    journal = trial_gate.trial_journal(state_path=meter.state_path)
    current = journal[-1]
    assert current['usage']['prompt_tokens'] == 180 and current['usage']['completion_tokens'] == 10
    assert current['usage']['reasoning_tokens'] == 0
    # Disclosed highest-input-rate planning estimate, not modality pricing or an invoice.
    observed_estimate = (Decimal('0.30') * 180 + Decimal('0.40') * 10) / Decimal('1000000')
    assert observed_estimate == Decimal('0.000058') > 0
    assert current['reserved_usd'] == '0' and current['estimated_usd'] == '0.001024'
    assert current['cost_bound_known'] is False
    preflight = trial_gate.validate_trial_authorization(receipt_path=meter.receipt_path, state_path=meter.state_path)
    assert preflight['remaining_usd'] is None and preflight['cost_bound_known'] is False
    assert preflight['historical_reserved_usd'] == '0.9510912'
    with pytest.raises(trial_gate.TrialGateError): send(meter, document, 'llm')
    assert len(sends) == 1 and len(trial_gate.trial_journal(state_path=meter.state_path)) == 4
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT * FROM attempts WHERE id<=3 ORDER BY id').fetchall() == history[2]


@pytest.mark.parametrize('mutation', [
    lambda b: b['usageMetadata'].pop('totalTokenCount'),
    lambda b: b['usageMetadata'].update(totalTokenCount=191),
    lambda b: b['usageMetadata'].update(toolUsePromptTokenCount=1),
    lambda b: b.update(modelVersion='unknown-model'),
])
def test_parser_exception_still_freezes_native_transport_without_followup(history, monkeypatch, mutation):
    body = response(); mutation(body)
    provider, request, sends, meter, document = local_pipeline(history, monkeypatch, body)
    with pytest.raises(recognition.RecognitionError): provider._send(request)
    with pytest.raises(trial_gate.TrialGateError): trial_gate.confirm_trial_review(4, 'cannot-review-failure', state_path=meter.state_path)
    with pytest.raises(trial_gate.TrialGateError): send(meter, document, 'llm')
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT frozen_reason FROM metadata').fetchone()[0] is not None
        assert db.execute('SELECT COUNT(*) FROM attempts').fetchone()[0] == 4
    assert len(sends) == 1


def test_valid_offline_usage_never_clears_later_business_stop(history, monkeypatch):
    body = response()
    provider, request, sends, meter, document = local_pipeline(history, monkeypatch, body)
    provider._send(request)
    trial_gate.stop_trial(4, 'business_validation_failed', state_path=meter.state_path)
    model_client._trial_report(request, body, json.dumps(body, ensure_ascii=False).encode(), protocol='gemini')
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT frozen_reason FROM metadata').fetchone()[0] == 'business_validation_failed'
    with pytest.raises(trial_gate.TrialGateError): trial_gate.confirm_trial_review(4, 'no-thaw', state_path=meter.state_path)
    with pytest.raises(trial_gate.TrialGateError): send(meter, document, 'llm')
    assert len(sends) == 1


def test_current_corrected_version_is_the_only_same_id_text_sent_to_model():
    received = []
    class OfflineProvider:
        def complete_json(self, system, payload):
            received.append(copy.deepcopy(payload))
            return model_draft(payload['turns'], user_intent='correction', suggested_action='ask',
                question_category='functional_impact', question_importance='essential', candidate_question='现在最影响您做什么？',
                reply_text='我会保留更正后的原话。')
    current = {'turn_id': 'turn_freeaudit01', 'text': '原创虚构：我头疼三天。', 'version': 2}
    result = conversation.conversation_turn({'turns': [current]}, provider=OfflineProvider())
    assert received[0]['turns'] == [current]
    assert result['completeness']['clinical_state']['main_complaint']['evidence_turn_ids'] == [current['turn_id']]
    assert '两天' not in json.dumps(result, ensure_ascii=False)
    with pytest.raises(conversation.ConversationError):
        conversation.conversation_turn({'turns': [{**current, 'version': 1, 'text': '原旧话两天'}, current]}, provider=OfflineProvider())
    assert len(received) == 1  # Ambiguous duplicate ID is rejected before model.


def test_legacy_media_candidate_is_unconfirmed_and_revision_preserves_original(tmp_path):
    store = SQLiteStore(tmp_path / 'synthetic-records.sqlite3')
    backend = LocalMediaBackend(store, tmp_path / 'synthetic-media', recognition_provider='unconfigured')
    raw = audio()
    upload, _ = backend.create_upload({'kind': 'audio', 'content_type': 'audio/wav', 'total_parts': 1,
        'expected_size': len(raw), 'expected_sha256': digest(raw), 'original_filename': 'synthetic.wav',
        'actor_name': '虚构讲述者'}, 'synthetic-upload')
    backend.write_part(upload['upload_id'], 0, raw, 'synthetic-part')
    media, _ = backend.complete_upload(upload['upload_id'], 'synthetic-complete')
    candidate = '原创虚构：我咳嗽两天，时间不确定。'
    calls = []
    def offline_recognizer(path, **kwargs):
        calls.append(str(path))
        return {'text': candidate, 'provider': 'offline-external-substitute', 'model': 'synthetic-only',
                'is_mock': False, 'trial_control': {'review_required': True}}
    service = MediaRecognitionService(store, backend.file_store, recognizer=offline_recognizer)
    result = service.recognize_media(media['media_id'], media['version'], 'synthetic-recognition', '虚构讲述者')
    event = store.get(result['media']['record_id'])
    assert event['raw_text'] == candidate and event['source_kind'] == 'audio_transcript' and event['state'] == 'inbox'
    assert 'record_not_confirmed' in store.handoff()['items'][0]['unresolved_reasons']
    corrected = store.revise(event['record_id'], event['version'], {'raw_text': '原创虚构：我咳嗽三天，其他不确定。',
        'source_kind': 'audio_transcript', 'actor_name': '虚构讲述者', 'reason': '本人免费纠正虚构文本'}, '虚构讲述者')
    assert store.get(event['record_id'])['raw_text'] == candidate
    handoff = store.handoff()['items']
    assert len(handoff) == 1 and handoff[0]['record_id'] == corrected['record_id']
    assert handoff[0]['supersedes_id'] == event['record_id'] and handoff[0]['source_kind'] == 'audio_transcript'
    assert 'record_not_confirmed' in handoff[0]['unresolved_reasons']
    assert len(calls) == 1
