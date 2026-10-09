"""Closed setup-failure budget inspection: temporary fixtures, no transport."""
import copy
from datetime import datetime, timedelta
from pathlib import Path
import socket

import pytest

from backend import trial_budget as budget
from tests.test_trial_budget_20261009 import initialized, receipt_fixture, reserve, observe


@pytest.fixture(autouse=True)
def local_only(monkeypatch, tmp_path):
    def forbidden(*args, **kwargs):
        pytest.fail('budget status tests must not open a network connection')
    monkeypatch.setattr(socket, 'socket', forbidden)
    monkeypatch.setattr(socket, 'create_connection', forbidden)
    monkeypatch.setattr(budget, 'CLAIM_ROOT', (tmp_path / 'exclusive-budget-claims').resolve())


def frozen_files(descriptor):
    import json
    authority = Path(descriptor['authorization_path'])
    record = json.loads(authority.read_bytes())
    paths = [authority, Path(descriptor['state_path']), *(Path(p) for p in record['claim_paths'])]
    return {str(path): path.read_bytes() for path in paths}


def closed_case(tmp_path, receipt_id='invented-setup-failed'):
    descriptor = initialized(tmp_path)
    receipt = receipt_fixture(descriptor, ('llm', 'llm'), receipt_id)
    budget.register_batch(descriptor, receipt=receipt)
    budget.close_batch(descriptor, receipt_id=receipt_id, reason='owner_stop')
    return descriptor, receipt


def test_closed_zero_allocations_are_real_counts_and_readonly(tmp_path):
    descriptor, receipt = closed_case(tmp_path)
    before = frozen_files(descriptor)
    result = budget.batch_status(descriptor, receipt=receipt)
    assert result['receipt_id'] == receipt['receipt_id']
    assert result['closed'] is True and result['closure_reason'] == 'owner_stop'
    assert result['allocations'] == 0 and result['global_active_batches'] == 0
    assert len(result['binding_sha256']) == 64
    assert frozen_files(descriptor) == before


@pytest.mark.parametrize('known', [False, True])
def test_closed_allocated_batch_never_looks_like_zero_or_refunds(tmp_path, known):
    descriptor = initialized(tmp_path)
    receipt = receipt_fixture(descriptor, ('llm',), 'invented-real-reservation')
    budget.register_batch(descriptor, receipt=receipt)
    reserve(descriptor, receipt, 0)
    if known:
        observe(descriptor, receipt, 0)
    budget.close_batch(descriptor, receipt_id=receipt['receipt_id'], reason='owner_stop')
    before = frozen_files(descriptor)
    snapshot = budget.budget_snapshot(descriptor)
    result = budget.batch_status(descriptor, receipt=receipt)
    assert result['allocations'] == 1 and result['global_active_batches'] == 0
    assert budget.budget_snapshot(descriptor) == snapshot
    assert snapshot['reserved_estimate_usd'] == '0.0096576'
    assert snapshot['response_usage_unknown'] == (0 if known else 1)
    assert frozen_files(descriptor) == before


def test_active_batch_is_rejected_without_closing_or_allocating(tmp_path):
    descriptor = initialized(tmp_path)
    receipt = receipt_fixture(descriptor, ('llm',), 'invented-active')
    budget.register_batch(descriptor, receipt=receipt)
    before = frozen_files(descriptor)
    with pytest.raises(budget.TrialBudgetError):
        budget.batch_status(descriptor, receipt=receipt)
    assert frozen_files(descriptor) == before


def test_other_active_batch_is_counted_in_same_snapshot(tmp_path):
    descriptor, receipt = closed_case(tmp_path)
    other = receipt_fixture(descriptor, ('llm',), 'invented-other-active')
    budget.register_batch(descriptor, receipt=other)
    before = frozen_files(descriptor)
    result = budget.batch_status(descriptor, receipt=receipt)
    assert result['closed'] is True and result['allocations'] == 0
    assert result['global_active_batches'] == 1
    assert frozen_files(descriptor) == before


@pytest.mark.parametrize('field', ['receipt_id', 'cost', 'billing_ref', 'model', 'descriptor'])
def test_wrong_closed_receipt_binding_is_rejected(tmp_path, field):
    descriptor, receipt = closed_case(tmp_path)
    changed = copy.deepcopy(receipt)
    if field == 'receipt_id':
        changed['receipt_id'] = 'invented-missing-batch'
    elif field == 'cost':
        changed['profiles']['llm']['billing']['estimated_usd'] = '0.000001'
    elif field == 'billing_ref':
        changed['profiles']['llm']['billing']['approval_ref'] += '-different'
    elif field == 'model':
        changed['profiles']['llm']['model'] = 'invented-unapproved-model'
    else:
        changed['cumulative_budget']['authorization_sha256'] = 'f' * 64
    before = frozen_files(descriptor)
    with pytest.raises(budget.TrialBudgetError):
        budget.batch_status(descriptor, receipt=changed)
    assert frozen_files(descriptor) == before


@pytest.mark.parametrize('field', ['authorization_sha256', 'state_path'])
def test_wrong_authority_or_cloned_state_is_rejected(tmp_path, field):
    descriptor, receipt = closed_case(tmp_path)
    wrong = dict(descriptor)
    if field == 'authorization_sha256':
        wrong[field] = 'f' * 64
    else:
        copied = tmp_path / 'copied-ledger.sqlite3'
        copied.write_bytes(Path(descriptor[field]).read_bytes())
        wrong[field] = str(copied.resolve())
    before = frozen_files(descriptor)
    with pytest.raises(budget.TrialBudgetError):
        budget.batch_status(wrong, receipt=receipt)
    assert frozen_files(descriptor) == before


def test_missing_batch_is_rejected_and_never_registered(tmp_path):
    descriptor = initialized(tmp_path)
    receipt = receipt_fixture(descriptor, ('llm',), 'invented-never-registered')
    before = frozen_files(descriptor)
    with pytest.raises(budget.TrialBudgetError):
        budget.batch_status(descriptor, receipt=receipt)
    assert budget.budget_snapshot(descriptor)['batches'] == []
    assert frozen_files(descriptor) == before


def test_expired_closed_history_can_be_read_without_extending_live_execution(tmp_path, monkeypatch):
    descriptor, closed_receipt = closed_case(tmp_path)
    active = receipt_fixture(descriptor, ('llm',), 'invented-live-then-expired')
    budget.register_batch(descriptor, receipt=active)
    later = datetime.fromisoformat(active['expires_at']) + timedelta(hours=2)

    class Later(datetime):
        @classmethod
        def now(cls, tz=None):
            return later.astimezone(tz)

    monkeypatch.setattr(budget, 'datetime', Later)
    before = frozen_files(descriptor)
    result = budget.batch_status(descriptor, receipt=closed_receipt)
    assert result['closed'] is True and result['allocations'] == 0
    assert result['global_active_batches'] == 1
    with pytest.raises(budget.TrialBudgetError):
        budget.validate_batch(descriptor, receipt=active)
    with pytest.raises(budget.TrialBudgetError):
        reserve(descriptor, active, 0)
    unregistered = copy.deepcopy(active)
    unregistered['receipt_id'] = 'invented-expired-successor'
    with pytest.raises(budget.TrialBudgetError):
        budget.register_batch(descriptor, receipt=unregistered)
    assert frozen_files(descriptor) == before


def test_closed_historical_binding_still_parses_and_rejects_bad_expiry(tmp_path):
    descriptor, receipt = closed_case(tmp_path)
    receipt['profiles']['llm']['billing']['expires_at'] = 'invented-invalid-date'
    before = frozen_files(descriptor)
    with pytest.raises(budget.TrialBudgetError):
        budget.batch_status(descriptor, receipt=receipt)
    assert frozen_files(descriptor) == before
