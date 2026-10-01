(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HealthSafety = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RULE_VERSION = 'offline-danger-v2';
  const CLINICAL_REVIEW_VERSION = 'offline-review-flags-v1';
  const DANGER_REMINDER = '您刚才说的情况可能需要紧急处理，请立即联系 120，或由家属陪同前往急诊。不要自行加药、减药或停药。';
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

  return { CLINICAL_REVIEW_VERSION, DANGER_REMINDER, RULE_VERSION, scanDanger, documentNeedsReview };
});
