"""TEMP backup/restore and fixed-origin recovery concurrency; no providers."""
import copy
import hashlib
import json
import shutil
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest

from backend import trial_budget, trial_gate as gate, trial_recovery as recovery
from backend.trial_snapshot import load_snapshot
from tests.test_trial_failed_setup_recovery import (
    consume, failed_setup, prepare_new, protected,
)
from tests.test_trial_scope_successor_20261009 import (
    closed, five, history, no_external_calls, succeed,
)


def tree_bytes(root):
    return {str(path.relative_to(root)): path.read_bytes()
            for path in root.rglob('*') if path.is_file()}


def ledger_tables(path):
    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
        schemas = db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' "
                             "AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
        return {name: (sql, db.execute(f'SELECT * FROM "{name}" ORDER BY rowid').fetchall())
                for name, sql in schemas}


def assert_preserved_history(case, target):
    previous, current = ledger_tables(case['previous'].state_path), ledger_tables(target)
    for name, (schema, rows) in previous.items():
        assert current[name][0] == schema, name
        if name == 'metadata':
            old_head = hashlib.sha256(case['old_receipt']).hexdigest()
            assert (old_head, *rows[0]) in current['closed_scope_metadata'][1]
        else:
            assert all(row in current[name][1] for row in rows), name
    assert current['attempts'][1] == case['old_rows']
    assert current['attempts'][1][3][-1] is None  # Unknown historical use stays unknown.
    assert case['previous'].state_path.read_bytes() == case['old_state']
    assert case['previous'].receipt_path.read_bytes() == case['old_receipt']


@pytest.fixture
def recovered_scope(failed_setup):
    case = failed_setup
    failed_before = protected(case)
    result = recovery.append_failed_setup_recovery(**case['append_args'])
    planned = prepare_new(case)
    consume(case, planned, result)
    meter, activated = succeed(planned, recovery_path=result['recovery_path'])
    assert activated['protected_through_attempt_id'] == 5
    for filename, raw in failed_before.items():
        if filename != case['document']['cumulative_budget']['state_path']:
            assert Path(filename).read_bytes() == raw
    assert_preserved_history(case, meter.state_path)
    with sqlite3.connect(meter.state_path) as db:
        reference = db.execute('SELECT state_raw FROM scope_successors ORDER BY id DESC').fetchone()[0]
    assert reference.startswith(b'NoReset-snapshot-reference-v1\n')
    assert len(reference) < len(case['old_state'])
    assert load_snapshot(reference, gate.CONTINUATION_CLAIM_ROOT) == case['old_state']
    snapshot = Path(json.loads(reference.split(b'\n', 1)[1])['path'])
    return case, planned, result, meter, snapshot


def test_pointer_ledger_and_complete_claim_snapshot_backup_restore_same_identity(
    recovered_scope, tmp_path,
):
    case, planned, recovery_result, meter, snapshot = recovered_scope
    claim_root = gate.CONTINUATION_CLAIM_ROOT.resolve()
    old_claims = tree_bytes(claim_root)
    old_tables = ledger_tables(meter.state_path)
    backup = tmp_path / 'separate-backup'
    backup.mkdir()
    # Real SQLite backup plus the complete external evidence/claim tree.
    # A database alone no longer contains the referenced snapshot bytes.
    with sqlite3.connect(meter.state_path.resolve().as_uri() + '?mode=ro', uri=True) as source:
        with sqlite3.connect(backup / 'ledger.sqlite3') as destination:
            source.backup(destination)
    shutil.copytree(claim_root, backup / 'claims')
    assert tree_bytes(backup / 'claims') == old_claims
    assert ledger_tables(backup / 'ledger.sqlite3') == old_tables

    # Simulate lost canonical copies only inside this TEMP fixture. Restore to
    # the same absolute paths; retain originals rather than delete old claims.
    meter.state_path.rename(tmp_path / 'held-original-pointer-ledger.sqlite3')
    claim_root.rename(tmp_path / 'held-original-claims')
    shutil.copyfile(backup / 'ledger.sqlite3', meter.state_path)
    shutil.copytree(backup / 'claims', claim_root)
    validated = gate.validate_trial_authorization(
        receipt_path=meter.receipt_path, state_path=meter.state_path)
    assert validated['scope_used_requests'] == 0
    assert validated['remaining_requests'] == 1
    assert validated['protected_through_attempt_id'] == 5
    assert tree_bytes(claim_root) == old_claims
    assert ledger_tables(meter.state_path) == old_tables
    assert snapshot.read_bytes() == case['old_state']
    assert_preserved_history(case, meter.state_path)
    # Backup/restore creates no allocation or new attempt and never revives the
    # failed authority that this separate recovered scope inherited.
    assert trial_budget.budget_snapshot(planned['document']['cumulative_budget'])['attempt_allocations'] == 0
    with pytest.raises(gate.TrialGateError):
        gate.validate_trial_authorization(receipt_path=case['receipt'], state_path=case['state'])


@pytest.mark.parametrize('damage', ['missing', 'corrupt'])
def test_pointer_ledger_without_exact_external_snapshot_cannot_validate(
    recovered_scope, damage,
):
    case, planned, recovery_result, meter, snapshot = recovered_scope
    ledger_before = meter.state_path.read_bytes()
    claims_before = {path: raw for path, raw in tree_bytes(gate.CONTINUATION_CLAIM_ROOT).items()
                     if not path.startswith('snapshots/')}
    original = snapshot.read_bytes()
    original_mode = snapshot.stat().st_mode & 0o777
    held = snapshot.with_name('held-synthetic-snapshot.sqlite3')
    try:
        if damage == 'missing':
            snapshot.rename(held)
        else:
            snapshot.chmod(0o600)
            snapshot.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
        with pytest.raises(gate.TrialGateError):
            gate.validate_trial_authorization(receipt_path=meter.receipt_path, state_path=meter.state_path)
        assert meter.state_path.read_bytes() == ledger_before
        assert {path: raw for path, raw in tree_bytes(gate.CONTINUATION_CLAIM_ROOT).items()
                if not path.startswith('snapshots/')} == claims_before
        assert trial_budget.budget_snapshot(planned['document']['cumulative_budget'])['attempt_allocations'] == 0
    finally:
        if damage == 'missing':
            held.rename(snapshot)
        else:
            snapshot.write_bytes(original)
            snapshot.chmod(original_mode)
    assert gate.validate_trial_authorization(receipt_path=meter.receipt_path,
                                             state_path=meter.state_path)['remaining_requests'] == 1
    assert_preserved_history(case, meter.state_path)


def test_same_pointer_and_claims_cannot_migrate_ledger_to_different_state_path(
    recovered_scope, tmp_path,
):
    case, planned, recovery_result, meter, snapshot = recovered_scope
    canonical_before = meter.state_path.read_bytes()
    claims_before = tree_bytes(gate.CONTINUATION_CLAIM_ROOT)
    migrated = tmp_path / 'different-canonical-state.sqlite3'
    shutil.copyfile(meter.state_path, migrated)
    with pytest.raises(gate.TrialGateError):
        gate.validate_trial_authorization(receipt_path=meter.receipt_path, state_path=migrated)
    assert migrated.read_bytes() == canonical_before
    assert meter.state_path.read_bytes() == canonical_before
    assert tree_bytes(gate.CONTINUATION_CLAIM_ROOT) == claims_before
    assert gate.validate_trial_authorization(receipt_path=meter.receipt_path,
                                             state_path=meter.state_path)['remaining_requests'] == 1
    assert_preserved_history(case, meter.state_path)


def test_different_targets_race_for_one_fixed_failed_claim_only_one_can_activate(
    failed_setup, monkeypatch,
):
    case = failed_setup
    failed_before = protected(case)
    result = recovery.append_failed_setup_recovery(**case['append_args'])
    first = prepare_new(case)
    second = copy.deepcopy(first)
    second['state'] = first['state'].with_name('concurrent-other-state.sqlite3')
    assert not first['state'].exists() and not second['state'].exists()

    # Both callers reach the real exclusive create, exercising the check/create
    # race. Do not mock filesystem claims, SQLite, owner observation or locks.
    both_ready = Barrier(2)
    original = recovery._exclusive_json

    def simultaneous_create(path, value):
        if Path(path).name.startswith('failed-setup-consumed-'):
            both_ready.wait(timeout=10)
        return original(path, value)

    monkeypatch.setattr(recovery, '_exclusive_json', simultaneous_create)

    def attempt(planned):
        try:
            return planned, consume(case, planned, result), None
        except (ValueError, FileExistsError) as error:
            return planned, None, error

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(attempt, [first, second]))
    successes = [row for row in outcomes if row[2] is None]
    losers = [row for row in outcomes if row[2] is not None]
    assert len(successes) == len(losers) == 1
    winner, consumed, _ = successes[0]
    loser = losers[0][0]
    assert not winner['state'].exists() and not loser['state'].exists()
    claims = list(gate.CONTINUATION_CLAIM_ROOT.glob('failed-setup-consumed-*.json'))
    assert len(claims) == 1
    claim_before = claims[0].read_bytes()
    assert json.loads(claim_before)['state_path'] == str(winner['state'].resolve())
    assert consumed[2] == str(claims[0])

    meter, activated = succeed(winner, recovery_path=result['recovery_path'])
    assert activated['remaining_requests'] == 1
    assert meter.state_path == winner['state']
    assert not loser['state'].exists()
    with pytest.raises(ValueError):
        consume(case, loser, result)
    assert not loser['state'].exists()
    assert claims[0].read_bytes() == claim_before
    for filename, raw in failed_before.items():
        if filename != case['document']['cumulative_budget']['state_path']:
            assert Path(filename).read_bytes() == raw
    assert_preserved_history(case, meter.state_path)
    assert trial_budget.budget_snapshot(winner['document']['cumulative_budget'])['attempt_allocations'] == 0
