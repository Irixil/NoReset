"""Synthetic temporary authority only. No credentials, runtime or network."""
import copy
import contextvars
import base64
import hashlib
import importlib.util
import json
import os
import shutil
import socket
import sqlite3
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend import model_client
from backend import recognition
from backend import trial_budget as budget
from backend import trial_gate as gate
from backend.conversation import SYSTEM_PROMPT, conversation_turn
from scripts.run_text_trial import PreviewProvider, PreviewReady
from tests.test_trial_budget_20261009 import authorization_fixture, initialized, receipt_fixture, reserve as old_reserve, observe


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


def proposed(tmp_path, monkeypatch, *, external_history=False):
    if external_history:
        current_root = tmp_path / 'current-checkout'
        native_root = tmp_path / 'prior-worktree' / 'runtime' / 'synthetic-trial'
        current_root.mkdir(parents=True)
        (native_root / 'cumulative-20261009-followup-usd1').mkdir(parents=True)
        (native_root / 'cumulative-budget-claims').mkdir()
        monkeypatch.setattr(gate, 'ROOT', current_root)
        monkeypatch.setattr(gate, 'CONTINUATION_CLAIM_ROOT', current_root / 'runtime')
        monkeypatch.setattr(budget, 'CLAIM_ROOT', native_root / 'cumulative-budget-claims')
        authority_dir = native_root / 'cumulative-20261009-followup-usd1'
        descriptor = budget.initialize_authorization(
            authorization_fixture(),
            authorization_path=(authority_dir / 'authorization.json').resolve(),
            state_path=(authority_dir / 'budget.sqlite3').resolve())
        work_root = current_root
    else:
        current_root = native_root = work_root = tmp_path
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
    old_native = native_root / ('ledger.sqlite3' if external_history else 'old-native.sqlite3')
    old_native.write_bytes(b'historical native contents must never be read')
    old_receipt = native_root / ('authorization.json' if external_history else 'old-receipt.json')
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
    audit_path = work_root / 'historical-reference.json'
    audit_sha = save(audit_path, audit)
    source = work_root / 'candidate.py'
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
        payload_path, wire_path = work_root / f'payload-{index}.json', work_root / f'wire-{index}.json'
        payload_sha = save(payload_path, payload)
        wire_path.write_bytes(wire)
        source_sha, wire_sha = sha(serialized.encode()), sha(wire)
        receipt['profiles']['llm']['source_sha256'][index] = source_sha
        receipt['profiles']['llm']['request_sha256'][index] = wire_sha
        pairs.append(dict(model_payload_path=str(payload_path), model_payload_sha256=payload_sha,
                          source_sha256=source_sha, wire_path=str(wire_path), request_sha256=wire_sha))
        payloads.append(payload); wires.append(wire)
    receipt_path, state_path, manifest_path = work_root / 'new-receipt.json', work_root / 'runtime/memory.sqlite3', work_root / 'manifest.json'
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
                manifest=manifest, source=source, payloads=payloads, wires=wires, old_native=old_native,
                old_receipt=old_receipt, native_root=native_root, current_root=current_root,
                audit=audit, audit_path=audit_path)


def proposed_long_asr(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch)
    fixture_path = Path(__file__).resolve().parents[1] / '.dz/evidence/goal-acceptance-2026-10-11/natural-audio-fixtures/audio/long.wav'
    if not fixture_path.is_file():
        pytest.skip('Private owner audio is not included in public source delivery')
    raw = fixture_path.read_bytes()
    source_sha = sha(raw)
    assert source_sha == 'f6b201ff06872283ab1c86bb1659599dde363cba284b7e9a39eb149521eb4875'
    audio_path, wire_path = tmp_path / 'natural-long.wav', tmp_path / 'natural-long-wire.json'
    audio_path.write_bytes(raw)
    config = SimpleNamespace(name='aihubmix', url=budget.URLS['asr'],
        model=budget.SERVICES['asr']['model'], api_key='invented-offline-only-key')
    request = recognition._OpenAICompatibleProvider(config)._audio_request(raw, 'audio/wav', audio_path.name)
    wire = request.data
    assert request.full_url == budget.URLS['asr'] and len(wire) <= 3 * 1024 * 1024
    wire_path.write_bytes(wire)

    receipt = receipt_fixture(f['descriptor'], ('asr',), 'new-natural-long-root')
    receipt['total_requests'] = 1
    receipt['previous_receipt_sha256'] = f['descriptor']['authorization_sha256']
    profile = receipt['profiles']['asr']
    profile['case_profile'] = 'natural-long-45s-v1'
    profile['source_sha256'] = [source_sha]
    profile['request_sha256'] = [sha(wire)]
    f['receipt'] = receipt
    f['receipt_path'], f['state_path'] = tmp_path / 'new-receipt.json', tmp_path / 'runtime/natural-long.sqlite3'
    receipt_sha = save(f['receipt_path'], receipt)
    f['manifest']['approval_ref'] = receipt['approval_ref']
    f['manifest']['purpose'] = 'long_term_health_memory'
    f['manifest']['receipt_path'] = str(f['receipt_path'])
    f['manifest']['receipt_sha256'] = receipt_sha
    f['manifest']['state_path'] = str(f['state_path'])
    f['manifest']['request_pairs'] = [dict(audio_path=str(audio_path), source_sha256=source_sha,
        wire_path=str(wire_path), request_sha256=sha(wire))]
    f['manifest_sha256'] = save(f['manifest_path'], f['manifest'])
    f.update(audio_path=audio_path, wire_path=wire_path, audio_sha256=source_sha,
        wire=wire, wire_sha256=sha(wire), wires=[wire])
    return f


def activate(fixture):
    return gate.initialize_standalone_trial(**{key: fixture[key] for key in
        ('receipt_path', 'state_path', 'manifest_path', 'manifest_sha256')})


def reseal_long_receipt(fixture):
    fixture['manifest']['receipt_sha256'] = save(fixture['receipt_path'], fixture['receipt'])
    fixture['manifest_sha256'] = save(fixture['manifest_path'], fixture['manifest'])


def assert_long_unregistered(fixture):
    assert budget.native_root_binding(fixture['descriptor'], receipt_id='new-natural-long-root',
        required=False, include_scope=True) is None
    assert budget.cumulative_row_seal(fixture['descriptor'], baseline=fixture['baseline']) == fixture['baseline']


def test_standalone_manifest_accepts_only_exactly_hashed_empty_candidate_source(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch)
    f['source'].write_bytes(b'')
    f['manifest']['candidate_source_sha256']['candidate.py'] = sha(b'')
    f['manifest_sha256'] = save(f['manifest_path'], f['manifest'])

    activate(f)
    receipt_sha = sha(f['receipt_path'].read_bytes())
    f['source'].write_bytes(b'now nonempty')
    with pytest.raises(gate.TrialGateError):
        gate._standalone_manifest(str(f['manifest_path']), f['manifest_sha256'], f['receipt'], receipt_sha)


def test_standalone_manifest_rejects_wrong_hash_for_empty_candidate_source(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch)
    f['source'].write_bytes(b'')
    f['manifest']['candidate_source_sha256']['candidate.py'] = 'f' * 64
    f['manifest_sha256'] = save(f['manifest_path'], f['manifest'])

    with pytest.raises(gate.TrialGateError):
        activate(f)
    assert not f['state_path'].exists()


def test_natural_long_profile_validates_full_original_wire_and_reserves_one_cumulative_asr(tmp_path, monkeypatch):
    f = proposed_long_asr(tmp_path, monkeypatch)
    assert len(f['audio_path'].read_bytes()) == 1798828
    assert f['audio_sha256'] == 'f6b201ff06872283ab1c86bb1659599dde363cba284b7e9a39eb149521eb4875'
    assert len(f['wire']) <= 3 * 1024 * 1024
    assert f['receipt']['request_sequence'] == ['asr']
    assert f['receipt']['profiles']['asr']['case_profile'] == 'natural-long-45s-v1'

    result = activate(f)
    assert result['remaining_requests'] == 1
    assert owner_long_status(f)['allocations'] == []
    with pytest.raises(gate.TrialGateError):
        gate.amend_trial(f['receipt_path'], f['state_path'])
    attempt_id = reserve_long_asr(f)
    assert attempt_id == 1
    allocations = owner_long_status(f)['allocations']
    assert len(allocations) == 1
    assert allocations[0][1:4] == ('asr', f['audio_sha256'], f['wire_sha256'])
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']
    with sqlite3.connect(f['descriptor']['state_path']) as db:
        assert db.execute('SELECT observation_json FROM allocations WHERE id=2').fetchone() == (None,)

    with pytest.raises(gate.TrialGateError):
        reserve_long_asr(f)
    assert len(owner_long_status(f)['allocations']) == 1
    assert owner_long_status(f)['status'] == 'closed'


@pytest.mark.parametrize('change', ['unknown_profile', 'second_asr', 'output_cap', 'ordinary_init'])
def test_natural_long_profile_rejects_unapproved_scope_or_ordinary_initialization(tmp_path, monkeypatch, change):
    f = proposed_long_asr(tmp_path, monkeypatch)
    if change == 'unknown_profile':
        f['receipt']['profiles']['asr']['case_profile'] = 'anything-else'
        reseal_long_receipt(f)
    elif change == 'second_asr':
        f['receipt']['request_sequence'] = ['asr', 'asr']
        f['receipt']['total_requests'] = 2
        reseal_long_receipt(f)
    elif change == 'output_cap':
        f['receipt']['profiles']['asr']['max_output_tokens'] = 512
        reseal_long_receipt(f)
    else:
        with pytest.raises(gate.TrialGateError):
            gate.initialize_trial(f['receipt_path'], f['state_path'])
        assert not f['state_path'].exists()
        assert_long_unregistered(f)
        return

    with pytest.raises(gate.TrialGateError):
        activate(f)
    assert not f['state_path'].exists()
    assert_long_unregistered(f)


@pytest.mark.parametrize('scope', ['asr_plus_llm', 'llm_profile'])
def test_natural_long_audio_profile_never_authorizes_llm(scope, tmp_path, monkeypatch):
    f = proposed_long_asr(tmp_path, monkeypatch)
    candidate = copy.deepcopy(f['receipt'])
    if scope == 'asr_plus_llm':
        llm = receipt_fixture(f['descriptor'], ('llm',), 'long-audio-llm-denial')['profiles']['llm']
        candidate['profiles']['llm'] = llm
        candidate['request_sequence'] = ['asr', 'llm']
        candidate['total_requests'] = 2
        candidate['planned_text_requests'] = 1
    else:
        candidate = receipt_fixture(f['descriptor'], ('llm',), 'long-profile-on-llm')
        candidate['profiles']['llm']['case_profile'] = 'natural-long-45s-v1'

    with pytest.raises(gate.TrialGateError):
        gate._validate_v3(candidate)


def test_natural_long_profile_wire_over_three_mib_fails_before_cumulative_registration(tmp_path, monkeypatch):
    f = proposed_long_asr(tmp_path, monkeypatch)
    body = json.loads(f['wire'])
    body['contents'][0]['parts'].append({'text': 'x' * (3 * 1024 * 1024)})
    wire = json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode()
    assert len(wire) > 3 * 1024 * 1024
    f['wire_path'].write_bytes(wire)
    f['receipt']['profiles']['asr']['request_sha256'] = [sha(wire)]
    f['manifest']['request_pairs'][0]['request_sha256'] = sha(wire)
    reseal_long_receipt(f)

    with pytest.raises(gate.TrialGateError):
        activate(f)
    assert not f['state_path'].exists()
    assert_long_unregistered(f)


def test_natural_long_profile_cannot_replay_old_cumulative_tuple(tmp_path, monkeypatch):
    f = proposed_long_asr(tmp_path, monkeypatch)
    f['audit']['current_native']['full_row_projections']['attempts'].append(dict(
        kind='asr', source_sha256=f['audio_sha256'], request_sha256=f['wire_sha256']))
    reseal_historical_fixture(f)
    with pytest.raises(gate.TrialGateError):
        activate(f)
    assert not f['state_path'].exists()
    assert_long_unregistered(f)


@pytest.mark.parametrize('target', ['audio', 'wire'])
def test_natural_long_profile_rejects_changed_source_or_wire_before_budget_registration(tmp_path, monkeypatch, target):
    f = proposed_long_asr(tmp_path, monkeypatch)
    path = f['audio_path'] if target == 'audio' else f['wire_path']
    path.write_bytes(path.read_bytes() + b'changed')
    with pytest.raises(gate.TrialGateError):
        activate(f)
    assert not f['state_path'].exists()
    assert_long_unregistered(f)


def test_root_file_default_and_empty_receipt_still_reject(tmp_path, monkeypatch):
    empty = tmp_path / 'empty.txt'
    empty.write_bytes(b'')
    with pytest.raises(gate.TrialGateError):
        gate._root_file(str(empty))
    with pytest.raises(gate.TrialGateError):
        gate._receipt(empty)


def reseal_historical_fixture(fixture):
    fixture['manifest']['historical_reference']['audit_sha256'] = save(fixture['audit_path'], fixture['audit'])
    fixture['manifest_sha256'] = save(fixture['manifest_path'], fixture['manifest'])


def test_external_historical_pair_uses_verified_neighbor_and_preserves_unknown_allocation(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch, external_history=True)
    assert activate(f)['native_history_revalidated'] is False
    assert f['old_native'] == f['native_root'] / 'ledger.sqlite3'
    assert f['old_receipt'] == f['native_root'] / 'authorization.json'
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']
    with sqlite3.connect(f['descriptor']['state_path']) as db:
        assert db.execute('SELECT observation_json FROM allocations WHERE id=2').fetchone() == (None,)
    assert reserve(f) == 1
    gate.stop_trial(1, 'owner_stop', state_path=f['state_path'])
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']
    scope = budget.native_root_binding(f['descriptor'], receipt_id=f['receipt']['receipt_id'], include_scope=True)
    assert scope['status'] == 'closed' and scope['allocations'][0][5] is None


@pytest.mark.parametrize('external_history', [False, True])
@pytest.mark.parametrize('suffix', ['-wal', '-shm', '-journal'])
def test_historical_native_sidecars_are_rejected_before_registration(tmp_path, monkeypatch, external_history, suffix):
    f = proposed(tmp_path, monkeypatch, external_history=external_history)
    Path(str(f['old_native']) + suffix).write_bytes(b'synthetic sidecar')
    with pytest.raises(gate.TrialGateError):
        activate(f)
    with sqlite3.connect(f['descriptor']['state_path']) as db:
        assert db.execute('SELECT COUNT(*) FROM batches WHERE receipt_id=?',
                          (f['receipt']['receipt_id'],)).fetchone() == (0,)


def test_external_authority_denies_without_trusted_fixed_claim_root(tmp_path, monkeypatch):
    f = proposed(tmp_path, monkeypatch, external_history=True)
    monkeypatch.setattr(budget, 'CLAIM_ROOT', tmp_path / 'untrusted-claims')
    with pytest.raises(gate.TrialGateError):
        activate(f)
    with sqlite3.connect(f['descriptor']['state_path']) as db:
        assert db.execute('SELECT COUNT(*) FROM batches WHERE receipt_id=?',
                           (f['receipt']['receipt_id'],)).fetchone() == (0,)


@pytest.mark.parametrize('attack', ['arbitrary_external_path', 'copied_authorization_identity',
    'ledger_replaced', 'receipt_replaced', 'unsealed_history', 'historical_request_replay'])
def test_external_historical_reference_rejects_substitution_and_replay(tmp_path, monkeypatch, attack):
    f = proposed(tmp_path, monkeypatch, external_history=True)
    if attack == 'arbitrary_external_path':
        other = f['native_root'].parent / 'unapproved-ledger.sqlite3'
        other.write_bytes(b'unapproved external ledger')
        f['audit']['current_native']['ledger_path'] = str(other)
        stat_result = other.stat()
        f['audit']['current_native']['ledger_stat'] = {'bytes': stat_result.st_size,
            'mtime_ns': stat_result.st_mtime_ns, 'inode': stat_result.st_ino, 'device': stat_result.st_dev}
        reseal_historical_fixture(f)
    elif attack == 'copied_authorization_identity':
        copied_root = tmp_path / 'copied-history' / 'runtime' / 'synthetic-trial'
        copied_dir = copied_root / 'cumulative-20261009-followup-usd1'
        (copied_dir).mkdir(parents=True)
        (copied_root / 'cumulative-budget-claims').mkdir()
        shutil.copyfile(f['descriptor']['authorization_path'], copied_dir / 'authorization.json')
        shutil.copyfile(f['descriptor']['state_path'], copied_dir / 'budget.sqlite3')
        copied_descriptor = {'authorization_path': str(copied_dir / 'authorization.json'),
            'state_path': str(copied_dir / 'budget.sqlite3'),
            'authorization_sha256': f['descriptor']['authorization_sha256']}
        f['receipt']['cumulative_budget'] = copied_descriptor
        f['manifest']['cumulative_budget'] = copied_descriptor
        f['audit']['cumulative_budget']['same_original_descriptor'] = copied_descriptor
        f['manifest']['receipt_sha256'] = save(f['receipt_path'], f['receipt'])
        reseal_historical_fixture(f)
    elif attack == 'ledger_replaced':
        f['old_native'].write_bytes(b'replaced historical ledger bytes')
    elif attack == 'receipt_replaced':
        f['old_receipt'].write_bytes(b'{"historical":"replacement"}')
    elif attack == 'unsealed_history':
        f['manifest']['budget_baseline']['rows_sha256'] = 'f' * 64
        f['audit']['cumulative_budget']['planning_hold_usd'] = '0.0976'
        reseal_historical_fixture(f)
    else:
        pair = f['manifest']['request_pairs'][0]
        f['audit']['current_native']['full_row_projections']['attempts'][0] = {
            'kind': 'llm', 'source_sha256': pair['source_sha256'],
            'request_sha256': pair['request_sha256']}
        reseal_historical_fixture(f)

    with pytest.raises(gate.TrialGateError):
        activate(f)
    with sqlite3.connect(f['descriptor']['state_path']) as db:
        assert db.execute('SELECT COUNT(*) FROM batches WHERE receipt_id=?',
                           (f['receipt']['receipt_id'],)).fetchone() == (0,)


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


def reserve_long_asr(fixture, **changes):
    profile = fixture['receipt']['profiles']['asr']
    args = dict(kind='asr', provider=profile['provider'], model=profile['model'], url=profile['url'],
        wire=fixture['wire'], source_sha256=profile['source_sha256'][0], output_tokens=1024, thinking_tokens=0)
    args.update(changes)
    return gate.TrialGate(fixture['receipt_path'], fixture['state_path']).reserve(**args)


def known(fixture, ident):
    return gate.report_usage(ident, 'deepseek-flash', {'prompt_tokens': 12, 'completion_tokens': 3,
            'completion_tokens_details': {'reasoning_tokens': 0}}, state_path=fixture['state_path'],
            transport_metadata={'response_sha256': sha(f'response-{ident}'.encode()), 'response_bytes': 42, 'protocol': 'openai'})


def owner_status(fixture):
    return budget.native_root_binding(fixture['descriptor'], receipt_id='new-memory-root', include_scope=True)


def owner_long_status(fixture):
    return budget.native_root_binding(fixture['descriptor'], receipt_id='new-natural-long-root', include_scope=True)


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
