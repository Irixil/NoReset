"""Offline description matching. A match is a notice, never a diagnosis."""
import re
import unicodedata
import hashlib
import json
from datetime import date
from pathlib import Path

RULE_VERSION = 'offline-danger-v2'
CLINICAL_REVIEW_VERSION = 'offline-review-flags-v1'
DANGER_REMINDER = '您刚才说的情况可能需要紧急处理，请立即联系 120，或由家属陪同前往急诊。不要自行加药、减药或停药。'
SOON_EVALUATION_REMINDER = '您刚才说的情况需要尽快让医生当面评估，请让家属陪同就医。具体需要做哪些检查，由接诊医生判断。'
URGENT_REVIEWED_REMINDER = '您刚才说的情况可能需要紧急处理，请立即联系 120，或由家属陪同前往急诊。'
REVIEWED_RISK_PATH = Path(__file__).resolve().parents[1] / 'config' / 'reviewed-risk-rules.json'
RISK_CONTRACT_VERSION = 'reviewed-risk-candidates-v1'


def load_reviewed_risk_rules(path=None, *, allow_test_fixture=False):
    """Load trusted local review metadata, never model-authored approval.

    This verifies the software contract, not a clinician's qualifications or
    clinical performance. Synthetic fixtures are disabled by default.
    """
    registry = {'rule_set_version': 'unavailable', 'rules': [], 'config_sha256': None,
                'clinical_validation': 'not_completed', 'status': 'no_approved_rules'}
    try:
        raw = Path(path or REVIEWED_RISK_PATH).read_bytes()
        if len(raw) > 65536:
            return registry
        registry['config_sha256'] = hashlib.sha256(raw).hexdigest()
        document = json.loads(raw)
        version = document.get('rule_set_version')
        if not isinstance(version, str) or not version.strip():
            return registry
        registry['rule_set_version'] = version
        fixture = document.get('scope') == 'synthetic_test_fixture'
        if document.get('scope') not in {'production', 'synthetic_test_fixture'} or (fixture and not allow_test_fixture):
            return registry
        if document.get('medical_signoff') != 'approved' or not isinstance(document.get('rules'), list) or len(document['rules']) > 50:
            return registry
        seen = set()
        for rule in document['rules']:
            if not isinstance(rule, dict):
                continue
            review = rule.get('clinical_review')
            if not isinstance(review, dict) or review.get('status') != 'approved':
                continue
            if any(not isinstance(review.get(key), str) or not review[key].strip()
                   for key in ('reviewer_id', 'reviewer_role', 'reviewed_at', 'evidence_ref')):
                continue
            if review['reviewer_role'] not in {'physician', 'nurse', 'pharmacist'}:
                continue
            try:
                date.fromisoformat(review['reviewed_at'])
            except ValueError:
                continue
            if any(not isinstance(rule.get(key), str) or not rule[key].strip()
                   for key in ('rule_id', 'version', 'pattern', 'description')):
                continue
            if rule['level'] not in {'soon_evaluation', 'urgent'} or len(rule['pattern']) > 500 or rule['rule_id'] in seen:
                continue
            try:
                re.compile(rule['pattern'])
            except re.error:
                continue
            seen.add(rule['rule_id'])
            registry['rules'].append(dict(rule))
        if registry['rules']:
            registry.update(status='reviewed_rules_loaded', clinical_validation=(
                'synthetic_fixture_only' if fixture else 'clinical_review_metadata_present'))
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        registry['rules'] = []
    return registry


def evaluate_reviewed_risk(candidates, turns, registry=None):
    """Require current, unabridged patient evidence and a reviewed local match."""
    registry = registry if registry is not None else load_reviewed_risk_rules()
    result = {key: registry[key] for key in ('rule_set_version', 'status', 'clinical_validation', 'config_sha256')}
    result.update(contract_version=RISK_CONTRACT_VERSION, level='none', notice=None,
                  matched_rules=[], sources=[], rejected_candidates=0)
    rules = {(rule['rule_id'], rule['version']): rule for rule in registry['rules']}
    sources = {turn['turn_id']: turn for turn in turns}
    if not isinstance(candidates, list) or len(candidates) > 8:
        result['rejected_candidates'] = 1
        return result
    accepted = []
    for candidate in candidates:
        valid = isinstance(candidate, dict) and set(candidate) == {'rule_id', 'rule_version', 'evidence'}
        rule = rules.get((candidate.get('rule_id'), candidate.get('rule_version'))) if valid and isinstance(candidate.get('rule_id'), str) and isinstance(candidate.get('rule_version'), str) else None
        evidence = candidate.get('evidence') if valid else None
        valid = bool(rule and isinstance(evidence, list) and 1 <= len(evidence) <= 8)
        if valid:
            for item in evidence:
                source = sources.get(item.get('turn_id')) if isinstance(item, dict) and isinstance(item.get('turn_id'), str) else None
                if (not isinstance(item, dict) or set(item) != {'turn_id', 'version', 'quote'}
                        or not source or type(item['version']) is not int or item['version'] != source.get('version', 1)
                        or not isinstance(item['quote'], str) or item['quote'] != source['text']):
                    valid = False
                    break
        if not valid:
            result['rejected_candidates'] += 1
            continue
        # Match full original statements independently; a model cannot obtain
        # a level by selecting a substring or quoting confirmed history alone.
        if not any(re.search(rule['pattern'], item['quote']) for item in evidence):
            continue
        accepted.append((rule, evidence))
    for rule, evidence in accepted:
        match = {'rule_id': rule['rule_id'], 'version': rule['version'], 'level': rule['level'], 'evidence': []}
        prior = next((item for item in result['matched_rules'] if item['rule_id'] == rule['rule_id'] and item['version'] == rule['version']), None)
        if prior is None:
            result['matched_rules'].append(match)
            prior = match
        for item in evidence:
            if item not in prior['evidence']:
                prior['evidence'].append(dict(item))
            if item not in result['sources']:
                result['sources'].append(dict(item))
        if rule['level'] == 'urgent' or result['level'] == 'none':
            result['level'] = rule['level']
    result['notice'] = {'soon_evaluation': SOON_EVALUATION_REMINDER,
                        'urgent': URGENT_REVIEWED_REMINDER}.get(result['level'])
    return result


def reviewed_risk_manifest(registry=None):
    """Expose approval identity for the browser; never expose rule patterns."""
    registry = registry if registry is not None else load_reviewed_risk_rules()
    return {key: registry[key] for key in ('rule_set_version', 'status', 'clinical_validation', 'config_sha256')} | {
        'contract_version': RISK_CONTRACT_VERSION,
        'rules': [{key: rule[key] for key in ('rule_id', 'version', 'level')} for rule in registry['rules']],
    }

# These are description rules, not clinically validated triage criteria. Only
# unambiguous, local negation is excluded; uncertain and historical mentions
# remain eligible for a notice. A non-match never establishes medical safety.
INTENSIFIER = r'(?:(?:突然|一直|仍然|还是|非常|特别|明显|很|有点儿?|有些|持续|十分|极其|越来越)(?:地|的)?){0,2}'
RULES = (
    ('chest', rf'胸(?:口|部)?{INTENSIFIER}(?:疼痛|疼|痛)|胸闷'),
    ('breathing', rf'呼吸{INTENSIFIER}(?:又(?:快|急促|费力)又)?困难|喘不(?:上|过)(?:来)?气|喘不过来|呼吸不上来|喘不上来|呼吸费力'),
    ('consciousness', r'昏迷|叫不醒|喊不醒|唤不醒|意识不清|失去意识|不省人事'),
    ('convulsion', r'抽搐|全身抽动'),
    ('bleeding', r'大量出血|严重出血|止不住血|出血不止|血流不止'),
    ('neurologic_description', r'(?:突然|突发)[^，。！？；\n]{0,8}(?:不能说话|说不出话|不会说话|无力|没劲)|口角歪|嘴角歪|一侧(?:肢体)?无力|半边(?:身体)?(?:无力|没劲)|说话含糊'),
    ('injury', r'严重摔倒|摔倒|头部受伤|头部外伤|摔伤头部|撞到头|磕到头'),
    ('persistent_vomiting', r'呕吐(?:还|还是|仍|仍然|一直|总是|根本|完全|就是|怎么也){0,2}(?:停不(?:下来|住|了)|不停|不止|止不住|没(?:有)?停|无法停止|不能停止)|(?:不停|持续|连续|反复)(?:地)?呕吐'),
    ('extreme_pressure_description', r'血压(?:极高|极低|非常高|非常低|高得吓人|低得吓人)'),
)
MEASUREMENT_PREFIX = r'\s*(?:(?:高达|达到|超过|是|为|降至|升至|测得|测量为)\s*)?[:=]?\s*'
# Bound numbers so a substring of 1100 or 180.5 is not read as 110 or 180.
PRESSURE_NUMBER = r'([0-9]{2,3}(?:\.[0-9]+)?)(?![0-9]|\.[0-9])'
PRESSURE_PAIR = re.compile(r'血压' + MEASUREMENT_PREFIX + PRESSURE_NUMBER + r'\s*(?:/|比|[，,])\s*' + PRESSURE_NUMBER)
PRESSURE_SINGLE = re.compile(r'(收缩压|高压|舒张压|低压)' + MEASUREMENT_PREFIX + PRESSURE_NUMBER)
# Require a named metric, a complete numeric token and an explicit per-minute
# unit. Unsupported/ambiguous forms belong in the offline review backlog, not
# an invented measurement. Never cross into another metric or sentence.
HEART_RATE_LABEL = r'(?:心率|脉搏|心跳|(?<![a-z])hr(?![a-z]))'
HEART_RATE_LINK = r'(?:[^\S\r\n]|[:=]|在|此前|之前|过去|数月|数日|昨天|今天|曾经|曾|静息|时|低至|降至|达到|测得|测量为|记录为|大约|约|为|不是|是|没有|不到|不超过|低于|少于|小于|<=|≤|<){0,12}'
HEART_RATE_NUMBER = r'(?<![0-9.,])([0-9]{1,3}(?:\.[0-9]{1,3})?)(?![0-9]|[.,][0-9])'
HEART_RATE_SUFFIX = r'(?![a-z0-9]|[^\S\r\n]*(?:呼吸|按摩|步行|/|每))'
HEART_RATE_PATTERNS = (
    re.compile(HEART_RATE_LABEL + HEART_RATE_LINK + HEART_RATE_NUMBER
               + r'[^\S\r\n]*(?:(?:次|下|拍)[^\S\r\n]*(?:/|每)[^\S\r\n]*(?:分钟|分)(?!钟|米|秒|时)|bpm)'
               + HEART_RATE_SUFFIX, re.I),
    re.compile(HEART_RATE_LABEL + HEART_RATE_LINK + r'(?:每分钟|每分)[^\S\r\n]*'
               + HEART_RATE_NUMBER + r'[^\S\r\n]*(?:次|下|拍)' + HEART_RATE_SUFFIX, re.I),
)
CLAUSE_BOUNDARY = re.compile(r'[，,。.!！?？;；\n]')
EXPLICIT_NEGATION = re.compile(r'(?:没有|未出现|未见|否认|并无|无)(?:出现|发生)?(?:明显|任何)?\s*$')
UNCERTAIN_NEGATION = re.compile(r'不(?:是|能|敢|确定|清楚|知道|一定)|并非|未必|难道|难说|有没有|是否|会不会|可能|好像|似乎|说不清|如果|假如|假设|倘若|要是|除非')


def _explicitly_negated(text, match):
    """Exclude a direct denial of this match, never the whole input.

    Questions, double negations and uncertainty keep the conservative notice.
    This is intentionally not a general Chinese negation/history parser.
    """
    prefix = CLAUSE_BOUNDARY.split(text[:match.start()])[-1]
    denial = EXPLICIT_NEGATION.search(prefix)
    if not denial or UNCERTAIN_NEGATION.search(prefix):
        return False
    # "没有人说没有胸痛" and "从未否认胸痛" are not symptom denials.
    if re.search(r'不|没|未|无|否', prefix[:denial.start()]):
        return False
    suffix = text[match.end():]
    clause_end = CLAUSE_BOUNDARY.search(suffix)
    local_suffix = suffix[:clause_end.start()] if clause_end else suffix
    if re.search(r'吗|么|呢|不可能|不属实|不准确|不对|不是真的|是假的|说错|错误|说不准|说不清|未确认|未经确认|证据|记录|资料|报告', local_suffix) or (clause_end and clause_end.group() in '?？'):
        return False
    return True


def scan_danger(raw_text):
    text = unicodedata.normalize('NFKC', str(raw_text or ''))
    matched = [name for name, pattern in RULES
               if any(not _explicitly_negated(text, match)
                      for match in re.finditer(pattern, text))]
    # MVP matching cutoffs, retaining the old 180/110 rule. No diagnosis,
    # severity estimate, medication decision, or assurance from a non-match.
    for match in PRESSURE_PAIR.finditer(text):
        systolic, diastolic = map(float, match.groups())
        if systolic >= 180 or diastolic >= 110 or systolic < 80 or diastolic < 50:
            matched.append('extreme_pressure_number')
    for label, value in PRESSURE_SINGLE.findall(text):
        value = float(value)
        if (label in ('收缩压', '高压') and (value >= 180 or value < 80)) or (label in ('舒张压', '低压') and (value >= 110 or value < 50)):
            matched.append('extreme_pressure_number')
    matched = list(dict.fromkeys(matched))
    # Preliminary clinical-review candidate only. This is deliberately kept
    # outside RULES: without clinician sign-off it must not become an
    # emergency diagnosis or automatic treatment decision.
    clinical_review_flags = []
    if any(0 < float(match.group(1)) <= 40
           for pattern in HEART_RATE_PATTERNS for match in pattern.finditer(text)):
        clinical_review_flags.append('low_heart_rate_candidate')
    return {
        'danger_detected': bool(matched),
        'escalation_level': 'emergency' if matched else 'none',
        'review_role': 'emergency_services' if matched else 'none',
        'danger_reminder': DANGER_REMINDER if matched else None,
        'matched_rules': matched,
        'safety_rule_version': RULE_VERSION,
        'legacy_clinical_review_status': 'active_unvalidated',
        'clinical_review_flags': clinical_review_flags,
        'clinical_review_version': CLINICAL_REVIEW_VERSION,
        'clinical_review_status': 'candidate_unverified' if clinical_review_flags else 'not_flagged',
        'clinical_review_required': bool(clinical_review_flags),
        'clinical_review_role': 'clinician_or_pharmacist' if clinical_review_flags else None,
        'clinical_review_notice': (
            '原文含心率或脉搏数值的待核查线索，可能涉及历史、转述、否定或假设；这不是诊断，也未确认是当前读数。请联系医生或护士核对，不要自行停药或调药。'
            if clinical_review_flags else None
        ),
    }


def reconcile_safety(raw_text, saved=None):
    """Refresh old rules without silently clearing a previously saved notice.

    The database and old revision snapshots keep the original scan unchanged.
    This derived view identifies both versions when the rules have changed.
    """
    current = scan_danger(raw_text)
    if saved and saved.get('clinical_review_version') != CLINICAL_REVIEW_VERSION:
        previous_flags = list(saved.get('clinical_review_flags') or [])
        current.update(previous_clinical_review_version=saved.get('clinical_review_version'),
                       previous_clinical_review_flags=previous_flags,
                       historical_clinical_review_preserved=bool(previous_flags) and not current['clinical_review_required'])
        if previous_flags:
            current.update(clinical_review_required=True,
                           clinical_review_status='candidate_unverified',
                           clinical_review_role='clinician_or_pharmacist')
            current['clinical_review_flags'] = list(dict.fromkeys(current['clinical_review_flags'] + previous_flags))
            current['clinical_review_notice'] = ('历史扫描曾标记待专业复核线索；规则变化不表示已完成医学复核。'
                                                  '请核对原文及历史版本，不要自行停药或调药。')
    if not saved or saved.get('safety_rule_version') == RULE_VERSION:
        return current
    current.update(previous_rule_version=saved.get('safety_rule_version'),
                   previous_danger_detected=bool(saved.get('danger_detected')),
                   previous_matched_rules=list(saved.get('matched_rules') or []),
                   historical_notice_preserved=bool(saved.get('danger_detected')) and not current['danger_detected'])
    if saved.get('danger_detected'):
        current.update(danger_detected=True, escalation_level='emergency',
                       review_role='emergency_services', danger_reminder=DANGER_REMINDER)
        current['matched_rules'] = list(dict.fromkeys(current['matched_rules'] + list(saved.get('matched_rules') or [])))
    return current
def document_needs_review(event):
    """Explicit source comparison is distinct from confirming an AI draft."""
    review = event.get('source_review') or {}
    return event.get('source_kind') == 'document' and not (
        isinstance(review, dict) and review.get('method') == 'original_comparison'
        and review.get('confirmed_at') and review.get('text') == event.get('raw_text')
    )
