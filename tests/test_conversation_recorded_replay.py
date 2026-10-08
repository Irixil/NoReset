"""Recorded synthetic responses replay offline; no provider configuration/network."""
from copy import deepcopy
import json
from pathlib import Path

import pytest

from backend.conversation import CATEGORIES, _source_excerpt, conversation_turn
from scripts.run_text_trial import digest, encoded, prepare_job


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'data/synthetic/recorded-text-subset-v1.json'


class RecordedProvider:
    def __init__(self, draft, expected_payload=None):
        self.draft, self.expected_payload, self.calls = draft, expected_payload, 0

    def complete_json(self, _system, payload):
        self.calls += 1
        if self.expected_payload is not None:
            assert payload == self.expected_payload
        return deepcopy(self.draft)


def recorded(job_id, *, whole_result=False):
    fixture = json.loads(FIXTURE.read_text(encoding='utf-8'))
    assert fixture['synthetic_only'] is True
    record = next(row for row in fixture['records'] if row['job_id'] == job_id)
    before = deepcopy(record)
    prepared = prepare_job(record)
    assert prepared['profile'] == record['profile']
    provider = RecordedProvider(record['draft'], prepared['model_payload'])
    result = conversation_turn(deepcopy(record['native_input']), provider)
    assert provider.calls == 1  # In-memory replay, not HTTP or a second paid call.
    assert digest(encoded(prepared['model_payload'])) == prepared['profile']['source_sha256']
    assert record == before
    return result if whole_result else result['completeness']['clinical_state']


def test_recorded_primary_cough_does_not_fill_missing_associated_symptoms():
    state = recorded('dialogue1')
    assert state['associated_symptoms']['status'] == 'missing'
    assert state['associated_symptoms']['summary'] == ''


def test_recorded_correction_does_not_reintroduce_old_duration_into_current_complaint():
    state = recorded('dialoguecorrection2')
    assert state['main_complaint']['status'] == 'known'
    assert '咳嗽' in state['main_complaint']['summary']
    assert '两天' not in state['main_complaint']['summary']
    assert '三天' in state['onset_course']['summary']
    assert state['onset_course']['evidence_turn_ids'] == ['turn_texttrial_correct02']
    assert state['associated_symptoms']['status'] == 'missing'


def test_recorded_unchanged_evening_change_is_not_discarded():
    for job_id in ('dialogue1', 'dialoguecorrection2'):
        state = recorded(job_id)
        assert state['aggravating_relieving']['status'] == 'known'
        assert '晚上明显' in state['aggravating_relieving']['summary']
        assert state['aggravating_relieving']['evidence_turn_ids'] == ['turn_texttrial_patient01']


def synthetic_draft(refs):
    state = {category: {'status': 'missing', 'summary': '', 'evidence_turn_ids': [], 'context_ids': []}
             for category in CATEGORIES}
    state['main_complaint'] = {'status': 'known', 'summary': '头疼', 'evidence_turn_ids': refs, 'context_ids': []}
    return {'user_intent': 'correction', 'latest_turn_adds_fact': True,
            'reply_text': '我会保留这次更正和原始记录。', 'suggested_action': 'finish',
            'question_category': None, 'question_importance': None, 'candidate_question': '',
            'clinical_state': state, 'relevant_context_ids': [], 'unknowns': [], 'contradictions': [],
            'risk_candidates': []}


@pytest.mark.parametrize('old,new', [('五周', '七周'), ('12小时', '18小时')])
def test_literal_duration_correction_is_generic_and_keeps_sources(old, new):
    first = {'turn_id': 'turn_generic_first01', 'text': f'虚构记录。我头疼{old}了，下午更明显。', 'version': 1}
    latest = {'turn_id': 'turn_generic_latest02', 'text': f'我说错了，不是{old}，是{new}。', 'version': 2}
    payload = {'turns': [first, latest], 'controller': {}, 'health_context': []}
    before = deepcopy(payload)
    draft = synthetic_draft([first['turn_id']])
    draft['clinical_state']['onset_course'] = {'status': 'known', 'summary': new,
              'evidence_turn_ids': [latest['turn_id']], 'context_ids': []}
    result = conversation_turn(payload, RecordedProvider(draft))
    state = result['completeness']['clinical_state']
    assert '头疼' in state['main_complaint']['summary']
    assert old not in state['main_complaint']['summary']
    assert state['main_complaint']['evidence_turn_ids'] == [first['turn_id']]
    assert new in state['onset_course']['summary']
    assert state['onset_course']['evidence_turn_ids'] == [latest['turn_id']]
    assert payload == before


def test_replacing_entire_old_complaint_cannot_leave_a_meaningless_known_fragment():
    turns = [{'turn_id': 'turn_generic_first01', 'text': '我头疼了。'},
             {'turn_id': 'turn_generic_latest02', 'text': '说错了，不是头疼，是耳鸣。'}]
    state = conversation_turn({'turns': turns}, RecordedProvider(synthetic_draft([turns[0]['turn_id']])))[
        'completeness']['clinical_state']
    assert state['main_complaint']['status'] == 'missing'
    assert state['main_complaint']['summary'] == ''


def test_negated_old_expression_is_not_turned_positive_by_deleting_negation():
    turns = [{'turn_id': 'turn_generic_first01', 'text': '我没有头疼。'},
             {'turn_id': 'turn_generic_latest02', 'text': '更正，不是没有，是有头疼。'}]
    state = conversation_turn({'turns': turns}, RecordedProvider(synthetic_draft([row['turn_id'] for row in turns])))[
        'completeness']['clinical_state']
    assert state['main_complaint']['evidence_turn_ids'] == [turns[-1]['turn_id']]
    assert state['main_complaint']['summary'] == '有头疼'


def test_ambiguous_old_value_in_multiple_turns_is_left_for_verification():
    turns = [{'turn_id': 'turn_generic_first01', 'text': '我头疼五周了。'},
             {'turn_id': 'turn_generic_other02', 'text': '另外那次头疼也五周了。'},
             {'turn_id': 'turn_generic_latest03', 'text': '更正，不是五周，是七周。'}]
    state = conversation_turn({'turns': turns}, RecordedProvider(synthetic_draft([turns[0]['turn_id']])))[
        'completeness']['clinical_state']
    assert state['main_complaint']['status'] == 'known'
    assert '头疼' in state['main_complaint']['summary']
    assert '五周' not in state['main_complaint']['summary']
    assert state['onset_course']['status'] == 'missing'
    assert '七周' not in state['onset_course']['summary']


@pytest.mark.parametrize('source', ['如果晚上更明显，就去医院。', '晚上更明显时建议做检查。',
                                  '要是晚上更明显就去看医生。', '我想问夜里会不会更重？'])
def test_temporal_change_extraction_does_not_promote_hypothetical_or_medical_advice(source):
    assert _source_excerpt(source, 'aggravating_relieving') == ''


def native_state(texts, category='main_complaint', refs=None):
    turns = [{'turn_id': f'turn_counterexample_{index:02d}', 'text': text} for index, text in enumerate(texts)]
    payload = {'turns': turns}
    before = deepcopy(payload)
    draft = synthetic_draft([turns[index]['turn_id'] for index in (refs if refs is not None else [0])])
    if category != 'main_complaint':
        draft['clinical_state'][category] = {'status': 'known', 'summary': texts[-1],
                'evidence_turn_ids': [turns[index]['turn_id'] for index in (refs if refs is not None else [0])],
                'context_ids': []}
    result = conversation_turn(payload, RecordedProvider(draft))
    assert payload == before  # Source/history retain all literal versions.
    return result['completeness']['clinical_state'], turns


def test_two_attributes_in_one_source_cannot_be_assigned_by_record_id_alone():
    state, turns = native_state(['我头疼五周了，腿也疼五周。晚上明显。', '更正，不是五周，是七周。'])
    assert state['main_complaint']['status'] == 'known'
    assert '头疼' in state['main_complaint']['summary'] and '腿也疼' in state['main_complaint']['summary']
    assert '五周' not in state['main_complaint']['summary']
    # The unchanged independent evening fact may still establish time of day;
    # neither unassigned duration can become a current duration.
    assert '五周' not in state['onset_course']['summary'] and '七周' not in state['onset_course']['summary']
    assert state['aggravating_relieving']['summary'] == '晚上明显。'
    assert state['aggravating_relieving']['evidence_turn_ids'] == [turns[0]['turn_id']]


@pytest.mark.parametrize('latest', [
    '如果不是五周，而是七周该怎么记？',
    '医生说不是五周，是七周就来复查。',
    '我没说不是五周，是七周；还是五周。',
])
def test_hypothetical_quoted_or_denied_correction_does_not_clip_current_source(latest):
    state, turns = native_state(['我头疼五周了。', latest], category='onset_course')
    assert state['main_complaint']['summary'] == '我头疼五周了。'
    assert state['main_complaint']['evidence_turn_ids'] == [turns[0]['turn_id']]
    assert '五周' in state['onset_course']['summary'] and '七周' not in state['onset_course']['summary']


@pytest.mark.parametrize('new,expected', [('右膝', 'missing'), ('右膝疼', 'known')])
def test_whole_complaint_correction_does_not_transplant_old_symptom(new, expected):
    state, turns = native_state(['我右腿疼。', f'说错了，不是右腿疼，是{new}。'], refs=[0, 1])
    complaint = state['main_complaint']
    assert complaint['status'] == expected
    assert '右腿疼' not in complaint['summary']
    if expected == 'known':
        assert complaint['summary'] == '右膝疼'
        assert complaint['evidence_turn_ids'] == [turns[1]['turn_id']]
    else:
        assert complaint['summary'] == ''


def test_numeric_fragment_does_not_match_a_larger_number():
    state, turns = native_state(['我头疼20天了。', '更正，不是2，是3天。'], category='onset_course')
    assert state['onset_course']['summary'] == '我头疼20天了。'
    assert state['onset_course']['evidence_turn_ids'] == [turns[0]['turn_id']]


def test_model_known_negated_associated_expression_preserves_literal_negation():
    state, _ = native_state(['我咳嗽两天，另外没有发热。'], category='associated_symptoms')
    assert state['associated_symptoms']['status'] == 'known'
    assert '没有发热' in state['associated_symptoms']['summary']


@pytest.mark.parametrize('source', ['晚上没有加重。', '夜里没有好转。', '昨晚加重了，医生建议今天复诊。'])
def test_temporal_literal_fact_and_negation_are_preserved(source):
    excerpt = _source_excerpt(source, 'aggravating_relieving')
    assert excerpt == source.split('，')[0] + ('，' if '，' in source else '')


def test_correction_does_not_discard_an_independent_new_fact_in_same_turn():
    state, turns = native_state(['我头疼五周了。', '刚才说错了，不是五周，是七周。昨晚更明显。'],
                                category='aggravating_relieving', refs=[1])
    assert state['aggravating_relieving']['summary'] == '昨晚更明显。'
    assert state['aggravating_relieving']['evidence_turn_ids'] == [turns[1]['turn_id']]


def test_blocked_nonmock_response_does_not_fill_missing_associated_symptoms():
    turn = {'turn_id': 'turn_counterexample_01', 'text': '我咳嗽两天了。'}
    draft = synthetic_draft([turn['turn_id']])
    draft['reply_text'] = '这就是肺炎，应该立即服用抗生素。'
    result = conversation_turn({'turns': [turn]}, RecordedProvider(draft))
    assert result['stop_reason'] == 'model_output_blocked'
    assert result['completeness']['clinical_state']['associated_symptoms']['status'] == 'missing'


def test_recorded_compound_presence_question_is_not_displayed_or_counted():
    result = recorded('dialogue1', whole_result=True)
    assert result['action'] == 'reply'
    assert result['question_category'] is None
    assert '有没有痰' not in result['assistant_text']
    assert result['controller']['question_count'] == 0


@pytest.mark.parametrize('intent', ['health_fact', 'patient_question'])
@pytest.mark.parametrize('candidate', [
    '您有没有头晕，或者同时有恶心、心慌这些情况？',
    '您还有没有头晕、恶心、心慌这些情况？',
    '您还有没有头晕，另外有没有恶心？',
])
def test_compound_presence_questions_leave_response_open_without_a_replacement(intent, candidate):
    turn = {'turn_id': 'turn_counterexample_01', 'text': '我腿疼了。'}
    draft = synthetic_draft([turn['turn_id']])
    draft.update(user_intent=intent, suggested_action='ask', question_category='associated_symptoms',
                 question_importance='essential', candidate_question=candidate)
    result = conversation_turn({'turns': [turn]}, RecordedProvider(draft))
    assert result['action'] == 'reply'
    assert result['assistant_text'] == draft['reply_text']
    assert result['question_category'] is None
    assert result['controller']['question_count'] == 0
    assert result['controller']['asked_questions'] == []


@pytest.mark.parametrize('intent', ['health_fact', 'patient_question'])
def test_legitimate_single_choice_question_is_still_available(intent):
    turn = {'turn_id': 'turn_counterexample_01', 'text': '我说不清哪里不舒服。'}
    draft = synthetic_draft([turn['turn_id']])
    draft.update(user_intent=intent, suggested_action='ask', question_category='symptom_character',
                 question_importance='essential', candidate_question='您腿疼的部位是左边还是右边？')
    result = conversation_turn({'turns': [turn]}, RecordedProvider(draft))
    assert result['action'] == 'ask'
    assert '左边还是右边' in result['assistant_text']
    assert result['controller']['question_count'] == 1
