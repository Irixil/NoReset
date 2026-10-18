"""Literal-source regressions, not a claim of clinical/model accuracy."""
from copy import deepcopy
import socket

import pytest

from backend import conversation


FACT = "昨晚翻身时左手腕疼醒过一次"
OLD = "晚上睡觉暂时还没受什么影响"


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("This regression is offline")
    monkeypatch.setattr(socket, "socket", forbidden)
    monkeypatch.setattr(conversation, "provider_from", forbidden)


def turn(index, text):
    return {"turn_id": f"turn_literal_func_{index:03}", "text": text, "version": 1}


class LiteralDraft:
    def __init__(self, summary, refs, status="known", intent="health_fact"):
        self.summary, self.refs, self.status, self.intent = summary, refs, status, intent

    def complete_json(self, _system, _payload):
        state = conversation._empty_state()
        state["functional_impact"] = {
            "status": self.status, "summary": self.summary if self.status == "known" else "",
            "evidence_turn_ids": self.refs if self.status != "missing" else [], "context_ids": [],
        }
        return {"user_intent": self.intent, "latest_turn_adds_fact": True,
                "reply_text": "我会保留您说的原话。", "suggested_action": "finish",
                "question_category": None, "question_importance": None, "candidate_question": "",
                "clinical_state": state, "relevant_context_ids": [], "unknowns": [], "contradictions": []}


def process(turns, summary=FACT, refs=None, **kwargs):
    payload = {"turns": deepcopy(turns), "controller": {}, "health_context": []}
    before = deepcopy(payload)
    result = conversation.conversation_turn(payload, LiteralDraft(
        summary, refs if refs is not None else [turns[-1]["turn_id"]], **kwargs))
    assert payload == before
    return result["completeness"]["clinical_state"]["functional_impact"]


@pytest.mark.parametrize("text", [FACT, "今早握筷时只能改用另一边", "昨晚没有疼醒过", "前天写字时不得不中途停笔",
                                 "昨晚只睡了3.5小时", "前天没有，昨晚翻身时左手腕疼醒过一次"])
def test_full_literal_function_outside_keyword_inventory_is_retained(text):
    state = process([turn(1, text + "。")], text)
    assert state["status"] == "known"
    assert text in state["summary"]
    assert state["evidence_turn_ids"] == [turn(1, "")["turn_id"]]


def test_unique_literal_correction_keeps_new_function_and_unchanged_function():
    original = turn(1, "最近端碗和开门都得慢一点，有时会换另一只手。" + OLD + "。")
    correction = turn(2, "更正一下，刚才说" + OLD + "不准确，" + FACT + "。")
    state = process([original, correction], FACT, [original["turn_id"], correction["turn_id"]], intent="correction")
    assert FACT in state["summary"]
    assert "端碗和开门" in state["summary"] and "换另一只手" in state["summary"]
    assert OLD not in state["summary"]
    assert set(state["evidence_turn_ids"]) == {original["turn_id"], correction["turn_id"]}


@pytest.mark.parametrize("source", [
    "没有" + FACT + "。", "不确定是不是" + FACT + "。", FACT + "，我不记得了。",
    "如果" + FACT + "，应该怎么办？", "如果是这样，" + FACT + "。",
    "医生说，" + FACT + "。", "我妈妈" + FACT + "。", "我妈妈说，" + FACT + "。",
    FACT + "吗？", "请解释" + FACT + "的意思。", "假设" + FACT + "。",
    "我不想说，" + FACT + "。",
    "前天没有，" + FACT + "。",
])
def test_model_cannot_drop_source_qualifiers_or_speaker(source):
    state = process([turn(1, source)])
    assert FACT not in state["summary"]


@pytest.mark.parametrize("summary", ["昨晚翻身时左手腕疼醒过两次", "左手腕疼醒过一次", "睡眠严重受影响"])
def test_model_rewording_or_partial_clause_cannot_become_fact(summary):
    state = process([turn(1, FACT + "。")], summary)
    assert state["status"] == "missing" and not state["summary"]


def test_other_source_id_cannot_supply_the_literal_clause():
    state = process([turn(1, "左手腕有点酸。"), turn(2, FACT + "。")], refs=[turn(1, "")["turn_id"]])
    assert state["status"] == "missing"


@pytest.mark.parametrize("status", ["missing", "unknown", "declined"])
def test_missing_or_uncertain_classification_is_not_promoted(status):
    state = process([turn(1, FACT + "。")], status=status)
    assert state["status"] != "known"


@pytest.mark.parametrize("old", ["晚上睡觉没受影响", OLD])
def test_unmatched_or_duplicate_correction_stays_pending(old):
    turns = [turn(1, OLD + "。"), turn(2, OLD + "。"),
             turn(3, "更正一下，刚才说" + old + "不准确，" + FACT + "。")]
    state = process(turns, intent="correction")
    assert state["status"] == "missing" and not state["summary"]


def test_retired_literal_clause_cannot_be_revived_by_old_model_reference():
    original = turn(1, FACT + "。")
    correction = turn(2, "更正一下，刚才说" + FACT + "不准确，昨晚没有疼醒过。")
    state = process([original, correction], refs=[original["turn_id"]], intent="correction")
    assert FACT not in state["summary"]


def test_confirmed_versioned_text_keeps_new_function_on_finish():
    original = {**turn(1, "最近端碗和开门都得慢一点。" + FACT + "。"), "version": 2}
    state = process([original, turn(2, "先说到这里。")], refs=[original["turn_id"]], intent="explicit_finish")
    assert FACT in state["summary"] and "端碗和开门" in state["summary"]


def test_bounded_correction_parser_cannot_truncate_a_later_uncertainty():
    original = turn(1, OLD + "。")
    correction = turn(2, "更正一下，刚才说" + OLD + "不准确，" + FACT + "，" + "那天的事情" * 30 + "，我不记得了。")
    assert conversation._literal_function_excerpts(correction["turn_id"], FACT, [original, correction]) == []

