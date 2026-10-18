"""Invented approvals, synthetic hashes, temporary SQLite; no external calls."""
import copy
import hashlib
import json
import shutil
import socket
import sqlite3
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest

from backend import trial_budget as budget


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def authorization_fixture():
    return {'schema_version': budget.SCHEMA, 'authorization_id': 'invented-fixture-only-cumulative-approval',
            'status': 'approved', 'authorization_source': 'explicit_owner_approval',
            'approval_ref': 'invented-human-reference-not-actual-authority',
            'effective_at': (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
            'project': 'NoReset', 'currency': 'USD', 'total_estimated_usd': '1.00',
            'synthetic_only': True, 'hard_currency_cap': False, 'billing_limitations_accepted': True,
            'unknown_final_cost_accepted': True, 'services': copy.deepcopy(budget.SERVICES)}


def initialized(tmp_path):
    return budget.initialize_authorization(authorization_fixture(),
        authorization_path=(tmp_path / 'cumulative-approval.json').resolve(),
        state_path=(tmp_path / 'cumulative-reservations.sqlite3').resolve())


def identity_recovery_fixture(tmp_path, monkeypatch):
    """Build a complete fictional 41/31/26 ledger whose device label changed."""
    descriptor = initialized(tmp_path)
    auth_path, db_path = Path(descriptor['authorization_path']), Path(descriptor['state_path'])
    record = json.loads(auth_path.read_text())
    actual_device, inode = db_path.stat().st_dev, db_path.stat().st_ino
    old_device = actual_device + 1
    record['state_device'] = old_device
    raw = budget._encode(record).encode(); auth_sha = digest(raw.decode())
    auth_path.write_bytes(raw)
    descriptor = {'authorization_sha256': auth_sha, 'authorization_path': str(auth_path), 'state_path': str(db_path)}
    with sqlite3.connect(db_path) as db:
        db.execute('UPDATE metadata SET authorization_sha256=?,record_json=?', (auth_sha, budget._encode(record)))
        db.execute(budget.NATIVE_ROOT_SQL)
        native_rows = []
        receipts = []
        allocations = 0
        for index in range(1, 42):
            receipt_id = f'legacy-{index:02}'
            seq = ('llm', 'llm') if index <= 15 else (('llm',) if index == 16 else ('llm',))
            receipt = receipt_fixture(descriptor, seq, receipt_id)
            receipt['previous_receipt_sha256'] = auth_sha
            binding_sha, _ = budget._receipt_binding(descriptor, receipt, record, historical=True)
            registered = budget._encode(receipt)
            db.execute('INSERT INTO batches VALUES (?,?,?,?,?)',
                       (receipt_id, binding_sha, registered, 'closed', 'owner_stop'))
            if index <= 15:
                allocation_slots = 2
            elif index == 16:
                allocation_slots = 1
            else:
                allocation_slots = 0
            for slot in range(allocation_slots):
                kind = receipt['request_sequence'][slot]
                profile = receipt['profiles'][kind]
                ordinal = receipt['request_sequence'][:slot].count(kind)
                allocations += 1
                observation = None if allocations == 2 else '{}'
                db.execute('INSERT INTO allocations VALUES (?,?,?,?,?,?,?,?,?)',
                    (allocations, receipt_id, slot, kind, profile['source_sha256'][ordinal],
                     profile['request_sha256'][ordinal], budget._units(profile['billing']['estimated_usd']),
                     '2026-10-14T00:00:00+00:00', observation))
            if index <= 26:
                scope = tmp_path / 'old-native' / receipt_id
                scope.mkdir(parents=True)
                native_state = scope / 'ledger.sqlite3'; native_state.write_bytes(f'opaque {index}'.encode())
                receipt_path = scope / 'authorization.json'
                receipt_raw = budget._encode(receipt).encode(); receipt_path.write_bytes(receipt_raw)
                manifest_path = scope / 'manifest.json'
                manifest = {'receipt_path': str(receipt_path), 'receipt_sha256': digest(receipt_raw.decode()),
                            'state_path': str(native_state)}
                manifest_raw = budget._encode(manifest).encode(); manifest_path.write_bytes(manifest_raw)
                native_stat = native_state.stat()
                native = {'schema_version': budget.NATIVE_ROOT_SCHEMA, 'receipt_id': receipt_id,
                    'root_id': digest(f'root-{index}'), 'manifest_path': str(manifest_path),
                    'manifest_sha256': digest(manifest_raw.decode()), 'receipt_sha256': digest(receipt_raw.decode()),
                    'state_path': str(native_state), 'state_device': old_device, 'state_inode': native_stat.st_ino,
                    'state_identity': f'{index:032x}', 'budget_baseline': {}}
                db.execute('INSERT INTO native_roots VALUES (?,?,?,?)',
                    (receipt_id, native['root_id'], str(native_state), budget._encode(native)))
                native_rows.append((receipt_id, native['root_id'], str(native_state), budget._encode(native)))
            receipts.append(receipt)
    with sqlite3.connect(db_path) as db:
        seal = budget._row_seal(db, descriptor)
        for receipt_id, _root_id, _state_path, record_json in native_rows:
            native = json.loads(record_json); native['budget_baseline'] = seal
            db.execute('UPDATE native_roots SET record_json=? WHERE receipt_id=?',
                       (budget._encode(native), receipt_id))
        native_rows = db.execute('SELECT receipt_id,root_id,state_path,record_json FROM native_roots ORDER BY receipt_id').fetchall()
    native_sha = digest(budget._encode(native_rows))
    approval = {'schema': budget.IDENTITY_RECOVERY_APPROVAL_SCHEMA, 'status': 'approved',
        'authorization_source': 'explicit_owner_approval', 'approval_ref': 'user-reply:synthetic-fixture-approval',
        'observed_at': datetime.now(timezone.utc).isoformat(),
        'verbatim_owner_reply': '允许恢复原账本身份，保留全部记录', 'scope': 'synthetic test fixture only',
        'original_authorization_sha256': auth_sha, 'authorization_path': str(auth_path),
        'state_path': str(db_path), 'state_identity': record['state_identity'], 'old_device': old_device,
        'new_device': actual_device, 'unchanged_inode': inode, 'original_seal': seal,
        'original_native_count': 26, 'original_native_rows_sha256': native_sha,
        'actual_sidecar_created': False, 'actual_recovery_performed': False, 'new_provider_calls': 0}
    return {'descriptor': descriptor, 'record_raw': raw, 'seal': seal, 'receipts': receipts,
            'approval': approval, 'old_native_ids': [item[0] for item in native_rows],
            'db_path': db_path, 'auth_path': auth_path}


def receipt_fixture(descriptor, sequence=('asr', 'llm', 'llm'), receipt_id='invented-batch'):
    now = datetime.now(timezone.utc)
    profiles = {}
    for kind in set(sequence):
        output = 2048 if kind == 'llm' else 1024
        incoming = 24000 if kind == 'llm' else 2048
        profiles[kind] = dict(provider=budget.SERVICES[kind]['provider'], model=budget.SERVICES[kind]['model'],
            url=budget.URLS[kind], requests=sequence.count(kind),
            max_input_bytes=24000 if kind == 'llm' else 3 * 1024 * 1024,
            max_output_tokens=output, max_thinking_tokens=0,
            source_sha256=[digest(f'{receipt_id}-{kind}-source-{i}') for i in range(sequence.count(kind))],
            request_sha256=[digest(f'{receipt_id}-{kind}-request-{i}') for i in range(sequence.count(kind))],
            billing={'status': 'disclosed_estimate', 'currency': 'USD', 'model': budget.SERVICES[kind]['model'],
                'evidence_url': 'https://api-docs.deepseek.com/quick_start/pricing/' if kind == 'llm'
                                else 'https://aihubmix.com/model/gemini-2.5-flash-lite',
                'evidence_date': now.date().isoformat(), 'expires_at': (now + timedelta(minutes=50)).isoformat(),
                'approval_ref': 'invented-fixture-billing-risk-disclosure',
                'usd_per_million_input_tokens': '0.30',
                'usd_per_million_generated_tokens': '1.20' if kind == 'llm' else '0.40',
                'estimated_input_tokens': incoming, 'estimated_usd': budget.SERVICES[kind]['estimated_upper_usd'],
                'observed_input_tokens_limit': incoming, 'observed_generated_tokens_limit': output,
                'completion_tokens_include_reasoning': True,
                'returned_models': [budget.SERVICES[kind]['model']],
                'complete_cost_bound_known': False, 'internal_billable_attempts_known': False})
    planned = sum(budget._units(budget.SERVICES[k]['estimated_upper_usd']) for k in sequence)
    return {'schema_version': budget.RECEIPT_SCHEMA, 'receipt_id': receipt_id, 'status': 'approved',
            'authorization_source': 'explicit_owner_approval', 'approval_ref': 'invented-scope-within-fixture-budget',
            'synthetic_only': True, 'approved_at': now.isoformat(),
            'expires_at': (now + timedelta(minutes=45)).isoformat(), 'total_requests': 5 + len(sequence),
            'planned_text_requests': sequence.count('llm'), 'previous_receipt_sha256': 'a' * 64,
            'cumulative_budget': copy.deepcopy(descriptor), 'request_sequence': list(sequence), 'profiles': profiles,
            'spend_authorization': {'currency': 'USD', 'estimated_new_usd': budget._usd(planned),
                'hard_currency_cap': False, 'billing_limitations_accepted': True,
                'scope': 'limited_requests_with_disclosed_non_hard_estimate', 'unknown_final_cost_accepted': True}}


def reserve(descriptor, receipt, slot):
    kind = receipt['request_sequence'][slot]
    profile = receipt['profiles'][kind]
    index = receipt['request_sequence'][:slot].count(kind)
    return budget.reserve_estimate(descriptor, receipt=receipt, slot=slot, kind=kind,
        source_sha256=profile['source_sha256'][index], request_sha256=profile['request_sha256'][index],
        estimated_upper_usd=profile['billing']['estimated_usd'])


def observe(descriptor, receipt, slot, **changes):
    kind = receipt['request_sequence'][slot]
    profile = receipt['profiles'][kind]
    index = receipt['request_sequence'][:slot].count(kind)
    values = dict(receipt_id=receipt['receipt_id'], slot=slot, kind=kind,
        source_sha256=profile['source_sha256'][index], request_sha256=profile['request_sha256'][index],
        returned_model=profile['model'], response_sha256=digest(f'captured-response-{slot}'),
        usage={'prompt_tokens': 1, 'completion_tokens': 1, 'completion_tokens_details': {'reasoning_tokens': 0}})
    values.update(changes)
    return budget.mark_observed(descriptor, **values)


@pytest.fixture(autouse=True)
def no_network_or_runtime(monkeypatch, tmp_path):
    def rejected(*args, **kwargs):
        pytest.fail('These tests must not open any network connection')
    monkeypatch.setattr(socket, 'socket', rejected)
    monkeypatch.setattr(budget, 'CLAIM_ROOT', (tmp_path / 'exclusive-fixture-claims').resolve())


def test_no_implicit_initialization_and_exclusive_canonical_setup(tmp_path):
    missing = {'authorization_sha256': 'a' * 64,
               'authorization_path': str((tmp_path / 'missing.json').resolve()),
               'state_path': str((tmp_path / 'missing.sqlite3').resolve())}
    with pytest.raises(budget.TrialBudgetError):
        budget.budget_snapshot(missing)
    assert not (tmp_path / 'missing.sqlite3').exists()
    descriptor = initialized(tmp_path)
    before = (tmp_path / 'cumulative-approval.json').read_bytes()
    with pytest.raises(budget.TrialBudgetError):
        initialized(tmp_path)
    assert (tmp_path / 'cumulative-approval.json').read_bytes() == before
    assert budget.budget_snapshot(descriptor)['reserved_estimate_usd'] == '0'


def test_owner_approved_device_recovery_keeps_prefix_and_new_scope_appends(tmp_path, monkeypatch):
    f = identity_recovery_fixture(tmp_path, monkeypatch)
    before = Path(f['auth_path']).read_bytes()
    with pytest.raises(budget.TrialBudgetError):
        budget.budget_snapshot(f['descriptor'])
    invalid_approval = dict(f['approval'], approval_ref='')
    with pytest.raises(budget.TrialBudgetError):
        budget.restore_device_identity(f['descriptor'], approval=invalid_approval)
    result = budget.restore_device_identity(f['descriptor'], approval=f['approval'])
    sidecar = Path(result['sidecar_path'])
    assert result['recovered'] is True and sidecar.stat().st_mode & 0o777 == 0o600
    assert Path(f['auth_path']).read_bytes() == before
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['seal']) == f['seal']
    assert budget.budget_snapshot(f['descriptor'])['attempt_allocations'] == 31
    transition = budget.identity_recovery_transition(f['descriptor'])
    assert transition['native_receipt_ids'] == tuple(f['old_native_ids'])

    # A closed old scope may be inspected under the exact same-inode alias, never resumed.
    old_receipt = f['receipts'][0]
    with sqlite3.connect(f['db_path']) as db:
        budget._guard_native_budget(db, f['descriptor'], old_receipt['receipt_id'], old_receipt)
    with pytest.raises(budget.TrialBudgetError):
        reserve(f['descriptor'], old_receipt, 0)

    successor = receipt_fixture(f['descriptor'], ('asr',), 'new-after-device-recovery')
    budget.register_batch(f['descriptor'], receipt=successor)
    reserve(f['descriptor'], successor, 0)
    budget.close_batch(f['descriptor'], receipt_id=successor['receipt_id'], reason='owner_stop')
    assert budget.batch_status(f['descriptor'], receipt=successor)['closed'] is True
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['seal']) == f['seal']


@pytest.mark.parametrize('tamper', ['claim', 'active', 'prefix'])
def test_identity_recovery_rejects_bad_source_without_sidecar(tmp_path, monkeypatch, tamper):
    f = identity_recovery_fixture(tmp_path, monkeypatch)
    if tamper == 'claim':
        record = json.loads(Path(f['auth_path']).read_text())
        Path(record['claim_paths'][0]).write_text('changed')
    elif tamper == 'active':
        with sqlite3.connect(f['db_path']) as db:
            db.execute("UPDATE batches SET status='active',closure_reason=NULL WHERE rowid=1")
    else:
        with sqlite3.connect(f['db_path']) as db:
            db.execute("UPDATE allocations SET reserved_units=reserved_units+1 WHERE id=1")
    with pytest.raises(budget.TrialBudgetError):
        budget.restore_device_identity(f['descriptor'], approval=f['approval'])
    assert not Path(f['auth_path']).with_name(budget.IDENTITY_RECOVERY_PATH_NAME).exists()


def test_identity_recovery_sidecar_tampering_fails_closed_and_duplicate_is_refused(tmp_path, monkeypatch):
    f = identity_recovery_fixture(tmp_path, monkeypatch)
    sidecar = Path(f['auth_path']).with_name(budget.IDENTITY_RECOVERY_PATH_NAME)
    sidecar.write_text('{}')
    with pytest.raises(budget.TrialBudgetError):
        budget.restore_device_identity(f['descriptor'], approval=f['approval'])
    sidecar.unlink()
    budget.restore_device_identity(f['descriptor'], approval=f['approval'])
    original = sidecar.read_bytes()
    with pytest.raises(budget.TrialBudgetError):
        budget.restore_device_identity(f['descriptor'], approval=f['approval'])
    sidecar.write_text('{}')
    with pytest.raises(budget.TrialBudgetError):
        budget.budget_snapshot(f['descriptor'])


@pytest.mark.parametrize('changes', [{'status': 'proposed'}, {'project': 'Other'}, {'synthetic_only': False},
    {'total_estimated_usd': '2'}, {'hard_currency_cap': True}, {'approval_ref': ''},
    {'authorization_source': 'environment_flag'}, {'effective_at': '2039-01-01T00:00:00Z'}])
def test_invalid_approval_creates_no_budget(tmp_path, changes):
    authorization = authorization_fixture(); authorization.update(changes)
    with pytest.raises(budget.TrialBudgetError):
        budget.initialize_authorization(authorization, authorization_path=(tmp_path / 'bad.json').resolve(),
                                        state_path=(tmp_path / 'bad.sqlite3').resolve())
    assert not (tmp_path / 'bad.json').exists() and not (tmp_path / 'bad.sqlite3').exists()


def test_unregistered_or_missing_scope_denies_without_reserved_cost(tmp_path):
    descriptor = initialized(tmp_path); receipt = receipt_fixture(descriptor)
    with pytest.raises(budget.TrialBudgetError): reserve(descriptor, receipt, 0)
    receipt['cumulative_budget'] = None
    with pytest.raises(budget.TrialBudgetError): budget.register_batch(descriptor, receipt=receipt)
    assert budget.budget_snapshot(descriptor)['attempt_allocations'] == 0


def test_three_request_batch_reserves_exact_maximum_without_old_history(tmp_path):
    descriptor = initialized(tmp_path); receipt = receipt_fixture(descriptor)
    budget.register_batch(descriptor, receipt=receipt)
    for slot in range(3):
        allocation = reserve(descriptor, receipt, slot)
        assert allocation['refundable'] is False and allocation['supplier_final_cost_usd'] is None
        observe(descriptor, receipt, slot)
    snapshot = budget.budget_snapshot(descriptor)
    assert snapshot['reserved_estimate_usd'] == '0.0203392'
    assert snapshot['response_usage_known'] == 3 and snapshot['response_usage_unknown'] == 0
    assert snapshot['supplier_hard_cap'] is False and snapshot['prior_authorization_consumption_included'] is False
    assert snapshot['supplier_final_cost_usd'] is None


def test_scope_order_pairs_duplicate_slot_and_quote_changes_fail_closed(tmp_path):
    descriptor = initialized(tmp_path); receipt = receipt_fixture(descriptor)
    budget.register_batch(descriptor, receipt=receipt)
    with pytest.raises(budget.TrialBudgetError): reserve(descriptor, receipt, 1)
    reserve(descriptor, receipt, 0)
    with pytest.raises(budget.TrialBudgetError): reserve(descriptor, receipt, 0)
    changed = copy.deepcopy(receipt); changed['profiles']['llm']['billing']['estimated_usd'] = '0.0001'
    with pytest.raises(budget.TrialBudgetError): reserve(descriptor, changed, 1)
    changed = copy.deepcopy(receipt); changed['profiles']['llm']['url'] = 'https://other.example/api'
    with pytest.raises(budget.TrialBudgetError): reserve(descriptor, changed, 1)
    assert budget.budget_snapshot(descriptor)['reserved_estimate_usd'] == '0.001024'


def test_dynamic_hash_append_does_not_change_registered_authority(tmp_path):
    descriptor = initialized(tmp_path); receipt = receipt_fixture(descriptor)
    expected = copy.deepcopy(receipt['profiles']['llm'])
    receipt['profiles']['llm']['source_sha256'] = []; receipt['profiles']['llm']['request_sha256'] = []
    budget.register_batch(descriptor, receipt=receipt); reserve(descriptor, receipt, 0)
    receipt['approval_ref'] += ':actual-first-response-binding'
    for name in ('source_sha256', 'request_sha256'): receipt['profiles']['llm'][name].append(expected[name][0])
    reserve(descriptor, receipt, 1)
    for name in ('source_sha256', 'request_sha256'): receipt['profiles']['llm'][name].append(expected[name][1])
    reserve(descriptor, receipt, 2)
    assert budget.budget_snapshot(descriptor)['reserved_estimate_usd'] == '0.0203392'


def test_active_batch_blocks_successor_and_closed_batch_never_reopens_or_refunds(tmp_path):
    descriptor = initialized(tmp_path); receipt = receipt_fixture(descriptor, ('asr',))
    budget.register_batch(descriptor, receipt=receipt); reserve(descriptor, receipt, 0)
    successor = receipt_fixture(descriptor, ('llm',), 'invented-successor')
    with pytest.raises(budget.TrialBudgetError): budget.register_batch(descriptor, receipt=successor)
    before = budget.budget_snapshot(descriptor)['reserved_estimate_usd']
    budget.close_batch(descriptor, receipt_id=receipt['receipt_id'], reason='failed_unknown')
    with pytest.raises(budget.TrialBudgetError): budget.register_batch(descriptor, receipt=receipt)
    budget.register_batch(descriptor, receipt=successor); reserve(descriptor, successor, 0)
    assert before == '0.001024'
    assert budget.budget_snapshot(descriptor)['reserved_estimate_usd'] == '0.0106816'


def test_unknown_request_cannot_replay_in_a_new_closed_successor(tmp_path):
    descriptor = initialized(tmp_path); receipt = receipt_fixture(descriptor, ('asr',))
    budget.register_batch(descriptor, receipt=receipt); reserve(descriptor, receipt, 0)
    budget.close_batch(descriptor, receipt_id=receipt['receipt_id'], reason='timeout_unknown')
    successor = receipt_fixture(descriptor, ('asr',), 'new-small-batch')
    successor['profiles']['asr'] = copy.deepcopy(receipt['profiles']['asr'])
    budget.register_batch(descriptor, receipt=successor)
    with pytest.raises(budget.TrialBudgetError, match='累计'): reserve(descriptor, successor, 0)
    assert budget.budget_snapshot(descriptor)['reserved_estimate_usd'] == '0.001024'


def test_known_captured_response_closed_then_new_batch_can_rerun_with_new_reserve(tmp_path):
    descriptor = initialized(tmp_path); receipt = receipt_fixture(descriptor, ('llm',))
    budget.register_batch(descriptor, receipt=receipt); reserve(descriptor, receipt, 0); observe(descriptor, receipt, 0)
    budget.close_batch(descriptor, receipt_id=receipt['receipt_id'], reason='business_validation_failed')
    successor = receipt_fixture(descriptor, ('llm',), 'new-after-local-fix')
    successor['profiles']['llm'] = copy.deepcopy(receipt['profiles']['llm'])
    budget.register_batch(descriptor, receipt=successor); reserve(descriptor, successor, 0)
    assert budget.budget_snapshot(descriptor)['reserved_estimate_usd'] == '0.0193152'


@pytest.mark.parametrize('changes', [{'response_sha256': 'bad'}, {'request_sha256': 'f' * 64},
    {'returned_model': 'new-model'}, {'usage': {}},
    {'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'completion_tokens_details': {'reasoning_tokens': 1}}},
    {'usage': {'prompt_tokens': 24001, 'completion_tokens': 1, 'completion_tokens_details': {'reasoning_tokens': 0}}}])
def test_invalid_observation_never_unblocks_unknown_replay(tmp_path, changes):
    descriptor = initialized(tmp_path); receipt = receipt_fixture(descriptor, ('llm',))
    budget.register_batch(descriptor, receipt=receipt); reserve(descriptor, receipt, 0)
    with pytest.raises(budget.TrialBudgetError): observe(descriptor, receipt, 0, **changes)
    snapshot = budget.budget_snapshot(descriptor)
    assert snapshot['response_usage_unknown'] == 1 and snapshot['reserved_estimate_usd'] == '0.0096576'


def test_copy_authority_or_database_cannot_clone_budget_and_replacing_inode_denies(tmp_path):
    descriptor = initialized(tmp_path)
    for key in ('authorization_path', 'state_path'):
        copied = tmp_path / ('copied-' + key)
        shutil.copyfile(descriptor[key], copied)
        changed = dict(descriptor, **{key: str(copied.resolve())})
        with pytest.raises(budget.TrialBudgetError): budget.budget_snapshot(changed)
    replacement = tmp_path / 'replacement.sqlite3'; shutil.copyfile(descriptor['state_path'], replacement)
    replacement.replace(descriptor['state_path'])
    with pytest.raises(budget.TrialBudgetError): budget.budget_snapshot(descriptor)


def test_changed_authority_hash_and_missing_database_do_not_recreate_state(tmp_path):
    descriptor = initialized(tmp_path)
    changed = dict(descriptor, authorization_sha256='0' * 64)
    with pytest.raises(budget.TrialBudgetError): budget.budget_snapshot(changed)
    from pathlib import Path
    Path(descriptor['state_path']).unlink()
    with pytest.raises(budget.TrialBudgetError): budget.budget_snapshot(descriptor)
    assert not Path(descriptor['state_path']).exists()


def test_two_concurrent_same_slot_reservations_allocate_once(tmp_path):
    descriptor = initialized(tmp_path); receipt = receipt_fixture(descriptor, ('llm',))
    budget.register_batch(descriptor, receipt=receipt)
    def attempt():
        try: return reserve(descriptor, receipt, 0)
        except budget.TrialBudgetError: return None
    with ThreadPoolExecutor(max_workers=2) as workers: results = list(workers.map(lambda _: attempt(), range(2)))
    assert sum(result is not None for result in results) == 1
    assert budget.budget_snapshot(descriptor)['reserved_estimate_usd'] == '0.0096576'


def test_cumulative_maximum_and_near_limit_stop_without_refunds(tmp_path):
    descriptor = initialized(tmp_path)
    for index in range(102):
        receipt = receipt_fixture(descriptor, ('llm',), f'invented-{index}')
        budget.register_batch(descriptor, receipt=receipt); reserve(descriptor, receipt, 0)
        budget.close_batch(descriptor, receipt_id=receipt['receipt_id'], reason='fixture-complete')
    snapshot = budget.budget_snapshot(descriptor)
    assert snapshot['reserved_estimate_usd'] == '0.9850752'
    assert snapshot['response_usage_unknown'] == 102
    with pytest.raises(budget.TrialBudgetError):
        budget.register_batch(descriptor, receipt=receipt_fixture(descriptor, ('llm',), 'one-too-many'))
    assert budget.budget_snapshot(descriptor) == snapshot


def test_expired_scope_and_different_cumulative_binding_are_denied(tmp_path):
    descriptor = initialized(tmp_path); receipt = receipt_fixture(descriptor)
    receipt['expires_at'] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    with pytest.raises(budget.TrialBudgetError): budget.register_batch(descriptor, receipt=receipt)
    receipt = receipt_fixture(descriptor); receipt['cumulative_budget']['authorization_sha256'] = 'b' * 64
    with pytest.raises(budget.TrialBudgetError): budget.register_batch(descriptor, receipt=receipt)
    assert budget.budget_snapshot(descriptor)['attempt_allocations'] == 0


def test_readonly_batch_validation_never_registers_and_binds_billing(tmp_path):
    descriptor = initialized(tmp_path); receipt = receipt_fixture(descriptor)
    with pytest.raises(budget.TrialBudgetError): budget.validate_batch(descriptor, receipt=receipt)
    assert budget.budget_snapshot(descriptor)['batches'] == []
    budget.register_batch(descriptor, receipt=receipt)
    from pathlib import Path
    before = Path(descriptor['state_path']).read_bytes()
    budget.validate_batch(descriptor, receipt=receipt)
    assert Path(descriptor['state_path']).read_bytes() == before
    changed = copy.deepcopy(receipt); changed['profiles']['llm']['billing']['approval_ref'] += '-changed'
    with pytest.raises(budget.TrialBudgetError): budget.validate_batch(descriptor, receipt=changed)
    budget.close_batch(descriptor, receipt_id=receipt['receipt_id'], reason='owner-stop')
    with pytest.raises(budget.TrialBudgetError): budget.validate_batch(descriptor, receipt=receipt)


def test_exact_readonly_allocation_status_retains_unknown_and_closure(tmp_path):
    descriptor = initialized(tmp_path); receipt = receipt_fixture(descriptor, ('asr',))
    budget.register_batch(descriptor, receipt=receipt); reserve(descriptor, receipt, 0)
    values = dict(receipt_id=receipt['receipt_id'], slot=0, kind='asr',
        source_sha256=receipt['profiles']['asr']['source_sha256'][0],
        request_sha256=receipt['profiles']['asr']['request_sha256'][0])
    status = budget.allocation_status(descriptor, **values)
    assert status['status'] == 'reserved_unknown' and status['batch_closed'] is False
    with pytest.raises(budget.TrialBudgetError):
        budget.allocation_status(descriptor, **dict(values, request_sha256='f' * 64))
    observe(descriptor, receipt, 0)
    budget.close_batch(descriptor, receipt_id=receipt['receipt_id'], reason='fixture-captured')
    status = budget.allocation_status(descriptor, **values)
    assert status['status'] == 'observed_known' and status['batch_closed'] is True
    assert status['supplier_final_cost_usd'] is None and status['reserved_estimate_usd'] == '0.001024'


@pytest.mark.parametrize('changed_identity', ['neither', 'authorization_id', 'approval_ref'])
def test_same_authorization_identity_cannot_initialize_a_second_empty_ledger(tmp_path, changed_identity):
    original = authorization_fixture()
    first = budget.initialize_authorization(original,
        authorization_path=(tmp_path / 'first.json').resolve(), state_path=(tmp_path / 'first.sqlite3').resolve())
    changed = copy.deepcopy(original)
    if changed_identity != 'neither': changed[changed_identity] += '-different'
    with pytest.raises(budget.TrialBudgetError):
        budget.initialize_authorization(changed, authorization_path=(tmp_path / 'second.json').resolve(),
                                        state_path=(tmp_path / 'second.sqlite3').resolve())
    assert budget.budget_snapshot(first)['total_planning_usd'] == '1'
    assert not (tmp_path / 'second.json').exists() and not (tmp_path / 'second.sqlite3').exists()


def test_removing_fixed_identity_claim_denies_existing_descriptor(tmp_path):
    descriptor = initialized(tmp_path)
    from pathlib import Path
    record = json.loads(Path(descriptor['authorization_path']).read_text())
    Path(record['claim_paths'][0]).unlink()
    with pytest.raises(budget.TrialBudgetError): budget.budget_snapshot(descriptor)
