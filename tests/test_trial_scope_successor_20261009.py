"""New explicit ordered scopes, closed history, TEMP SQLite only; no HTTP."""
import copy
import json
import socket
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from backend import trial_gate as gate
from backend import trial_budget
from tests.test_trial_append_20261009 import history
from tests.test_trial_continuation_20261009 import closed, continue_pair
from tests.test_trial_informed_risk_20261009 import audio, review, send as original_send, wire
from tests.test_trial_gate import digest, receipt_document, reserve as legacy_reserve


@pytest.fixture(autouse=True)
def no_external_calls(monkeypatch, tmp_path):
    def forbidden(*args, **kwargs):
        raise AssertionError('scope tests must never use external transport')
    monkeypatch.setattr(socket, 'create_connection', forbidden)
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    monkeypatch.setattr(socket.socket, 'connect_ex', forbidden)
    monkeypatch.setattr(trial_budget, 'CLAIM_ROOT', (tmp_path/'budget-fixture-exclusive-claims').resolve())


def planned_wire(kind, ordinal=0):
    raw = wire(kind, audio(2) if ordinal and kind == 'asr' else None)
    if ordinal and kind == 'llm':
        value = json.loads(raw); value['messages'][0]['content'] = '原创虚构：刚才的时间改为三天。'
        raw = json.dumps(value, ensure_ascii=False).encode()
    return raw


def send(meter, document, kind, report=True, **changes):
    if document['schema_version'] == 'noreset-synthetic-trial-informed-risk-v2':
        with sqlite3.connect(meter.state_path) as db:
            ordinal = sum(k == kind for _,k in gate._risk_scope_attempts(db, document))
        profile = document['profiles'].get(kind, {})
        sources = profile.get('source_sha256', [])
        changes.setdefault('wire', planned_wire(kind, ordinal))
        changes.setdefault('source_sha256', sources[ordinal] if ordinal < len(sources) else '0'*64)
    ident = original_send(meter, document, kind, report=False, **changes)
    if report:
        usage={'prompt_tokens':1,'completion_tokens':1,'completion_tokens_details':{'reasoning_tokens':0}}
        gate.report_usage(ident,document['profiles'][kind]['model'],usage,state_path=meter.state_path,
            transport_metadata={'response_sha256':digest(json.dumps(usage).encode()),'response_bytes':len(json.dumps(usage)),
                                'protocol':'gemini' if kind=='asr' else 'openai'})
    return ident


@pytest.fixture
def five(closed, tmp_path):
    meter, _ = continue_pair(closed)
    ident = send(meter, closed['new_document'], 'asr')
    assert ident == 5
    gate.stop_trial(ident, 'owner_stop', state_path=meter.state_path)
    authorization={'schema_version':'noreset-cumulative-trial-budget-v1','authorization_id':'invented-USD1-owner-approval',
        'status':'approved','authorization_source':'explicit_owner_approval','approval_ref':'invented-human-USD1-nonhard',
        'effective_at':datetime.now(timezone.utc).isoformat(),'project':'NoReset','currency':'USD',
        'total_estimated_usd':'1','synthetic_only':True,'hard_currency_cap':False,
        'billing_limitations_accepted':True,'unknown_final_cost_accepted':True,'services':copy.deepcopy(trial_budget.SERVICES)}
    descriptor=trial_budget.initialize_authorization(authorization,authorization_path=(tmp_path/'budget-authorization.json').resolve(),
        state_path=(tmp_path/'budget.sqlite3').resolve())
    return dict(meter=meter, document=closed['new_document'], closed=closed, tmp=tmp_path,descriptor=descriptor)


def proposal(case, sequence=('asr', 'llm', 'llm')):
    meter = case['meter']
    with sqlite3.connect(meter.state_path) as db:
        rows = db.execute('SELECT * FROM attempts ORDER BY id').fetchall()
        head, _, _, reason = db.execute('SELECT * FROM metadata').fetchone()
    document = copy.deepcopy(case['document'])
    now=datetime.now(timezone.utc)
    document.update(schema_version='noreset-synthetic-trial-informed-risk-v2',
        receipt_id='invented-new-ordered-scope-' + str(len(rows)),
        approval_ref='invented-explicit-new-scope-approval-' + str(len(rows)),
        previous_receipt_sha256=head, total_requests=len(rows)+len(sequence),
        planned_text_requests=sequence.count('llm'), request_sequence=list(sequence),approved_at=now.isoformat(),
        expires_at=(now+timedelta(minutes=40)).isoformat(),
        cumulative_budget=case.get('descriptor',document.get('cumulative_budget')))
    document['profiles'] = {k:p for k,p in document['profiles'].items() if k in sequence}
    for kind, profile in document['profiles'].items():
        profile['requests'] = sequence.count(kind)
        profile['request_sha256'] = [digest(planned_wire(kind, n)) for n in range(profile['requests'])]
        profile['source_sha256'] = [profile['source_sha256'][0]] + [digest(audio(2) if kind == 'asr' else b'original synthetic correction v2') for _ in range(1, profile['requests'])]
    document['spend_authorization']['estimated_new_usd'] = format(sum(
        gate.Decimal(p['billing']['estimated_usd']) * p['requests'] for p in document['profiles'].values()), 'f')
    stem = case['tmp'] / ('successor-' + str(len(rows)))
    receipt, state = stem.with_suffix('.json'), stem.with_suffix('.sqlite3')
    receipt.write_text(json.dumps(document))
    evidence = {'schema_version': 'noreset-closed-scope-evidence-v1', 'status': 'permanently_closed',
        'last_attempt_id': rows[-1][0], 'freeze_reason': reason,
        'last_request_sha256': rows[-1][2], 'last_source_sha256': rows[-1][3],
        'cumulative_attempt_rows': len(rows), 'historical_reserved_usd': '0.9510912',
        'supplier_final_charge_known': False}
    evidence_path = stem.with_name(stem.name+'-evidence.json'); evidence_path.write_text(json.dumps(evidence))
    closure = {'schema_version':'noreset-closed-scope-successor-v1', 'status':'permanently_closed',
        'authorization_source':'explicit_owner_approval', 'approval_ref':document['approval_ref'],
        'previous_state_sha256':digest(meter.state_path.read_bytes()), 'previous_receipt_sha256':head,
        'previous_attempts_sha256':digest(gate._snapshot(rows).encode()),
        'new_receipt_sha256':digest(receipt.read_bytes()), 'last_attempt_id':rows[-1][0],
        'freeze_reason':reason, 'last_request_sha256':rows[-1][2], 'last_source_sha256':rows[-1][3],
        'failure_evidence_sha256':digest(evidence_path.read_bytes())}
    closure_path = stem.with_name(stem.name+'-closure.json'); closure_path.write_text(json.dumps(closure))
    return dict(previous=meter, previous_document=case['document'], old_rows=rows,
        old_state=meter.state_path.read_bytes(), old_receipt=meter.receipt_path.read_bytes(),
        document=document, receipt=receipt, state=state, closure=closure, closure_path=closure_path,
        evidence=evidence, evidence_path=evidence_path)


def succeed(case, **changes):
    args = dict(previous_receipt_path=case['previous'].receipt_path,
        previous_state_path=case['previous'].state_path, closure_path=case['closure_path'],
        failure_evidence_path=case['evidence_path'])
    args.update(changes)
    document,_=gate._parse_receipt(case['receipt'].read_bytes())
    trial_budget.register_batch(document['cumulative_budget'],receipt=document)
    result = gate.succeed_informed_trial(case['receipt'], case['state'], **args)
    return gate.TrialGate(case['receipt'], case['state']), result


def unchanged(case):
    assert case['previous'].state_path.read_bytes() == case['old_state']
    assert case['previous'].receipt_path.read_bytes() == case['old_receipt']


def test_five_closed_attempts_can_inherit_one_asr_two_llm_without_reset(five):
    case = proposal(five)
    meter, result = succeed(case)
    assert result['remaining_requests'] == 3 and result['historical_reserved_usd'] == '0.9510912'
    assert result['remaining_usd'] is None and result['cost_bound_known'] is False
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT * FROM attempts ORDER BY id').fetchall() == case['old_rows']
        assert db.execute('SELECT frozen_reason FROM closed_metadata').fetchone() == ('response_invalid',)
        assert db.execute('SELECT usage_json FROM attempts WHERE id=4').fetchone() == (None,)
    for kind in ('asr', 'llm', 'llm'):
        ident = send(meter, case['document'], kind)
        with pytest.raises(gate.TrialGateError): send(meter, case['document'], 'llm')
        review(meter, ident)
    assert ident == 8
    with pytest.raises(gate.TrialGateError): send(meter, case['document'], 'asr')
    journal = gate.trial_journal(state_path=meter.state_path)
    assert len(journal) == 8 and journal[3]['usage'] is None
    assert journal[3]['closed_status'] == 'failed_usage_unverified'
    with sqlite3.connect(meter.state_path) as db:
        assert db.execute('SELECT * FROM attempts WHERE id<=5 ORDER BY id').fetchall() == case['old_rows']
    unchanged(case)


@pytest.mark.parametrize('sequence', [('asr','llm'), ('asr','llm','asr','llm'), ('llm',)])
def test_order_and_count_are_new_approval_data_not_old_batch_shape(five, sequence):
    case = proposal(five, sequence); meter, _ = succeed(case)
    for kind in sequence: review(meter, send(meter, case['document'], kind))
    assert len(gate.trial_journal(state_path=meter.state_path)) == 5+len(sequence)
    unchanged(case)


def test_late_old_reports_stops_and_reviews_cannot_change_the_successor(five):
    case = proposal(five); meter, _ = succeed(case)
    before = meter.state_path.read_bytes()
    for ident in (4,5):
        with pytest.raises(gate.TrialGateError): gate.report_usage(ident, 'gemini-2.5-flash-lite',
            {'prompt_tokens':1,'completion_tokens':1,'completion_tokens_details':{'reasoning_tokens':0}}, state_path=meter.state_path)
        with pytest.raises(gate.TrialGateError): gate.stop_trial(ident, 'owner_stop', state_path=meter.state_path)
        with pytest.raises(gate.TrialGateError): review(meter, ident)
    assert meter.state_path.read_bytes() == before
    unchanged(case)


def test_derived_llm_hashes_are_added_only_within_frozen_explicit_scope(five):
    case = proposal(five)
    profile = case['document']['profiles']['llm']
    sources, requests = list(profile['source_sha256']), list(profile['request_sha256'])
    profile['source_sha256'] = []; profile['request_sha256'] = []
    case['receipt'].write_text(json.dumps(case['document']))
    case['closure']['new_receipt_sha256'] = digest(case['receipt'].read_bytes())
    case['closure_path'].write_text(json.dumps(case['closure']))
    meter, _ = succeed(case)
    review(meter, send(meter, case['document'], 'asr'))
    with pytest.raises(gate.TrialGateError): send(meter, case['document'], 'llm')
    case['document']['approval_ref'] = 'invented-reviewed-derived-full-wire-and-source'
    profile['source_sha256'].append(sources[0]); profile['request_sha256'].append(requests[0])
    case['receipt'].write_text(json.dumps(case['document'])); gate.amend_trial(meter.receipt_path, meter.state_path)
    review(meter, send(meter, case['document'], 'llm'))
    with pytest.raises(gate.TrialGateError): send(meter, case['document'], 'llm')
    case['document']['approval_ref'] = 'invented-reviewed-current-correction-full-wire'
    profile['source_sha256'].append(sources[1]); profile['request_sha256'].append(requests[1])
    case['receipt'].write_text(json.dumps(case['document'])); gate.amend_trial(meter.receipt_path, meter.state_path)
    assert send(meter, case['document'], 'llm') == 8
    unchanged(case)


@pytest.mark.parametrize('mutation', [
    lambda x:x.update(request_sequence=['asr','llm']),
    lambda x:x.update(total_requests=99),
    lambda x:x.update(status='draft'),
    lambda x:x.update(authorization_source='http_request'),
    lambda x:x.update(approval_ref='human-new-one-pair-unknown-charge'),
    lambda x:x['spend_authorization'].update(hard_currency_cap=True),
    lambda x:x['profiles']['llm'].update(requests=3),
    lambda x:x.update(request_sequence=['asr','ocr','llm']),
])
def test_unapproved_or_changed_counts_costs_or_services_fail_closed(five, mutation):
    case=proposal(five); mutation(case['document'])
    case['receipt'].write_text(json.dumps(case['document']))
    case['closure']['new_receipt_sha256']=digest(case['receipt'].read_bytes())
    case['closure_path'].write_text(json.dumps(case['closure']))
    with pytest.raises(gate.TrialGateError): succeed(case)
    assert not case['state'].exists(); unchanged(case)


@pytest.mark.parametrize('field', ['previous_state_sha256','previous_receipt_sha256',
    'previous_attempts_sha256','new_receipt_sha256','failure_evidence_sha256'])
def test_missing_exact_closed_bindings_never_create_a_new_allowance(five, field):
    case=proposal(five); case['closure'][field]='0'*64
    case['closure_path'].write_text(json.dumps(case['closure']))
    with pytest.raises(gate.TrialGateError): succeed(case)
    assert not case['state'].exists(); unchanged(case)


def test_logical_copy_or_reserialized_source_cannot_create_duplicate_scope(five):
    case=proposal(five); meter,_=succeed(case)
    with pytest.raises(gate.TrialGateError): succeed(case)
    copied=case['state'].with_name('copied-predecessor.sqlite3'); copied.write_bytes(case['old_state'])
    with sqlite3.connect(copied) as db: db.execute('PRAGMA user_version=19')
    case['state']=case['state'].with_name('duplicate-new-scope.sqlite3')
    case['closure']['previous_state_sha256']=digest(copied.read_bytes())
    case['closure_path'].write_text(json.dumps(case['closure']))
    with pytest.raises(gate.TrialGateError): succeed(case,previous_state_path=copied)
    assert not case['state'].exists()
    clone=case['state'].with_name('copied-active-successor.sqlite3'); clone.write_bytes(meter.state_path.read_bytes())
    with pytest.raises(gate.TrialGateError): gate.validate_trial_authorization(receipt_path=meter.receipt_path,state_path=clone)
    unchanged(case)


def test_new_unknown_usage_does_not_bypass_stop_review_or_hash_amend(five):
    case=proposal(five); meter,_=succeed(case)
    ident=send(meter,case['document'],'asr',report=False)
    with pytest.raises(gate.TrialGateError): review(meter,ident)
    with pytest.raises(gate.TrialGateError): send(meter,case['document'],'llm')
    gate.stop_trial(ident,'transport_failed',state_path=meter.state_path)
    with pytest.raises(gate.TrialGateError): review(meter,ident)
    with pytest.raises(gate.TrialGateError): send(meter,case['document'],'llm')
    unchanged(case)


def test_successor_can_itself_be_permanently_closed_with_all_proofs_preserved(five):
    case=proposal(five, ('asr','llm')); meter,_=succeed(case)
    ident=send(meter,case['document'],'asr'); gate.stop_trial(ident,'business_validation_failed',state_path=meter.state_path)
    next_case=proposal(dict(meter=meter,document=case['document'],tmp=five['tmp']),('llm',))
    next_meter,_=succeed(next_case)
    assert send(next_meter,next_case['document'],'llm')==7
    assert len(gate.trial_journal(state_path=next_meter.state_path))==7
    assert gate.trial_journal(state_path=next_meter.state_path)[3]['usage'] is None
    unchanged(case); unchanged(next_case)


def test_stop_before_first_new_post_is_durable_idempotent_and_does_not_overwrite_reason(five):
    case=proposal(five); meter,_=succeed(case)
    preflight=gate.validate_trial_authorization(receipt_path=meter.receipt_path,state_path=meter.state_path)
    assert preflight['scope_used_requests']==0 and preflight['next_kind']=='asr'
    assert preflight['protected_through_attempt_id']==5 and preflight['manual_review_required'] is False
    first=gate.close_trial_scope(meter.receipt_path,meter.state_path,'response_invalid')
    assert first['reason']=='response_invalid'
    assert gate.close_trial_scope(meter.receipt_path,meter.state_path,'owner_stop')==first
    with pytest.raises(gate.TrialGateError): send(meter,case['document'],'asr')
    assert len(gate.trial_journal(state_path=meter.state_path))==5
    unchanged(case)


def test_owner_stop_does_not_make_unknown_latest_usage_a_closed_exception(five):
    with sqlite3.connect(five['meter'].state_path) as db:
        db.execute('UPDATE attempts SET usage_json=NULL WHERE id=5')
    case=proposal(five)
    with pytest.raises(gate.TrialGateError): succeed(case)
    assert not case['state'].exists(); unchanged(case)


@pytest.mark.parametrize('damage', ['old_usage','old_stop','old_proof','old_review','old_response_metadata'])
def test_successor_proof_rechecks_every_preserved_record_not_only_attempt_count(five,damage):
    case=proposal(five); meter,_=succeed(case)
    with sqlite3.connect(meter.state_path) as db:
        if damage=='old_usage': db.execute('UPDATE attempts SET usage_json=NULL WHERE id=5')
        elif damage=='old_stop': db.execute("UPDATE closed_scope_metadata SET frozen_reason='altered_stop'")
        elif damage=='old_proof': db.execute("UPDATE closed_origin SET evidence_raw='{}'")
        elif damage=='old_review':
            db.execute('CREATE TABLE IF NOT EXISTS trial_reviews (attempt_id INTEGER PRIMARY KEY,approval_ref TEXT NOT NULL)')
            db.execute('INSERT INTO trial_reviews VALUES (?,?)',(5,'forged-after-closure-review'))
        else:
            db.execute('CREATE TABLE IF NOT EXISTS transport_metadata (attempt_id INTEGER PRIMARY KEY,metadata_json TEXT NOT NULL)')
            db.execute('INSERT OR REPLACE INTO transport_metadata VALUES (?,?)',(5,'{}'))
    with pytest.raises(gate.TrialGateError): gate.validate_trial_authorization(receipt_path=meter.receipt_path,state_path=meter.state_path)
    unchanged(case)


def test_second_llm_cannot_reuse_first_wire_or_mismatched_source_even_if_whitelisted(five):
    case=proposal(five); meter,_=succeed(case)
    review(meter,send(meter,case['document'],'asr'))
    review(meter,send(meter,case['document'],'llm'))
    p=case['document']['profiles']['llm']
    with pytest.raises(gate.TrialGateError): send(meter,case['document'],'llm',wire=planned_wire('llm',0),source_sha256=p['source_sha256'][0])
    with pytest.raises(gate.TrialGateError): send(meter,case['document'],'llm',source_sha256=p['source_sha256'][0])
    assert send(meter,case['document'],'llm')==8
    unchanged(case)


def test_cumulative_descriptor_cannot_be_dropped_or_changed_in_a_later_scope(five):
    case=proposal(five)
    meter,_=succeed(case)
    trial_budget.close_batch(case['document']['cumulative_budget'],receipt_id=case['document']['receipt_id'],reason='owner_stop')
    # An independently closed cumulative batch blocks every send.
    with pytest.raises(gate.TrialGateError): send(meter,case['document'],'asr')
    assert len(gate.trial_journal(state_path=meter.state_path))==5
    with sqlite3.connect(meter.state_path) as db: db.execute("UPDATE metadata SET frozen_reason='owner_stop'")
    next_case=proposal(dict(meter=meter,document=case['document'],tmp=five['tmp']),('llm',))
    next_case['document'].pop('cumulative_budget')
    next_case['receipt'].write_text(json.dumps(next_case['document']))
    next_case['closure']['new_receipt_sha256']=digest(next_case['receipt'].read_bytes())
    next_case['closure_path'].write_text(json.dumps(next_case['closure']))
    with pytest.raises(gate.TrialGateError): succeed(next_case)
    unchanged(case)


def test_failed_unknown_is_preserved_with_allocation_and_different_request_may_succeed(five):
    case=proposal(five, ('asr','llm')); meter,_=succeed(case)
    ident=send(meter,case['document'],'asr',report=False)
    gate.stop_trial(ident,'transport_failed',state_path=meter.state_path)
    next_case=proposal(dict(meter=meter,document=case['document'],tmp=five['tmp']),('llm',))
    next_meter,_=succeed(next_case)
    assert send(next_meter,next_case['document'],'llm')==7
    journal=gate.trial_journal(state_path=next_meter.state_path)
    assert [j['id'] for j in journal if j.get('closed_status')=='failed_usage_unverified']==[4,6]
    assert journal[3]['usage'] is None and journal[5]['usage'] is None
    snapshot=trial_budget.budget_snapshot(five['descriptor'])
    assert snapshot['reserved_estimate_usd']=='0.0106816'
    assert snapshot['response_usage_unknown']==1 and snapshot['refunds_allowed'] is False
    with pytest.raises(gate.TrialGateError): gate.report_usage(6,'gemini-2.5-flash-lite',
        {'prompt_tokens':1,'completion_tokens':1,'completion_tokens_details':{'reasoning_tokens':0}},state_path=next_meter.state_path)
    unchanged(case); unchanged(next_case)


@pytest.mark.parametrize('different_request', [False,True])
def test_unknown_request_is_not_replayed_but_new_exact_reviewed_source_can_be_reserved(five,different_request):
    case=proposal(five, ('asr','llm')); meter,_=succeed(case)
    ident=send(meter,case['document'],'asr',report=False)
    gate.stop_trial(ident,'response_invalid',state_path=meter.state_path)
    next_case=proposal(dict(meter=meter,document=case['document'],tmp=five['tmp']),('asr',))
    if different_request:
        p=next_case['document']['profiles']['asr']
        p['source_sha256']=[digest(audio(2))]; p['request_sha256']=[digest(planned_wire('asr',1))]
        next_case['receipt'].write_text(json.dumps(next_case['document']))
        next_case['closure']['new_receipt_sha256']=digest(next_case['receipt'].read_bytes())
        next_case['closure_path'].write_text(json.dumps(next_case['closure']))
    next_meter,_=succeed(next_case)
    if different_request:
        assert send(next_meter,next_case['document'],'asr',wire=planned_wire('asr',1))==7
        expected='0.002048'
    else:
        with pytest.raises(gate.TrialGateError): send(next_meter,next_case['document'],'asr')
        assert len(gate.trial_journal(state_path=next_meter.state_path))==6
        expected='0.001024'
    assert trial_budget.budget_snapshot(five['descriptor'])['reserved_estimate_usd']==expected
    unchanged(case); unchanged(next_case)


@pytest.mark.parametrize('missing_allocation', [False,True])
def test_owner_stop_or_unbacked_unknown_never_create_a_closed_usage_exception(five,missing_allocation):
    case=proposal(five, ('asr','llm')); meter,_=succeed(case)
    ident=send(meter,case['document'],'asr',report=False)
    gate.stop_trial(ident,'transport_failed' if missing_allocation else 'owner_stop',state_path=meter.state_path)
    if missing_allocation:
        with sqlite3.connect(five['descriptor']['state_path']) as db: db.execute('DELETE FROM allocations')
    next_case=proposal(dict(meter=meter,document=case['document'],tmp=five['tmp']),('llm',))
    with pytest.raises(gate.TrialGateError): succeed(next_case)
    assert not next_case['state'].exists(); unchanged(case); unchanged(next_case)


def test_invalid_usage_remains_unverified_and_late_success_cannot_change_first_failure(five):
    case=proposal(five, ('asr','llm')); meter,_=succeed(case)
    ident=send(meter,case['document'],'asr',report=False)
    with pytest.raises(gate.TrialGateError): gate.report_usage(ident,'gemini-2.5-flash-lite',
        {'prompt_tokens':-1,'completion_tokens':1,'completion_tokens_details':{'reasoning_tokens':0}},state_path=meter.state_path)
    gate.stop_trial(ident,'owner_stop',state_path=meter.state_path)
    before=meter.state_path.read_bytes()
    with pytest.raises(gate.TrialGateError): gate.report_usage(ident,'gemini-2.5-flash-lite',
        {'prompt_tokens':1,'completion_tokens':1,'completion_tokens_details':{'reasoning_tokens':0}},state_path=meter.state_path)
    assert meter.state_path.read_bytes()==before
    next_case=proposal(dict(meter=meter,document=case['document'],tmp=five['tmp']),('llm',))
    next_meter,_=succeed(next_case)
    journal=gate.trial_journal(state_path=next_meter.state_path)
    assert journal[5]['usage']['verified'] is False and journal[5]['usage']['prompt_tokens'] is None
    assert journal[5]['closed_status']=='failed_usage_unverified'
    assert trial_budget.budget_snapshot(five['descriptor'])['batches'][0]['closure_reason']=='usage_unverified_or_over_bound'
    unchanged(case); unchanged(next_case)


def test_native_same_usage_callback_is_idempotent_without_repeating_response_metadata(five):
    case=proposal(five); meter,_=succeed(case)
    ident=send(meter,case['document'],'asr')
    before=meter.state_path.read_bytes()
    result=gate.report_usage(ident,'gemini-2.5-flash-lite',
        {'prompt_tokens':1,'completion_tokens':1,'completion_tokens_details':{'reasoning_tokens':0}},state_path=meter.state_path)
    assert result['verified'] is True and meter.state_path.read_bytes()==before
    assert trial_budget.budget_snapshot(five['descriptor'])['attempt_allocations']==1


def test_expiry_cannot_prevent_local_stop_and_no_new_post_is_reserved(five,monkeypatch):
    case=proposal(five); meter,_=succeed(case)
    class Later(datetime):
        @classmethod
        def now(cls,tz=None): return datetime.now(tz)+timedelta(hours=2)
    monkeypatch.setattr(gate,'datetime',Later)
    with pytest.raises(gate.TrialGateError): gate.validate_trial_authorization(receipt_path=meter.receipt_path,state_path=meter.state_path)
    assert gate.close_trial_scope(meter.receipt_path,meter.state_path,'owner_stop')['stopped'] is True
    assert len(gate.trial_journal(state_path=meter.state_path))==5
    assert trial_budget.budget_snapshot(five['descriptor'])['attempt_allocations']==0
    unchanged(case)


def test_new_receipt_requires_real_descriptor_and_preflight_requires_registration(five):
    case=proposal(five)
    missing=copy.deepcopy(case['document']); missing.pop('cumulative_budget')
    with pytest.raises(gate.TrialGateError): gate._parse_receipt(json.dumps(missing).encode())
    with pytest.raises(gate.TrialGateError): gate.succeed_informed_trial(case['receipt'],case['state'],
        previous_receipt_path=case['previous'].receipt_path,previous_state_path=case['previous'].state_path,
        closure_path=case['closure_path'],failure_evidence_path=case['evidence_path'])
    with pytest.raises(gate.TrialGateError): gate.validate_trial_authorization(receipt_path=case['receipt'],state_path=case['state'])
    assert trial_budget.budget_snapshot(five['descriptor'])['attempt_allocations']==0
    unchanged(case)


def test_append_without_closed_origin_cannot_replace_the_same_cumulative_authorization(five):
    receipt=five['tmp']/'simple-append.json'; state=five['tmp']/'simple-append.sqlite3'
    old=receipt_document(); receipt.write_text(json.dumps(old)); gate.initialize_trial(receipt,state)
    meter=gate.TrialGate(receipt,state)
    for _ in range(3): legacy_reserve(meter,old)
    document=proposal(five,('llm',))['document']
    with sqlite3.connect(state) as db: head=db.execute('SELECT receipt_sha256 FROM metadata').fetchone()[0]
    document.update(previous_receipt_sha256=head,total_requests=4,receipt_id='invented-normal-append-scope')
    receipt.write_text(json.dumps(document)); trial_budget.register_batch(five['descriptor'],receipt=document)
    gate.append_trial(receipt,state); ident=send(meter,document,'llm'); review(meter,ident)
    trial_budget.close_batch(five['descriptor'],receipt_id=document['receipt_id'],reason='owner_stop')
    before=state.read_bytes()
    with sqlite3.connect(state) as db: head=db.execute('SELECT receipt_sha256 FROM metadata').fetchone()[0]
    next_document=copy.deepcopy(document)
    next_document.update(previous_receipt_sha256=head,total_requests=5,receipt_id='invented-unsafe-reset',approval_ref='invented-changed-approval')
    next_document['cumulative_budget']['state_path']=str((five['tmp']/'different-empty-budget.sqlite3').resolve())
    receipt.write_text(json.dumps(next_document))
    with pytest.raises(gate.TrialGateError): gate.append_trial(receipt,state)
    assert state.read_bytes()==before
