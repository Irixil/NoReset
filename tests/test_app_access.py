import hashlib

import pytest

from backend import app_access


def configure(monkeypatch):
    monkeypatch.setenv("APP_MODE", "local_first")
    monkeypatch.setenv("APP_SESSION_SECRET", "s" * 32)
    monkeypatch.setenv("APP_OWNER_PASSWORD", "a sufficiently long password")
    monkeypatch.setenv("APP_COOKIE_SECURE", "false")


def test_owner_session_is_signed_expiring_and_requires_csrf_on_writes(monkeypatch):
    configure(monkeypatch)
    session, token = app_access.issue_session()
    cookie = f"other=x; {app_access.COOKIE_NAME}={token}"

    parsed = app_access.parse_session(cookie)
    assert parsed == session
    assert app_access.request_authorized(cookie, session.csrf, write=True) is not None
    assert app_access.request_authorized(cookie, "wrong", write=True) is None
    assert app_access.parse_session(cookie + "tampered") is None
    assert app_access.parse_session(cookie, now=session.expires_at) is None


def test_password_can_be_supplied_as_sha256_without_exposing_it_in_session(monkeypatch):
    monkeypatch.setenv("APP_SESSION_SECRET", "s" * 32)
    monkeypatch.delenv("APP_OWNER_PASSWORD", raising=False)
    monkeypatch.setenv("APP_OWNER_PASSWORD_SHA256", hashlib.sha256(b"another long password").hexdigest())

    assert app_access.configured() is True
    assert app_access.verify_password("another long password") is True
    assert app_access.verify_password("wrong") is False
    _, token = app_access.issue_session(now=100)
    assert "another" not in token


def test_incomplete_access_configuration_fails_closed(monkeypatch):
    monkeypatch.delenv("APP_SESSION_SECRET", raising=False)
    monkeypatch.delenv("APP_OWNER_PASSWORD", raising=False)
    monkeypatch.delenv("APP_OWNER_PASSWORD_SHA256", raising=False)
    assert app_access.configured() is False
    assert app_access.verify_password("anything") is False

    monkeypatch.setenv("APP_SESSION_SECRET", "s" * 32)
    assert app_access.session_configured() is True
    assert app_access.configured() is False


def test_login_failures_are_bounded_and_success_clears_the_window():
    app_access.reset_login_limiter()
    for offset in range(5):
        assert app_access.login_allowed("127.0.0.1", now=100 + offset)
        app_access.record_login_result("127.0.0.1", False, now=100 + offset)
    assert app_access.login_allowed("127.0.0.1", now=110) is False
    assert app_access.login_allowed("127.0.0.1", now=1000) is True
    app_access.record_login_result("127.0.0.1", False, now=1000)
    app_access.record_login_result("127.0.0.1", True, now=1001)
    assert app_access.login_allowed("127.0.0.1", now=1002) is True


def test_cookie_policy_supports_split_services_without_weak_defaults(monkeypatch):
    configure(monkeypatch)
    strict = app_access.cookie_header("token")
    assert "SameSite=Strict" in strict
    assert "Secure" not in strict

    monkeypatch.setenv("APP_COOKIE_SECURE", "true")
    monkeypatch.setenv("APP_COOKIE_SAMESITE", "None")
    cross_site = app_access.cookie_header("token")
    assert "SameSite=None" in cross_site
    assert "Secure" in cross_site

    monkeypatch.setenv("APP_COOKIE_SECURE", "false")
    with pytest.raises(app_access.AccessConfigurationError, match="requires_secure"):
        app_access.cookie_header("token")


def test_device_activation_is_signed_short_lived_and_tamper_evident(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setenv("APP_DEVICE_ACTIVATION_TTL_SECONDS", "600")
    token, expires_at = app_access.issue_device_activation(now=100)

    assert expires_at == 700
    assert app_access.verify_device_activation(token, now=699) is True
    assert app_access.verify_device_activation(token, now=700) is False
    assert app_access.verify_device_activation(token + "x", now=200) is False
    assert app_access.verify_device_activation("not-a-token", now=200) is False


def test_device_session_cookie_persists_for_configured_period(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setenv("APP_DEVICE_SESSION_TTL_SECONDS", "2592000")
    session, token, ttl = app_access.issue_device_session(now=100)
    header = app_access.cookie_header(token, max_age=ttl)

    assert session.expires_at == 2592100
    assert "Max-Age=2592000" in header
    assert "HttpOnly" in header
    assert app_access.parse_session(f"{app_access.COOKIE_NAME}={token}", now=2592099) == session


def test_loopback_auto_bind_requires_explicit_switch_exact_origin_and_loopback_client(monkeypatch):
    configure(monkeypatch)
    allowed = "http://127.0.0.1:5173"
    assert app_access.loopback_auto_bind_allowed("127.0.0.1", allowed, allowed) is False

    monkeypatch.setenv("APP_AUTO_BIND_LOOPBACK", "true")
    assert app_access.loopback_auto_bind_allowed("127.0.0.1", allowed, allowed) is True
    assert app_access.loopback_auto_bind_allowed("127.0.0.1", "https://untrusted.example", allowed) is False
    assert app_access.loopback_auto_bind_allowed("203.0.113.9", allowed, allowed) is False
    assert app_access.loopback_auto_bind_allowed("127.0.0.1", "http://localhost:5173", allowed) is False
    monkeypatch.setenv("ALLOWED_ORIGIN", "http://localhost:5173")
    assert app_access.loopback_auto_bind_allowed("127.0.0.1", "http://localhost:5173", "http://localhost:5173") is True
