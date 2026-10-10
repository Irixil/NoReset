"""Recorded synthetic usage shape, offline callback into a TEMP ledger only."""
import copy
import json
from urllib.request import Request

import pytest

from backend import model_client, trial_gate
from tests.test_trial_append_20261009 import history
from tests.test_trial_informed_risk_20261009 import activate, send


def envelope():
    # Exact actual synthetic ASR1 model/usage shape; no HTTP headers or credentials.
    return {'modelVersion': 'gemini-2.5-flash-lite',
            'usageMetadata': {'promptTokenCount': 180, 'candidatesTokenCount': 10, 'totalTokenCount': 190}}


def callback(history, value):
    meter, document = activate(history)
    ident = send(meter, document, 'asr', report=False)
    request = Request(document['profiles']['asr']['url'], data=b'not-sent-offline-only')
    request._noreset_trial_attempt_id = ident
    request._noreset_trial_state_path = meter.state_path
    raw = json.dumps(value).encode()
    model_client._trial_report(request, value, raw, protocol='gemini')
    return meter, request, ident


@pytest.mark.parametrize('thoughts', ['omitted', 0])
def test_balanced_recorded_zero_thought_usage_reports_to_temp_ledger(history, thoughts):
    value = envelope()
    if thoughts != 'omitted': value['usageMetadata']['thoughtsTokenCount'] = thoughts
    original = copy.deepcopy(value)
    meter, _, ident = callback(history, value)
    usage = trial_gate.trial_journal(state_path=meter.state_path)[-1]['usage']
    assert usage == {'returned_model': 'gemini-2.5-flash-lite', 'prompt_tokens': 180,
                     'completion_tokens': 10, 'reasoning_tokens': 0, 'verified': True}
    assert value == original  # Preserve recorded envelope verbatim.
    assert ident == 4 and len(trial_gate.trial_journal(state_path=meter.state_path)) == 4


@pytest.mark.parametrize('mutate', [
    lambda v: v['usageMetadata'].update(totalTokenCount=191),
    lambda v: v['usageMetadata'].pop('totalTokenCount'),
    lambda v: v['usageMetadata'].pop('promptTokenCount'),
    lambda v: v['usageMetadata'].pop('candidatesTokenCount'),
    lambda v: v['usageMetadata'].update(thoughtsTokenCount=None),
    lambda v: v['usageMetadata'].update(thoughtsTokenCount=-1, totalTokenCount=189),
    lambda v: v['usageMetadata'].update(thoughtsTokenCount=True, totalTokenCount=191),
    lambda v: v['usageMetadata'].update(promptTokenCount=True),
    lambda v: v['usageMetadata'].update(candidatesTokenCount=-1, totalTokenCount=179),
    lambda v: v['usageMetadata'].update(totalTokenCount=True),
    lambda v: v['usageMetadata'].update(toolUsePromptTokenCount=1),
    lambda v: v['usageMetadata'].update(toolUsePromptTokenCount=True),
    lambda v: v['usageMetadata'].update(toolUsePromptTokenCount=None),
    lambda v: v.update(modelVersion='unknown-model'),
])
def test_missing_or_invalid_usage_is_never_repaired_as_zero(history, mutate):
    value = envelope(); mutate(value)
    with pytest.raises(model_client.ModelClientError): callback(history, value)


def test_explicit_nonzero_thoughts_are_preserved_by_normalization(monkeypatch, tmp_path):
    # Isolate normalization: the real thinking=0 gate separately rejects nonzero.
    value = envelope(); value['usageMetadata'].update(thoughtsTokenCount=3, totalTokenCount=193)
    captured = []
    monkeypatch.setattr(trial_gate, 'report_usage', lambda ident, model, usage, **kwargs: captured.append(usage))
    request = Request('https://aihubmix.com/no-external-call', data=b'offline')
    request._noreset_trial_attempt_id = 1; request._noreset_trial_state_path = tmp_path / 'never-opened'
    model_client._trial_report(request, value, json.dumps(value).encode(), protocol='gemini')
    assert captured == [{'prompt_tokens': 180, 'completion_tokens': 13,
                         'completion_tokens_details': {'reasoning_tokens': 3}}]
