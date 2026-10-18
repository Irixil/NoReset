"""Check unreviewed public-case quarantine via HTTP; never attest source review."""
import argparse
import json
import os
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replay(base_url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    token = ''

    def request(method, path, body=None, key=None):
        headers = {'Content-Type': 'application/json', 'X-Session-Token': token}
        if key:
            headers['Idempotency-Key'] = key
        req = urllib.request.Request(base_url + path, method=method, headers=headers,
                                     data=None if body is None else json.dumps(body).encode())
        try:
            response = opener.open(req, timeout=60)
        except urllib.error.HTTPError as ex:
            response = ex
        with response:
            return response.status, json.load(response)

    status, health = request('GET', '/health')
    assert status == 200
    token = health['session_token']
    dataset = json.loads((ROOT / 'data/public_cases/cases.json').read_text(encoding='utf-8'))
    rows = []
    for case in dataset['cases']:
        payload = {'raw_text': case['input'], 'source_kind': 'document', 'actor_name': '公开病例演示', 'occurred_time': None}
        status, saved = request('POST', '/api/events', payload, case['id'])
        assert status in (200, 201), saved
        event = saved['event']
        rid = event['record_id']
        assert event['local_safety']['danger_detected'] == case['expected_local_danger']
        # Same key + exact payload must not create a second record.
        status, repeated = request('POST', '/api/events', payload, case['id'])
        assert status == 200 and repeated['event']['record_id'] == rid and repeated['created'] is False
        # Published text is still unreviewed document evidence. This script
        # cannot impersonate the person comparing a record with its original.
        for action, body in (
            ('organize', {'expected_version': event['version']}),
            ('review', {'expected_version': event['version'], 'action': 'confirm'}),
        ):
            status, denied = request('POST', f'/api/events/{rid}/{action}', body)
            assert status == 409 and denied.get('error') == 'document_source_review_required', {
                'case_id': case['id'], 'action': action, 'status': status, 'result': denied}
        status, queried = request('GET', f'/api/events/{rid}')
        assert status == 200 and queried['event'] == event and event['raw_text'] == case['input']
        assert event['state'] == 'inbox' and not event.get('source_review')
        status, history = request('GET', f'/api/events/{rid}/history')
        assert status == 200 and len(history['history']) == 1
        rows.append({'case_id': case['id'], 'record_id': rid, 'state': event['state'],
                     'local_danger_detected': event['local_safety']['danger_detected'],
                     'raw_text_queryable': True, 'idempotency_checked': True, 'history_count': len(history['history']),
                     'organize_blocked': True, 'confirmation_blocked': True})
    status, generated = request('POST', '/api/handoffs', {})
    assert status == 201
    card = generated['handoff']
    status, fetched = request('GET', '/api/handoffs/' + card['handoff_id'])
    assert status == 200 and fetched['handoff'] == card
    record_ids = {row['record_id'] for row in rows}
    pending_ids = {item['record_id'] for item in card['pending_documents']
                   if item['reason'] == 'document_source_review_required'}
    assert record_ids <= pending_ids
    assert not record_ids.intersection(item['record_id'] for item in card['items'])
    return {'passed': True, 'provider': health['provider'], 'dataset_version': dataset['dataset_version'],
            'patients': 1, 'extracts': len(rows), 'rows': rows, 'handoff_id': card['handoff_id'],
            'unreviewed_documents_quarantined': True, 'source_review_performed': False,
            'record_confirmation_performed': False,
            'limitations': ['公开论文改编摘要，不是原始病历或真实用户试验', '只检查未核对资料的保存与隔离，不自动代替人工核对',
                            'mock 不代表真实模型整理质量', '未命中规则不代表医学正常']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', help='可选：向已启动的本地服务导入；省略时使用临时数据库和 mock')
    parser.add_argument('--out', default='runtime/demo-result.json')
    args = parser.parse_args()
    if args.base_url:
        # Keep this seed utility local. A hosted deployment needs separate access controls.
        from urllib.parse import urlparse
        parsed = urlparse(args.base_url)
        if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost'}:
            parser.error('--base-url 仅接受本地 HTTP 地址')
        result = replay(args.base_url.rstrip('/'))
    else:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ['DB_PATH'] = str(Path(tmp) / 'demo.sqlite3')
            os.environ['MODEL_PROVIDER'] = 'mock'
            from backend import server
            from backend.store import SQLiteStore
            server.STORE = SQLiteStore(os.environ['DB_PATH'])
            httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
            worker = threading.Thread(target=httpd.serve_forever, daemon=True)
            worker.start()
            try:
                result = replay(f'http://127.0.0.1:{httpd.server_port}')
                # A fresh connection after HTTP work must read the same original text.
                restored = SQLiteStore(os.environ['DB_PATH'])
                result['database_reopen_checked'] = all(restored.get(r['record_id']) for r in result['rows'])
            finally:
                httpd.shutdown()
                httpd.server_close()
                worker.join(timeout=2)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'passed': result['passed'], 'provider': result['provider'], 'patients': 1, 'extracts': result['extracts'], 'report': str(out)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
