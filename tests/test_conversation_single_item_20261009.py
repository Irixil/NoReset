"""Five saved synthetic model drafts; offline checks, not historical delivery.

Unknown use and actual failed call 11 remain unchanged. This portable test has
no private QA import, credential, transport, runtime or budget dependency.
"""
from copy import deepcopy
import json
import socket
from types import SimpleNamespace
import pytest
from backend import adapter, conversation as c, model_client, trial_gate

CAPTURES = json.loads(r'''{
  "9": {
    "input": {
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
        },
        {
          "turn_id": "turn_0ed4bfd8e9c241dc9730041263de970e",
          "text": "大多是干咳，偶尔有一点白痰。",
          "version": 1,
          "responding_to": {
            "turn_id": "turn_9b0c45209d4a4b389bfe28a2f675283f",
            "text": "好的，我把咳嗽的时间改成三天，不是两天。 咳嗽的时候有痰吗，还是干咳？"
          }
        }
      ],
      "health_context": [],
      "controller": {
        "asked_categories": [
          "main_complaint",
          "symptom_character"
        ],
        "closed_categories": [],
        "question_counts": {
          "main_complaint": 1,
          "onset_course": 0,
          "symptom_character": 1,
          "aggravating_relieving": 0,
          "associated_symptoms": 0,
          "functional_impact": 0,
          "relevant_history": 0,
          "prior_actions_results": 0
        },
        "asked_questions": [
          "您好，我会帮您把不舒服的地方记清楚，方便和医生说。您今天最难受的是什么？",
          "咳嗽的时候有痰吗，还是干咳？"
        ],
        "question_count": 2,
        "no_new_fact_count": 0,
        "last_question_category": "symptom_character",
        "linked_context_ids": []
      },
      "approved_risk_rules": []
    },
    "draft": {
      "user_intent": "answer",
      "latest_turn_adds_fact": true,
      "reply_text": "好的，我把咳嗽时间改成三天，也记下大多是干咳、偶尔有一点白痰。",
      "suggested_action": "ask",
      "question_category": "associated_symptoms",
      "question_importance": "useful",
      "candidate_question": "除了咳嗽，这几天有没有发烧、嗓子疼或者喘不上气的情况？",
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
          "summary": "咳嗽三天，此前说两天后更正为三天",
          "evidence_turn_ids": [
            "turn_995fb60fedaf4506b85425e186272ce2",
            "turn_902dbb0381754982a955cb2ce07eda32"
          ],
          "context_ids": []
        },
        "symptom_character": {
          "status": "known",
          "summary": "大多是干咳，偶尔有一点白痰；晚上明显些",
          "evidence_turn_ids": [
            "turn_995fb60fedaf4506b85425e186272ce2",
            "turn_0ed4bfd8e9c241dc9730041263de970e"
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
  },
  "10": {
    "input": {
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
        },
        {
          "turn_id": "turn_0ed4bfd8e9c241dc9730041263de970e",
          "text": "大多是干咳，偶尔有一点白痰。",
          "version": 1,
          "responding_to": {
            "turn_id": "turn_9b0c45209d4a4b389bfe28a2f675283f",
            "text": "好的，我把咳嗽的时间改成三天，不是两天。 咳嗽的时候有痰吗，还是干咳？"
          }
        },
        {
          "turn_id": "turn_7dfe07fed7e84974a92597703a659a29",
          "text": "刚才说错了，白痰是前天的，今天没有痰，主要是干咳。我没量体温。",
          "version": 1,
          "responding_to": {
            "turn_id": "turn_a06d10d16d2344c99000df4c14104c14",
            "text": "好的，我把咳嗽时间改成三天，也记下大多是干咳、偶尔有一点白痰。"
          }
        }
      ],
      "health_context": [],
      "controller": {
        "asked_categories": [
          "main_complaint",
          "symptom_character"
        ],
        "closed_categories": [],
        "question_counts": {
          "main_complaint": 1,
          "onset_course": 0,
          "symptom_character": 1,
          "aggravating_relieving": 0,
          "associated_symptoms": 0,
          "functional_impact": 0,
          "relevant_history": 0,
          "prior_actions_results": 0
        },
        "asked_questions": [
          "您好，我会帮您把不舒服的地方记清楚，方便和医生说。您今天最难受的是什么？",
          "咳嗽的时候有痰吗，还是干咳？"
        ],
        "question_count": 2,
        "no_new_fact_count": 0,
        "last_question_category": "symptom_character",
        "linked_context_ids": [],
        "grounded_answers": [
          {
            "category": "symptom_character",
            "turn_id": "turn_0ed4bfd8e9c241dc9730041263de970e",
            "version": 1,
            "quote": "大多是干咳，偶尔有一点白痰。",
            "responding_to": {
              "turn_id": "turn_9b0c45209d4a4b389bfe28a2f675283f",
              "text": "好的，我把咳嗽的时间改成三天，不是两天。 咳嗽的时候有痰吗，还是干咳？"
            },
            "question": "咳嗽的时候有痰吗，还是干咳？"
          }
        ]
      },
      "approved_risk_rules": []
    },
    "draft": {
      "user_intent": "correction",
      "latest_turn_adds_fact": true,
      "reply_text": "好的，我按您更正后的说法记录：咳嗽三天，主要是干咳，白痰是前天出现过，今天没有痰；体温您还没量过。",
      "suggested_action": "ask",
      "question_category": "associated_symptoms",
      "question_importance": "useful",
      "candidate_question": "除了咳嗽，这几天有没有发烧、嗓子疼、喘不上气或胸口不舒服？",
      "clinical_state": {
        "main_complaint": {
          "status": "known",
          "summary": "咳嗽，晚上更明显",
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
          "status": "known",
          "summary": "主要是干咳；白痰为前天出现，今天无痰",
          "evidence_turn_ids": [
            "turn_0ed4bfd8e9c241dc9730041263de970e",
            "turn_7dfe07fed7e84974a92597703a659a29"
          ],
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
          "status": "known",
          "summary": "未量体温",
          "evidence_turn_ids": [
            "turn_7dfe07fed7e84974a92597703a659a29"
          ],
          "context_ids": []
        }
      },
      "relevant_context_ids": [],
      "unknowns": [
        {
          "text": "未量体温",
          "evidence_turn_ids": [
            "turn_7dfe07fed7e84974a92597703a659a29"
          ],
          "context_ids": []
        }
      ],
      "contradictions": [
        {
          "text": "咳嗽时间先说两天，后更正为三天",
          "evidence_turn_ids": [
            "turn_995fb60fedaf4506b85425e186272ce2",
            "turn_902dbb0381754982a955cb2ce07eda32"
          ],
          "context_ids": []
        },
        {
          "text": "痰的情况先说偶尔有一点白痰，后更正为白痰是前天的、今天没有痰",
          "evidence_turn_ids": [
            "turn_0ed4bfd8e9c241dc9730041263de970e",
            "turn_7dfe07fed7e84974a92597703a659a29"
          ],
          "context_ids": []
        }
      ],
      "risk_candidates": []
    }
  },
  "11": {
    "input": {
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
        },
        {
          "turn_id": "turn_0ed4bfd8e9c241dc9730041263de970e",
          "text": "大多是干咳，偶尔有一点白痰。",
          "version": 1,
          "responding_to": {
            "turn_id": "turn_9b0c45209d4a4b389bfe28a2f675283f",
            "text": "好的，我把咳嗽的时间改成三天，不是两天。 咳嗽的时候有痰吗，还是干咳？"
          }
        },
        {
          "turn_id": "turn_7dfe07fed7e84974a92597703a659a29",
          "text": "刚才说错了，白痰是前天的，今天没有痰，主要是干咳。我没量体温。",
          "version": 1,
          "responding_to": {
            "turn_id": "turn_a06d10d16d2344c99000df4c14104c14",
            "text": "好的，我把咳嗽时间改成三天，也记下大多是干咳、偶尔有一点白痰。"
          }
        },
        {
          "turn_id": "turn_95f20c1739de4823b530864a761a6131",
          "text": "先说到这里，帮我整理给医生看。",
          "version": 1,
          "responding_to": {
            "turn_id": "turn_55648dd9384f4551bf62756d8475a05a",
            "text": "好的，我按您更正后的说法记录：咳嗽三天，主要是干咳，白痰是前天出现过，今天没有痰；体温您还没量过。"
          }
        }
      ],
      "health_context": [],
      "controller": {
        "asked_categories": [
          "main_complaint",
          "symptom_character"
        ],
        "closed_categories": [],
        "question_counts": {
          "main_complaint": 1,
          "onset_course": 0,
          "symptom_character": 1,
          "aggravating_relieving": 0,
          "associated_symptoms": 0,
          "functional_impact": 0,
          "relevant_history": 0,
          "prior_actions_results": 0
        },
        "asked_questions": [
          "您好，我会帮您把不舒服的地方记清楚，方便和医生说。您今天最难受的是什么？",
          "咳嗽的时候有痰吗，还是干咳？"
        ],
        "question_count": 2,
        "no_new_fact_count": 0,
        "last_question_category": "symptom_character",
        "linked_context_ids": [],
        "grounded_answers": [
          {
            "category": "symptom_character",
            "turn_id": "turn_0ed4bfd8e9c241dc9730041263de970e",
            "version": 1,
            "quote": "大多是干咳，偶尔有一点白痰。",
            "responding_to": {
              "turn_id": "turn_9b0c45209d4a4b389bfe28a2f675283f",
              "text": "好的，我把咳嗽的时间改成三天，不是两天。 咳嗽的时候有痰吗，还是干咳？"
            },
            "question": "咳嗽的时候有痰吗，还是干咳？"
          }
        ]
      },
      "approved_risk_rules": []
    },
    "draft": {
      "user_intent": "explicit_finish",
      "latest_turn_adds_fact": false,
      "reply_text": "好的，我按您更正后的说法整理：咳嗽三天，主要是干咳，白痰是前天出现过、今天没有痰，体温还没量过。这些会整理成给医生看的记录。",
      "suggested_action": "finish",
      "question_category": null,
      "question_importance": null,
      "candidate_question": "",
      "clinical_state": {
        "main_complaint": {
          "status": "known",
          "summary": "咳嗽",
          "evidence_turn_ids": [
            "turn_995fb60fedaf4506b85425e186272ce2"
          ],
          "context_ids": []
        },
        "onset_course": {
          "status": "known",
          "summary": "咳嗽三天，晚上明显些",
          "evidence_turn_ids": [
            "turn_995fb60fedaf4506b85425e186272ce2",
            "turn_902dbb0381754982a955cb2ce07eda32"
          ],
          "context_ids": []
        },
        "symptom_character": {
          "status": "known",
          "summary": "大多是干咳，偶尔有一点白痰；白痰是前天出现，今天没有痰，主要是干咳",
          "evidence_turn_ids": [
            "turn_0ed4bfd8e9c241dc9730041263de970e",
            "turn_7dfe07fed7e84974a92597703a659a29"
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
          "status": "known",
          "summary": "没量体温",
          "evidence_turn_ids": [
            "turn_7dfe07fed7e84974a92597703a659a29"
          ],
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
        },
        {
          "text": "痰的情况先说偶尔有一点白痰，后更正为白痰是前天的、今天没有痰",
          "evidence_turn_ids": [
            "turn_0ed4bfd8e9c241dc9730041263de970e",
            "turn_7dfe07fed7e84974a92597703a659a29"
          ],
          "context_ids": []
        }
      ],
      "risk_candidates": []
    }
  },
  "12": {
    "input": {
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
        },
        {
          "turn_id": "turn_0ed4bfd8e9c241dc9730041263de970e",
          "text": "大多是干咳，偶尔有一点白痰。",
          "version": 1,
          "responding_to": {
            "turn_id": "turn_9b0c45209d4a4b389bfe28a2f675283f",
            "text": "好的，我把咳嗽的时间改成三天，不是两天。 咳嗽的时候有痰吗，还是干咳？"
          }
        }
      ],
      "health_context": [
        {
          "context_id": "context_b4fb18ea933d466c903b8918b1d60d55",
          "category": "conditions",
          "text": "两年前医生记录过哮喘，平时没有每天用药。",
          "source": "user_confirmed"
        }
      ],
      "controller": {
        "asked_categories": [
          "main_complaint",
          "symptom_character"
        ],
        "closed_categories": [],
        "question_counts": {
          "main_complaint": 1,
          "onset_course": 0,
          "symptom_character": 1,
          "aggravating_relieving": 0,
          "associated_symptoms": 0,
          "functional_impact": 0,
          "relevant_history": 0,
          "prior_actions_results": 0
        },
        "asked_questions": [
          "您好，我会帮您把不舒服的地方记清楚，方便和医生说。您今天最难受的是什么？",
          "咳嗽的时候有痰吗，还是干咳？"
        ],
        "question_count": 2,
        "no_new_fact_count": 0,
        "last_question_category": "symptom_character",
        "linked_context_ids": []
      },
      "approved_risk_rules": []
    },
    "draft": {
      "user_intent": "answer",
      "latest_turn_adds_fact": true,
      "reply_text": "您更正为咳嗽三天，我按三天记录；干咳为主、偶尔有一点白痰也记下了。",
      "suggested_action": "ask",
      "question_category": "associated_symptoms",
      "question_importance": "useful",
      "candidate_question": "这几天咳嗽的时候，有没有发烧、喘不上气或胸口不舒服？",
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
          "status": "known",
          "summary": "大多是干咳，偶尔有一点白痰",
          "evidence_turn_ids": [
            "turn_0ed4bfd8e9c241dc9730041263de970e"
          ],
          "context_ids": []
        },
        "aggravating_relieving": {
          "status": "known",
          "summary": "晚上明显些",
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
          "status": "known",
          "summary": "两年前医生记录过哮喘，平时没有每天用药",
          "evidence_turn_ids": [],
          "context_ids": [
            "context_b4fb18ea933d466c903b8918b1d60d55"
          ]
        },
        "prior_actions_results": {
          "status": "missing",
          "summary": "",
          "evidence_turn_ids": [],
          "context_ids": []
        }
      },
      "relevant_context_ids": [
        "context_b4fb18ea933d466c903b8918b1d60d55"
      ],
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
  },
  "13": {
    "input": {
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
        },
        {
          "turn_id": "turn_0ed4bfd8e9c241dc9730041263de970e",
          "text": "大多是干咳，偶尔有一点白痰。",
          "version": 1,
          "responding_to": {
            "turn_id": "turn_9b0c45209d4a4b389bfe28a2f675283f",
            "text": "好的，我把咳嗽的时间改成三天，不是两天。 咳嗽的时候有痰吗，还是干咳？"
          }
        }
      ],
      "health_context": [
        {
          "context_id": "context_9a6a4112ae444ba29afdda2a26658a12",
          "category": "procedures",
          "text": "三年前做过左膝关节镜手术，之后走路已恢复。",
          "source": "user_confirmed"
        }
      ],
      "controller": {
        "asked_categories": [
          "main_complaint",
          "symptom_character"
        ],
        "closed_categories": [],
        "question_counts": {
          "main_complaint": 1,
          "onset_course": 0,
          "symptom_character": 1,
          "aggravating_relieving": 0,
          "associated_symptoms": 0,
          "functional_impact": 0,
          "relevant_history": 0,
          "prior_actions_results": 0
        },
        "asked_questions": [
          "您好，我会帮您把不舒服的地方记清楚，方便和医生说。您今天最难受的是什么？",
          "咳嗽的时候有痰吗，还是干咳？"
        ],
        "question_count": 2,
        "no_new_fact_count": 0,
        "last_question_category": "symptom_character",
        "linked_context_ids": []
      },
      "approved_risk_rules": []
    },
    "draft": {
      "user_intent": "answer",
      "latest_turn_adds_fact": true,
      "reply_text": "您更正为咳嗽三天，我按三天记录；干咳为主、偶尔有一点白痰也记下了。",
      "suggested_action": "ask",
      "question_category": "associated_symptoms",
      "question_importance": "useful",
      "candidate_question": "除了咳嗽，这几天有没有发热、咽痛、气短或胸口不舒服？",
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
          "status": "known",
          "summary": "大多是干咳，偶尔有一点白痰",
          "evidence_turn_ids": [
            "turn_0ed4bfd8e9c241dc9730041263de970e"
          ],
          "context_ids": []
        },
        "aggravating_relieving": {
          "status": "known",
          "summary": "晚上明显些",
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
def offline_only(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError("No network, provider, credential or budget action")
    for name in ("connect", "connect_ex", "sendto"):
        monkeypatch.setattr(socket.socket, name, denied)
    monkeypatch.setattr(socket, "create_connection", denied)
    monkeypatch.setattr(adapter.Config, "from_env", classmethod(denied))
    monkeypatch.setattr(c, "provider_from", denied)
    monkeypatch.setattr(model_client, "_open_request", denied)
    for name in ("authorize_request", "report_usage", "stop_trial"):
        monkeypatch.setattr(trial_gate, name, denied)


def process(capture):
    payload = {k: deepcopy(v) for k, v in capture["input"].items() if k != "approved_risk_rules"}
    before = deepcopy(payload)
    class SavedDraft:
        c = SimpleNamespace(model="deepseek-flash")
        def complete_json(self, system, body):
            assert system == c.SYSTEM_PROMPT
            assert body["approved_risk_rules"] == []
            return deepcopy(capture["draft"])
    result = c.conversation_turn(payload, SavedDraft())
    assert payload == before
    return result


@pytest.mark.parametrize("capture_id,expected", [
    ("9", "除了咳嗽，这几天有没有发烧的情况？"),
    ("10", "除了咳嗽，这几天有没有发烧？"),
    ("12", "这几天咳嗽的时候，有没有发烧？"),
    ("13", "除了咳嗽，这几天有没有发热？"),
])
def test_saved_compounds_deliver_one_existing_item(capture_id, expected):
    capture = deepcopy(CAPTURES[capture_id]); original = deepcopy(capture)
    assert not c._easy_single_question(capture["draft"]["candidate_question"])
    result = process(capture)
    assert result["action"] == "ask"
    assert result["assistant_text"].endswith(expected)
    assert result["assistant_text"].count("？") == 1
    assert result["question_category"] == "associated_symptoms"
    assert result["controller"]["question_count"] == 3
    assert result["controller"]["asked_questions"][-1] == expected
    assert result["completeness"]["clinical_state"]["associated_symptoms"]["status"] == "missing"
    assert capture == original
    if capture_id == "12":
        assert result["completeness"]["relevant_context_ids"] == ["context_b4fb18ea933d466c903b8918b1d60d55"]
    elif capture_id == "13":
        assert result["completeness"]["relevant_context_ids"] == []


def test_saved_explicit_end_never_adds_question_and_keeps_correction():
    result = process(deepcopy(CAPTURES["11"]))
    assert result["action"] == "finish" and result["stop_reason"] == "user_finished"
    assert "？" not in result["assistant_text"]
    state = result["completeness"]["clinical_state"]
    assert "今天没有痰" in state["symptom_character"]["summary"]
    assert "没量体温" in state["prior_actions_results"]["summary"]


@pytest.mark.parametrize("question", [
    "除了咳嗽，这几天有没有发烧，另外有没有胸口痛？",
    "除了咳嗽，这几天有没有发烧？胸口痛吗？",
    "除了咳嗽，这几天有没有发烧和喘不上气？",
    "除了咳嗽，这几天有没有没有发烧、喘不上气？",
    "除了咳嗽，这几天有没有发烧、不确定是否喘不上气？",
    "除了咳嗽，如果发烧，有没有嗓子疼、喘不上气？",
    "除了咳嗽，这几天有没有发烧、喘不上气时才胸口痛？",
    "除了咳嗽，这几天有没有发烧、应该停药？",
    "除了咳嗽，这几天有没有发烧、银行卡转账？",
    "除了咳嗽，这几天有没有发烧、喜欢电影？",
    "除了咳嗽，这几天有没有我发烧、家属胸口痛？",
    "除了咳嗽，这几天有没有发烧、不记得喘不上气？",
    "除了咳嗽，这几天有没有发烧、胸口不舒服但不疼？",
    "除了电影，这几天有没有发烧、嗓子疼？",
    "这几天有没有发烧、嗓子疼？",
    "睡觉的时候，有没有发烧、嗓子疼？",
    "除了咳嗽，这几天有没有肺癌导致胸痛、发烧？",
    "除了咳嗽，这几天有没有发烧且胸口痛、气短？",
    "除了咳嗽，这几天有没有吐槽电影、发烧？",
    "除了咳嗽，这几天有没有发烧、胸口不疼？",
])
def test_ambiguous_unrelated_multiple_or_unsafe_candidates_stay_blocked(question):
    capture = deepcopy(CAPTURES["9"]); capture["draft"]["candidate_question"] = question
    try:
        result = process(capture)
    except c.ConversationError as error:
        assert error.code == "model_schema_invalid"
        return
    assert result["action"] != "ask"
    assert question not in result["assistant_text"]
    assert result["controller"]["question_count"] == 2


def test_repeated_first_item_uses_next_original_item_with_shared_suffix():
    capture = deepcopy(CAPTURES["9"])
    capture["input"]["controller"]["asked_questions"].append("咳嗽的时候，有没有发烧？")
    result = process(capture)
    assert result["assistant_text"].endswith("除了咳嗽，这几天有没有嗓子疼的情况？")
    assert result["controller"]["question_count"] == 3


@pytest.mark.parametrize("boundary", ["exact_repeat", "all_items_asked", "closed", "category_limit", "fatigue", "hard_limit"])
def test_controller_boundaries_are_unchanged(boundary):
    capture = deepcopy(CAPTURES["9"]); ctrl = capture["input"]["controller"]
    if boundary == "exact_repeat":
        ctrl["asked_questions"].append(capture["draft"]["candidate_question"])
    elif boundary == "all_items_asked":
        ctrl["asked_questions"] += [f"咳嗽的时候，有没有{x}？" for x in ["发烧", "嗓子疼", "喘不上气"]]
    elif boundary == "closed":
        ctrl["closed_categories"].append("associated_symptoms")
    elif boundary == "category_limit":
        ctrl["question_counts"]["associated_symptoms"] = 2
    elif boundary == "fatigue":
        ctrl["question_count"] = 8
    else:
        ctrl["question_count"] = 12
    result = process(capture)
    assert result["action"] != "ask"
    assert result["controller"]["question_count"] == ctrl["question_count"]


def test_patient_question_branch_uses_same_single_item_selection():
    capture = deepcopy(CAPTURES["9"]); capture["draft"]["user_intent"] = "patient_question"
    result = process(capture)
    assert result["action"] == "ask"
    assert result["assistant_text"].endswith("除了咳嗽，这几天有没有发烧的情况？")


@pytest.mark.parametrize("asked,original_item", [
    ("发烧", "发热"), ("发热", "发烧"),
    ("嗓子疼", "咽痛"), ("咽痛", "嗓子疼"),
    ("喘不上气", "气短"), ("气短", "喘不上气"),
])
def test_supported_alternate_wording_does_not_repeat_an_asked_item(asked, original_item):
    capture = deepcopy(CAPTURES["9"])
    capture["input"]["controller"]["asked_questions"].append(f"咳嗽的时候，有没有{asked}？")
    capture["draft"]["candidate_question"] = f"除了咳嗽，这几天有没有{original_item}、胸口不舒服？"
    result = process(capture)
    assert result["action"] == "ask"
    assert result["assistant_text"].endswith("除了咳嗽，这几天有没有胸口不舒服？")
    assert result["controller"]["asked_questions"][-1] == "除了咳嗽，这几天有没有胸口不舒服？"
    assert result["completeness"]["clinical_state"]["associated_symptoms"]["status"] == "missing"


def test_all_alternate_wordings_already_asked_block_original_candidate():
    capture = deepcopy(CAPTURES["13"])
    capture["input"]["controller"]["asked_questions"] += [
        f"咳嗽的时候，有没有{item}？" for item in ["发烧", "嗓子疼", "喘不上气", "胸口不舒服"]
    ]
    result = process(capture)
    assert result["action"] == "reply"
    assert result["controller"]["question_count"] == 2
