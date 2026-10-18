"""Temporary synthetic ledgers and audio; no real credentials or network."""
import base64
import io
import json
import wave
from pathlib import Path

import pytest

from backend import trial_gate as gate
from tests.test_memory_trial_gate_20261010 import (
    offline_temp_only, proposed, activate, save, sha, reserve, known,
)
from tests.test_trial_budget_20261009 import receipt_fixture


def pair_fixture(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch)
    receipt = receipt_fixture(f['descriptor'], ('asr', 'llm'), 'new-memory-root')
    receipt['total_requests'] = 2
    receipt['previous_receipt_sha256'] = f['descriptor']['authorization_sha256']
    receipt['profiles']['llm']['source_sha256'] = [f['receipt']['profiles']['llm']['source_sha256'][0]]
    receipt['profiles']['llm']['request_sha256'] = [f['receipt']['profiles']['llm']['request_sha256'][0]]
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000)
        audio.writeframes(b'\x00\x00' * 160)
    raw = stream.getvalue()
    audio_path = tmp_path / 'synthetic.wav'; audio_path.write_bytes(raw)
    body = {'contents': [{'role': 'user', 'parts': [{'inlineData': {
        'mimeType': 'audio/wav', 'data': base64.b64encode(raw).decode()}}]}],
        'generationConfig': {'maxOutputTokens': 1024,
            'thinkingConfig': {'thinkingBudget': 0, 'includeThoughts': False}}}
    wire = json.dumps(body).encode()
    wire_path = tmp_path / 'asr-wire.json'; wire_path.write_bytes(wire)
    profile = receipt['profiles']['asr']
    profile['source_sha256'] = [sha(raw)]; profile['request_sha256'] = [sha(wire)]
    f['receipt'] = receipt
    f['manifest']['receipt_sha256'] = save(f['receipt_path'], receipt)
    f['manifest']['request_pairs'] = [dict(audio_path=str(audio_path), source_sha256=sha(raw),
        wire_path=str(wire_path), request_sha256=sha(wire)), f['manifest']['request_pairs'][0]]
    f['manifest_sha256'] = save(f['manifest_path'], f['manifest'])
    f['asr_wire'] = wire
    return f


def reserve_asr(f):
    p = f['receipt']['profiles']['asr']
    return gate.TrialGate(f['receipt_path'], f['state_path']).reserve(kind='asr',
        provider=p['provider'], model=p['model'], url=p['url'], wire=f['asr_wire'],
        source_sha256=p['source_sha256'][0], output_tokens=1024, thinking_tokens=0)


def test_asr_then_llm_uses_two_slots_and_preserves_original_unknown_hold(tmp_path, monkeypatch):
    f = pair_fixture(tmp_path, monkeypatch); activate(f)
    first = reserve_asr(f)
    gate.report_usage(first, 'gemini-2.5-flash-lite', {'prompt_tokens': 12, 'completion_tokens': 3,
        'completion_tokens_details': {'reasoning_tokens': 0}}, state_path=f['state_path'],
        transport_metadata={'response_sha256': sha(b'asr-response'), 'response_bytes': 42, 'protocol': 'gemini'})
    gate.confirm_trial_review(first, 'invented-fixture-review-only', state_path=f['state_path'])
    assert reserve(f) == 2
    known(f, 2)
    from backend import trial_budget as budget
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']
    assert budget.budget_snapshot(f['descriptor'])['reserved_estimate_usd'] == '0.1082816'
    with pytest.raises(gate.TrialGateError): reserve_asr(f)
    with pytest.raises(gate.TrialGateError): reserve(f)


@pytest.mark.parametrize('change', ['audio', 'wire', 'swap', 'reverse', 'extra'])
def test_asr_pair_rejects_changed_audio_wire_sequence_or_extra_steps(tmp_path, monkeypatch, change):
    f = pair_fixture(tmp_path, monkeypatch)
    if change == 'audio':
        from pathlib import Path
        Path(f['manifest']['request_pairs'][0]['audio_path']).write_bytes(b'changed')
    elif change == 'wire':
        from pathlib import Path
        Path(f['manifest']['request_pairs'][0]['wire_path']).write_bytes(b'{}')
    elif change == 'swap': f['manifest']['request_pairs'].reverse()
    elif change == 'reverse': f['receipt']['request_sequence'].reverse()
    else: f['receipt']['request_sequence'].append('llm'); f['receipt']['total_requests'] = 3
    f['manifest']['receipt_sha256'] = save(f['receipt_path'], f['receipt'])
    f['manifest_sha256'] = save(f['manifest_path'], f['manifest'])
    with pytest.raises(gate.TrialGateError): activate(f)


def test_failed_asr_closes_pair_and_keeps_unknown_full_reservation(tmp_path, monkeypatch):
    f = pair_fixture(tmp_path, monkeypatch); activate(f); reserve_asr(f)
    gate.stop_trial(1, 'transport_failed', state_path=f['state_path'])
    with pytest.raises(gate.TrialGateError): reserve(f)
    from backend import trial_budget as budget
    status = budget.budget_snapshot(f['descriptor'])
    assert status['reserved_estimate_usd'] == '0.098624'
    assert status['batches'][-1]['status'] == 'closed'


@pytest.mark.parametrize('first_asr', [False, True])
def test_wrong_order_or_unreviewed_followup_is_denied_and_seals_only_new_scope(tmp_path, monkeypatch, first_asr):
    f = pair_fixture(tmp_path, monkeypatch); activate(f)
    if first_asr: reserve_asr(f)
    with pytest.raises(gate.TrialGateError): reserve(f)
    with pytest.raises(gate.TrialGateError): reserve_asr(f)
    from backend import trial_budget as budget
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']


def test_asr_only_finite_step_closes_before_actual_derived_llm_is_separately_frozen(tmp_path, monkeypatch):
    f = pair_fixture(tmp_path, monkeypatch)
    receipt = f['receipt']; receipt['request_sequence'] = ['asr']; receipt['total_requests'] = 1
    receipt['planned_text_requests'] = 0; receipt['profiles'].pop('llm')
    receipt['spend_authorization']['estimated_new_usd'] = '0.001024'
    f['manifest']['request_pairs'] = f['manifest']['request_pairs'][:1]
    f['manifest']['receipt_sha256'] = save(f['receipt_path'], receipt)
    f['manifest_sha256'] = save(f['manifest_path'], f['manifest'])
    result = activate(f); assert result['remaining_requests'] == 1
    assert reserve_asr(f) == 1
    gate.stop_trial(1, 'owner_stop', state_path=f['state_path'])
    with pytest.raises(gate.TrialGateError): reserve_asr(f)
    from backend import trial_budget as budget
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']
    assert budget.budget_snapshot(f['descriptor'])['reserved_estimate_usd'] == '0.098624'


def test_closed_native_journal_survives_code_update_but_never_resumes(tmp_path, monkeypatch):
    from backend import trial_budget as budget
    f = pair_fixture(tmp_path, monkeypatch); activate(f)
    first = reserve_asr(f)
    gate.report_usage(first, 'gemini-2.5-flash-lite', {'prompt_tokens': 12, 'completion_tokens': 3,
        'completion_tokens_details': {'reasoning_tokens': 0}}, state_path=f['state_path'],
        transport_metadata={'response_sha256': sha(b'fictional-asr'), 'response_bytes': 42, 'protocol': 'gemini'})
    gate.confirm_trial_review(first, 'fictional-review', state_path=f['state_path'])
    known(f, reserve(f))
    gate.close_trial_scope(f['receipt_path'], f['state_path'], 'owner_stop')
    before = budget.cumulative_row_seal(f['descriptor'])
    f['source'].write_text('updated synthetic code\n')
    with pytest.raises(gate.TrialGateError): gate.trial_journal(state_path=f['state_path'])
    journal = gate.trial_journal(state_path=f['state_path'], historical_closed=True)
    assert [row['kind'] for row in journal] == ['asr', 'llm']
    assert all(row['usage']['verified'] is True for row in journal)
    with pytest.raises(gate.TrialGateError): reserve_asr(f)
    assert budget.cumulative_row_seal(f['descriptor']) == before


def test_historical_journal_reads_closed_original_after_exact_device_transition(tmp_path, monkeypatch):
    import sqlite3
    from backend import trial_budget as budget
    f = pair_fixture(tmp_path, monkeypatch); activate(f)
    first = reserve_asr(f)
    gate.report_usage(first, 'gemini-2.5-flash-lite', {'prompt_tokens': 12, 'completion_tokens': 3,
        'completion_tokens_details': {'reasoning_tokens': 0}}, state_path=f['state_path'],
        transport_metadata={'response_sha256': sha(b'approved-transition-fixture'),
                            'response_bytes': 42, 'protocol': 'gemini'})
    gate.close_trial_scope(f['receipt_path'], f['state_path'], 'owner_stop')
    binding = budget.native_root_binding(f['descriptor'], receipt_id=f['receipt']['receipt_id'])
    old_device = binding['state_device'] + 1
    current = f['state_path'].stat()
    budget_state = Path(f['descriptor']['state_path']).stat()
    assert budget_state.st_ino != current.st_ino
    changed = dict(binding, state_device=old_device)
    with sqlite3.connect(f['descriptor']['state_path']) as db:
        db.execute('UPDATE native_roots SET record_json=? WHERE receipt_id=?',
                   (budget._encode(changed), f['receipt']['receipt_id']))
    with sqlite3.connect(f['state_path']) as db:
        db.execute('UPDATE standalone_root SET record_json=?', (budget._encode(changed),))
    transition = {'old_device': old_device, 'new_device': current.st_dev, 'inode': budget_state.st_ino,
        'native_receipt_ids': (f['receipt']['receipt_id'],)}
    def unapproved(_descriptor):
        raise budget.TrialBudgetError()
    monkeypatch.setattr(budget, 'identity_recovery_transition', unapproved)
    with pytest.raises((gate.TrialGateError, budget.TrialBudgetError)):
        gate.trial_journal(state_path=f['state_path'], historical_closed=True)
    monkeypatch.setattr(budget, 'identity_recovery_transition', lambda _descriptor: transition)

    journal = gate.trial_journal(state_path=f['state_path'], historical_closed=True)
    assert len(journal) == 1 and journal[0]['kind'] == 'asr'
    assert journal[0]['usage']['verified'] is True
    # Historical mode is the only reader allowed to consume the alias.
    with sqlite3.connect(f['state_path']) as db:
        with pytest.raises((gate.TrialGateError, budget.TrialBudgetError)):
            gate._standalone_context(db, strict=True, historical_closed=True)

    # An active/forged old scope cannot borrow the closed-history exception.
    with sqlite3.connect(f['descriptor']['state_path']) as db:
        db.execute("UPDATE batches SET status='active',closure_reason=NULL WHERE receipt_id=?",
                   (f['receipt']['receipt_id'],))
    with pytest.raises((gate.TrialGateError, budget.TrialBudgetError)):
        gate.trial_journal(state_path=f['state_path'], historical_closed=True)
    with sqlite3.connect(f['descriptor']['state_path']) as db:
        db.execute("UPDATE batches SET status='closed',closure_reason='owner_stop' WHERE receipt_id=?",
                   (f['receipt']['receipt_id'],))

    # A different inode cannot inherit the approved device-only transition.
    changed_inode = dict(changed, state_inode=current.st_ino + 1)
    with sqlite3.connect(f['descriptor']['state_path']) as db:
        db.execute('UPDATE native_roots SET record_json=? WHERE receipt_id=?',
                   (budget._encode(changed_inode), f['receipt']['receipt_id']))
    with sqlite3.connect(f['state_path']) as db:
        db.execute('UPDATE standalone_root SET record_json=?', (budget._encode(changed_inode),))
    with pytest.raises((gate.TrialGateError, budget.TrialBudgetError)):
        gate.trial_journal(state_path=f['state_path'], historical_closed=True)


def test_historical_journal_refuses_active_native_scope_after_code_update(tmp_path, monkeypatch):
    from backend import trial_budget as budget
    f = pair_fixture(tmp_path, monkeypatch); activate(f)
    before = budget.cumulative_row_seal(f['descriptor'])
    f['source'].write_text('updated synthetic code\n')
    with pytest.raises(gate.TrialGateError):
        gate.trial_journal(state_path=f['state_path'], historical_closed=True)
    assert budget.cumulative_row_seal(f['descriptor']) == before


def test_external_historical_pair_allows_only_the_approved_device_field_alias(tmp_path, monkeypatch):
    from backend import trial_budget as budget
    f = proposed(tmp_path, monkeypatch, external_history=True)
    actual = f['old_native'].stat()
    old_device = actual.st_dev + 1
    f['audit']['current_native']['ledger_stat']['device'] = old_device
    f['manifest']['historical_reference']['audit_sha256'] = save(f['audit_path'], f['audit'])
    f['manifest_sha256'] = save(f['manifest_path'], f['manifest'])
    monkeypatch.setattr(budget, 'identity_recovery_transition', lambda _descriptor: {
        'old_device': old_device, 'new_device': actual.st_dev,
        'native_receipt_ids': ('sealed-fixture-history',)})
    activate(f)

    # The one alias cannot excuse an inode, size, or mtime change.
    f = proposed(tmp_path / 'tamper', monkeypatch, external_history=True)
    actual = f['old_native'].stat(); old_device = actual.st_dev + 1
    f['audit']['current_native']['ledger_stat'].update(device=old_device, bytes=actual.st_size + 1)
    f['manifest']['historical_reference']['audit_sha256'] = save(f['audit_path'], f['audit'])
    f['manifest_sha256'] = save(f['manifest_path'], f['manifest'])
    monkeypatch.setattr(budget, 'identity_recovery_transition', lambda _descriptor: {
        'old_device': old_device, 'new_device': actual.st_dev,
        'native_receipt_ids': ('sealed-fixture-history',)})
    with pytest.raises(gate.TrialGateError):
        activate(f)


@pytest.mark.parametrize('change', ['manifest', 'usage'])
def test_historical_journal_still_rejects_closed_evidence_tampering(tmp_path, monkeypatch, change):
    import sqlite3
    f = pair_fixture(tmp_path, monkeypatch); activate(f)
    first = reserve_asr(f)
    gate.report_usage(first, 'gemini-2.5-flash-lite', {'prompt_tokens': 12, 'completion_tokens': 3,
        'completion_tokens_details': {'reasoning_tokens': 0}}, state_path=f['state_path'],
        transport_metadata={'response_sha256': sha(b'fictional-asr'), 'response_bytes': 42, 'protocol': 'gemini'})
    gate.close_trial_scope(f['receipt_path'], f['state_path'], 'owner_stop')
    f['source'].write_text('updated synthetic code\n')
    if change == 'manifest':
        f['manifest_path'].write_text('{}')
    else:
        with sqlite3.connect(f['state_path']) as db:
            raw = json.loads(db.execute('SELECT usage_json FROM attempts WHERE id=1').fetchone()[0])
            raw['verified'] = False
            db.execute('UPDATE attempts SET usage_json=? WHERE id=1', (json.dumps(raw),))
    with pytest.raises(gate.TrialGateError):
        gate.trial_journal(state_path=f['state_path'], historical_closed=True)
