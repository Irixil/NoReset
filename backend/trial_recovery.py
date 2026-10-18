"""Trusted local, append-only recovery of a setup that never sent a request.

This does not reopen a failed receipt. A separate new receipt consumes exactly
one recovery record; the original claim, failed state and closed budget survive.
There is deliberately no HTTP or environment-flag activation route.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
from itertools import zip_longest
from pathlib import Path


def _hash(raw):
    return hashlib.sha256(raw).hexdigest()


def _raw(path):
    path = Path(path).absolute()
    if path != path.resolve() or not path.is_file() or path.is_symlink():
        raise ValueError('regular canonical file required')
    return path.read_bytes()


def _json(raw):
    from .trial_gate import _unique_object
    return json.loads(raw, object_pairs_hook=_unique_object)


def _exclusive_json(path, value):
    from .trial_gate import _snapshot
    raw = _snapshot(value).encode()
    path = Path(path)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    return raw


def _assert_owner_stopped(owner, failed_receipt, failed_state):
    """Direct live observation supplements the trusted executor's exit record."""
    fields = {'schema_version', 'status', 'failed_receipt_sha256',
              'failed_state_path', 'host_session_id', 'exit_code', 'owned_command_paths'}
    if (set(owner) != fields or owner['schema_version'] != 'noreset-owner-exit-evidence-v1'
            or owner['status'] != 'host_executor_reported_exit'
            or not isinstance(owner['host_session_id'], str) or not owner['host_session_id']
            or type(owner['exit_code']) is not int
            or owner['failed_receipt_sha256'] != _hash(failed_receipt)
            or owner['failed_state_path'] != str(failed_state)
            or not isinstance(owner['owned_command_paths'], list) or not owner['owned_command_paths']
            or any(not isinstance(p, str) or str(Path(p).resolve()) != p for p in owner['owned_command_paths'])):
        raise ValueError('trusted owner completion evidence required')
    observation = subprocess.run(['ps', 'ax', '-ww', '-o', 'pid=,ppid=,command='],
                                 check=True, capture_output=True, text=True, timeout=10)
    processes = {}
    for line in observation.stdout.splitlines():
        pid, parent, command = line.strip().split(None, 2)
        processes[int(pid)] = (int(parent), command)
    if os.getpid() not in processes:
        raise ValueError('incomplete process observation')
    ancestors, current = set(), os.getpid()
    while current and current not in ancestors:
        ancestors.add(current)
        current = processes.get(current, (0, ''))[0]
    needles = [str(failed_state), str(failed_state.parent),
               _json(failed_receipt)['receipt_id'], *owner['owned_command_paths']]
    if any(pid not in ancestors and any(n in command for n in needles)
           for pid, (_, command) in processes.items()):
        raise ValueError('failed owner may still be running')


def _verify_failed_copy(source_raw, failed_state, old_receipt_raw):
    """An exclusive read transaction and every table show setup rolled back."""
    from . import trial_gate as gate
    old, old_sha = gate._parse_receipt(old_receipt_raw, historical=True)
    # read/write URI is needed for EXCLUSIVE; no SQL writes or metadata updates.
    if any(Path(str(failed_state)+suffix).exists() for suffix in ('-wal', '-shm', '-journal')):
        raise ValueError('failed copy has a live sidecar')
    before = failed_state.stat()
    identity = (before.st_dev, before.st_ino)
    with sqlite3.connect(':memory:') as source, sqlite3.connect(
            failed_state.as_uri() + '?mode=rw', uri=True, timeout=0) as failed:
        source.deserialize(source_raw)
        failed.execute('BEGIN EXCLUSIVE')
        try:
            current = failed_state.stat()
            if (current.st_dev, current.st_ino) != identity:
                raise ValueError('failed copy replaced before locking')
            expected = (old_sha, gate._budget_digest(old), gate._snapshot(old), 'successor_setup_failed')
            if failed.execute('SELECT * FROM metadata').fetchall() != [expected]:
                raise ValueError('not a rolled-back setup')
            schemas = source.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
            if failed.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall() != schemas:
                raise ValueError('failed setup added a table')
            for name, _ in schemas:
                if name == 'metadata':
                    continue
                if not gate.re.fullmatch('[a-z_]+', name):
                    raise ValueError('invalid table name')
                for a, b in zip_longest(source.execute(f'SELECT * FROM {name} ORDER BY rowid'),
                                       failed.execute(f'SELECT * FROM {name} ORDER BY rowid')):
                    if a != b:
                        raise ValueError('failed setup changed history')
            if failed.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise ValueError('failed copy corrupt')
            verified_raw = _raw(failed_state)
            current = failed_state.stat()
            if (current.st_dev, current.st_ino) != identity:
                raise ValueError('failed copy replaced while locked')
            if any(Path(str(failed_state)+suffix).exists() for suffix in ('-wal', '-shm', '-journal')):
                raise ValueError('failed copy gained a live sidecar')
        finally:
            failed.rollback()
    current = failed_state.stat()
    if (current.st_dev, current.st_ino) != identity:
        raise ValueError('failed copy replaced after locking')
    return verified_raw, identity


def append_failed_setup_recovery(*, previous_receipt_path, previous_state_path,
                                failed_receipt_path, failed_state_path, closure_path,
                                failure_evidence_path, owner_exit_evidence_path):
    """Called only by the trusted local owner after executor-confirmed exit.

    Repeating this preparation is idempotent. It creates no allowance and does
    not register, activate, reserve, close, refund or edit any budget/state.
    """
    from . import trial_gate as gate, trial_budget
    root = gate.CONTINUATION_CLAIM_ROOT.resolve()
    source, failed_state = Path(previous_state_path).resolve(), Path(failed_state_path).resolve()
    old_raw, source_raw = _raw(previous_receipt_path), _raw(previous_state_path)
    failed_raw = _raw(failed_receipt_path)
    closure_raw, evidence_raw = _raw(closure_path), _raw(failure_evidence_path)
    closure, _, _, _ = gate._successor_source(source_raw, old_raw, closure_raw,
                                             evidence_raw, failed_raw, str(source))
    failed_receipt, failed_sha = gate._parse_receipt(failed_raw, historical=True)
    claim_path = root / gate._successor_claim_name(closure)
    claim_raw = _raw(claim_path)
    expected_claim = {'schema_version': 'noreset-scope-successor-claim-v1',
        'previous_receipt_sha256': closure['previous_receipt_sha256'],
        'previous_attempts_sha256': closure['previous_attempts_sha256'],
        'previous_state_sha256': closure['previous_state_sha256'],
        'new_receipt_sha256': failed_sha, 'closure_sha256': _hash(closure_raw),
        'state_path': str(failed_state)}
    if _json(claim_raw) != expected_claim:
        raise ValueError('failed claim does not match')
    owner_raw = _raw(owner_exit_evidence_path)
    _assert_owner_stopped(_json(owner_raw), failed_raw, failed_state)
    budget = trial_budget.batch_status(failed_receipt['cumulative_budget'], receipt=failed_receipt)
    if budget['allocations'] != 0 or budget['global_active_batches'] != 0:
        raise ValueError('failed setup has allocation or another active batch')
    failed_state_raw, failed_identity = _verify_failed_copy(source_raw, failed_state, old_raw)
    # Never rely on a single observation if a file changed during inspection.
    current = failed_state.stat()
    if ((current.st_dev, current.st_ino) != failed_identity
            or _raw(previous_state_path) != source_raw or _raw(claim_path) != claim_raw
            or _raw(failed_state) != failed_state_raw or _raw(owner_exit_evidence_path) != owner_raw
            or any(Path(str(failed_state)+s).exists() for s in ('-wal', '-shm', '-journal'))):
        raise ValueError('predecessor changed during recovery')
    body = {'schema_version': 'noreset-failed-setup-recovery-v1',
        'status': 'failed_setup_permanently_terminated',
        'failed_claim_path': str(claim_path), 'failed_claim_sha256': _hash(claim_raw),
        'failed_receipt_path': str(Path(failed_receipt_path).resolve()), 'failed_receipt_sha256': failed_sha,
        'failed_state_path': str(failed_state), 'failed_state_sha256': _hash(failed_state_raw),
        'previous_state_path': str(source), 'previous_state_sha256': _hash(source_raw),
        'previous_receipt_sha256': _hash(old_raw),
        'owner_exit_evidence_path': str(Path(owner_exit_evidence_path).resolve()),
        'owner_exit_evidence_sha256': _hash(owner_raw),
        'verified_failed_allocations': 0, 'verified_global_active_batches_at_preparation': 0}
    path = root / ('failed-setup-recovery-' + _hash(claim_raw) + '.json')
    if path.exists():
        if _json(_raw(path)) != body:
            raise ValueError('different recovery already exists')
    else:
        _exclusive_json(path, body)
    return {'recovery_path': str(path), 'recovery_sha256': _hash(_raw(path)), 'creates_allowance': False}


def verify_recovery(path, *, source_path, source_sha256, old_receipt_sha256, observe_owner=False):
    """Immutable proof rechecked at activation and while validating history."""
    from . import trial_gate as gate, trial_budget
    root = gate.CONTINUATION_CLAIM_ROOT.resolve()
    path = Path(path).absolute()
    if (path.parent != root or path != path.resolve()
            or not gate.re.fullmatch('failed-setup-recovery-[a-f0-9]{64}\\.json', path.name)):
        raise ValueError('canonical recovery identity required')
    raw = _raw(path)
    proof = _json(raw)
    fields = {'schema_version', 'status', 'failed_claim_path', 'failed_claim_sha256',
              'failed_receipt_path', 'failed_receipt_sha256', 'failed_state_path', 'failed_state_sha256',
              'previous_state_path', 'previous_state_sha256', 'previous_receipt_sha256',
              'owner_exit_evidence_path', 'owner_exit_evidence_sha256',
              'verified_failed_allocations', 'verified_global_active_batches_at_preparation'}
    if (set(proof) != fields or proof['schema_version'] != 'noreset-failed-setup-recovery-v1'
            or proof['status'] != 'failed_setup_permanently_terminated'
            or proof['previous_state_path'] != str(Path(source_path).resolve())
            or proof['previous_state_sha256'] != source_sha256
            or proof['previous_receipt_sha256'] != old_receipt_sha256
            or type(proof['verified_failed_allocations']) is not int or proof['verified_failed_allocations'] != 0
            or type(proof['verified_global_active_batches_at_preparation']) is not int
            or proof['verified_global_active_batches_at_preparation'] != 0):
        raise ValueError('invalid recovery')
    if Path(path).absolute() != root / ('failed-setup-recovery-' + proof['failed_claim_sha256'] + '.json'):
        raise ValueError('recovery identity mismatch')
    claim_raw, failed_raw = _raw(proof['failed_claim_path']), _raw(proof['failed_receipt_path'])
    claim = _json(claim_raw)
    if (_hash(claim_raw) != proof['failed_claim_sha256']
            or _hash(failed_raw) != proof['failed_receipt_sha256']
            or _hash(_raw(proof['failed_state_path'])) != proof['failed_state_sha256']
            or _hash(_raw(proof['owner_exit_evidence_path'])) != proof['owner_exit_evidence_sha256']
            or claim['previous_state_sha256'] != source_sha256
            or claim['previous_receipt_sha256'] != old_receipt_sha256
            or claim['state_path'] != proof['failed_state_path']
            or claim['new_receipt_sha256'] != proof['failed_receipt_sha256']):
        raise ValueError('changed failure proof')
    failed_receipt, _ = gate._parse_receipt(failed_raw, historical=True)
    budget = trial_budget.batch_status(failed_receipt['cumulative_budget'], receipt=failed_receipt)
    if budget['allocations'] != 0:
        raise ValueError('failed batch has an allocation')
    if observe_owner:
        if budget['global_active_batches'] != 0:
            raise ValueError('another batch active before recovery activation')
        _assert_owner_stopped(_json(_raw(proof['owner_exit_evidence_path'])),
                              failed_raw, Path(proof['failed_state_path']))
    return proof, _hash(raw)


def consume_recovery(path, *, source_path, source_sha256, old_receipt_sha256, new_receipt_sha256, target):
    from . import trial_gate as gate
    proof, digest = verify_recovery(path, source_path=source_path,
        source_sha256=source_sha256, old_receipt_sha256=old_receipt_sha256, observe_owner=True)
    consumed = {'schema_version': 'noreset-failed-setup-consumption-v1',
        'failed_claim_sha256': proof['failed_claim_sha256'], 'recovery_sha256': digest,
        'new_receipt_sha256': new_receipt_sha256, 'state_path': str(Path(target).resolve())}
    # Fixed old-claim identity: changing recovery JSON cannot fork this origin.
    consume_path = gate.CONTINUATION_CLAIM_ROOT.resolve() / ('failed-setup-consumed-' + proof['failed_claim_sha256'] + '.json')
    if consume_path.exists():
        if _json(_raw(consume_path)) != consumed or Path(target).exists():
            raise ValueError('recovery already consumed by another target')
    else:
        _exclusive_json(consume_path, consumed)
    return proof, digest, str(consume_path)


def verify_consumed_recovery(path, *, source_path, source_sha256, old_receipt_sha256,
                             new_receipt_sha256, target, expected_failed_claim_path,
                             observe_owner=False):
    """Consume before registering the new batch; afterwards check that binding."""
    from . import trial_gate as gate
    proof, digest = verify_recovery(path, source_path=source_path,
        source_sha256=source_sha256, old_receipt_sha256=old_receipt_sha256)
    if proof['failed_claim_path'] != str(Path(expected_failed_claim_path).resolve()):
        raise ValueError('recovery does not terminate this logical predecessor')
    if new_receipt_sha256 == proof['failed_receipt_sha256']:
        raise ValueError('failed receipt cannot be reopened')
    consume_path = gate.CONTINUATION_CLAIM_ROOT.resolve() / ('failed-setup-consumed-' + proof['failed_claim_sha256'] + '.json')
    expected = {'schema_version': 'noreset-failed-setup-consumption-v1',
        'failed_claim_sha256': proof['failed_claim_sha256'], 'recovery_sha256': digest,
        'new_receipt_sha256': new_receipt_sha256, 'state_path': str(Path(target).resolve())}
    if _json(_raw(consume_path)) != expected:
        raise ValueError('different or unconsumed recovery')
    if observe_owner:
        _assert_owner_stopped(_json(_raw(proof['owner_exit_evidence_path'])),
                             _raw(proof['failed_receipt_path']), Path(proof['failed_state_path']))
    return proof, digest, str(consume_path)
