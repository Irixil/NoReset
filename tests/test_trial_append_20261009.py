"""Only invented approvals and temporary ledgers; never external transport."""
import copy
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest

from backend import trial_gate as gate
from tests.test_trial_gate import receipt_document, reserve, wire_for as legacy_wire, digest


def wire_for(kind):
    value = json.loads(legacy_wire(kind))
    if kind == 'asr': value['generationConfig']['thinkingConfig']['includeThoughts'] = False
    return json.dumps(value).encode()


def contract(mode='bounded_attempts'):
    value = dict(status='verified', approval_ref='invented-contract-for-offline-tests',
        evidence_url='https://docs.aihubmix.com/synthetic-contract-only',
        expires_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        complete_input=True, complete_generated=True, includes_reasoning=True,
        includes_internal_attempts=True, includes_failed_and_partial_attempts=True,
        includes_all_routes_and_models=True, no_additional_charges=True, mode=mode)
    if mode == 'bounded_attempts': value['max_billable_attempts'] = 2
    else: value['max_total_usd'] = '0.7'
    return value


def appended(old, previous):
    value = copy.deepcopy(old)
    value.update(schema_version='noreset-synthetic-trial-v3', receipt_id='new-synthetic-voice-only',
        approval_ref='new-invented-approval', previous_receipt_sha256=previous,
        total_requests=7, planned_text_requests=2)
    value['spend_authorization'].update(amount='3', scope='cumulative_reservations_and_new_contract_bounds')
    value['profiles'].pop('ocr')
    for profile in value['profiles'].values():
        profile['requests'] = 2
        profile['billing']['charge_contract'] = contract()
    for kind, profile in value['profiles'].items(): profile['request_sha256'] = [digest(wire_for(kind))]
    return value


@pytest.fixture
def history(tmp_path):
    receipt, state = tmp_path / 'receipt.json', tmp_path / 'ledger.sqlite3'
    old = receipt_document()
    receipt.write_text(json.dumps(old))
    gate.initialize_trial(receipt, state)
    meter = gate.TrialGate(receipt, state)
    for _ in range(3): reserve(meter, old)
    with sqlite3.connect(state) as db:
        rows = db.execute('SELECT * FROM attempts ORDER BY id').fetchall()
        previous = db.execute('SELECT receipt_sha256 FROM metadata').fetchone()[0]
    return meter, old, rows, appended(old, previous)


def append(history):
    meter, old, rows, new = history
    meter.receipt_path.write_text(json.dumps(new))
    gate.append_trial(meter.receipt_path, meter.state_path)
    return meter, new


def send(meter, document, kind='llm', report=True, **changes):
    changes.setdefault('wire', wire_for(kind))
    ident = reserve(meter, document, kind, report=False, **changes)
    if report:
        gate.report_usage(ident, document['profiles'][kind]['model'],
            {'prompt_tokens': 1, 'completion_tokens': 1,
             'completion_tokens_details': {'reasoning_tokens': 0}}, state_path=meter.state_path)
    return ident


def test_append_preserves_three_rows_and_runs_two_pairs(history):
    meter, new = append(history)
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT * FROM attempts ORDER BY id').fetchall() == history[2]
    before = gate.validate_trial_authorization(receipt_path=meter.receipt_path, state_path=meter.state_path)
    assert before['remaining_requests'] == 4
    assert before['remaining_usd'] == '2.0489088'
    for kind in ('asr', 'llm', 'asr', 'llm'): send(meter, new, kind)
    assert len(gate.trial_journal(state_path=meter.state_path)) == 7
    with pytest.raises(gate.TrialGateError): send(meter, new)


@pytest.mark.parametrize('mutate', [
    lambda x: x.update(previous_receipt_sha256='0' * 64),
    lambda x: x.update(receipt_id='synthetic-test-only'),
    lambda x: x.update(expires_at='2000-01-01T00:00:00Z'),
    lambda x: x.update(total_requests=3),
    lambda x: x['spend_authorization'].update(amount='0.5'),
    lambda x: x['spend_authorization'].update(scope='all_historical_actual_charges'),
    lambda x: x['profiles']['asr']['billing'].pop('charge_contract'),
    lambda x: x['profiles']['asr']['billing']['charge_contract'].pop('max_billable_attempts'),
    lambda x: x['profiles']['asr']['billing']['charge_contract'].update(max_billable_attempts=True),
    lambda x: x['profiles']['asr']['billing']['charge_contract'].update(includes_internal_attempts=False),
    lambda x: x['profiles']['asr']['billing']['charge_contract'].update(complete_input=False),
    lambda x: x['profiles']['asr']['billing']['charge_contract'].update(expires_at='2000-01-01T00:00:00Z'),
])
def test_invalid_append_does_not_modify_existing_attempts(history, mutate):
    meter, _, rows, new = history
    mutate(new)
    meter.receipt_path.write_text(json.dumps(new))
    with pytest.raises(gate.TrialGateError): gate.append_trial(meter.receipt_path, meter.state_path)
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT * FROM attempts ORDER BY id').fetchall() == rows


def test_expired_historical_authority_is_not_renewed_or_rejected(history, monkeypatch):
    meter, new = append(history)
    import backend.trial_gate as module
    actual = module.datetime
    class Later(actual):
        @classmethod
        def now(cls, tz=None): return actual.now(tz) + timedelta(minutes=90)
    # New authority/quote can expire later; legacy snapshots remain unchanged.
    newer = copy.deepcopy(new)
    for item in [newer, *[p['billing'] for p in newer['profiles'].values()],
                 *[p['billing']['charge_contract'] for p in newer['profiles'].values()]]:
        item['expires_at'] = (actual.now(timezone.utc) + timedelta(hours=3)).isoformat()
    # Renewal is explicit new scope, not mutation of the old authority.
    with sqlite3.connect(meter.state_path) as db:
        previous = db.execute('SELECT receipt_sha256 FROM metadata').fetchone()[0]
    newer.update(previous_receipt_sha256=previous, receipt_id='another-explicit-scope',
                 approval_ref='new-explicit-invented-approval', total_requests=7)
    meter.receipt_path.write_text(json.dumps(newer))
    monkeypatch.setattr(module, 'datetime', Later)
    gate.append_trial(meter.receipt_path, meter.state_path)
    send(meter, newer, 'asr')


def test_missing_reasoning_freezes_and_cannot_append_around(history):
    meter, new = append(history)
    ident = send(meter, new, report=False)
    with pytest.raises(gate.TrialGateError):
        gate.report_usage(ident, 'deepseek-flash', {'prompt_tokens': 1, 'completion_tokens': 1}, state_path=meter.state_path)
    with pytest.raises(gate.TrialGateError): send(meter, new, 'asr')
    with sqlite3.connect(meter.state_path) as db:
        previous = db.execute('SELECT receipt_sha256 FROM metadata').fetchone()[0]
    new.update(previous_receipt_sha256=previous, receipt_id='cannot-thaw', total_requests=11)
    meter.receipt_path.write_text(json.dumps(new))
    with pytest.raises(gate.TrialGateError): gate.append_trial(meter.receipt_path, meter.state_path)


def test_inflight_blocks_next_send_and_append(history):
    meter, new = append(history)
    send(meter, new, report=False)
    with pytest.raises(gate.TrialGateError): send(meter, new, 'asr')
    with pytest.raises(gate.TrialGateError): gate.append_trial(meter.receipt_path, meter.state_path)


def test_stop_is_durable_and_only_for_real_reserved_id(history):
    meter, new = append(history)
    with pytest.raises(gate.TrialGateError): gate.stop_trial(999, 'owner_stop', state_path=meter.state_path)
    ident = send(meter, new)
    gate.stop_trial(ident, 'business_validation_failed', state_path=meter.state_path)
    with pytest.raises(gate.TrialGateError): send(meter, new, 'asr')
    assert gate.trial_journal(state_path=meter.state_path)[-1]['reserved_usd'] == '0.6340608'


def test_single_post_contract_bound_and_metadata_are_idempotent(history):
    for profile in history[3]['profiles'].values(): profile['billing']['charge_contract'] = contract('single_post_amount')
    meter, new = append(history)
    ident = send(meter, new)
    usage = {'prompt_tokens': 1, 'completion_tokens': 1, 'completion_tokens_details': {'reasoning_tokens': 0}}
    gate.report_usage(ident, 'deepseek-flash', usage, state_path=meter.state_path,
        transport_metadata={'trace_id': 'invented-trace', 'response_sha256': 'a' * 64, 'response_bytes': 12, 'protocol': 'chat_completions'})
    gate.report_usage(ident, 'deepseek-flash', usage, state_path=meter.state_path)
    assert gate.trial_journal(state_path=meter.state_path)[-1]['reserved_usd'] == '0.7'


def test_amend_hash_does_not_reset_scope_count(history):
    meter, new = append(history)
    send(meter, new); send(meter, new)
    new['approval_ref'] = 'reviewed-new-synthetic-hash'
    new['profiles']['llm']['source_sha256'].append(digest(b'new synthetic source'))
    meter.receipt_path.write_text(json.dumps(new))
    gate.amend_trial(meter.receipt_path, meter.state_path)
    with pytest.raises(gate.TrialGateError): send(meter, new)


@pytest.mark.parametrize('changes', [{'output_tokens': 2049}, {'thinking_tokens': 1}, {'wire': b'x' * 24001}])
def test_real_limits_reject_before_reservation(history, changes):
    meter, new = append(history)
    with pytest.raises(gate.TrialGateError): send(meter, new, **changes)
    assert len(gate.trial_journal(state_path=meter.state_path)) == 3


@pytest.mark.parametrize('kind,mutate', [
    ('llm', lambda b: b.update(stream=True)),
    ('llm', lambda b: b.update(model='unapproved-model')),
    ('llm', lambda b: b.update(n=2)),
    ('llm', lambda b: b.update(thinking={'type': 'enabled'})),
    ('asr', lambda b: b['generationConfig'].update(candidateCount=2)),
    ('asr', lambda b: b['generationConfig']['thinkingConfig'].update(includeThoughts=True)),
    ('asr', lambda b: b['generationConfig']['thinkingConfig'].pop('includeThoughts')),
])
def test_even_approved_wire_cannot_bypass_actual_output_controls(history, kind, mutate):
    body = json.loads(wire_for(kind)); mutate(body)
    wire = json.dumps(body).encode()
    history[3]['profiles'][kind]['request_sha256'] = [digest(wire)]
    meter, new = append(history)
    with pytest.raises(gate.TrialGateError): send(meter, new, kind, wire=wire)
    assert len(gate.trial_journal(state_path=meter.state_path)) == 3


def test_disabled_thinking_but_nonzero_actual_thoughts_freezes(history):
    meter, new = append(history)
    ident = send(meter, new, report=False)
    with pytest.raises(gate.TrialGateError):
        gate.report_usage(ident, 'deepseek-flash', {'prompt_tokens': 1, 'completion_tokens': 2,
            'completion_tokens_details': {'reasoning_tokens': 1}}, state_path=meter.state_path)
    with pytest.raises(gate.TrialGateError): send(meter, new, 'asr')


@pytest.mark.parametrize('statement', [
    "UPDATE attempts SET reserved_nano_usd=1 WHERE id=1",
    "UPDATE authorization_snapshots SET receipt_json='{}'",
    'DELETE FROM attempt_authorizations WHERE attempt_id=1',
])
def test_damaged_history_is_never_repaired_by_reserving(history, statement):
    meter, new = append(history)
    with sqlite3.connect(meter.state_path) as db: db.execute(statement)
    with pytest.raises(gate.TrialGateError): send(meter, new, 'asr')
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT COUNT(*) FROM attempts').fetchone()[0] == 3


def test_missing_ledger_does_not_restart_scope(history):
    meter, new = append(history)
    meter.state_path.unlink()
    with pytest.raises(gate.TrialGateError): send(meter, new)
    assert not meter.state_path.exists()


def test_unknown_or_secret_transport_fields_are_rejected(history):
    meter, new = append(history)
    ident = send(meter, new, report=False)
    with pytest.raises(gate.TrialGateError):
        gate.report_usage(ident, 'deepseek-flash', {'prompt_tokens': 1, 'completion_tokens': 1,
            'completion_tokens_details': {'reasoning_tokens': 0}}, state_path=meter.state_path,
            transport_metadata={'headers': {'Authorization': 'invented-never-a-key'}})
    with pytest.raises(gate.TrialGateError): send(meter, new, 'asr')


def test_first_append_accepts_expired_legacy_snapshot_without_edit(history, monkeypatch):
    meter, _, rows, new = history
    actual = gate.datetime
    for item in [new, *[p['billing'] for p in new['profiles'].values()],
                 *[p['billing']['charge_contract'] for p in new['profiles'].values()]]:
        item['expires_at'] = (actual.now(timezone.utc) + timedelta(hours=3)).isoformat()
    class Later(actual):
        @classmethod
        def now(cls, tz=None): return actual.now(tz) + timedelta(minutes=90)
    monkeypatch.setattr(gate, 'datetime', Later)
    meter, new = append(history)
    send(meter, new, 'asr')
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT * FROM attempts WHERE id<=3 ORDER BY id').fetchall() == rows


def test_concurrent_new_scope_never_reserves_more_than_two(history):
    meter, new = append(history)
    def attempt(_):
        try: send(meter, new); return True
        except gate.TrialGateError: return False
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert 1 <= sum(pool.map(attempt, range(12))) <= 2
    while len(gate.trial_journal(state_path=meter.state_path)) < 5: send(meter, new)
    with pytest.raises(gate.TrialGateError): send(meter, new)


def test_append_cannot_recreate_missing_state(history):
    meter, _, _, new = history
    meter.receipt_path.write_text(json.dumps(new))
    meter.state_path.unlink()
    with pytest.raises(gate.TrialGateError): gate.append_trial(meter.receipt_path, meter.state_path)
    assert not meter.state_path.exists()


def test_actual_generation_cannot_exceed_smaller_approved_wire_limit(history):
    body = json.loads(wire_for('llm')); body['max_tokens'] = 512
    wire = json.dumps(body).encode()
    history[3]['profiles']['llm']['request_sha256'] = [digest(wire)]
    meter, new = append(history)
    ident = send(meter, new, report=False, wire=wire, output_tokens=512)
    with pytest.raises(gate.TrialGateError):
        gate.report_usage(ident, 'deepseek-flash', {'prompt_tokens': 1, 'completion_tokens': 513,
            'completion_tokens_details': {'reasoning_tokens': 0}}, state_path=meter.state_path)
    with pytest.raises(gate.TrialGateError): send(meter, new, 'asr')
