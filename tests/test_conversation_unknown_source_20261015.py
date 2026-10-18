"""Synthetic regressions for preserving scoped uncertainty without promoting questions."""
import importlib.util
from pathlib import Path

from backend.conversation import CATEGORIES, _source_excerpt, conversation_turn

_PROVENANCE_SPEC = importlib.util.spec_from_file_location(
    "conversation_answer_provenance_fixture", Path(__file__).with_name("test_conversation_answer_provenance_20261009.py"),
)
_PROVENANCE = importlib.util.module_from_spec(_PROVENANCE_SPEC)
_PROVENANCE_SPEC.loader.exec_module(_PROVENANCE)
(BOUND_ANSWER, BOUND_FIRST, LiteralFixtureProvider, bound_controller, run_bound, bound_slot) = (
    _PROVENANCE.ANSWER,
    _PROVENANCE.FIRST,
    _PROVENANCE.LiteralFixtureProvider,
    _PROVENANCE.controller,
    _PROVENANCE.run,
    _PROVENANCE.slot,
)


def empty_state():
    return {key: {"status": "missing", "summary": "", "evidence_turn_ids": [], "context_ids": []}
            for key in CATEGORIES}


class SourceAssessmentProvider:
    c = type("Config", (), {"model": "synthetic-uncertainty-regression"})()

    def __init__(self, *, history="known", unknown=True):
        self.history = history
        self.unknown = unknown

    def complete_json(self, _system, payload):
        source = payload["turns"][-1]
        state = empty_state()
        state["main_complaint"] = {
            "status": "known", "summary": "手腕疼",
            "evidence_turn_ids": [source["turn_id"]], "context_ids": [],
        }
        if self.history == "known":
            state["relevant_history"] = {
                "status": "known", "summary": source["text"],
                "evidence_turn_ids": [source["turn_id"]], "context_ids": [],
            }
        unknowns = ([{"text": source["text"], "evidence_turn_ids": [source["turn_id"]], "context_ids": []}]
                    if self.unknown else [])
        return {
            "user_intent": "health_fact", "latest_turn_adds_fact": True,
            "reply_text": "我明白了，继续帮您按原话记录。", "suggested_action": "ask",
            "question_category": "onset_course", "question_importance": "essential",
            "candidate_question": "大概什么时候开始的？", "clinical_state": state,
            "relevant_context_ids": [], "unknowns": unknowns, "contradictions": [],
        }


def run_source(text, *, history="known"):
    source = {"turn_id": "turn_synthetic_20261015_001", "text": text, "version": 1}
    result = conversation_turn({"turns": [source]}, SourceAssessmentProvider(history=history))
    return source, result


def test_history_question_with_uncertainty_is_not_a_known_history_fact():
    text = "手腕疼。以前左手腕有没有这样过，我记不太清，印象里没有特别明显的一次。"
    source, result = run_source(text)
    state = result["completeness"]["clinical_state"]

    assert state["main_complaint"]["status"] == "known"
    assert state["relevant_history"]["status"] == "missing"
    assert all("有没有这样过" not in item["summary"] for item in state.values())
    unknown = result["completeness"]["unknowns"]
    assert len(unknown) == 1
    assert unknown[0]["text"] == "以前左手腕有没有这样过，我记不太清，印象里没有特别明显的一次。"
    assert unknown[0]["evidence_turn_ids"] == [source["turn_id"]]
    assert source["text"] == text  # The original turn remains untouched.
    assert result["stop_reason"] != "user_finished"


def test_fever_uncertainty_keeps_its_measurement_context_and_other_known_fact():
    text = "手腕疼。有没有发烧我不确定，家里没有量过体温。"
    source, result = run_source(text, history="missing")
    state = result["completeness"]["clinical_state"]

    assert state["main_complaint"]["status"] == "known"
    assert state["relevant_history"]["status"] == "missing"
    assert result["completeness"]["unknowns"] == [{
        "text": "有没有发烧我不确定，家里没有量过体温。",
        "evidence_turn_ids": [source["turn_id"]], "context_ids": [],
    }]
    assert "relevant_history" not in result["controller"]["closed_categories"]
    assert result["stop_reason"] != "user_finished"
    assert result["action"] == "ask"
    assert source["text"] == text


def test_uncertainty_after_plain_past_assertion_removes_that_clause_from_known_history():
    text = "手腕疼。以前左手腕也疼过，我记不太清。"
    source, result = run_source(text)
    state = result["completeness"]["clinical_state"]

    assert state["main_complaint"]["status"] == "known"
    assert state["relevant_history"]["status"] == "missing"
    assert result["completeness"]["unknowns"] == [{
        "text": "以前左手腕也疼过，我记不太清。",
        "evidence_turn_ids": [source["turn_id"]], "context_ids": [],
    }]


def test_uncertain_absence_is_not_kept_as_a_known_symptom_clause():
    text = "手腕疼。没有发烧吧，我不确定。"
    source, result = run_source(text, history="missing")
    state = result["completeness"]["clinical_state"]

    assert state["main_complaint"]["status"] == "known"
    assert all("没有发烧吧" not in item["summary"] for item in state.values())
    assert result["completeness"]["unknowns"] == [{
        "text": "没有发烧吧，我不确定。",
        "evidence_turn_ids": [source["turn_id"]], "context_ids": [],
    }]


def test_objectless_uncertainty_covers_the_whole_sentence_but_not_prior_sentence():
    text = "手腕疼。以前左手腕也疼过，差不多也是这样，我记不太清。"
    source, result = run_source(text)
    state = result["completeness"]["clinical_state"]

    assert state["main_complaint"]["status"] == "known"
    assert "手腕疼" in state["main_complaint"]["summary"]
    assert state["relevant_history"]["status"] == "missing"
    assert result["completeness"]["unknowns"] == [{
        "text": "以前左手腕也疼过，差不多也是这样，我记不太清。",
        "evidence_turn_ids": [source["turn_id"]], "context_ids": [],
    }]


def test_uncertainty_with_its_own_clinical_object_does_not_swallow_prior_fact():
    text = "手腕疼，有没有发烧我不确定。"
    source, result = run_source(text, history="missing")
    state = result["completeness"]["clinical_state"]

    assert state["main_complaint"]["status"] == "known"
    assert "手腕疼" in state["main_complaint"]["summary"]
    assert all("发烧" not in item["summary"] for item in state.values())
    assert result["completeness"]["unknowns"] == [{
        "text": "有没有发烧我不确定。",
        "evidence_turn_ids": [source["turn_id"]], "context_ids": [],
    }]


def test_explicit_past_history_still_remains_a_grounded_fact():
    text = "手腕疼。以前也有过类似发作。"
    _source, result = run_source(text, history="known")
    history = result["completeness"]["clinical_state"]["relevant_history"]

    assert history["status"] == "known"
    assert history["summary"] == "以前也有过类似发作。"


def test_history_question_condition_and_corrected_history_are_not_facts():
    assert _source_excerpt("以前有没有出现过类似情况？", "relevant_history") == ""
    assert _source_excerpt("如果以前也有类似情况，可能是老问题。", "relevant_history") == ""
    assert _source_excerpt("不是以前有过，是这次第一次。", "relevant_history") == ""


def test_bound_short_answer_uncertain_is_not_promoted_to_known():
    uncertain = {
        "turn_id": "turn_story_unknown004", "text": "不确定", "version": 1,
        "responding_to": {"turn_id": "turn_story_question08", "text": BOUND_ANSWER["responding_to"]["text"]},
    }

    class UncertainBoundProvider(LiteralFixtureProvider):
        def complete_json(self, system, payload):
            result = super().complete_json(system, payload)
            result["unknowns"] = [{"text": uncertain["text"], "evidence_turn_ids": [uncertain["turn_id"]], "context_ids": []}]
            return result

    result = run_bound([BOUND_FIRST, uncertain], bound_controller(), UncertainBoundProvider(source=uncertain))

    assert bound_slot(result)["status"] != "known"
    assert result["completeness"]["unknowns"] == [{
        "text": "不确定", "evidence_turn_ids": [uncertain["turn_id"]], "context_ids": [],
    }]


def test_prompt_requests_one_specific_followup_without_symptom_lists():
    from backend.conversation import SYSTEM_PROMPT

    assert "一次只问一种具体表现" in SYSTEM_PROMPT
    assert "不要把多种症状用“、/或者”并列" in SYSTEM_PROMPT


def test_uncertain_negative_answer_does_not_close_its_actual_question():
    question = '除了咳嗽，有没有发烧？'
    answer = {'turn_id': 'turn_root_uncertain_a', 'text': '没有发烧吧，我不确定。', 'version': 1,
              'responding_to': {'turn_id': 'turn_root_question_a', 'text': question}}
    control = bound_controller()
    control.update(asked_categories=['main_complaint', 'associated_symptoms'],
                   last_question_category='associated_symptoms',
                   asked_questions=['您今天最难受的是哪里？', question])
    control['question_counts'] = {key: int(key in control['asked_categories']) for key in CATEGORIES}
    result = run_bound([BOUND_FIRST, answer], control,
                       LiteralFixtureProvider(category='associated_symptoms', source=answer))
    assert bound_slot(result, 'associated_symptoms')['status'] != 'known'
