"""Offline checks for product-vs-standalone outbound request authority."""
from __future__ import annotations

import contextvars
import json

import pytest

from backend import model_client, trial_gate


class FakeResponse:
    status = 200
    headers = {"Content-Type": "application/json"}

    def read(self, _limit):
        return json.dumps({
            "model": "synthetic-model",
            "choices": [{"finish_reason": "stop", "message": {"content": '{"ok":true}'}}],
        }).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def _client():
    return model_client.ChatCompletionsClient(
        base_url="https://provider.invalid/v1", model="synthetic-model",
        api_key="synthetic-only-key", trial_provider="synthetic-provider",
    )


def _fake_transport(monkeypatch):
    calls = []

    class FakeOpener:
        def open(self, request, *, timeout):
            calls.append((request, timeout))
            return FakeResponse()

    monkeypatch.setattr(model_client.urllib.request, "build_opener", lambda *_args: FakeOpener())
    monkeypatch.setattr("socket.getaddrinfo", lambda *_args, **_kwargs: pytest.fail("unexpected DNS"))
    return calls


def test_trusted_product_scope_allows_one_fake_dispatch(monkeypatch):
    calls = _fake_transport(monkeypatch)
    monkeypatch.setattr(trial_gate, "authorize_request", lambda *_args: pytest.fail("trial gate should not run"))

    with model_client.product_execution_scope():
        assert _client().complete_json("synthetic prompt", {"synthetic": True}) == {"ok": True}

    assert len(calls) == 1
    assert calls[0][0].full_url == "https://provider.invalid/v1/chat/completions"
    assert model_client.product_execution_allowed() is False


def test_direct_client_remains_fail_closed_without_scope(monkeypatch):
    calls = _fake_transport(monkeypatch)
    authorizations = []

    def deny(request):
        authorizations.append(request.full_url)
        raise trial_gate.TrialGateError()

    monkeypatch.setattr(model_client, "authorize_request", deny)
    with pytest.raises(model_client.ModelClientError) as error:
        _client().complete_json("synthetic prompt", {"synthetic": True})

    assert error.value.code == "trial_authorization_required"
    assert authorizations == ["https://provider.invalid/v1/chat/completions"]
    assert calls == []


def test_revoked_standalone_context_overrides_product_scope(monkeypatch):
    calls = _fake_transport(monkeypatch)
    meter_constructions = []

    def meter(*_args, **_kwargs):
        meter_constructions.append(True)
        pytest.fail("revoked scope must deny before a ledger is opened")

    monkeypatch.setattr(trial_gate, "TrialGate", meter)
    token = trial_gate._STANDALONE_SCOPE.set({"paths": ("missing-receipt", "missing-state"), "active": False})
    try:
        with model_client.product_execution_scope():
            with pytest.raises(model_client.ModelClientError) as error:
                _client().complete_json("synthetic prompt", {"synthetic": True})
    finally:
        trial_gate._STANDALONE_SCOPE.reset(token)

    assert error.value.code == "trial_authorization_required"
    assert calls == []
    assert meter_constructions == []


def test_copied_product_scope_is_revoked_after_request_scope_closes(monkeypatch):
    calls = _fake_transport(monkeypatch)
    monkeypatch.setattr(model_client, "authorize_request", lambda _request: (_ for _ in ()).throw(trial_gate.TrialGateError()))
    with model_client.product_execution_scope():
        copied = contextvars.copy_context()
        assert copied.run(model_client.product_execution_allowed) is True

    assert copied.run(model_client.product_execution_allowed) is False
    with pytest.raises(model_client.ModelClientError) as error:
        copied.run(_client().complete_json, "synthetic prompt", {"synthetic": True})
    assert error.value.code == "trial_authorization_required"
    assert calls == []
