"""Single-endpoint, non-streaming OpenAI Chat Completions transport.

This supports the Chat Completions protocol, including compatible relays. It
does not translate vendor-specific APIs, follow redirects, retry or fall back.
Errors deliberately exclude server bodies, URLs, credentials and exceptions.
"""
from __future__ import annotations

import copy
import contextvars
import hashlib
import http.client
import ipaddress
import json
import math
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any
try:
    from . import trial_gate
    from .trial_gate import authorize_request, TrialGateError
except ImportError:
    import trial_gate
    from trial_gate import authorize_request, TrialGateError


MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_ERROR_RESPONSE_BYTES = 16 * 1024
MAX_EXTRA_BODY_BYTES = 64 * 1024
_TRIAL_ATTEMPT = contextvars.ContextVar('noreset_trial_attempt', default=None)
_TRIAL_STATE = contextvars.ContextVar('noreset_trial_state', default=None)
PROTECTED_BODY_FIELDS = frozenset({
    'model', 'messages', 'stream', 'stream_options', 'response_format',
    'temperature', 'max_tokens', 'max_completion_tokens', 'n',
    'tools', 'tool_choice', 'parallel_tool_calls', 'functions', 'function_call',
})


class ModelClientError(RuntimeError):
    """A sanitized configuration, transport or response failure."""

    def __init__(self, message, *, code='model_response_invalid', status=None):
        super().__init__(message)
        self.code, self.status = code, status


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ModelClientError('模型 JSON 包含重复字段')
        result[key] = value
    return result


def _reject_constant(_value):
    raise ModelClientError('模型 JSON 包含非标准数值')


def _finite_float(value):
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ModelClientError('模型 JSON 包含非有限数值')
    return parsed


def strict_json_loads(text: str) -> Any:
    try:
        return json.loads(text, object_pairs_hook=_unique_object,
                          parse_constant=_reject_constant, parse_float=_finite_float)
    except (ValueError, TypeError, RecursionError):
        raise ModelClientError('模型返回不是有效 JSON') from None


def validate_extra_body(value: Any) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ModelClientError('LLM_EXTRA_BODY_JSON 必须是 JSON 对象')
    if PROTECTED_BODY_FIELDS.intersection(value):
        raise ModelClientError('LLM_EXTRA_BODY_JSON 不能覆盖请求核心字段')
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(encoded) > MAX_EXTRA_BODY_BYTES:
            raise ModelClientError('LLM_EXTRA_BODY_JSON 超过大小限制')
        # Round-trip rejects non-string keys and prevents shared mutable input.
        if any(not isinstance(key, str) for key in value):
            raise ModelClientError('LLM_EXTRA_BODY_JSON 字段名必须是字符串')
        return strict_json_loads(encoded.decode('utf-8'))
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise ModelClientError('LLM_EXTRA_BODY_JSON 不是有效 JSON 对象') from None


def parse_extra_body(text: str) -> dict:
    try:
        if not isinstance(text, str) or len(text.encode('utf-8')) > MAX_EXTRA_BODY_BYTES:
            raise ModelClientError('LLM_EXTRA_BODY_JSON 超过大小限制')
        return validate_extra_body(strict_json_loads(text))
    except (ModelClientError, UnicodeError):
        raise ModelClientError('LLM_EXTRA_BODY_JSON 无效或包含受保护字段') from None


def completion_url(base_url: str) -> str:
    """Accept a base such as /v1 or the complete /chat/completions endpoint."""
    invalid = '模型地址无效：须为 HTTPS base URL 或完整 chat/completions 地址；仅本机允许 HTTP'
    if not isinstance(base_url, str) or not base_url or re.search(r'[\s\x00-\x1f\x7f]', base_url):
        raise ModelClientError(invalid)
    try:
        parsed = urllib.parse.urlsplit(base_url)
        host = parsed.hostname
        port = parsed.port
        if (parsed.scheme not in {'https', 'http'} or not host or
                parsed.username is not None or parsed.password is not None or
                parsed.query or parsed.fragment or '?' in base_url or '#' in base_url or
                '\\' in base_url or (port is not None and not 1 <= port <= 65535)):
            raise ModelClientError(invalid)
        if parsed.scheme == 'http':
            loopback = host.lower().rstrip('.') == 'localhost'
            try:
                loopback = loopback or ipaddress.ip_address(host).is_loopback
            except ValueError:
                pass
            if not loopback:
                raise ModelClientError(invalid)
        # urllib otherwise defers invalid hostname characters until request time.
        host.encode('idna')
        if '%' in host or re.search(r'[^a-zA-Z0-9.\-:\u0080-\uffff]', host):
            raise ModelClientError(invalid)
        path = parsed.path.rstrip('/')
        if not path.endswith('/chat/completions'):
            path += '/chat/completions'
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, '', ''))
    except (ValueError, UnicodeError):
        raise ModelClientError(invalid) from None


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Returning None makes urllib raise HTTPError before sending credentials
        # or the medical-record request body to any redirect destination.
        return None


def reset_trial_context():
    _TRIAL_ATTEMPT.set(None)
    _TRIAL_STATE.set(None)


def trial_control(*, stopped=False):
    if type(_TRIAL_ATTEMPT.get()) is not int:
        return {}
    return {'review_required': True, **({'stopped': True} if stopped else {})}


def stop_current_trial(reason_code):
    attempt = _TRIAL_ATTEMPT.get()
    if type(attempt) is int:
        if _TRIAL_STATE.get() is None:
            raise ModelClientError('试验计量状态无效', code='trial_authorization_required')
        trial_gate.stop_trial(attempt, reason_code, state_path=_TRIAL_STATE.get())


def _trial_stop(request, reason_code):
    attempt = getattr(request, '_noreset_trial_attempt_id', None)
    if type(attempt) is int:
        state_path = getattr(request, '_noreset_trial_state_path', None)
        if state_path is None:
            raise ModelClientError('试验计量状态无效', code='trial_authorization_required')
        trial_gate.stop_trial(attempt, reason_code, state_path=state_path)


def _trial_report(request, envelope, raw, *, protocol='openai'):
    """Only the actual reserved request can report its own bounded response."""
    attempt = getattr(request, '_noreset_trial_attempt_id', None)
    if type(attempt) is not int:
        return
    state_path = getattr(request, '_noreset_trial_state_path', None)
    if state_path is None:
        raise ModelClientError('试验计量状态无效', code='trial_authorization_required')
    if not isinstance(envelope, dict):
        raise ModelClientError('合成试验用量无法验证', code='trial_authorization_required')
    if protocol == 'gemini':
        model, usage = envelope.get('modelVersion'), envelope.get('usageMetadata')
        fields = ('promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount')
        if (not isinstance(usage, dict) or any(type(usage.get(k)) is not int or usage[k] < 0 for k in fields)
                or ('toolUsePromptTokenCount' in usage and (type(usage['toolUsePromptTokenCount']) is not int or usage['toolUsePromptTokenCount'] != 0))
                or usage['totalTokenCount'] != usage['promptTokenCount'] + usage['candidatesTokenCount'] + usage['thoughtsTokenCount']):
            raise ModelClientError('合成试验用量无法验证', code='trial_authorization_required')
        usage = {'prompt_tokens': usage['promptTokenCount'],
                 'completion_tokens': usage['candidatesTokenCount'] + usage['thoughtsTokenCount'],
                 'completion_tokens_details': {'reasoning_tokens': usage['thoughtsTokenCount']}}
        trace = envelope.get('responseId')
    else:
        model, usage, trace = envelope.get('model'), envelope.get('usage'), envelope.get('id')
    metadata = {'response_sha256': hashlib.sha256(raw).hexdigest(), 'response_bytes': len(raw), 'protocol': protocol}
    secrets = [value.removeprefix('Bearer ') for key, value in request.header_items()
               if key.lower() in {'authorization', 'x-goog-api-key'}]
    if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}', model) or any(secret and secret in model for secret in secrets):
        model = None
    if isinstance(trace, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', trace):
        if not any(secret and secret in trace for secret in secrets):
            metadata['trace_id'] = trace
    try:
        trial_gate.report_usage(attempt, model, usage, transport_metadata=metadata,
                                state_path=state_path)
    except TrialGateError as error:
        raise ModelClientError(str(error), code=error.code) from None


def _open_request(request, timeout):
    reset_trial_context()
    for field in ('_noreset_trial_attempt_id', '_noreset_trial_state_path'):
        if hasattr(request, field):
            delattr(request, field)
    try:
        authorize_request(request)
    except TrialGateError as error:
        raise ModelClientError(str(error), code=error.code) from None
    attempt = getattr(request, '_noreset_trial_attempt_id', None)
    if type(attempt) is int:
        _TRIAL_ATTEMPT.set(attempt)
        _TRIAL_STATE.set(getattr(request, '_noreset_trial_state_path', None))
    try:
        return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirectHandler()).open(request, timeout=timeout)
    except Exception:
        _trial_stop(request, 'transport_failed')
        raise


def _modelscope_account_binding_required(error, request_url):
    """Recognize one confirmed vendor error without exposing response content."""
    if (error.code not in {401, 403} or
            urllib.parse.urlsplit(request_url).hostname != 'api-inference.modelscope.cn'):
        return False
    try:
        raw = error.read(MAX_ERROR_RESPONSE_BYTES + 1)
        if len(raw) > MAX_ERROR_RESPONSE_BYTES:
            return False
        data = strict_json_loads(raw.decode('utf-8'))
        vendor_error = data.get('error') if isinstance(data, dict) else None
        return (isinstance(vendor_error, dict) and
                vendor_error.get('message') == 'Please bind your Alibaba Cloud account before use.')
    except Exception:
        # Error-body diagnostics are best effort and must never replace the
        # original HTTP failure with a read, decoding or parser exception.
        return False


class ChatCompletionsClient:
    def __init__(self, *, base_url: str, model: str, api_key: str,
                 timeout: float = 30, json_mode: bool = False,
                 extra_body: dict | None = None, max_tokens: int = 4096,
                 trial_provider: str = 'openai_compatible'):
        self.url = completion_url(base_url)
        if not isinstance(model, str) or not model.strip() or re.search(r'[\x00-\x1f\x7f]', model):
            raise ModelClientError('未配置有效模型名称')
        if not isinstance(api_key, str) or not api_key.strip() or re.search(r'[\s\x00-\x1f\x7f]', api_key):
            raise ModelClientError('未配置有效模型 API key')
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise ModelClientError('MODEL_TIMEOUT_SECONDS 必须是大于零的有限数值')
        if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or max_tokens <= 0:
            raise ModelClientError('MODEL_MAX_TOKENS 必须是正整数')
        if not isinstance(json_mode, bool):
            raise ModelClientError('LLM_JSON_MODE 必须为 true 或 false')
        self.model, self.api_key, self.timeout = model, api_key, timeout
        self.json_mode, self.max_tokens = json_mode, max_tokens
        self.extra_body = validate_extra_body(extra_body)
        self.trial_provider = trial_provider

    def complete_json(self, system_prompt: str, payload: dict) -> dict:
        reset_trial_context()
        try:
            return self._complete_json(system_prompt, payload)
        except Exception:
            stop_current_trial('business_validation_failed')
            raise

    def _complete_json(self, system_prompt: str, payload: dict) -> dict:
        try:
            serialized_payload = json.dumps(payload, ensure_ascii=False, allow_nan=False)
        except (ValueError, TypeError, UnicodeError, RecursionError):
            raise ModelClientError('模型请求 payload 不是有效 JSON') from None
        body = copy.deepcopy(self.extra_body)
        body.update({
            'model': self.model, 'temperature': 0, 'stream': False,
            'max_tokens': self.max_tokens,
            'messages': [
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': serialized_payload},
            ],
        })
        if self.json_mode:
            body['response_format'] = {'type': 'json_object'}
        try:
            request = urllib.request.Request(
                self.url, json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8'),
                {'Authorization': 'Bearer ' + self.api_key,
                 'Content-Type': 'application/json', 'Accept': 'application/json'}, method='POST')
            request._noreset_trial_profile = {
                'kind': 'llm', 'provider': self.trial_provider, 'model': self.model,
                'source_sha256': hashlib.sha256(serialized_payload.encode('utf-8')).hexdigest(),
            }
            with _open_request(request, self.timeout) as response:
                status = response.status
                if status != 200:
                    raise ModelClientError('模型请求失败：非成功 HTTP 状态', code='model_http_error', status=status)
                content_type = response.headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
                if content_type and content_type != 'application/json' and not content_type.endswith('+json'):
                    raise ModelClientError('模型返回的 Content-Type 不是 JSON')
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise ModelClientError('模型响应超过大小限制', code='model_response_too_large')
        except urllib.error.HTTPError as error:
            status = error.code
            if 300 <= status < 400:
                error.close()
                raise ModelClientError('模型请求拒绝重定向', code='model_redirect_rejected', status=status) from None
            binding_required = _modelscope_account_binding_required(error, self.url)
            error.close()
            if binding_required:
                raise ModelClientError('魔搭账号需先绑定阿里云账号',
                                       code='model_account_binding_required', status=status) from None
            raise ModelClientError(f'模型请求失败：HTTP {status}', code='model_http_error', status=status) from None
        except TimeoutError:
            raise ModelClientError('模型请求失败：超时', code='model_timeout') from None
        except urllib.error.URLError as error:
            if isinstance(error.reason, TimeoutError):
                raise ModelClientError('模型请求失败：超时', code='model_timeout') from None
            raise ModelClientError('模型请求失败：网络连接错误', code='model_network_error') from None
        except (OSError, http.client.HTTPException):
            raise ModelClientError('模型请求失败：网络连接错误', code='model_network_error') from None
        except (ValueError, TypeError, UnicodeError):
            raise ModelClientError('模型请求或响应编码无效') from None
        try:
            response_data = strict_json_loads(raw.decode('utf-8'))
        except UnicodeError:
            raise ModelClientError('模型响应不是 UTF-8 JSON') from None
        if not isinstance(response_data, dict):
            raise ModelClientError('模型响应必须是 JSON 对象')
        _trial_report(request, response_data, raw)
        if response_data.get('error'):
            raise ModelClientError('模型响应报告错误')
        choices = response_data.get('choices')
        if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
            raise ModelClientError('模型响应必须包含一条完整 choice')
        choice = choices[0]
        if choice.get('finish_reason') == 'length':
            raise ModelClientError('模型输出因 token 上限被截断', code='model_output_truncated')
        if choice.get('finish_reason') != 'stop':
            raise ModelClientError('模型未正常完成文本输出')
        message = choice.get('message')
        if not isinstance(message, dict) or message.get('refusal') or message.get('tool_calls') or message.get('function_call'):
            raise ModelClientError('模型响应未提供可用文本消息')
        # Some compatible relays omit role. If supplied, it must identify an
        # assistant response rather than echoing user/system input as output.
        if 'role' in message and message['role'] != 'assistant':
            raise ModelClientError('模型响应 role 必须为 assistant')
        content = message.get('content')
        if not isinstance(content, str) or not content.strip():
            raise ModelClientError('模型返回 content 为空或不是文本')
        content = content.strip()
        # Retain the existing whole-message fenced-JSON compatibility. No prose,
        # partial fences or trailing content is stripped or repaired.
        fence = re.fullmatch(r'```(?:json)?\s*\n(.*?)\n```', content, re.DOTALL)
        if fence:
            content = fence.group(1)
        result = strict_json_loads(content)
        if not isinstance(result, dict):
            raise ModelClientError('模型输出必须为 JSON 对象')
        return result
