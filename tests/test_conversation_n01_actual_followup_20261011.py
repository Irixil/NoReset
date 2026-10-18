"""Portable replay of the actual synthetic N01 response; zero provider calls.
Capture: noreset-N01-reviewed-first-20261011T034831356331Z,
response SHA256 7058f732010eb71096e5372319884806d4ac84ebc36446a203b5aa1828ec9804.
Offline replay does not change or upgrade that real browser result.
"""
import json
from copy import deepcopy
from types import SimpleNamespace
import pytest
from backend.conversation import conversation_turn
CAPTURE=json.loads(r'''{
  "input": {
    "subject_id": "subject_self",
    "turns": [
      {
        "turn_id": "turn_saved_audio_bdf690e276d34d41a8bd88bb07a88445",
        "text": "我咳嗽两天了，晚上明显些。",
        "version": 1,
        "responding_to": {
          "turn_id": "turn_saved_audio_opening_bdf690e276d34d41a8bd88bb07a88445",
          "text": "您好，我会帮您把不舒服的地方记清楚，方便和医生说。您今天最难受的是什么？"
        }
      }
    ],
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
      "last_question_category": "main_complaint"
    },
    "health_context": []
  },
  "draft": {
    "user_intent": "health_fact",
    "latest_turn_adds_fact": true,
    "reply_text": "您说咳嗽两天了，晚上更明显，我先把这些记下来。",
    "suggested_action": "ask",
    "question_category": "associated_symptoms",
    "question_importance": "essential",
    "candidate_question": "除了咳嗽，这两天有没有发烧、咳痰或者喘不上气的情况？",
    "clinical_state": {
      "main_complaint": {
        "status": "known",
        "summary": "咳嗽两天，晚上明显些",
        "evidence_turn_ids": [
          "turn_saved_audio_bdf690e276d34d41a8bd88bb07a88445"
        ],
        "context_ids": []
      },
      "onset_course": {
        "status": "known",
        "summary": "咳嗽已两天",
        "evidence_turn_ids": [
          "turn_saved_audio_bdf690e276d34d41a8bd88bb07a88445"
        ],
        "context_ids": []
      },
      "symptom_character": {
        "status": "known",
        "summary": "咳嗽晚上更明显",
        "evidence_turn_ids": [
          "turn_saved_audio_bdf690e276d34d41a8bd88bb07a88445"
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
}''')
class SavedDraftProvider:
    c=SimpleNamespace(model='deepseek-flash')
    def __init__(self,draft):self.draft=draft
    def complete_json(self,prompt,payload):return deepcopy(self.draft)
def replay(question=None):
    draft=deepcopy(CAPTURE['draft'])
    if question is not None:draft['candidate_question']=question
    return conversation_turn(deepcopy(CAPTURE['input']),SavedDraftProvider(draft))
def test_actual_N01_followup_keeps_source_time_and_one_question():
    r=replay()
    assert r['action']=='ask'
    assert r['question_category']=='associated_symptoms'
    assert r['assistant_text']==CAPTURE['draft']['reply_text']+' 除了咳嗽，这两天有没有发烧的情况？'
    assert r['assistant_text'].count('？')==1
    assert r['controller']['question_count']==2
    assert r['completeness']['clinical_state']['associated_symptoms']['status']=='missing'
    assert r['completeness']['clinical_state']['onset_course']['evidence_turn_ids']==[CAPTURE['input']['turns'][0]['turn_id']]
@pytest.mark.parametrize('question',[
    '除了咳嗽，这两天有没有发烧、应该停药？',
    '除了肺癌，这两天有没有发烧、咳痰？',
    '除了咳嗽，这两天有没有发烧、转账？',
    '除了咳嗽，这两天有没有发烧、不确定是否咳痰？',
])
def test_new_wording_does_not_rescue_unsafe_or_uncertain_lists(question):
    r=replay(question)
    assert r['action']=='reply'
    assert r['controller']['question_count']==1
    assert r['question_category'] is None
    assert r['completeness']['clinical_state']['associated_symptoms']['status']=='missing'
