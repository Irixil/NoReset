"""Public local recovery lifecycle, real TEMP SQLite, never provider transport."""
import copy
import hashlib
import json
import os
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend import trial_gate as gate, trial_budget, trial_recovery as recovery
from tests.test_trial_scope_successor_20261009 import (
    closed, five, history, no_external_calls, proposal, succeed,
)


@pytest.fixture
def failed_setup(five, monkeypatch):
    case = proposal(five, ('llm',))
    original = gate._history_v3

    def fail_target(connection, *args, **kwargs):
        if connection.execute('PRAGMA database_list').fetchone()[2] == str(case['state']):
            raise sqlite3.DataError('injected setup INSERT-size failure')
        return original(connection, *args, **kwargs)

    monkeypatch.setattr(gate, '_history_v3', fail_target)
    with pytest.raises(gate.TrialGateError):
        succeed(case)
    monkeypatch.setattr(gate, '_history_v3', original)
    trial_budget.close_batch(case['document']['cumulative_budget'],
                             receipt_id=case['document']['receipt_id'], reason='owner_stop')
    owner = case['state'].with_suffix('.owner-exit.json')
    owner.write_text(json.dumps({'schema_version': 'noreset-owner-exit-evidence-v1',
        'status': 'host_executor_reported_exit',
        'failed_receipt_sha256': hashlib.sha256(case['receipt'].read_bytes()).hexdigest(),
        'failed_state_path': str(case['state']), 'host_session_id': 'TEMP-fixture-exit',
        'exit_code': 1, 'owned_command_paths': [str(case['receipt'])]}))
    case['owner'] = owner
    case['append_args'] = dict(previous_receipt_path=case['previous'].receipt_path,
        previous_state_path=case['previous'].state_path, failed_receipt_path=case['receipt'],
        failed_state_path=case['state'], closure_path=case['closure_path'],
        failure_evidence_path=case['evidence_path'], owner_exit_evidence_path=owner)
    return case


def prepare_new(case):
    planned = copy.deepcopy(case)
    planned['document']['receipt_id'] += '-new-recovery'
    planned['document']['approval_ref'] += '-new-recovery'
    planned['receipt'] = case['receipt'].with_name('new-recovery-receipt.json')
    planned['state'] = case['state'].with_name('new-recovery-state.sqlite3')
    planned['closure_path'] = case['closure_path'].with_name('new-recovery-closure.json')
    planned['receipt'].write_text(json.dumps(planned['document']))
    planned['closure']['approval_ref'] = planned['document']['approval_ref']
    planned['closure']['new_receipt_sha256'] = hashlib.sha256(planned['receipt'].read_bytes()).hexdigest()
    planned['closure_path'].write_text(json.dumps(planned['closure']))
    return planned


def consume(case, planned, result):
    return recovery.consume_recovery(result['recovery_path'],
        source_path=case['previous'].state_path,
        source_sha256=hashlib.sha256(case['old_state']).hexdigest(),
        old_receipt_sha256=hashlib.sha256(case['old_receipt']).hexdigest(),
        new_receipt_sha256=hashlib.sha256(planned['receipt'].read_bytes()).hexdigest(),
        target=planned['state'])


def protected(case):
    root = gate.CONTINUATION_CLAIM_ROOT
    return {str(p): p.read_bytes() for p in [case['state'], case['receipt'],
        case['previous'].state_path, case['previous'].receipt_path,
        Path(case['document']['cumulative_budget']['state_path']),
        *root.glob('scope-successor-*.json')]}


def test_append_is_idempotent_zero_allowance_and_new_scope_keeps_failed_lock(failed_setup):
    case = failed_setup
    before = protected(case)
    result = recovery.append_failed_setup_recovery(**case['append_args'])
    assert result['creates_allowance'] is False
    assert recovery.append_failed_setup_recovery(**case['append_args']) == result
    assert protected(case) == before
    planned = prepare_new(case)
    assert consume(case, planned, result) == consume(case, planned, result)
    meter, out = succeed(planned, recovery_path=result['recovery_path'])
    assert out['remaining_requests'] == 1 and out['protected_through_attempt_id'] == 5
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT * FROM attempts ORDER BY id').fetchall() == case['old_rows']
    # The old failed authority is still rejected; its DB and permanent claim unchanged.
    with pytest.raises(gate.TrialGateError):
        gate.validate_trial_authorization(receipt_path=case['receipt'], state_path=case['state'])
    for p, raw in before.items():
        if p != case['document']['cumulative_budget']['state_path']:
            assert Path(p).read_bytes() == raw
    assert trial_budget.batch_status(case['document']['cumulative_budget'], receipt=case['document'])['allocations'] == 0


def test_same_failed_claim_cannot_fork_to_another_new_receipt(failed_setup):
    result = recovery.append_failed_setup_recovery(**failed_setup['append_args'])
    first = prepare_new(failed_setup)
    consume(failed_setup, first, result)
    other = prepare_new(failed_setup)
    other['state'] = other['state'].with_name('second-fork.sqlite3')
    with pytest.raises(ValueError):
        consume(failed_setup, other, result)
    assert not other['state'].exists()


@pytest.mark.parametrize('change', ['old_row', 'extra_table', 'not_failed', 'missing_claim', 'owner_not_confirmed'])
def test_changed_or_unconfirmed_failure_never_appends_a_recovery(failed_setup, change):
    case = failed_setup
    if change == 'missing_claim':
        # A scratch invalid path must fail; do not delete even TEMP old claims.
        case['append_args']['failed_state_path'] = case['state'].with_name('no-such-state.sqlite3')
    elif change == 'owner_not_confirmed':
        owner = json.loads(case['owner'].read_bytes()); owner['status'] = 'caller_guessed_exit'
        case['owner'].write_text(json.dumps(owner))
    else:
        with sqlite3.connect(case['state']) as db:
            if change == 'old_row': db.execute("UPDATE attempts SET source_sha256=? WHERE id=1", ('0'*64,))
            if change == 'extra_table': db.execute('CREATE TABLE unexpected(value TEXT)')
            if change == 'not_failed': db.execute("UPDATE metadata SET frozen_reason='owner_stop'")
    before = protected(case)
    with pytest.raises((ValueError, OSError, gate.TrialGateError)):
        recovery.append_failed_setup_recovery(**case['append_args'])
    assert protected(case) == before
    assert not list(gate.CONTINUATION_CLAIM_ROOT.glob('failed-setup-recovery-*.json'))


def test_running_owner_or_failed_ps_cannot_be_replaced_with_static_exit_json(failed_setup, monkeypatch):
    case = failed_setup
    monkeypatch.setattr(recovery.subprocess, 'run', lambda *a, **k: SimpleNamespace(
        stdout=f'{os.getpid()} 0 python-current-observer\n999999 1 python '+str(case['state'])+'\n'))
    with pytest.raises(ValueError): recovery.append_failed_setup_recovery(**case['append_args'])
    monkeypatch.setattr(recovery.subprocess, 'run', lambda *a, **k: SimpleNamespace(stdout='unparseable'))
    with pytest.raises(ValueError): recovery.append_failed_setup_recovery(**case['append_args'])
    monkeypatch.setattr(recovery.subprocess, 'run', lambda *a, **k: SimpleNamespace(stdout=''))
    with pytest.raises(ValueError): recovery.append_failed_setup_recovery(**case['append_args'])
    assert not list(gate.CONTINUATION_CLAIM_ROOT.glob('failed-setup-recovery-*.json'))


def test_corrupt_recovery_failed_copy_and_unconsumed_record_cannot_activate(failed_setup):
    case = failed_setup; result = recovery.append_failed_setup_recovery(**case['append_args'])
    planned = prepare_new(case)
    trial_budget.register_batch(planned['document']['cumulative_budget'], receipt=planned['document'])
    with pytest.raises((ValueError, gate.TrialGateError)):
        gate.succeed_informed_trial(planned['receipt'], planned['state'],
            previous_receipt_path=planned['previous'].receipt_path,
            previous_state_path=planned['previous'].state_path,
            closure_path=planned['closure_path'], failure_evidence_path=planned['evidence_path'],
            recovery_path=result['recovery_path'])
    assert not planned['state'].exists()
