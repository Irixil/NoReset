from __future__ import annotations

import builtins
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

import pytest

from scripts import demo_config
from scripts.start_demo import main

ROOT = Path(__file__).resolve().parents[1]


def complete_online_env(tmp_path):
    env = {
        "MODEL_PROVIDER": "openai_compatible",
        "LLM_BASE_URL": "https://text.example/v1",
        "LLM_MODEL": "test-model",
        "LLM_API_KEY": "private-text-value",
        "MEDIA_RECOGNITION_PROVIDER": "openai_compatible",
        "MEDIA_ASR_URL": "https://asr.example/v1/audio/transcriptions",
        "MEDIA_ASR_MODEL": "test-asr",
        "MEDIA_ASR_API_KEY": "private-asr-value",
        "MEDIA_OCR_URL": "https://ocr.example/v1/chat/completions",
        "MEDIA_OCR_MODEL": "test-ocr",
        "MEDIA_OCR_API_KEY": "private-ocr-value",
    }
    return demo_config.prepare_demo_environment(tmp_path, environ=env)


def test_env_load_is_literal_and_shell_values_including_empty_win(tmp_path):
    path = tmp_path / ".env"
    path.write_text(
        '# comment\nLLM_API_KEY="file-key"\nLLM_MODEL=\'file-model\'\n'
        'export MEDIA_OCR_API_KEY="literal$HOME#=value"\n'
        'API_PORT=19999\nnot an identifier=ignored\ninvalid-line\n',
        encoding="utf-8",
    )
    env = {"LLM_API_KEY": "shell-key", "LLM_MODEL": ""}
    demo_config.load_environment(path, env)
    assert env == {
        "LLM_API_KEY": "shell-key", "LLM_MODEL": "",
        "MEDIA_OCR_API_KEY": "literal$HOME#=value", "API_PORT": "19999",
    }


def test_online_never_adds_mock_or_cross_origin_default(tmp_path):
    env = demo_config.prepare_demo_environment(tmp_path, environ={})
    assert "MODEL_PROVIDER" not in env
    assert "MEDIA_RECOGNITION_PROVIDER" not in env
    assert "ALLOWED_ORIGIN" not in env
    assert env["API_PORT"] == "18768"
    assert env["DB_PATH"] == str(tmp_path / "runtime" / "records.sqlite3")
    assert env["MEDIA_ROOT"] == str(tmp_path / "runtime" / "media")
    issues = demo_config.check_demo_configuration(env)
    assert all(issues[section] for section in ("文字整理", "语音识别（ASR）", "照片识字（OCR）"))
    assert not issues["本地服务"]


def test_explicit_paths_limits_and_origin_survive(tmp_path):
    env = {"ALLOWED_ORIGIN": "http://localhost:5173", "API_PORT": "12345", "DB_PATH": "test.sqlite3", "MEDIA_ROOT": "test-media", "MEDIA_UPLOAD_MAX_BYTES": "1000"}
    demo_config.prepare_demo_environment(tmp_path, environ=env)
    assert env["ALLOWED_ORIGIN"] == "http://localhost:5173"
    assert env["API_PORT"] == "12345"
    assert env["DB_PATH"] == "test.sqlite3"
    assert env["MEDIA_ROOT"] == "test-media"
    assert env["MEDIA_UPLOAD_MAX_BYTES"] == "1000"


def test_offline_overrides_all_providers_but_preserves_credentials(tmp_path):
    env = complete_online_env(tmp_path)
    env.update(MEDIA_ASR_PROVIDER="dashscope_streaming", MEDIA_OCR_PROVIDER="openai_compatible")
    demo_config.prepare_demo_environment(tmp_path, offline=True, environ=env)
    assert all(env[key] == "mock" for key in ("MODEL_PROVIDER", "MEDIA_RECOGNITION_PROVIDER", "MEDIA_ASR_PROVIDER", "MEDIA_OCR_PROVIDER"))
    assert env["LLM_API_KEY"] == "private-text-value"
    assert not any(demo_config.check_demo_configuration(env, offline=True).values())
    assert all(demo_config.check_demo_configuration(env)[section] for section in ("文字整理", "语音识别（ASR）", "照片识字（OCR）"))


@pytest.mark.parametrize("key,section", [
    ("LLM_API_KEY", "文字整理"), ("LLM_BASE_URL", "文字整理"), ("LLM_MODEL", "文字整理"),
    ("MEDIA_ASR_API_KEY", "语音识别（ASR）"), ("MEDIA_ASR_URL", "语音识别（ASR）"),
    ("MEDIA_OCR_MODEL", "照片识字（OCR）"), ("MEDIA_OCR_API_KEY", "照片识字（OCR）"),
])
def test_missing_fields_are_reported_per_service_without_values(tmp_path, key, section):
    env = complete_online_env(tmp_path)
    env[key] = "  "
    issues = demo_config.check_demo_configuration(env)
    assert key in " ".join(issues[section])
    assert not any(values for name, values in issues.items() if name != section)
    assert "private-" not in str(issues)


def test_valid_online_config_and_shared_media_key(tmp_path):
    env = complete_online_env(tmp_path)
    del env["MEDIA_ASR_API_KEY"], env["MEDIA_OCR_API_KEY"]
    env["MEDIA_RECOGNITION_API_KEY"] = "shared-value"
    assert not any(demo_config.check_demo_configuration(env).values())


def test_aihubmix_media_needs_only_one_key_and_uses_internal_defaults(tmp_path):
    env = complete_online_env(tmp_path)
    env["MEDIA_RECOGNITION_PROVIDER"] = "aihubmix"
    for key in (
        "MEDIA_ASR_URL",
        "MEDIA_ASR_MODEL",
        "MEDIA_ASR_API_KEY",
        "MEDIA_OCR_URL",
        "MEDIA_OCR_MODEL",
        "MEDIA_OCR_API_KEY",
    ):
        del env[key]
    env["AIHUBMIX_API_KEY"] = "shared-hubmix-secret"

    assert not any(demo_config.check_demo_configuration(env).values())


def test_aihubmix_missing_shared_key_is_reported_without_values(tmp_path):
    env = complete_online_env(tmp_path)
    env["MEDIA_RECOGNITION_PROVIDER"] = "aihubmix"
    env["MEDIA_ASR_API_KEY"] = "stale-other-provider-secret"
    env["MEDIA_OCR_API_KEY"] = "stale-other-provider-secret"
    env["MEDIA_RECOGNITION_API_KEY"] = "stale-shared-secret"
    env["AIHUBMIX_API_KEY"] = "  "

    issues = demo_config.check_demo_configuration(env)
    assert "AIHUBMIX_API_KEY" in " ".join(issues["语音识别（ASR）"])
    assert "AIHUBMIX_API_KEY" in " ".join(issues["照片识字（OCR）"])
    assert "shared-hubmix-secret" not in str(issues)
    assert "stale-" not in str(issues)


@pytest.mark.parametrize("provider,settings", [
    ("deepseek", {"DEEPSEEK_API_KEY": "test-secret"}),
    ("deepseek-ai", {"DEEPSEEK_API_KEY": "test-secret", "DEEPSEEK_MODEL": "custom-model"}),
    ("modelscope", {"MODELSCOPE_ACCESS_TOKEN": "test-secret", "MODELSCOPE_MODEL": "custom-model"}),
    ("魔搭", {"MODELSCOPE_TOKEN": "test-secret", "MODELSCOPE_MODEL": "custom-model"}),
])
def test_text_provider_compatibility(tmp_path, provider, settings):
    env = complete_online_env(tmp_path)
    env.update(MODEL_PROVIDER=provider, **settings)
    assert not any(demo_config.check_demo_configuration(env).values())


def test_modelscope_explicit_empty_primary_token_does_not_claim_alias_is_valid(tmp_path):
    env = complete_online_env(tmp_path)
    env.update(MODEL_PROVIDER="modelscope", MODELSCOPE_MODEL="test-model", MODELSCOPE_ACCESS_TOKEN="", MODELSCOPE_TOKEN="unused-alias-secret")
    issues = demo_config.check_demo_configuration(env)
    assert "MODELSCOPE_ACCESS_TOKEN" in " ".join(issues["文字整理"])
    assert "unused-alias-secret" not in str(issues)


def test_unknown_providers_are_rejected_without_echoing_input(tmp_path):
    env = complete_online_env(tmp_path)
    env.update(MODEL_PROVIDER="private-invalid-provider", MEDIA_ASR_PROVIDER="private-invalid-provider")
    issues = demo_config.check_demo_configuration(env)
    assert issues["文字整理"] and issues["语音识别（ASR）"]
    assert "private-invalid-provider" not in str(issues)


def test_per_kind_media_provider_overrides_global(tmp_path):
    env = complete_online_env(tmp_path)
    env["MEDIA_RECOGNITION_PROVIDER"] = "mock"
    env["MEDIA_ASR_PROVIDER"] = "openai_compatible"
    env["MEDIA_OCR_PROVIDER"] = "openai-compatible"
    assert not any(demo_config.check_demo_configuration(env).values())
    env["MEDIA_OCR_PROVIDER"] = "mock"
    issues = demo_config.check_demo_configuration(env)
    assert issues["照片识字（OCR）"]
    assert not issues["语音识别（ASR）"]


@pytest.mark.parametrize("prefix,section", [
    ("MEDIA_ASR", "语音识别（ASR）"),
    ("MEDIA_OCR", "照片识字（OCR）"),
])
@pytest.mark.parametrize("url", [
    "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    "ws://localhost:8000/recognize",
    "http://recognizer.example/recognize",
    "https://user:password@recognizer.example/recognize",
    "https://recognizer.example/recognize?private=value",
    "https://recognizer.example/recognize?",
    "https://recognizer.example/recognize#private-fragment",
    "https://recognizer.example/recognize#",
    "https://recognizer.example",
])
def test_openai_compatible_media_rejects_unsafe_or_non_endpoint_urls(
    tmp_path, prefix, section, url
):
    env = complete_online_env(tmp_path)
    env[prefix + "_URL"] = url
    issues = demo_config.check_demo_configuration(env)
    assert prefix + "_URL" in " ".join(issues[section])
    assert "private" not in str(issues)


@pytest.mark.parametrize("url", [
    "http://localhost:8000/recognize",
    "http://127.0.0.1:8000/recognize",
    "http://[::1]:8000/recognize",
])
def test_openai_compatible_media_allows_http_loopback_for_local_testing(tmp_path, url):
    env = complete_online_env(tmp_path)
    env["MEDIA_OCR_URL"] = url
    assert not any(demo_config.check_demo_configuration(env).values())


def test_inherited_openai_compatible_ocr_rejects_streaming_asr_url(tmp_path):
    env = complete_online_env(tmp_path)
    env["MEDIA_OCR_URL"] = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
    issues = demo_config.check_demo_configuration(env)
    assert "MEDIA_OCR_URL" in " ".join(issues["照片识字（OCR）"])
    assert not issues["语音识别（ASR）"]


def test_whitespace_media_override_does_not_fall_back_or_pass_validation(tmp_path):
    env = complete_online_env(tmp_path)
    env["MEDIA_ASR_PROVIDER"] = "  "
    assert demo_config.check_demo_configuration(env)["语音识别（ASR）"]
    env["MEDIA_ASR_PROVIDER"] = "openai_compatible"
    env["MEDIA_ASR_API_KEY"] = "  "
    env["MEDIA_RECOGNITION_API_KEY"] = "unused-fallback-key"
    assert "MEDIA_ASR_API_KEY" in " ".join(demo_config.check_demo_configuration(env)["语音识别（ASR）"])


def test_streaming_asr_uses_exact_explicit_endpoint_model_and_key(tmp_path, monkeypatch):
    env = complete_online_env(tmp_path)
    env.update(MEDIA_ASR_PROVIDER="dashscope_streaming", MEDIA_ASR_URL="wss://dashscope.aliyuncs.com/api-ws/v1/inference", MEDIA_ASR_MODEL="qwen-audio-3.0-asr-flash-streaming", DASHSCOPE_API_KEY="private-dashscope-value")
    del env["MEDIA_ASR_API_KEY"]
    monkeypatch.setattr(demo_config.importlib.util, "find_spec", lambda name: object())
    monkeypatch.setattr("backend.recognition.ffmpeg_executable", lambda: "/test/ffmpeg")
    assert not any(demo_config.check_demo_configuration(env).values())
    assert env["MEDIA_ASR_MODEL"] == "qwen-audio-3.0-asr-flash-streaming"
    env["MEDIA_ASR_URL"] = "https://secret.example/secret-path"
    issues = demo_config.check_demo_configuration(env)
    assert issues["语音识别（ASR）"]
    assert "secret.example" not in str(issues)
    assert "private-dashscope-value" not in str(issues)


def test_streaming_asr_reports_missing_runtime_dependencies(tmp_path, monkeypatch):
    env = complete_online_env(tmp_path)
    env.update(MEDIA_ASR_PROVIDER="dashscope_streaming", MEDIA_ASR_URL="wss://dashscope.aliyuncs.com/api-ws/v1/inference")
    monkeypatch.setattr(demo_config.importlib.util, "find_spec", lambda name: None)
    monkeypatch.setattr("backend.recognition.ffmpeg_executable", lambda: None)
    messages = " ".join(demo_config.check_demo_configuration(env)["语音识别（ASR）"])
    assert "websockets" in messages and "ffmpeg" in messages


@pytest.mark.parametrize("key,value", [("API_PORT", "0"), ("API_PORT", "65536"), ("MEDIA_UPLOAD_MAX_BYTES", "-1"), ("MEDIA_UPLOAD_PART_MAX_BYTES", "0"), ("MEDIA_UPLOAD_MAX_PARTS", "bad")])
def test_invalid_local_settings_are_not_silently_replaced(tmp_path, key, value):
    env = complete_online_env(tmp_path)
    env[key] = value
    assert key in " ".join(demo_config.check_demo_configuration(env)["本地服务"])
    assert env[key] == value


def test_check_config_does_not_import_server_or_leak_values(tmp_path, monkeypatch, capsys):
    env = complete_online_env(tmp_path)
    (tmp_path / ".env").write_text("\n".join(f"{k}={v}" for k, v in env.items()), encoding="utf-8")
    monkeypatch.setattr(os, "environ", {})
    original_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        assert name != "backend.server", "config-only check must not initialize a database/server"
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)
    assert main(["--check-config"], root=tmp_path) == 0
    output = capsys.readouterr().out
    assert "配置检查不等于接口连通性" in output
    assert "private-" not in output and "https://" not in output
    assert not (tmp_path / "runtime").exists()


def test_online_missing_config_fails_and_offline_is_explicit(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(os, "environ", {})
    assert main(["--check-config"], root=tmp_path) == 2
    assert "未启动服务" in capsys.readouterr().out
    assert main(["--offline", "--check-config"], root=tmp_path) == 0
    assert "离线 Mock" in capsys.readouterr().out


def test_offline_entry_serves_same_origin_ui_and_accepts_write(tmp_path):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    # The actual repository .env is never read: pass only a temporary root to
    # main(), and an explicit minimal environment to the subprocess.
    code = "from pathlib import Path; from scripts.start_demo import main; raise SystemExit(main(['--offline'], root=Path(__import__('sys').argv[1])))"
    process = subprocess.Popen(
        [sys.executable, "-c", code, str(tmp_path)], cwd=ROOT,
        env={"PATH": os.defpath, "API_PORT": str(port)},
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    base = f"http://localhost:{port}"
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            assert process.poll() is None, "offline demo exited before startup"
            try:
                with urllib.request.urlopen(base + "/health", timeout=1) as response:
                    health = json.load(response)
                break
            except (OSError, urllib.error.URLError):
                time.sleep(0.05)
        else:
            pytest.fail("offline demo did not start")
        assert health["provider"] == "mock"
        with urllib.request.urlopen(base + "/", timeout=2) as response:
            assert "<title>NoReset·内测版｜陪你记下来</title>" in response.read().decode()
        with urllib.request.urlopen(base + "/api/media/capabilities", timeout=2) as response:
            assert json.load(response)["capabilities"]["enabled"] is True
        request = urllib.request.Request(base + "/api/events", data=json.dumps({"raw_text": "演示启动测试", "source_kind": "elder", "actor_name": "测试"}).encode(), headers={"Content-Type": "application/json", "Origin": base, "X-Session-Token": health["session_token"], "Idempotency-Key": "same-origin-demo-test"})
        with urllib.request.urlopen(request, timeout=2) as response:
            assert response.status == 201
            assert json.load(response)["event"]["raw_text"] == "演示启动测试"
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        if process.stderr:
            process.stderr.close()
