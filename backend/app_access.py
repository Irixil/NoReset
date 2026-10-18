"""Stateless online access for the local-first hosted application.

Health records and decryption keys never enter this module.  It protects only
the hosted AI and backup capabilities with signed admin/device sessions plus a
double-submit CSRF value carried inside each signed cookie.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass
from http.cookies import SimpleCookie
from urllib.parse import urlparse


COOKIE_NAME = "bingli_session"
_LOGIN_FAILURES: dict[str, list[float]] = {}
_LOGIN_LOCK = threading.Lock()


class AccessConfigurationError(RuntimeError):
    pass


def local_first_enabled() -> bool:
    return os.getenv("APP_MODE", "").strip().lower() == "local_first"


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _required_secret() -> bytes:
    value = os.getenv("APP_SESSION_SECRET", "")
    if len(value.encode("utf-8")) < 32:
        raise AccessConfigurationError("app_session_secret_not_configured")
    return value.encode("utf-8")


def configured() -> bool:
    """Return whether the optional legacy administrator password is ready."""
    try:
        _required_secret()
    except AccessConfigurationError:
        return False
    password = os.getenv("APP_OWNER_PASSWORD", "")
    password_hash = os.getenv("APP_OWNER_PASSWORD_SHA256", "")
    return len(password) >= 12 or re.fullmatch(r"[0-9a-fA-F]{64}", password_hash) is not None


def session_configured() -> bool:
    try:
        _required_secret()
    except AccessConfigurationError:
        return False
    return True


def verify_password(value: object) -> bool:
    if not isinstance(value, str):
        return False
    expected = os.getenv("APP_OWNER_PASSWORD", "")
    expected_hash = os.getenv("APP_OWNER_PASSWORD_SHA256", "").strip().lower()
    if expected:
        return len(expected) >= 12 and hmac.compare_digest(value.encode("utf-8"), expected.encode("utf-8"))
    if re.fullmatch(r"[0-9a-fA-F]{64}", expected_hash):
        actual = hashlib.sha256(value.encode("utf-8")).hexdigest()
        return hmac.compare_digest(actual, expected_hash)
    return False


def login_allowed(identifier: str, now: float | None = None) -> bool:
    current = time.time() if now is None else now
    window = 15 * 60
    with _LOGIN_LOCK:
        recent = [value for value in _LOGIN_FAILURES.get(identifier, []) if value > current - window]
        _LOGIN_FAILURES[identifier] = recent
        return len(recent) < 5


def record_login_result(identifier: str, success: bool, now: float | None = None) -> None:
    current = time.time() if now is None else now
    with _LOGIN_LOCK:
        if success:
            _LOGIN_FAILURES.pop(identifier, None)
        else:
            _LOGIN_FAILURES.setdefault(identifier, []).append(current)


def reset_login_limiter() -> None:
    """Clear in-memory limiter state for process-isolated tests."""
    with _LOGIN_LOCK:
        _LOGIN_FAILURES.clear()


@dataclass(frozen=True)
class Session:
    csrf: str
    expires_at: int


def _bounded_ttl(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        ttl = int(os.getenv(name, str(default)))
    except ValueError as error:
        raise AccessConfigurationError(f"{name.lower()}_invalid") from error
    if ttl < minimum or ttl > maximum:
        raise AccessConfigurationError(f"{name.lower()}_invalid")
    return ttl


def _signed_payload(payload: dict[str, object]) -> str:
    encoded = _b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = _b64encode(hmac.new(_required_secret(), encoded.encode("ascii"), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def _verified_payload(token: object) -> dict[str, object] | None:
    if not isinstance(token, str) or len(token) > 2048:
        return None
    try:
        encoded, supplied_signature = token.split(".", 1)
        expected_signature = _b64encode(hmac.new(_required_secret(), encoded.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(supplied_signature, expected_signature):
            return None
        payload = json.loads(_b64decode(encoded))
        return payload if isinstance(payload, dict) else None
    except (AccessConfigurationError, ValueError, TypeError, json.JSONDecodeError):
        return None


def issue_session(now: int | None = None, *, ttl: int | None = None) -> tuple[Session, str]:
    _required_secret()
    current = int(time.time() if now is None else now)
    session_ttl = _bounded_ttl("APP_SESSION_TTL_SECONDS", 43200, 300, 604800) if ttl is None else ttl
    if session_ttl < 300 or session_ttl > 31536000:
        raise AccessConfigurationError("app_session_ttl_invalid")
    payload = {
        "v": 1,
        "iat": current,
        "exp": current + session_ttl,
        "csrf": secrets.token_urlsafe(24),
        "nonce": secrets.token_urlsafe(12),
    }
    return Session(payload["csrf"], payload["exp"]), _signed_payload(payload)


def device_session_ttl() -> int:
    return _bounded_ttl("APP_DEVICE_SESSION_TTL_SECONDS", 2592000, 86400, 31536000)


def issue_device_session(now: int | None = None) -> tuple[Session, str, int]:
    ttl = device_session_ttl()
    session, token = issue_session(now=now, ttl=ttl)
    return session, token, ttl


def issue_device_activation(now: int | None = None) -> tuple[str, int]:
    current = int(time.time() if now is None else now)
    ttl = _bounded_ttl("APP_DEVICE_ACTIVATION_TTL_SECONDS", 600, 60, 3600)
    expires_at = current + ttl
    token = _signed_payload({
        "v": 1,
        "purpose": "device_activation",
        "iat": current,
        "exp": expires_at,
        "nonce": secrets.token_urlsafe(18),
    })
    return token, expires_at


def verify_device_activation(token: object, now: int | None = None) -> bool:
    payload = _verified_payload(token)
    current = int(time.time() if now is None else now)
    return bool(
        payload
        and payload.get("v") == 1
        and payload.get("purpose") == "device_activation"
        and type(payload.get("iat")) is int
        and type(payload.get("exp")) is int
        and payload["iat"] <= current
        and payload["exp"] > current
        and payload["exp"] - payload["iat"] <= 3600
    )


def parse_session(cookie_header: str | None, now: int | None = None) -> Session | None:
    if not cookie_header:
        return None
    try:
        cookies = SimpleCookie(); cookies.load(cookie_header)
        token = cookies[COOKIE_NAME].value
        payload = _verified_payload(token)
        if payload is None:
            return None
        current = int(time.time() if now is None else now)
        if payload.get("v") != 1 or type(payload.get("exp")) is not int or payload["exp"] <= current:
            return None
        csrf = payload.get("csrf")
        if not isinstance(csrf, str) or len(csrf) < 20:
            return None
        return Session(csrf, payload["exp"])
    except (AccessConfigurationError, KeyError, ValueError, TypeError, json.JSONDecodeError):
        return None


def request_authorized(cookie_header: str | None, csrf_header: str | None = None, *, write: bool) -> Session | None:
    session = parse_session(cookie_header)
    if session is None:
        return None
    if write and (not csrf_header or not hmac.compare_digest(csrf_header, session.csrf)):
        return None
    return session


def cookie_header(token: str, *, clear: bool = False, max_age: int | None = None) -> str:
    secure = os.getenv("APP_COOKIE_SECURE", "true").strip().lower() not in {"0", "false", "off", "no"}
    same_site = os.getenv("APP_COOKIE_SAMESITE", "Strict").strip().capitalize()
    if same_site not in {"Strict", "Lax", "None"}:
        raise AccessConfigurationError("app_cookie_samesite_invalid")
    if same_site == "None" and not secure:
        raise AccessConfigurationError("app_cookie_samesite_none_requires_secure")
    parts = [f"{COOKIE_NAME}={'' if clear else token}", "Path=/", "HttpOnly", f"SameSite={same_site}"]
    if secure:
        parts.append("Secure")
    if clear:
        parts.append("Max-Age=0")
    elif max_age is not None:
        if type(max_age) is not int or max_age < 1 or max_age > 31536000:
            raise AccessConfigurationError("app_cookie_max_age_invalid")
        parts.append(f"Max-Age={max_age}")
    return "; ".join(parts)


def loopback_auto_bind_allowed(client_host: str, origin: str | None, allowed_origin: str) -> bool:
    if os.getenv("APP_AUTO_BIND_LOOPBACK", "false").strip().lower() not in {"1", "true", "on", "yes"}:
        return False
    try:
        client_is_loopback = ipaddress.ip_address(client_host).is_loopback
        parsed_origin = urlparse((origin or "").strip().rstrip("/"))
        parsed_allowed = urlparse(allowed_origin.strip().rstrip("/"))
        origin_is_loopback = _is_loopback_host(parsed_origin.hostname)
        allowed_is_loopback = _is_loopback_host(parsed_allowed.hostname)
    except ValueError:
        return False
    return bool(
        client_is_loopback
        and origin_is_loopback
        and allowed_is_loopback
        and parsed_origin.scheme in {"http", "https"}
        and parsed_origin.geturl() == parsed_allowed.geturl()
    )


def _is_loopback_host(host: str | None) -> bool:
    if not host:
        return False
    if host.lower().rstrip(".") == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False
