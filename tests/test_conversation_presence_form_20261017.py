"""Offline checks for sourced single yes/no questions; no provider access."""
from copy import deepcopy
import socket

import pytest

from backend import conversation as c, model_client


QUESTION = "咳嗽的时候有痰吗？"
SOURCE = {"turn_id": "turn_presence_source_20261017", "version": 1,
          "text": "我咳嗽两天了，晚上明显些。"}


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError("offline only")
    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(model_client, "_open_request", denied)


class Draft:
    def __init__(self, question=QUESTION):
        self.question = question

    def complete_json(self, _system, payload):
        first, last = payload["turns"][0], payload["turns"][-1]
        state = c._empty_state()
        state["main_complaint"] = {"status": "known", "summary": first["text"],
                                  "evidence_turn_ids": [first["turn_id"]], "context_ids": []}
        if len(payload["turns"]) > 1:
            state["symptom_character"] = {"status": "known", "summary": last["text"],
                                         "evidence_turn_ids": [last["turn_id"]], "context_ids": []}
        return {"user_intent": "health_fact", "latest_turn_adds_fact": True,
                "reply_text": "您说的原话已经保留。", "suggested_action": "ask",
                "question_category": "symptom_character", "question_importance": "essential",
                "candidate_question": self.question, "clinical_state": state,
                "relevant_context_ids": [], "unknowns": [], "contradictions": []}


def run(question=QUESTION, turns=None, controller=None):
    body = {"turns": deepcopy(turns or [SOURCE]), "controller": deepcopy(controller or {}),
            "health_context": []}
    before = deepcopy(body)
    result = c.conversation_turn(body, Draft(question))
    assert body == before
    return result


def test_single_original_question_is_displayed_without_becoming_a_patient_fact():
    result = run()
    assert result["action"] == "ask"
    assert result["assistant_text"].endswith(QUESTION)
    assert result["controller"]["asked_questions"] == [QUESTION]
    assert result["completeness"]["clinical_state"]["symptom_character"]["status"] == "missing"
    assert all("痰" not in item["summary"] for item in result["completeness"]["clinical_state"].values())


@pytest.mark.parametrize("question", [
    "腿疼的时候有痰吗？", "咳嗽的时候有痰和发热吗？", "咳嗽的时候有痰、发热吗？",
    "咳嗽的时候有痰或者发热吗？", "咳嗽的时候有头晕恶心吗？",
    "咳嗽的时候有肺炎吗？", "咳嗽的时候有服药吗？",
    "如果咳嗽的时候有痰吗？", "拿东西时有肿和发热吗？",
])
def test_mismatched_compound_and_diagnostic_questions_remain_blocked(question):
    result = run(question)
    assert result["action"] != "ask"
    assert result["controller"]["asked_questions"] == []


def test_denied_source_does_not_authorize_question_premise():
    assert run(turns=[{**SOURCE, "text": "我没有咳嗽。"}])["action"] != "ask"


@pytest.mark.parametrize("answer", ["没有", "有"])
def test_short_answer_keeps_its_original_question_binding(answer):
    first = run()
    turn = {"turn_id": "turn_presence_answer_20261017", "version": 1, "text": answer,
            "responding_to": {"turn_id": "turn_presence_question_20261017", "text": first["assistant_text"]}}
    result = run(turns=[SOURCE, turn], controller=first["controller"])
    assert result["stop_reason"] != "user_finished"
    assert result["completeness"]["clinical_state"]["symptom_character"]["summary"] == answer
    binding = result["controller"]["grounded_answers"][0]
    assert binding["question"] == QUESTION and binding["quote"] == answer
    assert binding["responding_to"] == turn["responding_to"]


def test_repeated_question_is_not_asked_again():
    first = run()
    result = run(controller=first["controller"])
    assert result["action"] != "ask"
    assert result["controller"]["question_count"] == first["controller"]["question_count"]
