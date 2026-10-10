"""Real loopback API; saved synthetic first draft and fictional provider only."""
from copy import deepcopy

from backend import conversation, model_client, server, trial_gate
from backend.ai_limits import AIRequestLimiter
from tests.http_support import HttpClient, running_http_server
from tests.test_local_first_http import configure, local_session
from tests.test_conversation_followup_questions_20261009 import SAVED, QUESTIONS, SavedSyntheticProvider


def test_followup_coverage_and_danger_via_authenticated_local_first_api(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setenv('APP_AUTO_BIND_LOOPBACK', 'true')
    # The route's production mock refusal remains unchanged. This fixture
    # injects an explicitly offline supplier at the actual conversation layer.
    monkeypatch.setattr(server, '_mock_text_provider', lambda: False)
    monkeypatch.setattr(server, 'AI_REQUEST_LIMITER', AIRequestLimiter())
    provider = SavedSyntheticProvider()
    monkeypatch.setattr(conversation, 'provider_from', lambda: provider)
    def forbidden(*args, **kwargs):
        raise AssertionError('No supplier transport or native trial in the free HTTP regression')
    monkeypatch.setattr(model_client, '_open_request', forbidden)
    for method in ('authorize_request', 'report_usage', 'stop_trial'):
        monkeypatch.setattr(trial_gate, method, forbidden)
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {'Content-Type': 'application/json'})
        headers = local_session(client)
        payload = deepcopy(SAVED['input']); payload.pop('approved_risk_rules', None)
        response = client.request('POST', '/api/ai/conversation-turn', payload, headers=headers)
        assert response.status == 200
        result = response.body
        assert result['raw_text_preserved_on_device'] is True
        assert result['completeness']['pending_questions'] == QUESTIONS
        assert result['controller']['followup_questions'] == QUESTIONS
        for index in range(3):
            payload['controller'] = deepcopy(result['controller'])
            payload['turns'].append({'turn_id': f'turn_http_answer{index:08}', 'version': 1,
                'text': '没有。', 'responding_to': {'turn_id': f'turn_http_question{index:08}', 'text': result['assistant_text']}})
            provider.finish = index == 2
            response = client.request('POST', '/api/ai/conversation-turn', payload, headers=headers)
            assert response.status == 200
            result = response.body
            assert result['completeness']['pending_questions'] == QUESTIONS[index + 1:]
            assert result['controller']['no_new_fact_count'] == 0
            assert result['stop_reason'] != 'user_finished'
            if index < 2:
                assert result['action'] == 'ask' and result['assistant_text'].endswith(QUESTIONS[index + 1])
        assert result['completeness']['clinical_state']['associated_symptoms']['evidence_turn_ids'] == [row['turn_id'] for row in payload['turns'][3:]]
        # An isolated boundary payload is deliberately distinct from a natural
        # UI journey: prove danger wins before count12/end/provider transport.
        payload = deepcopy(SAVED['input']); payload.pop('approved_risk_rules', None)
        payload['controller'] = deepcopy(result['controller'])
        payload['controller'].update(question_count=12, no_new_fact_count=2)
        payload['turns'].append({'turn_id': 'turn_http_currentdanger01', 'version': 1,
                                'text': '我现在喘不上气，结束吧。'})
        previous_calls = len(provider.inputs)
        response = client.request('POST', '/api/ai/conversation-turn', payload, headers=headers)
        assert response.status == 200
        assert response.body['action'] == 'urgent'
        assert response.body['assistant_text'] == conversation.DANGER_REMINDER
        assert response.body['stop_reason'] == 'urgent_rule'
        assert response.body['completeness']['complete'] is False
        assert len(provider.inputs) == previous_calls
        # API-only local-first mode never saves these fictional health inputs.
        assert server.STORE.list() == []
