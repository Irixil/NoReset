"""Future non-thinking response compatibility; original unknown rows untouched.

All approvals, provider replies and paths are synthetic/TEMP. Actual attempt7
usage shape is reproduced literally; content is a fresh authored JSON stub.
"""
import copy
import hashlib
import json
import socket
import sqlite3
from urllib.request import Request

import pytest

from backend import model_client, trial_budget, trial_gate
from tests.test_trial_append_20261009 import history
from tests.test_trial_continuation_20261009 import closed
from tests.test_trial_scope_successor_20261009 import five, proposal, succeed, planned_wire


@pytest.fixture(autouse=True)
def no_network_or_runtime(monkeypatch,tmp_path):
    def forbidden(*args,**kwargs): pytest.fail('Offline callback tests must not use sockets')
    monkeypatch.setattr(socket,'create_connection',forbidden)
    monkeypatch.setattr(socket.socket,'connect',forbidden)
    monkeypatch.setattr(socket.socket,'connect_ex',forbidden)
    monkeypatch.setattr(trial_gate,'CONTINUATION_CLAIM_ROOT',tmp_path/'gate-claims')
    monkeypatch.setattr(trial_budget,'CLAIM_ROOT',tmp_path/'budget-claims')


def response():
    return {'id':'synthetic-actual7-usage-shape','model':'deepseek-flash','object':'chat.completion',
        'choices':[{'index':0,'finish_reason':'stop','message':{'role':'assistant','content':'{"summary":"原创合成回包"}'}}],
        'usage':{'prompt_tokens':1782,'completion_tokens':361,'total_tokens':2143,
            'prompt_tokens_details':{'cached_tokens':1280},'prompt_cache_hit_tokens':1280,'prompt_cache_miss_tokens':502}}


def reserved(five,returned_models=None):
    case=proposal(five,('llm',))
    if returned_models is not None:
        case['document']['profiles']['llm']['billing']['returned_models']=returned_models
        case['receipt'].write_text(json.dumps(case['document']))
        case['closure']['new_receipt_sha256']=hashlib.sha256(case['receipt'].read_bytes()).hexdigest()
        case['closure_path'].write_text(json.dumps(case['closure']))
    meter,_=succeed(case)
    profile=case['document']['profiles']['llm']; wire=planned_wire('llm')
    ident=meter.reserve(kind='llm',provider=profile['provider'],model=profile['model'],url=profile['url'],
        wire=wire,source_sha256=profile['source_sha256'][0],output_tokens=2048,thinking_tokens=0)
    request=Request(profile['url'],data=wire,method='POST')
    request._noreset_trial_profile={'kind':'llm','provider':'deepseek','model':'deepseek-flash','source_sha256':profile['source_sha256'][0]}
    request._noreset_trial_attempt_id=ident; request._noreset_trial_state_path=meter.state_path
    return case,meter,request,ident


def callback(request,value,protocol='openai'):
    model_client._trial_report(request,value,json.dumps(value,ensure_ascii=False).encode(),protocol=protocol)


@pytest.mark.parametrize('shape',['actual7','empty_details','returned_alias'])
def test_future_official_nonthinking_missing_reasoning_reports_with_audited_derivation(five,shape):
    case,meter,request,ident=reserved(five,['deepseek-flash','deepseek-v4-flash'] if shape=='returned_alias' else None); value=response()
    if shape=='empty_details': value['usage']['completion_tokens_details']={}
    if shape=='returned_alias': value['model']='deepseek-v4-flash'
    original=copy.deepcopy(value); raw_usage_sha=hashlib.sha256(trial_gate._snapshot(value['usage']).encode()).hexdigest()
    callback(request,value)
    assert value==original
    item=trial_gate.trial_journal(state_path=meter.state_path)[-1]
    assert item['id']==6 and item['usage']=={'returned_model':value['model'],'prompt_tokens':1782,
        'completion_tokens':361,'reasoning_tokens':0,'verified':True}
    with sqlite3.connect(meter.state_path) as db:
        meta=json.loads(db.execute('SELECT metadata_json FROM transport_metadata WHERE attempt_id=?',(ident,)).fetchone()[0])
    assert meta['usage_normalization']=='deepseek_nonthinking_omitted_reasoning_v1'
    assert meta['original_usage_sha256']==raw_usage_sha
    assert meta['request_sha256']==hashlib.sha256(request.data).hexdigest()
    assert trial_budget.budget_snapshot(five['descriptor'])['response_usage_known']==1
    assert trial_budget.budget_snapshot(five['descriptor'])['reserved_estimate_usd']=='0.0096576'
    assert case['previous'].state_path.read_bytes()==case['old_state']


@pytest.mark.parametrize('fault',[
    'relay','unknown_model','unknown_request_model','wrong_kind','thinking_enabled','thinking_missing','conflicting_effort',
    'streaming','tools','wrong_endpoint','total_missing','unbalanced_total','bool_prompt','negative_prompt','bool_generated',
    'bool_total','cache_bool','cache_unbalanced','cache_one_field','cache_details_mismatch','cache_details_bool',
    'reasoning_content','reasoning_logprobs','top_reasoning','malformed_logprobs','empty_content','blank_content',
    'tool_call','not_stop','two_choices','wrong_role','details_null',
    'reasoning_null','reasoning_bool','reasoning_negative','reasoning_positive'])
def test_omission_never_repairs_unknown_or_conflicting_future_usage(five,fault):
    case,meter,request,ident=reserved(five); value=response(); body=json.loads(request.data)
    if fault=='relay': request._noreset_trial_profile['provider']='openai_compatible'
    elif fault=='unknown_model': value['model']='unknown-model'
    elif fault=='unknown_request_model': body['model']='unknown-model'
    elif fault=='wrong_kind': request._noreset_trial_profile['kind']='ocr'
    elif fault=='thinking_enabled': body['thinking']={'type':'enabled'}
    elif fault=='thinking_missing': body.pop('thinking')
    elif fault=='conflicting_effort': body['reasoning_effort']='high'
    elif fault=='streaming': body['stream']=True
    elif fault=='tools': body['tools']=[]
    elif fault=='wrong_endpoint': request.full_url='https://example.invalid/chat/completions'
    elif fault=='total_missing': value['usage'].pop('total_tokens')
    elif fault=='unbalanced_total': value['usage']['total_tokens']+=1
    elif fault=='bool_prompt': value['usage']['prompt_tokens']=True
    elif fault=='negative_prompt': value['usage']['prompt_tokens']=-1
    elif fault=='bool_generated': value['usage']['completion_tokens']=True
    elif fault=='bool_total': value['usage']['total_tokens']=True
    elif fault=='cache_bool': value['usage']['prompt_cache_hit_tokens']=True
    elif fault=='cache_unbalanced': value['usage']['prompt_cache_miss_tokens']+=1
    elif fault=='cache_one_field': value['usage'].pop('prompt_cache_miss_tokens')
    elif fault=='cache_details_mismatch': value['usage']['prompt_tokens_details']['cached_tokens']+=1
    elif fault=='cache_details_bool': value['usage']['prompt_tokens_details']['cached_tokens']=True
    elif fault=='reasoning_content': value['choices'][0]['message']['reasoning_content']='thought'
    elif fault=='reasoning_logprobs': value['choices'][0]['logprobs']={'reasoning_content':[{'token':'thought'}]}
    elif fault=='top_reasoning': value['reasoning_content']='unexpected thought'
    elif fault=='malformed_logprobs': value['choices'][0]['logprobs']=[]
    elif fault=='empty_content': value['choices'][0]['message']['content']=''
    elif fault=='blank_content': value['choices'][0]['message']['content']=' \n '
    elif fault=='tool_call': value['choices'][0]['message']['tool_calls']=[{'function':{'name':'x'}}]
    elif fault=='not_stop': value['choices'][0]['finish_reason']='length'
    elif fault=='two_choices': value['choices'].append(copy.deepcopy(value['choices'][0]))
    elif fault=='wrong_role': value['choices'][0]['message']['role']='user'
    elif fault=='details_null': value['usage']['completion_tokens_details']=None
    else:
        value['usage']['completion_tokens_details']={'reasoning_tokens':{'reasoning_null':None,'reasoning_bool':True,
            'reasoning_negative':-1,'reasoning_positive':1}[fault]}
    request.data=json.dumps(body).encode(); original=copy.deepcopy(value)
    with pytest.raises(model_client.ModelClientError): callback(request,value)
    assert value==original
    assert trial_gate.trial_journal(state_path=meter.state_path)[-1]['usage']['verified'] is False
    assert trial_budget.budget_snapshot(five['descriptor'])['response_usage_unknown']==1
    assert trial_budget.budget_snapshot(five['descriptor'])['reserved_estimate_usd']=='0.0096576'


def test_native_single_response_opener_replay_reports_same_future_attempt_without_network(five,monkeypatch):
    case=proposal(five,('llm',)); value=response()
    body={'thinking':{'type':'disabled'},'model':'deepseek-flash','temperature':0,'stream':False,'max_tokens':2048,
        'messages':[{'role':'system','content':'synthetic'},{'role':'user','content':'{"synthetic": true}'}]}
    exact=json.dumps(body,ensure_ascii=False,allow_nan=False).encode()
    case['document']['profiles']['llm']['request_sha256']=[hashlib.sha256(exact).hexdigest()]
    case['document']['profiles']['llm']['source_sha256']=[hashlib.sha256(b'{"synthetic": true}').hexdigest()]
    case['receipt'].write_text(json.dumps(case['document']))
    case['closure']['new_receipt_sha256']=hashlib.sha256(case['receipt'].read_bytes()).hexdigest()
    case['closure_path'].write_text(json.dumps(case['closure']))
    meter,_=succeed(case); calls=[]
    class Response:
        status=200; headers={'Content-Type':'application/json'}
        def read(self,limit): return json.dumps(value,ensure_ascii=False).encode()[:limit]
        def __enter__(self): return self
        def __exit__(self,*_): return False
    class Opener:
        def open(self,request,**kwargs):
            calls.append(request)
            assert request.data==exact
            assert trial_budget.budget_snapshot(five['descriptor'])['attempt_allocations']==1
            return Response()
    monkeypatch.setattr(trial_gate,'TrialGate',lambda:meter)
    monkeypatch.setattr(model_client.urllib.request,'build_opener',lambda *_:Opener())
    client=model_client.ChatCompletionsClient(base_url='https://api.deepseek.com',model='deepseek-flash',
        api_key='invented-never-sent',trial_provider='deepseek',max_tokens=2048,extra_body={'thinking':{'type':'disabled'}})
    assert client.complete_json('synthetic',{'synthetic':True})=={'summary':'原创合成回包'}
    assert len(calls)==1 and trial_budget.budget_snapshot(five['descriptor'])['response_usage_known']==1
    assert model_client.trial_control()=={'review_required':True}


def test_future_eligible_shape_cannot_reclassify_a_previous_frozen_unknown_row(five):
    case,meter,request,ident=reserved(five); value=response()
    with pytest.raises(trial_gate.TrialGateError): trial_gate.report_usage(ident,value['model'],value['usage'],state_path=meter.state_path)
    before=meter.state_path.read_bytes(); budget_before=trial_budget.budget_snapshot(five['descriptor'])
    with pytest.raises(model_client.ModelClientError): callback(request,value)
    assert meter.state_path.read_bytes()==before
    assert trial_budget.budget_snapshot(five['descriptor'])==budget_before
    assert trial_gate.trial_journal(state_path=meter.state_path)[-1]['usage']['verified'] is False
    assert budget_before['response_usage_unknown']==1 and budget_before['reserved_estimate_usd']=='0.0096576'


def test_saved_reply_pure_product_parser_does_not_report_or_reserve(monkeypatch):
    def forbidden(*args,**kwargs): pytest.fail('Pure saved response parsing must not meter or transport')
    monkeypatch.setattr(model_client,'_trial_report',forbidden)
    monkeypatch.setattr(model_client,'_open_request',forbidden)
    monkeypatch.setattr(trial_gate,'report_usage',forbidden)
    monkeypatch.setattr(trial_gate,'authorize_request',forbidden)
    value=response(); original=copy.deepcopy(value)
    assert model_client.parse_completion_envelope(value)=={'summary':'原创合成回包'}
    assert value==original and 'completion_tokens_details' not in value['usage']
    value['choices'][0]['finish_reason']='length'
    with pytest.raises(model_client.ModelClientError) as error: model_client.parse_completion_envelope(value)
    assert error.value.code=='model_output_truncated'
