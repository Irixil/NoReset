from __future__ import annotations
import json, os, secrets, mimetypes, hashlib, re, tempfile
from email.parser import BytesParser
from email.policy import default as email_policy
from dataclasses import asdict, is_dataclass
from urllib.error import URLError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote
from pathlib import Path
try:
 from .adapter import AdapterError, Config, organize_event, PROMPT_VERSION, SCHEMA_VERSION, PROMPT_SHA256, payload_sha256
 from .conversation import ConversationError, conversation_turn, payload_sha256 as conversation_payload_sha256
 from . import app_access, cloud_backup
 from .ai_limits import AIRequestLimiter
 from .capabilities import local_first_capabilities
 from .media_backend import create_default_media_backend
 from .media_store import MediaStoreError
 from .recognition import RecognitionError, recognize_file
 from .safety import scan_danger, document_needs_review, reviewed_risk_manifest
 from .store import SQLiteStore, StoreError, NotFound, Conflict, Unauthorized, Forbidden, expected_version
except ImportError:
 from adapter import AdapterError, Config, organize_event, PROMPT_VERSION, SCHEMA_VERSION, PROMPT_SHA256, payload_sha256
 from conversation import ConversationError, conversation_turn, payload_sha256 as conversation_payload_sha256
 import app_access, cloud_backup
 from ai_limits import AIRequestLimiter
 from capabilities import local_first_capabilities
 from media_backend import create_default_media_backend
 from media_store import MediaStoreError
 from recognition import RecognitionError, recognize_file
 from safety import scan_danger, document_needs_review, reviewed_risk_manifest
 from store import SQLiteStore, StoreError, NotFound, Conflict, Unauthorized, Forbidden, expected_version
ROOT=Path(__file__).resolve().parents[1]
# The elder UI is plain HTML/JS; serve its source when no optional build exists.
STATIC=(ROOT/'frontend'/'dist' if (ROOT/'frontend'/'dist'/'index.html').is_file() else ROOT/'frontend').resolve()
SESSION_TOKEN=secrets.token_urlsafe(24)
DB_PATH=os.getenv('DB_PATH',os.getenv('API_DB_PATH',str(ROOT/'runtime'/'records.sqlite3')))
# The hosted local-first application must not create a shadow health database.
# Legacy development mode keeps the existing SQLite behavior and test surface.
STORE=None if app_access.local_first_enabled() else SQLiteStore(DB_PATH)
ALLOWED_ORIGIN=os.getenv('ALLOWED_ORIGIN','')
MAX_MEDIA_REQUEST_BYTES=int(os.getenv('MEDIA_REQUEST_MAX_BYTES','0') or '0')
MEDIA_ROOT=os.getenv('MEDIA_ROOT',str(ROOT/'runtime'/'media'))
MEDIA_BACKEND=None if app_access.local_first_enabled() else create_default_media_backend(STORE,root=MEDIA_ROOT)
AI_REQUEST_LIMITER=AIRequestLimiter()

_SAFE_MEDIA_ID=re.compile(r'^(?:media|upload)_[A-Za-z0-9_-]+$')

def _allowed_origin():
 return os.getenv('ALLOWED_ORIGIN',ALLOWED_ORIGIN).strip().rstrip('/')

def _public_value(value):
 if is_dataclass(value):return asdict(value)
 if isinstance(value,dict):return {k:_public_value(v) for k,v in value.items() if 'path' not in k.lower()}
 if isinstance(value,(list,tuple)):return [_public_value(v) for v in value]
 return value

def _safe_media_id(value,prefix):
 return isinstance(value,str) and value.startswith(prefix+'_') and _SAFE_MEDIA_ID.fullmatch(value) is not None

def _media_error_status(error):
 code=getattr(error,'code',str(error))
 if code in {'limit_exceeded','request_too_large'}:return 413
 if code=='media_limits_not_configured':return 503
 if code in {'invalid_media','integrity_mismatch'}:return 422
 if code in {'storage_failed','storage_corrupt','unsafe_storage'}:return 500
 if code in {'unsupported_format','content_type_kind_mismatch'}:return 415
 if code in {'media_not_found','upload_not_found'}:return 404
 if code in {'idempotency_key_payload_mismatch','upload_conflict','upload_incomplete','upload_completed','stale_version'}:return 409
 return getattr(error,'status',400)

def _media_error_code(error):
 code=getattr(error,'code',str(error))
 known={
  'limit_exceeded','request_too_large','unsupported_format','content_type_kind_mismatch',
  'media_not_found','upload_not_found','idempotency_key_payload_mismatch','upload_conflict',
  'upload_incomplete','upload_completed','stale_version','idempotency_key_required',
  'invalid_media','invalid_upload','invalid_part','integrity_mismatch','provider_timeout',
  'provider_unavailable','provider_not_configured','provider_auth_failed',
  'provider_rate_limited','invalid_provider_response','no_text_detected','storage_failed',
  'storage_corrupt','unsafe_storage','media_limits_not_configured','invalid_range',
 }
 return code if code in known else 'media_request_failed'

def _positive_env(name):
 value=os.getenv(name)
 return int(value) if value and value.isdigit() and int(value)>0 else None

def _media_capabilities():
 enabled=all(_positive_env(name) is not None for name in (
   'MEDIA_UPLOAD_MAX_BYTES','MEDIA_UPLOAD_PART_MAX_BYTES','MEDIA_UPLOAD_MAX_PARTS',
  ))
 return {
  'enabled': enabled,
  'disabled_reason': None if enabled else 'media_limits_not_configured',
  'max_total_bytes': _positive_env('MEDIA_UPLOAD_MAX_BYTES'),
  'max_part_bytes': _positive_env('MEDIA_UPLOAD_PART_MAX_BYTES'),
  'max_parts': _positive_env('MEDIA_UPLOAD_MAX_PARTS'),
  'max_audio_duration_seconds': None,
  'max_image_pixels': None,
  'audio_content_types': ['audio/aac','audio/flac','audio/m4a','audio/mp3','audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/webm','audio/x-m4a','audio/x-wav'],
  'image_content_types': ['image/gif','image/jpeg','image/png','image/tiff','image/webp'],
  'multipart_upload': True,
  'resumable_parts': True,
 }

def _media_limits():
 limits=_media_capabilities()
 if not limits['enabled']:
  limits['disabled_reason']='media_limits_not_configured'
 return limits
def request_actor(b):
 if 'actor_name' not in b:return '本地用户'
 actor=b['actor_name']
 if not isinstance(actor,str) or not actor.strip():raise StoreError('actor_name_required')
 if len(actor)>80:raise StoreError('actor_name_too_long')
 return actor
def model_evidence(event):
 # Only original evidence crosses the model boundary. Prior drafts, audit
 # notes, review state and model output must never become new source facts.
 return {key:event.get(key) for key in ('record_id','raw_text','source_kind','recorded_at','occurred_time')} | ({'source_review':event.get('source_review')} if event.get('source_kind')=='document' else {})

def configured_model_metadata():
 try:
  config=Config.from_env()
  return {'provider':config.provider,'model_id':'mock-v1' if config.provider=='mock' else config.model or None}
 except (ValueError,TypeError):
  return {'provider':None,'model_id':None}

def _mock_text_provider():
 try:return Config.from_env().provider=='mock'
 except (AdapterError,ValueError,TypeError):return False

def model_failure_details(error):
 # Use known codes, never a remote message/body, URL or arbitrary error field.
 messages={'model_timeout':'模型超时','model_network_error':'网络连接失败',
           'model_configuration_invalid':'模型配置无效','model_redirect_rejected':'模型地址返回重定向，已拒绝转发',
           'model_response_too_large':'模型响应超过大小限制','model_output_truncated':'模型输出被截断',
           'model_response_invalid':'模型返回内容格式无效','model_http_error':'模型服务请求失败',
           'model_account_binding_required':'魔搭账号需先绑定阿里云账号'}
 code=error.code if isinstance(error,AdapterError) and type(error.code) is str and error.code in messages else None
 status=error.status if isinstance(error,AdapterError) and code in {'model_http_error','model_account_binding_required'} and type(error.status)==int and 100<=error.status<=599 else None
 if code:
  reason=messages[code]
  if code=='model_http_error' and status in (401,403): reason='模型服务鉴权或访问权限失败'
  elif code=='model_http_error' and status==429: reason='模型服务限流或额度不足'
  return {'failure_reason':reason,'failure_code':code,**({'provider_http_status':status} if status is not None else {})}
 cause=error.__cause__ or error
 reason=('模型超时' if isinstance(cause,TimeoutError) else '模型返回非法 JSON' if isinstance(cause,json.JSONDecodeError) else '网络连接失败' if isinstance(cause,URLError) else '模型调用失败或返回内容未通过校验')
 return {'failure_reason':reason}

def local_first_model_evidence(body):
 raw=body.get('raw_text')
 if not isinstance(raw,str) or not raw.strip():raise StoreError('raw_text_required')
 if len(raw)>10000:raise StoreError('raw_text_too_long')
 record_id=body.get('record_id')
 if not isinstance(record_id,str) or not re.fullmatch(r'rec_[A-Za-z0-9_-]{8,100}',record_id):raise StoreError('record_id_invalid')
 source_kind=body.get('source_kind','elder')
 if source_kind not in {'elder','family_observation','family_report','caregiver','clinician_evidence','document','audio_transcript','system','unknown'}:raise StoreError('invalid_source_kind')
 if document_needs_review(body):raise Conflict('document_source_review_required')
 history=body.get('history') or []
 if not isinstance(history,list) or len(history)>20:raise StoreError('history_invalid')
 clean_history=[]
 for item in history:
  if not isinstance(item,dict):raise StoreError('history_invalid')
  history_id=item.get('record_id');history_text=item.get('raw_text')
  if not isinstance(history_id,str) or not re.fullmatch(r'rec_[A-Za-z0-9_-]{8,100}',history_id):raise StoreError('history_invalid')
  if not isinstance(history_text,str) or not history_text.strip() or len(history_text)>10000:raise StoreError('history_invalid')
  if document_needs_review(item):raise Conflict('document_source_review_required')
  clean_history.append({'record_id':history_id,'raw_text':history_text,'source_kind':item.get('source_kind','unknown'),'source_review':item.get('source_review'),'recorded_at':item.get('recorded_at'),'occurred_time':item.get('occurred_time')})
 return {'record_id':record_id,'raw_text':raw,'source_kind':source_kind,'source_review':body.get('source_review'),'recorded_at':body.get('recorded_at'),'occurred_time':body.get('occurred_time'),'history':clean_history}

class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a): pass
 def origin_allowed(self):
  origin=self.headers.get('Origin','').strip().rstrip('/')
  if not origin:return True
  allowed=_allowed_origin()
  if allowed:return origin==allowed
  if app_access.local_first_enabled():return False
  return origin==('http://'+self.headers.get('Host','')).rstrip('/')
 def end_headers(self):
  o=self.headers.get('Origin','').strip().rstrip('/')
  if o and self.origin_allowed():
   self.send_header('Access-Control-Allow-Origin',o);self.send_header('Access-Control-Allow-Credentials','true');self.send_header('Vary','Origin')
  self.send_header('Cache-Control','no-store');super().end_headers()
 def send_json(self,code,p,extra_headers=None):
  b=json.dumps(p,ensure_ascii=False).encode();self.send_response(code);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(b)))
  for name,value in (extra_headers or {}).items():self.send_header(name,value)
  self.end_headers();self.wfile.write(b)
 def send_bytes(self,code,payload,content_type,extra_headers=None):
  self.send_response(code);self.send_header('Content-Type',content_type);self.send_header('Content-Length',str(len(payload)))
  for name,value in (extra_headers or {}).items():self.send_header(name,value)
  self.end_headers();self.wfile.write(payload)
 def body(self):
  n=int(self.headers.get('Content-Length','0'))
  if n>1_000_000: raise StoreError('body_too_large')
  x=json.loads(self.rfile.read(n).decode() or '{}')
  if not isinstance(x,dict): raise StoreError('body_must_object')
  return x
 def media_body(self,request_limit=None):
  try:n=int(self.headers.get('Content-Length',''))
  except ValueError:raise StoreError('invalid_content_length') from None
  if n<1:raise StoreError('body_required')
  request_limit = request_limit or MAX_MEDIA_REQUEST_BYTES or _media_limits().get('max_total_bytes')
  if request_limit is not None and n>request_limit:
   e=StoreError('request_too_large');e.status=413;raise e
  content_type=self.headers.get('Content-Type','')
  if not content_type.lower().startswith('multipart/form-data;'):
   e=StoreError('unsupported_format');e.status=415;raise e
  raw=self.rfile.read(n)
  if len(raw)!=n:raise StoreError('incomplete_request_body')
  try:
   message=BytesParser(policy=email_policy).parsebytes(
    b'Content-Type: '+content_type.encode('ascii')+b'\r\nMIME-Version: 1.0\r\n\r\n'+raw
   )
  except (UnicodeEncodeError,ValueError):raise StoreError('invalid_multipart_payload') from None
  if not message.is_multipart():raise StoreError('invalid_multipart_payload')
  fields={};files={}
  for part in message.iter_parts():
   name=part.get_param('name',header='content-disposition')
   if not name or name in fields or name in files:raise StoreError('invalid_multipart_payload')
   payload=part.get_payload(decode=True)
   if not isinstance(payload,bytes):raise StoreError('invalid_multipart_payload')
   filename=part.get_filename()
   if filename is None:
    try:fields[name]=payload.decode('utf-8')
    except UnicodeDecodeError:raise StoreError('invalid_multipart_payload') from None
   else:files[name]={'filename':filename,'content_type':part.get_content_type(),'data':payload}
  return fields,files
 def media_backend(self):
  if MEDIA_BACKEND is None:raise StoreError('media_backend_unavailable')
  return MEDIA_BACKEND
 def media_write_enabled(self):
  if not _media_limits()['enabled']:
   error=StoreError('media_limits_not_configured');error.status=503;raise error
 def media_read_allowed(self):
  auth_token=self.headers.get('X-Auth-Token')
  if auth_token:return self._auth_ctx() is not None
  return self.headers.get('X-Session-Token')==SESSION_TOKEN
 def _require_ai_access(self,limit=False):
  origin=self.headers.get('Origin','').strip().rstrip('/')
  expected=_allowed_origin()
  if not expected or not origin or origin!=expected:return None,(403,'origin_rejected',{})
  if not app_access.session_configured():return None,(503,'access_not_configured',{})
  cookie=self.headers.get('Cookie')
  session=app_access.parse_session(cookie)
  if session is None:return None,(401,'authentication_required',{})
  if app_access.request_authorized(cookie,self.headers.get('X-CSRF-Token'),write=True) is None:
   return None,(403,'csrf_invalid',{})
  key=hashlib.sha256(session.csrf.encode('utf-8')).hexdigest()
  if limit:
   retry_after=AI_REQUEST_LIMITER.acquire(key)
   if retry_after is not None:return None,(429,'ai_rate_limited',{'Retry-After':str(retry_after),'X-AI-Limit-Scope':'process'})
   self._ai_rate_session=key
  return session,None
 def csrf(self):
  if self.command=='GET': return True
  path=urlparse(self.path).path
  if app_access.local_first_enabled():
   if path.startswith('/api/ai/'):
    _,rejection=self._require_ai_access(limit=True)
    self._request_rejection=rejection
    return rejection is None
   if not self.origin_allowed():return False
   if path in {'/api/app/login','/api/app/device/activate'}:return True
   if path=='/api/app/logout' or path.startswith('/api/backups/'):
    return app_access.request_authorized(self.headers.get('Cookie'),self.headers.get('X-CSRF-Token'),write=True) is not None
   return False
  if path in ('/api/auth/households','/api/auth/login'): return True
  # New account sessions use X-Auth-Token; retain legacy local token for v4 UI.
  if self.headers.get('X-Auth-Token'): return True
  if self.headers.get('X-Session-Token')!=SESSION_TOKEN:return False
  o=self.headers.get('Origin',''); expected=ALLOWED_ORIGIN or ('http://'+self.headers.get('Host',''))
  return not o or o==expected
 def backup_credentials(self):
  values=(self.headers.get('X-Faas-Access-Key-Id'),self.headers.get('X-Faas-Secret-Access-Key'),self.headers.get('X-Faas-Session-Token'))
  return cloud_backup.RequestCredentials(*values) if all(values) else None
 def _auth_ctx(self, permission=None, household_id=None):
  token=self.headers.get('X-Auth-Token')
  if not token:return None
  try:return STORE.authorize(token, permission, household_id) if permission else STORE.authenticate(token)
  except StoreError: return None
 def do_OPTIONS(self):
  if not self.origin_allowed():return self.send_json(403,{'ok':False,'error':'origin_rejected'})
  self.send_response(204);self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS');self.send_header('Access-Control-Allow-Headers','Content-Type, Idempotency-Key, X-Session-Token, X-Auth-Token, X-CSRF-Token, Range');self.send_header('Access-Control-Max-Age','600');self.end_headers()
 def do_GET(self):
  try:return self._do_GET()
  except StoreError as e:return self.send_json(e.status,{'ok':False,'error':str(e)})
  except MediaStoreError as e:return self.send_json(_media_error_status(e),{'ok':False,'error':_media_error_code(e)})
  except Exception:return self.send_json(500,{'ok':False,'error':'internal_server_error'})
 def _do_GET(self):
  p=unquote(urlparse(self.path).path)
  if app_access.local_first_enabled() and p.startswith('/api/ai/'):
   _,rejection=self._require_ai_access(limit=False)
   if rejection:return self.send_json(rejection[0],{'ok':False,'error':rejection[1]},rejection[2])
  if app_access.local_first_enabled() and p.startswith('/api/') and not self.origin_allowed():return self.send_json(403,{'ok':False,'error':'origin_rejected'})
  if app_access.local_first_enabled() and p=='/':return self.send_json(200,{'ok':True,'service':'bingli-beta-api','kind':'api','frontend_hosted':False})
  if p=='/api/app/config':
   if not app_access.local_first_enabled():return self.send_json(404,{'ok':False,'error':'not_found'})
   return self.send_json(200,{'ok':True,'mode':'local_first','access_configured':app_access.session_configured(),'cloud_backup_configured':cloud_backup.configured(),'product_name':'NoReset·内测版','data_location':'this_device','backup_mode':'encrypted_archive','reviewed_risk_rules':reviewed_risk_manifest(),**local_first_capabilities()})
  if p=='/api/app/session':
   if not app_access.local_first_enabled():return self.send_json(404,{'ok':False,'error':'not_found'})
   session=app_access.request_authorized(self.headers.get('Cookie'),write=False)
   if session is None and app_access.loopback_auto_bind_allowed(self.client_address[0],self.headers.get('Origin'),_allowed_origin()):
    session,cookie,ttl=app_access.issue_device_session()
    return self.send_json(200,{'ok':True,'authenticated':True,'csrf_token':session.csrf,'expires_at':session.expires_at,'binding':'loopback_development'},{'Set-Cookie':app_access.cookie_header(cookie,max_age=ttl)})
   return self.send_json(200,{'ok':True,'authenticated':session is not None,**({'csrf_token':session.csrf,'expires_at':session.expires_at} if session else {})})
  if p=='/api/backups':
   if not app_access.local_first_enabled():return self.send_json(404,{'ok':False,'error':'not_found'})
   if app_access.request_authorized(self.headers.get('Cookie'),write=False) is None:return self.send_json(401,{'ok':False,'error':'authentication_required'})
   try:return self.send_json(200,{'ok':True,'backups':cloud_backup.list_backups(credentials=self.backup_credentials())})
   except cloud_backup.CloudBackupError as e:return self.send_json(e.status,{'ok':False,'error':e.code})
  if p=='/api/media/capabilities':
   if app_access.local_first_enabled():return self.send_json(404,{'ok':False,'error':'legacy_api_disabled'})
   return self.send_json(200,{'ok':True,'capabilities':_media_capabilities()})
  if p=='/health':
   c=Config.from_env()
   if app_access.local_first_enabled():return self.send_json(200,{'ok':True,'service':'bingli-beta','provider':c.provider,'storage':'encrypted_on_device','mode':'local_first','schema_version':SCHEMA_VERSION,'access_configured':app_access.session_configured()})
   return self.send_json(200,{'ok':True,'service':'medical-handoff-p0','provider':c.provider,'storage':'sqlite','mode':'local_single_household','schema_version':SCHEMA_VERSION,'session_token':SESSION_TOKEN})
  if app_access.local_first_enabled() and p.startswith('/api/'):
   return self.send_json(404,{'ok':False,'error':'legacy_api_disabled'})
  if p=='/api/events':
   ctx=self._auth_ctx()
   if self.headers.get('X-Auth-Token') and ctx is None:
    return self.send_json(401,{'ok':False,'error':'invalid_session'})
   return self.send_json(200,{'ok':True,'events':STORE.list(ctx['household_id'] if ctx else None)})
  if p=='/api/media' or p.startswith('/api/media/'):
   if not self.media_read_allowed():return self.send_json(403,{'ok':False,'error':'csrf_or_origin_rejected'})
   backend=self.media_backend();ctx=self._auth_ctx();household_id=ctx['household_id'] if ctx else None
   if p=='/api/media':return self.send_json(200,{'ok':True,'media':_public_value(backend.list_media(household_id))})
   parts=p.strip('/').split('/')
   if len(parts) not in {3,4} or parts[:2]!=['api','media'] or not _safe_media_id(parts[2],'media'):
    return self.send_json(404,{'ok':False,'error':'not_found'})
   media_id=parts[2]
   media=backend.get_media(media_id,household_id)
   if not media:raise NotFound('media_not_found')
   if len(parts)==3:return self.send_json(200,{'ok':True,'media':_public_value(media)})
   if parts[3]!='original':return self.send_json(404,{'ok':False,'error':'not_found'})
   with backend.open_original(media_id,household_id) as original:
    payload=original.read()
   content_type=_public_value(media).get('content_type') or 'application/octet-stream'
   total=len(payload);headers={'Accept-Ranges':'bytes'};range_header=self.headers.get('Range')
   if range_header:
    match=re.fullmatch(r'bytes=(\d*)-(\d*)',range_header.strip())
    if not match or (not match.group(1) and not match.group(2)):return self.send_json(416,{'ok':False,'error':'invalid_range'})
    if match.group(1):
     start=int(match.group(1));end=int(match.group(2)) if match.group(2) else total-1
    else:
     length=int(match.group(2));start=max(0,total-length);end=total-1
    if start>=total or end<start:return self.send_json(416,{'ok':False,'error':'invalid_range'})
    end=min(end,total-1);headers['Content-Range']=f'bytes {start}-{end}/{total}'
    return self.send_bytes(206,payload[start:end+1],content_type,headers)
   return self.send_bytes(200,payload,content_type,headers)
  if p=='/api/auth/me':
   try:return self.send_json(200,{'ok':True,'user':STORE.authenticate(self.headers.get('X-Auth-Token'))})
   except StoreError as e:return self.send_json(e.status,{'ok':False,'error':str(e)})
  if p=='/api/auth/members':
   try:
    ctx=STORE.authorize(self.headers.get('X-Auth-Token'),'read'); return self.send_json(200,{'ok':True,'members':STORE.list_members(ctx['household_id'])})
   except StoreError as e:return self.send_json(e.status,{'ok':False,'error':str(e)})
  if p.startswith('/api/events/'):
   z=p.strip('/').split('/');rid=z[2] if len(z)>2 else ''
   try:
    if len(z)==4 and z[3]=='history':
     ctx=self._auth_ctx()
     if self.headers.get('X-Auth-Token') and ctx is None:return self.send_json(401,{'ok':False,'error':'invalid_session'})
     if ctx and not STORE.get(rid,ctx['household_id']): return self.send_json(404,{'ok':False,'error':'event_not_found'})
     h,a=STORE.history(rid);return self.send_json(200,{'ok':True,'history':h,'audit':a})
    if len(z)==3:
     ctx=self._auth_ctx()
     if self.headers.get('X-Auth-Token') and ctx is None:return self.send_json(401,{'ok':False,'error':'invalid_session'})
     e=STORE.get(rid,ctx['household_id'] if ctx else None);return self.send_json(200,{'ok':True,'event':e}) if e else self.send_json(404,{'ok':False,'error':'event_not_found'})
   except StoreError as e:return self.send_json(e.status,{'ok':False,'error':str(e)})
  if p.startswith('/api/handoffs/'):
   try:
    ctx=self._auth_ctx()
    if self.headers.get('X-Auth-Token') and ctx is None:return self.send_json(401,{'ok':False,'error':'invalid_session'})
    handoff=STORE.get_handoff(p.split('/')[-1])
    if ctx and handoff.get('household_id') not in (None,ctx['household_id']):return self.send_json(404,{'ok':False,'error':'handoff_not_found'})
    return self.send_json(200,{'ok':True,'handoff':handoff})
   except StoreError as e:return self.send_json(e.status,{'ok':False,'error':str(e)})
  # Historical mode retains its old same-origin demo. The local-first beta
  # intentionally runs its user-facing frontend as a separate service.
  if not app_access.local_first_enabled() and not p.startswith('/api/'):
   f=(STATIC/('index.html' if p=='/' else p.lstrip('/'))).resolve()
   if STATIC in f.parents and f.suffix.lower() in {'.html','.js','.css','.json','.webmanifest','.svg','.png','.jpg','.ico','.woff2'} and f.is_file():
    b=f.read_bytes();self.send_response(200);self.send_header('Content-Type',mimetypes.guess_type(str(f))[0] or 'application/octet-stream');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b);return
  return self.send_json(404,{'ok':False,'error':'not_found'})
 def do_POST(self):
  self._ai_rate_session=None
  self._request_rejection=None
  try:return self._do_POST()
  finally:
   if self._ai_rate_session is not None:AI_REQUEST_LIMITER.release(self._ai_rate_session)
 def _do_POST(self):
  if not self.csrf():
   rejection=self._request_rejection
   if rejection:return self.send_json(rejection[0],{'ok':False,'error':rejection[1]},rejection[2])
   return self.send_json(403,{'ok':False,'error':'csrf_or_origin_rejected'})
  p=urlparse(self.path).path
  if app_access.local_first_enabled() and p.startswith('/api/') and p not in {'/api/app/login','/api/app/device/activate','/api/app/logout','/api/ai/organize','/api/ai/conversation-turn','/api/backups/upload-grant','/api/backups/download-grant'} and not p.startswith('/api/ai/media/'):
   return self.send_json(404,{'ok':False,'error':'legacy_api_disabled'})
  if p.startswith('/api/media/') and not p.startswith('/api/media/uploads'):
   try:self.media_write_enabled()
   except StoreError as e:return self.send_json(e.status,{'ok':False,'error':str(e)})
  if p=='/api/media/uploads' or p.startswith('/api/media/uploads/'):
   try:return self._do_media_upload_POST(p)
   except Exception as e:
    if isinstance(e,StoreError) or hasattr(e,'code'):
     return self.send_json(_media_error_status(e),{'ok':False,'error':_media_error_code(e)})
    return self.send_json(500,{'ok':False,'error':'internal_server_error'})
  if p=='/api/ai/media/recognize':
   try:return self._do_local_first_media_recognize()
   except (StoreError,MediaStoreError,RecognitionError) as e:
    return self.send_json(_media_error_status(e),{'ok':False,'error':_media_error_code(e),'retryable':bool(getattr(e,'retryable',False))})
   except Exception:return self.send_json(500,{'ok':False,'error':'internal_server_error','retryable':False})
  if p in {'/api/ai/organize','/api/ai/conversation-turn'} and _mock_text_provider():
   return self.send_json(503,{'ok':False,'error':'provider_mock_unavailable','retryable':True})
  try:b=self.body()
  except StoreError as e:return self.send_json(e.status,{'ok':False,'error':str(e)})
  except (json.JSONDecodeError,UnicodeDecodeError,ValueError):return self.send_json(400,{'ok':False,'error':'invalid_json_payload'})
  try:
   if p=='/api/app/login':
    if not app_access.configured():return self.send_json(503,{'ok':False,'error':'access_not_configured'})
    login_id=self.client_address[0]
    if not app_access.login_allowed(login_id):return self.send_json(429,{'ok':False,'error':'login_rate_limited'})
    if not app_access.verify_password(b.get('password')):
     app_access.record_login_result(login_id,False);return self.send_json(401,{'ok':False,'error':'invalid_credentials'})
    app_access.record_login_result(login_id,True)
    session,cookie=app_access.issue_session()
    return self.send_json(200,{'ok':True,'csrf_token':session.csrf,'expires_at':session.expires_at},{'Set-Cookie':app_access.cookie_header(cookie)})
   if p=='/api/app/device/activate':
    if not app_access.session_configured():return self.send_json(503,{'ok':False,'error':'access_not_configured'})
    if not app_access.verify_device_activation(b.get('activation_token')):return self.send_json(401,{'ok':False,'error':'device_activation_invalid'})
    session,cookie,ttl=app_access.issue_device_session()
    return self.send_json(200,{'ok':True,'csrf_token':session.csrf,'expires_at':session.expires_at,'binding':'family_link'},{'Set-Cookie':app_access.cookie_header(cookie,max_age=ttl)})
   if p=='/api/app/logout':
    return self.send_json(200,{'ok':True},{'Set-Cookie':app_access.cookie_header('',clear=True)})
   if p=='/api/backups/upload-grant':
    try:grant=cloud_backup.create_upload_grant(b.get('size'),b.get('sha256'),credentials=self.backup_credentials())
    except cloud_backup.CloudBackupError as e:return self.send_json(e.status,{'ok':False,'error':e.code})
    return self.send_json(201,{'ok':True,'grant':grant})
   if p=='/api/backups/download-grant':
    try:grant=cloud_backup.create_download_grant(b.get('object_key'),credentials=self.backup_credentials())
    except cloud_backup.CloudBackupError as e:return self.send_json(e.status,{'ok':False,'error':e.code})
    return self.send_json(200,{'ok':True,'grant':grant})
   if p=='/api/ai/organize':
    payload=local_first_model_evidence(b)
    safety=scan_danger(payload['raw_text'])
    try:r=organize_event(payload)
    except Exception as ex:
     return self.send_json(422,{'ok':False,'ai_failed':True,'error':'ai_organize_failed','trace_id':'tr_'+secrets.token_hex(16),'raw_text_sha256':hashlib.sha256(payload['raw_text'].encode()).hexdigest(),'input_sha256':payload_sha256(payload),'prompt_version':PROMPT_VERSION,'prompt_sha256':PROMPT_SHA256,'schema_version':SCHEMA_VERSION,'raw_text_preserved_on_device':True,'local_safety':safety,**configured_model_metadata(),**model_failure_details(ex)})
    return self.send_json(200,{'ok':True,'raw_text_preserved_on_device':True,**r})
   if p=='/api/ai/conversation-turn':
    try:r=conversation_turn(b)
    except ConversationError as ex:
     return self.send_json(422,{'ok':False,'ai_failed':True,'error':ex.code,'trace_id':'ctr_'+secrets.token_hex(16),'input_sha256':conversation_payload_sha256(b),'raw_text_preserved_on_device':True,**configured_model_metadata()})
    except Exception as ex:
     return self.send_json(422,{'ok':False,'ai_failed':True,'error':'ai_conversation_failed','trace_id':'ctr_'+secrets.token_hex(16),'input_sha256':conversation_payload_sha256(b),'raw_text_preserved_on_device':True,**configured_model_metadata(),**model_failure_details(ex)})
    return self.send_json(200,{'ok':True,'raw_text_preserved_on_device':True,**r})
   if p=='/api/auth/households':
    result=STORE.create_household(b.get('name'),b.get('display_name'),b.get('role','owner'),b.get('external_key'),b.get('password'))
    login=STORE.login(user_id=result['user_id'],household_id=result['household_id'],password=b.get('password'))
    return self.send_json(201,{'ok':True,'household':result,'session':login})
   if p=='/api/auth/login':
    return self.send_json(200,{'ok':True,'session':STORE.login(b.get('user_id'),b.get('display_name'),b.get('household_id'),password=b.get('password'))})
   if p=='/api/auth/logout':
    token=self.headers.get('X-Auth-Token'); STORE.revoke_session(token); return self.send_json(200,{'ok':True})
   if p=='/api/auth/members':
    ctx=STORE.authorize(self.headers.get('X-Auth-Token'),'manage_members',b.get('household_id'))
    m=STORE.add_member(ctx['household_id'],b.get('display_name'),b.get('role','family'),b.get('external_key'),b.get('password'))
    return self.send_json(201,{'ok':True,'member':m})
   if p=='/api/events':
    actor=request_actor(b)
    for k in ('raw_text','source_kind','actor_name'):
     if not isinstance(b.get(k),str) or not b[k].strip():raise StoreError(k+'_required')
    if len(b['raw_text'])>10000:raise StoreError('raw_text_too_long')
    key=self.headers.get('Idempotency-Key')
    if not key:raise StoreError('idempotency_key_required')
    ctx=self._auth_ctx('create')
    if self.headers.get('X-Auth-Token') and ctx is None:return self.send_json(401,{'ok':False,'error':'invalid_session'})
    e,created=STORE.create(b,key,actor,ctx['household_id'] if ctx else 'hh_local_default');return self.send_json(201 if created else 200,{'ok':True,'created':created,'event':e})
   if p=='/api/handoffs':
    if b:raise StoreError('handoff_body_must_be_empty_object')
    ctx=self._auth_ctx('read')
    if self.headers.get('X-Auth-Token') and ctx is None:return self.send_json(401,{'ok':False,'error':'invalid_session'})
    return self.send_json(201,{'ok':True,'handoff':STORE.handoff(ctx['household_id'] if ctx else None)})
   z=p.strip('/').split('/')
   if len(z)==4 and z[:2]==['api','media'] and z[3]=='recognize':
    self.media_write_enabled()
    if not _safe_media_id(z[2],'media'):return self.send_json(404,{'ok':False,'error':'not_found'})
    key=self.headers.get('Idempotency-Key')
    if not key:raise StoreError('idempotency_key_required')
    ctx=self._auth_ctx('create')
    if self.headers.get('X-Auth-Token') and ctx is None:return self.send_json(401,{'ok':False,'error':'invalid_session'})
    result=self.media_backend().start_recognition(
     z[2],b.get('expected_version'),key,
     actor=request_actor(b),household_id=ctx['household_id'] if ctx else None,
    )
    action = result.get('action')
    status = 200 if action in {'existing', 'resume_link'} and result.get('media', {}).get('recognition_status') == 'succeeded' else 202
    return self.send_json(status,{'ok':True,**_public_value(result)})
   if len(z)==4 and z[:2]==['api','media'] and z[3]=='link':
    self.media_write_enabled()
    if not _safe_media_id(z[2],'media'):return self.send_json(404,{'ok':False,'error':'not_found'})
    key=self.headers.get('Idempotency-Key')
    if not key:raise StoreError('idempotency_key_required')
    ctx=self._auth_ctx('create')
    if self.headers.get('X-Auth-Token') and ctx is None:return self.send_json(401,{'ok':False,'error':'invalid_session'})
    expected=expected_version(b.get('expected_version'))
    result=self.media_backend().link_media(
     z[2],key,expected,actor=request_actor(b),household_id=ctx['household_id'] if ctx else None,
    )
    return self.send_json(201 if result.get('event_created') else 200,{'ok':True,**_public_value(result)})
   if len(z)>=4 and z[:2]==['api','events']:
    actor=request_actor(b)
    ctx=self._auth_ctx();
    if self.headers.get('X-Auth-Token') and ctx is None:return self.send_json(401,{'ok':False,'error':'invalid_session'})
    rid=z[2];e=STORE.get(rid,ctx['household_id'] if ctx else None)
    if not e:raise NotFound('event_not_found')
    if z[3]=='organize':
     if ctx: STORE.authorize(self.headers.get('X-Auth-Token'),'organize',ctx['household_id'])
     expected=expected_version(b.get('expected_version'))
     if e['version']!=expected:raise Conflict('stale_version')
     if document_needs_review(e):raise Conflict('document_source_review_required')
     related=[STORE.get(x) for x in e.get('related_record_ids',[])]; payload={**model_evidence(e),'history':[model_evidence(item) for item in related if not document_needs_review(item) and item['state']!='superseded']}
     safety=e['local_safety']
     try:
      r=organize_event(payload)
     except Exception as ex:
      # Do not expose provider bodies/credentials or misclassify storage/version
      # failures: only the provider+validation call is caught here.
      cause=ex.__cause__ or ex
      failure={'error':'ai_organize_failed','failure_type':type(ex).__name__,'failure_cause_type':type(cause).__name__,'trace_id':'tr_'+secrets.token_hex(16),'raw_text_sha256':hashlib.sha256(e['raw_text'].encode()).hexdigest(),'input_sha256':payload_sha256(payload),'prompt_version':PROMPT_VERSION,'prompt_sha256':PROMPT_SHA256,'schema_version':SCHEMA_VERSION,'raw_text_preserved':True,'local_safety':safety,**configured_model_metadata(),**model_failure_details(ex)}
      STORE.fail(rid,expected,'organize_failed',actor,failure)
      return self.send_json(422,{'ok':False,'ai_failed':True,'record_id':rid,'event':STORE.get(rid),'local_safety':safety,**failure,**safety})
     # The outward notice includes historical positives retained on rule upgrade.
     r.update(local_safety=safety,**safety)
     out=STORE.organize(rid,expected,r,actor)
     return self.send_json(200,{'event':out,'raw_text_preserved':True,**r})
    if z[3]=='source-review':
     if ctx: STORE.authorize(self.headers.get('X-Auth-Token'),'review',ctx['household_id'])
     return self.send_json(200,{'ok':True,'event':STORE.source_review(rid,b.get('expected_version'),b.get('compared_with_original'),actor)})
    if z[3]=='review':
     if ctx: STORE.authorize(self.headers.get('X-Auth-Token'),'review',ctx['household_id'])
     return self.send_json(200,{'ok':True,'event':STORE.review(rid,b.get('expected_version'),b.get('action'),actor,b.get('note'))})
    if z[3]=='revise':
     if ctx: STORE.authorize(self.headers.get('X-Auth-Token'),'revise',ctx['household_id'])
     return self.send_json(201,{'ok':True,'event':STORE.revise(rid,b.get('expected_version'),b,actor)})
  except StoreError as e:return self.send_json(e.status,{'ok':False,'error':str(e)})
  except Exception:return self.send_json(500,{'ok':False,'error':'internal_server_error'})
  return self.send_json(404,{'ok':False,'error':'not_found'})
 def _do_local_first_media_recognize(self):
  if not app_access.local_first_enabled():return self.send_json(404,{'ok':False,'error':'not_found'})
  try:limit=int(os.getenv('APP_AI_MEDIA_MAX_BYTES',str(20*1024*1024)))
  except ValueError:raise StoreError('media_limit_invalid') from None
  if limit<1 or limit>25*1024*1024:raise StoreError('media_limit_invalid')
  fields,files=self.media_body(limit+1024*1024)
  if set(files)!={'file'} or set(fields)!={'kind','content_type','attempt_id'}:raise StoreError('invalid_multipart_payload')
  media=files['file'];kind=fields['kind'];content_type=fields['content_type'];attempt_id=fields['attempt_id']
  if len(media['data'])>limit:
   error=StoreError('limit_exceeded');error.status=413;raise error
  suffix=Path(media['filename']).suffix[:12] if media.get('filename') else ''
  path=None
  try:
   with tempfile.NamedTemporaryFile(prefix='bingli-ai-',suffix=suffix,delete=False) as temporary:
    temporary.write(media['data']);path=Path(temporary.name)
   recognition=recognize_file(path,kind=kind,content_type=content_type,attempt_id=attempt_id,max_bytes=limit)
   if recognition.get('is_mock') is True:
    return self.send_json(503,{'ok':False,'error':'media_mock_unavailable','retryable':True})
   local_safety=scan_danger(recognition['text'])
   return self.send_json(200,{'ok':True,'recognition':recognition,'local_safety':local_safety})
  finally:
   if path is not None:
    try:path.unlink(missing_ok=True)
    except OSError:pass
 def _do_media_upload_POST(self,p):
  self.media_write_enabled()
  backend=self.media_backend();key=self.headers.get('Idempotency-Key')
  if not key:raise StoreError('idempotency_key_required')
  ctx=self._auth_ctx('create')
  if self.headers.get('X-Auth-Token') and ctx is None:return self.send_json(401,{'ok':False,'error':'invalid_session'})
  household_id=ctx['household_id'] if ctx else None
  parts=p.strip('/').split('/')
  if p=='/api/media/uploads':
   fields,files=self.media_body()
   if files:raise StoreError('invalid_multipart_payload')
   try:total_parts=int(fields.get('total_parts',''))
   except ValueError:raise StoreError('expected_parts_must_positive_integer') from None
   metadata={
   'kind':fields.get('kind'),'content_type':fields.get('content_type'),
    'total_parts':total_parts,'expected_parts':total_parts,
    'original_filename':fields.get('original_filename'),
    'actor_name':fields.get('actor_name','老人'),
    'occurred_time':fields.get('occurred_time'),
   }
   if fields.get('expected_size') not in (None,''):
    try:metadata['expected_size']=int(fields['expected_size'])
    except ValueError:raise StoreError('expected_size_must_positive_integer') from None
   if fields.get('expected_sha256') not in (None,''):metadata['expected_sha256']=fields['expected_sha256']
   upload,created=backend.create_upload(metadata,key,household_id)
   return self.send_json(201 if created else 200,{'ok':True,'created':created,'upload':_public_value(upload)})
  if len(parts)==6 and parts[:3]==['api','media','uploads'] and parts[4]=='parts':
   upload_id=parts[3]
   if not _safe_media_id(upload_id,'upload'):return self.send_json(404,{'ok':False,'error':'not_found'})
   try:index=int(parts[5])
   except ValueError:return self.send_json(404,{'ok':False,'error':'not_found'})
   fields,files=self.media_body()
   if fields or set(files)!={'file'}:raise StoreError('invalid_multipart_payload')
   part,created=backend.write_part(upload_id,index,files['file']['data'],key,household_id)
   return self.send_json(201 if created else 200,{'ok':True,'created':created,'part':_public_value(part)})
  if len(parts)==5 and parts[:3]==['api','media','uploads'] and parts[4]=='complete':
   upload_id=parts[3]
   if not _safe_media_id(upload_id,'upload'):return self.send_json(404,{'ok':False,'error':'not_found'})
   body=self.body()
   if body:raise StoreError('complete_body_must_be_empty_object')
   media,created=backend.complete_upload(upload_id,key,household_id)
   return self.send_json(201 if created else 200,{'ok':True,'created':created,'media':_public_value(media)})
  return self.send_json(404,{'ok':False,'error':'not_found'})
def serve(host=None,port=None): ThreadingHTTPServer((host or os.getenv('API_HOST','127.0.0.1'),int(os.getenv('API_PORT',os.getenv('PORT',port or 18768)))),Handler).serve_forever()
if __name__=='__main__':serve()
