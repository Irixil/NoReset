"""One independent reviewed N01/N03 saved-audio LLM grant; never renews an ASR stop.

The local operator installs a binding only after native one-request approval.
No HTTP route creates approval, loads keys, resets a ledger, or retries a claim.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

try:
    from . import trial_gate
except ImportError:
    import trial_gate

ROOT = Path(__file__).resolve().parents[1]
BINDING_PATH = ROOT / 'runtime/synthetic-trial/saved-audio-continuation.json'
TEXT = '上腹这两天不舒服，吃完饭后明显。'
AUDIO_SHA = '4d1963d2ac15bd81b1bc39ea4ccd81e9e116c579f9f7452938cefbee33eb7af0'
SCHEMA = 'noreset-n03-saved-audio-llm-v1'
SCHEMA_N01 = 'noreset-n01-saved-audio-llm-v1'
SCHEMA_N01_REVIEWED = 'noreset-n01-saved-audio-llm-reviewed-v2'
SCHEMA_N03_COUGH_REVIEWED = 'noreset-n03-cough-reviewed-saved-audio-llm-v1'
SCHEMA_REVIEWED_ASR = 'noreset-reviewed-asr-saved-audio-llm-v1'
N01_TEXT = '我咳嗽两天了，晚上明显些。'
N01_AUDIO_SHA = '8e30b62c66b203d2e17a4a42af4ac1ef6ad9a0c3cf2eab4c40c907ecaeaedaff'
N03_COUGH_TEXT = '我咳嗽两天了，晚上明显些。'
N03_COUGH_AUDIO_SHA = '55534757775cb28fdbcfcb8cd58e932e62e2ed50f1d2c5b5268d7f319bb11e4c'
# Each reviewed fixture keeps its real source revision; this is not a generic grant.
SOURCES = {SCHEMA: (TEXT, AUDIO_SHA, 2), SCHEMA_N01: (N01_TEXT, N01_AUDIO_SHA, 1),
           SCHEMA_N01_REVIEWED: (N01_TEXT, N01_AUDIO_SHA, 2),
           SCHEMA_N03_COUGH_REVIEWED: (N03_COUGH_TEXT, N03_COUGH_AUDIO_SHA, 2)}
# The existing synthetic N01 closure is completed but still review-required.
# A new independent grant preserves these exact archived controls, never resumes them.
N01_COMPLETED_MEDIA = {'review_required': True, 'state': 'completed', 'conversation_id': 'conversation_3001b2e17e6a4b3686948dc6d83f6659', 'turn_id': 'turn_995fb60fedaf4506b85425e186272ce2', 'turn_version': 1, 'media_id': 'media_858a368d6c1b4246aa91be47fdb7cf1a'}
N01_COMPLETED_GLOBAL = {'review_required': True, 'state': 'completed', 'source_kind': 'elder', 'conversation_id': 'conversation_3001b2e17e6a4b3686948dc6d83f6659', 'turn_id': 'turn_902dbb0381754982a955cb2ce07eda32', 'turn_version': 1, 'media_id': None}


def _deny():
    raise trial_gate.TrialGateError()


def http_sha(body):
    return hashlib.sha256(json.dumps(body, ensure_ascii=False, allow_nan=False,
                                    separators=(',', ':')).encode()).hexdigest()


def _read(path, limit=64000):
    path = Path(path)
    if (not path.is_absolute() or path != path.resolve() or not path.is_file()
            or path.is_symlink() or path.stat().st_nlink != 1
            or ROOT.resolve() not in path.parents or path.stat().st_size > limit):
        _deny()
    return json.loads(path.read_text(), object_pairs_hook=trial_gate._unique_object)


def _reviewed_asr_is_closed(binding, source, llm_receipt):
    """Trust only a verified, closed ASR scope in this same cumulative budget."""
    try:
        from . import trial_budget
    except ImportError:
        import trial_budget
    media = binding['prior_media_control']
    receipt_id, receipt_sha = media.get('asr_trial_receipt_id'), media.get('asr_trial_receipt_sha256')
    descriptor = llm_receipt.get('cumulative_budget')
    if (not isinstance(receipt_id, str) or not receipt_id.strip()
            or not isinstance(receipt_sha, str) or not re.fullmatch('[a-f0-9]{64}', receipt_sha)
            or not isinstance(descriptor, dict)):
        _deny()
    try:
        native = trial_budget.native_root_binding(descriptor, receipt_id=receipt_id, include_scope=True)
    except trial_budget.TrialBudgetError:
        _deny()
    root = native.get('binding', {})
    receipt_path = Path(root.get('manifest_path', '')).with_name('authorization.json')
    raw = trial_gate._root_file(str(receipt_path), 65536)
    if hashlib.sha256(raw).hexdigest() != receipt_sha or root.get('receipt_sha256') != receipt_sha:
        _deny()
    asr_receipt, digest = trial_gate._parse_receipt(raw, historical=True)
    profile = asr_receipt.get('profiles', {}).get('asr', {})
    if (digest != receipt_sha or asr_receipt.get('schema_version') != trial_gate.SCHEMA_RISK_SEQUENCE
            or asr_receipt.get('request_sequence') != ['asr'] or asr_receipt.get('total_requests') != 1
            or asr_receipt.get('planned_text_requests') != 0 or set(asr_receipt.get('profiles', {})) != {'asr'}
            or profile.get('provider') != 'aihubmix' or profile.get('model') != 'gemini-2.5-flash-lite'
            or profile.get('requests') != 1 or profile.get('source_sha256') != [source['audio_sha256']]
            or not isinstance(profile.get('request_sha256'), list) or len(profile['request_sha256']) != 1
            or asr_receipt.get('cumulative_budget') != descriptor
            or native.get('receipt') != asr_receipt or native.get('status') != 'closed'
            or native.get('closure_reason') != 'owner_stop' or root.get('state_path') != str(Path(root.get('state_path', '')).resolve())):
        _deny()
    allocations = native.get('allocations', [])
    if (len(allocations) != 1 or allocations[0][0] != 0 or allocations[0][1] != 'asr'
            or allocations[0][2] != source['audio_sha256']
            or allocations[0][3] != profile['request_sha256'][0] or not allocations[0][5]):
        _deny()
    try:
        allocation = trial_budget.batch_status(descriptor, receipt=asr_receipt)
    except trial_budget.TrialBudgetError:
        _deny()
    if not allocation.get('closed') or allocation.get('allocations') != 1 or allocation.get('closure_reason') != 'owner_stop':
        _deny()
    journal = trial_gate.trial_journal(state_path=root['state_path'], historical_closed=True)
    if (len(journal) != 1 or journal[0].get('kind') != 'asr'
            or journal[0].get('source_sha256') != source['audio_sha256']
            or journal[0].get('request_sha256') != profile['request_sha256'][0]
            or not isinstance(journal[0].get('usage'), dict) or journal[0]['usage'].get('verified') is not True
            or journal[0]['usage'].get('returned_model') != profile['model']
            or journal[0].get('closed_status') == 'failed_usage_unverified'):
        _deny()


def _load():
    binding = _read(BINDING_PATH)
    if set(binding) != {'schema_version', 'grant_id', 'source', 'prior_media_control',
                        'prior_global_control', 'receipt_path', 'state_path',
                        'http_payload_path', 'http_payload_sha256'}:
        _deny()
    if (binding['schema_version'] not in set(SOURCES) | {SCHEMA_REVIEWED_ASR}
            or not re.fullmatch('[a-f0-9]{32}', binding['grant_id'])):
        _deny()
    text, audio_sha, source_version = SOURCES.get(binding['schema_version'], (None, None, None))
    source = binding['source']
    if (set(source) != {'media_id', 'media_version', 'record_id', 'source_version',
                       'subject_id', 'text_sha256', 'confirmed_at', 'audio_sha256'}
            or source['subject_id'] != 'subject_self' or type(source['source_version']) is not int
            or (binding['schema_version'] != SCHEMA_REVIEWED_ASR and source['source_version'] != source_version)
            or (binding['schema_version'] == SCHEMA_REVIEWED_ASR and source['source_version'] < 1)
            or not re.fullmatch('[a-f0-9]{64}', source['text_sha256'])
            or (text is not None and source['text_sha256'] != hashlib.sha256(text.encode()).hexdigest())
            or (audio_sha is not None and source['audio_sha256'] != audio_sha)
            or not re.fullmatch('media_[a-f0-9]{32}', source['media_id'])
            or not re.fullmatch('rec_[a-f0-9]{32}', source['record_id'])
            or type(source['media_version']) is not int or source['media_version'] < 1):
        _deny()
    if not isinstance(source['confirmed_at'], str):
        _deny()
    confirmed = datetime.fromisoformat(source['confirmed_at'].replace('Z', '+00:00'))
    if confirmed.tzinfo is None or confirmed > datetime.now(timezone.utc):
        _deny()
    expected_global = {**binding['prior_media_control'], 'media_id': source['media_id'], 'conversation_id': None}
    stopped_source = (binding['prior_media_control'] in [dict(review_required=True, state='review_required'), dict(review_required=True, state='stopped')]
                      and binding['prior_global_control'] == expected_global)
    saved_N01_closure = (binding['schema_version'] == SCHEMA_N01_REVIEWED
                        and source['media_id'] == N01_COMPLETED_MEDIA['media_id']
                        and source['record_id'] == 'rec_731878cfff954398993ee79f0f1c5716'
                        and source['media_version'] == 4
                        and binding['prior_media_control'] == N01_COMPLETED_MEDIA
                        and binding['prior_global_control'] == N01_COMPLETED_GLOBAL)
    if not (stopped_source or saved_N01_closure):
        media_control = binding['prior_media_control']
        global_control = binding['prior_global_control']
        null_global_reviewed_source = (
            global_control is None and isinstance(media_control, dict)
            and ('media_id' not in media_control or media_control['media_id'] == source['media_id'])
            and isinstance(media_control.get('asr_trial_receipt_id'), str)
            and bool(media_control['asr_trial_receipt_id'].strip())
            and isinstance(media_control.get('asr_trial_receipt_sha256'), str)
            and re.fullmatch('[a-f0-9]{64}', media_control['asr_trial_receipt_sha256']) is not None)
        if (binding['schema_version'] != SCHEMA_REVIEWED_ASR or not isinstance(media_control, dict)
                or media_control.get('review_required') is not True
                or media_control.get('state') not in {'review_required', 'stopped'}
                or media_control.get('conversation_id') is not None
                or not (null_global_reviewed_source or (
                    isinstance(global_control, dict)
                    and global_control.get('review_required') is True
                    and global_control.get('state') in {'stopped', 'review_required'}
                    and global_control.get('conversation_id') is None
                    and re.fullmatch('media_[a-f0-9]{32}', str(global_control.get('media_id', ''))) is not None
                ))):
            _deny()
    status = trial_gate.validate_trial_authorization(receipt_path=binding['receipt_path'], state_path=binding['state_path'])
    receipt = status['receipt']
    p = receipt['profiles'].get('llm', {})
    lifetime = datetime.fromisoformat(receipt['expires_at']) - datetime.fromisoformat(receipt['approved_at'])
    if (receipt['schema_version'] != trial_gate.SCHEMA_RISK_SEQUENCE
            or receipt['request_sequence'] != ['llm'] or receipt['total_requests'] != 1
            or set(receipt['profiles']) != {'llm'} or status['remaining_requests'] != 1
            or not 0 < lifetime.total_seconds() <= 1200
            or p.get('provider') != 'deepseek' or p.get('model') != 'deepseek-flash'
            or p.get('url') != 'https://api.deepseek.com/chat/completions'
            or p.get('max_input_bytes') != 24000 or p.get('max_output_tokens') != 2048
            or p.get('max_thinking_tokens') != 0):
        _deny()
    if binding['schema_version'] == SCHEMA_REVIEWED_ASR:
        _reviewed_asr_is_closed(binding, source, receipt)
    # This validates the independent manifest, frozen wire and unchanged original
    # cumulative rows. A normal old-ledger amendment is deliberately insufficient.
    with sqlite3.connect(Path(binding['state_path']).as_uri() + '?mode=ro', uri=True) as db:
        native = trial_gate._standalone_context(db, receipt)
        if native is None:
            _deny()
    body = _read(binding['http_payload_path'])
    if binding['schema_version'] == SCHEMA_REVIEWED_ASR:
        turns = body.get('turns', [])
        text = turns[0].get('text') if len(turns) == 1 and isinstance(turns[0], dict) else None
        if (not isinstance(text, str) or not text.strip() or len(text) > 10000
                or hashlib.sha256(text.encode()).hexdigest() != source['text_sha256']
                or type(source['source_version']) is not int or source['source_version'] < 1):
            _deny()
    if (http_sha(body) != binding['http_payload_sha256'] or body.get('subject_id') != 'subject_self'
            or len(body.get('turns', [])) != 1
            or body['turns'][0] != {'turn_id': 'turn_saved_audio_' + binding['grant_id'], 'text': text, 'version': 1,
                                    'responding_to': {'turn_id': 'turn_saved_audio_opening_' + binding['grant_id'],
                                                      'text': '您好，我会帮您把不舒服的地方记清楚，方便和医生说。您今天最难受的是什么？'}}
            or (body.get('health_context', []) != [] if binding['schema_version'] == SCHEMA_REVIEWED_ASR
                else len(body.get('health_context', [])) > 1)
            or any(item.get('text') != text or item.get('subject_id') != 'subject_self'
                   for item in body.get('health_context', []))):
        _deny()
    claim = Path(binding['state_path']).with_name(Path(binding['state_path']).name + '.saved-audio.claimed')
    if claim.exists() or claim.is_symlink():
        _deny()
    return binding, receipt, status['receipt_sha256'], claim


def available_grant():
    """Read-only metadata; default closed even when the native ledger is absent."""
    try:
        b, receipt, digest, _ = _load()
        return {key: b[key] for key in ['grant_id', 'source', 'prior_media_control', 'prior_global_control', 'http_payload_sha256']} | {
            'schema_version': b['schema_version'], 'receipt_sha256': digest, 'expires_at': receipt['expires_at'],
            'requests': 1, 'retries': 0}
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError, sqlite3.Error, trial_gate.TrialGateError):
        return None


def run_turn(grant_id, body, callback):
    """Claim durably before the normal model path; a restart cannot resend it."""
    try:
        binding, _, _, claim = _load()
        if grant_id != binding['grant_id'] or http_sha(body) != binding['http_payload_sha256']:
            _deny()
        # open(x)+fsync serializes processes as well as requests; this independent
        # claim remains occupied even if the process dies before supplier reserve.
        fd = os.open(claim, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, json.dumps({'grant_id': grant_id, 'http_payload_sha256': http_sha(body),
                                    'claimed_at': datetime.now(timezone.utc).isoformat()}).encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        directory_fd = os.open(claim.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        with trial_gate.standalone_trial_scope(receipt_path=binding['receipt_path'], state_path=binding['state_path']):
            return callback(body)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError, sqlite3.Error):
        raise trial_gate.TrialGateError() from None
