"""Independent explicitly approved pair; closed synthetic predecessor, TEMP SQLite only."""
import copy
import json
import sqlite3
from pathlib import Path

import pytest

from backend import trial_gate as gate
from tests.test_trial_append_20261009 import history
from tests.test_trial_informed_risk_20261009 import activate, review, send
from tests.test_trial_gate import digest


@pytest.fixture
def closed(history, tmp_path, monkeypatch):
    monkeypatch.setattr(gate, 'CONTINUATION_CLAIM_ROOT', tmp_path / 'claims')
    meter, old = activate(history)
    ident = send(meter, old, 'asr', report=False)
    gate.stop_trial(ident, 'response_invalid', state_path=meter.state_path)
    with sqlite3.connect(meter.state_path) as db:
        rows = db.execute('SELECT * FROM attempts ORDER BY id').fetchall()
        previous = db.execute('SELECT receipt_sha256 FROM metadata').fetchone()[0]
    new = copy.deepcopy(old)
    new.update(receipt_id='new-invented-single-pair', approval_ref='human-new-one-pair-unknown-charge',
               previous_receipt_sha256=previous, total_requests=6, planned_text_requests=1)
    new['spend_authorization']['estimated_new_usd'] = '0.0106816'
    for profile in new['profiles'].values(): profile['requests'] = 1
    new_receipt, new_state = tmp_path / 'new-receipt.json', tmp_path / 'new-ledger.sqlite3'
    new_receipt.write_text(json.dumps(new))
    evidence = {'status': 'failed_first_asr_stopped_without_retry', 'freeze_reason': 'response_invalid',
                'new_attempt_id': 4, 'actual_new_posts': {'asr': 1, 'llm': 0, 'ocr': 0},
                'cumulative_attempt_rows': 4, 'historical_three_rows_unchanged': True,
                'historical_reserved_usd': '0.9510912', 'supplier_final_charge_known': False}
    evidence_path = tmp_path / 'closed-failure.json'
    evidence_path.write_text(json.dumps(evidence))
    closure = {'schema_version': 'noreset-closed-trial-continuation-v1',
               'status': 'permanently_closed_failed', 'authorization_source': 'explicit_owner_approval',
               'approval_ref': new['approval_ref'], 'previous_state_sha256': digest(meter.state_path.read_bytes()),
               'previous_receipt_sha256': previous, 'previous_attempts_sha256': digest(gate._snapshot(rows).encode()),
               'new_receipt_sha256': digest(new_receipt.read_bytes()), 'failed_attempt_id': ident,
               'freeze_reason': 'response_invalid', 'failed_request_sha256': rows[-1][2],
               'failed_source_sha256': rows[-1][3], 'failure_evidence_sha256': digest(evidence_path.read_bytes())}
    closure_path = tmp_path / 'closure.json'; closure_path.write_text(json.dumps(closure))
    return dict(old=meter, old_document=old, old_rows=rows, new_document=new, receipt=new_receipt,
                state=new_state, closure=closure, closure_path=closure_path, evidence_path=evidence_path,
                old_receipt_bytes=meter.receipt_path.read_bytes(), old_state_bytes=meter.state_path.read_bytes())


def continue_pair(case, **changes):
    args = dict(previous_receipt_path=case['old'].receipt_path, previous_state_path=case['old'].state_path,
                closure_path=case['closure_path'], failure_evidence_path=case['evidence_path'])
    args.update(changes)
    result = gate.continue_informed_trial(case['receipt'], case['state'], **args)
    return gate.TrialGate(case['receipt'], case['state']), result


def assert_old_unchanged(case):
    assert case['old'].receipt_path.read_bytes() == case['old_receipt_bytes']
    assert case['old'].state_path.read_bytes() == case['old_state_bytes']


def test_new_pair_inherits_closed_history_and_obeys_review_and_cumulative_count(closed):
    meter, result = continue_pair(closed)
    assert result['historical_reserved_usd'] == '0.9510912'
    assert result['remaining_requests'] == 2 and result['cost_bound_known'] is False
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT * FROM attempts ORDER BY id').fetchall() == closed['old_rows']
        assert db.execute('SELECT frozen_reason FROM closed_metadata').fetchone() == ('response_invalid',)
        assert db.execute('SELECT usage_json FROM attempts WHERE id=4').fetchone() == (None,)
    assert gate.validate_trial_authorization(receipt_path=meter.receipt_path, state_path=meter.state_path)['remaining_usd'] is None
    with pytest.raises(gate.TrialGateError): send(meter, closed['new_document'], 'llm')
    first = send(meter, closed['new_document'], 'asr')
    assert first == 5
    with pytest.raises(gate.TrialGateError): send(meter, closed['new_document'], 'llm')
    review(meter, first)
    assert send(meter, closed['new_document'], 'llm') == 6
    with pytest.raises(gate.TrialGateError): send(meter, closed['new_document'], 'asr')
    journal = gate.trial_journal(state_path=meter.state_path)
    assert len(journal) == 6 and journal[3]['usage'] is None
    assert journal[3]['closed_status'] == 'failed_usage_unverified'
    assert_old_unchanged(closed)
    with pytest.raises(gate.TrialGateError): send(closed['old'], closed['old_document'], 'llm')


@pytest.mark.parametrize('mutate', [
    lambda c: c.update(previous_state_sha256='0'*64),
    lambda c: c.update(previous_receipt_sha256='0'*64),
    lambda c: c.update(previous_attempts_sha256='0'*64),
    lambda c: c.update(new_receipt_sha256='0'*64),
    lambda c: c.update(failed_attempt_id=3),
    lambda c: c.update(freeze_reason='owner_stop'),
    lambda c: c.update(authorization_source='http_request'),
    lambda c: c.update(approval_ref='delegated-agent-says-continue'),
    lambda c: c.update(failure_evidence_sha256='0'*64),
])
def test_missing_or_mismatched_closed_binding_never_creates_active_target(closed, mutate):
    mutate(closed['closure']); closed['closure_path'].write_text(json.dumps(closed['closure']))
    with pytest.raises(gate.TrialGateError): continue_pair(closed)
    assert not closed['state'].exists()
    assert_old_unchanged(closed)


def test_missing_closure_and_active_wal_are_not_complete_source_snapshots(closed):
    closed['closure_path'].unlink()
    with pytest.raises(gate.TrialGateError): continue_pair(closed)
    closed['closure_path'].write_text(json.dumps(closed['closure']))
    wal = closed['old'].state_path.with_name(closed['old'].state_path.name+'-wal'); wal.write_bytes(b'not a closed DB')
    with pytest.raises(gate.TrialGateError): continue_pair(closed)
    assert not closed['state'].exists()
    assert_old_unchanged(closed)


def test_one_closed_source_cannot_activate_another_target_or_receipt(closed):
    meter, result = continue_pair(closed)
    with pytest.raises(gate.TrialGateError): continue_pair(closed)
    closed['state'] = meter.state_path.with_name('forked-target.sqlite3')
    with pytest.raises(gate.TrialGateError): continue_pair(closed)
    assert not closed['state'].exists()
    copied_source = meter.state_path.with_name('copied-old-ledger.sqlite3')
    copied_source.write_bytes(closed['old_state_bytes'])
    with pytest.raises(gate.TrialGateError): continue_pair(closed, previous_state_path=copied_source)
    assert not closed['state'].exists()
    closed['state'].write_bytes(meter.state_path.read_bytes())
    with pytest.raises(gate.TrialGateError):
        gate.validate_trial_authorization(receipt_path=meter.receipt_path, state_path=closed['state'])
    forged_claim = closed['state'].with_name('forged-claim.json')
    claim = json.loads(Path(result['claim_path']).read_bytes())
    claim['state_path'] = str(closed['state'].resolve())
    forged_claim.write_text(json.dumps(claim))
    with sqlite3.connect(closed['state']) as db:
        db.execute('UPDATE closed_origin SET claim_path=?', (str(forged_claim),))
    with pytest.raises(gate.TrialGateError):
        gate.validate_trial_authorization(receipt_path=meter.receipt_path, state_path=closed['state'])
    assert_old_unchanged(closed)


def test_pending_llm_hashes_can_be_amended_after_this_asr_review(closed):
    source = closed['new_document']['profiles']['llm']['source_sha256'].pop()
    wire_sha = closed['new_document']['profiles']['llm']['request_sha256'].pop()
    closed['receipt'].write_text(json.dumps(closed['new_document']))
    closed['closure']['new_receipt_sha256'] = digest(closed['receipt'].read_bytes())
    closed['closure_path'].write_text(json.dumps(closed['closure']))
    meter, _ = continue_pair(closed)
    review(meter, send(meter, closed['new_document'], 'asr'))
    closed['new_document']['approval_ref'] = 'human-compared-new-native-LLM-wire'
    closed['new_document']['profiles']['llm']['source_sha256'].append(source)
    closed['new_document']['profiles']['llm']['request_sha256'].append(wire_sha)
    closed['receipt'].write_text(json.dumps(closed['new_document']))
    gate.amend_trial(meter.receipt_path, meter.state_path)
    assert send(meter, closed['new_document'], 'llm') == 6
    assert_old_unchanged(closed)


def test_same_logical_predecessor_with_different_sqlite_bytes_cannot_fork(closed):
    meter, _ = continue_pair(closed)
    another_source = meter.state_path.with_name('reserialized-old-ledger.sqlite3')
    another_source.write_bytes(closed['old_state_bytes'])
    with sqlite3.connect(another_source) as db:
        db.execute('PRAGMA user_version=17')
        assert db.execute('SELECT * FROM attempts ORDER BY id').fetchall() == closed['old_rows']
    assert another_source.read_bytes() != closed['old_state_bytes']
    closed['state'] = meter.state_path.with_name('logical-fork.sqlite3')
    closed['closure']['previous_state_sha256'] = digest(another_source.read_bytes())
    closed['closure_path'].write_text(json.dumps(closed['closure']))
    with pytest.raises(gate.TrialGateError): continue_pair(closed, previous_state_path=another_source)
    assert not closed['state'].exists()
    assert_old_unchanged(closed)


def test_other_unknown_historical_usage_is_not_closed_by_the_last_failure(closed):
    with sqlite3.connect(closed['old'].state_path) as db:
        db.execute('UPDATE attempts SET usage_json=NULL WHERE id=2')
        rows = db.execute('SELECT * FROM attempts ORDER BY id').fetchall()
    closed['old_state_bytes'] = closed['old'].state_path.read_bytes()
    closed['closure']['previous_state_sha256'] = digest(closed['old_state_bytes'])
    closed['closure']['previous_attempts_sha256'] = digest(gate._snapshot(rows).encode())
    closed['closure_path'].write_text(json.dumps(closed['closure']))
    with pytest.raises(gate.TrialGateError): continue_pair(closed)
    assert not closed['state'].exists()
    assert_old_unchanged(closed)


def test_closed_usage_cannot_be_filled_or_stop_the_new_scope(closed):
    meter, _ = continue_pair(closed)
    with pytest.raises(gate.TrialGateError):
        gate.report_usage(4, 'gemini-2.5-flash-lite', {'prompt_tokens': 180, 'completion_tokens': 10,
            'completion_tokens_details': {'reasoning_tokens': 0}}, state_path=meter.state_path)
    with pytest.raises(gate.TrialGateError): gate.stop_trial(4, 'owner_stop', state_path=meter.state_path)
    assert gate.validate_trial_authorization(receipt_path=meter.receipt_path, state_path=meter.state_path)['remaining_requests'] == 2
    assert gate.trial_journal(state_path=meter.state_path)[3]['usage'] is None
    assert_old_unchanged(closed)


@pytest.mark.parametrize('damage', ['new_null', 'old_row', 'closed_metadata', 'proof', 'missing_proof'])
def test_exception_is_bound_to_exact_old_failure_and_not_new_unknown_usage(closed, damage):
    meter, _ = continue_pair(closed)
    if damage == 'new_null': send(meter, closed['new_document'], 'asr', report=False)
    else:
        with sqlite3.connect(meter.state_path) as db:
            if damage == 'old_row': db.execute('UPDATE attempts SET reserved_nano_usd=1 WHERE id=4')
            if damage == 'closed_metadata': db.execute('UPDATE closed_metadata SET frozen_reason=NULL')
            if damage == 'proof': db.execute("UPDATE closed_origin SET closure_json='{}'")
            if damage == 'missing_proof': db.execute('DROP TABLE closed_origin')
    with pytest.raises(gate.TrialGateError): send(meter, closed['new_document'], 'llm')
    assert_old_unchanged(closed)


def test_new_failure_stops_remaining_pair_and_cannot_recreate(closed):
    meter, _ = continue_pair(closed)
    ident = send(meter, closed['new_document'], 'asr')
    gate.stop_trial(ident, 'business_validation_failed', state_path=meter.state_path)
    with pytest.raises(gate.TrialGateError): review(meter, ident)
    with pytest.raises(gate.TrialGateError): send(meter, closed['new_document'], 'llm')
    with pytest.raises(gate.TrialGateError): continue_pair(closed)
    assert_old_unchanged(closed)


@pytest.mark.parametrize('mutation', [
    lambda d: d.update(total_requests=7),
    lambda d: d.update(receipt_id='invented-informed-risk'),
    lambda d: d['profiles']['asr'].update(requests=2),
    lambda d: d['spend_authorization'].update(hard_currency_cap=True),
])
def test_continuation_never_expands_scope_or_reuses_old_authority(closed, mutation):
    mutation(closed['new_document']); closed['receipt'].write_text(json.dumps(closed['new_document']))
    closed['closure']['new_receipt_sha256'] = digest(closed['receipt'].read_bytes())
    closed['closure_path'].write_text(json.dumps(closed['closure']))
    with pytest.raises(gate.TrialGateError): continue_pair(closed)
    assert not closed['state'].exists()
    assert_old_unchanged(closed)
