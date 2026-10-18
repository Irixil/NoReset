from __future__ import annotations
import hashlib,json,math,os,re,time,unicodedata,uuid
from dataclasses import dataclass,field
from datetime import datetime,timezone
from pathlib import Path
from typing import Any,Dict,Protocol
try:
 from jsonschema import Draft202012Validator
except ImportError: Draft202012Validator=None
ROOT=Path(__file__).resolve().parents[1]
SCHEMA=json.loads((ROOT/'config/event-v0.3.schema.json').read_text(encoding='utf-8'))
SCHEMA_VERSION=SCHEMA['properties']['schema_version']['const']
class AdapterError(RuntimeError):
 def __init__(self,message,*,code=None,status=None):
  super().__init__(message); self.code=code; self.status=status


def _validation_error(message, code):
 """Raise a bounded, non-content diagnostic for a local model contract check.

 The message remains useful to local callers/tests, while the code is the only
 value allowed to cross the HTTP/audit boundary.  Keep this separate from
 provider transport codes: a rejected model draft must never be treated as a
 successful or partially safe draft.
 """
 raise AdapterError(message, code=code)
class Provider(Protocol):
 def complete_json(self,system_prompt:str,payload:Dict[str,Any])->Dict[str,Any]: ...
def now(): return datetime.now(timezone.utc).isoformat()
def new_id(p): return f'{p}_{uuid.uuid4()}'
try:
 from .safety import scan_danger, DANGER_REMINDER, document_needs_review
except ImportError:
 from safety import scan_danger, DANGER_REMINDER, document_needs_review
def danger(t): return scan_danger(t)['danger_detected']
def medication_review_required(t):
 # This routes uncertain medication/instruction text for review; it is not a diagnosis.
 return bool(re.search(r'药|处方|剂量|医嘱|医生|药师|嘱咐|服用|停服|停用|加量|减量|每次|每天.{0,4}次|(?:\d+(?:\.\d+)?|半|一|二|两|三|四|五|六|七|八|九|十)\s*(?:毫克|微克|mg|mcg|片|粒|毫升|ml)',t,re.IGNORECASE))
def kind(t):
 if re.search(r'血压|血糖|体温|心率|\d{2,3}/\d{2,3}',t): return 'measurement'
 if re.search(r'药|处方|剂量|停药|加药|减药|服用',t): return 'medication'
 if re.search(r'头晕|咳嗽|走路|疼|痛|不舒服|发热|呼吸|无力|含糊|昏迷',t): return 'symptom'
 if re.search(r'医生|药师|建议|医嘱',t): return 'instruction'
 if '要不要' in t or '是否' in t:return 'question'
 return 'other'
class MockProvider:
 def complete_json(self,system_prompt,payload):
  t=str(payload.get('raw_text','')).strip(); rid=str(payload.get('record_id') or new_id('rec')); explicit=payload.get('source_kind'); src=explicit if explicit in ALLOWED_SOURCE_KINDS else 'unknown'
  d=danger(t); rel=bool(re.search(r'今天|昨天|最近|大约|好像|不记得|不清楚|之前',t)); ek=kind(t)
  history=payload.get('history') or payload.get('history_events') or []
  refs=[]; conflict=False
  for h in history:
   if not isinstance(h,dict): continue
   hid=str(h.get('record_id') or h.get('id') or '')
   ht=str(h.get('raw_text') or h.get('text') or '')
   if not hid or not ht or ht == t: continue  # 精确同文保留为两条，不合并、不制造冲突
   hk=str(h.get('event_kind') or '')
   if hk and hk == ek or (ek == 'measurement' and re.search(r'血压|血糖|体温|心率|\d{2,3}/\d{2,3}',ht)):
    refs.append(hid); conflict=True
  if conflict:
   rel=True
   refs=list(dict.fromkeys([rid]+refs))
  return {'schema_version':SCHEMA_VERSION,'event_kind':ek,'summary':t,'time':{'occurred':payload.get('occurred_time'),'recorded':payload.get('recorded_at') or now(),'certainty':'relative' if rel else ('unknown' if not payload.get('occurred_time') else 'exact')},'claims':[{'text':t,'source_kind':src,'record_id':rid,'quote':t}],'review_required':True,'review_role':'emergency_services' if d else ('clinician_or_pharmacist' if ek in {'medication','instruction'} or medication_review_required(t) else 'family'),'escalation_level':'emergency' if d else 'none','conflict':{'present':conflict,'record_refs':refs},'provenance_preserved':True,'plan_change_allowed':False,'follow_up_questions':['请补充发生时间和可核验证据。'] if rel else [],'forbidden_actions':[]}
ALLOWED_SOURCE_KINDS={'elder','family_observation','family_report','caregiver','clinician_evidence','document','audio_transcript','system','unknown'}
try:
 from .model_client import ChatCompletionsClient,ModelClientError,parse_extra_body
except ImportError:
 from model_client import ChatCompletionsClient,ModelClientError,parse_extra_body
@dataclass(frozen=True)
class Config:
 provider:str='mock'; base_url:str=''; model:str=''; token:str=field(default='',repr=False); timeout:float=30
 json_mode:bool|None=None; extra_body:dict|None=field(default=None,repr=False); max_tokens:int=4096
 @classmethod
 def from_env(cls):
  provider=os.getenv('MODEL_PROVIDER','mock').strip().lower()
  try:
   timeout=float(os.getenv('MODEL_TIMEOUT_SECONDS','30'))
   max_tokens=int(os.getenv('MODEL_MAX_TOKENS','4096'))
   if not math.isfinite(timeout) or timeout<=0 or max_tokens<=0: raise ValueError
  except (ValueError,OverflowError):
   raise AdapterError('MODEL_TIMEOUT_SECONDS 必须为正有限数值，MODEL_MAX_TOKENS 必须为正整数',code='model_configuration_invalid') from None
  mode=os.getenv('LLM_JSON_MODE')
  if mode is not None:
   mode=mode.strip().lower()
   if mode not in {'true','false','1','0','on','off'}:
    raise AdapterError('LLM_JSON_MODE 必须为 true 或 false',code='model_configuration_invalid')
  json_mode=None if mode is None else mode in {'true','1','on'}
  try:
   extra_body=parse_extra_body(os.environ['LLM_EXTRA_BODY_JSON']) if 'LLM_EXTRA_BODY_JSON' in os.environ else None
  except ModelClientError as error:
   raise AdapterError(str(error),code='model_configuration_invalid') from None
  options={'timeout':timeout,'json_mode':json_mode,'extra_body':extra_body,'max_tokens':max_tokens}
  if provider in {'openai_compatible','openai','custom'}:
   return cls(provider,os.getenv('LLM_BASE_URL',''),os.getenv('LLM_MODEL',''),os.getenv('LLM_API_KEY',''),**options)
  if provider in {'deepseek','deepseek-ai'}:
   return cls(provider,os.getenv('DEEPSEEK_BASE_URL','https://api.deepseek.com/v1'),os.getenv('DEEPSEEK_MODEL','deepseek-chat'),os.getenv('DEEPSEEK_API_KEY',''),**options)
  return cls(provider,os.getenv('MODELSCOPE_BASE_URL','https://api-inference.modelscope.cn/v1'),os.getenv('MODELSCOPE_MODEL',''),os.getenv('MODELSCOPE_ACCESS_TOKEN',os.getenv('MODELSCOPE_TOKEN','')),**options)
class OpenAICompatibleProvider:
 token_env='LLM_API_KEY'; model_env='LLM_MODEL'; default_json_mode=False; default_base_url=''
 def __init__(self,c):
  if not c.token: raise AdapterError('未配置 '+self.token_env,code='model_configuration_invalid')
  if not c.model: raise AdapterError('未配置 '+self.model_env,code='model_configuration_invalid')
  self.c=c
  try:
   self.client=ChatCompletionsClient(base_url=c.base_url or self.default_base_url,model=c.model,api_key=c.token,timeout=c.timeout,
    json_mode=self.default_json_mode if c.json_mode is None else c.json_mode,
    extra_body=c.extra_body,max_tokens=c.max_tokens,trial_provider=c.provider)
  except ModelClientError as error:
   raise AdapterError(str(error),code='model_configuration_invalid') from None
 def complete_json(self,system_prompt,payload):
  try: return self.client.complete_json(system_prompt,payload)
  except ModelClientError as error: raise AdapterError(str(error),code=error.code,status=error.status) from None
class ModelScopeProvider(OpenAICompatibleProvider):
 token_env='MODELSCOPE_ACCESS_TOKEN'; model_env='MODELSCOPE_MODEL'; default_base_url='https://api-inference.modelscope.cn/v1'
class DeepSeekProvider(OpenAICompatibleProvider):
 token_env='DEEPSEEK_API_KEY'; model_env='DEEPSEEK_MODEL'; default_json_mode=True; default_base_url='https://api.deepseek.com/v1'
# VERSION is the sole human-readable version source; the digest identifies the
# exact system/task/schema/template bytes sent to the provider.
PROMPT_VERSION=(ROOT/'prompts/VERSION').read_text(encoding='utf-8').strip()
if not re.fullmatch(r'prompt-v\d+\.\d+',PROMPT_VERSION):
 raise AdapterError('prompts/VERSION 格式错误')
SYSTEM_PROMPT=(ROOT/'prompts/01-系统提示词.md').read_text(encoding='utf-8')
TASK_PROMPT=(ROOT/'prompts/02-事件整理任务提示词.md').read_text(encoding='utf-8')
SCHEMA_TEXT=json.dumps(SCHEMA,ensure_ascii=False,separators=(',',':'))
FOLLOW_UP_TEMPLATES=(
 '请补充发生时间和可核验证据。',
 '请核对这条记录是否准确。',
 '请由医生或药师核对用药记录。',
 '请核对双方记录的原话、来源和发生时间。',
 DANGER_REMINDER,
)
def build_prompt():
 return (f'提示词版本：{PROMPT_VERSION}\n'+SYSTEM_PROMPT+'\n\n'+TASK_PROMPT
         +'\n\nfollow_up_questions 只能为空数组或选用以下完整句子，不得自由补写：\n'
         +json.dumps(FOLLOW_UP_TEMPLATES,ensure_ascii=False)
         +'\n\n输出必须严格符合以下 JSON Schema：\n'+SCHEMA_TEXT)
PROMPT_SHA256=hashlib.sha256(build_prompt().encode('utf-8')).hexdigest()
def payload_sha256(payload):
 return hashlib.sha256(json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()
def _history_records(payload):
 hs=payload.get('history') or payload.get('history_events') or []
 return hs if isinstance(hs,list) else []
def _source_records(payload):
 """Bind each immutable record ID to its raw evidence and supplied source.

 Summaries, quotes and old model drafts are not new primary evidence. Missing
 source metadata remains unknown; even a clinician mentioned in raw text cannot
 promote that record to clinician_evidence.
 """
 records={}
 for row in [payload]+_history_records(payload):
  if not isinstance(row,dict): continue
  rid=row.get('record_id') or row.get('id')
  if not isinstance(rid,str) or not rid: continue
  raw=row.get('raw_text')
  if raw is None: raw=row.get('text')  # legacy plain-text history input
  if not isinstance(raw,str) or not raw.strip(): continue
  src=row.get('source_kind','unknown')
  if src not in ALLOWED_SOURCE_KINDS: src='unknown'
  evidence={'raw_text':raw,'source_kind':src}
  if rid in records and records[rid]!=evidence:
   raise AdapterError('同一 record_id 对应不同原文或来源，拒绝歧义证据。')
  records[rid]=evidence
 return records

# A literal substring can reverse the meaning through numeric truncation,
# dropped negation, cross-sentence attribution or quoted bad advice. Until a
# semantic excerpt verifier is validated, the MVP preserves each full record.
def _grounded_excerpt(excerpt,source):
 return isinstance(excerpt,str) and bool(excerpt.strip()) and excerpt.strip()==source.strip()

def _overreach(text):
 normalized=unicodedata.normalize('NFKC',text)
 normalized=re.sub(r'[\s\u200b-\u200f\ufeff]', '', normalized)
 return bool(re.search(
  r'诊断为|确诊为|确诊|就是(?:心梗|脑梗|卒中)|患有|'
  r'(?:建议|可以|应该|应当|请|直接|自行|马上|立即|先).{0,10}(?:停药|加药|减药|换药|停用|停服|加倍|减半|加量|减量|增加.{0,4}剂量|减少.{0,4}剂量|调整.{0,4}剂量)|'
  r'(?:药量|剂量).{0,8}(?:加倍|翻倍|减半|改为|调整为)|'
  r'(?:不用|无需|不需要|不必|无需再).{0,6}(?:就医|去医院|急救|120|看医生)|'
  r'没有.{0,3}危险|没事|排除.{0,5}(?:心梗|脑梗|卒中)|替代医生',normalized))
def validate_output(out,raw,payload=None):
 payload=payload or {'raw_text':raw}
 if Draft202012Validator is None: _validation_error('缺少 jsonschema 依赖，拒绝接受模型输出；请先安装并固定版本。','model_schema_invalid')
 es=sorted(Draft202012Validator(SCHEMA).iter_errors(out),key=lambda e:list(e.path))
 if es: _validation_error('Schema 校验失败: '+es[0].message,'model_schema_invalid')
 if out.get('provenance_preserved') is not True or out.get('plan_change_allowed') is not False: _validation_error('安全字段不满足硬规则','model_safety_invalid')
 if out.get('forbidden_actions'): _validation_error('模型报告禁行动，拒绝接受草稿。','model_safety_invalid')
 records=_source_records(payload)
 # Raw quotations remain attributed data. No ungrounded medical facts may enter
 # the summary/claims; follow-up language is restricted to neutral templates.
 summary=out['summary']
 if not _grounded_excerpt(summary,raw):
  if _overreach(summary): _validation_error('模型输出触发越权拦截','model_safety_invalid')
  _validation_error('summary 必须保留当前完整原文，不得截取或改写。','model_grounding_invalid')
 for question in out.get('follow_up_questions') or []:
  if question not in FOLLOW_UP_TEMPLATES:
   if _overreach(question): _validation_error('模型输出触发越权拦截','model_safety_invalid')
   _validation_error('follow_up_questions 只能使用已审阅的中性模板。','model_followup_invalid')
 for claim in out.get('claims') or []:
  rid=claim['record_id']
  if rid not in records: _validation_error('claim.record_id 不属于当前记录或后端原始历史证据。','model_evidence_invalid')
  evidence=records[rid]
  if claim['source_kind']!=evidence['source_kind']:
   _validation_error('claim.source_kind 必须与该 record_id 的原始来源一致。','model_source_invalid')
  quote=claim['quote']
  if not _grounded_excerpt(quote,evidence['raw_text']):
   _validation_error('claim.quote 必须保留该 record_id 的完整非空原文。','model_grounding_invalid')
  if claim['text']!=quote:
   _validation_error('claim.text 必须等于已验证的 claim.quote，禁止补写事实。','model_grounding_invalid')
 if payload.get('record_id') not in {claim['record_id'] for claim in out['claims']}:
  _validation_error('claims 必须包含当前记录的原始证据。','model_evidence_invalid')
 conflict=out['conflict']; refs=conflict['record_refs']
 if len(refs)!=len(set(refs)) or any(ref not in records for ref in refs):
  _validation_error('conflict.record_refs 必须为真实原始记录 ID 且不得重复。','model_conflict_invalid')
 if conflict['present']:
  if len(refs)<2 or payload.get('record_id') not in refs:
   _validation_error('冲突必须引用当前记录及至少另一条原始记录。','model_conflict_invalid')
 elif refs:
  _validation_error('conflict.present=false 时 record_refs 必须为空。','model_conflict_invalid')
 # 原文里的日期可能属于他人或假设事件，不能仅凭子串命中归给当前事件。
 # 当前 MVP 只沿用后端 supplied 时间；没有 supplied 时保留原话，不推断。
 occurred=out.get('time',{}).get('occurred'); supplied=payload.get('occurred_time')
 if occurred is not None and supplied is None:
  _validation_error('time.occurred 没有后端提供的 occurred_time，必须为 null。','model_time_invalid')
 if occurred is None and out['time']['certainty'] in {'exact','range','daypart'}:
  _validation_error('time.occurred 为 null 时不能声称确定的时间精度。','model_time_invalid')
 if supplied is not None and occurred not in {supplied,str(supplied)}:
  _validation_error('time.occurred 必须沿用后端提供的 occurred_time。','model_time_invalid')
 recorded=out.get('time',{}).get('recorded'); server_recorded=payload.get('recorded_at')
 if server_recorded and recorded != server_recorded:
  _validation_error('time.recorded 必须使用后端 recorded_at。','model_time_invalid')
 if danger(raw) and (out.get('escalation_level')!='emergency' or out.get('review_role')!='emergency_services'): _validation_error('危险输入必须升级为 emergency_services','model_safety_invalid')
 if out.get('review_required') is not True: _validation_error('医疗交接输出必须 review_required=true','model_safety_invalid')
 if out['review_role']=='none': _validation_error('待核实医疗记录必须指定复核角色。','model_safety_invalid')
 if out['escalation_level']=='emergency' and out['review_role']!='emergency_services':
  _validation_error('emergency 升级必须指定 emergency_services，不能绕过复核。','model_safety_invalid')
 if (out.get('event_kind') in {'medication','instruction'} or medication_review_required(raw)) and out.get('review_role')!='clinician_or_pharmacist' and out.get('escalation_level')!='emergency': _validation_error('用药/医嘱事件必须交由 clinician_or_pharmacist 复核','model_safety_invalid')
 if scan_danger(raw).get('clinical_review_required') and out['review_role'] not in {'clinician_or_pharmacist','emergency_services'}:
  _validation_error('测量候选须保留专业复核要求。','model_safety_invalid')
 return out
def apply_safety_guard(out,raw):
 if not isinstance(out,dict): raise AdapterError('模型输出必须为 JSON 对象')
 safety=scan_danger(raw)
 if not safety['danger_detected']:
  if not safety.get('clinical_review_required'): return out,False
  fixed=dict(out)
  fixed['review_required']=True
  # Preserve stronger model escalation; this candidate does not establish an
  # emergency and cannot grant treatment or confirmation authority.
  fixed['review_role']='emergency_services' if out.get('escalation_level')=='emergency' else 'clinician_or_pharmacist'
  return fixed,fixed!=out
 fixed=dict(out)
 fixed['escalation_level']='emergency'; fixed['review_role']='emergency_services'; fixed['review_required']=True; fixed['plan_change_allowed']=False
 qs=out.get('follow_up_questions',[])
 if not isinstance(qs,list): raise AdapterError('follow_up_questions 必须为数组')
 fixed['follow_up_questions']=[DANGER_REMINDER]+[q for q in qs if q!=DANGER_REMINDER][:4]
 return fixed,fixed!=out
def provider_from(c=None):
 c=c or Config.from_env()
 if c.provider=='mock':return MockProvider()
 if c.provider in {'modelscope','魔搭'}:return ModelScopeProvider(c)
 if c.provider in {'deepseek','deepseek-ai'}:return DeepSeekProvider(c)
 if c.provider in {'openai_compatible','openai','custom'}:return OpenAICompatibleProvider(c)
 raise AdapterError('不支持的 MODEL_PROVIDER')
def organize_event(payload,provider=None):
 if not isinstance(payload,dict) or not str(payload.get('raw_text','')).strip():raise AdapterError('raw_text 不能为空')
 if any(document_needs_review(row) for row in [payload]+_history_records(payload) if isinstance(row,dict)):
  _validation_error('资料文字必须先对照原件核对。','document_source_review_required')
 raw=str(payload['raw_text']); safety=scan_danger(raw)  # Always before provider selection/network.
 start=time.perf_counter(); p=provider or provider_from()
 model_out=p.complete_json(build_prompt(),payload)
 out,guard=apply_safety_guard(model_out,raw); out=validate_output(out,raw,payload)
 return {'ok':True,'ai_failed':False,'trace_id':new_id('tr'),'provider':type(p).__name__,'prompt_version':PROMPT_VERSION,'prompt_sha256':PROMPT_SHA256,'input_sha256':payload_sha256(payload),'model_id':(getattr(getattr(p,'c',None),'model',None) or ('mock-v1' if isinstance(p,MockProvider) else 'unknown')),'schema_version':SCHEMA_VERSION,'latency_ms':round((time.perf_counter()-start)*1000,2),'safety_guard_applied':guard,'output':out,'local_safety':safety,**safety}
