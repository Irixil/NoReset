"""Prepare three synthetic native requests; execute exactly one approved request."""
from __future__ import annotations

import argparse
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path
from unittest.mock import patch

from backend import adapter, conversation, model_client, trial_gate
from backend.evaluation import SAFE_MODEL_ERROR_CODES


ROOT = Path(__file__).resolve().parents[1]
PACKET = ROOT / 'docs/evidence/goal-audit-2026-10-08/preflight/five-call-inputs.json'
OUT_DIR = ROOT / 'docs/evidence/goal-audit-2026-10-08/preflight/text-subset'
MODEL = 'deepseek-flash'
BASE_URL = 'https://api.deepseek.com'
URL = BASE_URL + '/chat/completions'
JOB_IDS = ('dialogue1', 'dialoguecorrection2', 'documentorganize3')
MAX_OUTPUT = 2048
MAX_WIRE = 24000


def encoded(value):
    # Match the native client's actual wire serialization, including spacing.
    return json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(value).hexdigest()


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')


class PreviewReady(Exception):
    pass


class PreviewProvider:
    """Capture the native engine's cleaned model input without a client or Key."""
    def complete_json(self, system_prompt, payload):
        self.system_prompt, self.payload = system_prompt, deepcopy(payload)
        raise PreviewReady()


def run_native(job, provider):
    if job['engine'] == 'conversation':
        return conversation.conversation_turn(deepcopy(job['native_input']), provider)
    return adapter.organize_event(deepcopy(job['native_input']), provider)


def authored_jobs(packet_path=PACKET):
    packet = json.loads(Path(packet_path).read_text(encoding='utf-8'))
    if packet.get('schema_version') != 'noreset-five-call-inputs-v1' or packet.get('synthetic_only') is not True:
        raise ValueError('Only the prepared authored synthetic packet is allowed')
    calls = {item['number']: item for item in packet['calls']}
    first, correction = calls[2]['current_turn'], calls[3]['current_turn']
    document = calls[4]['expected_text_for_human_comparison']
    if first != (ROOT / 'data/synthetic/five-call-preflight/asr-source.txt').read_text(encoding='utf-8').strip():
        raise ValueError('Authored typed source changed')
    if document != (ROOT / 'data/synthetic/five-call-preflight/ocr-source.txt').read_text(encoding='utf-8').strip():
        raise ValueError('Authored document source changed')
    stamp = packet['reference_time']
    turn = {'turn_id': 'turn_texttrial_patient01', 'text': first, 'version': 1}
    corrected = {'turn_id': 'turn_texttrial_correct02', 'text': correction, 'version': 2}
    common = {'health_context': [], 'controller': {}}
    return [
        {'job_id': JOB_IDS[0], 'engine': 'conversation',
         'native_input': {'turns': [turn], **deepcopy(common)},
         'source_history': [turn], 'reference_time': stamp,
         'source_note': '原创语音稿直接键入；未执行或宣称真实 ASR。'},
        {'job_id': JOB_IDS[1], 'engine': 'conversation',
         'native_input': {'turns': [turn, corrected], **deepcopy(common)},
         'source_history': [turn, corrected], 'reference_time': stamp,
         'source_note': '仅带两条原创患者文字；最新纠正来源为 version 2，未混入 AI 回复。'},
        {'job_id': JOB_IDS[2], 'engine': 'organize', 'reference_time': stamp,
         'native_input': {'record_id': 'rec_texttrial_document03', 'raw_text': document,
                          'source_kind': 'document', 'recorded_at': stamp, 'occurred_time': None,
                          'source_review': {'method': 'original_comparison', 'text': document, 'confirmed_at': stamp}},
         'source_history': [{'record_id': 'rec_texttrial_document03', 'raw_text': document, 'version': 1}],
         'source_note': '原创 UTF-8 资料全文对照作者文本；未执行 OCR、图像核对或医学审签。'},
    ]


def prepare_job(job):
    preview = PreviewProvider()
    try:
        run_native(job, preview)
    except PreviewReady:
        pass
    else:
        raise ValueError('Native engine did not produce exactly one model request')
    payload_bytes = encoded(preview.payload)
    body = {'thinking': {'type': 'disabled'}}
    body.update(model=MODEL, temperature=0, stream=False, max_tokens=MAX_OUTPUT,
                messages=[{'role': 'system', 'content': preview.system_prompt},
                          {'role': 'user', 'content': payload_bytes.decode('utf-8')}])
    body['response_format'] = {'type': 'json_object'}
    wire = encoded(body)
    if len(wire) > MAX_WIRE:
        raise ValueError('Prepared wire exceeds the reviewed byte cap')
    return {**deepcopy(job), 'synthetic_only': True, 'planned_text_requests': 3,
            'real_requests_executed': 0, 'semantic_review_status': 'pending', 'clinical_review_status': 'pending',
            'model_payload': preview.payload, 'wire_body': body,
            'profile': {'kind': 'llm', 'provider': 'deepseek', 'model': MODEL, 'url': URL,
                        'source_sha256': digest(payload_bytes), 'request_sha256': digest(wire),
                        'wire_bytes': len(wire), 'max_output_tokens': MAX_OUTPUT, 'max_thinking_tokens': 0}}


def write_preview(prepared, out_dir):
    out_dir = Path(out_dir)
    save_json(out_dir / (prepared['job_id'] + '.input.json'), prepared)
    wire_path = out_dir / (prepared['job_id'] + '.wire.json')
    wire_path.write_bytes(encoded(prepared['wire_body']))


def prepare_all(out_dir=OUT_DIR):
    prepared = [prepare_job(job) for job in authored_jobs()]
    for item in prepared:
        write_preview(item, out_dir)
    manifest = {'schema_version': 'noreset-text-trial-preview-v1', 'synthetic_only': True,
                'planned_text_requests': 3, 'real_requests_executed': 0,
                'semantic_review_status': 'pending', 'clinical_review_status': 'pending',
                'authorization': 'Preview only; runtime receipt and root approval are still required.',
                'profiles': [item['profile'] for item in prepared]}
    save_json(Path(out_dir) / 'manifest.json', manifest)
    return prepared


def receipt_matches(prepared):
    authorization = trial_gate.validate_trial_authorization()
    approved = authorization['receipt']['profiles']['llm']
    profile = prepared['profile']
    journal = trial_gate.trial_journal()
    if (digest(encoded(prepared['wire_body'])) != profile['request_sha256']
            or digest(encoded(prepared['model_payload'])) != profile['source_sha256']
            or (approved['provider'], approved['model'], approved['url']) != ('deepseek', MODEL, URL)
            or profile['source_sha256'] not in approved['source_sha256']
            or profile['request_sha256'] not in approved['request_sha256']
            or profile['wire_bytes'] > approved['max_input_bytes']
            or approved['max_output_tokens'] < MAX_OUTPUT or approved['max_thinking_tokens'] != 0
            or approved['billing'].get('status') != 'verified'
            or authorization['remaining_requests'] <= 0
            or Decimal(authorization['remaining_usd']) < Decimal('0.3170304')
            or sum(row['kind'] == 'llm' for row in journal) >= approved['requests']
            or any(row['usage'] is None for row in journal)):
        raise trial_gate.TrialGateError()
    authorization['journal_before_ids'] = [row['id'] for row in journal]
    return authorization


class BufferedResponse:
    def __init__(self, raw, status, content_type):
        self.raw, self.status = raw, status
        self.headers = {'Content-Type': content_type}

    def read(self, size=-1):
        return self.raw if size < 0 else self.raw[:size]

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class CaptureResponse:
    def __init__(self, prepared, opener):
        self.prepared, self.opener = prepared, opener
        self.calls, self.attempt_id, self.raw, self.status = 0, None, None, None

    def __call__(self, request, timeout):
        self.calls += 1
        if self.calls != 1 or request.data != encoded(self.prepared['wire_body']):
            raise model_client.ModelClientError('Frozen request changed', code='text_trial_request_changed')
        expected = self.prepared['profile']
        if request.full_url != URL or getattr(request, '_noreset_trial_profile', None) != {
                'kind': 'llm', 'provider': 'deepseek', 'model': MODEL, 'source_sha256': expected['source_sha256']}:
            raise model_client.ModelClientError('Frozen profile changed', code='text_trial_request_changed')
        try:
            with self.opener(request, timeout) as response:
                self.status = response.status
                content_type = response.headers.get('Content-Type', '')
                # Never capture an HTTP error body, which may echo credentials.
                self.raw = response.read(model_client.MAX_RESPONSE_BYTES + 1) if self.status == 200 else b''
                return BufferedResponse(self.raw, self.status, content_type)
        finally:
            self.attempt_id = getattr(request, '_noreset_trial_attempt_id', None)


def safe_response(capture, secret):
    if capture.raw is None or capture.status != 200:
        return None, None, None
    artifact = {'raw_sha256': digest(capture.raw), 'response_bytes': len(capture.raw), 'status': capture.status}
    if len(capture.raw) > model_client.MAX_RESPONSE_BYTES:
        artifact['capture_status'] = 'too_large_body_not_saved'
        return artifact, None, None
    try:
        envelope = model_client.strict_json_loads(capture.raw.decode('utf-8'))
    except (model_client.ModelClientError, UnicodeError):
        artifact['capture_status'] = 'malformed_envelope_body_not_saved'
        return artifact, None, None
    if not isinstance(envelope, dict):
        return artifact, None, None
    returned_model, usage = envelope.get('model'), envelope.get('usage')
    safe_usage = ({key: usage[key] for key in ('prompt_tokens', 'completion_tokens', 'total_tokens') if key in usage}
                  if isinstance(usage, dict) else None)
    if isinstance(usage, dict) and isinstance(usage.get('completion_tokens_details'), dict):
        safe_usage['completion_tokens_details'] = {'reasoning_tokens': usage['completion_tokens_details'].get('reasoning_tokens')}
    choices = envelope.get('choices')
    artifact.update(capture_status='bounded_response_content', model=returned_model,
                    usage=safe_usage, choices=[{'finish_reason': choice.get('finish_reason'),
                            'content': choice.get('message', {}).get('content')}
                        for choice in (choices if isinstance(choices, list) else []) if isinstance(choice, dict)
                        and isinstance(choice.get('message'), dict)])
    # Preserve model content even when native parsing/grounding fails, but never
    # retain envelope headers, credentials, arbitrary metadata or error bodies.
    artifact = redact(artifact, secret)
    return artifact, returned_model, usage


def redact(value, secret):
    if isinstance(value, str):
        return value.replace(secret, '[REDACTED]') if secret else value
    if isinstance(value, dict):
        return {key: redact(item, secret) for key, item in value.items()
                if str(key).lower() not in {'headers', 'authorization', 'api_key', 'token', 'password'}}
    if isinstance(value, list):
        return [redact(item, secret) for item in value]
    return value


def safe_failure(error):
    allowed = SAFE_MODEL_ERROR_CODES | {'trial_authorization_required', 'trial_budget_exhausted',
                                      'text_trial_request_changed', 'text_trial_configuration_invalid',
                                      'model_reply_unsafe', 'text_trial_no_attempt', 'text_trial_usage_unverified'}
    code = getattr(error, 'code', None)
    result = {'code': code if code in allowed else 'generation_or_validation_failed'}
    status = getattr(error, 'status', None)
    if type(status) is int and 100 <= status <= 599:
        result['http_status'] = status
    return result


def execute_one(prepared, out_dir=OUT_DIR):
    # Save the complete synthetic runtime input before even checking authority.
    write_preview(prepared, out_dir)
    result = {'job_id': prepared['job_id'], 'planned_text_requests': 3, 'retry_performed': False,
              'synthetic_only': True, 'semantic_review_status': 'pending', 'clinical_review_status': 'pending',
              'started_at': datetime.now(timezone.utc).isoformat(), 'request_profile': prepared['profile'],
              'status': 'failed', 'real_requests_executed': 0}
    capture, secret = None, ''
    try:
        authority = receipt_matches(prepared)  # Read-only, no Key, before Config.
        result['receipt_sha256'] = authority['receipt_sha256']
        config = adapter.Config.from_env()
        if config.provider not in {'deepseek', 'deepseek-ai'}:
            raise model_client.ModelClientError('Existing DeepSeek service required', code='text_trial_configuration_invalid')
        secret = config.token
        # Approved trial-only request parameters; no persistent configuration.
        config = replace(config, provider='deepseek', base_url=BASE_URL, model=MODEL,
                         max_tokens=MAX_OUTPUT, json_mode=True, extra_body={'thinking': {'type': 'disabled'}})
        provider = adapter.DeepSeekProvider(config)
        capture = CaptureResponse(prepared, model_client._open_request)
        with patch.object(model_client, '_open_request', capture):
            native = run_native(prepared, provider)
        if capture.calls != 1 or capture.attempt_id is None:
            raise model_client.ModelClientError('No metered request observed', code='text_trial_no_attempt')
        result['native_output'] = redact(native, secret)
        if native.get('stop_reason') == 'model_output_blocked':
            raise model_client.ModelClientError('Native reply blocked', code='model_reply_unsafe')
        result['status'] = 'validated_pending_manual_review'
    except Exception as error:
        result['failure'] = safe_failure(error)
    finally:
        if capture is not None:
            result['transport_invocations'] = capture.calls
            result['attempt_id'] = capture.attempt_id
            result['real_requests_executed'] = int(capture.attempt_id is not None)
            artifact, returned_model, usage = safe_response(capture, secret)
            if artifact is not None:
                artifact_path = Path(out_dir) / (prepared['job_id'] + '.response.json')
                save_json(artifact_path, artifact)
                result['response_artifact'] = str(artifact_path)
            if capture.attempt_id is not None:
                try:
                    new_rows = [row for row in trial_gate.trial_journal() if row['id'] not in authority['journal_before_ids']]
                    if (len(new_rows) != 1 or new_rows[0]['id'] != capture.attempt_id
                            or new_rows[0]['request_sha256'] != prepared['profile']['request_sha256']
                            or new_rows[0]['source_sha256'] != prepared['profile']['source_sha256']):
                        returned_model, usage = None, None  # Freeze unknown accounting.
                        result.update(status='failed', failure={'code': 'text_trial_no_attempt'})
                    result['meter_usage'] = trial_gate.report_usage(capture.attempt_id, returned_model, usage)
                    result['attempt_journal'] = next(row for row in trial_gate.trial_journal() if row['id'] == capture.attempt_id)
                except Exception as error:
                    result.update(status='failed', meter_failure=safe_failure(error))
        save_json(Path(out_dir) / (prepared['job_id'] + '.result.json'), redact(result, secret))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('prepare', 'dry-run', 'execute'), default='prepare')
    parser.add_argument('--job', choices=JOB_IDS)
    parser.add_argument('--out-dir', default=str(OUT_DIR))
    args = parser.parse_args(argv)
    if args.mode == 'execute' and args.job is None:
        parser.error('execute requires one --job; no automatic three-call chain')
    prepared = prepare_all(Path(args.out_dir))
    if args.mode != 'execute':
        print(json.dumps({'mode': 'prepare', 'planned_text_requests': 3, 'real_requests_executed': 0,
                          'profiles': [item['profile'] for item in prepared]}, ensure_ascii=False))
        return 0
    selected = next(item for item in prepared if item['job_id'] == args.job)
    result = execute_one(selected, Path(args.out_dir))
    print(json.dumps({'job_id': result['job_id'], 'status': result['status'],
                      'real_requests_executed': result['real_requests_executed'], 'failure': result.get('failure')}, ensure_ascii=False))
    return 0 if result['status'] == 'validated_pending_manual_review' else 1


if __name__ == '__main__':
    raise SystemExit(main())
