"""Offline input-contract preflight; every clinical/semantic review stays pending."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from backend import adapter
from backend.adapter import AdapterError, MockProvider, organize_event
from backend.evaluation import evaluate_dataset, passes, payload_for, sha256, write_report


DEFAULT_DATASET = 'data/synthetic/evaluation-preflight-v1.json'
DEFAULT_OUT = 'runtime/evaluations/synthetic-preflight-v1.json'
DOCUMENT_REJECTION = 'document_source_review_required'


def validate_fixture_policy(dataset):
    policy = dataset.get('source_policy', {})
    if policy.get('case_data') != 'synthetic' or policy.get('external_records_used') is not False:
        raise ValueError('前置评测只接受独立合成资料，不读取外部病例。')
    if dataset.get('clinical_review_status') != 'pending' or dataset.get('semantic_review_status') != 'pending':
        raise ValueError('离线前置评测必须保留临床与语义待审状态。')
    cases = dataset.get('cases', [])
    rejected = dataset.get('rejection_cases', [])
    if not cases or not rejected:
        raise ValueError('前置评测须同时包含合法输入和预期拒绝输入。')
    ids = [case['id'] for case in cases + rejected]
    if len(ids) != len(set(ids)):
        raise ValueError('所有前置评测输入 ID 必须唯一。')
    for case in cases + rejected:
        if case.get('synthetic_only') is not True or case.get('clinical_review_status') != 'pending':
            raise ValueError('每例必须明确为合成且临床待审。')
        if not case.get('manual_required'):
            raise ValueError('每例必须保留人工语义复核事项。')
    if any(case.get('expected_rejection') != DOCUMENT_REJECTION for case in rejected):
        raise ValueError('本版本的拒绝样例仅评估资料原件核对门槛。')


class CountingMockProvider(MockProvider):
    def __init__(self):
        self.calls = 0

    def complete_json(self, system_prompt, payload):
        self.calls += 1
        return super().complete_json(system_prompt, payload)


def evaluate_preflight(dataset):
    validate_fixture_policy(dataset)
    report = evaluate_dataset(dataset, lambda payload: organize_event(payload, MockProvider()),
                              expected_provider='MockProvider', capture_output=True)
    rejections = []
    for case in dataset['rejection_cases']:
        provider = CountingMockProvider()
        actual_code = None
        try:
            organize_event(payload_for(case, dataset), provider)
        except AdapterError as error:
            if error.code == DOCUMENT_REJECTION:
                actual_code = error.code
        rejections.append({
            'id': case['id'], 'expected_code': DOCUMENT_REJECTION, 'actual_code': actual_code,
            'provider_calls': provider.calls,
            'assertions': [
                {'field': 'rejection.code', 'status': 'passed' if actual_code == DOCUMENT_REJECTION else 'failed'},
                {'field': 'rejection.before_provider', 'status': 'passed' if provider.calls == 0 else 'failed'},
            ],
        })
    rejection_checks = [check for row in rejections for check in row['assertions']]
    report['rejection_counts'] = {
        'total': len(rejections),
        'assertions_passed': sum(check['status'] == 'passed' for check in rejection_checks),
        'assertions_failed': sum(check['status'] == 'failed' for check in rejection_checks),
        'provider_calls': sum(row['provider_calls'] for row in rejections),
    }
    report.update(rejection_rows=rejections, gate='offline_input_contract_preflight',
                  gate_pass=passes(report, strict=True) and report['rejection_counts']['assertions_failed'] == 0,
                  provider='mock', model='mock', evaluation_type='synthetic_contract_preflight',
                  synthetic_only=True, clinical_review_status='pending', semantic_review_status='pending',
                  clinical_identity_verified=False, real_asr_ocr_verified=False,
                  prompt_version=adapter.PROMPT_VERSION, prompt_sha256=adapter.PROMPT_SHA256,
                  schema_version=adapter.SCHEMA_VERSION,
                  disclaimer='只验证可执行整理输入合同，不证明真实服务、临床身份、动态对话、完整语义或临床安全。')
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', default=DEFAULT_DATASET)
    parser.add_argument('--out', default=DEFAULT_OUT)
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    dataset_path = root / args.dataset
    dataset = json.loads(dataset_path.read_text(encoding='utf-8'))
    report = evaluate_preflight(dataset)
    report.update(dataset_version=dataset['version'], dataset_sha256=sha256(dataset_path))
    write_report(report, root / args.out)
    return 0 if report['gate_pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
