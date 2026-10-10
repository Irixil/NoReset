"""Synthetic adversarial cases at the public conversation boundary."""
import pytest

from backend.conversation import MODEL_OUTPUT_BLOCKED_TEXT
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
