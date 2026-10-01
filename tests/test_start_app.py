from scripts import start_app
from scripts.start_app import prepare_app_environment


def test_start_app_selects_local_first_without_device_session_setup(tmp_path, monkeypatch):
    monkeypatch.delenv("APP_MODE", raising=False)
    env, generated = prepare_app_environment(tmp_path, environ={})
    assert env["APP_MODE"] == "local_first"
    assert generated is True
    assert len(env["APP_SESSION_SECRET"]) >= 32
    assert env["APP_AUTO_BIND_LOOPBACK"] == "true"
    assert env["APP_COOKIE_SECURE"] == "false"
    assert env["APP_AI_MEDIA_MAX_BYTES"] == str(20 * 1024 * 1024)


def test_start_app_preserves_explicit_secret_but_never_auto_binds_public_host(tmp_path):
    secret = "s" * 40
    local, generated = prepare_app_environment(tmp_path, environ={"APP_SESSION_SECRET": secret})
    assert generated is False
    assert local["APP_SESSION_SECRET"] == secret
    assert local["APP_AUTO_BIND_LOOPBACK"] == "true"

    public, generated = prepare_app_environment(
        tmp_path,
        environ={"API_HOST": "0.0.0.0", "APP_SESSION_SECRET": secret, "APP_AUTO_BIND_LOOPBACK": "true"},
    )
    assert generated is False
    assert public["APP_AUTO_BIND_LOOPBACK"] == "false"


def test_check_config_does_not_require_device_session_access(tmp_path, monkeypatch):
    monkeypatch.setattr(start_app, "prepare_app_environment", lambda _root: ({"API_PORT": "18768"}, False))
    monkeypatch.setattr(start_app, "check_demo_configuration", lambda _env: {"模型": []})
    assert start_app.main(["--check-config"], root=tmp_path) == 0


def test_check_config_fails_when_model_configuration_is_not_ready(tmp_path, monkeypatch):
    monkeypatch.setattr(start_app, "prepare_app_environment", lambda _root: ({"API_PORT": "18768"}, False))
    monkeypatch.setattr(start_app, "check_demo_configuration", lambda _env: {"模型": ["缺少密钥"]})

    assert start_app.main(["--check-config"], root=tmp_path) == 2
