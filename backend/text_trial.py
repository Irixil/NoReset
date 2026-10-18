"""One root-installed, exact-payload text grant for a single synthetic request."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from . import conversation, saved_audio_trial, trial_gate, trial_budget
except ImportError:
    import conversation, saved_audio_trial, trial_gate, trial_budget

ROOT = Path(__file__).resolve().parents[1]
TRIAL_ROOT = ROOT / 'runtime/synthetic-trial/browser-metered-qa'
BINDING_PATH = TRIAL_ROOT / 'current-text-trial.json'
SCHEMA = 'noreset-current-text-trial-v1'
MODEL_URL = 'https://api.deepseek.com/chat/completions'


def _deny():
    raise trial_gate.TrialGateError()


def is_installed():
    """Keep a missing/expired/used grant fail-closed while its root binding exists."""
    return BINDING_PATH.exists() or BINDING_PATH.is_symlink()


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _scope_paths(binding):
    receipt_path, state_path = Path(binding['receipt_path']), Path(binding['state_path'])
    root = TRIAL_ROOT.resolve()
    if (not receipt_path.is_absolute() or not state_path.is_absolute()
            or receipt_path != receipt_path.resolve() or state_path != state_path.resolve()
            or receipt_path.name != 'authorization.json' or state_path.name != 'ledger.sqlite3'
            or receipt_path.parent != state_path.parent or receipt_path.parent.parent != root
            or not receipt_path.is_file() or not state_path.is_file()
            or receipt_path.is_symlink() or state_path.is_symlink()
            or receipt_path.stat().st_nlink != 1 or state_path.stat().st_nlink != 1):
        _deny()
    return receipt_path, state_path, receipt_path.parent


def _load():
    binding = saved_audio_trial._read(BINDING_PATH)
    if (set(binding) != {'schema_version', 'grant_id', 'receipt_path', 'state_path', 'http_payload_sha256'}
            or binding['schema_version'] != SCHEMA
            or not isinstance(binding['grant_id'], str)
            or len(binding['grant_id']) != 32
            or any(char not in '0123456789abcdef' for char in binding['grant_id'])
            or not isinstance(binding['http_payload_sha256'], str)
            or not trial_gate.HASH.fullmatch(binding['http_payload_sha256'])):
        _deny()
    receipt_path, state_path, scope_dir = _scope_paths(binding)
    claim = scope_dir / ('claim-' + binding['grant_id'] + '.json')
    if claim.exists() or claim.is_symlink():
        _deny()

    status = trial_gate.validate_trial_authorization(receipt_path=receipt_path, state_path=state_path)
    receipt = status['receipt']
    profile = receipt.get('profiles', {}).get('llm', {})
    lifetime = datetime.fromisoformat(receipt['expires_at']) - datetime.fromisoformat(receipt['approved_at'])
    if (receipt.get('schema_version') != trial_gate.SCHEMA_RISK_SEQUENCE
            or receipt.get('request_sequence') != ['llm'] or receipt.get('total_requests') != 1
            or receipt.get('planned_text_requests') != 1 or set(receipt.get('profiles', {})) != {'llm'}
            or not timedelta(0) < lifetime <= timedelta(minutes=20)
            or profile.get('requests') != 1 or profile.get('provider') not in {'deepseek', 'deepseek-ai'}
            or profile.get('model') not in {'deepseek-flash', 'deepseek-v4-flash'}
            or profile.get('url') != MODEL_URL or profile.get('max_input_bytes') != 24000
            or profile.get('max_output_tokens') != 2048 or profile.get('max_thinking_tokens') != 0
            or len(profile.get('source_sha256', [])) != 1 or len(profile.get('request_sha256', [])) != 1
            or status.get('remaining_requests') != 1 or status.get('scope_used_requests') != 0
            or status.get('next_kind') != 'llm' or status.get('manual_review_required') is not False):
        _deny()

    with sqlite3.connect(state_path.as_uri() + '?mode=ro', uri=True) as db:
        native = trial_gate._standalone_context(db, receipt)
    root = trial_budget.native_root_binding(receipt['cumulative_budget'],
        receipt_id=receipt['receipt_id'], include_scope=True)
    if (native is None or root.get('status') != 'active' or root.get('closure_reason') is not None
            or root.get('receipt') != receipt or root.get('allocations') != []
            or root.get('binding') != native
            or native.get('state_path') != str(state_path)
            or native.get('receipt_sha256') != status['receipt_sha256']):
        _deny()

    manifest_raw = trial_gate._root_file(native['manifest_path'], 65536)
    if _sha(manifest_raw) != native['manifest_sha256']:
        _deny()
    manifest = json.loads(manifest_raw, object_pairs_hook=trial_gate._unique_object)
    pairs = manifest.get('request_pairs')
    if not isinstance(pairs, list) or len(pairs) != 1:
        _deny()
    pair = pairs[0]
    payload_raw = trial_gate._root_file(pair['model_payload_path'], 65536)
    if _sha(payload_raw) != pair['model_payload_sha256']:
        _deny()
    frozen_payload = json.loads(payload_raw, object_pairs_hook=trial_gate._unique_object)
    serialized = json.dumps(frozen_payload, ensure_ascii=False, allow_nan=False).encode('utf-8')
    if (_sha(serialized) != pair['source_sha256']
            or pair['source_sha256'] != profile['source_sha256'][0]
            or pair['request_sha256'] != profile['request_sha256'][0]):
        _deny()
    return binding, status, frozen_payload, claim, receipt_path, state_path


def available_grant():
    """Read-only UI metadata; the real authority stays in the native receipt."""
    try:
        binding, status, _, _, _, _ = _load()
        return {'grant_id': binding['grant_id'], 'receipt_id': status['receipt']['receipt_id'],
                'receipt_sha256': status['receipt_sha256'], 'expires_at': status['receipt']['expires_at'],
                'http_payload_sha256': binding['http_payload_sha256'], 'remaining_requests': 1,
                'kind': 'llm', 'retries': 0}
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError, AttributeError,
            RecursionError, trial_gate.TrialGateError):
        return None


class _CapturedModelPayload(Exception):
    pass


class _CaptureProvider:
    def __init__(self):
        self.payload = None
        self.calls = 0

    def complete_json(self, _prompt, payload):
        self.calls += 1
        self.payload = deepcopy(payload)
        raise _CapturedModelPayload()


def _matches_current_payload(body, frozen_payload):
    capture = _CaptureProvider()
    try:
        conversation.conversation_turn(body, capture)
    except _CapturedModelPayload:
        pass
    if capture.calls != 1 or capture.payload is None:
        _deny()
    current = json.dumps(capture.payload, ensure_ascii=False, allow_nan=False).encode('utf-8')
    frozen = json.dumps(frozen_payload, ensure_ascii=False, allow_nan=False).encode('utf-8')
    if current != frozen:
        _deny()


def _claim(path, grant_id, body_sha):
    data = json.dumps({'grant_id': grant_id, 'http_payload_sha256': body_sha,
                       'claimed_at': datetime.now(timezone.utc).isoformat()}, separators=(',', ':')).encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def run_turn(grant_id, body, callback):
    """Bind the HTTP input to the normalized native payload before one send."""
    try:
        binding, _, frozen_payload, claim, receipt_path, state_path = _load()
        body_sha = saved_audio_trial.http_sha(body)
        if grant_id != binding['grant_id'] or body_sha != binding['http_payload_sha256']:
            _deny()
        # This invokes the actual clinical-input normalizer with a recorder, not a
        # model client. The native manifest must approve exactly this payload.
        _matches_current_payload(body, frozen_payload)
        current, _, current_payload, current_claim, current_receipt, current_state = _load()
        if (current != binding or current_payload != frozen_payload or current_claim != claim
                or current_receipt != receipt_path or current_state != state_path
                or saved_audio_trial.http_sha(body) != body_sha):
            _deny()
        _claim(claim, grant_id, body_sha)
        with trial_gate.standalone_trial_scope(receipt_path=receipt_path, state_path=state_path):
            return callback(body)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError, sqlite3.Error):
        raise trial_gate.TrialGateError() from None
