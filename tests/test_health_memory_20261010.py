"""Invented health memories at the public conversation and actual HTTP boundary.

Only the external model is replaced. These checks prove request isolation and
source handling, not supplier recall, clinical accuracy, or persistent storage.
"""
from copy import deepcopy

import pytest

from backend import conversation
from tests.http_support import HttpClient, running_http_server


SUBJECT = "person_fictional_alpha"
STAMP = "2001-03-02T12:00:00.000Z"


def memory(**changes):
    value = {
        "context_id": "context_fictionalalpha",
        "subject_id": SUBJECT,
        "category": "medications",
        "text": "过去用过示例药甲，已经不用；药名是否记对还不确定。",
        "source": "user_confirmed",
        "recorded_at": STAMP,
        "confirmed_at": STAMP,
        "updated_at": STAMP,
        "temporal_status": "historical",
        "confirmation_status": "confirmed",
        "confirmed_by": "self",
        "occurred_on": "2000-02-29",
        "remember": True,
        "source_kind": "self_statement",
    }
    value.update(changes)
    return value


def request(row=None, **changes):
    value = {
        "subject_id": SUBJECT,
        "turns": [{"turn_id": "turn_fictionalalpha", "text": "我今天头疼。"}],
        "health_context": [memory() if row is None else row],
        "controller": {},
    }
    value.update(changes)
    return value


class CapturingProvider:
    def __init__(self):
        self.inputs = []

    def complete_json(self, _system, payload):
        self.inputs.append(deepcopy(payload))
        state = {category: {"status": "missing", "summary": "",
                            "evidence_turn_ids": [], "context_ids": []}
                 for category in conversation.CATEGORIES}
        state["main_complaint"] = {"status": "known", "summary": "我今天头疼。",
                                   "evidence_turn_ids": [payload["turns"][0]["turn_id"]],
                                   "context_ids": []}
        return {
            "user_intent": "health_fact", "latest_turn_adds_fact": True,
            "reply_text": "我按您说的保留这次描述。", "suggested_action": "ask",
            "question_category": "functional_impact", "question_importance": "essential",
            "candidate_question": "头疼现在对您的日常活动有什么影响？",
            "clinical_state": state, "relevant_context_ids": [], "unknowns": [],
            "contradictions": [], "risk_candidates": [],
        }


def test_confirmed_memory_preserves_subject_dates_history_and_uncertain_source_words():
    provider = CapturingProvider()
    row = memory()
    result = conversation.conversation_turn(request(row), provider=provider)
    assert result["action"] == "ask"
    assert provider.inputs[0]["health_context"] == [row]
    assert provider.inputs[0]["subject_id"] == SUBJECT
    assert "还不确定" in provider.inputs[0]["health_context"][0]["text"]


@pytest.mark.parametrize("changes", [
    {"source": "family_report"},
    {"source": "model_generated"},
    {"confirmation_status": "unconfirmed"},
    {"confirmation_status": "revoked"},
    {"confirmed": False},
    {"status": "revoked"},
    {"revoked": True},
    {"temporal_status": "uncertain"},
    {"subject_id": "person_fictional_beta"},
])
def test_ineligible_memory_is_rejected_before_provider(changes):
    provider = CapturingProvider()
    with pytest.raises(conversation.ConversationError):
        conversation.conversation_turn(request(memory(**changes)), provider=provider)
    assert provider.inputs == []


@pytest.mark.parametrize("changes", [
    {"recorded_at": "yesterday"},
    {"confirmed_at": "2001-02-29T12:00:00Z"},
    {"updated_at": "2001-03-02T12:00:00"},
    {"recorded_at": "2999-01-01T00:00:00Z"},
    {"occurred_on": "2001-02-29"},
    {"occurred_on": "2999-01-01"},
    {"confirmed_by": "assistant"},
    {"source_kind": "model_generated"},
    {"remember": 1},
    {"subject_id": "../another-person"},
    {"category": []},
    {"status": {}},
    {"temporal_status": []},
    {"confirmed_by": []},
    {"source_kind": {}},
    {"revoked": "false"},
])
def test_invalid_memory_metadata_is_rejected_without_model_call(changes):
    provider = CapturingProvider()
    with pytest.raises(conversation.ConversationError):
        conversation.conversation_turn(request(memory(**changes)), provider=provider)
    assert provider.inputs == []


def test_confirmed_family_report_remains_family_report_and_preserves_null_occurrence():
    provider = CapturingProvider()
    row = memory(source_kind="family_report", confirmed_by="family", occurred_on=None)
    conversation.conversation_turn(request(row), provider=provider)
    assert provider.inputs[0]["health_context"] == [row]


def test_explicit_today_selection_may_include_confirmed_memory_not_kept_for_next_dialogue():
    provider = CapturingProvider()
    row = memory(remember=False)
    conversation.conversation_turn(request(row), provider=provider)
    assert provider.inputs[0]["health_context"] == [row]


def test_legacy_confirmed_four_fields_remain_legacy_without_invented_metadata():
    provider = CapturingProvider()
    row = {key: value for key, value in memory().items()
           if key in {"context_id", "category", "text", "source"}}
    payload = request(row)
    payload.pop("subject_id")
    conversation.conversation_turn(payload, provider=provider)
    assert provider.inputs[0]["health_context"] == [row]
    assert "subject_id" not in provider.inputs[0]


def test_identity_scoped_request_cannot_adopt_an_identity_unknown_legacy_row():
    row = {key: value for key, value in memory().items()
           if key in {"context_id", "category", "text", "source"}}
    provider = CapturingProvider()
    with pytest.raises(conversation.ConversationError):
        conversation.conversation_turn(request(row), provider=provider)
    assert provider.inputs == []


@pytest.fixture
def http_client(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_MODE", "local_first")
    monkeypatch.setenv("DB_PATH", str(tmp_path / "must-not-be-created.sqlite3"))
    monkeypatch.setenv("MEDIA_ROOT", str(tmp_path / "must-not-be-created-media"))
    monkeypatch.setenv("APP_SESSION_SECRET", "fictional-session-secret-" * 2)
    monkeypatch.setenv("APP_OWNER_PASSWORD", "fictional-health-memory-test-password")
    monkeypatch.setenv("APP_COOKIE_SECURE", "false")
    monkeypatch.setenv("ALLOWED_ORIGIN", "http://127.0.0.1:5173")
    monkeypatch.setenv("MODEL_PROVIDER", "deepseek")
    for key in ("DEEPSEEK_API_KEY", "LLM_API_KEY", "MODELSCOPE_ACCESS_TOKEN",
                "MODELSCOPE_TOKEN", "AIHUBMIX_API_KEY", "APP_AUTO_BIND_LOOPBACK"):
        monkeypatch.delenv(key, raising=False)
    from backend import server
    monkeypatch.setattr(server, "STORE", None)
    monkeypatch.setattr(server, "MEDIA_BACKEND", None)
    provider = CapturingProvider()
    monkeypatch.setattr(conversation, "provider_from", lambda: provider)
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {"Content-Type": "application/json",
                                      "Origin": "http://127.0.0.1:5173"})
        logged_in = client.request("POST", "/api/app/login",
                                   {"password": "fictional-health-memory-test-password"})
        assert logged_in.status == 200
        headers = {"Cookie": logged_in.headers["Set-Cookie"].split(";", 1)[0],
                   "X-CSRF-Token": logged_in.body["csrf_token"]}
        yield client, headers, provider
    assert not (tmp_path / "must-not-be-created.sqlite3").exists()


def test_http_preserves_confirmed_memory_and_current_history_distinction(http_client):
    client, headers, provider = http_client
    row = memory(category="allergies", temporal_status="current",
                 text="本人确认示例食物乙曾引起皮疹，原因仍不清楚。")
    response = client.request("POST", "/api/ai/conversation-turn", request(row), headers=headers)
    assert response.status == 200
    assert response.body["raw_text_preserved_on_device"] is True
    assert provider.inputs[0]["health_context"] == [row]
    assert provider.inputs[0]["subject_id"] == SUBJECT


@pytest.mark.parametrize("changes", [
    {"source": "family_report"}, {"confirmation_status": "unconfirmed"},
    {"confirmation_status": "revoked"}, {"temporal_status": "uncertain"},
    {"subject_id": "person_fictional_beta"},
    {"updated_at": "2001-02-29T12:00:00Z"},
])
def test_http_rejects_ineligible_memory_without_supplier_entry(http_client, changes):
    client, headers, provider = http_client
    response = client.request("POST", "/api/ai/conversation-turn",
                              request(memory(**changes)), headers=headers)
    assert response.status == 422
    assert response.body["raw_text_preserved_on_device"] is True
    assert response.body["error"].startswith("health_context_")
    assert provider.inputs == []
