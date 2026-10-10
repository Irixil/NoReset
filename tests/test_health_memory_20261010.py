"""Invented health memories at the public conversation and actual HTTP boundary.

Only the external model is replaced. These checks prove request isolation and
source handling, not supplier recall, clinical accuracy, or persistent storage.
"""
from copy import deepcopy
import hashlib
import json

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


def recorded_recall_failure():
    """Exact synthetic supplier draft from first.result.json SHA 0c5cb0eb….

    Embedded so public tests do not depend on excluded local evidence files.
    This is a recorded failure replay, never a new supplier observation.
    """
    state = {category: {"status": "missing", "summary": "", "evidence_turn_ids": [], "context_ids": []}
             for category in conversation.CATEGORIES}
    state["main_complaint"] = {
        "status": "known", "summary": "今天咳嗽",
        "evidence_turn_ids": ["turn_f411631caf994ca6a5be929c8e30a88b"], "context_ids": [],
    }
    return {
        "user_intent": "health_fact", "latest_turn_adds_fact": True,
        "reply_text": "好的，您今天咳嗽，我会把这件事记下来，方便之后和医生说明。",
        "suggested_action": "ask", "question_category": "onset_course",
        "question_importance": "essential", "candidate_question": "这次咳嗽是从什么时候开始的？",
        "clinical_state": state, "relevant_context_ids": [], "unknowns": [],
        "contradictions": [], "risk_candidates": [],
    }


def recorded_recall_input():
    """Original synthetic browser input of the failed first memory request."""
    rows = [
        ("context_a73a26f043a543dba2ebe14ca65c01c2", "conditions",
         "2021年医生曾告诉我有哮喘，这只是我保存的既往陈述。", "historical", "2021-04-03", "244"),
        ("context_4267b9a2fe3e4dbdb149d3db695e2058", "medications",
         "2023年曾用过示例药甲，现在已经不用。", "historical", "2023-05-04", "392"),
        ("context_a7e0c0d995b54c398e12a1d9b42833a3", "allergies",
         "示例食物乙曾让我起皮疹，原因还不清楚。", "current", None, "542"),
    ]
    context = []
    for context_id, category, text, temporal, occurred, millis in rows:
        stamp = f"2026-10-10T00:55:45.{millis}Z"
        context.append(memory(context_id=context_id, subject_id="subject_self", category=category,
                              text=text, temporal_status=temporal, occurred_on=occurred,
                              recorded_at=stamp, confirmed_at=stamp, updated_at=stamp))
    return {
        "subject_id": "subject_self",
        "turns": [{"turn_id": "turn_f411631caf994ca6a5be929c8e30a88b",
                   "text": "我今天咳嗽，想把情况记录下来。", "version": 1,
                   "responding_to": {"turn_id": "turn_f34c0bf796bc4a5c86a997df219dbd2c",
                                     "text": "您好，我会帮您把不舒服的地方记清楚，方便和医生说。您今天最难受的是什么？"}}],
        "controller": {"asked_categories": ["main_complaint"], "closed_categories": [],
                       "question_counts": {category: int(category == "main_complaint")
                                           for category in conversation.CATEGORIES},
                       "asked_questions": ["您好，我会帮您把不舒服的地方记清楚，方便和医生说。您今天最难受的是什么？"],
                       "question_count": 1, "no_new_fact_count": 0,
                       "last_question_category": "main_complaint"},
        "health_context": context,
    }


def test_recorded_real_recall_failure_remains_failure_without_local_memory_copy():
    draft = recorded_recall_failure()
    canonical = json.dumps(draft, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    assert hashlib.sha256(canonical).hexdigest() == "ee29421c8f8d04fe9ef190e72c14aeb72f045b1697176bf3d6886fcb55da9aa7"
    payload = recorded_recall_input()
    before = deepcopy(payload)

    class RecordedFailureProvider:
        def complete_json(self, _system, model_payload):
            assert model_payload["health_context"] == payload["health_context"]
            assert model_payload["subject_id"] == "subject_self"
            return deepcopy(draft)

    result = conversation.conversation_turn(payload, provider=RecordedFailureProvider())
    assert result["completeness"]["relevant_context_ids"] == []
    assert result["completeness"]["clinical_state"]["relevant_history"]["status"] == "missing"
    assert "哮喘" not in result["assistant_text"]
    assert payload == before


def test_actual_model_prompt_requires_related_memory_state_before_next_question():
    class PromptContractProvider(CapturingProvider):
        def complete_json(self, system, payload):
            # Positive obligations are distinct from the old prohibition-only
            # contract that allowed the recorded empty history response.
            assert "先审阅本轮已选背景" in system
            assert "clinical_state.relevant_history" in system
            assert "不以患者再次说出" in system
            assert "不因当前只收到一句新主诉" in system
            assert "没有相关条目时保留 missing 和空引用" in system
            assert "保留原文中的“不确定”" in system
            return super().complete_json(system, payload)

    conversation.conversation_turn(request(memory()), provider=PromptContractProvider())


def test_recalled_historical_memory_uses_context_source_without_current_turn_repetition():
    row = memory(category="similar_episodes", text="2014年曾有过相似头部疼痛，几天后缓解。")

    class SourceGroundedProvider(CapturingProvider):
        def complete_json(self, system, payload):
            draft = super().complete_json(system, payload)
            draft["clinical_state"]["relevant_history"] = {
                "status": "known", "summary": row["text"], "evidence_turn_ids": [],
                "context_ids": [row["context_id"]],
            }
            draft["relevant_context_ids"] = [row["context_id"]]
            return draft

    provider = SourceGroundedProvider()
    result = conversation.conversation_turn(request(row), provider=provider)
    history = result["completeness"]["clinical_state"]["relevant_history"]
    assert history["context_ids"] == [row["context_id"]]
    assert history["evidence_turn_ids"] == []
    assert "2014年" in history["summary"]
    assert result["completeness"]["relevant_context_ids"] == [row["context_id"]]
    assert "2014年" not in provider.inputs[0]["turns"][0]["text"]
    assert provider.inputs[0]["health_context"][0]["temporal_status"] == "historical"


def test_provider_cannot_invent_a_recalled_memory_source():
    class ForgedRecallProvider(CapturingProvider):
        def complete_json(self, system, payload):
            draft = super().complete_json(system, payload)
            draft["relevant_context_ids"] = ["context_forgedunrelated"]
            return draft

    with pytest.raises(conversation.ConversationError, match="model_evidence_invalid"):
        conversation.conversation_turn(request(memory()), provider=ForgedRecallProvider())
