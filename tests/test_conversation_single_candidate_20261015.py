"""Synthetic controller checks; no live provider or clinical-quality claim."""
from copy import deepcopy
import socket

import pytest

from backend import adapter, conversation as c, model_client


FIRST = {"turn_id": "turn_single_source_20261015", "version": 1,
         "text": "我左手腕这几天有点疼，大概四五天了。"}
QUESTION = "手腕疼的地方有没有肿？"


@pytest.fixture(autouse=True)
def offline_only(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError("Only the explicit synthetic provider is permitted")
    monkeypatch.setattr(socket, "create_connection", denied)
    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(adapter.Config, "from_env", staticmethod(denied))
    monkeypatch.setattr(c, "provider_from", denied)
    monkeypatch.setattr(model_client, "_open_request", denied)


class Draft:
    def __init__(self, question=QUESTION, answer_status="known"):
        self.question, self.answer_status = question, answer_status

    def complete_json(self, _system, payload):
        turns = payload["turns"]
        state = c._empty_state()
        state["main_complaint"] = {"status": "known", "summary": turns[0]["text"],
                                   "evidence_turn_ids": [turns[0]["turn_id"]], "context_ids": []}
        unknowns = []
        if len(turns) > 1:
            answer = turns[-1]
            state["associated_symptoms"] = {"status": self.answer_status,
                "summary": answer["text"], "evidence_turn_ids": [answer["turn_id"]], "context_ids": []}
            if self.answer_status == "unknown":
                unknowns = [{"text": answer["text"], "evidence_turn_ids": [answer["turn_id"]], "context_ids": []}]
        return {"user_intent": "explicit_finish" if turns[-1]["text"] == "没有" else "answer",
                "latest_turn_adds_fact": True, "reply_text": "按您说的原话记录。",
                "suggested_action": "ask", "question_category": "associated_symptoms",
                "question_importance": "useful", "candidate_question": self.question,
                "clinical_state": state, "unknowns": unknowns, "contradictions": [], "relevant_context_ids": []}


def run(turns=None, controller=None, provider=None):
    payload = {"turns": deepcopy(turns or [FIRST]), "controller": deepcopy(controller or {}), "health_context": []}
    original = deepcopy(payload)
    result = c.conversation_turn(payload, provider or Draft())
    assert payload == original
    return result


def test_current_site_question_is_not_a_patient_fact():
    result = run()
    assert result["action"] == "ask" and result["assistant_text"].endswith(QUESTION)
    assert result["controller"]["asked_questions"][-1] == QUESTION
    assert result["completeness"]["clinical_state"]["associated_symptoms"]["status"] == "missing"


@pytest.mark.parametrize("target", ["胸口疼", "皮肤变红"])
def test_literal_anchored_single_question_is_not_limited_to_old_symptom_list(target):
    source = {**FIRST, "text": "我咳嗽三天了。"}
    question = f"除了咳嗽，这几天有没有{target}？"
    result = run([source], provider=Draft(question))
    assert result["action"] == "ask" and result["assistant_text"].endswith(question)
    assert result["completeness"]["clinical_state"]["associated_symptoms"]["status"] == "missing"


def test_denied_complaint_does_not_authorize_a_painful_site_premise():
    result = run([{**FIRST, "text": "我没有手腕疼。"}])
    assert result["action"] != "ask"
    assert QUESTION not in result["assistant_text"]


@pytest.mark.parametrize("question", [
    "脚踝疼的地方有没有肿？", "手腕疼的地方有没有肿，同时发红？",
    "手腕疼的地方有没有肿和发红？", "手腕疼的地方有没有肿或者发红？",
    "手腕疼的地方有没有肿，另外有没有麻？", "手腕疼的地方有没有骨折？",
    "手腕什么时候会胸口疼？", "手腕什么时候会胸口疼，同时喘不上气？",
    "手腕疼的地方有没有肿、发红或者摸着发热？",
    "手腕疼的地方有没有头晕恶心？",
    "手腕疼的地方有没有银行卡密码？",
])
def test_unanchored_compound_or_presumed_symptom_does_not_create_question(question):
    result = run(provider=Draft(question))
    assert result["action"] != "ask"
    assert question not in result["assistant_text"]
    assert result["controller"]["question_count"] == 0


@pytest.mark.parametrize("answer,status", [("没有", "known"), ("有", "known"), ("不确定", "unknown")])
def test_short_answer_is_bound_to_actual_new_question(answer, status):
    first = run()
    assert first["action"] == "ask"
    turn = {"turn_id": "turn_single_answer_20261015", "version": 1, "text": answer,
            "responding_to": {"turn_id": "turn_single_asked_20261015", "text": first["assistant_text"]}}
    result = run([FIRST, turn], first["controller"], Draft(answer_status=status))
    assert result["stop_reason"] != "user_finished"
    item = result["completeness"]["clinical_state"]["associated_symptoms"]
    if status == "known":
        assert item["status"] == "known" and item["summary"] == answer
        binding = result["controller"]["grounded_answers"][0]
        assert binding["quote"] == answer and binding["question"] == QUESTION
        assert binding["responding_to"] == turn["responding_to"]
    else:
        assert item["status"] != "known"
        assert result["completeness"]["unknowns"][0]["text"] == answer
    assert result["controller"]["question_count"] == first["controller"]["question_count"]


def test_edited_answer_invalidates_old_yes_no_binding():
    first = run()
    answer = {"turn_id": "turn_single_answer_20261015", "version": 1, "text": "没有",
              "responding_to": {"turn_id": "turn_single_asked_20261015", "text": first["assistant_text"]}}
    result = run([FIRST, answer], first["controller"])
    assert result["controller"].get("grounded_answers")
    edited = {**answer, "version": 2, "text": "不确定"}
    result = run([FIRST, edited], result["controller"], Draft(answer_status="known"))
    assert not result["controller"].get("grounded_answers")
    assert result["completeness"]["clinical_state"]["associated_symptoms"]["status"] != "known"


@pytest.mark.parametrize("boundary", ["repeat", "closed", "fatigue", "hard_limit"])
def test_new_single_candidate_keeps_existing_limits(boundary):
    controller = run()["controller"]
    if boundary == "closed":
        controller["closed_categories"] = ["associated_symptoms"]
    elif boundary == "fatigue":
        controller["asked_questions"] = []
        controller["question_count"] = 8
    elif boundary == "hard_limit":
        controller["asked_questions"] = []
        controller["question_count"] = 12
    result = run(controller=controller)
    assert result["action"] != "ask"
    assert result["controller"]["question_count"] == controller["question_count"]
