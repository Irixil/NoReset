"""Configuration-readiness checks; none of these probes contact a provider."""

from __future__ import annotations

try:
    from .adapter import AdapterError, Config, provider_from
    from .recognition import RecognitionError, _config_for
except ImportError:
    from adapter import AdapterError, Config, provider_from
    from recognition import RecognitionError, _config_for


def _text_ai() -> tuple[str, dict[str, object]]:
    try:
        config = Config.from_env()
    except AdapterError:
        return "unconfigured", {"available": False, "reason": "provider_configuration_invalid"}
    provider = config.provider
    if provider == "mock":
        return provider, {"available": False, "reason": "provider_mock"}
    try:
        provider_from(config)  # Construct/validate only; never call complete_json.
    except AdapterError:
        return provider, {"available": False, "reason": "provider_configuration_missing_or_invalid"}
    return provider, {"available": True, "reason": "provider_configured_connection_unverified"}


def _recognition(kind: str) -> dict[str, object]:
    try:
        config = _config_for(kind, None)
    except RecognitionError as error:
        reason = error.code if error.code in {"provider_not_configured", "media_configuration_invalid"} else "provider_configuration_invalid"
        return {"available": False, "reason": reason}
    if config.name == "mock":
        return {"available": False, "reason": "provider_mock"}
    return {"available": True, "reason": "provider_configured_connection_unverified"}


def local_first_capabilities() -> dict[str, object]:
    provider, text_ai = _text_ai()
    return {
        "provider": provider,
        "capabilities": {
            "text_ai": text_ai,
            "audio_recognition": _recognition("audio"),
            "image_recognition": _recognition("image"),
        },
    }
