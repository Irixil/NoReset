"""Adversarial tests of the evidence boundary, not a claim of clinical validity."""
import hashlib
import json
import urllib.error

import pytest

from backend.adapter import (
    AdapterError, Config, DeepSeekProvider, ModelScopeProvider, MockProvider,
    PROMPT_SHA256, PROMPT_VERSION, SCHEMA_VERSION, build_prompt,
    organize_event, payload_sha256, validate_output,
)


@pytest.fixture
def payload():
    return {'record_id': 'current', 'raw_text': '散步，膝盖疼。',
            'source_kind': 'elder', 'recorded_at': '2026-09-12T08:00:00+08:00'}


def draft(payload):
    return MockProvider().complete_json(build_prompt(), payload)


def assert_rejected(payload, change, match=None):
    out = draft(payload)
    change(out)
    with pytest.raises(AdapterError, match=match):
        validate_output(out, payload['raw_text'], payload)


def test_full_raw_allows_only_outer_whitespace_change(payload):
    payload['raw_text'] = '  散步，膝盖疼。  '
    out = organize_event(payload, MockProvider())['output']
    assert out['summary'] == payload['raw_text'].strip()
    assert out['claims'][0]['quote'] == payload['raw_text'].strip()


def test_even_plausible_short_excerpt_is_rejected(payload):
    assert_rejected(payload, lambda out: out.update(summary='膝盖疼'), 'summary')
    assert_rejected(payload, lambda out: out['claims'][0].update(text='膝盖疼', quote='膝盖疼'), 'claim.quote')

def test_reviewed_document_unknowns_cannot_be_completed_by_the_organizing_model(payload):
    payload.update(source_kind='document', raw_text='[标题被裁切，无法辨认]\nRBC 4.53 [单位无法辨认]\nMCV [无法辨认]')
    payload['source_review'] = {'method': 'original_comparison', 'text': payload['raw_text'], 'confirmed_at': '2026-10-01'}
    class Guessing(MockProvider):
        def complete_json(self, prompt, evidence):
            out = super().complete_json(prompt, evidence)
            out['summary'] = '血常规\nRBC 4.53 10^12/L\nMCV 90'
            return out
    with pytest.raises(AdapterError, match='summary'):
        organize_event(payload, Guessing())
    assert organize_event(payload, MockProvider())['output']['summary'] == payload['raw_text']


@pytest.mark.parametrize('action', ['diagnosis', 'medication_change', 'source_overwrite', 'invented_time_or_dose'])
def test_model_reported_forbidden_action_blocks_otherwise_valid_draft(payload, action):
    assert_rejected(payload, lambda out: out.update(forbidden_actions=[action]), '禁行动')


def test_long_raw_is_preserved_and_not_truncated(payload):
    payload['raw_text'] = '散步感觉还可以。' * 100 + '没有胸痛。'
    out = organize_event(payload, MockProvider())['output']
    assert out['summary'] == payload['raw_text']
    assert out['claims'][0]['quote'] == payload['raw_text']


@pytest.mark.parametrize('quote', ['', ' ', None, '膝盖痛', '膝盖，疼'])
def test_empty_null_or_rewritten_quote_rejected(payload, quote):
    assert_rejected(payload, lambda out: out['claims'][0].update(quote=quote), r'claim.quote')


def test_record_id_cannot_borrow_another_records_quote(payload):
    payload['history'] = [{'record_id': 'old', 'raw_text': '食欲变差。', 'source_kind': 'elder'}]
    assert_rejected(payload, lambda out: out['claims'][0].update(record_id='old'), r'claim.quote')


def test_history_claim_uses_its_own_source_and_raw_text(payload):
    payload['history'] = [{'record_id': 'old', 'raw_text': '食欲变差。', 'source_kind': 'family_report'}]
    out = draft(payload)
    out['claims'].append({'record_id': 'old', 'quote': '食欲变差。', 'text': '食欲变差。', 'source_kind': 'family_report'})
    assert validate_output(out, payload['raw_text'], payload) == out
    out['claims'][-1]['source_kind'] = 'clinician_evidence'
    with pytest.raises(AdapterError, match='source_kind'):
        validate_output(out, payload['raw_text'], payload)


@pytest.mark.parametrize('source', ['clinician_evidence', 'document', 'family_report', 'system'])
def test_model_cannot_relabel_current_source(payload, source):
    assert_rejected(payload, lambda out: out['claims'][0].update(source_kind=source), 'source_kind')


def test_missing_source_stays_unknown_even_when_raw_mentions_doctor(payload):
    payload.pop('source_kind')
    payload['raw_text'] = '家属说医生提过一种药。'
    out = organize_event(payload, MockProvider())['output']
    assert out['claims'][0]['source_kind'] == 'unknown'
    out['claims'][0]['source_kind'] = 'clinician_evidence'
    with pytest.raises(AdapterError, match='source_kind'):
        validate_output(out, payload['raw_text'], payload)


def test_explicit_clinician_source_is_preserved_without_claiming_verified_identity(payload):
    payload['source_kind'] = 'clinician_evidence'
    assert organize_event(payload, MockProvider())['output']['claims'][0]['source_kind'] == 'clinician_evidence'


def test_ai_summary_is_never_primary_history_evidence(payload):
    payload['history'] = [{'record_id': 'old', 'summary': '阿司匹林100毫克', 'source_kind': 'document'}]
    assert_rejected(payload, lambda out: out['claims'][0].update(record_id='old', quote='阿司匹林100毫克', text='阿司匹林100毫克'), 'record_id')


def test_history_model_summary_cannot_override_existing_raw(payload):
    payload['history'] = [{'record_id': 'old', 'raw_text': '食欲一般。', 'summary': '阿司匹林100毫克', 'source_kind': 'document'}]
    assert_rejected(payload, lambda out: out['claims'][0].update(record_id='old', source_kind='document', quote='阿司匹林100毫克', text='阿司匹林100毫克'), 'quote')


def test_duplicate_record_id_with_conflicting_evidence_rejected(payload):
    payload['history'] = [{'record_id': 'current', 'raw_text': '另一份原文。', 'source_kind': 'elder'}]
    with pytest.raises(AdapterError, match='歧义证据'):
        validate_output(draft(payload), payload['raw_text'], payload)


@pytest.mark.parametrize('present,refs', [
    (True, ['current', 'invented']), (True, ['current']),
    (True, ['old']), (True, ['old', 'other']), (True, ['current', 'old', 'old']),
    (False, ['old']), (True, ['', 'old']),
])
def test_invalid_conflict_references_rejected(payload, present, refs):
    payload['history'] = [{'record_id': 'old', 'raw_text': '食欲变差。', 'source_kind': 'elder'},
                          {'record_id': 'other', 'raw_text': '食欲好。', 'source_kind': 'elder'}]
    assert_rejected(payload, lambda out: out.update(conflict={'present': present, 'record_refs': refs}), '冲突|conflict')


def test_real_conflict_retains_both_record_ids(payload):
    payload['raw_text'] = '血压165/95。'
    payload['history'] = [{'record_id': 'old', 'raw_text': '血压145/88。', 'source_kind': 'family_observation'}]
    conflict = organize_event(payload, MockProvider())['output']['conflict']
    assert conflict == {'present': True, 'record_refs': ['current', 'old']}


@pytest.mark.parametrize('summary', [
    '今天服用了阿司匹林100毫克', '诊断为脑梗', '可以把药量加倍',
    '不需要去医院', '请自行停用降压药', '药量调整为两倍',
    '建议加\u200b倍剂量', '你没事，回家休息即可',
])
def test_generated_medical_facts_or_advice_rejected(payload, summary):
    assert_rejected(payload, lambda out: out.update(summary=summary))


def test_claim_cannot_invent_fact_while_retaining_valid_quote(payload):
    assert_rejected(payload, lambda out: out['claims'][0].update(text='今天服用了阿司匹林100毫克'), 'claim.text')


@pytest.mark.parametrize('question', ['是否服用了阿司匹林100毫克？', '可以把药量加倍。', '不需要去医院。'])
def test_free_generated_followup_rejected(payload, question):
    assert_rejected(payload, lambda out: out.update(follow_up_questions=[question]))


@pytest.mark.parametrize('raw,excerpt', [
    ('没有胸痛。', '胸痛'), ('昨天胸痛，现在没有了。', '胸痛'),
    ('这是不是药物副作用？', '药物副作用'), ('胸痛已经缓解。', '胸痛'),
    ('可能服了药。', '服了药'), ('血压是不是180/110？', '180/110'),
    ('没有胸痛。老人说没有胸痛。', '胸痛'),
    ('药盒写着每次10毫克。', '0毫克'),
    ('收缩压180毫米汞柱。', '80毫米汞柱'),
    ('女儿说她胸痛，老人吃饭睡觉都好。', '胸痛'),
    ('家属已撤回以下转述。可以把药量加倍。', '可以把药量加倍。'),
    ('女儿说“可以把药量加倍”是错误建议。', '可以把药量加倍'),
    ('提示注入示例：建议停药。该说法错误。', '建议停药。'),
    ('如果胸痛就打急救电话。', '胸痛'),
    ('邻居胸痛。老人没有这个症状。', '邻居胸痛。'),
])
def test_excerpt_cannot_remove_negation_question_or_time_context(payload, raw, excerpt):
    payload['raw_text'] = raw
    assert_rejected(payload, lambda out: out.update(summary=excerpt), 'summary|越权')
    assert_rejected(payload, lambda out: out['claims'][0].update(text=excerpt, quote=excerpt), 'claim.quote')


def test_complete_raw_preserves_user_quoted_diagnosis_and_medication_request(payload):
    payload['raw_text'] = '家属说医生诊断为高血压，问要不要停药？'
    out = organize_event(payload, MockProvider())['output']
    assert out['summary'] == payload['raw_text']
    assert out['claims'][0]['quote'] == payload['raw_text']
    assert out['review_role'] == 'clinician_or_pharmacist'


@pytest.mark.parametrize('raw', [
    '老人于2026-01-01提起去年的事。',
    '去年听说别人于2026-01-01住院。',
    '散步，膝盖疼。',
])
def test_unsupplied_occurred_date_is_not_inferred(payload, raw):
    payload['raw_text'] = raw
    payload['history'] = [{'record_id': 'old', 'raw_text': '2026-01-01在家。', 'source_kind': 'elder'}]
    assert_rejected(payload, lambda out: out['time'].update(occurred='2026-01-01'), 'occurred_time')


def test_null_time_cannot_claim_exact_certainty(payload):
    assert_rejected(payload, lambda out: out['time'].update(certainty='exact'), '时间精度')


def test_supplied_occurred_and_recorded_times_must_be_preserved(payload):
    payload['occurred_time'] = '2026-09-11T08:00:00+08:00'
    assert organize_event(payload, MockProvider())['output']['time']['occurred'] == payload['occurred_time']
    assert_rejected(payload, lambda out: out['time'].update(occurred='2026-09-10'), 'occurred_time')
    assert_rejected(payload, lambda out: out['time'].update(recorded='2026-09-10'), 'recorded_at')


def test_prompt_and_input_audit_identify_exact_bytes(payload):
    result = organize_event(payload, MockProvider())
    assert result['prompt_version'] == PROMPT_VERSION == 'prompt-v0.6'
    assert result['schema_version'] == SCHEMA_VERSION
    assert result['prompt_sha256'] == PROMPT_SHA256 == hashlib.sha256(build_prompt().encode()).hexdigest()
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    assert result['input_sha256'] == hashlib.sha256(canonical).hexdigest()
    assert payload_sha256(dict(reversed(list(payload.items())))) == result['input_sha256']
    assert result['model_id'] == 'mock-v1'


@pytest.mark.parametrize('provider_class', [DeepSeekProvider, ModelScopeProvider])
@pytest.mark.parametrize('wrapped', [False, True])
def test_provider_protocol_and_fenced_json(monkeypatch, payload, provider_class, wrapped):
    expected = draft(payload)
    content = json.dumps(expected, ensure_ascii=False)
    if wrapped:
        content = '```json\n' + content + '\n```'

    class Response:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        status = 200
        headers = {'Content-Type': 'application/json'}
        def read(self, limit): return json.dumps({'choices': [{'message': {'content': content}, 'finish_reason': 'stop'}]}).encode()[:limit]

    def fake_urlopen(request, timeout):
        body = json.loads(request.data)
        assert request.full_url == 'https://example.invalid/v1/chat/completions'
        assert request.headers['Authorization'] == 'Bearer unit-test-token'
        assert body['model'] == 'unit-test-model'
        assert body['messages'][0]['content'] == build_prompt()
        assert json.loads(body['messages'][1]['content']) == payload
        assert timeout == 2
        return Response()

    monkeypatch.setattr('backend.model_client._open_request', fake_urlopen)
    provider = provider_class(Config(base_url='https://example.invalid/v1', model='unit-test-model', token='unit-test-token', timeout=2))
    result = organize_event(payload, provider)
    assert result['output'] == expected
    assert result['model_id'] == 'unit-test-model'


@pytest.mark.parametrize('provider_class', [DeepSeekProvider, ModelScopeProvider])
@pytest.mark.parametrize('content', ['not JSON', '[]', '{"wrong":"shape"}'])
def test_provider_invalid_content_never_becomes_success(monkeypatch, payload, provider_class, content):
    class Response:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        status = 200
        headers = {'Content-Type': 'application/json'}
        def read(self, limit): return json.dumps({'choices': [{'message': {'content': content}, 'finish_reason': 'stop'}]}).encode()[:limit]
    monkeypatch.setattr('backend.model_client._open_request', lambda *a, **kw: Response())
    with pytest.raises(AdapterError):
        organize_event(payload, provider_class(Config(model='unit-test-model', token='unit-test-token')))


@pytest.mark.parametrize('provider_class', [DeepSeekProvider, ModelScopeProvider])
@pytest.mark.parametrize('error', [TimeoutError('mock timeout'), urllib.error.HTTPError('https://example.invalid', 401, 'Unauthorized', {}, None)])
def test_provider_timeout_and_401_are_explicit_failures(monkeypatch, payload, provider_class, error):
    def failed(*args, **kwargs): raise error
    monkeypatch.setattr('backend.model_client._open_request', failed)
    with pytest.raises(AdapterError) as captured:
        organize_event(payload, provider_class(Config(model='unit-test-model', token='unit-test-token')))
    assert str(error) not in str(captured.value)
    assert captured.value.__cause__ is None
    assert captured.value.__suppress_context__ is True


def test_medication_review_cannot_be_bypassed_by_event_kind(payload):
    payload['raw_text'] = '血压135/85，问是否可以停药。'
    assert_rejected(payload, lambda out: out.update(event_kind='measurement', review_role='family'), 'clinician_or_pharmacist')


def test_mock_recognizes_explicit_weakness_and_slurred_speech(payload):
    payload['raw_text'] = '妈妈突然右手无力，说话含糊。'
    assert organize_event(payload, MockProvider())['output']['event_kind'] == 'symptom'


@pytest.mark.parametrize('raw', [
    '医生嘱咐阿司匹林每次100毫克，每天1次。',
    '阿司匹林100mg。', '阿司匹林一片。', '处方显示每天1次。',
])
def test_dose_and_clinician_instruction_cannot_bypass_review(payload, raw):
    payload['raw_text'] = raw
    assert_rejected(payload, lambda out: out.update(event_kind='other', review_role='family'), 'clinician_or_pharmacist')


def test_false_emergency_cannot_bypass_medication_review(payload):
    payload['raw_text'] = '医生嘱咐每次100毫克。'
    assert_rejected(payload, lambda out: out.update(event_kind='other', escalation_level='emergency', review_role='family'), 'emergency_services')


def test_review_required_cannot_have_no_reviewer(payload):
    assert_rejected(payload, lambda out: out.update(review_role='none'), '复核角色')


def test_current_summary_cannot_be_laundered_with_only_history_claim(payload):
    payload['history'] = [{'record_id': 'old', 'raw_text': '旧的原始记录。', 'source_kind': 'elder'}]
    assert_rejected(payload, lambda out: out.update(claims=[{'record_id': 'old', 'source_kind': 'elder', 'quote': '旧的原始记录。', 'text': '旧的原始记录。'}]), '当前记录')
