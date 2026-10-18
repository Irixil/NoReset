"""Synthetic adversarial cases at the public conversation boundary."""
import pytest

from backend.conversation import (
    MODEL_OUTPUT_BLOCKED_TEXT, _empty_state, _ground_clinical_state,
    _source_excerpt, _source_summary,
)
from tests.test_conversation import model_draft, opening_controller, run, turn


@pytest.mark.parametrize(
    "reply",
    [
        "您得了肺炎。",
        "这是肺炎。",
        "诊断为关节炎。",
        "您患有糖尿病。",
        "每天服用两片阿司匹林。",
        "把胰岛素增加到十单位。",
        "先去做血常规。",
        "请做CT检查。",
        "每天服用 2 mg 阿司匹林。",
        "您的情况很安全，没有问题。",
    ],
)
def test_direct_medical_conclusions_and_instructions_never_reach_user(reply):
    class AdversarialProvider:
        def complete_json(self, _system, payload):
            return model_draft(payload["turns"], reply_text=reply)

    result = run([turn(1, "这是完全虚构测试，我头疼。")], provider=AdversarialProvider())

    assert result["assistant_text"] == MODEL_OUTPUT_BLOCKED_TEXT
    assert result["action"] == "reply"
    assert result["stop_reason"] == "model_output_blocked"
    assert result["completeness"]["clinical_state"]["main_complaint"]["summary"] == "我头疼。"


@pytest.mark.parametrize(
    "complaint",
    [
        "我左膝有些疼。",
        "我这两天一直咳嗽。",
        "我这两天一直拉肚子。",
        "我这三天便秘。",
        "我手指发麻。",
        "我最近耳鸣。",
        "我这两天浑身无力。",
        "我这两天失眠。",
        "我最近看不清。",
        "我最近尿频。",
        "我皮肤一直痒。",
        "我最近吞咽困难。",
    ],
)
def test_source_grounded_complaint_does_not_depend_on_a_symptom_keyword(complaint):
    class SourceGroundedProvider:
        def complete_json(self, _system, payload):
            return model_draft(
                payload["turns"], question_category="functional_impact",
                candidate_question="这个情况现在对您的日常活动有什么影响？",
            )

    result = run([turn(1, complaint)], provider=SourceGroundedProvider())

    item = result["completeness"]["clinical_state"]["main_complaint"]
    assert item["status"] == "known"
    assert item["summary"] == complaint
    assert item["evidence_turn_ids"] == ["turn_00000001"]
    assert result["action"] == "ask"
    assert result["assistant_text"].count("？") == 1


@pytest.mark.parametrize("question_count", [8, 11])
@pytest.mark.parametrize("importance", ["useful", "optional"])
def test_patient_question_does_not_bypass_followup_fatigue_limit(question_count, importance):
    reply = "我不能仅凭聊天判断原因，会把您说的情况如实整理。"

    class LowValueFollowupProvider:
        def complete_json(self, _system, payload):
            return model_draft(
                payload["turns"], user_intent="patient_question", latest_turn_adds_fact=False,
                reply_text=reply, question_category="functional_impact",
                question_importance=importance,
                candidate_question="这个情况现在对您的日常活动有什么影响？",
            )

    controller = opening_controller(question_count=question_count)
    result = run([turn(1, "我头疼，这是怎么回事？")], controller, provider=LowValueFollowupProvider())

    assert result["action"] == "reply"
    assert result["assistant_text"] == reply
    assert result["controller"]["question_count"] == question_count


def test_explaining_a_medical_record_is_not_a_new_diagnosis():
    reply = "这是病历记录，用来说明您已经说过的情况。"

    class RecordExplanationProvider:
        def complete_json(self, _system, payload):
            return model_draft(payload["turns"], reply_text=reply)

    result = run([turn(1, "我头疼。")], provider=RecordExplanationProvider())

    assert result["action"] == "ask"
    assert result["assistant_text"].startswith(reply)
    assert result["stop_reason"] is None


@pytest.mark.parametrize("category", ["onset_course", "aggravating_relieving"])
def test_indirect_request_is_not_promoted_to_clinical_fact(category):
    source = "请说说当时是哪天、怎样缓解的，"
    assert _source_excerpt(source, category) == ""


@pytest.mark.parametrize(
    ("category", "source", "fact"),
    [
        ("onset_course", "我从昨天开始腿疼，休息后会缓解。请说说当时是哪天，后来怎样缓解的。", "我从昨天开始腿疼"),
        ("aggravating_relieving", "我从昨天开始腿疼，休息后会缓解。请说说当时是哪天，后来怎样缓解的。", "休息后会缓解"),
        ("onset_course", "请说说当时是哪天，昨天开始疼的。", "昨天开始疼的"),
        ("aggravating_relieving", "请说说怎样缓解的，休息后能缓解。", "休息后能缓解"),
        ("onset_course", "不是昨天，是前天开始的；请说说当时是哪天。", "前天开始的"),
        ("onset_course", "昨天", "昨天"),
        ("aggravating_relieving", "我没有感觉活动会加重。", "活动会加重"),
    ],
)
def test_request_filter_keeps_adjacent_facts_corrections_and_negations(category, source, fact):
    assert fact in _source_excerpt(source, category)


def test_request_filter_keeps_explicit_unknown_as_unknown_evidence():
    source = "我不记得是哪天开始的。请说说当时是哪天，后来怎样缓解的。"
    assert "我不记得是哪天开始的" in _source_excerpt(source, "unknown")
    assert "请说说" not in _source_excerpt(source, "unknown")


def test_request_filter_does_not_remove_selected_history_context():
    context = {"context_id": "context_00000001", "text": "用户确认：以前有类似经历。"}
    assert _source_summary([], [context["context_id"]], [], [context], category="relevant_history") == context["text"]


@pytest.mark.parametrize(
    ("category", "source", "fact"),
    [
        ("functional_impact", "怎么也睡不好。", "怎么也睡不好"),
        ("functional_impact", "什么都吃不下。", "什么都吃不下"),
        ("unknown", "什么时候开始我也不记得了。", "什么时候开始我也不记得了"),
    ],
)
def test_question_words_inside_clear_statements_are_not_filtered(category, source, fact):
    assert fact in _source_excerpt(source, category)


def test_request_clause_cannot_be_rebound_as_a_short_answer():
    question = "这种不舒服大概什么时候开始？"
    source = "请说说当时是哪天、怎样缓解的，"
    latest = {
        "turn_id": "turn_patient_0001", "version": 1, "text": source,
        "responding_to": {"turn_id": "turn_assistant_0001", "text": question},
    }
    state = _empty_state()
    state["onset_course"] = {
        "status": "known", "summary": source,
        "evidence_turn_ids": [latest["turn_id"]], "context_ids": [],
    }
    controller = {
        "last_question_category": "onset_course", "asked_categories": ["onset_course"],
        "asked_questions": [question], "question_counts": {"onset_course": 1},
        "grounded_answers": [],
    }

    _ground_clinical_state(state, [latest], [], controller, "answer")

    assert state["onset_course"]["status"] == "missing"
    assert not controller.get("grounded_answers")


def test_request_only_main_complaint_cannot_use_literal_source_fallback():
    source = "请说说膝盖疼具体是什么感觉"
    latest = {"turn_id": "turn_patient_0002", "version": 1, "text": source}
    state = _empty_state()
    state["main_complaint"] = {
        "status": "known", "summary": source,
        "evidence_turn_ids": [latest["turn_id"]], "context_ids": [],
    }

    _ground_clinical_state(state, [latest], [], {}, "health_fact")

    assert state["main_complaint"]["status"] == "missing"
    assert not state["main_complaint"]["summary"]


def test_old_request_quote_cannot_bypass_grounded_answer_validation():
    question = "膝盖疼具体是什么感觉？"
    source = "请说说膝盖疼具体是什么感觉"
    latest = {
        "turn_id": "turn_patient_0003", "version": 1, "text": source,
        "responding_to": {"turn_id": "turn_assistant_0001", "text": question},
    }
    state = _empty_state()
    state["main_complaint"] = {
        "status": "known", "summary": source,
        "evidence_turn_ids": [latest["turn_id"]], "context_ids": [],
    }
    controller = {
        "last_question_category": "main_complaint", "asked_categories": ["main_complaint"],
        "asked_questions": [question], "question_counts": {"main_complaint": 1},
        "grounded_answers": [{
            "category": "main_complaint", "turn_id": latest["turn_id"], "version": 1,
            "quote": source, "responding_to": dict(latest["responding_to"]), "question": question,
        }],
    }

    _ground_clinical_state(state, [latest], [], controller, "answer")

    assert state["main_complaint"]["status"] == "missing"
    assert not controller.get("grounded_answers")
