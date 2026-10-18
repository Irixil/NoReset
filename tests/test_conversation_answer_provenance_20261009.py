"""Mechanical controller/source regressions; fixture replies are not model quality evidence."""
from copy import deepcopy
import socket

import pytest

from backend import adapter, conversation, model_client, trial_gate


QUESTION = "咳嗽的时候有痰吗，还是干咳？"
FULL_QUESTION = "好的，我把咳嗽的时间改成三天，不是两天。 " + QUESTION
ANSWER = {
    "turn_id": "turn_story_answer0003", "text": "大多是干咳，偶尔有一点白痰。", "version": 1,
    "responding_to": {"turn_id": "turn_story_question08", "text": FULL_QUESTION},
}
FIRST = {"turn_id": "turn_story_initial01", "text": "我咳嗽三天了，晚上明显些。", "version": 1}


@pytest.fixture(autouse=True)
def no_network_credentials_or_meter(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("This regression permits only explicit local fixture providers")
    monkeypatch.setattr(socket, "socket", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(adapter.Config, "from_env", staticmethod(forbidden))
    monkeypatch.setattr(conversation, "provider_from", forbidden)
    monkeypatch.setattr(model_client, "_open_request", forbidden)
    monkeypatch.setattr(model_client, "_trial_report", forbidden)
    monkeypatch.setattr(trial_gate, "authorize_request", forbidden)


def controller():
    return {
        "asked_categories": ["main_complaint", "symptom_character"], "closed_categories": [],
        "question_counts": {key: int(key in {"main_complaint", "symptom_character"}) for key in conversation.CATEGORIES},
        "asked_questions": ["您今天最难受的是哪里？", QUESTION], "question_count": 2,
        "no_new_fact_count": 0, "last_question_category": "symptom_character", "linked_context_ids": [],
    }


class LiteralFixtureProvider:
    """Explicit test precondition, not an invented actual provider result."""
    def __init__(self, *, category="symptom_character", source=None, status="known", summary=None):
        self.category, self.source, self.status, self.summary = category, source or ANSWER, status, summary
        self.last_payload = None

    def complete_json(self, _system, payload):
        self.last_payload = deepcopy(payload)
        state = conversation._empty_state()
        state["main_complaint"] = {
            "status": "known", "summary": FIRST["text"], "evidence_turn_ids": [FIRST["turn_id"]], "context_ids": [],
        }
        state[self.category] = {
            "status": self.status,
            "summary": (self.summary if self.summary is not None else self.source["text"]) if self.status == "known" else "",
            "evidence_turn_ids": [self.source["turn_id"]] if self.status != "missing" else [], "context_ids": [],
        }
        finished = payload["turns"][-1]["text"] == "没有了。"
        return {
            "user_intent": "explicit_finish" if finished else "correction" if "说错了" in payload["turns"][-1]["text"] else "answer",
            "latest_turn_adds_fact": not finished, "reply_text": "按您说的原话记录。",
            "suggested_action": "ask", "question_category": "functional_impact", "question_importance": "useful",
            "candidate_question": "睡觉受影响吗？", "clinical_state": state,
            "relevant_context_ids": [], "unknowns": [], "contradictions": [], "risk_candidates": [],
        }


def run(turns, control, provider=None):
    payload = {"turns": deepcopy(turns), "controller": deepcopy(control), "health_context": []}
    before = deepcopy(payload)
    result = conversation.conversation_turn(payload, provider=provider or LiteralFixtureProvider())
    assert payload == before
    return result


def slot(result, category="symptom_character"):
    return result["completeness"]["clinical_state"][category]


@pytest.mark.parametrize("later", [
    {"turn_id": "turn_story_correct04", "text": "我刚才说错了，不是三天，是四天。", "version": 1},
    {"turn_id": "turn_story_finished4", "text": "没有了。", "version": 1},
    {"turn_id": "turn_story_sleep004", "text": "睡觉还好。", "version": 1,
     "responding_to": {"turn_id": "turn_story_question09", "text": "睡觉受影响吗？"}},
])
def test_literal_answer_survives_later_correction_finish_and_other_question(later):
    first = run([FIRST, ANSWER], controller())
    assert slot(first) == {"status": "known", "summary": ANSWER["text"], "evidence_turn_ids": [ANSWER["turn_id"]], "context_ids": []}
    second = run([FIRST, ANSWER, later], first["controller"])
    assert slot(second) == slot(first)
    if later["text"] == "没有了。":
        assert second["action"] == "finish" and second["stop_reason"] == "user_finished"


@pytest.mark.parametrize("change", ["version", "quote", "question_text", "question_id"])
def test_old_answer_binding_does_not_survive_modified_source_or_question(change):
    first = run([FIRST, ANSWER], controller())
    changed = deepcopy(ANSWER)
    if change == "version":
        changed["version"] = 2
    elif change == "quote":
        changed["text"] = "主要是干咳，没有痰。"
    elif change == "question_text":
        changed["responding_to"]["text"] = "什么时候开始的？"
    else:
        changed["responding_to"]["turn_id"] = "turn_other_question09"
    later = {"turn_id": "turn_story_finished4", "text": "没有了。", "version": 1}
    second = run([FIRST, changed, later], first["controller"], LiteralFixtureProvider(source=changed))
    assert slot(second)["status"] == "missing"


@pytest.mark.parametrize("status", ["missing", "unknown", "declined"])
def test_binding_never_promotes_missing_unknown_or_refused_model_state(status):
    first = run([FIRST, ANSWER], controller())
    later = {"turn_id": "turn_story_finished4", "text": "没有了。", "version": 1}
    second = run([FIRST, ANSWER, later], first["controller"], LiteralFixtureProvider(status=status))
    assert slot(second)["status"] != "known"


def test_binding_cannot_be_reused_in_unanswered_other_category():
    first = run([FIRST, ANSWER], controller())
    later = {"turn_id": "turn_story_finished4", "text": "没有了。", "version": 1}
    second = run([FIRST, ANSWER, later], first["controller"], LiteralFixtureProvider(category="relevant_history"))
    assert slot(second, "relevant_history")["status"] == "missing"


def test_bound_literal_replaces_model_summary_extra_words_instead_of_reporting_them():
    first = run([FIRST, ANSWER], controller())
    later = {"turn_id": "turn_story_finished4", "text": "没有了。", "version": 1}
    second = run([FIRST, ANSWER, later], first["controller"], LiteralFixtureProvider(summary="有白痰，测温正常"))
    assert slot(second) == slot(first)
    assert "测温正常" not in slot(second)["summary"]


def test_unasked_question_does_not_create_durable_answer_binding():
    fake = deepcopy(ANSWER)
    fake["responding_to"]["text"] = "这是一个并未问过的问题？"
    first = run([FIRST, fake], controller(), LiteralFixtureProvider(source=fake))
    later = {"turn_id": "turn_story_finished4", "text": "没有了。", "version": 1}
    second = run([FIRST, fake, later], first["controller"], LiteralFixtureProvider(source=fake))
    assert slot(second)["status"] == "missing"


def test_legacy_controller_without_binding_keeps_exact_model_wire_structure():
    control = controller()
    provider = LiteralFixtureProvider(status="missing")
    result = run([FIRST, ANSWER], control, provider)
    assert provider.last_payload["controller"] == control
    assert "grounded_answers" not in result["controller"]


@pytest.mark.parametrize("malformed", ["too_many", "duplicate", "bool_version", "extra_field", "oversize_quote"])
def test_malformed_binding_is_rejected_before_fixture_provider(malformed):
    first = run([FIRST, ANSWER], controller())
    control = deepcopy(first["controller"])
    binding = control["grounded_answers"][0]
    if malformed == "too_many":
        control["grounded_answers"] = [binding] * 9
    elif malformed == "duplicate":
        control["grounded_answers"].append(deepcopy(binding))
    elif malformed == "bool_version":
        binding["version"] = True
    elif malformed == "extra_field":
        binding["diagnosis"] = "not allowed"
    else:
        binding["quote"] = "字" * 121
    provider = LiteralFixtureProvider()
    with pytest.raises(conversation.ConversationError, match="controller_answer_invalid"):
        run([FIRST, ANSWER], control, provider)
    assert provider.last_payload is None


def test_explicit_replacement_invalidates_old_bound_answer():
    first = run([FIRST, ANSWER], controller())
    later = {"turn_id": "turn_story_correct04", "text": "刚才说错了，不是干咳，是湿咳。", "version": 1}
    second = run([FIRST, ANSWER, later], first["controller"])
    assert slot(second)["status"] == "missing"
    assert "grounded_answers" not in second["controller"]


def test_known_without_source_is_still_rejected_and_implicit_unknown_note_is_removed():
    class NoEvidenceProvider(LiteralFixtureProvider):
        def complete_json(self, system, payload):
            result = super().complete_json(system, payload)
            result["clinical_state"]["symptom_character"]["evidence_turn_ids"] = []
            return result

    with pytest.raises(conversation.ConversationError, match="model_evidence_invalid"):
        run([FIRST, ANSWER], controller(), NoEvidenceProvider())

    class FalseUnknownProvider(LiteralFixtureProvider):
        def complete_json(self, system, payload):
            result = super().complete_json(system, payload)
            result["unknowns"] = [{"text": "没有量体温", "evidence_turn_ids": [ANSWER["turn_id"]], "context_ids": []}]
            return result

    result = run([FIRST, ANSWER], controller(), FalseUnknownProvider())
    assert result["completeness"]["unknowns"] == []
    assert slot(result)["summary"] == ANSWER["text"]


def test_existing_binding_does_not_classify_a_new_unrelated_source():
    first = run([FIRST, ANSWER], controller())
    other = {"turn_id": "turn_story_sleep004", "text": "睡觉还好。", "version": 1,
             "responding_to": {"turn_id": "turn_story_question09", "text": "睡觉受影响吗？"}}
    second = run([FIRST, ANSWER, other], first["controller"], LiteralFixtureProvider(source=other))
    assert slot(second)["status"] == "missing"


def test_unsafe_model_summary_is_discarded_in_favour_of_bound_patient_quote():
    first = run([FIRST, ANSWER], controller())
    later = {"turn_id": "turn_story_finished4", "text": "没有了。", "version": 1}
    second = run([FIRST, ANSWER, later], first["controller"], LiteralFixtureProvider(summary="建议加药并做CT检查"))
    assert slot(second) == slot(first)
    assert "CT" not in slot(second)["summary"]


@pytest.mark.parametrize("field", ["reply_text", "candidate_question"])
def test_answer_binding_does_not_bypass_unsafe_reply_or_question(field):
    first = run([FIRST, ANSWER], controller())
    later = {"turn_id": "turn_story_sleep004", "text": "睡觉还好。", "version": 1}

    class UnsafeOutputProvider(LiteralFixtureProvider):
        def complete_json(self, system, payload):
            result = super().complete_json(system, payload)
            result[field] = "建议加药。" if field == "reply_text" else "可以先加药吗？"
            return result

    second = run([FIRST, ANSWER, later], first["controller"], UnsafeOutputProvider())
    assert second["action"] == "reply" and second["stop_reason"] == "model_output_blocked"
    assert second["assistant_text"] == conversation.MODEL_OUTPUT_BLOCKED_TEXT
