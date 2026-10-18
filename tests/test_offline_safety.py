import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from backend import adapter
from backend.safety import CLINICAL_REVIEW_VERSION, DANGER_REMINDER, RULE_VERSION, scan_danger
from backend.store import SQLiteStore, now


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv('DB_PATH', str(tmp_path / 'records.sqlite3'))
    monkeypatch.setenv('MODEL_PROVIDER', 'mock')
    from backend import server
    store = SQLiteStore(str(tmp_path / 'records.sqlite3'))
    monkeypatch.setattr(server, 'STORE', store)
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
    worker = threading.Thread(target=httpd.serve_forever, daemon=True)
    worker.start()
    base = f'http://127.0.0.1:{httpd.server_port}'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(method, path, body=None, key=None):
        headers = {'Content-Type': 'application/json', 'X-Session-Token': server.SESSION_TOKEN}
        if key:
            headers['Idempotency-Key'] = key
        req = urllib.request.Request(base + path, method=method, headers=headers,
                                     data=None if body is None else json.dumps(body).encode())
        try:
            response = opener.open(req, timeout=5)
        except urllib.error.HTTPError as ex:
            response = ex
        with response:
            return response.status, json.load(response)

    yield request, store
    httpd.shutdown()
    httpd.server_close()
    worker.join(timeout=2)


def create(request, text, key='input'):
    status, body = request('POST', '/api/events',
                          {'raw_text': text, 'source_kind': 'elder', 'actor_name': '演示用户'}, key)
    assert status == 201
    return body['event']


@pytest.mark.parametrize('text', ['今天散步，吃饭和睡觉都和平时一样。', '胸口疼，喘不上气', '心率40次/分'])
@pytest.mark.parametrize('failure', ['offline', 'timeout', 'invalid_json', 'empty', 'unexpected', 'invalid_object'])
def test_failure_keeps_original_and_notice(api, monkeypatch, text, failure):
    request, store = api
    event = create(request, text)
    rid = event['record_id']
    expected = scan_danger(text)
    # Saving alone must return the notice, before any model call.
    assert event['local_safety'] == expected

    class Broken:
        def complete_json(self, *_):
            saved = SQLiteStore(store.path).get(rid)
            assert saved['raw_text'] == text
            assert saved['local_safety'] == expected
            if failure == 'offline':
                raise urllib.error.URLError('network unavailable')
            if failure == 'timeout':
                raise TimeoutError('provider timeout')
            if failure == 'invalid_json':
                raise json.JSONDecodeError('invalid', 'no-json', 0)
            if failure == 'empty':
                return None
            if failure == 'invalid_object':
                return {'summary': 'missing required fields'}
            raise RuntimeError('provider internal error; must not leak this body')

    monkeypatch.setattr(adapter, 'provider_from', lambda: Broken())
    status, result = request('POST', f'/api/events/{rid}/organize', {'expected_version': 1})
    assert status == 422
    assert result['ok'] is False and result['ai_failed'] is True
    assert result['raw_text_preserved'] is True
    assert 'output' not in result
    assert result['local_safety'] == expected
    assert result['danger_detected'] == expected['danger_detected']
    assert 'provider internal error' not in json.dumps(result)
    status, saved = request('GET', f'/api/events/{rid}')
    assert status == 200
    assert saved['event']['raw_text'] == text
    assert saved['event']['draft'] is None
    assert saved['event']['state'] == 'inbox' and saved['event']['version'] == 1
    history, audit = store.history(rid)
    assert history and audit[-1]['action'] == 'organize_failed'
    assert audit[-1]['details']['failure_type']
    assert audit[-1]['details']['local_safety'] == expected
    restored = SQLiteStore(store.path)
    assert restored.get(rid)['local_safety'] == expected
    status, card = request('POST', '/api/handoffs', {})
    assert status == 201
    assert card['handoff']['items'][0]['local_safety'] == expected
    assert ('local_danger_detected' in card['handoff']['items'][0]['unresolved_reasons']) == expected['danger_detected']
    assert ('clinical_measurement_review_required' in card['handoff']['items'][0]['unresolved_reasons']) == expected['clinical_review_required']
    assert request('POST', f'/api/events/{rid}/review', {'expected_version': 1, 'action': 'confirm'})[0] == 409


def test_success_keeps_existing_flow_and_cannot_clear_local_warning(api, monkeypatch):
    request, store = api
    raw = '胸口疼，喘不上气'
    event = create(request, raw)

    class MissedDanger:
        def complete_json(self, prompt, payload):
            out = adapter.MockProvider().complete_json(prompt, payload)
            out.update(escalation_level='none', review_role='family')
            return out

    monkeypatch.setattr(adapter, 'provider_from', lambda: MissedDanger())
    status, result = request('POST', f"/api/events/{event['record_id']}/organize", {'expected_version': 1})
    assert status == 200 and result['ai_failed'] is False
    assert result['danger_detected'] and result['safety_guard_applied']
    assert result['output']['escalation_level'] == 'emergency'
    assert result['output']['review_role'] == 'emergency_services'
    assert result['output']['plan_change_allowed'] is False
    assert DANGER_REMINDER in result['output']['follow_up_questions']
    status, result = request('POST', f"/api/events/{event['record_id']}/review",
                             {'expected_version': 2, 'action': 'confirm', 'note': '仅确认原话'})
    assert status == 200 and result['event']['confirmation_scope'] == 'record_accuracy'
    assert store.handoff()['items'][0]['unresolved']


@pytest.mark.parametrize('text', ['胸痛', '胸口疼', '胸闷', '喘不上气', '呼吸不上来', '呼吸困难',
    '叫不醒', '昏迷', '意识不清', '抽搐', '大量出血', '止不住血', '突然不能说话', '口角歪',
    '一侧无力', '严重摔倒', '头部受伤', '血压200/90', '血压160/120', '血压70/40',
    '喘不过气', '喊不醒', '嘴角歪', '血流不止', '血压１８０／１１０', '收缩压190',
    '呼吸很困难', '说话含糊', '突发右侧无力', '严重出血', '摔倒', '呕吐停不下来'])
def test_requested_and_legacy_rules(text):
    assert scan_danger(text)['danger_detected']


@pytest.mark.parametrize('text', ['今天睡得很好', '散步二十分钟', '血压120/80', '今天吃了早饭', '准备下周去复诊'])
def test_ordinary_inputs_do_not_match(text):
    result = scan_danger(text)
    assert not result['danger_detected'] and result['danger_reminder'] is None


@pytest.mark.parametrize(('text', 'rule'), [
    ('现在胸口很疼。', 'chest'),
    ('胸部一直疼痛', 'chest'),
    ('胸口有点痛', 'chest'),
    ('呼吸十分困难', 'breathing'),
    ('呼吸有点儿困难', 'breathing'),
    ('呼吸又快又困难', 'breathing'),
    ('突然右手无力', 'neurologic_description'),
    ('突然左腿没劲', 'neurologic_description'),
    ('突然说不出话', 'neurologic_description'),
    ('呕吐停不住', 'persistent_vomiting'),
    ('呕吐还没有停止', 'persistent_vomiting'),
    ('呕吐无法停止', 'persistent_vomiting'),
    ('持续呕吐', 'persistent_vomiting'),
    ('老人连续呕吐，家属问能不能把今天的药全部停掉。', 'persistent_vomiting'),
    ('血压：180/110', 'extreme_pressure_number'),
    ('血压为：１８０／１１０', 'extreme_pressure_number'),
    ('血压 = 180 / 90 mmHg', 'extreme_pressure_number'),
    ('收缩压：190', 'extreme_pressure_number'),
    ('低压：45', 'extreme_pressure_number'),
    ('血压 180.5/80', 'extreme_pressure_number'),
    ('血压180/110.', 'extreme_pressure_number'),
    ('血压180/110.5.', 'extreme_pressure_number'),
    ('收缩压180.', 'extreme_pressure_number'),
])
def test_supported_expression_and_measurement_formats(text, rule):
    result = scan_danger(text)
    assert rule in result['matched_rules']
    assert result['escalation_level'] == 'emergency'
    assert result['review_role'] == 'emergency_services'
    assert result['danger_reminder'] == DANGER_REMINDER
    assert result['safety_rule_version'] == RULE_VERSION == 'offline-danger-v2'


@pytest.mark.parametrize('text', [
    '没有胸痛', '今天没有胸痛。', '否认胸痛', '未出现胸闷',
    '没有呼吸困难', '呕吐已经停止', '呕吐停止了', '呕吐已经停了',
    '血压：120/80', '血压120.5/80.5', '血压120/80.',
    '血压120/8000', '血压1800/80', '收缩压1800',
])
def test_clear_denials_or_resolved_vomiting_do_not_match(text):
    result = scan_danger(text)
    assert result['matched_rules'] == []
    # This is the scanner's absence of a notice, not an assessment of health.
    assert result['danger_detected'] is False
    assert result['danger_reminder'] is None
    assert 'safe' not in result and 'normal' not in result


@pytest.mark.parametrize(('text', 'rules'), [
    ('没有胸痛但喘不上气', {'breathing'}),
    ('没有胸痛，后来又胸口很疼', {'chest'}),
    ('没有胸痛，突然右手无力', {'neurologic_description'}),
    ('呕吐已经停止，但还是呼吸困难', {'breathing'}),
    ('呕吐终于停了但止不住血', {'bleeding'}),
    ('否认胸痛；血压：180/110', {'extreme_pressure_number'}),
    ('没有胸痛，但呕吐停不下来', {'persistent_vomiting'}),
    ('没有胸痛。老人胸痛。女儿胸痛。', {'chest'}),
])
def test_denial_of_one_mention_does_not_hide_other_evidence(text, rules):
    result = scan_danger(text)
    assert set(result['matched_rules']) == rules
    assert result['danger_detected'] is True
    assert len(result['matched_rules']) == len(set(result['matched_rules']))


@pytest.mark.parametrize('text', [
    '不是没有胸痛', '并非没有胸痛', '不确定有没有胸痛',
    '可能没有胸痛', '好像没有胸痛', '不敢说没有胸痛',
    '没有胸痛吗？', '没有胸痛？', '有没有胸痛',
    '没有人说没有胸痛', '从未否认胸痛', '没有胸痛是不可能的',
    '没有胸痛的记录不准确', '没有胸痛还说不准',
    '如果没有胸痛就散步', '假如没有胸痛就散步',
    '没有胸痛的证据', '没有胸痛记录，尚待核实',
    '昨天胸痛，今天好了', '曾经胸痛',
])
def test_uncertainty_double_negation_and_history_keep_conservative_notice(text):
    assert 'chest' in scan_danger(text)['matched_rules']


@pytest.mark.parametrize('text', [
    '呼吸平稳，困难的是买菜', '突然来访。老人说手脚一直无力',
    '呕吐过一次，后来停止吃饭', '呕吐已经停止',
])
def test_patterns_do_not_join_unrelated_clauses(text):
    assert not scan_danger(text)['danger_detected']


@pytest.mark.parametrize('text', [
    '患者的心率在此前数月曾低至每分钟40次。',
    '静息脉搏 38 bpm。',
    '心率低于40次/分。',
    '心跳≤４０次每分钟。',
    'HR: 39.5 bpm',
    '脉搏每分40下',
    '如果心率40次/分该怎么办？',
    '心率不是40次/分，是80次/分。',
])
def test_low_heart_rate_is_batch_marked_for_clinical_review_only(text):
    result = scan_danger(text)
    assert result['danger_detected'] is False
    assert result['danger_reminder'] is None
    assert result['clinical_review_flags'] == ['low_heart_rate_candidate']
    assert result['clinical_review_required'] is True
    assert result['clinical_review_role'] == 'clinician_or_pharmacist'
    assert result['clinical_review_version'] == CLINICAL_REVIEW_VERSION
    assert '不是诊断' in result['clinical_review_notice']


@pytest.mark.parametrize('text', [
    '心率41次/分', '心率40.5次/分', '血压140/40', '40次/分钟走路',
    '呼吸每分钟20次', '每分钟40次呼吸', '按摩每分钟40下',
    '心率40mg', '心率40年前', '心率4,000次/分', '心率4000次/分',
    '心率40次/秒', '心率40次/小时', '心率为0次/分',
    '心率不详，呼吸每分钟20次', '心率不详。每分钟40次',
    '心率记录有40个', '脉搏计电量40%', '心率，体温40℃',
    '心率\n每分钟40次', '心率每分钟40次呼吸', '心率每分钟40次/小时',
    '心率40bpm2', '心率40次/分米',
])
def test_low_heart_rate_candidate_has_context_boundaries(text):
    result = scan_danger(text)
    assert result['clinical_review_flags'] == []
    assert result['clinical_review_required'] is False


def test_candidate_survives_confirmation_restart_and_handoff(api):
    request, store = api
    raw = '历史资料：心率40次/分，当前情况未核实。'
    event = create(request, raw)
    rid = event['record_id']
    assert event['local_safety']['clinical_review_status'] == 'candidate_unverified'
    status, result = request('POST', f'/api/events/{rid}/organize', {'expected_version': 1})
    assert status == 200
    assert result['output']['review_role'] == 'clinician_or_pharmacist'
    assert result['output']['escalation_level'] == 'none'
    assert result['output']['plan_change_allowed'] is False
    assert result['output']['summary'] == raw
    status, review = request('POST', f'/api/events/{rid}/review', {'expected_version': 2, 'action': 'confirm'})
    assert status == 200
    assert review['event']['confirmation_scope'] == 'record_accuracy'
    reopened = SQLiteStore(store.path)
    assert reopened.get(rid)['local_safety']['clinical_review_required']
    card = reopened.handoff()['items'][0]
    assert card['unresolved'] is True
    assert 'clinical_measurement_review_required' in card['unresolved_reasons']


def test_candidate_does_not_replace_existing_emergency_route():
    payload = {'record_id': 'candidate-emergency', 'raw_text': '胸痛伴心率40次/分', 'source_kind': 'elder'}
    result = adapter.organize_event(payload, adapter.MockProvider())
    assert result['local_safety']['clinical_review_required'] is True
    assert result['output']['escalation_level'] == 'emergency'
    assert result['output']['review_role'] == 'emergency_services'
    assert DANGER_REMINDER in result['output']['follow_up_questions']


def test_candidate_rule_upgrade_is_not_medical_clearance():
    from backend.safety import reconcile_safety
    old = dict(scan_danger('心率40次/分'), clinical_review_version='old-review-flags')
    current = reconcile_safety('心率41次/分', old)
    assert current['danger_detected'] is False
    assert current['historical_clinical_review_preserved'] is True
    assert current['clinical_review_required'] is True
    assert current['previous_clinical_review_flags'] == ['low_heart_rate_candidate']


def test_revision_keeps_owner_and_rescans_raw_text(tmp_path):
    store = SQLiteStore(str(tmp_path / 'r.sqlite3'))
    household = store.create_household('演示', '演示用户', password='valid-password')
    event, _ = store.create({'raw_text': '胸痛', 'actor_name': '演示用户', 'source_kind': 'elder'}, 'k', household_id=household['household_id'])
    new = store.revise(event['record_id'], 1, {'raw_text': '修正录入：今天散步正常', 'actor_name': '演示用户', 'source_kind': 'elder', 'reason': '输入错误'}, '演示用户')
    assert new['household_id'] == household['household_id']
    assert not new['local_safety']['danger_detected']
    assert store.get(event['record_id'])['local_safety']['danger_detected']
    assert [x['record_id'] for x in store.handoff(household['household_id'])['items']] == [new['record_id']]


def test_historical_handoff_quarantines_document_revision_mislabeled_as_elder(tmp_path):
    store = SQLiteStore(tmp_path / 'legacy-handoff.sqlite3')
    household = store.create_household('虚构家庭', '虚构家属')
    document, _ = store.create(
        {'raw_text': '虚构原件内容', 'source_kind': 'document', 'actor_name': '虚构家属'},
        'document-source', household_id=household['household_id'],
    )
    revised = store.revise(
        document['record_id'], 1,
        {'raw_text': '虚构 OCR 修订内容', 'source_kind': 'elder', 'actor_name': '虚构家属', 'reason': '历史修订'},
        '虚构家属',
    )
    # Simulate an older database revision that persisted the inherited source
    # incorrectly. _get must recover its source from the immutable ancestor.
    with store.transaction() as conn:
        conn.execute('DROP TRIGGER preserve_event_evidence')
        conn.execute("UPDATE events SET source_kind='elder' WHERE record_id=?", (revised['record_id'],))
    assert store.get(revised['record_id'])['source_kind'] == 'document'

    created_at = now()
    snapshot_item = {**revised, 'source_kind': 'elder', 'source_review': None}
    handoff_id = 'handoff_legacy_document_revision'
    snapshot = {
        'handoff_id': handoff_id,
        'created_at': created_at,
        'household_id': household['household_id'],
        'items': [snapshot_item],
        'pending_documents': [],
        'unresolved_count': 0,
    }
    with store.transaction() as conn:
        conn.execute(
            'INSERT INTO handoffs(handoff_id,created_at,snapshot_json,household_id) VALUES(?,?,?,?)',
            (handoff_id, created_at, json.dumps(snapshot, ensure_ascii=False), household['household_id']),
        )

    # Later verification must not rewrite the historical handoff's point-in-time review state.
    current = store.source_review(revised['record_id'], revised['version'], True, '虚构家属')
    assert current['source_review']['confirmed_at']
    historical = store.get_handoff(handoff_id)
    assert historical['items'] == []
    assert historical['created_at'] == created_at
    assert historical['pending_documents'] == [{
        'record_id': revised['record_id'],
        'recorded_at': snapshot_item['recorded_at'],
        'reason': 'document_source_review_required',
    }]
    assert snapshot_item['raw_text'] not in json.dumps(historical, ensure_ascii=False)

    with store.connection() as conn:
        persisted = json.loads(conn.execute(
            'SELECT snapshot_json FROM handoffs WHERE handoff_id=?', (handoff_id,),
        ).fetchone()['snapshot_json'])
    assert persisted['created_at'] == created_at
    assert persisted['items'][0]['raw_text'] == snapshot_item['raw_text']
    assert persisted['items'][0]['recorded_at'] == snapshot_item['recorded_at']
    assert persisted['items'][0]['source_kind'] == 'elder'
    assert persisted['items'][0]['source_review'] is None


@pytest.mark.parametrize('violation', ['schema', 'source_id', 'quote', 'occurred_time', 'recorded_time', 'medical_advice'])
def test_existing_validators_still_reject_and_preserve_raw(api, monkeypatch, violation):
    request, store = api
    event = create(request, '今天散步二十分钟。')

    class Invalid:
        def complete_json(self, prompt, payload):
            out = adapter.MockProvider().complete_json(prompt, payload)
            if violation == 'schema':
                out['event_kind'] = 'unsupported'
            elif violation == 'source_id':
                out['claims'][0]['record_id'] = 'invented-id'
            elif violation == 'quote':
                out['claims'][0]['quote'] = '原文没有这句话'
            elif violation == 'occurred_time':
                out['time']['occurred'] = '2026-01-01T10:00:00Z'
            elif violation == 'recorded_time':
                out['time']['recorded'] = '2026-01-01T10:00:00Z'
            else:
                out['summary'] = '建议停药'
            return out

    monkeypatch.setattr(adapter, 'provider_from', lambda: Invalid())
    status, result = request('POST', f"/api/events/{event['record_id']}/organize", {'expected_version': 1})
    assert status == 422 and result['ai_failed']
    assert store.get(event['record_id'])['draft'] is None
    assert request('GET', f"/api/events/{event['record_id']}")[1]['event']['raw_text'] == event['raw_text']
