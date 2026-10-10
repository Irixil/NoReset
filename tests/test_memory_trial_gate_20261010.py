"""Synthetic temporary authority only. No credentials, runtime or network."""
import copy
import contextvars
import hashlib
import json
import os
import shutil
import socket
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from backend import model_client
from backend import trial_budget as budget
from backend import trial_gate as gate
from backend.conversation import SYSTEM_PROMPT, conversation_turn
from scripts.run_text_trial import PreviewProvider, PreviewReady
from tests.test_trial_budget_20261009 import initialized, receipt_fixture, reserve as old_reserve, observe


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(value, ensure_ascii=False, indent=2).encode()
    path.write_bytes(raw)
    return sha(raw)


@pytest.fixture(autouse=True)
def offline_temp_only(monkeypatch, tmp_path):
    def reject(*args, **kwargs):
        pytest.fail('A memory gate test attempted network transport')
    monkeypatch.setattr(socket, 'socket', reject)
    monkeypatch.setattr(budget, 'CLAIM_ROOT', tmp_path / 'claims')
    monkeypatch.setattr(gate, 'ROOT', tmp_path)
    monkeypatch.setattr(gate, 'CONTINUATION_CLAIM_ROOT', tmp_path / 'runtime')


def proposed(tmp_path, monkeypatch):
    descriptor = initialized(tmp_path)
    for index in range(15):
        old = receipt_fixture(descriptor, ('asr',) if index == 0 else ('llm',), f'old-{index}')
        budget.register_batch(descriptor, receipt=old)
        if index < 11:
            old_reserve(descriptor, old, 0)
            if index != 1:
                observe(descriptor, old, 0)
        budget.close_batch(descriptor, receipt_id=old['receipt_id'], reason='owner_stop')
    baseline = budget.cumulative_row_seal(descriptor)
    assert baseline['reserved_units'] == 97600000 and baseline['unknown_allocation_ids'] == [2]
    old_native = tmp_path / 'old-native.sqlite3'
    old_native.write_bytes(b'historical native contents must never be read')
    old_receipt = tmp_path / 'old-receipt.json'
    old_sha = save(old_receipt, {'historical': 'reference only'})
    info = old_native.stat()
    audit = {'current_native': {'ledger_path': str(old_native), 'ledger_stat': {
                'bytes': info.st_size, 'mtime_ns': info.st_mtime_ns, 'inode': info.st_ino, 'device': info.st_dev},
                'closed_reason': 'owner_stop', 'receipt_path': str(old_receipt), 'receipt_sha256': old_sha,
                'full_row_projections': {'attempts': [dict(kind='llm', source_sha256=sha(f'old-source-{i}'.encode()),
                                                          request_sha256=sha(f'old-wire-{i}'.encode())) for i in range(16)]}},
             'cumulative_budget': {'same_original_descriptor': descriptor, 'planning_hold_usd': '0.0976'},
             'actual_counts': {'budget_batch_records': 15, 'originalUSD1_allocation_attempts': 11,
                              'all_budget_batches_closed': True}}
    audit_path = tmp_path / 'historical-reference.json'
    audit_sha = save(audit_path, audit)
    source = tmp_path / 'candidate.py'
    source.write_text('synthetic memory candidate\n')
    receipt = receipt_fixture(descriptor, ('llm', 'llm'), 'new-memory-root')
    receipt['total_requests'] = 2
    receipt['previous_receipt_sha256'] = descriptor['authorization_sha256']
    pairs, payloads, wires = [], [], []
    for index in range(2):
        payload = {'turns': [{'role': 'user', 'content': f'虚构用户的新会话问题{index}'}],
                   'health_context': {'items': []}, 'controller': {}, 'approved_risk_rules': []}
        serialized = json.dumps(payload, ensure_ascii=False, allow_nan=False)
        body = {'thinking': {'type': 'disabled'}, 'model': 'deepseek-flash', 'temperature': 0, 'stream': False,
                'max_tokens': 2048, 'messages': [{'role': 'system', 'content': SYSTEM_PROMPT},
                                               {'role': 'user', 'content': serialized}],
                'response_format': {'type': 'json_object'}}
        wire = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        assert len(wire) <= 24000
        payload_path, wire_path = tmp_path / f'payload-{index}.json', tmp_path / f'wire-{index}.json'
        payload_sha = save(payload_path, payload)
        wire_path.write_bytes(wire)
        source_sha, wire_sha = sha(serialized.encode()), sha(wire)
        receipt['profiles']['llm']['source_sha256'][index] = source_sha
        receipt['profiles']['llm']['request_sha256'][index] = wire_sha
        pairs.append(dict(model_payload_path=str(payload_path), model_payload_sha256=payload_sha,
                          source_sha256=source_sha, wire_path=str(wire_path), request_sha256=wire_sha))
        payloads.append(payload); wires.append(wire)
    receipt_path, state_path, manifest_path = tmp_path / 'new-receipt.json', tmp_path / 'runtime/memory.sqlite3', tmp_path / 'manifest.json'
    receipt_sha = save(receipt_path, receipt)
    manifest = dict(schema_version=gate.STANDALONE_SCHEMA, status='approved', authorization_source='explicit_owner_approval',
        approval_ref=receipt['approval_ref'], synthetic_only=True, purpose='long_term_health_memory', contract_sha256='c'*64,
        receipt_path=str(receipt_path), receipt_sha256=receipt_sha, state_path=str(state_path), cumulative_budget=descriptor,
        budget_baseline=baseline, candidate_source_sha256={'candidate.py': sha(source.read_bytes())},
        historical_reference=dict(audit_path=str(audit_path), audit_sha256=audit_sha, reference_only=True), request_pairs=pairs)
    manifest_sha = save(manifest_path, manifest)
    original = Path.read_bytes
    def no_old_read(path):
        if path == old_native:
            pytest.fail('Standalone root must only stat the old native ledger')
        return original(path)
    monkeypatch.setattr(Path, 'read_bytes', no_old_read)
    return dict(descriptor=descriptor, baseline=baseline, receipt=receipt, receipt_path=receipt_path,
                state_path=state_path, manifest_path=manifest_path, manifest_sha256=manifest_sha,
                manifest=manifest, payloads=payloads, wires=wires, old_native=old_native)


def activate(fixture):
    return gate.initialize_standalone_trial(**{key: fixture[key] for key in
        ('receipt_path', 'state_path', 'manifest_path', 'manifest_sha256')})


def bind_payload(fixture, payload, index=0):
    serialized = json.dumps(payload, ensure_ascii=False, allow_nan=False)
    pair = fixture['manifest']['request_pairs'][index]
    wire = json.loads(fixture['wires'][index])
    wire['messages'][1]['content'] = serialized
    raw = json.dumps(wire, ensure_ascii=False, allow_nan=False).encode()
    pair['model_payload_sha256'] = save(Path(pair['model_payload_path']), payload)
    Path(pair['wire_path']).write_bytes(raw)
    pair['source_sha256'], pair['request_sha256'] = sha(serialized.encode()), sha(raw)
    for key in ('source_sha256', 'request_sha256'):
        fixture['receipt']['profiles']['llm'][key][index] = pair[key]
    fixture['manifest']['receipt_sha256'] = save(fixture['receipt_path'], fixture['receipt'])
    fixture['manifest_sha256'] = save(fixture['manifest_path'], fixture['manifest'])
    fixture['payloads'][index], fixture['wires'][index] = payload, raw


def test_actual_conversation_preview_five_fields_accepts_valid_typed_memory_and_subject(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch)
    from tests.test_health_memory_20261010 import request, memory, SUBJECT
    preview = PreviewProvider()
    with pytest.raises(PreviewReady): conversation_turn(request(memory()), provider=preview)
    assert set(preview.payload) == {'turns', 'health_context', 'controller', 'approved_risk_rules', 'subject_id'}
    assert preview.payload['subject_id'] == SUBJECT and preview.payload['health_context'] == [memory()]
    bind_payload(f, preview.payload)
    activate(f)
    assert reserve(f) == 1 and preview.system_prompt == SYSTEM_PROMPT


@pytest.mark.parametrize('change', ['other-field', 'invalid-subject', 'other-subject', 'revoked-memory'])
def test_fifth_field_is_subject_contract_only_not_arbitrary_or_mismatched_memory(tmp_path, monkeypatch, change):
    f = proposed(tmp_path, monkeypatch)
    from tests.test_health_memory_20261010 import request, memory
    preview = PreviewProvider()
    with pytest.raises(PreviewReady): conversation_turn(request(memory()), provider=preview)
    payload = preview.payload
    if change == 'other-field': payload['secret_passthrough'] = 'fictional-only'
    elif change == 'invalid-subject': payload['subject_id'] = '../fictional'
    elif change == 'other-subject': payload['health_context'][0]['subject_id'] = 'person_fictional_other'
    else: payload['health_context'][0]['confirmation_status'] = 'revoked'
    bind_payload(f, payload)
    with pytest.raises(gate.TrialGateError): activate(f)


def reserve(fixture, slot=0, **changes):
    profile = fixture['receipt']['profiles']['llm']
    args = dict(kind='llm', provider=profile['provider'], model=profile['model'], url=profile['url'],
                wire=fixture['wires'][slot], source_sha256=profile['source_sha256'][slot],
                output_tokens=2048, thinking_tokens=0)
    args.update(changes)
    return gate.TrialGate(fixture['receipt_path'], fixture['state_path']).reserve(**args)


def known(fixture, ident):
    return gate.report_usage(ident, 'deepseek-flash', {'prompt_tokens': 12, 'completion_tokens': 3,
            'completion_tokens_details': {'reasoning_tokens': 0}}, state_path=fixture['state_path'],
            transport_metadata={'response_sha256': sha(f'response-{ident}'.encode()), 'response_bytes': 42, 'protocol': 'openai'})


def owner_status(fixture):
    return budget.native_root_binding(fixture['descriptor'], receipt_id='new-memory-root', include_scope=True)


def test_finite_root_keeps_original_unknown_and_all_closed_history_without_reading_native(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch)
    result = activate(f)
    assert result['remaining_requests'] == 2
    assert result['native_history_revalidated'] is False and result['native_counts_scope'] == 'this_finite_batch_only'
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']
    assert budget.budget_snapshot(f['descriptor'])['reserved_estimate_usd'] == '0.0976'
    first = reserve(f); assert first == 1
    known(f, first); known(f, first)  # Same report is idempotent, never a refund.
    gate.confirm_trial_review(first, 'local-human-reviewed-synthetic-result', state_path=f['state_path'])
    second = reserve(f, 1); assert second == 2
    known(f, second)
    with pytest.raises(gate.TrialGateError): reserve(f, 1)
    assert owner_status(f)['status'] == 'closed'
    snapshot = budget.budget_snapshot(f['descriptor'])
    assert snapshot['reserved_estimate_usd'] == '0.1169152'
    assert snapshot['response_usage_unknown'] == 1 and snapshot['attempt_allocations'] == 13
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']


@pytest.mark.parametrize('sql', ["UPDATE allocations SET observation_json='{}' WHERE id=2",
    'UPDATE allocations SET reserved_units=reserved_units-1 WHERE id=1',
    "UPDATE allocations SET source_sha256='changed' WHERE id=1", "DELETE FROM allocations WHERE id=1",
    "UPDATE batches SET closure_reason='changed' WHERE rowid=1", "UPDATE batches SET status='active' WHERE rowid=1"])
def test_history_cas_change_before_registration_never_creates_new_budget_scope(tmp_path, monkeypatch, sql):
    f = proposed(tmp_path, monkeypatch)
    with sqlite3.connect(f['descriptor']['state_path']) as db: db.execute(sql)
    with pytest.raises(gate.TrialGateError): activate(f)
    with sqlite3.connect(f['descriptor']['state_path']) as db:
        assert db.execute("SELECT COUNT(*) FROM batches WHERE receipt_id='new-memory-root'").fetchone() == (0,)


@pytest.mark.parametrize('field,value', [('reserved_units', 0), ('reserved_units', -1), ('reserved_units', 1),
    ('observation_json', None), ('source_sha256', 'f'*64), ('request_sha256', 'e'*64)])
def test_current_reservation_and_verified_observation_tampering_denies_next_send(tmp_path, monkeypatch, field, value):
    f = proposed(tmp_path, monkeypatch); activate(f)
    ident = reserve(f); known(f, ident)
    with sqlite3.connect(f['descriptor']['state_path']) as db:
        db.execute(f'UPDATE allocations SET {field}=? WHERE receipt_id=?', (value, 'new-memory-root'))
    with pytest.raises(gate.TrialGateError): gate.confirm_trial_review(ident, 'review', state_path=f['state_path'])
    with pytest.raises(gate.TrialGateError): reserve(f, 1)
    assert len(owner_status(f)['allocations']) == 1


@pytest.mark.parametrize('changed', [dict(model='other'), dict(provider='other'), dict(url='https://example.invalid/chat/completions'),
    dict(source_sha256='f'*64), dict(wire=b'{}'), dict(output_tokens=2049), dict(thinking_tokens=1)])
def test_wrong_request_closes_owned_scope_before_transport_or_allocation(tmp_path, monkeypatch, changed):
    f = proposed(tmp_path, monkeypatch); activate(f)
    with pytest.raises(gate.TrialGateError): reserve(f, **changed)
    assert owner_status(f)['status'] == 'closed' and owner_status(f)['allocations'] == []


@pytest.mark.parametrize('mode', ['copy', 'symlink', 'hardlink', 'rename', 'replacement'])
def test_all_public_mutations_reject_other_identity_or_alias_without_closing_owner(tmp_path, monkeypatch, mode):
    f = proposed(tmp_path, monkeypatch); activate(f); ident = reserve(f); known(f, ident)
    original = f['state_path']; other = original.with_name('other.sqlite3')
    if mode == 'copy': shutil.copyfile(original, other)
    elif mode == 'symlink': other.symlink_to(original)
    elif mode == 'hardlink': os.link(original, other)
    elif mode == 'rename': original.rename(other)
    else:
        original.rename(other); shutil.copyfile(other, original); other = original
    for call in [lambda: gate.validate_trial_authorization(receipt_path=f['receipt_path'], state_path=other),
                 lambda: gate.report_usage(ident, 'deepseek-flash', {}, state_path=other),
                 lambda: gate.confirm_trial_review(ident, 'review', state_path=other),
                 lambda: gate.stop_trial(ident, 'owner_stop', state_path=other),
                 lambda: gate.close_trial_scope(f['receipt_path'], other),
                 lambda: reserve(dict(f, state_path=other), 1)]:
        with pytest.raises(gate.TrialGateError): call()
    assert owner_status(f)['status'] == 'active' and len(owner_status(f)['allocations']) == 1


def test_failed_native_insert_retains_cumulative_orphan_and_closes_scope(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch); activate(f)
    with sqlite3.connect(f['state_path']) as db:
        db.execute("CREATE TRIGGER fixture_failure BEFORE INSERT ON attempts BEGIN SELECT RAISE(ABORT,'fixture'); END")
    with pytest.raises(gate.TrialGateError): reserve(f)
    assert owner_status(f)['status'] == 'closed' and len(owner_status(f)['allocations']) == 1
    assert owner_status(f)['allocations'][0][5] is None
    assert budget.budget_snapshot(f['descriptor'])['reserved_estimate_usd'] == '0.1072576'


def test_setup_postcommit_summary_failure_closes_exact_owned_registry_without_new_allocations(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch)
    actual, failures = budget.budget_snapshot, []
    def fail_after_committed_registration(descriptor):
        with sqlite3.connect(descriptor['state_path']) as db:
            registered = db.execute("SELECT 1 FROM batches WHERE receipt_id='new-memory-root' AND status='active'").fetchone()
        if registered is not None and not failures:
            failures.append('one postcommit read failure')
            raise budget.TrialBudgetError()
        return actual(descriptor)
    monkeypatch.setattr(budget, 'budget_snapshot', fail_after_committed_registration)
    with pytest.raises(gate.TrialGateError): activate(f)
    assert failures == ['one postcommit read failure']
    scope = owner_status(f)
    assert scope['status'] == 'closed' and scope['closure_reason'] == 'standalone_setup_failed'
    assert scope['allocations'] == []
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']
    assert actual(f['descriptor'])['reserved_estimate_usd'] == '0.0976'
    with sqlite3.connect(f['state_path']) as db:
        assert db.execute('SELECT frozen_reason FROM metadata').fetchone() == ('standalone_setup_failed',)
        assert db.execute('SELECT COUNT(*) FROM attempts').fetchone() == (0,)


@pytest.mark.parametrize('table', ['standalone_root', 'authorization_snapshots', 'attempt_authorizations'])
def test_deleted_initial_snapshot_cannot_bypass_bootstrap_on_any_entry(tmp_path, monkeypatch, table):
    f = proposed(tmp_path, monkeypatch); activate(f); ident = reserve(f)
    with sqlite3.connect(f['state_path']) as db: db.execute(f'DROP TABLE {table}')
    with pytest.raises(gate.TrialGateError): reserve(f, 1)
    with pytest.raises(gate.TrialGateError): gate.close_trial_scope(f['receipt_path'], f['state_path'])
    with pytest.raises(gate.TrialGateError): gate.report_usage(ident, 'deepseek-flash', {}, state_path=f['state_path'])
    assert len(owner_status(f)['allocations']) == 1


def test_standalone_root_cannot_append_amend_or_reinitialize(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch); activate(f)
    for call in [lambda: gate.append_trial(f['receipt_path'], f['state_path']),
                 lambda: gate.amend_trial(f['receipt_path'], f['state_path']), lambda: activate(f)]:
        with pytest.raises(gate.TrialGateError): call()
    assert owner_status(f)['status'] == 'active' and owner_status(f)['allocations'] == []


def test_concurrent_registration_and_reservation_have_one_durable_winner(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch)
    def setup(_):
        try: return activate(f)
        except gate.TrialGateError: return None
    with ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(setup, range(2)))
    assert sum(r is not None for r in results) == 1
    def allocate(_):
        try: return reserve(f)
        except gate.TrialGateError: return None
    with ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(allocate, range(2)))
    assert sum(r is not None for r in results) == 1 and len(owner_status(f)['allocations']) == 1


def test_changed_candidate_payload_wire_or_old_native_stat_denies_live_preflight(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch); activate(f)
    (tmp_path / 'candidate.py').write_text('changed source')
    with pytest.raises(gate.TrialGateError): gate.validate_trial_authorization(receipt_path=f['receipt_path'], state_path=f['state_path'])
    assert len(owner_status(f)['allocations']) == 0


@pytest.mark.parametrize('target', ['candidate.py', 'payload-0.json', 'wire-0.json', 'old-native.sqlite3'])
def test_frozen_artifact_or_historical_stat_change_denies_zero_attempt(tmp_path, monkeypatch, target):
    f = proposed(tmp_path, monkeypatch); activate(f)
    (tmp_path / target).write_bytes(b'changed fictional data')
    with pytest.raises(gate.TrialGateError): reserve(f)
    assert owner_status(f)['allocations'] == []


@pytest.mark.parametrize('change', ['third', 'initial-five', 'wrong-anchor', 'missing-wire', 'unapproved', 'unknown-replay'])
def test_manifest_receipt_constraints_fail_before_global_claim(tmp_path, monkeypatch, change):
    f = proposed(tmp_path, monkeypatch)
    if change in {'third', 'initial-five'}: f['receipt']['total_requests'] = 3 if change == 'third' else 7
    elif change == 'wrong-anchor': f['receipt']['previous_receipt_sha256'] = 'f'*64
    elif change == 'missing-wire': f['manifest']['request_pairs'].pop()
    elif change == 'unapproved': f['manifest']['status'] = 'proposed'
    else:
        with sqlite3.connect(f['descriptor']['state_path']) as db:
            p = f['receipt']['profiles']['llm']
            db.execute('UPDATE allocations SET source_sha256=?,request_sha256=? WHERE id=2',
                       (p['source_sha256'][0], p['request_sha256'][0]))
        f['manifest']['budget_baseline'] = budget.cumulative_row_seal(f['descriptor'])
    f['manifest']['receipt_sha256'] = save(f['receipt_path'], f['receipt'])
    f['manifest_sha256'] = save(f['manifest_path'], f['manifest'])
    with pytest.raises(gate.TrialGateError): activate(f)
    with sqlite3.connect(f['descriptor']['state_path']) as db:
        assert db.execute("SELECT COUNT(*) FROM batches WHERE receipt_id='new-memory-root'").fetchone() == (0,)


@pytest.mark.parametrize('usage', [{}, {'prompt_tokens': 24001, 'completion_tokens': 1,
    'completion_tokens_details': {'reasoning_tokens': 0}}, {'prompt_tokens': 1, 'completion_tokens': 2049,
    'completion_tokens_details': {'reasoning_tokens': 0}}])
def test_unverified_first_usage_stops_second_and_retains_unknown_reservation(tmp_path, monkeypatch, usage):
    f = proposed(tmp_path, monkeypatch); activate(f); ident = reserve(f)
    with pytest.raises(gate.TrialGateError): gate.report_usage(ident, 'deepseek-flash', usage, state_path=f['state_path'])
    with pytest.raises(gate.TrialGateError): reserve(f, 1)
    assert owner_status(f)['status'] == 'closed' and owner_status(f)['allocations'][0][5] is None
    assert budget.budget_snapshot(f['descriptor'])['reserved_estimate_usd'] == '0.1072576'


def test_changed_old_unknown_inside_reservation_transaction_denies_before_new_allocation(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch); activate(f)
    old = budget.reserve_estimate
    def race(*args, **kwargs):
        with sqlite3.connect(f['descriptor']['state_path']) as db:
            db.execute("UPDATE allocations SET observation_json='{}' WHERE id=2")
        return old(*args, **kwargs)
    monkeypatch.setattr(budget, 'reserve_estimate', race)  # Fault injection between the two durable DB writes.
    with pytest.raises(gate.TrialGateError): reserve(f)
    assert owner_status(f)['allocations'] == []


def test_copied_context_is_revoked_when_explicit_transport_scope_exits(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch); activate(f)
    with gate.standalone_trial_scope(receipt_path=f['receipt_path'], state_path=f['state_path']):
        inherited = contextvars.copy_context()
    request = model_client.urllib.request.Request('https://api.deepseek.com/chat/completions',
                                                 f['wires'][0], method='POST')
    request._noreset_trial_profile = dict(kind='llm', provider='deepseek', model='deepseek-flash',
                                        source_sha256=f['receipt']['profiles']['llm']['source_sha256'][0])
    with pytest.raises(gate.TrialGateError): inherited.run(gate.authorize_request, request)
    assert owner_status(f)['allocations'] == []


def test_standard_model_client_uses_actual_gate_and_counts_exactly_two_without_retry(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch); activate(f)
    calls = []
    class Response:
        status = 200
        headers = {'Content-Type': 'application/json'}
        def __enter__(self): return self
        def __exit__(self, *_): return False
        def read(self, limit):
            return json.dumps({'model': 'deepseek-flash', 'choices': [{'finish_reason': 'stop',
                'message': {'role': 'assistant', 'content': '{"synthetic_result": true}'}}],
                'usage': {'prompt_tokens': 12, 'completion_tokens': 3,
                          'completion_tokens_details': {'reasoning_tokens': 0}}}).encode()
    class Opener:
        def open(self, request, timeout): calls.append(request.data); return Response()
    monkeypatch.setattr(model_client.urllib.request, 'build_opener', lambda *_: Opener())
    client = model_client.ChatCompletionsClient(base_url='https://api.deepseek.com', model='deepseek-flash',
        api_key='invented-fixture-key', json_mode=True, extra_body={'thinking': {'type': 'disabled'}},
        max_tokens=2048, trial_provider='deepseek')
    with gate.standalone_trial_scope(receipt_path=f['receipt_path'], state_path=f['state_path']):
        assert client.complete_json(SYSTEM_PROMPT, f['payloads'][0]) == {'synthetic_result': True}
        gate.confirm_trial_review(1, 'reviewed-first-synthetic-result', state_path=f['state_path'])
        assert client.complete_json(SYSTEM_PROMPT, f['payloads'][1]) == {'synthetic_result': True}
        with pytest.raises(model_client.ModelClientError): client.complete_json(SYSTEM_PROMPT, f['payloads'][1])
    assert calls == f['wires']
    assert owner_status(f)['status'] == 'closed'
    assert budget.budget_snapshot(f['descriptor'])['reserved_estimate_usd'] == '0.1169152'
