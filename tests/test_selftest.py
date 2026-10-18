"""HTTP selftest behavior; external providers are explicit controlled substitutes."""

import io
import json
import os
import threading
from dataclasses import replace
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from backend import adapter, server
from backend.media_backend import LocalMediaBackend
from backend.store import SQLiteStore
from scripts.selftest import SelfTest, main, valid_base_url


@pytest.fixture
def deployment(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_PROVIDER", "mock")
    monkeypatch.setenv("MEDIA_UPLOAD_MAX_BYTES", "1048576")
    monkeypatch.setenv("MEDIA_UPLOAD_PART_MAX_BYTES", "32")
    monkeypatch.setenv("MEDIA_UPLOAD_MAX_PARTS", "100")
    store = SQLiteStore(tmp_path / "selftest.sqlite3")
    backend = LocalMediaBackend(store, tmp_path / "media", recognition_provider="mock", background=False)
    monkeypatch.setattr(server, "STORE", store)
    monkeypatch.setattr(server, "MEDIA_BACKEND", backend)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    audio, image = tmp_path / "voice.wav", tmp_path / "note.png"
    audio.write_bytes(b"RIFF" + b"\0" * 4 + b"WAVE" + b"\0" * 88)
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"synthetic fixture" * 4)
    try:
        yield f"http://127.0.0.1:{httpd.server_port}", store, backend, audio, image
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)


def failed_names(report):
    return [check["name"] for check in report["checks"] if not check["passed"]]


def install_contract_fixtures(monkeypatch, backend):
    """Use deterministic, explicitly non-provider fixtures for HTTP workflow tests."""
    config = replace(adapter.Config.from_env(), provider="openai_compatible")
    monkeypatch.setattr(server.Config, "from_env", classmethod(lambda cls: config))

    class ContractFixtureProvider(adapter.MockProvider):
        pass

    monkeypatch.setattr(
        server, "organize_event",
        lambda payload: adapter.organize_event(payload, ContractFixtureProvider()),
    )

    def recognize(_path, *, kind, attempt_id, **_kwargs):
        text = "合成语音内容：今天散步十分钟。" if kind == "audio" else "合成图片文字：家庭记录资料。"
        return {
            "text": text, "provider": "contract_fixture", "model": "fixture",
            "is_mock": False, "attempt_id": attempt_id,
        }

    backend._recognition._recognizer = recognize


def test_default_refuses_mock_and_makes_no_writes(deployment, tmp_path):
    url, store, _, audio, image = deployment
    output = io.StringIO()
    report_path = tmp_path / "result.json"
    code = main(["--base-url", url, "--audio", str(audio), "--image", str(image), "--out", str(report_path)], output=output)
    report = json.loads(output.getvalue())
    assert code == 1
    assert report["online_passed"] is False
    assert "health.real_provider" in failed_names(report)
    assert json.loads(report_path.read_text()) == report
    assert not store.list()
    assert not store.list_media()
    assert all(call["method"] == "GET" for call in report["http_calls"])


def test_contract_fixture_runs_full_http_path_without_overriding_environment(deployment, monkeypatch):
    url, store, backend, audio, image = deployment
    install_contract_fixtures(monkeypatch, backend)
    env_before = dict(os.environ)
    report = SelfTest(url, audio=audio, image=image, allow_mock=True).run()
    assert report["passed"] is True, failed_names(report)
    assert report["online_passed"] is False
    assert report["mode"] == "offline_regression_allow_mock"
    assert dict(os.environ) == env_before
    assert len(report["artifacts"]["media"]) == 2
    assert len(report["artifacts"]["records"]) == 4
    assert len(store.list()) == 4
    assert len(store.list_media()) == 2
    names = {check["name"] for check in report["checks"]}
    assert {"text.snapshot_immutable", "text.key_conflict", "text.old_preserved", "text.danger_after_review",
            "audio.original_equal", "image.original_equal", "audio.recognition_idempotent", "image.linked"} <= names
    assert server.SESSION_TOKEN not in json.dumps(report)
    assert str(audio) not in json.dumps(report)
    assert report["providers"]["audio"]["is_mock"] is False
    assert len([call for call in report["http_calls"] if call["name"].startswith("audio.part_")]) > 2


def test_missing_sample_is_reported_without_writes(deployment):
    url, store, _, _, image = deployment
    report = SelfTest(url, image=image, allow_mock=True).run()
    assert not report["passed"]
    assert "audio.sample_supplied" in failed_names(report)
    assert not store.list()
    assert not store.list_media()


def test_expected_transcript_mismatch_cannot_pass(deployment, monkeypatch):
    url, _, backend, audio, image = deployment
    install_contract_fixtures(monkeypatch, backend)
    report = SelfTest(url, audio=audio, image=image, allow_mock=True,
                      audio_expect=["this_text_is_not_in_mock_transcript"]).run()
    assert not report["passed"]
    assert "audio.expected_keyword" in failed_names(report)
    # Independent image diagnostics still run after the audio phase failed.
    assert any(check["name"] == "image.handoff_link" and check["passed"] for check in report["checks"])


def test_recognition_failure_retains_original_and_reports_error(deployment):
    url, _, backend, audio, image = deployment
    backend.recognition_provider = "unconfigured"
    report = SelfTest(url, audio=audio, image=image, allow_mock=True).run()
    assert not report["passed"]
    assert {"audio.recognition_success", "image.recognition_success"} <= set(failed_names(report))
    assert report["providers"]["audio"]["error_code"] == "provider_not_configured"
    assert any(check["name"] == "audio.after_recognition.original_equal" and check["passed"] for check in report["checks"])


def test_processing_deadline_fails_instead_of_claiming_success(deployment):
    url, _, backend, audio, image = deployment

    def leave_processing(media_id, version, key, actor, household_id=None):
        return backend.event_store.claim_media_recognition(media_id, expected_version=version,
                                                           idempotency_key=key, actor=actor)

    backend.start_recognition = leave_processing
    report = SelfTest(url, audio=audio, image=image, allow_mock=True,
                      recognition_timeout=0.02, poll_interval=0.01).run()
    assert not report["passed"]
    assert {"audio.poll_deadline", "image.poll_deadline"} <= set(failed_names(report))


def test_organize_failure_queries_preserved_original(deployment, monkeypatch):
    url, store, _, audio, image = deployment

    def fail(_payload):
        raise TimeoutError("not included in report")

    monkeypatch.setattr(server, "organize_event", fail)
    report = SelfTest(url, audio=audio, image=image, allow_mock=True).run()
    assert not report["passed"]
    assert "text.organize_success" in failed_names(report)
    assert any(check["name"] == "text.failure_preserves_original" and check["passed"] for check in report["checks"])
    assert store.list()[0]["raw_text"]
    assert "not included in report" not in json.dumps(report)


def test_default_real_mode_requires_sample_keywords(deployment, monkeypatch):
    url, _, _, audio, image = deployment
    real_config = replace(adapter.Config.from_env(), provider="openai_compatible")
    monkeypatch.setattr(server.Config, "from_env", classmethod(lambda cls: real_config))
    report = SelfTest(url, audio=audio, image=image).run()
    assert not report["passed"]
    assert "audio.expected_keywords_supplied" in failed_names(report)
    assert all(call["method"] == "GET" for call in report["http_calls"])


def test_real_health_label_does_not_make_mock_results_pass(deployment, monkeypatch):
    url, _, _, audio, image = deployment
    config = replace(adapter.Config.from_env(), provider="openai_compatible")
    monkeypatch.setattr(server.Config, "from_env", classmethod(lambda cls: config))
    monkeypatch.setattr(server, "organize_event", lambda payload: adapter.organize_event(payload, adapter.MockProvider()))
    report = SelfTest(url, audio=audio, image=image, audio_expect=["Mock"], image_expect=["Mock"]).run()
    assert not report["passed"] and not report["online_passed"]
    assert {"text.real_provider", "audio.recognition_success", "image.recognition_success"} <= set(failed_names(report))


def test_real_mode_contract_with_controlled_provider_substitutes(deployment, monkeypatch):
    """Validate the online gate's mechanics; this test does not call real providers."""
    url, _, backend, audio, image = deployment
    config = replace(adapter.Config.from_env(), provider="openai_compatible")
    monkeypatch.setattr(server.Config, "from_env", classmethod(lambda cls: config))

    class ContractFixtureProvider(adapter.MockProvider):
        pass

    monkeypatch.setattr(server, "organize_event", lambda payload: adapter.organize_event(payload, ContractFixtureProvider()))
    backend._recognition._recognizer = lambda *args, **kwargs: {
        "text": "自动化合成病例：今天散步二十分钟。", "provider": "contract_fixture", "model": "fixture",
        "is_mock": False, "attempt_id": kwargs["attempt_id"],
    }
    report = SelfTest(url, audio=audio, image=image, audio_expect=["散步", "二十分钟"], image_expect=["散步"]).run()
    assert report["passed"] is True, failed_names(report)
    assert report["online_passed"] is True  # Contract metadata only; fixture context is explicit above.


def test_unreachable_service_returns_nonzero_json(tmp_path):
    import socket
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    output = io.StringIO()
    code = main(["--base-url", f"http://127.0.0.1:{port}", "--timeout", "0.1",
                 "--out", str(tmp_path / "unreachable.json")], output=output)
    report = json.loads(output.getvalue())
    assert code == 1
    assert "health.transport" in failed_names(report)


def test_bad_target_emits_machine_json_without_http(tmp_path):
    output = io.StringIO()
    code = main(["--base-url", "https://example.com", "--out", str(tmp_path / "bad.json")], output=output)
    report = json.loads(output.getvalue())
    assert code == 1
    assert report["online_passed"] is False
    assert report["http_calls"] == []


@pytest.mark.parametrize("url", ["http://localhost@evil.example", "http://localhost/?token=secret",
                                  "http://localhost/api", "file:///tmp/server", "http://127.0.0.1:bad"])
def test_local_origin_validation(url):
    with pytest.raises(ValueError):
        valid_base_url(url)
