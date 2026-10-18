"""Portable synthetic actual-reply captures, processed entirely offline.

Capture 7 had an actual failed/unknown usage result; capture 8 was delivered as
reply only. These fixtures preserve their model drafts and original source
versions. They verify future controller handling, not historical delivery,
provider availability or clinical quality. No credentials or HTTP metadata.
"""
from copy import deepcopy
import json
import socket
from types import SimpleNamespace

import pytest
from backend import adapter, conversation, model_client, trial_gate

CAPTURES = json.loads(r'''{
  "7": {
    "model_input": {
      "turns": [
        {
          "turn_id": "turn_995fb60fedaf4506b85425e186272ce2",
          "text": "我咳嗽两天了，晚上明显些。",
          "version": 1,
          "responding_to": {
            "turn_id": "turn_ffb772930dc946a58acb638df8fbbc24",
            "text": "您好，我会帮您把不舒服的地方记清楚，方便和医生说。您今天最难受的是什么？"
          }
        }
      ],
      "health_context": [],
      "controller": {
        "asked_categories": [
          "main_complaint"
        ],
        "closed_categories": [],
        "question_counts": {
          "main_complaint": 1,
          "onset_course": 0,
          "symptom_character": 0,
          "aggravating_relieving": 0,
          "associated_symptoms": 0,
          "functional_impact": 0,
          "relevant_history": 0,
          "prior_actions_results": 0
        },
        "asked_questions": [
          "您好，我会帮您把不舒服的地方记清楚，方便和医生说。您今天最难受的是什么？"
        ],
        "question_count": 1,
        "no_new_fact_count": 0,
        "last_question_category": "main_complaint",
        "linked_context_ids": []
      },
      "approved_risk_rules": []
    },
    "draft": {
      "user_intent": "health_fact",
      "latest_turn_adds_fact": true,
      "reply_text": "您说的咳嗽两天、晚上更明显，我记下了。",
      "suggested_action": "ask",
      "question_category": "symptom_character",
      "question_importance": "essential",
      "candidate_question": "咳嗽的时候有痰吗，还是干咳？",
      "clinical_state": {
        "main_complaint": {
          "status": "known",
          "summary": "咳嗽两天",
          "evidence_turn_ids": [
            "turn_995fb60fedaf4506b85425e186272ce2"
          ],
          "context_ids": []
        },
        "onset_course": {
          "status": "known",
          "summary": "咳嗽持续两天",
          "evidence_turn_ids": [
            "turn_995fb60fedaf4506b85425e186272ce2"
          ],
          "context_ids": []
        },
        "symptom_character": {
          "status": "known",
          "summary": "咳嗽晚上明显些",
          "evidence_turn_ids": [
            "turn_995fb60fedaf4506b85425e186272ce2"
          ],
          "context_ids": []
        },
        "aggravating_relieving": {
          "status": "missing",
          "summary": "",
          "evidence_turn_ids": [],
          "context_ids": []
        },
        "associated_symptoms": {
          "status": "missing",
          "summary": "",
          "evidence_turn_ids": [],
          "context_ids": []
        },
        "functional_impact": {
          "status": "missing",
          "summary": "",
          "evidence_turn_ids": [],
          "context_ids": []
        },
        "relevant_history": {
          "status": "missing",
          "summary": "",
          "evidence_turn_ids": [],
          "context_ids": []
        },
        "prior_actions_results": {
          "status": "missing",
          "summary": "",
          "evidence_turn_ids": [],
          "context_ids": []
        }
      },
      "relevant_context_ids": [],
      "unknowns": [],
      "contradictions": [],
      "risk_candidates": []
    }
  },
  "8": {
    "model_input": {
      "turns": [
        {
          "turn_id": "turn_995fb60fedaf4506b85425e186272ce2",
          "text": "我咳嗽两天了，晚上明显些。",
          "version": 1,
          "responding_to": {
            "turn_id": "turn_ffb772930dc946a58acb638df8fbbc24",
            "text": "您好，我会帮您把不舒服的地方记清楚，方便和医生说。您今天最难受的是什么？"
          }
        },
        {
          "turn_id": "turn_902dbb0381754982a955cb2ce07eda32",
          "text": "我刚才说错了，不是两天，是三天。",
          "version": 1,
          "responding_to": {
            "turn_id": "turn_c6eb0f1002e64203b293ea9e7f77c1df",
            "text": "您说的咳嗽两天、晚上更明显，我记下了。"
          }
        }
      ],
      "health_context": [],
      "controller": {
        "asked_categories": [
          "main_complaint"
        ],
        "closed_categories": [],
        "question_counts": {
          "main_complaint": 1,
          "onset_course": 0,
          "symptom_character": 0,
          "aggravating_relieving": 0,
          "associated_symptoms": 0,
          "functional_impact": 0,
          "relevant_history": 0,
          "prior_actions_results": 0
        },
        "asked_questions": [
          "您好，我会帮您把不舒服的地方记清楚，方便和医生说。您今天最难受的是什么？"
        ],
        "question_count": 1,
        "no_new_fact_count": 0,
        "last_question_category": "main_complaint",
        "linked_context_ids": []
      },
      "approved_risk_rules": []
    },
    "draft": {
      "user_intent": "correction",
      "latest_turn_adds_fact": true,
      "reply_text": "好的，我把咳嗽的时间改成三天，不是两天。",
      "suggested_action": "ask",
      "question_category": "symptom_character",
      "question_importance": "useful",
      "candidate_question": "咳嗽的时候有痰吗，还是干咳？",
      "clinical_state": {
        "main_complaint": {
          "status": "known",
          "summary": "咳嗽，晚上明显些",
          "evidence_turn_ids": [
            "turn_995fb60fedaf4506b85425e186272ce2"
          ],
          "context_ids": []
        },
        "onset_course": {
          "status": "known",
          "summary": "咳嗽三天",
          "evidence_turn_ids": [
            "turn_902dbb0381754982a955cb2ce07eda32"
          ],
          "context_ids": []
        },
        "symptom_character": {
          "status": "missing",
          "summary": "",
          "evidence_turn_ids": [],
          "context_ids": []
        },
        "aggravating_relieving": {
          "status": "known",
          "summary": "晚上咳嗽更明显",
          "evidence_turn_ids": [
            "turn_995fb60fedaf4506b85425e186272ce2"
          ],
          "context_ids": []
        },
        "associated_symptoms": {
          "status": "missing",
          "summary": "",
          "evidence_turn_ids": [],
          "context_ids": []
        },
        "functional_impact": {
          "status": "missing",
          "summary": "",
          "evidence_turn_ids": [],
          "context_ids": []
        },
        "relevant_history": {
          "status": "missing",
          "summary": "",
          "evidence_turn_ids": [],
          "context_ids": []
        },
        "prior_actions_results": {
          "status": "missing",
          "summary": "",
          "evidence_turn_ids": [],
          "context_ids": []
        }
      },
      "relevant_context_ids": [],
      "unknowns": [],
      "contradictions": [
        {
          "text": "咳嗽时间先说两天，后更正为三天",
          "evidence_turn_ids": [
            "turn_995fb60fedaf4506b85425e186272ce2",
            "turn_902dbb0381754982a955cb2ce07eda32"
          ],
          "context_ids": []
        }
      ],
      "risk_candidates": []
    }
  }
}''')


@pytest.fixture(autouse=True)
def no_external_actions(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError('No provider, credential or trial-meter action is allowed')
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    monkeypatch.setattr(socket.socket, 'connect_ex', forbidden)
    monkeypatch.setattr(socket.socket, 'sendto', forbidden)
    monkeypatch.setattr(socket, 'create_connection', forbidden)
    monkeypatch.setattr(adapter.Config, 'from_env', classmethod(forbidden))
    monkeypatch.setattr(conversation, 'provider_from', forbidden)
    monkeypatch.setattr(model_client, '_open_request', forbidden)
    for name in ('authorize_request', 'report_usage', 'stop_trial'):
        monkeypatch.setattr(trial_gate, name, forbidden)


class SavedActualReplyOfflineReplay:
    c = SimpleNamespace(model='deepseek-flash')

    def __init__(self, draft):
        self.draft = deepcopy(draft)
        self.calls = 0

    def complete_json(self, system, payload):
        assert system == conversation.SYSTEM_PROMPT
        self.calls += 1
        assert payload['approved_risk_rules'] == []
        return deepcopy(self.draft)


def process(capture):
    payload = {key: deepcopy(value) for key, value in capture['model_input'].items()
               if key != 'approved_risk_rules'}
    before = deepcopy(payload)
    provider = SavedActualReplyOfflineReplay(capture['draft'])
    result = conversation.conversation_turn(payload, provider)
    assert provider.calls == 1
    assert payload == before
    assert provider.draft == capture['draft']
    return result


@pytest.mark.parametrize('capture_id', ['7', '8'])
def test_exact_saved_replies_ask_the_existing_single_question(capture_id):
    capture = deepcopy(CAPTURES[capture_id])
    result = process(capture)
    question = capture['draft']['candidate_question']
    assert result['action'] == 'ask'
    assert result['question_category'] == 'symptom_character'
    assert result['assistant_text'].endswith(question)
    assert result['assistant_text'].count('？') == 1
    assert result['controller']['question_count'] == 2
    assert result['controller']['question_counts']['symptom_character'] == 1
    assert result['controller']['asked_questions'][-1] == question
    state = result['completeness']['clinical_state']
    assert state['symptom_character']['status'] == 'missing'
    assert state['associated_symptoms']['status'] == 'missing'
    assert state['aggravating_relieving']['summary'] == '晚上明显些。'
    assert state['aggravating_relieving']['evidence_turn_ids'] == [capture['model_input']['turns'][0]['turn_id']]
    if capture_id == '8':
        assert state['onset_course']['summary'] == '三天'
        assert state['onset_course']['evidence_turn_ids'] == [capture['model_input']['turns'][1]['turn_id']]
        assert '两天' not in state['main_complaint']['summary']


@pytest.mark.parametrize('candidate', [
    '您最喜欢哪部电影？',
    '有痰吗，还是干咳？',
    '头疼的时候有波动吗，还是钝疼？',
    '咳嗽的时候有痰吗，还是发烧？',
    '咳嗽的时候有痰和胸痛吗，还是干咳？',
    '咳嗽的时候有肺炎吗，还是肺炎性咳？',
    '肺炎导致咳嗽的时候有痰吗，还是干咳？',
    '咳嗽的时候有心慌吗，还是干咳？',
    '发烧咳嗽的时候有痰吗，还是干咳？',
    '咳血的时候有痰吗，还是干咳？',
])
def test_unrelated_unanchored_or_multiple_dimensions_remain_reply(candidate):
    capture = deepcopy(CAPTURES['8'])
    capture['draft']['candidate_question'] = candidate
    result = process(capture)
    assert result['action'] == 'reply'
    assert result['assistant_text'] == capture['draft']['reply_text']
    assert result['controller']['question_count'] == 1
    assert result['question_category'] is None


@pytest.mark.parametrize('candidate', [
    '您可能是肺炎，要服药吗？',
    '您应当停药再检查，可以吗？',
    '咳嗽的时候有没有痰，另外有没有胸痛？',
])
def test_dangerous_or_compound_questions_are_not_displayed(candidate):
    capture = deepcopy(CAPTURES['8'])
    capture['draft']['candidate_question'] = candidate
    result = process(capture)
    assert result['action'] != 'ask'
    assert candidate not in result['assistant_text']
    assert result['controller']['question_count'] == 1
    assert result['completeness']['clinical_state']['associated_symptoms']['status'] == 'missing'


@pytest.mark.parametrize('boundary', ['repeat', 'closed', 'category_limit', 'fatigue', 'hard_limit', 'already_known_category', 'no_current_complaint'])
def test_source_and_existing_controller_boundaries_still_stop_the_question(boundary):
    capture = deepcopy(CAPTURES['8'])
    controller = capture['model_input']['controller']
    if boundary == 'repeat':
        controller['asked_questions'].append(capture['draft']['candidate_question'])
    elif boundary == 'closed':
        controller['closed_categories'].append('symptom_character')
    elif boundary == 'category_limit':
        controller['question_counts']['symptom_character'] = 2
    elif boundary == 'fatigue':
        controller['question_count'] = 8
    elif boundary == 'hard_limit':
        controller['question_count'] = 12
    elif boundary == 'already_known_category':
        capture['draft']['question_category'] = 'onset_course'
    elif boundary == 'no_current_complaint':
        capture['model_input']['turns'][0]['text'] = '我想记一下。'
    result = process(capture)
    assert result['action'] != 'ask'
    assert capture['draft']['candidate_question'] not in result['assistant_text']
    assert result['controller']['question_count'] == controller['question_count']


def test_patient_question_branch_uses_the_same_scope_rule():
    # Only the model-intent branch is varied in a mechanical offline fixture.
    # The original patient sources and captured clinical state stay unchanged.
    capture = deepcopy(CAPTURES['7'])
    capture['draft']['user_intent'] = 'patient_question'
    result = process(capture)
    assert result['action'] == 'ask'
    assert result['assistant_text'].endswith(capture['draft']['candidate_question'])
    assert result['assistant_text'].count('？') == 1
    assert result['controller']['question_count'] == 2
