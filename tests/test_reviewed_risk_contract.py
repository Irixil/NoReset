"""Controller mechanics only: fixtures are synthetic, never clinical approval."""
import copy
import json

import pytest

import backend.conversation as conversation
from backend.safety import (
    DANGER_REMINDER, SOON_EVALUATION_REMINDER, URGENT_REVIEWED_REMINDER,
    evaluate_reviewed_risk, load_reviewed_risk_rules, scan_danger,
)


def rules_document(level="soon_evaluation", **changes):
    document = {
        "rule_set_version": "synthetic-risk-controller-v1", "scope": "synthetic_test_fixture",
        "medical_signoff": "approved", "rules": [{
            "rule_id": "synthetic_controller_rule", "version": "fixture-v1", "level": level,
            "pattern": "SYNTHETIC_FLAG", "description": "Synthetic controller token only",
            "clinical_review": {"status": "approved", "reviewer_id": "synthetic-reviewer",
                "reviewer_role": "physician", "reviewed_at": "2026-10-08", "evidence_ref": "synthetic-fixture-not-clinical-approval"},
        }],
    }
    document.update(changes)
    return document


def fixture_registry(tmp_path, document=None):
    path = tmp_path / "synthetic-reviewed-rules.json"
    path.write_text(json.dumps(document or rules_document()), encoding="utf-8")
    return load_reviewed_risk_rules(path, allow_test_fixture=True)


def source(text="纯虚构：SYNTHETIC_FLAG", version=1):
    return {"turn_id": "turn_synthetic_0001", "text": text, "version": version}


def candidate(turn=None, **changes):
    turn = turn or source()
    value = {"rule_id": "synthetic_controller_rule", "rule_version": "fixture-v1",
        "evidence": [{"turn_id": turn["turn_id"], "version": turn["version"], "quote": turn["text"]}]}
    value.update(changes)
    return value


def test_production_has_no_approved_rules_and_never_claims_safety():
    registry = load_reviewed_risk_rules()
    result = evaluate_reviewed_risk([], [source()], registry)
    assert result["status"] == "no_approved_rules"
    assert result["level"] == "none"
    assert result["notice"] is None
    assert result["clinical_validation"] == "not_completed"
    assert not registry["rules"]


def test_synthetic_rule_file_cannot_be_loaded_by_production_default(tmp_path):
    path = tmp_path / "fixture.json"
    path.write_text(json.dumps(rules_document()), encoding="utf-8")
    assert not load_reviewed_risk_rules(path)["rules"]


@pytest.mark.parametrize("level,notice", [
    ("soon_evaluation", SOON_EVALUATION_REMINDER), ("urgent", URGENT_REVIEWED_REMINDER),
])
def test_only_approved_matching_rule_selects_fixed_notice(tmp_path, level, notice):
    result = evaluate_reviewed_risk([candidate()], [source()], fixture_registry(tmp_path, rules_document(level)))
    assert result["level"] == level
    assert result["notice"] == notice
    assert result["clinical_validation"] == "synthetic_fixture_only"
    assert result["matched_rules"] == [{"rule_id": "synthetic_controller_rule", "version": "fixture-v1", "level": level, "evidence": candidate()["evidence"]}]
    assert result["sources"] == candidate()["evidence"]


@pytest.mark.parametrize("mutation", [
    {"rule_id": "unknown_rule"}, {"rule_version": "old"},
    {"evidence": [{"turn_id": "turn_unknown_0001", "version": 1, "quote": source()["text"]}]},
    {"evidence": [{"turn_id": source()["turn_id"], "version": 0, "quote": source()["text"]}]},
    {"evidence": [{"turn_id": source()["turn_id"], "version": 1, "quote": "SYNTHETIC_FLAG"}]},
    {"evidence": [{"context_id": "context_synthetic_0001", "version": 1, "quote": "SYNTHETIC_FLAG"}]},
    {"level": "urgent"}, {"notice": "模型任意文案"},
])
def test_invalid_or_forged_candidate_never_escalates(tmp_path, mutation):
    result = evaluate_reviewed_risk([candidate(**mutation)], [source()], fixture_registry(tmp_path))
    assert result["level"] == "none"
    assert result["notice"] is None
    assert result["rejected_candidates"] == 1


def test_real_source_does_not_replace_the_local_matcher(tmp_path):
    turn = source("纯虚构：普通记录")
    result = evaluate_reviewed_risk([candidate(turn)], [turn], fixture_registry(tmp_path))
    assert result["level"] == "none"


@pytest.mark.parametrize("missing", ["reviewer_id", "reviewer_role", "reviewed_at", "evidence_ref"])
def test_review_metadata_must_be_complete(tmp_path, missing):
    document = rules_document()
    document["rules"][0]["clinical_review"].pop(missing)
    assert not fixture_registry(tmp_path, document)["rules"]


def test_pending_rule_never_becomes_soon_evaluation(tmp_path):
    document = rules_document()
    document["rules"][0]["clinical_review"]["status"] = "pending"
    assert evaluate_reviewed_risk([candidate()], [source()], fixture_registry(tmp_path, document))["level"] == "none"


def test_existing_engineering_emergency_notice_is_retained_and_labeled_unvalidated():
    scan = scan_danger("纯虚构：胸口痛")
    assert scan["danger_detected"] is True
    assert scan["danger_reminder"] == DANGER_REMINDER
    assert scan["legacy_clinical_review_status"] == "active_unvalidated"


class SyntheticProvider:
    def __init__(self, draft): self.draft = draft
    def complete_json(self, prompt, payload): return copy.deepcopy(self.draft)


def test_conversation_stops_questions_for_mechanically_approved_fixture(tmp_path, monkeypatch):
    registry = fixture_registry(tmp_path)
    monkeypatch.setattr(conversation, "load_reviewed_risk_rules", lambda: registry)
    turn = source()
    draft = conversation._mock_assessment([turn], {})
    draft["risk_candidates"] = [candidate(turn)]
    result = conversation.conversation_turn({"turns": [turn]}, SyntheticProvider(draft))
    assert result["action"] == "soon_evaluation"
    assert result["assistant_text"] == SOON_EVALUATION_REMINDER
    assert result["question_category"] is None
    assert result["controller"]["last_question_category"] is None
    assert result["risk_assessment"]["clinical_validation"] == "synthetic_fixture_only"


def test_current_version_evidence_is_required_after_a_correction(tmp_path):
    turn = source("纯虚构：纠正后普通记录", version=2)
    result = evaluate_reviewed_risk([candidate(source())], [turn], fixture_registry(tmp_path))
    assert result["level"] == "none"
    assert result["rejected_candidates"] == 1


def test_manifest_contains_only_rule_identity_and_no_model_controlled_approval(tmp_path):
    from backend.safety import reviewed_risk_manifest
    manifest = reviewed_risk_manifest(fixture_registry(tmp_path))
    assert manifest["rules"] == [{"rule_id": "synthetic_controller_rule", "version": "fixture-v1", "level": "soon_evaluation"}]
    assert manifest["status"] == "reviewed_rules_loaded"
    assert manifest["clinical_validation"] == "synthetic_fixture_only"
    assert "pattern" not in json.dumps(manifest)
    assert not reviewed_risk_manifest()["rules"]


def test_unknown_candidate_on_production_rules_does_not_upgrade_ordinary_reply():
    turn = source()
    draft = conversation._mock_assessment([turn], {})
    draft["risk_candidates"] = [candidate(turn)]
    result = conversation.conversation_turn({"turns": [turn]}, SyntheticProvider(draft))
    assert result["action"] not in {"soon_evaluation", "urgent"}
    assert result["risk_assessment"]["status"] == "no_approved_rules"
    assert result["risk_assessment"]["rejected_candidates"] == 1


def test_urgent_fixture_has_precedence_over_soon_and_each_match_has_sources(tmp_path):
    document = rules_document()
    urgent = copy.deepcopy(document["rules"][0])
    urgent.update(rule_id="synthetic_urgent_rule", level="urgent")
    document["rules"].append(urgent)
    candidates = [candidate(), candidate(rule_id="synthetic_urgent_rule")]
    result = evaluate_reviewed_risk(candidates, [source()], fixture_registry(tmp_path, document))
    assert result["level"] == "urgent"
    assert result["notice"] == URGENT_REVIEWED_REMINDER
    assert len(result["matched_rules"]) == 2
    assert all(rule["evidence"] == candidate()["evidence"] for rule in result["matched_rules"])


def test_turn_version_is_preserved_to_the_model_and_invalid_versions_are_rejected():
    assert conversation._clean_turns({"turns": [source(version=3)]})[0]["version"] == 3
    for version in [0, -1, True, 1.5, "1"]:
        with pytest.raises(conversation.ConversationError, match="turn_version_invalid"):
            conversation._clean_turns({"turns": [source(version=version)]})
