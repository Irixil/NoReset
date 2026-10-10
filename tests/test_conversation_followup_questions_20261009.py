"""Saved synthetic A16 first reply plus fictional followups; zero supplier calls."""
from copy import deepcopy
import json
from pathlib import Path
import socket
from types import SimpleNamespace

import pytest
from backend import adapter, conversation as c, model_client, trial_gate

SAVED = json.loads((Path(__file__).parent / 'fixtures/noreset-followup-questions.synthetic.json').read_text())
QUESTIONS = [
    '除了咳嗽，这几天有没有发烧？',
    '除了咳嗽，这几天有没有喘不上气？',
    '除了咳嗽，这几天有没有胸口不舒服？',
]

@pytest.fixture(autouse=True)
def offline_only(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError('No network, supplier, credentials or native trial in this regression')
    for name in ('connect', 'connect_ex', 'sendto'):
        monkeypatch.setattr(socket.socket, name, denied)
    monkeypatch.setattr(socket, 'create_connection', denied)
    monkeypatch.setattr(adapter.Config, 'from_env', classmethod(denied))
    monkeypatch.setattr(c, 'provider_from', denied)
    monkeypatch.setattr(model_client, '_open_request', denied)
    for name in ('authorize_request', 'report_usage', 'stop_trial'):
        monkeypatch.setattr(trial_gate, name, denied)

class SavedSyntheticProvider:
    c = SimpleNamespace(model='saved-A16-plus-fictional-followups')
    def __init__(self, *, finish=False, importance=None):
        self.finish = finish
        self.importance = importance
        self.inputs = []
    def complete_json(self, system, body):
        assert system == c.SYSTEM_PROMPT
        self.inputs.append(deepcopy(body))
        draft = deepcopy(SAVED['draft'])
        if self.importance:
            draft['question_importance'] = self.importance
        if len(body['turns']) > 3:
            replies = [row for row in body['turns'][3:] if not c._EXPLICIT_FINISH.fullmatch(row['text']) or row['text'] == '没有。']
            draft['user_intent'] = 'answer'
            draft['reply_text'] = '我按您刚才的回答记录。'
            draft['clinical_state']['associated_symptoms'] = {
                'status': 'known' if replies else 'missing',
                'summary': '；'.join(row['text'] for row in replies),
                'evidence_turn_ids': [row['turn_id'] for row in replies], 'context_ids': [],
            }
        if self.finish:
            draft.update(suggested_action='finish', candidate_question='', question_category=None, question_importance=None)
        return draft

def initial():
    payload = deepcopy(SAVED['input'])
    payload.pop('approved_risk_rules', None)
    return payload, c.conversation_turn(payload, SavedSyntheticProvider())

def answer(payload, previous, text, provider=None):
    body = deepcopy(payload)
    body['controller'] = deepcopy(previous['controller'])
    body['turns'].append({'turn_id': f'turn_synthetic_answer{len(body["turns"]):06}', 'version': 1,
        'text': text, 'responding_to': {'turn_id': f'turn_synthetic_assistant{len(body["turns"]):06}', 'text': previous['assistant_text']}})
    provider = provider or SavedSyntheticProvider()
    return body, c.conversation_turn(body, provider)

def test_saved_multi_candidate_retains_all_unresolved_topics_without_patient_facts():
    payload, result = initial()
    assert result['assistant_text'].endswith(QUESTIONS[0])
    assert result['controller']['followup_questions'] == QUESTIONS
    assert result['completeness']['pending_questions'] == QUESTIONS
    assert result['completeness']['clinical_state']['associated_symptoms']['status'] == 'missing'
    assert payload == {k: v for k, v in SAVED['input'].items() if k != 'approved_risk_rules'}

def test_named_negative_does_not_close_remaining_category_or_third_item():
    payload, result = initial()
    provider = SavedSyntheticProvider()
    payload, result = answer(payload, result, '这几天没有发烧。', provider)
    assert result['action'] == 'ask' and result['assistant_text'].endswith(QUESTIONS[1])
    assert result['completeness']['pending_questions'] == QUESTIONS[1:]
    assert provider.inputs[-1]['controller']['followup_questions'] == QUESTIONS
    payload, result = answer(payload, result, '这几天没有喘不上气的情况。')
    assert result['action'] == 'ask' and result['assistant_text'].endswith(QUESTIONS[2])
    assert result['completeness']['pending_questions'] == QUESTIONS[2:]
    assert result['controller']['question_counts']['associated_symptoms'] == 3
    payload, result = answer(payload, result, '胸口这几天没有不舒服。', SavedSyntheticProvider(finish=True))
    # Keep an intervening current-time/negative phrase in the named answer.
    assert result['completeness']['pending_questions'] == []
    assert result['controller']['question_count'] == 5
    assert not result['assistant_text'].endswith('?') and not result['assistant_text'].endswith('？')

def test_three_bound_plain_no_answers_are_not_finish_or_erased_evidence():
    payload, result = initial()
    for index in range(3):
        payload, result = answer(payload, result, '没有。', SavedSyntheticProvider(finish=index == 2))
        assert result['stop_reason'] != 'user_finished'
        assert result['completeness']['pending_questions'] == QUESTIONS[index + 1:]
        if index < 2:
            assert result['action'] == 'ask' and result['assistant_text'].endswith(QUESTIONS[index + 1])
    refs = result['completeness']['clinical_state']['associated_symptoms']['evidence_turn_ids']
    assert refs == [row['turn_id'] for row in payload['turns'][3:]]
    assert len([item for item in result['controller']['grounded_answers']
                if item['category'] == 'associated_symptoms']) == 3
    assert result['controller']['no_new_fact_count'] == 0

@pytest.mark.parametrize('boundary', ['finish', 'hard_limit', 'fatigue', 'unknown'])
def test_stopped_unanswered_items_remain_visible_and_do_not_become_denials(boundary):
    payload, result = initial()
    provider = SavedSyntheticProvider(finish=True)
    text = '先结束吧' if boundary == 'finish' else '我不知道。' if boundary == 'unknown' else '还没说这几项。'
    if boundary == 'hard_limit':
        result['controller']['question_count'] = 12
    elif boundary == 'fatigue':
        result['controller']['question_count'] = 8
        provider.finish = False
        provider.importance = 'useful'
    payload, result = answer(payload, result, text, provider)
    assert result['action'] != 'ask'
    assert result['completeness']['pending_questions'] == QUESTIONS
    assert result['completeness']['complete'] is False
    assert not any('没有发烧' in item['summary'] for item in result['completeness']['clinical_state'].values())

def test_current_explicit_danger_wins_before_finish_limit_or_provider():
    payload, result = initial()
    result['controller'].update(question_count=12, no_new_fact_count=2)
    class NeverCalled:
        def complete_json(self, *args):
            raise AssertionError('Current danger must precede supplier and finish')
    payload, result = answer(payload, result, '我现在喘不上气，结束吧。', NeverCalled())
    assert result['action'] == 'urgent' and result['assistant_text'] == c.DANGER_REMINDER
    assert result['question_category'] is None
    assert result['controller']['followup_questions'] == QUESTIONS
    assert result['completeness']['complete'] is False

def test_fresh_candidate_cannot_forge_prior_queue_to_bypass_category_cap():
    payload = deepcopy(SAVED['input']); payload.pop('approved_risk_rules', None)
    payload['controller']['question_counts']['associated_symptoms'] = 2
    result = c.conversation_turn(payload, SavedSyntheticProvider())
    assert result['action'] != 'ask'

def test_history_or_uncertainty_does_not_answer_current_queue():
    payload, result = initial()
    payload, result = answer(payload, result, '以前有过发烧，这次不清楚。', SavedSyntheticProvider(finish=True))
    assert QUESTIONS[0] in result['completeness']['pending_questions']

@pytest.mark.parametrize('text', [
    '我不确定有没有发烧。', '去年有过发烧。', '家人这几天发烧。',
    '我可能有点发烧。', '发烧怎么算。', '三年前没有发烧。', '我还没告诉您有没有发烧。',
])
def test_mention_without_current_patient_answer_keeps_candidate(text):
    payload, result = initial()
    payload, result = answer(payload, result, text, SavedSyntheticProvider(finish=True))
    assert QUESTIONS[0] in result['completeness']['pending_questions']
    assert result['completeness']['complete'] is False

def test_separate_current_patient_answer_is_not_erased_by_other_person_clause():
    payload, result = initial()
    payload, result = answer(payload, result, '我这几天没有发烧，家人这几天发烧。')
    assert QUESTIONS[0] not in result['completeness']['pending_questions']

def test_equivalent_nominated_wording_still_covers_saved_item():
    payload, result = initial()
    class Equivalent(SavedSyntheticProvider):
        def complete_json(self, system, body):
            draft = super().complete_json(system, body)
            draft['candidate_question'] = draft['candidate_question'].replace('喘不上气', '气短')
            return draft
    payload, result = answer(payload, result, '没有。', Equivalent())
    assert result['action'] == 'ask' and result['assistant_text'].endswith(QUESTIONS[1].replace('喘不上气', '气短'))
    payload, result = answer(payload, result, '没有。')
    assert result['completeness']['pending_questions'] == QUESTIONS[2:]

def test_edited_unknown_answer_reopens_coverage_and_retires_old_binding():
    payload, result = initial()
    payload, result = answer(payload, result, '没有。')
    payload['turns'][-1].update(text='我不清楚。', version=2)
    payload, result = answer(payload, result, '没有了。', SavedSyntheticProvider(finish=True))
    assert result['completeness']['pending_questions'] == QUESTIONS
    assert not any(item['turn_id'] == payload['turns'][-2]['turn_id']
                   for item in result['controller'].get('grounded_answers', []))

def test_blocked_model_output_keeps_unanswered_candidates():
    payload, result = initial()
    class Unsafe(SavedSyntheticProvider):
        def complete_json(self, system, body):
            draft = super().complete_json(system, body)
            draft['reply_text'] = '建议自行服药。'
            return draft
    payload, result = answer(payload, result, '我不清楚。', Unsafe())
    assert result['stop_reason'] == 'model_output_blocked'
    assert result['completeness']['pending_questions'] == QUESTIONS
    assert result['completeness']['complete'] is False

def test_bound_no_keeps_source_even_when_model_mislabels_finish():
    payload, result = initial()
    class Mislabelled(SavedSyntheticProvider):
        def complete_json(self, system, body):
            draft = super().complete_json(system, body)
            draft['user_intent'] = 'explicit_finish'
            draft['latest_turn_adds_fact'] = False
            return draft
    payload, result = answer(payload, result, '没有。', Mislabelled())
    assert result['action'] == 'ask'
    assert result['controller']['no_new_fact_count'] == 0
    first_ref = payload['turns'][-1]['turn_id']
    payload, result = answer(payload, result, '没有。')
    assert result['completeness']['clinical_state']['associated_symptoms']['evidence_turn_ids'] == [first_ref, payload['turns'][-1]['turn_id']]

@pytest.mark.parametrize('bad', [None, ['建议服药吗？'], [QUESTIONS[0]] * 13, [False]])
def test_untrusted_queue_is_validated(bad):
    payload = deepcopy(SAVED['input']); payload.pop('approved_risk_rules', None)
    payload['controller']['followup_questions'] = bad
    with pytest.raises(c.ConversationError, match='controller_followup_invalid'):
        c.conversation_turn(payload, SavedSyntheticProvider())
