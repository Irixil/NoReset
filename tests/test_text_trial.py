"""Native single-call trial preparation and failure evidence, with fake transport."""
from copy import deepcopy
from io import BytesIO
import json
from types import SimpleNamespace
import urllib.error

import pytest

from backend import adapter, conversation, model_client, trial_gate
from scripts import run_text_trial as runner


@pytest.fixture
def prepared():
    return [runner.prepare_job(job) for job in runner.authored_jobs()]


def document_output(prepared):
    payload = prepared['native_input']
    return {'schema_version': adapter.SCHEMA_VERSION, 'event_kind': 'document',
            'summary': payload['raw_text'],
            'time': {'occurred': None, 'recorded': payload['recorded_at'], 'certainty': 'unknown'},
            'claims': [{'text': payload['raw_text'], 'quote': payload['raw_text'],
                        'record_id': payload['record_id'], 'source_kind': 'document'}],
            'review_required': True, 'review_role': 'family', 'escalation_level': 'none',
            'conflict': {'present': False, 'record_refs': []}, 'provenance_preserved': True,
            'plan_change_allowed': False, 'follow_up_questions': []}


def dialogue_output(prepared, reply='我会保留您说的原话，方便之后核对。'):
    state = {category: {'status': 'missing', 'summary': '', 'evidence_turn_ids': [], 'context_ids': []}
             for category in conversation.CATEGORIES}
    state['main_complaint'] = {'status': 'known', 'summary': '咳嗽',
                               'evidence_turn_ids': ['turn_texttrial_patient01'], 'context_ids': []}
    return {'user_intent': 'health_fact', 'latest_turn_adds_fact': True,
            'reply_text': reply, 'suggested_action': 'finish', 'question_category': None,
            'question_importance': None, 'candidate_question': '', 'clinical_state': state,
            'relevant_context_ids': [], 'unknowns': [], 'contradictions': [], 'risk_candidates': []}


@pytest.fixture
def fake_execution(monkeypatch, prepared):
    """No actual authorization, real credentials, HTTP or production ledger."""
    state = SimpleNamespace(rows=[], opens=0, reports=0, config_reads=0, frozen=False,
                            content=document_output(prepared[2]), finish='stop', model=runner.MODEL,
                            usage={'prompt_tokens': 200, 'completion_tokens': 100,
                                   'completion_tokens_details': {'reasoning_tokens': 0}}, http_error=None)
    hashes = [item['profile'] for item in prepared]
    authority = {'receipt_sha256': 'a' * 64, 'remaining_requests': 3, 'remaining_usd': '1',
                 'receipt': {'profiles': {'llm': {'provider': 'deepseek', 'model': runner.MODEL,
                   'url': runner.URL, 'requests': 3, 'max_input_bytes': runner.MAX_WIRE,
                   'max_output_tokens': 2048, 'max_thinking_tokens': 0, 'billing': {'status': 'verified'},
                   'source_sha256': [item['source_sha256'] for item in hashes],
                   'request_sha256': [item['request_sha256'] for item in hashes]}}}}
    monkeypatch.setattr(trial_gate, 'validate_trial_authorization', lambda: deepcopy(authority))
    monkeypatch.setattr(trial_gate, 'trial_journal', lambda: deepcopy(state.rows))

    def config():
        state.config_reads += 1
        return adapter.Config(provider='deepseek', token='synthetic-secret-must-not-be-saved')
    monkeypatch.setattr(adapter.Config, 'from_env', config)

    def opener(request, timeout):
        state.opens += 1
        assert state.opens == 1
        profile = request._noreset_trial_profile
        request._noreset_trial_attempt_id = 1
        state.rows.append({'id': 1, 'kind': 'llm', 'request_sha256': runner.digest(request.data),
                           'source_sha256': profile['source_sha256'], 'usage': None,
                           'reserved_usd': '0.3170304'})
        if state.http_error:
            raise state.http_error
        envelope = {'model': state.model, 'usage': state.usage,
                    'headers': {'Authorization': 'synthetic-secret-must-not-be-saved'},
                    'choices': [{'finish_reason': state.finish,
                                 'message': {'role': 'assistant', 'content': json.dumps(state.content, ensure_ascii=False)}}]}
        return runner.BufferedResponse(runner.encoded(envelope), 200, 'application/json')
    monkeypatch.setattr(model_client, '_open_request', opener)

    def usage(attempt_id, returned_model, metadata):
        state.reports += 1
        if returned_model != runner.MODEL or not isinstance(metadata, dict):
            state.frozen = True
            raise trial_gate.TrialGateError()
        normalized = {'returned_model': returned_model, 'prompt_tokens': metadata['prompt_tokens'],
                      'completion_tokens': metadata['completion_tokens'], 'reasoning_tokens': 0, 'verified': True}
        state.rows[0]['usage'] = normalized
        return normalized
    monkeypatch.setattr(trial_gate, 'report_usage', usage)
    return state


def test_prepare_without_environment_client_or_network(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('prepare touched configuration/client/network')
    monkeypatch.setattr(adapter.Config, 'from_env', forbidden)
    monkeypatch.setattr(model_client.ChatCompletionsClient, '__init__', forbidden)
    monkeypatch.setattr(model_client, '_open_request', forbidden)
    previews = runner.prepare_all(tmp_path)
    assert len(previews) == 3
    for preview in previews:
        wire = (tmp_path / (preview['job_id'] + '.wire.json')).read_bytes()
        assert runner.digest(wire) == preview['profile']['request_sha256']
        assert preview['profile']['wire_bytes'] == len(wire) <= 24000
        assert preview['wire_body']['thinking'] == {'type': 'disabled'}
        assert preview['wire_body']['max_tokens'] == 2048
        assert preview['profile']['url'] == 'https://api.deepseek.com/chat/completions'
        assert preview['real_requests_executed'] == 0


def test_native_sources_preserve_old_duration_correction_version_and_authored_document(prepared):
    first = prepared[0]['model_payload']['turns'][0]
    old, corrected = prepared[1]['model_payload']['turns']
    assert first == old
    assert '两天' in old['text'] and old['version'] == 1
    assert '不是两天，是三天' in corrected['text'] and corrected['version'] == 2
    assert all('responding_to' not in row for row in (old, corrected))
    document = prepared[2]['model_payload']
    assert document['source_kind'] == 'document'
    assert document['source_review']['text'] == document['raw_text']
    assert document['occurred_time'] is None
    assert document['recorded_at'] == '2026-10-08T12:00:00Z'
    assert '未执行 OCR' in prepared[2]['source_note']


def test_missing_receipt_saves_input_before_any_credential_read(prepared, tmp_path, monkeypatch):
    def deny():
        assert (tmp_path / 'dialogue1.input.json').is_file()
        raise trial_gate.TrialGateError()
    def forbidden():
        raise AssertionError('credential/config read before authorization')
    monkeypatch.setattr(trial_gate, 'validate_trial_authorization', deny)
    monkeypatch.setattr(adapter.Config, 'from_env', forbidden)
    result = runner.execute_one(prepared[0], tmp_path)
    assert result['status'] == 'failed' and result['real_requests_executed'] == 0
    assert result['failure']['code'] == 'trial_authorization_required'


@pytest.mark.parametrize('kind', ['document', 'dialogue'])
def test_one_native_request_uses_exact_preview_and_remains_pending(prepared, fake_execution, tmp_path, kind):
    item = prepared[2] if kind == 'document' else prepared[0]
    fake_execution.content = document_output(item) if kind == 'document' else dialogue_output(item)
    result = runner.execute_one(item, tmp_path)
    assert result['status'] == 'validated_pending_manual_review'
    assert fake_execution.opens == fake_execution.reports == fake_execution.config_reads == 1
    assert result['attempt_journal']['request_sha256'] == item['profile']['request_sha256']
    assert result['planned_text_requests'] == 3 and result['real_requests_executed'] == 1
    assert result['semantic_review_status'] == result['clinical_review_status'] == 'pending'
    assert result['retry_performed'] is False
    for path in tmp_path.glob('*.json'):
        assert 'synthetic-secret-must-not-be-saved' not in path.read_text()
        assert 'Authorization' not in path.read_text()


def test_native_validation_failure_retains_response_and_counts_no_retry(prepared, fake_execution, tmp_path):
    fake_execution.content = {'not_native_schema': True}
    result = runner.execute_one(prepared[0], tmp_path)
    assert result['status'] == 'failed'
    assert result['failure']['code'] == 'model_schema_invalid'
    assert fake_execution.opens == fake_execution.reports == 1
    artifact = json.loads((tmp_path / 'dialogue1.response.json').read_text())
    assert json.loads(artifact['choices'][0]['content']) == {'not_native_schema': True}
    assert result['meter_usage']['verified'] is True  # Usage is separate from product quality.
    assert result['real_requests_executed'] == 1 and result['retry_performed'] is False


def test_native_blocked_reply_is_quality_failure_even_when_engine_returns_ok(prepared, fake_execution, tmp_path):
    fake_execution.content = dialogue_output(prepared[0], '可以自行加倍服药。')
    result = runner.execute_one(prepared[0], tmp_path)
    assert result['status'] == 'failed' and result['failure']['code'] == 'model_reply_unsafe'
    assert fake_execution.opens == fake_execution.reports == 1
    assert '自行加倍服药' in (tmp_path / 'dialogue1.response.json').read_text()


def test_truncation_retains_completion_content_and_consumes_one_attempt(prepared, fake_execution, tmp_path):
    fake_execution.finish = 'length'
    result = runner.execute_one(prepared[2], tmp_path)
    assert result['status'] == 'failed' and result['failure']['code'] == 'model_output_truncated'
    assert result['real_requests_executed'] == 1 and fake_execution.opens == 1
    artifact = json.loads((tmp_path / 'documentorganize3.response.json').read_text())
    assert artifact['choices'][0]['finish_reason'] == 'length'


def test_http_error_never_saves_body_and_unknown_usage_freezes(prepared, fake_execution, tmp_path):
    fake_execution.http_error = urllib.error.HTTPError(runner.URL, 401, 'unauthorized', {},
                              BytesIO(b'Authorization: synthetic-secret-must-not-be-saved'))
    result = runner.execute_one(prepared[2], tmp_path)
    assert result['status'] == 'failed' and result['failure']['code'] == 'model_http_error'
    assert fake_execution.opens == fake_execution.reports == 1 and fake_execution.frozen
    assert not (tmp_path / 'documentorganize3.response.json').exists()
    assert 'synthetic-secret' not in (tmp_path / 'documentorganize3.result.json').read_text()


def test_changed_preview_is_rejected_before_configuration(prepared, fake_execution, tmp_path):
    prepared[0]['wire_body']['max_tokens'] = 4096
    result = runner.execute_one(prepared[0], tmp_path)
    assert result['status'] == 'failed' and result['real_requests_executed'] == 0
    assert fake_execution.config_reads == fake_execution.opens == 0


def test_inflight_attempt_is_rejected_before_configuration(prepared, fake_execution, tmp_path):
    fake_execution.rows.append({'id': 9, 'kind': 'llm', 'usage': None})
    result = runner.execute_one(prepared[0], tmp_path)
    assert result['status'] == 'failed'
    assert fake_execution.config_reads == fake_execution.opens == 0


def test_execute_cli_requires_a_single_selected_job(tmp_path, monkeypatch):
    monkeypatch.setattr(adapter.Config, 'from_env', lambda: pytest.fail('no selected job may read Key'))
    with pytest.raises(SystemExit) as rejected:
        runner.main(['--mode', 'execute', '--out-dir', str(tmp_path)])
    assert rejected.value.code == 2
