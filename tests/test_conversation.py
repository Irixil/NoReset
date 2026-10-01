import pytest

from backend.adapter import MockProvider
from backend.conversation import (
    CATEGORIES,
    ConversationError,
    DANGER_REMINDER,
    FINISH_TEXT,
    MAX_QUESTIONS,
    MODEL_OUTPUT_BLOCKED_TEXT,
    PROMPT_VERSION,
    _source_excerpt,
    conversation_turn,
)


def turn(number, text):
    return {"turn_id": f"turn_0000000{number}", "text": text}


def context(number, category, text):
    return {"context_id": f"context_{number:08d}", "category": category, "text": text, "source": "user_confirmed"}


def opening_controller(**changes):
    counts = {category: 0 for category in CATEGORIES}
    counts["main_complaint"] = 1
    value = {
        "asked_categories": ["main_complaint"], "closed_categories": [],
        "question_counts": counts,
        "asked_questions": ["您今天最难受的是哪里，或者是什么感觉？"],
        "question_count": 1, "no_new_fact_count": 0,
        "last_question_category": "main_complaint",
    }
    value.update(changes)
    return value


def empty_state():
    return {category: {"status": "missing", "summary": "", "evidence_turn_ids": [], "context_ids": []} for category in CATEGORIES}


def model_draft(turns, health_context=None, **changes):
    first = turns[0]["turn_id"]
    state = empty_state()
    state["main_complaint"] = {"status": "known", "summary": turns[0]["text"], "evidence_turn_ids": [first], "context_ids": []}
    value = {
        "user_intent": "health_fact", "latest_turn_adds_fact": True,
        "reply_text": "我理解了，先把这部分按您说的记录下来。", "suggested_action": "ask",
        "question_category": "onset_course", "question_importance": "essential",
        "candidate_question": "头疼大概从什么时候开始，后来怎么变化的？",
        "clinical_state": state, "relevant_context_ids": [], "unknowns": [], "contradictions": [],
    }
    value.update(changes)
    return value


def run(turns, controller=None, provider=None, health_context=None):
    return conversation_turn(
        {"turns": turns, "controller": controller or opening_controller(), "health_context": health_context or []},
        provider=provider or MockProvider(),
    )


def test_prompt_contract_is_the_clinical_intake_version():
    result = run([turn(1, "我头疼。")])
    assert result["prompt_version"] == PROMPT_VERSION == "clinical-intake-v7"
    assert set(result["completeness"]["clinical_state"]) == set(CATEGORIES)


def test_real_acceptance_normal_sleep_and_medication_question_are_not_onset_facts():
    source = "脚踝有点酸，大约三分，不红也不肿，晚上睡得还好，平地能走，走楼梯时会疼。"
    state = run([turn(1, source)])["completeness"]["clinical_state"]
    assert state["onset_course"]["status"] == "missing"
    assert all(part in state["functional_impact"]["summary"] for part in ("晚上睡得还好", "平地能走", "走楼梯时会疼"))
    assert _source_excerpt("昨天漏服了降压药，今天要不要加倍补上？", "onset_course") == "昨天漏服了降压药，"
    assert _source_excerpt("今天没量过也没处理。", "onset_course") == ""
    assert _source_excerpt("从昨天晚上开始睡不好。", "onset_course") == "从昨天晚上开始睡不好。"


def test_explicit_finish_never_echoes_an_unsupported_model_recap():
    class InventedClosingProvider:
        def complete_json(self, _system, payload):
            return model_draft(payload["turns"], user_intent="explicit_finish", latest_turn_adds_fact=False,
                               reply_text="目前记录里只有您提到过起始时间这一项。",
                               suggested_action="finish", question_category=None,
                               question_importance=None, candidate_question="")
    result = run([turn(1, "这是虚构测试。先这样，我不说了。")], provider=InventedClosingProvider())
    assert result["stop_reason"] == "user_finished"
    assert result["assistant_text"] == "好的，先到这里。您说过的原话会保留，之后可以回来继续。"
    assert all(item["status"] == "missing" for item in result["completeness"]["clinical_state"].values())


def test_unknown_medications_do_not_decline_or_erase_separately_stated_pain():
    source = "我刚出院，腿还疼，走路比以前费劲。药名我想不起来，也记不清每次吃多少。"
    result = run([turn(1, source)])
    state = result["completeness"]["clinical_state"]
    assert state["main_complaint"]["status"] == "known"
    assert "腿还疼" in state["main_complaint"]["summary"]
    assert "main_complaint" not in result["controller"]["closed_categories"]
    assert "费劲" in state["functional_impact"]["summary"]
    assert all("药名" not in item["summary"] and "吃多少" not in item["summary"] for item in state.values() if item["status"] == "known")
    assert "记不清每次吃多少" in _source_excerpt(source, "unknown")


def test_complete_fact_rich_answer_stops_without_forcing_every_field():
    text = "今天早上突然开始太阳穴持续刺痛，走路更痛，还恶心，已经影响睡觉。以前也有过，量过血压正常，休息后没变化。"
    result = run([turn(1, text)])
    assert result["action"] == "finish"
    assert result["assistant_text"]
    assert result["completeness"]["complete"] is True


def test_controller_asks_one_question_and_uses_eight_dimension_contract():
    result = run([turn(1, "我头疼。")])
    assert result["action"] == "ask"
    assert result["assistant_text"].count("？") == 1
    assert result["question_category"] in CATEGORIES
    assert result["controller"]["question_count"] == 2


def test_model_can_choose_highest_value_question_out_of_fixed_order():
    class DynamicProvider:
        def complete_json(self, _system, payload):
            return model_draft(
                payload["turns"],
                question_category="functional_impact",
                candidate_question="腿疼现在最影响您走路、起身还是睡觉？",
            )

    result = run([turn(1, "我的腿疼。")], provider=DynamicProvider())
    assert result["question_category"] == "functional_impact"
    assert "最影响" in result["assistant_text"]


def test_confirmed_relevant_context_reaches_model_and_is_traceable():
    item = context(1, "conditions", "医生曾确认尿酸偏高")

    class ContextAwareProvider:
        def complete_json(self, _system, payload):
            assert payload["health_context"] == [item]
            value = model_draft(payload["turns"])
            value["relevant_context_ids"] = [item["context_id"]]
            value["clinical_state"]["relevant_history"] = {
                "status": "known", "summary": "用户确认医生曾提示尿酸偏高",
                "evidence_turn_ids": [], "context_ids": [item["context_id"]],
            }
            value["question_category"] = "relevant_history"
            value["question_importance"] = "useful"
            value["candidate_question"] = "以前记录的尿酸偏高和这次脚趾不舒服有什么相同或不同？"
            return value

    result = run([turn(1, "我脚趾疼。")], provider=ContextAwareProvider(), health_context=[item])
    assert result["completeness"]["relevant_context_ids"] == [item["context_id"]]
    assert result["completeness"]["clinical_state"]["relevant_history"]["context_ids"] == [item["context_id"]]
    assert result["question_category"] == "relevant_history"
    assert "尿酸偏高" in result["assistant_text"]
    assert item["context_id"] in result["controller"]["linked_context_ids"]


def test_unrelated_context_cannot_be_claimed_without_valid_id():
    item = context(1, "allergies", "对花生过敏")

    class InventedContextProvider:
        def complete_json(self, _system, payload):
            return model_draft(payload["turns"], relevant_context_ids=["context_not_real"])

    with pytest.raises(ConversationError, match="model_evidence_invalid"):
        run([turn(1, "我腿疼。")], provider=InventedContextProvider(), health_context=[item])


def test_declined_topic_is_closed_and_not_repeated():
    first = run([turn(1, "我头疼。")])
    second = run([turn(1, "我头疼。"), turn(2, "什么时候开始的我不记得。")], first["controller"])
    assert first["question_category"] in second["controller"]["closed_categories"]
    assert second["question_category"] != first["question_category"]


def test_declined_intent_value_is_tolerated_and_source_controls_refusal_state():
    class DeclinedProvider:
        def complete_json(self, _system, payload):
            value = model_draft(payload["turns"], user_intent="declined", latest_turn_adds_fact=False)
            value["clinical_state"]["relevant_history"] = {
                "status": "declined", "summary": "用户表示不想说",
                "evidence_turn_ids": [payload["turns"][-1]["turn_id"]], "context_ids": [],
            }
            return value

    controller = opening_controller(last_question_category="relevant_history")
    result = run([turn(1, "这部分我不想说。")], controller, provider=DeclinedProvider())
    assert result["completeness"]["clinical_state"]["relevant_history"]["status"] == "declined"
    assert "relevant_history" in result["controller"]["closed_categories"]


def test_two_no_fact_turns_stop_and_hard_limit_is_twelve():
    controller = opening_controller(question_count=3, no_new_fact_count=1, last_question_category="onset_course")
    result = run([turn(1, "我头疼。"), turn(2, "我头疼。")], controller)
    assert result["action"] == "finish"
    assert result["stop_reason"] == "two_no_new_fact_turns"

    limited = run([turn(1, "我头疼。")], opening_controller(question_count=MAX_QUESTIONS))
    assert limited["action"] == "finish"
    assert limited["stop_reason"] == "question_limit"


def test_danger_uses_only_fixed_local_message_without_model_call():
    class FailingProvider:
        def complete_json(self, _system, _payload):
            raise AssertionError("danger handling must not call model")

    result = run([turn(1, "我胸口疼得喘不上来。")], provider=FailingProvider())
    assert result["action"] == "urgent"
    assert result["risk_level"] == "urgent"
    assert result["assistant_text"] == DANGER_REMINDER
    assert "120" in result["assistant_text"]


def test_grounded_natural_model_reply_is_used():
    class NaturalProvider:
        def complete_json(self, _system, payload):
            return model_draft(payload["turns"])

    result = run([turn(1, "我头疼。")], provider=NaturalProvider())
    assert result["assistant_text"] == "我理解了，先把这部分按您说的记录下来。 头疼大概从什么时候开始，后来怎么变化的？"


def test_patient_question_can_get_a_natural_answer_without_a_followup():
    response = "我不能仅凭这些描述判断病因，会把您说的疼痛和活动受限如实整理给接诊医生。"

    class PatientQuestionProvider:
        def complete_json(self, _system, payload):
            return model_draft(
                payload["turns"], user_intent="patient_question", latest_turn_adds_fact=False,
                reply_text=response, suggested_action="finish", question_category=None,
                question_importance=None, candidate_question="",
            )

    controller = opening_controller(no_new_fact_count=1)
    result = run([turn(1, "我腿疼，这可能是什么原因？")], controller, provider=PatientQuestionProvider())

    assert result["action"] == "reply"
    assert result["assistant_text"] == response
    assert result["controller"]["question_count"] == controller["question_count"]
    assert result["controller"]["no_new_fact_count"] == 0
    assert result["controller"]["last_question_category"] == "main_complaint"


def test_safe_diagnosis_boundary_is_not_blocked_by_medical_words():
    class SafeRefusalProvider:
        def complete_json(self, _system, payload):
            return model_draft(
                payload["turns"], user_intent="patient_question", latest_turn_adds_fact=False,
                reply_text="不能仅凭这些判断病因；我会把已经说到的情况整理下来。",
                suggested_action="finish", question_category=None, question_importance=None,
                candidate_question="",
            )

    result = run([turn(1, "我腿疼，这是什么病？")], provider=SafeRefusalProvider())
    assert result["action"] == "reply"
    assert "不能仅凭这些判断病因" in result["assistant_text"]
    assert result["stop_reason"] == "awaiting_user"


def test_two_meta_turns_are_answered_and_do_not_finish_or_increment_questions():
    replies = iter(("您不用重新说一遍，我会结合前面的话继续理解。", "刚才我没有回答到您的问题，我会先回应您说的内容。"))

    class MetaFeedbackProvider:
        def complete_json(self, _system, payload):
            return model_draft(
                payload["turns"], user_intent="meta_feedback", latest_turn_adds_fact=False,
                reply_text=next(replies), suggested_action="finish", question_category=None,
                question_importance=None, candidate_question="",
            )

    first = run([turn(1, "我腿疼得伸不直。")])
    first_controller = first["controller"]
    first_controller["no_new_fact_count"] = 1
    first_controller["last_question_category"] = "functional_impact"
    history = [turn(1, "我腿疼得伸不直。"), turn(2, "你刚才没有听懂我说的。")]
    second = run(history, first_controller, provider=MetaFeedbackProvider())
    third = run(history + [turn(3, "我说的是左腿疼。")], second["controller"], provider=MetaFeedbackProvider())

    assert second["action"] == third["action"] == "reply"
    assert second["assistant_text"] == "您不用重新说一遍，我会结合前面的话继续理解。"
    assert third["assistant_text"] == "刚才我没有回答到您的问题，我会先回应您说的内容。"
    assert third["controller"]["question_count"] == first_controller["question_count"]
    assert third["controller"]["no_new_fact_count"] == 0
    assert third["controller"]["last_question_category"] == "functional_impact"


@pytest.mark.parametrize(
    ("text", "claimed_category"),
    [
        ("为什么问我走路？", "aggravating_relieving"),
        ("这个问题里的睡眠是什么意思？", "functional_impact"),
    ],
)
def test_questions_about_the_assistant_do_not_become_clinical_facts(text, claimed_category):
    class OverclaimingProvider:
        def complete_json(self, _system, payload):
            latest_id = payload["turns"][-1]["turn_id"]
            value = model_draft(payload["turns"])
            value.update(
                user_intent="meta_feedback", latest_turn_adds_fact=False,
                reply_text="我是在了解这部分的意思。", suggested_action="finish",
                question_category=None, question_importance=None, candidate_question="",
            )
            value["clinical_state"][claimed_category] = {
                "status": "known", "summary": text,
                "evidence_turn_ids": [latest_id], "context_ids": [],
            }
            return value

    result = run([turn(1, text)], provider=OverclaimingProvider())

    item = result["completeness"]["clinical_state"][claimed_category]
    assert result["action"] == "reply"
    assert item["status"] == "missing"
    assert item["evidence_turn_ids"] == []


def test_worry_about_symptom_severity_is_not_symptom_character_evidence():
    text = "这是虚构测试。我有点担心，会不会越来越严重？"

    class OverclaimingProvider:
        def complete_json(self, _system, payload):
            value = model_draft(payload["turns"])
            value["clinical_state"]["symptom_character"] = {
                "status": "known", "summary": text,
                "evidence_turn_ids": [payload["turns"][-1]["turn_id"]], "context_ids": [],
            }
            return value

    result = run([turn(1, text)], provider=OverclaimingProvider())
    assert result["completeness"]["clinical_state"]["symptom_character"]["status"] == "missing"


def test_symptom_question_keeps_its_health_facts_and_is_not_meta_feedback():
    text = "我走路疼，为什么会这样？"

    class PatientQuestionProvider:
        def complete_json(self, _system, payload):
            return model_draft(
                payload["turns"], user_intent="patient_question", latest_turn_adds_fact=False,
                reply_text="我不能仅凭聊天判断原因，会把您说的情况如实整理。",
                suggested_action="finish", question_category=None,
                question_importance=None, candidate_question="",
            )

    result = run([turn(1, text)], provider=PatientQuestionProvider())

    clinical_state = result["completeness"]["clinical_state"]
    assert result["action"] == "reply"
    assert clinical_state["main_complaint"]["status"] == "known"
    assert clinical_state["main_complaint"]["evidence_turn_ids"] == ["turn_00000001"]
    assert clinical_state["aggravating_relieving"]["status"] == "known"
    assert clinical_state["aggravating_relieving"]["evidence_turn_ids"] == ["turn_00000001"]


def test_repeated_question_is_suppressed_without_replacing_model_reply():
    first = run([turn(1, "我腿疼。")])
    repeated = first["controller"]["asked_questions"][-1]
    controller = first["controller"]

    class RepeatingProvider:
        def complete_json(self, _system, payload):
            return model_draft(
                payload["turns"], user_intent="answer", reply_text="我明白，您刚才已经说了腿疼。",
                question_category=first["question_category"], candidate_question=repeated,
            )

    result = run([turn(1, "我腿疼。"), turn(2, "还是疼。")], controller, provider=RepeatingProvider())
    assert result["action"] == "reply"
    assert result["assistant_text"] == "我明白，您刚才已经说了腿疼。"
    assert result["question_category"] is None
    assert result["controller"]["question_count"] == controller["question_count"]


def test_explicit_side_correction_replaces_old_complaint_and_is_not_contradiction():
    first = turn(1, "我右腿膝盖疼。")
    latest = turn(2, "刚才说错了，不是右边，是左边疼。")

    class CorrectionProvider:
        def complete_json(self, _system, payload):
            refs = [row["turn_id"] for row in payload["turns"]]
            value = model_draft(payload["turns"], user_intent="correction", latest_turn_adds_fact=True)
            value["clinical_state"]["main_complaint"] = {
                "status": "known", "summary": "右腿膝盖疼；左边疼",
                "evidence_turn_ids": refs, "context_ids": [],
            }
            value["clinical_state"]["onset_course"] = {
                "status": "known", "summary": latest["text"],
                "evidence_turn_ids": [latest["turn_id"]], "context_ids": [],
            }
            value["clinical_state"]["symptom_character"] = {
                "status": "known", "summary": latest["text"],
                "evidence_turn_ids": [latest["turn_id"]], "context_ids": [],
            }
            value["contradictions"] = [{
                "text": "左右说法不一致", "evidence_turn_ids": refs, "context_ids": [],
            }]
            return value

    result = run([first, latest], opening_controller(last_question_category="main_complaint"), provider=CorrectionProvider())
    complaint = result["completeness"]["clinical_state"]["main_complaint"]
    assert "左边疼" in complaint["summary"] and "右" not in complaint["summary"]
    assert complaint["evidence_turn_ids"] == ["turn_00000002"]
    assert result["completeness"]["clinical_state"]["onset_course"]["status"] == "missing"
    assert result["completeness"]["clinical_state"]["symptom_character"]["status"] == "missing"
    assert result["completeness"]["contradictions"] == []


def test_responding_to_long_assistant_text_is_context_only():
    assistant_id = "turn_assistant_01"
    assistant_text = "您刚才说的情况我记下了。" + ("我再确认一下相关细节。" * 30)
    observed = {}

    class ContextProvider:
        def complete_json(self, _system, payload):
            observed["turns"] = payload["turns"]
            return model_draft(payload["turns"])

    result = run(
        [{**turn(1, "左腿疼。"), "responding_to": {"turn_id": assistant_id, "text": assistant_text}}],
        provider=ContextProvider(),
    )
    assert observed["turns"][0]["responding_to"] == {"turn_id": assistant_id, "text": assistant_text}
    assert assistant_id not in result["completeness"]["evidence_turn_ids"]
    assert assistant_id not in result["completeness"]["clinical_state"]["main_complaint"]["evidence_turn_ids"]


def test_responding_to_cannot_be_cited_as_patient_evidence():
    assistant_id = "turn_assistant_01"

    class InventedSourceProvider:
        def complete_json(self, _system, payload):
            value = model_draft(payload["turns"])
            value["clinical_state"]["main_complaint"]["evidence_turn_ids"] = [assistant_id]
            return value

    rows = [{**turn(1, "左腿疼。"), "responding_to": {"turn_id": assistant_id, "text": "您具体哪里不舒服？"}}]
    with pytest.raises(ConversationError, match="model_evidence_invalid"):
        run(rows, provider=InventedSourceProvider())


def test_responding_to_rejects_malformed_or_oversized_context():
    base = turn(1, "左腿疼。")
    with pytest.raises(ConversationError, match="responding_to_invalid"):
        run([{**base, "responding_to": {"turn_id": "turn_assistant_01", "text": "x" * 1001}}])
    with pytest.raises(ConversationError, match="responding_to_invalid"):
        run([{**base, "responding_to": {"turn_id": "turn_assistant_01", "text": "问题？", "role": "assistant"}}])


def test_model_summary_cannot_replace_leg_pain_with_mouth_pain():
    class HallucinatingProvider:
        def complete_json(self, _system, payload):
            value = model_draft(payload["turns"])
            value["clinical_state"]["main_complaint"]["summary"] = "用户自述嘴疼"
            return value

    result = run([turn(1, "今天我的腿疼得厉害。")], provider=HallucinatingProvider())
    complaint = result["completeness"]["clinical_state"]["main_complaint"]
    assert complaint["summary"] == "今天我的腿疼得厉害。"
    assert "嘴" not in complaint["summary"]


def test_functional_impact_does_not_pretend_to_answer_onset_question():
    controller = opening_controller(
        asked_categories=["main_complaint", "onset_course"],
        question_counts={**opening_controller()["question_counts"], "onset_course": 1},
        question_count=2,
        last_question_category="onset_course",
    )

    class PrematureFinishProvider:
        def complete_json(self, _system, payload):
            value = model_draft(payload["turns"], suggested_action="finish", question_category=None, question_importance=None, candidate_question="")
            latest_id = payload["turns"][-1]["turn_id"]
            for category in CATEGORIES:
                value["clinical_state"][category] = {
                    "status": "known", "summary": "用户自述嘴疼，资料已经完整",
                    "evidence_turn_ids": [latest_id], "context_ids": [],
                }
            return value

    result = run(
        [turn(1, "我的腿疼得伸不直。"), turn(2, "疼得我下不了地了。")],
        controller,
        provider=PrematureFinishProvider(),
    )
    assert result["action"] == "reply"
    assert result["question_category"] is None
    assert result["assistant_text"] == "我理解了，先把这部分按您说的记录下来。"
    assert result["controller"]["question_count"] == 2
    assert result["completeness"]["clinical_state"]["onset_course"]["status"] == "missing"
    assert result["completeness"]["clinical_state"]["functional_impact"]["status"] == "known"


def test_diagnosis_request_gets_safe_answer_without_forced_question():
    controller = opening_controller(
        asked_categories=["main_complaint", "onset_course"],
        question_counts={**opening_controller()["question_counts"], "onset_course": 1},
        question_count=2,
        last_question_category="onset_course",
    )

    class WantsToFinishProvider:
        def complete_json(self, _system, payload):
            return model_draft(
                payload["turns"], user_intent="patient_question",
                reply_text="我不能仅凭聊天判断病因，但可以把您说的情况整理给接诊医生。",
                suggested_action="finish", question_category=None, question_importance=None, candidate_question="",
            )

    result = run(
        [turn(1, "我的腿疼得伸不直。"), turn(2, "你不能告诉我这是怎么了吗？")],
        controller,
        provider=WantsToFinishProvider(),
    )
    assert result["action"] == "reply"
    assert result["assistant_text"] == "我不能仅凭聊天判断病因，但可以把您说的情况整理给接诊医生。"
    assert result["controller"]["question_count"] == 2
    assert result["controller"]["last_question_category"] == "onset_course"


def test_out_of_scope_question_is_rejected_without_faking_a_clinical_question():
    class OutOfScopeProvider:
        def complete_json(self, _system, payload):
            return model_draft(payload["turns"], candidate_question="您最喜欢哪部电影？")

    result = run([turn(1, "我头疼。")], provider=OutOfScopeProvider())
    assert result["action"] == "reply"
    assert "电影" not in result["assistant_text"]
    assert "什么时候开始" not in result["assistant_text"]
    assert result["question_category"] is None


def test_medical_advice_and_specific_test_suggestion_are_blocked_whole():
    class UnsafeProvider:
        def complete_json(self, _system, payload):
            return model_draft(
                payload["turns"], reply_text="您可能是关节炎。",
                candidate_question="建议你停药并做核磁，可以吗？",
            )

    result = run([turn(1, "我腿疼。")], provider=UnsafeProvider())
    assert result["action"] == "reply"
    assert result["assistant_text"] == MODEL_OUTPUT_BLOCKED_TEXT
    assert result["stop_reason"] == "model_output_blocked"


def test_past_test_fact_is_not_mistaken_for_a_test_recommendation():
    class PastFactProvider:
        def complete_json(self, _system, payload):
            return model_draft(
                payload["turns"],
                reply_text="我听到您说这次还没吃药，也没做过检查，已经记下了。",
                question_category="relevant_history",
                question_importance="useful",
                candidate_question="以前有没有出现过类似情况？",
            )

    result = run([turn(1, "这次还没吃药，也没做过检查。")], provider=PastFactProvider())
    assert result["action"] == "ask"
    assert "没做过检查" in result["assistant_text"]


def test_new_medication_or_test_advice_stays_blocked():
    class AdviceProvider:
        def complete_json(self, _system, payload):
            return model_draft(payload["turns"], reply_text="您可以先吃药，再做检查。")

    result = run([turn(1, "我头疼。")], provider=AdviceProvider())
    assert result["assistant_text"] == MODEL_OUTPUT_BLOCKED_TEXT


def test_sensitive_non_health_request_is_blocked():
    class SensitiveProvider:
        def complete_json(self, _system, payload):
            return model_draft(payload["turns"], reply_text="请告诉我银行卡密码。")

    result = run([turn(1, "我头疼。")], provider=SensitiveProvider())
    assert result["assistant_text"] == MODEL_OUTPUT_BLOCKED_TEXT


def test_every_known_fact_requires_real_source():
    class UngroundedProvider:
        def complete_json(self, _system, payload):
            value = model_draft(payload["turns"])
            value["clinical_state"]["main_complaint"]["evidence_turn_ids"] = ["turn_not_real"]
            return value

    with pytest.raises(ConversationError, match="model_evidence_invalid"):
        run([turn(1, "我头疼。")], provider=UngroundedProvider())


def test_unattributed_gap_note_is_discarded_without_failing_turn():
    class UnsupportedNoteProvider:
        def complete_json(self, _system, payload):
            return model_draft(payload["turns"], unknowns=[{"text": "开始时间未知", "evidence_turn_ids": [], "context_ids": []}])

    result = run([turn(1, "我头疼。")], provider=UnsupportedNoteProvider())
    assert result["completeness"]["unknowns"] == []


def test_exact_meta_question_after_symptom_question_does_not_return_422():
    first_text = "这是虚构测试，我从昨天开始左膝盖疼，走路时更明显，坐下来会好一些，没有摔倒。"
    follow_up = "我没听懂，为什么要问是什么感觉？"
    controller = opening_controller(
        asked_categories=["symptom_character"],
        asked_questions=["这个疼是什么感觉，比如酸、胀、刺痛还是别的？"],
        last_question_category="symptom_character",
        question_counts={**opening_controller()["question_counts"], "symptom_character": 1},
        question_count=1,
    )

    class MetaProvider:
        def complete_json(self, _system, payload):
            value = model_draft(
                payload["turns"], user_intent="meta_feedback", latest_turn_adds_fact=False,
                reply_text="我刚才想了解疼痛的具体感觉，您不用重复前面说过的话。",
                suggested_action="finish", question_category=None, question_importance=None,
                candidate_question="",
                unknowns=[{"text": "开始时间未知", "evidence_turn_ids": [], "context_ids": []}],
            )
            value["clinical_state"]["symptom_character"] = {
                "status": "declined", "summary": "未描述疼痛性质",
                "evidence_turn_ids": [payload["turns"][-1]["turn_id"]], "context_ids": [],
            }
            return value

    result = run(
        [turn(1, first_text), {
            **turn(2, follow_up),
            "responding_to": {"turn_id": "turn_assistant_q001", "text": "这个疼是什么感觉，比如酸、胀、刺痛还是别的？"},
        }],
        controller,
        provider=MetaProvider(),
    )
    assert result["action"] == "reply"
    assert result["controller"]["question_count"] == 1
    assert result["controller"]["last_question_category"] == "symptom_character"


def test_category_summaries_are_short_source_excerpts_not_repeated_turns():
    source = "这是虚构测试。我从昨天开始左膝盖疼，走路时更明显，没有摔倒。"

    class RepeatedQuoteProvider:
        def complete_json(self, _system, payload):
            value = model_draft(payload["turns"])
            ref = payload["turns"][0]["turn_id"]
            for category in ("main_complaint", "onset_course", "aggravating_relieving"):
                value["clinical_state"][category] = {
                    "status": "known", "summary": source,
                    "evidence_turn_ids": [ref], "context_ids": [],
                }
            value["unknowns"] = [
                {"text": source, "evidence_turn_ids": [ref], "context_ids": []}
                for _ in range(7)
            ]
            return value

    result = run([turn(1, source)], provider=RepeatedQuoteProvider())
    state = result["completeness"]["clinical_state"]
    summaries = [state[category]["summary"] for category in ("main_complaint", "onset_course", "aggravating_relieving")]

    assert all(summary in source and len(summary) < len(source) for summary in summaries)
    assert summaries[0] == summaries[1]  # One source clause can support multiple facts.
    assert "走路" in summaries[2]
    assert result["completeness"]["unknowns"] == []


def test_source_excerpt_keeps_full_negative_and_time_clauses():
    source = "我虽然昨天下午走了很久，但是没有胸口疼，也没有喘不上气。"

    onset = _source_excerpt(source, "onset_course")
    associated = _source_excerpt(source, "associated_symptoms")

    assert onset == "我虽然昨天下午走了很久，"
    assert associated == "但是没有胸口疼；也没有喘不上气。"
    assert all(item in source for item in (onset, associated.replace("；", "，")))


def test_category_excerpt_keeps_multiple_complete_evidence_clauses():
    source = "这是虚构测试。晚上睡得还好，平地能走，走楼梯会疼。"
    summary = _source_excerpt(source, "functional_impact")
    assert summary == "晚上睡得还好；平地能走；走楼梯会疼。"


def test_declined_summary_text_is_normalized_instead_of_rejecting_the_turn():
    first = turn(1, "我左膝疼。")
    latest = turn(2, "我没听懂，为什么要问是什么感觉？")

    class MetaProvider:
        def complete_json(self, _system, payload):
            value = model_draft(payload["turns"], user_intent="meta_feedback", latest_turn_adds_fact=False)
            value["clinical_state"]["symptom_character"] = {
                "status": "declined", "summary": "未描述疼痛性质",
                "evidence_turn_ids": [latest["turn_id"]], "context_ids": [],
            }
            return value

    state = run([first, latest], opening_controller(last_question_category="symptom_character"), provider=MetaProvider())
    assert state["action"] == "reply"
    assert state["completeness"]["clinical_state"]["symptom_character"]["status"] == "missing"


def test_contradiction_note_discards_meta_feedback_as_one_of_two_sources():
    facts = [turn(1, "昨天左膝疼。"), turn(2, "我没听懂，为什么要问左膝疼？")]

    class ContradictionProvider:
        def complete_json(self, _system, payload):
            value = model_draft(payload["turns"])
            value["contradictions"] = [{
                "text": "两处说法不一致", "evidence_turn_ids": [row["turn_id"] for row in payload["turns"]], "context_ids": [],
            }]
            return value

    result = run(facts, provider=ContradictionProvider())
    assert result["completeness"]["contradictions"] == []


def test_contradiction_note_requires_and_keeps_two_factual_sources():
    facts = [turn(1, "昨天左膝疼。"), turn(2, "昨天右膝也疼。")]

    class ContradictionProvider:
        def complete_json(self, _system, payload):
            value = model_draft(payload["turns"])
            value["contradictions"] = [{
                "text": "两处说法不一致", "evidence_turn_ids": [row["turn_id"] for row in payload["turns"]], "context_ids": [],
            }]
            return value

    result = run(facts, provider=ContradictionProvider())
    contradiction = result["completeness"]["contradictions"]
    assert len(contradiction) == 1
    assert contradiction[0]["evidence_turn_ids"] == ["turn_00000001", "turn_00000002"]


def test_plain_language_sleep_and_walking_facts_fill_functional_impact():
    source = "这是虚构测试。是酸痛，大概三分，不红也不肿，晚上睡得还好，平地能走，走楼梯会疼。"

    class SparseProvider:
        def complete_json(self, _system, payload):
            return model_draft(payload["turns"])

    result = run([turn(1, source)], provider=SparseProvider())
    impact = result["completeness"]["clinical_state"]["functional_impact"]
    assert impact["status"] == "known"
    assert all(phrase in impact["summary"] for phrase in ("晚上睡得还好", "平地能走", "走楼梯会疼"))


def test_short_answer_to_linked_assistant_question_is_grounded_without_keywords():
    first = turn(1, "我膝盖有点不舒服。")
    answer = {
        **turn(2, "是的。"),
        "responding_to": {"turn_id": "turn_assistant_q001", "text": "这对您上下楼影响大吗？"},
    }

    class ShortAnswerProvider:
        def complete_json(self, _system, payload):
            value = model_draft(payload["turns"])
            value["clinical_state"]["functional_impact"] = {
                "status": "known", "summary": "是的。",
                "evidence_turn_ids": [answer["turn_id"]], "context_ids": [],
            }
            return value

    controller = opening_controller(
        last_question_category="functional_impact",
        question_counts={**opening_controller()["question_counts"], "functional_impact": 1},
        question_count=2,
    )
    result = run([first, answer], controller, provider=ShortAnswerProvider())
    impact = result["completeness"]["clinical_state"]["functional_impact"]
    assert impact["status"] == "known"
    assert impact["summary"] == "是的。"
    assert impact["evidence_turn_ids"] == ["turn_00000002"]

    class MissingAnswerProvider:
        def complete_json(self, _system, payload):
            return model_draft(payload["turns"])

    unverified = run([first, answer], controller, provider=MissingAnswerProvider())
    unverified_impact = unverified["completeness"]["clinical_state"]["functional_impact"]
    assert unverified_impact["status"] == "missing"
    assert unverified_impact["evidence_turn_ids"] == []


def test_explicit_unknown_is_kept_as_a_short_source_excerpt():
    source = "我不记得具体哪一天开始疼的。"

    class ExplicitUnknownProvider:
        def complete_json(self, _system, payload):
            ref = payload["turns"][-1]["turn_id"]
            value = model_draft(payload["turns"])
            value["unknowns"] = [{"text": source, "evidence_turn_ids": [ref], "context_ids": []}]
            return value

    result = run([turn(1, source)], provider=ExplicitUnknownProvider())

    unknowns = result["completeness"]["unknowns"]
    assert len(unknowns) == 1
    assert unknowns[0]["text"] in source
    assert unknowns[0]["evidence_turn_ids"] == ["turn_00000001"]


def test_legacy_controller_is_migrated_without_reasking_old_main_question():
    legacy = {
        "asked_categories": ["main_discomfort"], "closed_categories": [],
        "question_counts": {"main_discomfort": 1, "onset_change": 0, "life_impact": 0, "other_facts": 0},
        "asked_questions": ["您哪里不舒服？"], "question_count": 1,
        "no_new_fact_count": 0, "last_question_category": "main_discomfort",
    }
    result = run([turn(1, "我头疼。")], legacy)
    assert result["controller"]["question_counts"]["main_complaint"] >= 1
    assert result["question_category"] != "main_complaint"
