"""New synthetic fixtures must not turn an offline gate into medical approval."""
from copy import deepcopy
import json
from pathlib import Path

import pytest

from backend.adapter import ALLOWED_SOURCE_KINDS, Config
from backend.evaluation import dataset_issues, payload_for
from scripts.evaluate_synthetic_preflight import (
    DEFAULT_DATASET, evaluate_preflight, main, validate_fixture_policy,
)


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def dataset():
    return json.loads((ROOT / DEFAULT_DATASET).read_text(encoding='utf-8'))


def test_new_fixture_has_explicit_sources_and_no_incompatible_labels(dataset):
    assert len(dataset['cases']) == 18
    assert len(dataset['rejection_cases']) == 6
    assert {case['source_kind'] for case in dataset['cases']} == ALLOWED_SOURCE_KINDS
    for case in dataset['cases']:
        assert not dataset_issues(case, dataset), case['id']
        payload = payload_for(case, dataset)
        assert payload['source_kind'] == case['source_kind']
        assert payload['recorded_at'] == dataset['reference_time']
        assert payload.get('occurred_time') == case['expected']['occurred_time']
        assert case['manual_required']
    clinician = next(case for case in dataset['cases'] if case['source_kind'] == 'clinician_evidence')
    assert clinician['provenance']['source_declaration'] == 'fixture_only_identity_unverified'
    assert clinician['clinical_review_status'] == 'pending'


def test_preflight_pass_preserves_all_manual_and_clinical_pending_states(dataset):
    report = evaluate_preflight(dataset)
    assert report['gate_pass'] is True
    assert report['counts']['total'] == report['counts']['schema_pass'] == 18
    assert report['counts']['errors'] == report['counts']['assertions_failed'] == report['counts']['dataset_issues'] == 0
    assert report['counts']['semantic_pass'] == 0
    assert report['counts']['semantic_incomplete'] == 18
    assert all(row['semantic_status'] == 'incomplete' for row in report['rows'])
    assert report['clinical_review_status'] == report['semantic_review_status'] == 'pending'
    assert report['clinical_identity_verified'] is report['real_asr_ocr_verified'] is False
    assert report['rejection_counts'] == {'total': 6, 'assertions_passed': 12, 'assertions_failed': 0, 'provider_calls': 0}


@pytest.mark.parametrize('index', range(6))
def test_document_rejection_fixture_never_reaches_provider(dataset, index):
    selected = deepcopy(dataset)
    selected['rejection_cases'] = [selected['rejection_cases'][index]]
    report = evaluate_preflight(selected)
    rejection = report['rejection_rows'][0]
    assert rejection['actual_code'] == 'document_source_review_required'
    assert rejection['provider_calls'] == 0
    assert all(check['status'] == 'passed' for check in rejection['assertions'])


@pytest.mark.parametrize('mutation', ['external_source', 'clinical_approved', 'missing_manual', 'non_synthetic_case'])
def test_preflight_rejects_inputs_that_hide_provenance_or_pending_review(dataset, mutation):
    if mutation == 'external_source':
        dataset['source_policy']['external_records_used'] = True
    elif mutation == 'clinical_approved':
        dataset['clinical_review_status'] = 'approved'
    elif mutation == 'missing_manual':
        dataset['cases'][0]['manual_required'] = []
    else:
        dataset['cases'][0]['synthetic_only'] = False
    with pytest.raises(ValueError):
        validate_fixture_policy(dataset)


def test_cli_cannot_load_operator_configuration_or_claim_full_acceptance(tmp_path, monkeypatch):
    def configuration_is_forbidden(*args, **kwargs):
        raise AssertionError('offline preflight must not read provider configuration')
    monkeypatch.setattr(Config, 'from_env', configuration_is_forbidden)
    path = tmp_path / 'preflight.json'
    assert main(['--out', str(path)]) == 0
    report = json.loads(path.read_text(encoding='utf-8'))
    assert report['gate'] == 'offline_input_contract_preflight'
    assert report['provider'] == report['model'] == 'mock'
    assert report['counts']['semantic_pass'] == 0
    assert report['clinical_review_status'] == report['semantic_review_status'] == 'pending'
    assert report['dataset_sha256']
