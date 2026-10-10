"""Offline transport controls: synthetic bodies, fake opener, no real ledger/key."""
import io
import contextvars
import json
import urllib.error
from types import SimpleNamespace

import pytest

from backend import model_client, recognition, trial_gate


class Response:
    status = 200
    headers = {'Content-Type': 'application/json'}
    def __init__(self, body):
        self.raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    def read(self, limit): return self.raw[:limit]
    def __enter__(self): return self
    def __exit__(self, *_): return False


@pytest.fixture
def meter(monkeypatch):
    state = SimpleNamespace(attempts=[], reports=[], stops=[], sends=[], frozen=False, body=None, failure=None)
    class Gate:
        state_path = 'synthetic-fake-ledger-no-file'
        def reserve(self, **kwargs):
            if state.frozen: raise trial_gate.TrialGateError()
            if kwargs['output_tokens'] > (1024 if kwargs['kind'] == 'asr' else 2048):
                raise trial_gate.TrialGateError()
            state.attempts.append(kwargs)
            return len(state.attempts)
    def report(attempt, model, usage, **kwargs):
        state.reports.append((attempt, model, usage, kwargs))
        if model not in {'deepseek-flash', 'gemini-2.5-flash-lite'} or not isinstance(usage, dict):
            state.frozen = True
            raise trial_gate.TrialGateError()
        return {'verified': True}
    def stop(attempt, reason, **kwargs):
        state.stops.append((attempt, reason))
        state.frozen = True
    class Opener:
        def open(self, request, **kwargs):
            state.sends.append(request)
            if state.failure: raise state.failure
            return Response(state.body)
    monkeypatch.setattr(trial_gate, 'TrialGate', Gate)
    monkeypatch.setattr(trial_gate, 'report_usage', report)
    monkeypatch.setattr(trial_gate, 'stop_trial', stop, raising=False)
    monkeypatch.setattr(model_client.urllib.request, 'build_opener', lambda *_: Opener())
    model_client.reset_trial_context()
    return state


def llm_body(**changes):
    result = {'id': 'synthetic_trace_1', 'model': 'deepseek-flash',
        'usage': {'prompt_tokens': 12, 'completion_tokens': 3,
                  'completion_tokens_details': {'reasoning_tokens': 0}},
        'choices': [{'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': '{"ok":true}'}}]}
    result.update(changes)
    return result


def llm():
    return model_client.ChatCompletionsClient(base_url='https://api.deepseek.com', model='deepseek-flash',
        api_key='synthetic-secret-never-save', max_tokens=2048, trial_provider='deepseek',
        extra_body={'thinking': {'type': 'disabled'}})


def gemini_body():
    return {'responseId': 'synthetic_gemini_trace', 'modelVersion': 'gemini-2.5-flash-lite',
        'usageMetadata': {'promptTokenCount': 220, 'candidatesTokenCount': 7,
                          'thoughtsTokenCount': 0, 'totalTokenCount': 227},
        'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': '原创合成转写'}]}}]}


def asr_request():
    provider = recognition._OpenAICompatibleProvider(recognition._ProviderConfig('aihubmix',
        'https://aihubmix.com/gemini/v1beta/models/gemini-2.5-flash-lite:generateContent',
        'gemini-2.5-flash-lite', 'synthetic-secret-never-save', 1, 2048))
    request = provider._audio_request(b'original synthetic audio bytes', 'audio/wav', 'synthetic.wav')
    request._noreset_trial_profile = {'kind': 'asr', 'provider': 'aihubmix', 'model': 'gemini-2.5-flash-lite',
                                    'source_sha256': 'a'*64}
    return provider, request


def test_llm_reports_same_response_and_attempt_once(meter):
    meter.body = llm_body()
    assert llm().complete_json('synthetic prompt', {'synthetic': True}) == {'ok': True}
    assert len(meter.sends) == len(meter.attempts) == len(meter.reports) == 1
    attempt, model, usage, kwargs = meter.reports[0]
    assert attempt == 1 and model == 'deepseek-flash' and usage['prompt_tokens'] == 12
    metadata = kwargs['transport_metadata']
    assert set(metadata) <= {'trace_id', 'response_sha256', 'response_bytes', 'protocol'}
    assert metadata['trace_id'] == 'synthetic_trace_1'
    assert kwargs['state_path'] == 'synthetic-fake-ledger-no-file'
    assert 'synthetic-secret-never-save' not in json.dumps(metadata)


def test_asr_reports_full_usage_and_internal_review_marker(meter):
    meter.body = gemini_body()
    provider, request = asr_request()
    assert provider._send(request) == '原创合成转写'
    assert provider.trial_control == {'review_required': True}
    assert meter.reports[0][2] == {'prompt_tokens': 220, 'completion_tokens': 7,
                                 'completion_tokens_details': {'reasoning_tokens': 0}}
    assert len(meter.sends) == 1 and not meter.stops


@pytest.mark.parametrize('mutation', [
    lambda b: (b['usageMetadata'].pop('thoughtsTokenCount'), b['usageMetadata'].update(totalTokenCount=999)),
    lambda b: b['usageMetadata'].update(promptTokenCount=True),
    lambda b: b['usageMetadata'].update(totalTokenCount=999),
    lambda b: b.pop('modelVersion'),
    lambda b: b.update(modelVersion='unknown-model'),
    lambda b: b['usageMetadata'].update(toolUsePromptTokenCount=1),
    lambda b: b['candidates'][0].update(finishReason='MAX_TOKENS'),
])
def test_asr_invalid_or_missing_usage_stops_without_followup(meter, mutation):
    meter.body = gemini_body(); mutation(meter.body)
    provider, request = asr_request()
    with pytest.raises(recognition.RecognitionError): provider._send(request)
    assert meter.frozen and meter.stops and len(meter.sends) == 1
    provider, request = asr_request()
    with pytest.raises(recognition.RecognitionError): provider._send(request)
    assert len(meter.sends) == 1


@pytest.mark.parametrize('body,failure', [
    (None, TimeoutError('synthetic-secret-never-save')),
    (b'{broken', None),
    (llm_body(usage=None), None),
    (llm_body(model='unknown-model'), None),
    (llm_body(choices=[{'finish_reason': 'length'}]), None),
    (llm_body(choices=[{'finish_reason': 'stop', 'message': {'content': 'invalid business JSON'}}]), None),
])
def test_llm_failure_stops_after_one_attempt_and_preserves_safe_error(meter, body, failure):
    meter.body, meter.failure = body, failure
    with pytest.raises(model_client.ModelClientError) as error:
        llm().complete_json('synthetic', {'synthetic': True})
    assert 'synthetic-secret-never-save' not in str(error.value)
    assert meter.frozen and meter.stops and len(meter.sends) == 1
    with pytest.raises(model_client.ModelClientError): llm().complete_json('synthetic', {'synthetic': True})
    assert len(meter.sends) == 1


def test_trial_context_resets_between_business_requests(meter):
    meter.body = llm_body()
    llm().complete_json('synthetic', {})
    assert model_client.trial_control() == {'review_required': True}
    model_client.stop_current_trial('business_validation_failed')
    assert model_client.trial_control(stopped=True) == {'review_required': True, 'stopped': True}
    model_client.reset_trial_context()
    assert model_client.trial_control(stopped=True) == {}


def test_request_over_output_cap_never_opens_or_reserves(meter):
    meter.body = llm_body()
    client = llm(); client.max_tokens = 2049
    with pytest.raises(model_client.ModelClientError): client.complete_json('synthetic', {})
    assert not meter.sends and not meter.attempts and not meter.stops


def test_oversized_response_stops_after_bounded_read(meter):
    meter.body = b'x' * (model_client.MAX_RESPONSE_BYTES + 20)
    with pytest.raises(model_client.ModelClientError) as error:
        llm().complete_json('synthetic', {})
    assert error.value.code == 'model_response_too_large'
    assert len(meter.sends) == 1 and meter.frozen


def test_http_error_body_and_key_are_not_read_or_captured(meter):
    class Guard(io.BytesIO):
        def read(self, *_): pytest.fail('remote error body was read')
    meter.failure = urllib.error.HTTPError('https://api.deepseek.com/chat/completions', 503,
        'synthetic-secret-never-save', {}, Guard(b'synthetic-secret-never-save'))
    with pytest.raises(model_client.ModelClientError) as error:
        llm().complete_json('synthetic', {})
    assert error.value.code == 'model_http_error'
    assert 'synthetic-secret-never-save' not in str(error.value)
    assert not meter.reports and meter.frozen and len(meter.sends) == 1


def test_secret_echo_trace_is_never_saved(meter):
    meter.body = llm_body(id='synthetic-secret-never-save')
    llm().complete_json('synthetic', {})
    assert 'trace_id' not in meter.reports[0][3]['transport_metadata']


def test_other_request_context_cannot_freeze_this_attempt(meter):
    meter.body = llm_body()
    llm().complete_json('synthetic', {})
    other = contextvars.copy_context()
    other.run(model_client.reset_trial_context)
    other.run(model_client.stop_current_trial, 'business_validation_failed')
    assert not meter.stops
    assert model_client.trial_control() == {'review_required': True}


def test_missing_asr_finish_is_rejected_after_same_usage_report(meter):
    meter.body = gemini_body()
    meter.body['candidates'][0].pop('finishReason')
    provider, request = asr_request()
    with pytest.raises(recognition.RecognitionError): provider._send(request)
    assert len(meter.reports) == len(meter.sends) == 1 and meter.frozen


def test_unreserved_loopback_does_not_create_review_marker(meter):
    meter.body = gemini_body()
    provider, request = asr_request()
    request.full_url = 'http://127.0.0.1:9999/synthetic'
    meter.body['trial_control'] = {'review_required': True}
    assert provider._send(request) == '原创合成转写'
    assert not hasattr(provider, 'trial_control')
    assert not meter.reports and not meter.attempts


def test_server_business_failure_returns_only_trusted_stop_marker(meter, monkeypatch):
    monkeypatch.setenv('APP_MODE', 'local_first')
    from backend import server
    meter.body = llm_body()
    llm().complete_json('synthetic', {})
    assert server.trial_failure_control(ValueError('synthetic invalid business result')) == {
        'trial_control': {'review_required': True, 'stopped': True}}
    assert meter.frozen and meter.stops[-1] == (1, 'business_validation_failed')


def test_server_unreserved_gate_refusal_stops_client_without_freezing_history(meter, monkeypatch):
    monkeypatch.setenv('APP_MODE', 'local_first')
    from backend import server
    assert server.trial_failure_control(model_client.ModelClientError('safe', code='trial_authorization_required')) == {
        'trial_control': {'review_required': True, 'stopped': True}}
    assert not meter.stops and not meter.attempts
