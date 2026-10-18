"""Temporary invented approval + public HTTP; only the external provider is mocked."""
import io
import json
import importlib
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from backend import saved_audio_trial as audio, trial_gate as gate, trial_budget as budget, model_client
from tests.test_memory_trial_gate_20261010 import proposed, activate, save, sha
from tests.http_support import HttpClient, running_http_server
from scripts.run_text_trial import prepare_job, encoded
from tests.test_conversation import model_draft
from tests.test_trial_budget_20261009 import receipt_fixture


def _closed_asr_scope(f, tmp_path):
    """Create a synthetic native ASR attempt with verified usage, then close it."""
    import wave
    from backend import recognition
    from types import SimpleNamespace
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(b'\x01\x00' * 160)
    raw = stream.getvalue(); source_sha = sha(raw)
    config = SimpleNamespace(name='aihubmix', url=budget.URLS['asr'], model=budget.SERVICES['asr']['model'], api_key='synthetic-only')
    wire = recognition._OpenAICompatibleProvider(config)._audio_request(raw, 'audio/wav', 'source.wav').data
    receipt = receipt_fixture(f['descriptor'], ('asr',), 'prior-reviewed-asr-proof')
    receipt['total_requests'] = 1; receipt['planned_text_requests'] = 0
    receipt['previous_receipt_sha256'] = f['descriptor']['authorization_sha256']
    receipt['profiles']['asr']['source_sha256'] = [source_sha]
    receipt['profiles']['asr']['request_sha256'] = [sha(wire)]
    directory = tmp_path / 'prior-asr'; state = tmp_path / 'runtime/prior-asr/ledger.sqlite3'
    receipt_path, manifest_path = directory / 'authorization.json', directory / 'manifest.json'
    receipt_sha = save(receipt_path, receipt)
    audio_path, wire_path = directory / 'assets/source.wav', directory / 'assets/request.body'
    audio_path.parent.mkdir(parents=True); audio_path.write_bytes(raw); wire_path.write_bytes(wire)
    manifest = dict(f['manifest'], approval_ref=receipt['approval_ref'], purpose='long_term_health_memory',
        receipt_path=str(receipt_path), receipt_sha256=receipt_sha, state_path=str(state), budget_baseline=f['baseline'],
        request_pairs=[dict(audio_path=str(audio_path), source_sha256=source_sha, wire_path=str(wire_path), request_sha256=sha(wire))])
    manifest_sha = save(manifest_path, manifest)
    gate.initialize_standalone_trial(receipt_path=receipt_path, state_path=state, manifest_path=manifest_path, manifest_sha256=manifest_sha)
    profile = receipt['profiles']['asr']
    attempt = gate.TrialGate(receipt_path, state).reserve(kind='asr', provider=profile['provider'], model=profile['model'],
        url=profile['url'], wire=wire, source_sha256=source_sha, output_tokens=1024, thinking_tokens=0)
    gate.report_usage(attempt, profile['model'], {'prompt_tokens': 12, 'completion_tokens': 3,
        'completion_tokens_details': {'reasoning_tokens': 0}}, state_path=state,
        transport_metadata={'response_sha256': sha(b'synthetic-asr-response'), 'response_bytes': 32, 'protocol': 'gemini'})
    gate.close_trial_scope(receipt_path, state, 'owner_stop')
    # The following LLM scope is based on the now-current cumulative prefix.
    # Preserve the original fake audit for the ASR scope and derive a successor
    # projection for the LLM scope; no product/runtime files are touched.
    original_audit_path = tmp_path / 'historical-before-asr.json'
    original_audit_path.write_bytes(f['audit_path'].read_bytes())
    f['manifest']['historical_reference']['audit_path'] = str(original_audit_path)
    f['manifest']['historical_reference']['audit_sha256'] = sha(original_audit_path.read_bytes())
    f['manifest']['historical_reference']['reference_only'] = True
    new_baseline = budget.cumulative_row_seal(f['descriptor'])
    f['audit']['cumulative_budget']['planning_hold_usd'] = budget._usd(new_baseline['reserved_units'])
    f['audit']['actual_counts']['budget_batch_records'] = new_baseline['batch_count']
    f['audit']['actual_counts']['originalUSD1_allocation_attempts'] = new_baseline['allocation_count']
    f['audit']['current_native']['full_row_projections']['attempts'].append(
        {'kind': 'asr', 'source_sha256': source_sha, 'request_sha256': sha(wire)})
    successor_audit = tmp_path / 'historical-after-asr.json'; save(successor_audit, f['audit'])
    f['audit_path'] = successor_audit; f['baseline'] = new_baseline
    f['manifest']['historical_reference']['audit_path'] = str(successor_audit)
    f['manifest']['historical_reference']['audit_sha256'] = sha(successor_audit.read_bytes())
    return dict(receipt_id=receipt['receipt_id'], receipt_sha256=receipt_sha, source_sha256=source_sha)


def fixture(tmp_path, monkeypatch, scenario="N03"):
    schema = (audio.SCHEMA_N01 if scenario == "N01" else
              audio.SCHEMA_N01_REVIEWED if scenario == "N01Reviewed" else
              audio.SCHEMA_N03_COUGH_REVIEWED if scenario == "N03CoughReviewed" else
              audio.SCHEMA_REVIEWED_ASR if scenario == "ReviewedAsr" else audio.SCHEMA)
    text, audio_sha, source_version = (("今天太阳挺好，下午我想在楼下散散步，回来再挑一部电影看看。", None, 2)
                                      if scenario == 'ReviewedAsr' else audio.SOURCES[schema])
    # Same independent-root validator as the existing memory trial; no real files.
    monkeypatch.setattr(gate, 'ROOT', tmp_path)
    monkeypatch.setattr(budget, 'CLAIM_ROOT', tmp_path / 'claims')
    monkeypatch.setattr(gate, 'CONTINUATION_CLAIM_ROOT', tmp_path / 'runtime')
    monkeypatch.setattr(audio, 'ROOT', tmp_path)
    monkeypatch.setattr(audio, 'BINDING_PATH', tmp_path / 'runtime/saved-audio-continuation.json')
    f = proposed(tmp_path, monkeypatch)
    gid = 'a' * 32
    body = dict(subject_id='subject_self', turns=[dict(turn_id='turn_saved_audio_' + gid, text=text, version=1,
        responding_to=dict(turn_id='turn_saved_audio_opening_' + gid, text='您好，我会帮您把不舒服的地方记清楚，方便和医生说。您今天最难受的是什么？'))], controller={}, health_context=[])
    preview = prepare_job(dict(job_id='synthetic-corrected-audio', engine='conversation', native_input=body))
    payload_path = tmp_path / 'corrected-model-payload.json'; payload_sha = save(payload_path, preview['model_payload'])
    wire_path = tmp_path / 'corrected-wire.json'; wire_path.write_bytes(encoded(preview['wire_body']))
    r = f['receipt']; r['total_requests'] = 1; r['planned_text_requests'] = 1; r['request_sequence'] = ['llm']
    r['expires_at'] = (datetime.fromisoformat(r['approved_at']) + timedelta(minutes=20)).isoformat()
    p = r['profiles']['llm']; p['requests'] = 1; p['source_sha256'] = [preview['profile']['source_sha256']]; p['request_sha256'] = [sha(wire_path.read_bytes())]
    r['spend_authorization']['estimated_new_usd'] = '0.0096576'
    f['manifest']['receipt_sha256'] = save(f['receipt_path'], r)
    f['manifest']['request_pairs'] = [dict(model_payload_path=str(payload_path), model_payload_sha256=payload_sha,
        source_sha256=p['source_sha256'][0], wire_path=str(wire_path), request_sha256=p['request_sha256'][0])]
    prior_asr = _closed_asr_scope(f, tmp_path) if scenario == 'ReviewedAsr' else None
    if prior_asr:
        audio_sha = prior_asr['source_sha256']
        f['manifest']['budget_baseline'] = budget.cumulative_row_seal(f['descriptor'])
    f['manifest_sha256'] = save(f['manifest_path'], f['manifest']); activate(f)
    http = tmp_path / 'normal-http.json'; save(http, body)
    source = dict(media_id='media_' + '1' * 32, media_version=5, record_id='rec_' + '2' * 32, source_version=source_version,
        subject_id='subject_self', text_sha256=sha(text.encode()), confirmed_at='2026-10-10T17:28:58.856Z', audio_sha256=audio_sha)
    old = dict(review_required=True, state='review_required')
    if prior_asr:
        old.update(media_id=source['media_id'], conversation_id=None,
                   asr_trial_receipt_id=prior_asr['receipt_id'], asr_trial_receipt_sha256=prior_asr['receipt_sha256'])
    binding = dict(schema_version=schema, grant_id=gid, source=source, prior_media_control=old,
        prior_global_control=(dict(review_required=True, state='stopped', source_kind='elder', media_id='media_' + '9' * 32, conversation_id=None)
                              if prior_asr else dict(**old, media_id=source['media_id'], conversation_id=None)),
        receipt_path=str(f['receipt_path']), state_path=str(f['state_path']), http_payload_path=str(http), http_payload_sha256=audio.http_sha(body))
    save(audio.BINDING_PATH, binding)
    return {**f, 'body': body, 'binding': binding, 'gid': gid, 'wire': wire_path.read_bytes(), 'prior_asr': prior_asr}


def test_default_closed_and_no_budget_created(tmp_path, monkeypatch):
    monkeypatch.setattr(audio, 'ROOT', tmp_path); monkeypatch.setattr(audio, 'BINDING_PATH', tmp_path / 'missing.json')
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError): audio.run_turn('a' * 32, {}, lambda _: pytest.fail('must not reach provider'))
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize('change', ['version', 'unconfirmed', 'subject', 'old_owner', 'wide_time', 'expired', 'wire', 'source'])
def test_binding_drift_and_expiry_cannot_reach_model(tmp_path, monkeypatch, change):
    f = fixture(tmp_path, monkeypatch); b = f['binding']
    if change == 'version': b['source']['source_version'] = 3
    elif change == 'unconfirmed': b['source']['confirmed_at'] = None
    elif change == 'subject': b['source']['subject_id'] = 'subject_family'
    elif change == 'old_owner': b['prior_global_control']['conversation_id'] = 'old-conversation'
    elif change == 'wide_time':
        # Any authored attempt to widen the receipt also breaks the frozen native identity.
        r = f['receipt']; r['expires_at'] = (datetime.now(timezone.utc) + timedelta(minutes=40)).isoformat(); save(f['receipt_path'], r)
    elif change == 'expired':
        class Later(datetime):
            @classmethod
            def now(cls, tz=None): return datetime.now(tz) + timedelta(minutes=21)
        monkeypatch.setattr(gate, 'datetime', Later)
    elif change == 'wire': Path(f['manifest']['request_pairs'][0]['wire_path']).write_bytes(b'{}')
    elif change == 'source': b['source']['text_sha256'] = '0' * 64
    save(audio.BINDING_PATH, b)
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError): audio.run_turn(f['gid'], f['body'], lambda _: pytest.fail('must not reach model'))
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']


@pytest.mark.parametrize("scenario", ["N03", "N01"])
def test_failure_before_native_reserve_is_durable_across_module_restart(tmp_path, monkeypatch, scenario):
    f = fixture(tmp_path, monkeypatch, scenario); assert audio.available_grant() is not None
    def crash(_): raise RuntimeError('synthetic process interruption before reserve')
    with pytest.raises(RuntimeError): audio.run_turn(f['gid'], f['body'], crash)
    importlib.reload(audio); monkeypatch.setattr(audio, 'ROOT', tmp_path); monkeypatch.setattr(audio, 'BINDING_PATH', tmp_path / 'runtime/saved-audio-continuation.json')
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError): audio.run_turn(f['gid'], f['body'], lambda _: pytest.fail('restart must not replay'))
    assert gate.validate_trial_authorization(receipt_path=f['receipt_path'], state_path=f['state_path'])['remaining_requests'] == 1
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']


@pytest.mark.parametrize("scenario", ["N03", "N01", "N03CoughReviewed"])
def test_HTTP_normal_turn_preserves_original_budget_and_one_attempt_across_server_restart(tmp_path, monkeypatch, scenario):
    f = fixture(tmp_path, monkeypatch, scenario)
    monkeypatch.setenv('APP_MODE', 'local_first'); monkeypatch.setenv('APP_AUTO_BIND_LOOPBACK', 'true')
    monkeypatch.setenv('APP_SESSION_SECRET', 'synthetic-corrected-audio-session-0123456789'); monkeypatch.setenv('APP_COOKIE_SECURE', 'false')
    monkeypatch.setenv('ALLOWED_ORIGIN', 'http://127.0.0.1:5173'); monkeypatch.setenv('MODEL_PROVIDER', 'deepseek')
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'invented-key-no-account'); monkeypatch.setenv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com')
    monkeypatch.setenv('DEEPSEEK_MODEL', 'deepseek-flash'); monkeypatch.setenv('MODEL_MAX_TOKENS', '2048'); monkeypatch.setenv('LLM_JSON_MODE', 'true')
    monkeypatch.setenv('LLM_EXTRA_BODY_JSON', '{"thinking":{"type":"disabled"}}')
    from backend import server
    opened = []
    class Response(io.BytesIO):
        status = 200
        headers = {'Content-Type': 'application/json'}
    class ProviderOnlyOpener:
        def open(self, req, timeout):
            assert req.full_url == 'https://api.deepseek.com/chat/completions'
            assert req.data == f['wire']; opened.append(req.data)
            content = model_draft(f['body']['turns'], candidate_question='咳嗽每次会持续多久？' if scenario in ('N01', 'N03CoughReviewed') else '上腹不舒服每次会持续多久？')
            envelope = dict(id='synthetic-response', model='deepseek-flash', usage=dict(prompt_tokens=12, completion_tokens=3,
                completion_tokens_details=dict(reasoning_tokens=0)), choices=[dict(finish_reason='stop', message=dict(content=json.dumps(content, ensure_ascii=False)))])
            return Response(json.dumps(envelope, ensure_ascii=False).encode())
    for run in range(2):
        server.AI_REQUEST_LIMITER = server.AIRequestLimiter()
        with running_http_server(server.Handler) as url:
            client = HttpClient(url, {'Content-Type': 'application/json', 'Origin': 'http://127.0.0.1:5173'})
            session = client.request('GET', '/api/app/session'); assert session.body['authenticated']
            client.default_headers.update(Cookie=session.headers['Set-Cookie'].split(';', 1)[0], **{'X-CSRF-Token': session.body['csrf_token']})
            assert 'X-NoReset-Saved-Audio-Trial' in client.request('OPTIONS', '/api/ai/conversation-turn').headers['Access-Control-Allow-Headers']
            g = client.request('GET', '/api/app/saved-audio-trial'); assert g.status == 200
            assert bool(g.body['grant']) is (run == 0)
            with monkeypatch.context() as network:
                network.setattr(model_client.urllib.request, 'build_opener', lambda *_: ProviderOnlyOpener())
                bad = client.request('POST', '/api/ai/conversation-turn', {**f['body'], 'subject_id': 'subject_family'}, headers={'X-NoReset-Saved-Audio-Trial': f['gid']})
                assert bad.status == 422
                result = client.request('POST', '/api/ai/conversation-turn', f['body'], headers={'X-NoReset-Saved-Audio-Trial': f['gid']})
            assert result.status == (200 if run == 0 else 422)
            assert len(opened) == 1
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']
    assert budget.budget_snapshot(f['descriptor'])['reserved_estimate_usd'] == '0.1072576'


@pytest.mark.parametrize("change", ["wrong_version", "bool_version", "unreviewed", "changed_text", "changed_audio", "wrong_schema"])
def test_N01_real_first_revision_binding_denies_unreviewed_or_source_drift(tmp_path, monkeypatch, change):
    f = fixture(tmp_path, monkeypatch, "N01"); b = f["binding"]
    if change == "wrong_version": b["source"]["source_version"] = 2
    elif change == "bool_version": b["source"]["source_version"] = True
    elif change == "unreviewed": b["source"]["confirmed_at"] = None
    elif change == "changed_text": b["source"]["text_sha256"] = "0" * 64
    elif change == "changed_audio": b["source"]["audio_sha256"] = audio.AUDIO_SHA
    elif change == "wrong_schema": b["schema_version"] = audio.SCHEMA
    save(audio.BINDING_PATH, b)
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError):
        audio.run_turn(f["gid"], f["body"], lambda _: pytest.fail("N01 drift must not reach provider"))
    assert budget.cumulative_row_seal(f["descriptor"], baseline=f["baseline"]) == f["baseline"]

def test_N01_reviewed_first_revision_metadata_is_single_and_keeps_real_version(tmp_path, monkeypatch):
    f = fixture(tmp_path, monkeypatch, "N01")
    g = audio.available_grant()
    assert g["schema_version"] == audio.SCHEMA_N01 and g["source"]["source_version"] == 1
    assert g["source"]["text_sha256"] == sha(audio.N01_TEXT.encode())
    assert g["source"]["audio_sha256"] == audio.N01_AUDIO_SHA
    assert g["requests"] == 1 and g["retries"] == 0
    calls = []
    assert audio.run_turn(f["gid"], f["body"], lambda body: calls.append(body) or "saved") == "saved"
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError):
        audio.run_turn(f["gid"], f["body"], lambda _: pytest.fail("must not replay"))
    assert len(calls) == 1 and budget.cumulative_row_seal(f["descriptor"], baseline=f["baseline"]) == f["baseline"]


def test_N01_normal_review_second_revision_single_grant(tmp_path, monkeypatch):
    f = fixture(tmp_path, monkeypatch, "N01Reviewed")
    g = audio.available_grant()
    assert g["schema_version"] == "noreset-n01-saved-audio-llm-reviewed-v2"
    assert g["source"]["source_version"] == 2
    assert g["source"]["text_sha256"] == sha(audio.N01_TEXT.encode())
    assert g["source"]["audio_sha256"] == audio.N01_AUDIO_SHA
    calls = []
    assert audio.run_turn(f["gid"], f["body"], lambda body: calls.append(body) or "saved") == "saved"
    with pytest.raises(gate.TrialGateError):
        audio.run_turn(f["gid"], f["body"], lambda _: pytest.fail("must not replay"))
    assert len(calls) == 1
    assert budget.cumulative_row_seal(f["descriptor"], baseline=f["baseline"]) == f["baseline"]


def test_N03_reviewed_cough_exact_source_uses_new_single_grant(tmp_path, monkeypatch):
    f = fixture(tmp_path, monkeypatch, "N03CoughReviewed")
    g = audio.available_grant()
    assert g["schema_version"] == audio.SCHEMA_N03_COUGH_REVIEWED
    assert g["source"]["text_sha256"] == sha("我咳嗽两天了，晚上明显些。".encode())
    assert g["source"]["audio_sha256"] == "55534757775cb28fdbcfcb8cd58e932e62e2ed50f1d2c5b5268d7f319bb11e4c"
    assert g["source"]["source_version"] == 2
    assert f["body"]["turns"][0]["text"] == "我咳嗽两天了，晚上明显些。"
    assert g["requests"] == 1 and g["retries"] == 0
    calls = []
    assert audio.run_turn(f["gid"], f["body"], lambda body: calls.append(body) or "saved") == "saved"
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError):
        audio.run_turn(f["gid"], f["body"], lambda _: pytest.fail("used grant must not replay"))
    assert calls == [f["body"]]
    assert budget.cumulative_row_seal(f["descriptor"], baseline=f["baseline"]) == f["baseline"]


@pytest.mark.parametrize("change", ["bad_audio", "unreviewed", "wrong_version", "wrong_person", "not_stopped"])
def test_N03_reviewed_cough_binding_rejects_source_drift(tmp_path, monkeypatch, change):
    f = fixture(tmp_path, monkeypatch, "N03CoughReviewed")
    b = f["binding"]
    if change == "bad_audio": b["source"]["audio_sha256"] = audio.N01_AUDIO_SHA
    elif change == "unreviewed": b["source"]["confirmed_at"] = None
    elif change == "wrong_version": b["source"]["source_version"] = 1
    elif change == "wrong_person": b["source"]["subject_id"] = "subject_family"
    elif change == "not_stopped":
        b["prior_media_control"] = {"review_required": False, "state": "active"}
        b["prior_global_control"] = {**b["prior_media_control"], "media_id": b["source"]["media_id"], "conversation_id": None}
    save(audio.BINDING_PATH, b)
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError):
        audio.run_turn(f["gid"], f["body"], lambda _: pytest.fail("source drift must not reach provider"))
    assert budget.cumulative_row_seal(f["descriptor"], baseline=f["baseline"]) == f["baseline"]


def test_reviewed_asr_source_opens_only_one_saved_audio_grant_then_cannot_replay(tmp_path, monkeypatch):
    f = fixture(tmp_path, monkeypatch, 'ReviewedAsr')
    grant = audio.available_grant()
    assert grant and grant['schema_version'] == audio.SCHEMA_REVIEWED_ASR
    assert grant['source']['source_version'] == 2 and grant['source']['audio_sha256'] == f['prior_asr']['source_sha256']
    assert grant['requests'] == 1 and grant['retries'] == 0 and f['body']['health_context'] == []
    calls = []
    assert audio.run_turn(f['gid'], f['body'], lambda body: calls.append(body) or 'saved') == 'saved'
    assert calls == [f['body']] and audio.available_grant() is None
    with pytest.raises(gate.TrialGateError):
        audio.run_turn(f['gid'], f['body'], lambda _: pytest.fail('used saved-audio grant must not replay'))
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']


def test_reviewed_asr_source_accepts_null_global_control_with_closed_asr_proof(tmp_path, monkeypatch):
    f = fixture(tmp_path, monkeypatch, 'ReviewedAsr')
    f['binding']['prior_global_control'] = None
    f['binding']['prior_media_control'] = dict(
        review_required=True, state='review_required',
        asr_trial_receipt_id=f['prior_asr']['receipt_id'],
        asr_trial_receipt_sha256=f['prior_asr']['receipt_sha256'])
    save(audio.BINDING_PATH, f['binding'])
    grant = audio.available_grant()
    assert grant and grant['source']['source_version'] == 2
    calls = []
    assert audio.run_turn(f['gid'], f['body'], lambda body: calls.append(body) or 'saved') == 'saved'
    assert calls == [f['body']]
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError):
        audio.run_turn(f['gid'], f['body'], lambda _: pytest.fail('null-global grant must remain one-shot'))


def test_reviewed_asr_source_rejects_nonnull_bad_global_control(tmp_path, monkeypatch):
    f = fixture(tmp_path, monkeypatch, 'ReviewedAsr')
    f['binding']['prior_global_control']['state'] = 'completed'
    save(audio.BINDING_PATH, f['binding'])
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError):
        audio.run_turn(f['gid'], f['body'], lambda _: pytest.fail('bad global control must not dispatch'))


def test_reviewed_asr_null_global_rejects_unclosed_asr_scope(tmp_path, monkeypatch):
    f = fixture(tmp_path, monkeypatch, 'ReviewedAsr')
    f['binding']['prior_global_control'] = None
    save(audio.BINDING_PATH, f['binding'])
    original = budget.native_root_binding
    monkeypatch.setattr(budget, 'native_root_binding', lambda *args, **kwargs: {
        **original(*args, **kwargs), 'status': 'active'})
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError):
        audio.run_turn(f['gid'], f['body'], lambda _: pytest.fail('unclosed ASR scope must not dispatch'))


@pytest.mark.parametrize('change', ['media_state', 'media_id', 'asr_receipt', 'source_text'])
def test_reviewed_asr_null_global_keeps_exact_media_and_source_guards(tmp_path, monkeypatch, change):
    f = fixture(tmp_path, monkeypatch, 'ReviewedAsr')
    binding = f['binding']; binding['prior_global_control'] = None
    if change == 'media_state': binding['prior_media_control']['state'] = 'completed'
    elif change == 'media_id': binding['prior_media_control']['media_id'] = 'media_' + '9' * 32
    elif change == 'asr_receipt': binding['prior_media_control']['asr_trial_receipt_sha256'] = '0' * 64
    else: binding['source']['text_sha256'] = '0' * 64
    save(audio.BINDING_PATH, binding)
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError):
        audio.run_turn(f['gid'], f['body'], lambda _: pytest.fail('changed reviewed source must not dispatch'))


@pytest.mark.parametrize('change', ['audio_hash', 'text_hash', 'version', 'asr_proof'])
def test_reviewed_asr_grant_denies_changed_source_or_proof(tmp_path, monkeypatch, change):
    f = fixture(tmp_path, monkeypatch, 'ReviewedAsr'); binding = f['binding']
    if change == 'audio_hash': binding['source']['audio_sha256'] = '0' * 64
    elif change == 'text_hash': binding['source']['text_sha256'] = '0' * 64
    elif change == 'version': binding['source']['source_version'] = 0
    else: binding['prior_media_control']['asr_trial_receipt_sha256'] = '0' * 64
    save(audio.BINDING_PATH, binding)
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError):
        audio.run_turn(f['gid'], f['body'], lambda _: pytest.fail('changed ASR proof must not reach model'))
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']


def test_reviewed_asr_grant_denies_active_original_scope(tmp_path, monkeypatch):
    f = fixture(tmp_path, monkeypatch, 'ReviewedAsr')
    native_binding = budget.native_root_binding
    def active_scope(descriptor, **kwargs):
        result = native_binding(descriptor, **kwargs)
        if kwargs.get('receipt_id') == f['prior_asr']['receipt_id']:
            result['status'] = 'active'
        return result
    monkeypatch.setattr(budget, 'native_root_binding', active_scope)
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError):
        audio.run_turn(f['gid'], f['body'], lambda _: pytest.fail('active ASR scope must not reach model'))


def test_reviewed_asr_grant_denies_missing_native_scope_without_500(tmp_path, monkeypatch):
    f = fixture(tmp_path, monkeypatch, 'ReviewedAsr')
    native_binding = budget.native_root_binding
    def missing_scope(descriptor, **kwargs):
        if kwargs.get('receipt_id') == f['prior_asr']['receipt_id']:
            raise budget.TrialBudgetError()
        return native_binding(descriptor, **kwargs)
    monkeypatch.setattr(budget, 'native_root_binding', missing_scope)
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError):
        audio.run_turn(f['gid'], f['body'], lambda _: pytest.fail('missing ASR proof must not reach model'))

@pytest.mark.parametrize("drift", ["version1", "version3", "schema", "audio"])
def test_N01_second_revision_binding_drift_closed(tmp_path, monkeypatch, drift):
    f = fixture(tmp_path, monkeypatch, "N01Reviewed")
    b = f["binding"]
    if drift == "version1": b["source"]["source_version"] = 1
    if drift == "version3": b["source"]["source_version"] = 3
    if drift == "schema": b["schema_version"] = audio.SCHEMA_N01
    if drift == "audio": b["source"]["audio_sha256"] = audio.AUDIO_SHA
    save(audio.BINDING_PATH, b)
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError):
        audio.run_turn(f["gid"], f["body"], lambda _: pytest.fail("drift must not reach provider"))
    assert budget.cumulative_row_seal(f["descriptor"], baseline=f["baseline"]) == f["baseline"]


def test_exact_saved_N01_completed_controls_preserved_for_new_grant(tmp_path, monkeypatch):
    f = fixture(tmp_path, monkeypatch, "N01Reviewed")
    b = f["binding"]
    b["source"].update(media_id=audio.N01_COMPLETED_MEDIA["media_id"], media_version=4,
                       record_id="rec_731878cfff954398993ee79f0f1c5716")
    b["prior_media_control"] = dict(audio.N01_COMPLETED_MEDIA)
    b["prior_global_control"] = dict(audio.N01_COMPLETED_GLOBAL)
    save(audio.BINDING_PATH, b)
    assert audio.available_grant()["source"]["source_version"] == 2
    b["prior_global_control"]["turn_id"] = "turn_" + "0" * 32
    save(audio.BINDING_PATH, b)
    assert audio.available_grant() is None
    with pytest.raises(gate.TrialGateError):
        audio.run_turn(f["gid"], f["body"], lambda _: pytest.fail("changed archived controls must not dispatch"))
    assert budget.cumulative_row_seal(f["descriptor"], baseline=f["baseline"]) == f["baseline"]
