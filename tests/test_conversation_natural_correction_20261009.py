"""Portable source/controller regressions; authored drafts are not model quality proof."""
from copy import deepcopy
import socket

import pytest

from backend import adapter, conversation, model_client, trial_gate


QUESTION = "咳嗽的时候有痰吗，还是干咳？"
ANSWER = {
    "turn_id": "turn_natural_answer03", "text": "大多是干咳，偶尔有一点白痰。", "version": 1,
    "responding_to": {"turn_id": "turn_natural_question8", "text": "时间改好了。 " + QUESTION},
}
CORRECTION = {
    "turn_id": "turn_natural_correct4", "text": "刚才说错了，白痰是前天的，今天没有痰，主要是干咳。我没量体温。", "version": 1,
    "responding_to": {"turn_id": "turn_natural_question9", "text": "睡觉受影响吗？"},
}
FINISH = {"turn_id": "turn_natural_finished5", "text": "先说到这里，帮我整理给医生看。", "version": 1}
FACT = CORRECTION["text"].split("。", 1)[0] + "。"


@pytest.fixture(autouse=True)
def no_external_or_real_configuration(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("Only the explicit local fixture is permitted")
    monkeypatch.setattr(socket, "socket", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(adapter.Config, "from_env", staticmethod(forbidden))
    monkeypatch.setattr(conversation, "provider_from", forbidden)
    monkeypatch.setattr(model_client, "_open_request", forbidden)
    monkeypatch.setattr(model_client, "_trial_report", forbidden)
    monkeypatch.setattr(trial_gate, "authorize_request", forbidden)


def control():
    return {"asked_categories": ["symptom_character"], "closed_categories": [],
            "question_counts": {c: int(c == "symptom_character") for c in conversation.CATEGORIES},
            "asked_questions": [QUESTION], "question_count": 1, "no_new_fact_count": 0,
            "last_question_category": "symptom_character", "linked_context_ids": []}


class FixtureProvider:
    def __init__(self, *, refs, status="known", intent="correction", prior=False):
        self.refs, self.status, self.intent, self.prior = refs, status, intent, prior
        self.calls = 0

    def complete_json(self, _system, payload):
        self.calls += 1
        state = conversation._empty_state()
        state["symptom_character"] = {
            "status": self.status, "summary": "An untrusted fixture recap" if self.status == "known" else "",
            "evidence_turn_ids": self.refs if self.status != "missing" else [], "context_ids": [],
        }
        if self.prior:
            state["prior_actions_results"] = {
                "status": "known", "summary": "体温正常", "evidence_turn_ids": [CORRECTION["turn_id"]], "context_ids": [],
            }
        return {"user_intent": self.intent, "latest_turn_adds_fact": self.intent != "explicit_finish",
                "reply_text": "我会按您更正后的原话记录。", "suggested_action": "finish",
                "question_category": None, "question_importance": None, "candidate_question": "",
                "clinical_state": state, "relevant_context_ids": [], "unknowns": [], "contradictions": [], "risk_candidates": []}


def process(turns, controller, provider):
    payload = {"turns": deepcopy(turns), "controller": deepcopy(controller), "health_context": []}
    before = deepcopy(payload)
    result = conversation.conversation_turn(payload, provider)
    assert payload == before
    return result


def start(answer=ANSWER):
    return process([answer], control(), FixtureProvider(refs=[answer["turn_id"]], intent="answer"))


def symptom(result):
    return result["completeness"]["clinical_state"]["symptom_character"]


@pytest.mark.parametrize("last_category", ["symptom_character", "functional_impact"])
@pytest.mark.parametrize("refs", [[CORRECTION["turn_id"]], [ANSWER["turn_id"], CORRECTION["turn_id"]]])
def test_temporal_correction_replaces_old_answer_in_same_or_other_question(last_category, refs):
    controller = start()["controller"]
    controller["last_question_category"] = last_category
    result = process([ANSWER, CORRECTION], controller, FixtureProvider(refs=refs, prior=True))
    assert symptom(result) == {"status": "known", "summary": FACT,
                               "evidence_turn_ids": [CORRECTION["turn_id"]], "context_ids": []}
    binding = result["controller"]["grounded_answers"][0]
    assert binding["turn_id"] == ANSWER["turn_id"] and binding["responding_to"] == ANSWER["responding_to"]
    assert binding["correction"] == {
        "turn_id": CORRECTION["turn_id"], "version": 1,
        "quote": CORRECTION["text"], "responding_to": CORRECTION["responding_to"],
    }
    assert binding["correction"]["responding_to"] == CORRECTION["responding_to"]
    prior = result["completeness"]["clinical_state"]["prior_actions_results"]
    assert prior["summary"] == "我没量体温。" and "正常" not in prior["summary"]


@pytest.mark.parametrize("refs", [[CORRECTION["turn_id"]], [ANSWER["turn_id"], CORRECTION["turn_id"]]])
@pytest.mark.parametrize("legacy_controller", [False, True])
def test_finish_retains_correction_for_new_and_original_saved_controller(refs, legacy_controller):
    original = start()["controller"]
    newer = process([ANSWER, CORRECTION], original, FixtureProvider(refs=[CORRECTION["turn_id"]]))["controller"]
    result = process([ANSWER, CORRECTION, FINISH], original if legacy_controller else newer,
                     FixtureProvider(refs=refs, intent="explicit_finish", prior=True))
    assert result["action"] == "finish" and result["stop_reason"] == "user_finished"
    assert symptom(result)["summary"] == FACT
    assert result["controller"]["last_question_category"] is None
    assert result["completeness"]["clinical_state"]["prior_actions_results"]["summary"] == "我没量体温。"


def test_old_only_reference_does_not_revive_superseded_answer():
    original = start()["controller"]
    newer = process([ANSWER, CORRECTION], original, FixtureProvider(refs=[CORRECTION["turn_id"]]))["controller"]
    for controller in (original, newer):
        result = process([ANSWER, CORRECTION, FINISH], controller,
                         FixtureProvider(refs=[ANSWER["turn_id"]], intent="explicit_finish"))
        assert symptom(result)["status"] == "missing"
        assert "偶尔有一点白痰" not in symptom(result)["summary"]


@pytest.mark.parametrize("status", ["missing", "unknown", "declined"])
def test_correction_relation_never_upgrades_model_missing_unknown_or_declined(status):
    result = process([ANSWER, CORRECTION], start()["controller"],
                     FixtureProvider(refs=[CORRECTION["turn_id"]], status=status))
    assert symptom(result)["status"] != "known"


@pytest.mark.parametrize("which", ["origin", "correction"])
@pytest.mark.parametrize("field", ["version", "text", "question_id", "question_text"])
def test_editing_origin_or_correction_source_invalidates_durable_binding(which, field):
    original = start()["controller"]
    updated = process([ANSWER, CORRECTION], original, FixtureProvider(refs=[CORRECTION["turn_id"]]))["controller"]
    turns = deepcopy([ANSWER, CORRECTION, FINISH])
    turn = turns[0 if which == "origin" else 1]
    if field == "version":
        turn["version"] = 2
    elif field == "text":
        turn["text"] = "现在只想保留原始记录。"
    elif field == "question_id":
        turn["responding_to"]["turn_id"] = "turn_natural_changedQ"
    else:
        turn["responding_to"]["text"] = "这是另一个问题。"
    result = process(turns, updated, FixtureProvider(refs=[CORRECTION["turn_id"]], intent="explicit_finish"))
    assert symptom(result)["status"] == "missing"


@pytest.mark.parametrize("text", [
    "睡觉还好。", "我没量体温。", "刚才说错了，睡眠是前天的，今天没有影响。",
    "如果刚才说错了，白痰是前天的该怎么记？",
    "医生说刚才说错了，白痰是前天的。",
    "我没说刚才说错了，白痰是前天的。",
])
def test_unrelated_hypothetical_quoted_or_denied_text_cannot_refresh_answer(text):
    latest = {**CORRECTION, "text": text}
    result = process([ANSWER, latest], start()["controller"], FixtureProvider(refs=[latest["turn_id"]]))
    assert symptom(result)["status"] == "missing"
    assert not any("correction" in row for row in result["controller"].get("grounded_answers", []))


@pytest.mark.parametrize("text", [
    "刚才说错了，白痰是前天没有，今天仍没有痰。",
    "刚才说错了，白痰是我不记得什么时候的。",
    "刚才说错了，白痰是我不方便说的情况。",
])
def test_negative_unknown_and_declined_qualifications_are_never_cut_into_affirmatives(text):
    latest = {**CORRECTION, "text": text}
    result = process([ANSWER, latest], start()["controller"],
                     FixtureProvider(refs=[ANSWER["turn_id"], latest["turn_id"]]))
    if "没有" in text:
        assert symptom(result)["summary"] == text
    else:
        assert symptom(result)["status"] == "missing"
    assert symptom(result)["summary"] != ANSWER["text"]


def test_complete_dynamic_subject_handles_another_nonmedical_vocabulary():
    answer = deepcopy(ANSWER)
    answer["text"] = "大多是砂纸感，偶尔有一点棉絮感。"
    latest = {**CORRECTION, "text": "刚才说错了，棉絮感是前天的，今天没有，主要是砂纸感。"}
    result = process([answer, latest], start(answer)["controller"], FixtureProvider(refs=[latest["turn_id"]]))
    assert symptom(result)["summary"] == latest["text"]


def test_multiple_answer_anchors_do_not_authorize_a_category_by_shared_substring():
    controller = start()["controller"]
    other = deepcopy(ANSWER)
    other["turn_id"] = "turn_natural_history7"
    other["responding_to"] = {"turn_id": "turn_natural_historyQ", "text": "以前发生过吗？"}
    controller["asked_categories"].append("relevant_history")
    controller["question_counts"]["relevant_history"] = 1
    controller["asked_questions"].append("以前发生过吗？")
    controller["grounded_answers"].append({"category": "relevant_history", "turn_id": other["turn_id"],
        "version": 1, "quote": other["text"], "responding_to": other["responding_to"], "question": "以前发生过吗？"})
    result = process([ANSWER, other, CORRECTION], controller, FixtureProvider(refs=[ANSWER["turn_id"], CORRECTION["turn_id"]]))
    assert symptom(result)["status"] == "missing"


def test_two_target_subjects_in_same_correction_remain_unassigned():
    latest = {**CORRECTION, "text": "刚才说错了，白痰是前天的，干咳是昨天的。"}
    result = process([ANSWER, latest], start()["controller"], FixtureProvider(refs=[ANSWER["turn_id"], latest["turn_id"]]))
    assert symptom(result)["status"] == "missing"


@pytest.mark.parametrize("source", ["我没量血压。", "还没有测过数值。", "我尚未做检查。", "未查报告。"])
def test_unperformed_action_preserves_literal_source_not_a_normal_result(source):
    latest = {**CORRECTION, "text": source}
    provider = FixtureProvider(refs=[], status="missing", prior=True)
    result = process([latest], control(), provider)
    assert result["completeness"]["clinical_state"]["prior_actions_results"]["summary"] == source


@pytest.mark.parametrize("source", ["如果我没测数值怎么办？", "医生没量血压。", "我不知道有没有测过数值。", "我不想说有没有检查。"])
def test_unperformed_action_does_not_invent_a_result_from_question_or_third_party(source):
    latest = {**CORRECTION, "text": source}
    result = process([latest], control(), FixtureProvider(refs=[], status="missing", prior=True))
    assert result["completeness"]["clinical_state"]["prior_actions_results"]["status"] == "missing"


def test_correction_drops_whole_changed_clause_instead_of_leaving_orphan_particles():
    old = {"turn_id": "turn_natural_duration1", "text": "我咳嗽两天了，晚上明显些。", "version": 1}
    latest = {"turn_id": "turn_natural_duration2", "text": "我刚才说错了，不是两天，是三天。", "version": 1}
    state = conversation._empty_state()
    state["onset_course"] = {"status": "known", "summary": "untrusted", "evidence_turn_ids": [old["turn_id"], latest["turn_id"]], "context_ids": []}
    conversation._ground_clinical_state(state, [old, latest], [], conversation._controller_state({}), "correction")
    assert state["onset_course"]["summary"] == "晚上明显些；三天"
    assert "了；" not in state["onset_course"]["summary"]


@pytest.mark.parametrize("malformed", ["extra", "bool_version", "old_id", "oversize", "responding_extra"])
def test_malformed_optional_correction_is_rejected_before_provider(malformed):
    controller = start()["controller"]
    correction = {"turn_id": CORRECTION["turn_id"], "version": 1, "quote": CORRECTION["text"], "responding_to": deepcopy(CORRECTION["responding_to"])}
    if malformed == "extra":
        correction["summary"] = "not accepted"
    elif malformed == "bool_version":
        correction["version"] = True
    elif malformed == "old_id":
        correction["turn_id"] = ANSWER["turn_id"]
    elif malformed == "oversize":
        correction["quote"] = "字" * 121
    else:
        correction["responding_to"]["category"] = "symptom_character"
    controller["grounded_answers"][0]["correction"] = correction
    provider = FixtureProvider(refs=[CORRECTION["turn_id"]])
    with pytest.raises(conversation.ConversationError, match="controller_answer_invalid"):
        process([ANSWER, CORRECTION], controller, provider)
    assert provider.calls == 0
