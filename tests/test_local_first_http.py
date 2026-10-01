from backend import server
from backend.ai_limits import AIRequestLimiter
from backend.store import SQLiteStore
from tests.http_support import HttpClient, running_http_server
from tests.test_media_api import PNG, multipart


def configure(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_MODE", "local_first")
    monkeypatch.setenv("APP_SESSION_SECRET", "s" * 32)
    monkeypatch.setenv("APP_OWNER_PASSWORD", "a sufficiently long password")
    monkeypatch.setenv("APP_COOKIE_SECURE", "false")
    monkeypatch.setenv("ALLOWED_ORIGIN", "http://127.0.0.1:5173")
    monkeypatch.setenv("MODEL_PROVIDER", "mock")
    for key in (
        "APP_AUTO_BIND_LOOPBACK", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
        "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "MEDIA_RECOGNITION_PROVIDER",
        "MEDIA_ASR_PROVIDER", "MEDIA_OCR_PROVIDER", "AIHUBMIX_API_KEY",
        "MEDIA_ASR_API_KEY", "MEDIA_OCR_API_KEY", "MEDIA_RECOGNITION_API_KEY",
        "MEDIA_ASR_URL", "MEDIA_OCR_URL", "MEDIA_ASR_MODEL", "MEDIA_OCR_MODEL",
        "DASHSCOPE_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(server, "STORE", SQLiteStore(tmp_path / "must-stay-empty.sqlite3"))


def login(client):
    response = client.request("POST", "/api/app/login", {"password": "a sufficiently long password"})
    assert response.status == 200
    return response.headers["Set-Cookie"].split(";", 1)[0], response.body["csrf_token"]


def local_session(client, origin="http://127.0.0.1:5173"):
    response = client.request("GET", "/api/app/session", headers={"Origin": origin})
    assert response.status == 200
    assert response.body["authenticated"] is True
    return {
        "Origin": origin,
        "Cookie": response.headers["Set-Cookie"].split(";", 1)[0],
        "X-CSRF-Token": response.body["csrf_token"],
    }


def test_local_first_health_and_session_do_not_issue_legacy_storage_token(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {"Content-Type": "application/json"})
        health = client.request("GET", "/health")
        assert health.status == 200
        assert health.body["mode"] == "local_first"
        assert health.body["storage"] == "encrypted_on_device"
        assert "session_token" not in health.body

        session = client.request("GET", "/api/app/session")
        assert session.body == {"ok": True, "authenticated": False}
        legacy = client.request("GET", "/api/events")
        assert legacy.status == 404
        assert legacy.body["error"] == "legacy_api_disabled"


def test_local_first_backend_is_api_only_and_allows_only_the_frontend_origin(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {"Content-Type": "application/json"})
        root = client.request("GET", "/")
        assert root.status == 200
        assert root.body == {"ok": True, "service": "bingli-beta-api", "kind": "api", "frontend_hosted": False}

        allowed = client.request(
            "OPTIONS",
            "/api/app/login",
            headers={"Origin": "http://127.0.0.1:5173", "Access-Control-Request-Method": "POST"},
        )
        assert allowed.status == 204
        assert allowed.headers["Access-Control-Allow-Origin"] == "http://127.0.0.1:5173"
        assert allowed.headers["Access-Control-Allow-Credentials"] == "true"

        rejected = client.request(
            "OPTIONS",
            "/api/app/login",
            headers={"Origin": "https://untrusted.example", "Access-Control-Request-Method": "POST"},
        )
        assert rejected.status == 403
        assert rejected.body["error"] == "origin_rejected"
        assert rejected.headers.get("Access-Control-Allow-Origin") is None


def test_split_frontend_can_login_and_reuse_cookie_cross_port(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    origin = "http://127.0.0.1:5173"
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {"Content-Type": "application/json", "Origin": origin})
        response = client.request("POST", "/api/app/login", {"password": "a sufficiently long password"})
        assert response.status == 200
        assert response.headers["Access-Control-Allow-Origin"] == origin
        assert response.headers["Access-Control-Allow-Credentials"] == "true"
        cookie = response.headers["Set-Cookie"].split(";", 1)[0]

        session = client.request("GET", "/api/app/session", headers={"Cookie": cookie})
        assert session.status == 200
        assert session.body["authenticated"] is True
        assert session.headers["Access-Control-Allow-Origin"] == origin

        untrusted = client.request(
            "POST",
            "/api/app/login",
            {"password": "a sufficiently long password"},
            headers={"Origin": "https://untrusted.example"},
        )
        assert untrusted.status == 403
        assert untrusted.body["error"] == "csrf_or_origin_rejected"


def test_family_link_activates_a_persistent_device_session(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setenv("APP_DEVICE_SESSION_TTL_SECONDS", "2592000")
    origin = "http://127.0.0.1:5173"
    activation_token, _ = server.app_access.issue_device_activation()
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {"Content-Type": "application/json", "Origin": origin})
        activated = client.request("POST", "/api/app/device/activate", {"activation_token": activation_token})
        assert activated.status == 200
        assert activated.body["binding"] == "family_link"
        assert "Max-Age=2592000" in activated.headers["Set-Cookie"]
        assert "HttpOnly" in activated.headers["Set-Cookie"]
        cookie = activated.headers["Set-Cookie"].split(";", 1)[0]

        session = client.request("GET", "/api/app/session", headers={"Cookie": cookie})
        assert session.body["authenticated"] is True
        assert session.body["csrf_token"] == activated.body["csrf_token"]

        rejected = client.request(
            "POST",
            "/api/app/device/activate",
            {"activation_token": activation_token},
            headers={"Origin": "https://untrusted.example"},
        )
        assert rejected.status == 403
        assert rejected.body["error"] == "csrf_or_origin_rejected"


def test_loopback_development_can_bind_silently_but_production_default_cannot(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    origin = "http://127.0.0.1:5173"
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {"Content-Type": "application/json", "Origin": origin})
        ordinary = client.request("GET", "/api/app/session")
        assert ordinary.body == {"ok": True, "authenticated": False}

        monkeypatch.setenv("APP_AUTO_BIND_LOOPBACK", "true")
        bound = client.request("GET", "/api/app/session")
        assert bound.body["authenticated"] is True
        assert bound.body["binding"] == "loopback_development"
        assert "Max-Age=" in bound.headers["Set-Cookie"]

        no_origin = HttpClient(base_url, {"Content-Type": "application/json"}).request("GET", "/api/app/session")
        assert no_origin.body == {"ok": True, "authenticated": False}


def test_allowed_frontend_ai_requires_signed_session_and_csrf(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setenv("MODEL_PROVIDER", "deepseek")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "synthetic-test-key")
    monkeypatch.setattr(server, "organize_event", lambda _payload: {"output": {"review_required": True}})
    origin = "http://127.0.0.1:5173"
    with running_http_server(server.Handler) as base_url:
        no_origin = HttpClient(base_url, {"Content-Type": "application/json"})
        denied = no_origin.request("POST", "/api/ai/organize", {})
        assert denied.status == 403

        untrusted = HttpClient(base_url, {"Content-Type": "application/json", "Origin": "https://untrusted.example"})
        rejected = untrusted.request(
            "POST",
            "/api/ai/organize",
            {"record_id": "rec_12345678", "raw_text": "今天头晕"},
        )
        assert rejected.status == 403

        client = HttpClient(base_url, {"Content-Type": "application/json", "Origin": origin})
        anonymous = client.request(
            "POST", "/api/ai/organize",
            {"record_id": "rec_12345678", "raw_text": "今天头晕", "history": []},
        )
        assert anonymous.status == 401
        assert anonymous.body["error"] == "authentication_required"

        monkeypatch.setenv("APP_AUTO_BIND_LOOPBACK", "true")
        session_headers = local_session(client, origin)
        bad_csrf = client.request(
            "POST", "/api/ai/organize",
            {"record_id": "rec_12345678", "raw_text": "今天头晕", "history": []},
            headers={**session_headers, "X-CSRF-Token": "wrong"},
        )
        assert bad_csrf.status == 403
        assert bad_csrf.body["error"] == "csrf_invalid"
        organized = client.request(
            "POST",
            "/api/ai/organize",
            {
                "record_id": "rec_12345678",
                "raw_text": "今天头晕",
                "source_kind": "elder",
                "recorded_at": "2026-09-16T10:00:00+00:00",
                "history": [],
            },
            headers=session_headers,
        )
        assert organized.status == 200
        assert organized.body["raw_text_preserved_on_device"] is True
        assert organized.body["output"]["review_required"] is True
        assert server.STORE.list() == []


def test_every_ai_post_route_rejects_missing_session_before_provider(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    failure = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("provider path reached"))
    monkeypatch.setattr(server, "organize_event", failure)
    monkeypatch.setattr(server, "recognize_file", failure)
    monkeypatch.setattr(server, "conversation_turn", failure)
    origin = "http://127.0.0.1:5173"
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {"Content-Type": "application/json", "Origin": origin})
        for path in ("/api/ai/organize", "/api/ai/conversation-turn", "/api/ai/media/recognize"):
            denied = client.request("POST", path, {})
            assert denied.status == 401
            assert denied.body["error"] == "authentication_required"
        get_denied = client.request("GET", "/api/ai/status", headers={"Origin": origin})
        assert get_denied.status == 401


def test_ai_rate_limit_returns_explicit_process_scoped_429(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setenv("APP_AUTO_BIND_LOOPBACK", "true")
    monkeypatch.setenv("MODEL_PROVIDER", "deepseek")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "synthetic-test-key")
    monkeypatch.setattr(server, "AI_REQUEST_LIMITER", AIRequestLimiter(session_requests=1, instance_requests=10))
    monkeypatch.setattr(server, "organize_event", lambda _payload: {"synthetic_test": True})
    origin = "http://127.0.0.1:5173"
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {"Content-Type": "application/json", "Origin": origin})
        headers = local_session(client, origin)
        body = {"record_id": "rec_12345678", "raw_text": "今天头晕", "history": []}
        accepted = client.request("POST", "/api/ai/organize", body, headers=headers)
        assert accepted.status == 200
        limited = client.request("POST", "/api/ai/organize", body, headers=headers)
        assert limited.status == 429
        assert limited.body == {"ok": False, "error": "ai_rate_limited"}
        assert limited.headers["Retry-After"] == "60"
        assert limited.headers["X-AI-Limit-Scope"] == "process"


def test_app_config_reports_mock_and_missing_recognition_configuration(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    with running_http_server(server.Handler) as base_url:
        config = HttpClient(base_url).request("GET", "/api/app/config")
        assert config.status == 200
        assert config.body["provider"] == "mock"
        assert config.body["capabilities"]["text_ai"] == {"available": False, "reason": "provider_mock"}
        assert config.body["capabilities"]["audio_recognition"] == {
            "available": False, "reason": "provider_not_configured",
        }
        assert config.body["capabilities"]["image_recognition"] == {
            "available": False, "reason": "provider_not_configured",
        }


def test_app_config_reports_missing_real_model_credentials_without_network(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setenv("MODEL_PROVIDER", "deepseek")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    with running_http_server(server.Handler) as base_url:
        config = HttpClient(base_url).request("GET", "/api/app/config")
        assert config.body["provider"] == "deepseek"
        assert config.body["capabilities"]["text_ai"] == {
            "available": False,
            "reason": "provider_configuration_missing_or_invalid",
        }


def test_app_config_marks_configured_media_as_unverified_not_connected(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setenv("MEDIA_ASR_PROVIDER", "aihubmix")
    monkeypatch.setenv("MEDIA_OCR_PROVIDER", "aihubmix")
    monkeypatch.setenv("AIHUBMIX_API_KEY", "synthetic-test-key")
    with running_http_server(server.Handler) as base_url:
        config = HttpClient(base_url).request("GET", "/api/app/config")
        for name in ("audio_recognition", "image_recognition"):
            assert config.body["capabilities"][name] == {
                "available": True,
                "reason": "provider_configured_connection_unverified",
            }

def test_local_first_fails_closed_when_access_secret_is_missing(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.delenv("APP_SESSION_SECRET")
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {"Content-Type": "application/json"})
        config = client.request("GET", "/api/app/config")
        assert config.body["access_configured"] is False
        login_attempt = client.request("POST", "/api/app/login", {"password": "a sufficiently long password"})
        assert login_attempt.status == 503
        assert login_attempt.body["error"] == "access_not_configured"
        direct_ai = client.request(
            "POST",
            "/api/ai/organize",
            {"record_id": "rec_12345678", "raw_text": "今天头晕", "history": []},
            headers={"Origin": "http://127.0.0.1:5173"},
        )
        assert direct_ai.status == 503
        assert direct_ai.body["error"] == "access_not_configured"


def test_media_recognition_uses_a_temporary_original_and_returns_only_a_real_draft(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setenv("APP_AUTO_BIND_LOOPBACK", "true")
    observed = {}

    def recognize(path, **kwargs):
        observed["path"] = path
        observed["bytes"] = path.read_bytes()
        return {"text": "照片上的文字", "provider": "synthetic-test", "model": "fixture", "is_mock": False, "attempt_id": kwargs["attempt_id"]}

    monkeypatch.setattr(server, "recognize_file", recognize)
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {"Content-Type": "application/json", "Origin": "http://127.0.0.1:5173"})
        session_headers = local_session(client)
        body, content_type = multipart(
            {"kind": "image", "content_type": "image/png", "attempt_id": "attempt_test"},
            [("file", "report.png", "image/png", PNG)],
        )
        response = client.request(
            "POST",
            "/api/ai/media/recognize",
            raw_body=body,
            headers={"Content-Type": content_type, **session_headers},
        )
        assert response.status == 200
        assert response.body["recognition"]["text"] == "照片上的文字"
        assert observed["bytes"] == PNG
        assert not observed["path"].exists()
        assert server.STORE.list() == []


def test_local_first_ai_http_refuses_mock_text_provider(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setenv("APP_AUTO_BIND_LOOPBACK", "true")
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {"Content-Type": "application/json", "Origin": "http://127.0.0.1:5173"})
        headers = local_session(client)
        for path, body in (
            ("/api/ai/organize", {"record_id": "rec_12345678", "raw_text": "今天头晕", "history": []}),
            ("/api/ai/conversation-turn", {"turns": [{"turn_id": "turn_00000001", "text": "今天头晕"}]}),
        ):
            response = client.request("POST", path, body, headers=headers)
            assert response.status == 503
            assert response.body == {"ok": False, "error": "provider_mock_unavailable", "retryable": True}


def test_local_first_media_http_refuses_mock_transcript_as_recognized_text(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setenv("APP_AUTO_BIND_LOOPBACK", "true")

    def mock_recognize(path, **kwargs):
        assert path.is_file()
        return {"text": "[Mock ASR] voice.wav", "provider": "mock", "model": "mock", "is_mock": True, "attempt_id": kwargs["attempt_id"]}

    monkeypatch.setattr(server, "recognize_file", mock_recognize)
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {"Content-Type": "application/json", "Origin": "http://127.0.0.1:5173"})
        headers = local_session(client)
        body, content_type = multipart(
            {"kind": "audio", "content_type": "audio/wav", "attempt_id": "attempt_mock"},
            [("file", "voice.wav", "audio/wav", b"RIFF\x00\x00\x00\x00WAVE")],
        )
        response = client.request(
            "POST", "/api/ai/media/recognize", raw_body=body,
            headers={"Content-Type": content_type, **headers},
        )
        assert response.status == 503
        assert response.body == {"ok": False, "error": "media_mock_unavailable", "retryable": True}
        assert "[Mock ASR]" not in str(response.body)


def test_app_config_marks_explicit_media_mock_unavailable(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setenv("MEDIA_ASR_PROVIDER", "mock")
    monkeypatch.setenv("MEDIA_OCR_PROVIDER", "mock")
    with running_http_server(server.Handler) as base_url:
        config = HttpClient(base_url).request("GET", "/api/app/config")
        assert config.body["capabilities"]["audio_recognition"] == {
            "available": False, "reason": "provider_mock",
        }
        assert config.body["capabilities"]["image_recognition"] == {
            "available": False, "reason": "provider_mock",
        }


def test_cloud_backup_grants_require_session_and_csrf(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    expected = {
        "object_key": "backups/2026/09/16/test.bingli",
        "method": "PUT",
        "url": "https://signed.invalid/upload",
        "headers": {"content-type": "application/vnd.bingli.encrypted+json"},
        "expires_in": 300,
        "size": 123,
        "sha256": "a" * 64,
    }
    monkeypatch.setattr(server.cloud_backup, "create_upload_grant", lambda size, sha256, credentials=None: expected)
    monkeypatch.setattr(server.cloud_backup, "list_backups", lambda credentials=None: [{"object_key": expected["object_key"]}])
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {"Content-Type": "application/json"})
        denied = client.request("POST", "/api/backups/upload-grant", {"size": 123, "sha256": "a" * 64})
        assert denied.status == 403

        cookie, csrf = login(client)
        missing_csrf = client.request(
            "POST",
            "/api/backups/upload-grant",
            {"size": 123, "sha256": "a" * 64},
            headers={"Cookie": cookie},
        )
        assert missing_csrf.status == 403

        granted = client.request(
            "POST",
            "/api/backups/upload-grant",
            {"size": 123, "sha256": "a" * 64},
            headers={"Cookie": cookie, "X-CSRF-Token": csrf},
        )
        assert granted.status == 201
        assert granted.body["grant"] == expected

        backups = client.request("GET", "/api/backups", headers={"Cookie": cookie})
        assert backups.status == 200
        assert backups.body["backups"][0]["object_key"] == expected["object_key"]
def test_document_and_document_history_cannot_reach_model_before_source_review(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setenv('APP_AUTO_BIND_LOOPBACK', 'true')
    monkeypatch.setenv('MODEL_PROVIDER', 'deepseek')
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'synthetic-test-key')
    monkeypatch.setattr(server, 'organize_event', lambda *_: (_ for _ in ()).throw(AssertionError('unreviewed OCR reached provider')))
    doc = {'record_id': 'rec_12345678', 'raw_text': '胸部120法及以上CT', 'source_kind': 'document'}
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {'Content-Type': 'application/json'})
        headers = local_session(client)
        for body in [doc, {**doc, 'source_kind': 'elder', 'history': [doc]}, {**doc, 'source_review': {'method': 'original_comparison', 'text': '不同版本', 'confirmed_at': '2026-10-01'}}]:
            response = client.request('POST', '/api/ai/organize', body, headers=headers)
            assert response.status == 409
            assert response.body['error'] == 'document_source_review_required'
