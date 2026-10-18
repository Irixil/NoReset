"""Configuration-readiness checks; none of these probes contact a provider."""

from __future__ import annotations

try:
    from .adapter import AdapterError, Config, provider_from
    from .recognition import RecognitionError, _config_for
except ImportError:
    from adapter import AdapterError, Config, provider_from
    from recognition import RecognitionError, _config_for


def _restricted(reason: str) -> dict[str, object]:
    return {"configured": False, "available": False, "connection_state": "not_configured",
            "execution_restricted": False, "reason": reason}


def _configured(*, product_execution_enabled: bool) -> dict[str, object]:
    return {"configured": True, "available": product_execution_enabled,
            "connection_state": "unverified" if product_execution_enabled else "not_attempted",
            "execution_restricted": not product_execution_enabled,
            "reason": "provider_configured_connection_unverified" if product_execution_enabled
            else "provider_execution_restricted"}


def _text_ai(*, product_execution_enabled: bool) -> tuple[str, dict[str, object]]:
    try:
        config = Config.from_env()
    except AdapterError:
        return "unconfigured", _restricted("provider_configuration_invalid")
    provider = config.provider
    if provider == "mock":
        return provider, _restricted("provider_mock")
    try:
        provider_from(config)  # Construct/validate only; never call complete_json.
    except AdapterError:
        return provider, _restricted("provider_configuration_missing_or_invalid")
    return provider, _configured(product_execution_enabled=product_execution_enabled)


def _recognition(kind: str, *, product_execution_enabled: bool) -> dict[str, object]:
    try:
        config = _config_for(kind, None)
    except RecognitionError as error:
        reason = error.code if error.code in {"provider_not_configured", "media_configuration_invalid"} else "provider_configuration_invalid"
        return _restricted(reason)
    if config.name == "mock":
        return _restricted("provider_mock")
    if config.name == "dashscope_streaming":
        return {"configured": True, "available": False, "connection_state": "not_attempted",
                "execution_restricted": True, "reason": "provider_external_transport_unavailable"}
    return _configured(product_execution_enabled=product_execution_enabled)


def local_first_capabilities(*, product_execution_enabled: bool = False) -> dict[str, object]:
    """Report config and trusted-route readiness without probing the provider.

    Direct callers default to the transport's fail-closed state. The actual
    local-first HTTP config route opts in because it is the trusted product
    surface; this does not claim the remote service has been tested.
    """
    provider, text_ai = _text_ai(product_execution_enabled=product_execution_enabled)
    return {
        "provider": provider,
        "capabilities": {
            "text_ai": text_ai,
            "audio_recognition": _recognition("audio", product_execution_enabled=product_execution_enabled),
            "image_recognition": _recognition("image", product_execution_enabled=product_execution_enabled),
        },
    }
