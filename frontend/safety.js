(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HealthSafety = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RULE_VERSION = 'offline-danger-v2';
  const CLINICAL_REVIEW_VERSION = 'offline-review-flags-v1';
  const DANGER_REMINDER = '您刚才说的情况可能需要紧急处理，请立即联系 120，或由家属陪同前往急诊。不要自行加药、减药或停药。';
  const SOON_EVALUATION_REMINDER = '您刚才说的情况需要尽快让医生当面评估，请让家属陪同就医。具体需要做哪些检查，由接诊医生判断。';
  const URGENT_REVIEWED_REMINDER = '您刚才说的情况可能需要紧急处理，请立即联系 120，或由家属陪同前往急诊。';
  const RISK_CONTRACT_VERSION = 'reviewed-risk-candidates-v1';
  const INTENSIFIER = '(?:(?:突然|一直|仍然|还是|非常|特别|明显|很|有点儿?|有些|持续|十分|极其|越来越)(?:地|的)?){0,2}';
  const rules = [
    ['chest', new RegExp(`胸(?:口|部)?${INTENSIFIER}(?:疼痛|疼|痛)|胸闷`, 'gu')],
    ['breathing', new RegExp(`呼吸${INTENSIFIER}(?:又(?:快|急促|费力)又)?困难|喘不(?:上|过)(?:来)?气|喘不过来|呼吸不上来|喘不上来|呼吸费力`, 'gu')],
    ['consciousness', /昏迷|叫不醒|喊不醒|唤不醒|意识不清|失去意识|不省人事/gu],
    ['convulsion', /抽搐|全身抽动/gu],
    ['bleeding', /大量出血|严重出血|止不住血|出血不止|血流不止/gu],
    ['neurologic_description', /(?:突然|突发)[^，。！？；\n]{0,8}(?:不能说话|说不出话|不会说话|无力|没劲)|口角歪|嘴角歪|一侧(?:肢体)?无力|半边(?:身体)?(?:无力|没劲)|说话含糊/gu],
    ['injury', /严重摔倒|摔倒|头部受伤|头部外伤|摔伤头部|撞到头|磕到头/gu],
    ['persistent_vomiting', /呕吐(?:还|还是|仍|仍然|一直|总是|根本|完全|就是|怎么也){0,2}(?:停不(?:下来|住|了)|不停|不止|止不住|没(?:有)?停|无法停止|不能停止)|(?:不停|持续|连续|反复)(?:地)?呕吐/gu],
    ['extreme_pressure_description', /血压(?:极高|极低|非常高|非常低|高得吓人|低得吓人)/gu],
  ];
  const clauseBoundary = /[，,。.!！?？;；\n]/;
  const explicitNegation = /(?:没有|未出现|未见|否认|并无|无)(?:出现|发生)?(?:明显|任何)?\s*$/u;
  const uncertainNegation = /不(?:是|能|敢|确定|清楚|知道|一定)|并非|未必|难道|难说|有没有|是否|会不会|可能|好像|似乎|说不清|如果|假如|假设|倘若|要是|除非/u;

  function explicitlyNegated(text, match) {
    const prefix = text.slice(0, match.index).split(clauseBoundary).at(-1);
    const denial = prefix.match(explicitNegation);
    if (!denial || uncertainNegation.test(prefix)) return false;
    const before = prefix.slice(0, denial.index);
    if (/不|没|未|无|否/u.test(before)) return false;
    const remainder = text.slice(match.index + match[0].length);
    const boundary = remainder.match(clauseBoundary);
    const suffix = boundary ? remainder.slice(0, boundary.index) : remainder;
    if (/吗|么|呢|不可能|不属实|不准确|不对|不是真的|是假的|说错|错误|说不准|说不清|未确认|未经确认|证据|记录|资料|报告/u.test(suffix)) return false;
    return !(boundary && /[?？]/u.test(boundary[0]));
  }

  function ruleMatches(text, expression) {
    expression.lastIndex = 0;
    return [...text.matchAll(expression)].some(match => !explicitlyNegated(text, match));
  }

  function scanPressure(text, matched) {
    const prefix = '\\s*(?:(?:高达|达到|超过|是|为|降至|升至|测得|测量为)\\s*)?[:=]?\\s*';
    const number = '([0-9]{2,3}(?:\\.[0-9]+)?)(?![0-9]|\\.[0-9])';
    const pair = new RegExp(`血压${prefix}${number}\\s*(?:/|比|[，,])\\s*${number}`, 'gu');
    const single = new RegExp(`(收缩压|高压|舒张压|低压)${prefix}${number}`, 'gu');
    for (const match of text.matchAll(pair)) {
      const systolic = Number(match[1]); const diastolic = Number(match[2]);
      if (systolic >= 180 || diastolic >= 110 || systolic < 80 || diastolic < 50) matched.push('extreme_pressure_number');
    }
    for (const match of text.matchAll(single)) {
      const value = Number(match[2]);
      if ((['收缩压', '高压'].includes(match[1]) && (value >= 180 || value < 80)) ||
          (['舒张压', '低压'].includes(match[1]) && (value >= 110 || value < 50))) matched.push('extreme_pressure_number');
    }
  }

  function lowHeartRateCandidate(text) {
    const metric = '(?:心率|脉搏|心跳|(?<![a-z])hr(?![a-z]))';
    const link = '(?:[^\\S\\r\\n]|[:=]|在|此前|之前|过去|数月|数日|昨天|今天|曾经|曾|静息|时|低至|降至|达到|测得|测量为|记录为|大约|约|为|不是|是|没有|不到|不超过|低于|少于|小于|<=|≤|<){0,12}';
    const number = '(?<![0-9.,])([0-9]{1,3}(?:\\.[0-9]{1,3})?)(?![0-9]|[.,][0-9])';
    const suffix = '(?![a-z0-9]|[^\\S\\r\\n]*(?:呼吸|按摩|步行|/|每))';
    const patterns = [
      new RegExp(`${metric}${link}${number}[^\\S\\r\\n]*(?:(?:次|下|拍)[^\\S\\r\\n]*(?:/|每)[^\\S\\r\\n]*(?:分钟|分)(?!钟|米|秒|时)|bpm)${suffix}`, 'giu'),
      new RegExp(`${metric}${link}(?:每分钟|每分)[^\\S\\r\\n]*${number}[^\\S\\r\\n]*(?:次|下|拍)${suffix}`, 'giu'),
    ];
    return patterns.some(pattern => [...text.matchAll(pattern)].some(match => Number(match[1]) > 0 && Number(match[1]) <= 40));
  }

  function scanDanger(rawText) {
    const text = String(rawText || '').normalize('NFKC');
    const matched = [];
    for (const [name, expression] of rules) if (ruleMatches(text, expression)) matched.push(name);
    scanPressure(text, matched);
    const matchedRules = [...new Set(matched)];
    const clinicalReviewFlags = lowHeartRateCandidate(text) ? ['low_heart_rate_candidate'] : [];
    return {
      danger_detected: matchedRules.length > 0,
      escalation_level: matchedRules.length ? 'emergency' : 'none',
      review_role: matchedRules.length ? 'emergency_services' : 'none',
      danger_reminder: matchedRules.length ? DANGER_REMINDER : null,
      matched_rules: matchedRules,
      safety_rule_version: RULE_VERSION,
      legacy_clinical_review_status: 'active_unvalidated',
      clinical_review_flags: clinicalReviewFlags,
      clinical_review_version: CLINICAL_REVIEW_VERSION,
      clinical_review_status: clinicalReviewFlags.length ? 'candidate_unverified' : 'not_flagged',
      clinical_review_required: clinicalReviewFlags.length > 0,
      clinical_review_role: clinicalReviewFlags.length ? 'clinician_or_pharmacist' : null,
      clinical_review_notice: clinicalReviewFlags.length ? '原文含心率或脉搏数值的待核查线索，可能涉及历史、转述、否定或假设；这不是诊断，也未确认是当前读数。请联系医生或护士核对，不要自行停药或调药。' : null,
    };
  }

  // An OCR result is a candidate until a person compares this exact text with
  // its source. A legacy recorded/draft state is not that attestation.
  function documentNeedsReview(event) {
    return event?.source_kind === 'document' && !(event.source_review?.method === 'original_comparison' &&
      event.source_review?.confirmed_at && event.source_review.text === event.raw_text);
  }

  function reviewedRiskSourcesCurrent(assessment, turns) {
    const current = new Map((turns || []).filter(turn => turn.role === 'elder' && !turn.superseded && !turn.is_mock)
      .map(turn => [turn.turn_id, turn]));
    return Array.isArray(assessment?.sources) && assessment.sources.length > 0 && assessment.sources.every(source => {
      const turn = current.get(source?.turn_id);
      return turn && Number.isInteger(source.version) && source.version === turn.version
        && typeof source.quote === 'string' && source.quote === turn.text;
    });
  }

  // The backend owns approved pattern matching. This second gate verifies only
  // its trusted manifest identity, current full-source evidence, and fixed text.
  // Metadata presence is not proof of clinical validation or model accuracy.
  function validateReviewedRisk(assessment, manifest, turns) {
    try {
      if (!assessment || !manifest || assessment.contract_version !== RISK_CONTRACT_VERSION
        || manifest.contract_version !== RISK_CONTRACT_VERSION || manifest.status !== 'reviewed_rules_loaded'
        || assessment.status !== manifest.status || !['synthetic_fixture_only', 'clinical_review_metadata_present'].includes(manifest.clinical_validation)
        || assessment.clinical_validation !== manifest.clinical_validation
        || typeof manifest.rule_set_version !== 'string' || !manifest.rule_set_version
        || assessment.rule_set_version !== manifest.rule_set_version
        || !/^[a-f0-9]{64}$/.test(manifest.config_sha256 || '') || assessment.config_sha256 !== manifest.config_sha256
        || !Array.isArray(manifest.rules) || !manifest.rules.length || manifest.rules.length > 50
        || !['soon_evaluation', 'urgent'].includes(assessment.level)
        || !Array.isArray(assessment.matched_rules) || !assessment.matched_rules.length || assessment.matched_rules.length > 8
        || Object.keys(assessment).sort().join(',') !== 'clinical_validation,config_sha256,contract_version,level,matched_rules,notice,rejected_candidates,rule_set_version,sources,status'
        || !Number.isInteger(assessment.rejected_candidates) || assessment.rejected_candidates < 0
        || !reviewedRiskSourcesCurrent(assessment, turns)) return null;
      const approved = new Map();
      for (const rule of manifest.rules) {
        if (typeof rule.rule_id !== 'string' || !rule.rule_id || typeof rule.version !== 'string' || !rule.version
          || !['soon_evaluation', 'urgent'].includes(rule.level)) return null;
        const key = JSON.stringify([rule.rule_id, rule.version]);
        if (approved.has(key)) return null;
        approved.set(key, rule.level);
      }
      const sourceKey = source => JSON.stringify([source.turn_id, source.version, source.quote]);
      const sourceKeys = new Set();
      for (const source of assessment.sources) {
        if (Object.keys(source).sort().join(',') !== 'quote,turn_id,version' || sourceKeys.has(sourceKey(source))) return null;
        sourceKeys.add(sourceKey(source));
      }
      const matched = new Set(), evidenceKeys = new Set();
      let level = 'soon_evaluation';
      for (const rule of assessment.matched_rules) {
        const key = JSON.stringify([rule.rule_id, rule.version]);
        if (Object.keys(rule).sort().join(',') !== 'evidence,level,rule_id,version' || matched.has(key)
          || approved.get(key) !== rule.level || !Array.isArray(rule.evidence) || !rule.evidence.length || rule.evidence.length > 8) return null;
        matched.add(key);
        if (rule.level === 'urgent') level = 'urgent';
        const ownEvidence = new Set();
        for (const source of rule.evidence) {
          if (Object.keys(source).sort().join(',') !== 'quote,turn_id,version'
            || !sourceKeys.has(sourceKey(source)) || ownEvidence.has(sourceKey(source))) return null;
          ownEvidence.add(sourceKey(source)); evidenceKeys.add(sourceKey(source));
        }
      }
      const notice = level === 'urgent' ? URGENT_REVIEWED_REMINDER : SOON_EVALUATION_REMINDER;
      if (level !== assessment.level || assessment.notice !== notice || evidenceKeys.size !== sourceKeys.size) return null;
      return { ...assessment, notice, sources: assessment.sources.map(source => ({ ...source })),
        matched_rules: assessment.matched_rules.map(rule => ({ ...rule, evidence: rule.evidence.map(source => ({ ...source })) })) };
    } catch { return null; }
  }

  return { CLINICAL_REVIEW_VERSION, DANGER_REMINDER, RULE_VERSION, scanDanger, documentNeedsReview,
    SOON_EVALUATION_REMINDER, URGENT_REVIEWED_REMINDER, RISK_CONTRACT_VERSION,
    validateReviewedRisk, reviewedRiskSourcesCurrent };
});
