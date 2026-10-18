"""Generated tone and temporary ledgers only; no human audio or network."""
import base64
import json
import subprocess
from pathlib import Path

import pytest

from backend import recognition, trial_budget as budget, trial_gate as gate
from tests.test_memory_trial_gate_20261010 import offline_temp_only, activate, save, sha
from tests.test_standalone_asr_llm_pair_20261010 import pair_fixture, reserve_asr


def webm(tmp_path, seconds=0.2):
    executable = recognition.ffmpeg_executable()
    if not executable:
        pytest.skip('project FFmpeg runtime unavailable')
    target = tmp_path / f'tone-{seconds}.webm'
    subprocess.run([executable, '-nostdin', '-v', 'error', '-f', 'lavfi',
                    '-i', 'sine=frequency=440:sample_rate=48000', '-t', str(seconds),
                    '-c:a', 'libopus', '-y', str(target)], check=True, timeout=10)
    return target.read_bytes()


def wire(raw, mime='audio/webm'):
    return json.dumps({'contents': [{'role': 'user', 'parts': [{'inlineData': {
        'mimeType': mime, 'data': base64.b64encode(raw).decode()}}]}],
        'generationConfig': {'maxOutputTokens': 1024,
        'thinkingConfig': {'thinkingBudget': 0, 'includeThoughts': False}}}).encode()


def microphone_fixture(tmp_path, monkeypatch):
    f = pair_fixture(tmp_path, monkeypatch)
    raw = webm(tmp_path)
    f['asr_wire'] = wire(raw)
    receipt = f['receipt']
    receipt.update(request_sequence=['asr'], total_requests=1, planned_text_requests=0)
    receipt['profiles'].pop('llm')
    receipt['spend_authorization']['estimated_new_usd'] = '0.001024'
    receipt['profiles']['asr'].update(case_profile=gate.ASR_MIC_CASE_PROFILE,
        source_sha256=[sha(raw)], request_sha256=[sha(f['asr_wire'])])
    pair = f['manifest']['request_pairs'][0]
    Path(pair['audio_path']).write_bytes(raw)
    Path(pair['wire_path']).write_bytes(f['asr_wire'])
    pair.update(source_sha256=sha(raw), request_sha256=sha(f['asr_wire']))
    f['manifest']['request_pairs'] = [pair]
    f['manifest']['receipt_sha256'] = save(f['receipt_path'], receipt)
    f['manifest_sha256'] = save(f['manifest_path'], f['manifest'])
    return f


def test_full_webm_reserves_once_and_preserves_original_budget(tmp_path, monkeypatch):
    f = microphone_fixture(tmp_path, monkeypatch)
    assert activate(f)['remaining_requests'] == 1
    assert reserve_asr(f) == 1
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']
    gate.report_usage(1, 'gemini-2.5-flash-lite', {'prompt_tokens': 12,
        'completion_tokens': 3, 'completion_tokens_details': {'reasoning_tokens': 0}},
        state_path=f['state_path'], transport_metadata={'response_sha256': sha(b'fixture'),
        'response_bytes': 7, 'protocol': 'gemini'})
    with pytest.raises(gate.TrialGateError):
        reserve_asr(f)
    assert budget.budget_snapshot(f['descriptor'])['batches'][-1]['status'] == 'closed'


@pytest.mark.parametrize('change', ['hash', 'mime', 'legacy', 'garbage', 'long', 'large'])
def test_webm_scope_rejects_changed_or_unbounded_audio(tmp_path, change):
    raw = webm(tmp_path, 45.1 if change == 'long' else 0.2)
    if change == 'garbage': raw = b'\x1a\x45\xdf\xa3broken'
    if change == 'large': raw += b'x' * gate.ASR_LONG_MAX_BYTES
    with pytest.raises(gate.TrialGateError):
        gate._risk_audio(wire(raw, 'audio/wav' if change == 'mime' else 'audio/webm'),
            '0' * 64 if change == 'hash' else sha(raw),
            None if change == 'legacy' else gate.ASR_MIC_CASE_PROFILE)


@pytest.mark.parametrize('change', ['two_asr', 'asr_then_llm', 'unknown_profile', 'missing_decoder'])
def test_microphone_profile_cannot_expand_scope(tmp_path, monkeypatch, change):
    f = microphone_fixture(tmp_path, monkeypatch)
    if change == 'missing_decoder':
        monkeypatch.setattr(recognition, 'ffmpeg_executable', lambda: None)
    elif change == 'unknown_profile':
        f['receipt']['profiles']['asr']['case_profile'] = 'unapproved-webm'
    else:
        f['receipt']['request_sequence'].append('asr' if change == 'two_asr' else 'llm')
        f['receipt']['total_requests'] = 2
    f['manifest']['receipt_sha256'] = save(f['receipt_path'], f['receipt'])
    f['manifest_sha256'] = save(f['manifest_path'], f['manifest'])
    with pytest.raises(gate.TrialGateError):
        activate(f)
    assert not f['state_path'].exists()
    assert budget.cumulative_row_seal(f['descriptor'], baseline=f['baseline']) == f['baseline']
