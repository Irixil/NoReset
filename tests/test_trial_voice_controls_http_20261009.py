"""New control-path HTTP integration; all supplier responses/contracts are invented.

Only loopback sockets are allowed. Real authorization/ledger files and user keys
are never loaded or amended. These are not ASR/model-quality acceptance tests.
"""
import io
import ipaddress
import json
import socket
import sqlite3
import struct
import urllib.request
import wave

import pytest

from backend import conversation, model_client, recognition, trial_gate
from backend import text_trial
from tests.http_support import HttpClient, running_http_server
from tests import test_memory_trial_gate_20261010 as memory_gate_fixtures
from tests.test_trial_append_20261009 import history
from tests.test_trial_gate import digest


ASR_TEXT = '完全虚构。离线语音保护测试记录甲。'
TURN_BODY = {'turns': [{'turn_id': 'turn_synthetic_control01', 'text': ASR_TEXT, 'version': 1}]}


def synthetic_wav():
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(16000)
        stream.writeframes(struct.pack('<h', 100) * 1600)
    return buffer.getvalue()


def media_body(audio):
    boundary = 'synthetic-control-boundary'
    parts = []
    for name, value in {'kind': 'audio', 'content_type': 'audio/wav', 'attempt_id': 'synthetic_media_attempt'}.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts += [f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode(), audio,
              f'\r\n--{boundary}--\r\n'.encode()]
    return b''.join(parts), 'multipart/form-data; boundary=' + boundary


def llm_wire():
    # Reuse the existing offline native preview. Key order matters to the exact
    # wire hash, even when two JSON objects have the same semantic contents.
    from scripts.run_text_trial import prepare_job, encoded
    preview = prepare_job({'job_id': 'synthetic_voice_controls', 'engine': 'conversation', 'native_input': TURN_BODY})
    return encoded(preview['wire_body']), preview['profile']['source_sha256']


@pytest.fixture
def local_server(monkeypatch, request):
    # Import server only after choosing local_first; it must not create a shadow
    # records database in the workspace at module import.
    monkeypatch.setenv('APP_MODE', 'local_first')
    monkeypatch.setenv('APP_AUTO_BIND_LOOPBACK', 'true')
    monkeypatch.setenv('APP_SESSION_SECRET', 'offline-control-session-secret-0123456789')
    monkeypatch.setenv('APP_OWNER_PASSWORD', 'offline-test-password-only')
    monkeypatch.setenv('APP_COOKIE_SECURE', 'false')
    monkeypatch.setenv('ALLOWED_ORIGIN', 'http://127.0.0.1:5173')
    monkeypatch.setenv('MODEL_PROVIDER', 'deepseek')
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'invented-key-no-account')
    monkeypatch.setenv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com')
    monkeypatch.setenv('DEEPSEEK_MODEL', 'deepseek-flash')
    monkeypatch.setenv('MODEL_MAX_TOKENS', '2048')
    monkeypatch.setenv('LLM_JSON_MODE', 'true')
    monkeypatch.setenv('LLM_EXTRA_BODY_JSON', '{"thinking":{"type":"disabled"}}')
    monkeypatch.setenv('MEDIA_ASR_PROVIDER', 'aihubmix')
    monkeypatch.setenv('MEDIA_ASR_API_KEY', 'invented-key-no-account')
    monkeypatch.setenv('AIHUBMIX_API_KEY', 'invented-key-no-account')
    monkeypatch.setenv('MEDIA_ASR_MODEL', 'gemini-2.5-flash-lite')
    monkeypatch.setenv('MEDIA_ASR_URL', 'https://aihubmix.com/gemini/v1beta/models/gemini-2.5-flash-lite:generateContent')
    from backend import server
    server.AI_REQUEST_LIMITER = server.AIRequestLimiter()
    actual = socket.create_connection
    def only_loopback(address, *args, **kwargs):
        assert ipaddress.ip_address(address[0]).is_loopback, 'external network forbidden'
        return actual(address, *args, **kwargs)
    monkeypatch.setattr(socket, 'create_connection', only_loopback)
    handler = server.ProductHandler if getattr(request, 'param', None) == 'product' else server.Handler
    with running_http_server(handler) as url:
        client = HttpClient(url, {'Content-Type': 'application/json', 'Origin': 'http://127.0.0.1:5173'})
        session = client.request('GET', '/api/app/session')
        assert session.status == 200 and session.body['authenticated']
        client.default_headers.update(Cookie=session.headers['Set-Cookie'].split(';', 1)[0], **{'X-CSRF-Token': session.body['csrf_token']})
        yield client


def test_http_missing_new_authorization_opens_no_supplier(monkeypatch, tmp_path, local_server):
    capabilities = local_server.request('GET', '/api/app/config')
    assert capabilities.status == 200
    assert capabilities.body['asr_trial'] is None
    assert capabilities.body['capabilities']['text_ai']['available'] is False
    assert capabilities.body['capabilities']['text_ai']['execution_restricted'] is True
    meter = trial_gate.TrialGate(tmp_path / 'missing.json', tmp_path / 'missing.sqlite3')
    monkeypatch.setattr(trial_gate, 'TrialGate', lambda: meter)
    def forbidden(*_):
        pytest.fail('supplier opener must never be built')
    monkeypatch.setattr(model_client.urllib.request, 'build_opener', forbidden)
    response = local_server.request('POST', '/api/ai/conversation-turn', TURN_BODY)
    assert response.status == 422 and response.body['ai_failed']
    assert not meter.state_path.exists()


@pytest.mark.parametrize('local_server', ['product'], indirect=True)
def test_http_current_text_grant_requires_header_and_sends_only_exact_memory_wire(
        monkeypatch, tmp_path, local_server):
    from tests.test_text_trial import install_current_memory_grant
    from tests.test_conversation import model_draft

    f = install_current_memory_grant(tmp_path, monkeypatch)
    config = local_server.request('GET', '/api/app/config')
    assert config.status == 200
    assert config.body['text_trial'] == text_trial.available_grant()
    assert config.body['text_trial']['remaining_requests'] == 1
    options = local_server.request('OPTIONS', '/api/ai/conversation-turn')
    assert 'X-NoReset-Text-Trial' in options.headers['Access-Control-Allow-Headers']

    opened = []
    class Response(io.BytesIO):
        status = 200
        headers = {'Content-Type': 'application/json'}
    class Supplier:
        def open(self, request, timeout):
            opened.append(request.data)
            assert request.data == f['wire']
            draft = model_draft(f['body']['turns'])
            envelope = {'id': 'synthetic-text-trial', 'model': 'deepseek-flash',
                'usage': {'prompt_tokens': 200, 'completion_tokens': 60,
                          'completion_tokens_details': {'reasoning_tokens': 0}},
                'choices': [{'finish_reason': 'stop', 'message': {'role': 'assistant',
                    'content': json.dumps(draft, ensure_ascii=False)}}]}
            return Response(json.dumps(envelope, ensure_ascii=False).encode())

    monkeypatch.setattr(model_client.urllib.request, 'build_opener', lambda *_: Supplier())
    missing = local_server.request('POST', '/api/ai/conversation-turn', f['body'])
    assert missing.status == 422 and opened == []
    assert not list(f['scope'].glob('claim-*.json'))

    sent = local_server.request('POST', '/api/ai/conversation-turn', f['body'],
        headers={'X-NoReset-Text-Trial': f['grant_id']})
    assert sent.status == 200 and not sent.body.get('ai_failed')
    assert opened == [f['wire']]
    retry = local_server.request('POST', '/api/ai/conversation-turn', f['body'],
        headers={'X-NoReset-Text-Trial': f['grant_id']})
    assert retry.status == 422 and len(opened) == 1
    with sqlite3.connect(f['state_path']) as db:
        assert db.execute('SELECT COUNT(*) FROM attempts').fetchone()[0] == 1


@pytest.mark.parametrize('local_server', ['product'], indirect=True)
def test_http_current_text_wire_mismatch_is_stopped_before_supplier_and_not_retried(
        monkeypatch, tmp_path, local_server):
    from tests.test_text_trial import install_current_memory_grant

    f = install_current_memory_grant(tmp_path, monkeypatch)
    monkeypatch.setenv('LLM_EXTRA_BODY_JSON', '{"thinking":{"type":"disabled"},"seed":123}')
    opened = []
    monkeypatch.setattr(model_client.urllib.request, 'build_opener', lambda *_: opened.append('opened'))
    denied = local_server.request('POST', '/api/ai/conversation-turn', f['body'],
        headers={'X-NoReset-Text-Trial': f['grant_id']})
    assert denied.status == 422 and opened == []
    # A failed/unknown attempt is occupied; changing config cannot replay it.
    monkeypatch.setenv('LLM_EXTRA_BODY_JSON', '{"thinking":{"type":"disabled"}}')
    retry = local_server.request('POST', '/api/ai/conversation-turn', f['body'],
        headers={'X-NoReset-Text-Trial': f['grant_id']})
    assert retry.status == 422 and opened == []
    with sqlite3.connect(f['state_path']) as db:
        assert db.execute('SELECT COUNT(*) FROM attempts').fetchone()[0] == 0


@pytest.mark.parametrize('local_server', ['product'], indirect=True)
def test_trusted_product_handler_allows_fake_model_request_and_reports_policy(monkeypatch, local_server):
    from backend import server

    assert server.Handler.product_execution_enabled is False
    assert server.ProductHandler.product_execution_enabled is True
    config = local_server.request('GET', '/api/app/config')
    assert config.status == 200
    assert config.body['capabilities']['text_ai']['available'] is True
    assert config.body['capabilities']['text_ai']['connection_state'] == 'unverified'
    assert config.body['capabilities']['text_ai']['execution_restricted'] is False

    assessment = conversation._mock_assessment(TURN_BODY['turns'], conversation._controller_state({}))
    raw = json.dumps({'id': 'synthetic-product-response', 'model': 'deepseek-flash',
        'usage': {'prompt_tokens': 2, 'completion_tokens': 3, 'total_tokens': 5,
                  'completion_tokens_details': {'reasoning_tokens': 0}},
        'choices': [{'finish_reason': 'stop', 'message': {'role': 'assistant',
            'content': json.dumps(assessment, ensure_ascii=False)}}]}, ensure_ascii=False).encode()
    calls = []

    class Response:
        status = 200
        headers = {}
        def read(self, limit): return raw[:limit]
        def __enter__(self): return self
        def __exit__(self, *_): return False

    class FakeSupplier:
        def open(self, request, **_):
            calls.append(request.full_url)
            return Response()

    monkeypatch.setattr(model_client.urllib.request, 'build_opener', lambda *_: FakeSupplier())
    response = local_server.request('POST', '/api/ai/conversation-turn', TURN_BODY)
    assert response.status == 200 and not response.body.get('ai_failed')
    assert calls == ['https://api.deepseek.com/chat/completions']


@pytest.mark.parametrize('scenario', ['unused_asr', 'expired', 'closed', 'used', 'llm_only', 'no_scope'])
@pytest.mark.parametrize('local_server', ['product'], indirect=True)
def test_app_config_reports_only_a_current_unused_single_asr_grant(
        monkeypatch, tmp_path, local_server, scenario):
    from backend import server

    monkeypatch.setattr(memory_gate_fixtures.budget, 'CLAIM_ROOT', tmp_path / 'claims')
    monkeypatch.setattr(trial_gate, 'ROOT', tmp_path)
    monkeypatch.setattr(trial_gate, 'CONTINUATION_CLAIM_ROOT', tmp_path / 'runtime')
    fixture = None
    if scenario == 'llm_only':
        fixture = memory_gate_fixtures.proposed(tmp_path, monkeypatch)
    elif scenario != 'no_scope':
        fixture = memory_gate_fixtures.proposed_long_asr(tmp_path, monkeypatch)
    if fixture is not None:
        memory_gate_fixtures.activate(fixture)
        if scenario == 'closed':
            trial_gate.close_trial_scope(receipt_path=fixture['receipt_path'], state_path=fixture['state_path'])
        elif scenario == 'used':
            memory_gate_fixtures.reserve_long_asr(fixture)
        elif scenario == 'expired':
            from datetime import datetime, timedelta

            class ExpiredDateTime(datetime):
                @classmethod
                def now(cls, tz=None):
                    return super().now(tz) + timedelta(hours=2)

            monkeypatch.setattr(trial_gate, 'datetime', ExpiredDateTime)
        monkeypatch.setattr(server.ProductHandler, '_provider_execution_scope', lambda _self: (
            trial_gate.standalone_trial_scope(receipt_path=fixture['receipt_path'], state_path=fixture['state_path'])))

    before = None
    if fixture is not None:
        before = memory_gate_fixtures.budget.native_root_binding(
            fixture['descriptor'], receipt_id=fixture['receipt']['receipt_id'], include_scope=True)
    response = local_server.request('GET', '/api/app/config')
    assert response.status == 200
    summary = response.body['asr_trial']
    if scenario == 'unused_asr':
        assert set(summary) == {
            'receipt_id', 'receipt_sha256', 'expires_at', 'source_sha256', 'remaining_requests', 'kind'}
        assert summary == {
            'receipt_id': fixture['receipt']['receipt_id'],
            'receipt_sha256': digest(fixture['receipt_path'].read_bytes()),
            'expires_at': fixture['receipt']['expires_at'],
            'source_sha256': fixture['receipt']['profiles']['asr']['source_sha256'],
            'remaining_requests': 1,
            'kind': 'asr',
        }
    else:
        assert summary is None
    if fixture is not None and scenario not in {'expired', 'closed'}:
        after = memory_gate_fixtures.budget.native_root_binding(
            fixture['descriptor'], receipt_id=fixture['receipt']['receipt_id'], include_scope=True)
        assert after['allocations'] == before['allocations']


@pytest.mark.parametrize('clinical_failure', ['schema', 'unsafe'])
def test_http_asr_then_business_failure_share_durable_gate(monkeypatch, tmp_path, local_server, clinical_failure):
    meter, old, old_rows, new = history.__wrapped__(tmp_path)
    audio = synthetic_wav()
    provider = recognition._OpenAICompatibleProvider(recognition._ProviderConfig(
        'aihubmix', new['profiles']['asr']['url'], 'gemini-2.5-flash-lite', 'invented-key-no-account', 1, 2048))
    asr_wire = provider._audio_request(audio, 'audio/wav', 'synthetic.wav').data
    text_wire, text_source = llm_wire()
    new['profiles']['asr'].update(source_sha256=[digest(audio)], request_sha256=[digest(asr_wire)])
    new['profiles']['llm'].update(source_sha256=[text_source], request_sha256=[digest(text_wire)])
    new['profiles']['llm']['url'] = 'https://api.deepseek.com/chat/completions'
    meter.receipt_path.write_text(json.dumps(new))
    trial_gate.append_trial(meter.receipt_path, meter.state_path)
    monkeypatch.setattr(trial_gate, 'TrialGate', lambda: meter)
    sends = []
    assessment = conversation._mock_assessment(TURN_BODY['turns'], conversation._controller_state({}))
    assessment['reply_text'] = '建议服用阿莫西林。'  # invented unsafe fixture, never shown as advice
    model_content = '{}' if clinical_failure == 'schema' else json.dumps(assessment, ensure_ascii=False)
    class Response:
        status = 200
        headers = {}
        def __init__(self, body): self.raw = json.dumps(body).encode()
        def read(self, limit): return self.raw[:limit]
        def __enter__(self): return self
        def __exit__(self, *_): return False
    class OfflineSupplier:
        def open(self, request, **_):
            # An actual committed reservation must exist before this fake seam.
            with sqlite3.connect(meter.state_path) as db:
                assert db.execute('SELECT COUNT(*) FROM attempts').fetchone()[0] == 4 + len(sends)
            sends.append(request.full_url)
            assert 'invented-key-no-account' not in request.data.decode()
            if ':generateContent' in request.full_url:
                return Response({'responseId': 'synthetic_asr_same_request', 'modelVersion': 'gemini-2.5-flash-lite',
                    'usageMetadata': {'promptTokenCount': 220, 'candidatesTokenCount': 7, 'thoughtsTokenCount': 0, 'totalTokenCount': 227},
                    'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': ASR_TEXT}]}}]})
            assert request.data == text_wire
            return Response({'id': 'synthetic_llm_same_request', 'model': 'deepseek-flash',
                'usage': {'prompt_tokens': 12, 'completion_tokens': 3, 'completion_tokens_details': {'reasoning_tokens': 0}},
                # Both a schema error and a 200 safety fallback must freeze the
                # ledger, even after transport usage was verified successfully.
                'choices': [{'finish_reason': 'stop', 'message': {'content': model_content}}]})
    monkeypatch.setattr(model_client.urllib.request, 'build_opener', lambda *_: OfflineSupplier())
    raw, content_type = media_body(audio)
    first = local_server.request('POST', '/api/ai/media/recognize', raw_body=raw, headers={'Content-Type': content_type})
    assert first.status == 200 and first.body['recognition']['text'] == ASR_TEXT
    assert first.body['trial_control'] == {'review_required': True}
    assert len(sends) == 1  # recognition itself must not auto-call LLM
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT * FROM attempts WHERE id<=3 ORDER BY id').fetchall() == old_rows
        assert json.loads(db.execute('SELECT usage_json FROM attempts WHERE id=4').fetchone()[0])['verified']
    second = local_server.request('POST', '/api/ai/conversation-turn', TURN_BODY)
    assert second.status == (422 if clinical_failure == 'schema' else 200)
    assert second.body['trial_control']['stopped'] is True
    if clinical_failure == 'unsafe':
        assert second.body['stop_reason'] == 'model_output_blocked'
    assert len(sends) == 2
    with sqlite3.connect(meter.state_path) as db:
        reserved = db.execute('SELECT SUM(reserved_nano_usd) FROM attempts').fetchone()[0]
        assert db.execute('SELECT frozen_reason FROM metadata').fetchone()[0]
        assert json.loads(db.execute('SELECT usage_json FROM attempts WHERE id=5').fetchone()[0])['verified']
    for path, body in [('/api/ai/conversation-turn', TURN_BODY), ('/api/ai/media/recognize', None)]:
        response = local_server.request('POST', path, body, raw_body=raw if body is None else None,
            headers={'Content-Type': content_type} if body is None else None)
        assert response.status >= 400
    assert len(sends) == 2
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT SUM(reserved_nano_usd) FROM attempts').fetchone()[0] == reserved
        assert db.execute('SELECT * FROM attempts WHERE id<=3 ORDER BY id').fetchall() == old_rows
