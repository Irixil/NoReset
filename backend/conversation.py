"""Evidence-grounded, bounded clinical history intake.

The model chooses the next highest-value history question and drafts
source-linked facts. Deterministic code owns provenance, stopping, risk
messages and the prohibition on diagnosis or treatment advice.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import unicodedata
import uuid
from typing import Any

try:
    from .adapter import MockProvider, provider_from
    from .safety import DANGER_REMINDER, scan_danger, load_reviewed_risk_rules, evaluate_reviewed_risk, RISK_CONTRACT_VERSION
except ImportError:
    from adapter import MockProvider, provider_from
    from safety import DANGER_REMINDER, scan_danger, load_reviewed_risk_rules, evaluate_reviewed_risk, RISK_CONTRACT_VERSION


PROMPT_VERSION = "clinical-intake-v8-risk-candidates"
CATEGORIES = (
    "main_complaint", "onset_course", "symptom_character",
    "aggravating_relieving", "associated_symptoms", "functional_impact",
    "relevant_history", "prior_actions_results",
)
ESSENTIAL_CATEGORIES = (
    "main_complaint", "onset_course", "symptom_character", "functional_impact",
)
CLOSURE_CATEGORIES = ESSENTIAL_CATEGORIES + (
    "associated_symptoms", "relevant_history", "prior_actions_results",
)
MAX_QUESTIONS = 12
TYPICAL_QUESTION_LIMIT = 8
QUESTION_TEMPLATES = {
    "main_complaint": ("您今天最难受的是哪里，是什么感觉？", "您最想先告诉医生的是哪一处不舒服？"),
    "onset_course": ("这种不舒服大概什么时候开始，后来怎么变化的？", "我再问具体一点：这是今天突然开始，还是已经持续了几天？"),
    "symptom_character": ("这种不舒服具体是什么感觉，最难受时大概到什么程度？", "您用自己的话形容一下这种感觉，是怎样难受？"),
    "aggravating_relieving": ("做什么时会更明显，什么情况下会轻一些？", "活动、休息或姿势变化时，这种感觉会不会变化？"),
    "associated_symptoms": ("不舒服的时候，身体还有没有同时出现别的变化？", "除了刚才说的情况，还有什么是一起出现的？"),
    "functional_impact": ("它现在最影响您做什么，比如走路、吃饭或睡觉？", "这件事对您今天的活动影响到什么程度？"),
    "relevant_history": ("以前有没有出现过类似情况？", "这次之前，身体有没有与它相关的老问题或相似经历？"),
    "prior_actions_results": ("这次不舒服后，您已经做过什么，结果怎么样？", "您有没有量过数值、用过原来的药或看过资料，之后有什么变化？"),
}
FINISH_TEXT = "我已经把这次主要情况整理好了。还有想补充的可以继续说，不想说也可以直接退出。"
MODEL_FAILURE_TEXT = "您的原话已经保存。刚才没有连接上智能回复，您可以继续补充哪里不舒服、什么时候开始，以及最影响什么。"
MODEL_OUTPUT_BLOCKED_TEXT = "我不能提供诊断、用药或治疗建议。我先把您刚才说的原话记下来了。"

SYSTEM_PROMPT = """你是“NoReset”的健康对话助手，负责理解患者表达并作切题回应；记录与报告随对话形成。你要像有经验的临床工作者那样结合上下文理解患者、判断是否需要进一步了解并自然回应，但面向用户时始终是健康记录助手，不能自称医生，不能诊断或给治疗方案。

对话中逐步形成可纠错、可追溯、可交给接诊医生的事实记录与交接报告。每轮都要综合当前主诉、此前回答、用户已确认且与本次相关的健康背景、已问问题和疲劳边界。不要按固定字段顺序，不要因某个病名套专病问卷，也不要为了填满字段无休止追问。

可采集的八个维度：
- main_complaint：最主要的不舒服、部位和本人最在意的问题；
- onset_course：起始时间、起病方式、持续/反复及变化；
- symptom_character：本人描述的性质、程度、范围和频率；
- aggravating_relieving：与活动、休息、姿势、进食等可观察情境的关系；
- associated_symptoms：同一时间出现的其他身体变化，也包括明确否认；
- functional_impact：对行走、睡眠、进食、自理等的影响；
- relevant_history：与本次主诉确有关系的既往情况、相似发作、过敏或长期用药事实；
- prior_actions_results：本次已经做过的处理、已有测量/资料及结果。只能问已发生事实，不能建议做检查或改药。

规则：
1. 先真正回应老人最新一句话。用 reply_text 直接回答他提出的安全问题、说明你理解到哪里、接住担忧或更正；不要反复套“我听到您说……记下了”。只有在确有价值时才另外给一个 candidate_question；不需要问时留空。reply_text 不是病历事实，不能被当成患者证据。
2. 某条 turn 的 responding_to（如有）是老人实际回应的上一句助手问题，只能帮助理解上下文；它不是患者事实来源，不能引用为证据或改写成老人说过的话。
3. 临床事实只能进入 clinical_state，并且必须引用真实老人 turn_id 或 context_id；未知、矛盾、拒答必须保留，不能补写。已知事实的 summary 要短而具体，只描述对应分类；unknowns 只记录老人明确说不知道或不愿回答的内容，普通未提及项只用 clinical_state 的 missing 表示；不得把同一整段原话复制到多个分类或未知项。
4. health_context 只是用户确认的本机背景。只使用真正相关的条目，并把使用的 context_id 放入 relevant_context_ids；无关背景不得影响问题。
5. 绝对禁止诊断结论、病名猜测、治疗/处方、加减停换药、剂量、具体检查建议或把风险等级告诉用户。可以询问既往诊断、当前用药或已经做过的检查，前提是问事实而非给建议。
6. 医学原因/诊断问题要直接、温和地说明不能仅凭聊天判断，不猜病；可以继续帮他记录和梳理已说的情况。关于助手本身、记录怎么用、为什么提问等问题，应回答问题本身，不要误当成病情，也不要强行追问。
7. suggested_action=ask 时只给一个与当前上下文最相关的问题，放入 candidate_question；若当前不该追问，suggested_action=finish 且 candidate_question 为空。reply_text 用陈述句，不包含问号；问号只放在 candidate_question。
8. 通常总共 4 至 8 问，最多 12 问；用户明确结束、连续没有新事实或继续追问收益很低时及时 finish，不能无休止追问。
9. 只能输出下面结构的完整 JSON，不要 Markdown 或解释。

{"user_intent":"health_fact","latest_turn_adds_fact":true,"reply_text":"您说腿疼得伸不直，这听起来确实影响活动，我会按您说的记录。","suggested_action":"ask","question_category":"functional_impact","question_importance":"essential","candidate_question":"现在还能自己站起来或走几步吗？","clinical_state":{"main_complaint":{"status":"known","summary":"用户自述……","evidence_turn_ids":["turn_x"],"context_ids":[]},"onset_course":{"status":"missing","summary":"","evidence_turn_ids":[],"context_ids":[]},"symptom_character":{"status":"missing","summary":"","evidence_turn_ids":[],"context_ids":[]},"aggravating_relieving":{"status":"missing","summary":"","evidence_turn_ids":[],"context_ids":[]},"associated_symptoms":{"status":"missing","summary":"","evidence_turn_ids":[],"context_ids":[]},"functional_impact":{"status":"missing","summary":"","evidence_turn_ids":[],"context_ids":[]},"relevant_history":{"status":"missing","summary":"","evidence_turn_ids":[],"context_ids":[]},"prior_actions_results":{"status":"missing","summary":"","evidence_turn_ids":[],"context_ids":[]}},"relevant_context_ids":[],"unknowns":[],"contradictions":[]}

枚举与限制：
- user_intent: health_fact / answer / correction / declined / meta_feedback / patient_question / explicit_finish / unclear；
- suggested_action: ask / finish；question_importance: essential / useful / optional；
- reply_text: 可省略或为空，最多 500 字，不含问号；candidate_question: 可空，最多一个问题；
- status: known / unknown / declined / not_applicable / missing；
- ask 时 question_category 必须是八个维度之一；finish 时类别和重要性为 null、问题为空；
- known/unknown/declined 必须至少有一个真实 turn_id 或 context_id；missing/not_applicable 不得伪造来源；
- unknowns 和 contradictions 的每项结构为 {"text":"……","evidence_turn_ids":[],"context_ids":[]} 且至少有一个来源；
- summary、unknowns、contradictions 都必须是客观事实表达，不得包含推测或建议。known summary 尽量简短；unknowns.text 应对应来源中明确表达“不知道/不记得/不想说”的原话，不能把信息缺口改写成患者事实。"""
SYSTEM_PROMPT += """\n风险合同 reviewed-risk-candidates-v1：新增 risk_candidates 数组。只从程序提供的 approved_risk_rules 选择编号和版本；目录为空时必须返回 []。每项严格为 {"rule_id":"目录编号","rule_version":"目录版本","evidence":[{"turn_id":"真实患者回合编号","version":1,"quote":"该版本回合完整原话"}]}，最多8项。证据必须是当前患者回合全文与当前version，不能剪裁否定或历史词，不能引用助手问题，也不能只引用health_context。缺省version为1。模型不得输出等级、提醒、诊断或检查建议，最终判断和固定文案由本地审核规则决定。"""
PROMPT_SHA256 = hashlib.sha256(SYSTEM_PROMPT.encode("utf-8")).hexdigest()

_TURN_ID = re.compile(r"^turn_[A-Za-z0-9_-]{8,100}$")
_CONTEXT_ID = re.compile(r"^context_[A-Za-z0-9_-]{8,100}$")
_DECLINED = re.compile(r"不知道|不清楚|不记得|记不清|想不起来|不想说|不方便说|说不上来")
_EXPLICIT_UNKNOWN = _DECLINED
_EXPLICIT_FINISH = re.compile(r"^(?:没有了?|没了|就这些|就这样|先这样|不说了|结束吧?|可以了)[。！! ]*$")
_CORRECTION_REPLACEMENT = re.compile(r"不是(?P<old>[^，。；,;]{1,24})[，,；; ]*(?:而)?是(?P<new>[^，。；,;]+)")
_META_FEEDBACK = re.compile(
    r"没听懂|没听我说|不明白我|没理解|不看我说|为什么不问|怎么不问|问错了?|不是这个意思|照本宣科|固定流程|太死板|"
    r"为什么(?:要|总是)?问我|你问的是|"
    r"这个问题(?:里|中的|上)?[^。！？!?]{0,24}(?:是什么意思|是指什么|指什么|怎么理解)|"
    r"这个问题(?:是什么意思|是指什么|指什么)|你问的(?:这个)?问题[^。！？!?]{0,24}(?:是什么意思|是指什么|指什么)"
)
_CORRECTION = re.compile(r"说错了|不是.{0,10}是|改一下|更正|纠正")
_DIAGNOSIS_REQUEST = re.compile(r"(?:这是|到底|究竟)?(?:怎么了|怎么回事|什么情况|什么病)|为什么会这样|能不能告诉我.{0,12}(?:怎么了|什么情况|什么病)")
_NEGATIVE_ANSWER = re.compile(r"^(?:没有|没|无|不是|从来没有|没什么|没有别的)")
_TEMPORAL_CHANGE = r"(?:早晨|清晨|早上|上午|中午|下午|傍晚|晚上|昨晚|夜间|夜里|凌晨|白天)[^，。！？；,!?;]{0,8}(?:明显|加重|减轻|缓解|好转|好些)"
_PATTERNS = {
    "main_complaint": re.compile(r"疼|痛|酸|胀|刺痛|灼痛|晕|咳|喘|闷|恶心|吐|发热|发烧|无力|没劲|麻|痒|肿胀|肿起来|肿得|发肿|不舒服|难受|睡不着|吃不下|伸不直"),
    "onset_course": re.compile(r"今天|昨天|前天|刚才|早上|上午|中午|下午|晚上|半夜|最近|小时|分钟|天|周|月|年|开始|一直|后来|突然|慢慢|越来越|反复|时好时坏"),
    "symptom_character": re.compile(r"刺痛|胀痛|酸痛|酸|麻|烧|灼|跳着|隐隐|钝|刀割|压着|一阵|持续|较轻|轻微|不算重|偏重|剧烈疼痛|很疼|非常疼|程度|[一二三四五六七八九十\d]+分"),
    "aggravating_relieving": re.compile(_TEMPORAL_CHANGE + r"|活动|走路|上楼|下楼|弯|伸|躺|坐|站|休息|吃饭|空腹|更疼|减轻|缓解"),
    "associated_symptoms": re.compile(r"同时|还会|伴随|另外|胸(?:口|部)?(?:疼|痛)|胸闷|发烧|咳|吐|恶心|晕|麻|肿|喘|心慌|出汗"),
    "functional_impact": re.compile(r"影响|费劲|不稳|抓不住|拿不住|抬不起来|睡不着|睡不好|睡得(?:还好|好|不好)|睡眠(?:正常|还好|不好|受影响)|睡觉(?:受影响|不好|还好)|吃不下|走不了|不能走|平地(?:能|可)走|能(?:自己)?走路|可以自己走|走楼梯|上下楼|下不了地|起不来|伸不直|活动|自理|干活"),
    "relevant_history": re.compile(r"以前|之前也|老毛病|长期|过敏|手术|住院|一直吃|既往|病史"),
    "prior_actions_results": re.compile(r"量过|测过|做过|看过|查过|用了|吃了|处理|结果|报告|数值"),
}
_QUESTION_SCOPE = re.compile(r"哪里|哪儿|部位|感觉|怎么|什么时候|多久|开始|变化|后来|突然|逐渐|加重|减轻|反复|程度|影响|走|站|起|拿|抬|吃|睡|活动|发生|之前|前后|还有|伴随|同时|以前|类似|用药|过敏|手术|住院|量过|测过|做过|结果|资料|报告")
_UNSAFE_REPLY = re.compile(
    r"诊断为|确诊为|患有|(?:您|你)(?:已经)?得了|"
    r"(?:这是|就是|属于|判断为|表现为)[^，。！？;；!?]{0,16}(?:病|炎|症|癌|感染|梗|卒中|结石)(?=[，。！？;；!?]|$)|"
    r"(?:可能|考虑|怀疑|应当|应该|建议|最好).{0,12}(?:是|病|炎|癌|症|就医|检查|治疗|服用|用药)|"
    r"(?:建议|应该|应当|最好|可以|需要|请|先|自行|直接).{0,8}(?:吃药|服药|用药|做(?:核磁|CT|彩超|B超|化验|检查))|"
    r"加药|减药|停药|换药|加量|减量|改药|处方|剂量|药量|治疗方案|"
    r"去医院|去急诊|拨打\s*120|做(?:核磁|CT|彩超|B超|化验|检查)",
    re.IGNORECASE,
)
_DIRECT_MEDICAL_INSTRUCTION = re.compile(
    r"(?:服用|口服|注射|吃|用)[^，。！？;；!?]{0,12}[0-9一二三四五六七八九十百两半]+"
    r"(?:毫克|微克|克|毫升|片|粒|滴|单位|mg|mcg|ml)|"
    r"(?:增加|减少|增至|减至|调整到|改为)[^，。！？;；!?]{0,8}[0-9一二三四五六七八九十百两半]+"
    r"(?:毫克|微克|克|毫升|片|粒|滴|单位|mg|mcg|ml)|"
    r"(?:建议|应该|应当|最好|可以|需要|请|先|直接|去)[^，。！？;；!?]{0,8}"
    r"(?:血常规|血生化|心电图|脑电图|胃镜|肠镜|胸片|X光|MRI|CT|核磁|彩超|B超)|"
    r"(?:您|你|情况|身体|目前|现在)[^，。！？;；!?]{0,8}(?:很安全|没有问题|没事)|"
    r"没有.{0,3}(?:危险|风险)|(?:不用|无需|不需要|不必).{0,6}(?:就医|去医院|急救|120|看医生)",
    re.IGNORECASE,
)
_NON_HEALTH_ACTION = re.compile(r"银行卡|支付|付款|转账|密码|验证码|身份证|手机号|下载|打开链接|点击链接|扫码")
_CONTEXT_CATEGORIES = {"conditions", "medications", "allergies", "procedures", "tests", "similar_episodes"}


def _unsafe_reply(text: str) -> bool:
    """Allow recording past facts while still blocking new medical advice."""
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"[\s\u200b-\u200f\ufeff]", "", text)
    factual = re.sub(
        r"(?:(?:没|没有|尚未|还没|已经|曾经|以前|有没有|是否)做(?:过)?|做过)(?:核磁|CT|彩超|B超|化验|检查)",
        "已核对既往资料",
        text,
        flags=re.IGNORECASE,
    )
    factual = re.sub(
        r"(?:没|没有|尚未|还没|已经|曾经|以前|有没有|是否)(?:吃|服|用)(?:过)?药",
        "已核对既往用药",
        factual,
    )
    return bool(_UNSAFE_REPLY.search(factual) or _DIRECT_MEDICAL_INSTRUCTION.search(factual))


class ConversationError(RuntimeError):
    def __init__(self, message: str, code: str = "conversation_invalid"):
        super().__init__(message)
        self.code = code


def _normalise_text(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "")).strip("，。！？；,.!?; ")


def _clean_turns(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("turns")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 40:
        raise ConversationError("turns_invalid")
    turns = []
    for row in rows:
        if not isinstance(row, dict):
            raise ConversationError("turn_invalid")
        if set(row) - {"turn_id", "text", "version", "responding_to"}:
            raise ConversationError("turn_invalid")
        turn_id, text = row.get("turn_id"), row.get("text")
        if not isinstance(turn_id, str) or not _TURN_ID.fullmatch(turn_id):
            raise ConversationError("turn_id_invalid")
        if not isinstance(text, str) or not text.strip() or len(text) > 10000:
            raise ConversationError("turn_text_invalid")
        version = row.get("version", 1)
        if type(version) is not int or version < 1:
            raise ConversationError("turn_version_invalid")
        turn: dict[str, Any] = {"turn_id": turn_id, "text": text.strip(), "version": version}
        responding_to = row.get("responding_to")
        if responding_to is not None:
            if not isinstance(responding_to, dict) or set(responding_to) != {"turn_id", "text"}:
                raise ConversationError("responding_to_invalid")
            assistant_id, question = responding_to.get("turn_id"), responding_to.get("text")
            if (
                not isinstance(assistant_id, str)
                or not _TURN_ID.fullmatch(assistant_id)
                or assistant_id == turn_id
                or not isinstance(question, str)
                or not question.strip()
                or len(question) > 1000
            ):
                raise ConversationError("responding_to_invalid")
            turn["responding_to"] = {"turn_id": assistant_id, "text": question.strip()}
        turns.append(turn)
    if len({row["turn_id"] for row in turns}) != len(turns):
        raise ConversationError("turn_id_duplicate")
    turn_ids = {row["turn_id"] for row in turns}
    if any(row.get("responding_to", {}).get("turn_id") in turn_ids for row in turns):
        raise ConversationError("responding_to_invalid")
    return turns


def _clean_health_context(payload: dict[str, Any]) -> list[dict[str, str]]:
    rows = payload.get("health_context", [])
    if not isinstance(rows, list) or len(rows) > 30:
        raise ConversationError("health_context_invalid")
    result = []
    for row in rows:
        if not isinstance(row, dict):
            raise ConversationError("health_context_invalid")
        context_id, category, text = row.get("context_id"), row.get("category"), row.get("text")
        if not isinstance(context_id, str) or not _CONTEXT_ID.fullmatch(context_id):
            raise ConversationError("health_context_id_invalid")
        if category not in _CONTEXT_CATEGORIES or not isinstance(text, str) or not text.strip() or len(text) > 500:
            raise ConversationError("health_context_invalid")
        result.append({"context_id": context_id, "category": category, "text": text.strip(), "source": "user_confirmed"})
    if len({row["context_id"] for row in result}) != len(result):
        raise ConversationError("health_context_id_duplicate")
    return result


def _fallback_question(category: str, count: int) -> str:
    choices = QUESTION_TEMPLATES[category]
    return choices[1 if count else 0]


def _empty_state() -> dict[str, dict[str, Any]]:
    return {category: {"status": "missing", "summary": "", "evidence_turn_ids": [], "context_ids": []} for category in CATEGORIES}


def _easy_single_question(question: str) -> bool:
    """Reject explicit compound presence checks without inventing a replacement.

    Single-dimension choices such as left versus right remain available. This
    lexical guard does not claim to decide every question's semantic complexity.
    """
    presence = list(re.finditer(r"有没有|有无|是否(?:还)?有|同时(?:还)?有|还(?:会|有)", question))
    return len(presence) <= 1 and not (presence and "、" in question[presence[0].end():])


def _presence_items(question: str):
    """Read only an explicit presence list, preserving its shared qualifier.

    Ambiguous negation/conditions and other clauses stay blocked. This is a
    narrow grammar, not a general medical or Chinese sentence parser.
    """
    presence = list(re.finditer(r"有没有|有无|是否(?:还)?有|同时(?:还)?有|还(?:会|有)", question))
    if len(presence) != 1 or not re.fullmatch(r"[^。！？；.!?;]+[？?]", question):
        return None
    match = presence[0]
    prefix, body = question[:match.end()], question[match.end():-1]
    if (_DECLINED.search(question)
            or re.search(r"如果|假如|假设|要是|若|可能|不确定|不一定|并非|不是|但|却|虽", question)):
        return None
    suffix = "的情况" if body.endswith("的情况") else ""
    if suffix:
        body = body[:-len(suffix)]
    items = re.split(r"、|或者|或", body)
    # ponytail: conservative phrase grammar; unsupported wording stays blocked.
    if not items or any(
        not re.fullmatch(r"发(?:烧|热)|嗓子疼|咽痛|喘不上气|气短|胸口不舒服", item)
        for item in items
    ):
        return None
    return prefix, items, suffix, question[-1]


def _presence_item_key(item: str) -> str:
    # Only skip already asked wording; never rewrite a patient fact or output.
    return {"发热": "发烧", "咽痛": "嗓子疼", "气短": "喘不上气"}.get(item, item)


def _presence_question_key(question: str):
    parts = _presence_items(question)
    return (parts[0], _presence_item_key(parts[1][0]), parts[2]) if parts and len(parts[1]) == 1 else None


def _bound_presence_answer(row: dict[str, Any], asked_questions: list[str]) -> bool:
    """A plain yes/no answers its actual single question, not the session."""
    if not re.fullmatch(r"(?:没有|没|无|不是|有|是|有的)[。！! ]*", row["text"].strip()):
        return False
    previous = row.get("responding_to")
    return bool(isinstance(previous, dict) and any(
        previous.get("text", "").endswith(question)
        and (parts := _presence_items(question)) and len(parts[1]) == 1
        for question in asked_questions
    ))


def _followup_answered(question: str, turns: list[dict[str, Any]], controller: dict[str, Any]) -> bool:
    parts = _presence_items(question)
    if not parts or len(parts[1]) != 1:
        return False
    item = _presence_item_key(parts[1][0])
    names = {"发烧": r"发烧|发热", "嗓子疼": r"嗓子疼|咽痛", "喘不上气": r"喘不上气|气短",
             "胸口不舒服": r"胸口(?:这几天|今天|现在|最近|没有|没|也|一直|都|还){0,3}不舒服"}.get(item, re.escape(item))
    for row in turns:
        # Candidate coverage is metadata, never a new patient fact. Uncertain,
        # hypothetical, historic or superseded words cannot close a current gap.
        if (_EXPLICIT_UNKNOWN.search(row["text"])
                or re.search(r"不确定|不肯定|不敢肯定|不太清楚|拿不准|可能|也许|大概|好像|是否|算不算|怎么算|怎么才算", row["text"])
                or re.search(r"(?:还没|尚未|没|没有)(?:告诉|回答|说过|说清)|有没有|有无", row["text"])
                or list(_literal_corrections(row["turn_id"], turns))):
            continue
        if _bound_presence_answer(row, controller["asked_questions"]) and any(
            row["responding_to"]["text"].endswith(asked)
            and _presence_question_key(asked) == _presence_question_key(question)
            for asked in controller["asked_questions"]
        ):
            return True
        for clause in re.split(r"[，。！？；,.!?;\n]", row["text"]):
            if re.search(r"以前|之前|过去|曾经|小时候|那时候|那时|上次|去年|前年|上个月|前几年|[0-9一二三四五六七八九十两]+年前|"
                         r"如果|假如|假设|要是|会不会|是不是|家人|家属|孩子|儿子|女儿|父亲|母亲|爸爸|妈妈|妻子|丈夫|朋友|同事|邻居|别人|他|她", clause):
                continue
            if re.search(names, clause) and not re.search(r"[？?]", row["text"]):
                return True
    return False


def _pending_followups(controller: dict[str, Any], turns: list[dict[str, Any]]) -> list[str]:
    return [question for question in controller.get("followup_questions", [])
            if not _followup_answered(question, turns, controller)]


def _remember_followups(controller: dict[str, Any], question: str, category: str | None,
                        state: dict[str, dict[str, Any]]) -> None:
    questions = [item for item in controller.get("followup_questions", [])
                 if _question_in_scope(item, "associated_symptoms", state)]
    parts = _presence_items(question) if category == "associated_symptoms" else None
    if parts and len(parts[1]) > 1:
        prefix, items, suffix, ending = parts
        questions.extend(prefix + item + suffix + ending for item in items)
    unique = {}
    for item in questions:
        parts = _presence_items(item)
        if (parts and len(parts[1]) == 1 and _question_in_scope(item, "associated_symptoms", state)
                and _easy_single_question(item) and not _unsafe_reply(item) and not _NON_HEALTH_ACTION.search(item)):
            unique.setdefault(_presence_item_key(parts[1][0]), item)
    if unique or "followup_questions" in controller:
        controller["followup_questions"] = list(unique.values())[:MAX_QUESTIONS]


def _single_candidate_question(question: str, category: str | None, asked_questions: list[str]) -> str:
    if _unsafe_reply(question) or _NON_HEALTH_ACTION.search(question):
        return ""
    if _normalise_text(question) in {_normalise_text(item) for item in asked_questions}:
        return ""
    if category != "associated_symptoms":
        return question
    parts = _presence_items(question)
    if not parts:
        # Never rescue a compound candidate whose qualifiers cannot be kept.
        return "" if re.search(r"有没有|有无|是否(?:还)?有|、|或者", question) else question
    prefix, items, suffix, ending = parts
    asked_items = {
        _presence_item_key(item)
        for previous in asked_questions
        if (previous_parts := _presence_items(previous))
        for item in previous_parts[1]
    }
    item = next((item for item in items if _presence_item_key(item) not in asked_items), None)
    return prefix + item + suffix + ending if item else ""


def _question_in_scope(question: str, category: str | None, state: dict[str, dict[str, Any]]) -> bool:
    complaint = state["main_complaint"]
    if category == "associated_symptoms" and (parts := _presence_items(question)):
        if complaint["status"] == "known" and complaint["evidence_turn_ids"] and len(parts[1]) == 1:
            prefix = parts[0]
            stem = re.sub(r"(?:有没有|有无|是否(?:还)?有)$", "", prefix)
            anchored = re.fullmatch(
                r"(?:除了(?P<except>[^，。！？；,!?;、]{1,40})[，,](?:这几天|今天|最近|现在)?|"
                r"(?:这几天|今天|最近|现在)?(?P<during>[^，。！？；,!?;、]{1,40})(?:的时候|时)[，,]?)", stem,
            )
            if anchored:
                subject = anchored.group("except") or anchored.group("during")
                return bool(
                    _normalise_text(subject) in _normalise_text(complaint["summary"])
                    and not re.search(r"和|或|并|因为|导致|病|炎|癌|症|感染|药|检查", subject)
                    and _PATTERNS["main_complaint"].search(subject)
                )
        return False
    if _QUESTION_SCOPE.search(question):
        return True
    if category != "symptom_character" or complaint["status"] != "known" or not complaint["evidence_turn_ids"]:
        return False
    # A natural choice about an already sourced symptom need not contain a
    # legacy field word. Require the same literal complaint in a narrow choice
    # shape and reject recognised extra symptoms or diagnostic premises.
    choice = re.fullmatch(
        r"(?P<subject>[^，。！？；,!?;、]{1,40})(?:的时候|时)"
        r"(?P<first>(?:有|是)[^，。！？；,!?;、]{1,16})吗[，,]?\s*还是"
        r"(?P<second>[^，。！？；,!?;、]{1,16})[？?]",
        question,
    )
    if not choice:
        return False
    if _normalise_text(choice.group("subject")) not in _normalise_text(complaint["summary"]):
        return False
    if re.search(r"和|或|并|另外|同时|伴随|以及|还有|病|炎|癌|症|感染|药|检查", question):
        return False
    anchors = set(_PATTERNS["main_complaint"].findall(complaint["summary"]))
    question_symptoms = (_PATTERNS["main_complaint"].findall(question)
                         + _PATTERNS["associated_symptoms"].findall(question))
    return any(
        anchor in choice.group("subject") and anchor in choice.group("second")
        and all(symptom == anchor for symptom in question_symptoms)
        for anchor in anchors
    )


def _correction_context_span(text: str, match) -> tuple[int, int]:
    separators = "。！？；.!?;\n"
    start = max((text.rfind(char, 0, match.start()) for char in separators), default=-1) + 1
    ends = [index for char in separators if (index := text.find(char, match.end())) >= 0]
    return start, min(ends) + 1 if ends else len(text)


def _correction_context(text: str, match) -> str:
    start, end = _correction_context_span(text, match)
    return text[start:end]


def _direct_correction(text: str):
    match = _CORRECTION_REPLACEMENT.search(text)
    if match and re.search(
        r"如果|假如|假设|要是|会不会|[？?]|(?:没|没有|未)(?:说|更正|改|表示)|"
        r"(?:医生|药师|家属|别人|他|她).{0,6}(?:说|建议|嘱咐|提到)",
        _correction_context(text, match),
    ):
        return None
    return match


def _correction_span(text: str) -> tuple[int, int] | None:
    match = _direct_correction(text)
    return (match.start("new"), match.end("new")) if match else None


def _source_excerpt(text: str, category: str | None = None) -> str:
    """Keep complete source clauses that actually match the requested fact."""
    matcher = _EXPLICIT_UNKNOWN if category == "unknown" else _PATTERNS.get(category) if category else None
    if matcher is None:
        return text.strip()
    correction = _correction_span(text)
    correction_match = _CORRECTION_REPLACEMENT.search(text)
    correction_context = _correction_context_span(text, correction_match) if correction_match else None
    matches = list(matcher.finditer(text))
    if not matches:
        return ""
    separators = "，。！？；,.!?;\n"
    excerpts = []
    for match in matches:
        search_start, search_end = 0, len(text)
        if correction_context and correction_context[0] <= match.start() < correction_context[1]:
            if not correction or not correction[0] <= match.start() < correction[1]:
                continue
            search_start, search_end = correction
        previous = max((text.rfind(char, 0, match.start()) for char in separators), default=-1)
        following = [index for char in separators if (index := text.find(char, match.end())) >= 0]
        start = max(previous + 1, search_start)
        end = min(min(following) + 1 if following else len(text), search_end)
        clause = text[start:end].strip()
        if re.search(r"[？?]", clause):
            continue
        if category not in {"relevant_history", "prior_actions_results", "unknown"}:
            if re.search(r"如果|假如|假设|要是|会不会", clause):
                continue
        if category == "aggravating_relieving" and re.fullmatch(_TEMPORAL_CHANGE, match.group()) and re.search(
            r"建议|应该|应当|请|就医|医院|急诊|检查", clause,
        ):
            continue
        if category != "unknown" and _EXPLICIT_UNKNOWN.search(clause):
            continue
        if category == "onset_course" and not re.search(r"开始|持续|从.+(?:到|至)|以来", clause):
            # A time-of-day attached to normal function or a past action is
            # not an onset. Keep those clauses in their own categories.
            if not _PATTERNS["main_complaint"].search(clause) and (
                _PATTERNS["functional_impact"].search(clause)
                or _PATTERNS["prior_actions_results"].search(clause)
            ):
                continue
        if category == "main_complaint" and re.search(
            r"(?:没有|未出现|未见|否认|并无|没|不|无)[^，。！？；,!?;]{0,8}$",
            text[start:match.start()],
        ):
            continue
        excerpts.append(clause)
    excerpts = list(dict.fromkeys(excerpts))
    if len(excerpts) > 1:
        excerpts = [excerpt.rstrip(separators) for excerpt in excerpts[:-1]] + [excerpts[-1]]
    return "；".join(excerpts)


def _unperformed_action_excerpt(text: str) -> str:
    """A stated unperformed action is a fact; it is not a normal result."""
    values = []
    for match in re.finditer(r"[^，。！？；,.!?;\n]+[，。！？；,.!?;]?", text):
        clause = match.group().strip()
        if re.fullmatch(
            r"(?:我)?(?:还没有|尚未|并未|没有|还没|没|未)"
            r"(?:量|测|做|查|检查)(?:过)?[^，。！？；,.!?;\n]+[，。；,.;]?", clause,
        ) and not _EXPLICIT_UNKNOWN.search(clause):
            values.append(clause)
    return "；".join(dict.fromkeys(values))


def _literal_corrections(ref: str, turns: list[dict[str, Any]]):
    positions = {row["turn_id"]: index for index, row in enumerate(turns)}
    position = positions[ref]
    for index, row in enumerate(turns):
        if index < position:
            continue
        correction = _direct_correction(row["text"])
        if not correction:
            continue
        old = correction.group("old").strip()
        numeric = "0123456789零〇一二三四五六七八九十百千万两"
        left = r"(?<![0-9零〇一二三四五六七八九十百千万两])" if old and old[0] in numeric else ""
        right = r"(?![0-9零〇一二三四五六七八九十百千万两])" if old and old[-1] in numeric else ""
        pattern = re.compile(left + re.escape(old) + right)
        owners = [(source["turn_id"], len(list(pattern.finditer(source["text"])))) for source in turns[:index]]
        occurrences = sum(count for _, count in owners)
        if position == index or any(source == ref and count for source, count in owners):
            yield old, pattern, occurrences, position == index


def _current_source_excerpt(ref: str, category: str, turns: list[dict[str, Any]]) -> str:
    source = next(row["text"] for row in turns if row["turn_id"] == ref)
    excerpt = _source_excerpt(source, category)
    if category == "prior_actions_results":
        return "；".join(dict.fromkeys(value for value in
                          (excerpt, _unperformed_action_excerpt(source)) if value))
    if category in {"relevant_history", "prior_actions_results", "unknown", None}:
        return excerpt
    for old, pattern, occurrences, is_correction in _literal_corrections(ref, turns):
        if is_correction:
            if occurrences != 1 and not (category == "main_complaint" and _PATTERNS[category].search(excerpt)):
                return ""  # No unique earlier attribute to attach this replacement to.
            continue
        if not pattern.search(excerpt):
            continue  # Unchanged clauses in this source remain literal facts.
        if re.match(r"^(?:不|没|未|无|否认)", old) or old in {"是", "有"}:
            return ""  # Never make an affirmative fact by deleting a negation.
        # Keep only still-supported category fragments, never paste new words
        # into an old quote. Ambiguous attributes remain unassigned; raw history
        # retains every occurrence and other source clauses stay available.
        # Split the existing extract into clauses before removing an old
        # attribute. Otherwise a dangling suffix such as "了" can borrow a
        # match from a separate unchanged evening clause and become a fact.
        excerpt = "；".join(part.strip() for clause in re.split(r"[，。！？；,.!?;\n]", excerpt)
                           for part in pattern.split(clause)
                           if part.strip() and _PATTERNS[category].search(part))
    return excerpt


def _current_main_complaint_refs(refs: list[str], turns: list[dict[str, Any]]) -> list[str]:
    """Drop an earlier side-specific complaint explicitly replaced by a correction."""
    positions = {row["turn_id"]: index for index, row in enumerate(turns)}
    current = set(refs)
    for correction in turns:
        match = _direct_correction(correction["text"])
        if not match:
            continue
        old_side = "右" if "右" in match.group("old") else "左" if "左" in match.group("old") else None
        new_side = "右" if "右" in match.group("new") else "左" if "左" in match.group("new") else None
        if not old_side or not new_side or old_side == new_side:
            continue
        old_pattern = re.compile(old_side + r"(?:边|侧|腿|膝|脚)")
        new_pattern = re.compile(new_side + r"(?:边|侧|腿|膝|脚)")
        for ref in refs:
            if positions.get(ref, len(turns)) < positions[correction["turn_id"]]:
                source = next((row["text"] for row in turns if row["turn_id"] == ref), "")
                if old_pattern.search(source) and not new_pattern.search(source):
                    current.discard(ref)
    return [ref for ref in refs if ref in current]


def _source_summary(
        turn_ids: list[str], context_ids: list[str], turns: list[dict[str, Any]],
        health_context: list[dict[str, str]], limit: int = 500,
        category: str | None = None) -> str:
    """Use concise extractive evidence, never unsupported model prose."""
    turn_text = {row["turn_id"]: row["text"] for row in turns}
    context_text = {row["context_id"]: row["text"] for row in health_context}
    values = [_current_source_excerpt(ref, category, turns) for ref in turn_ids if ref in turn_text]
    values.extend(context_text[ref].strip() for ref in context_ids if ref in context_text)
    result = []
    for value in dict.fromkeys(values):
        if not value:
            continue
        candidate = "；".join(result + [value])
        if len(candidate) > limit and result:
            break
        result.append(value)
    return "；".join(result)


def _bound_answer_corrections(answers: list[dict[str, Any]], turns: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Resolve only an explicit, uniquely targeted literal answer correction.

    The complete declared subject comes from patient syntax, not a symptom
    inventory. Ambiguous or explicitly unknown targets retire the old answer
    without authorizing a new known fact. Full sentences preserve time and
    negation; the actual new responding_to stays separate from the old question.
    """
    positions = {row["turn_id"]: index for index, row in enumerate(turns)}
    resolved = {}
    for index, row in enumerate(turns):
        for match in re.finditer(r"[^。！？；.!?;\n]+[。！？；.!?;]?", row["text"]):
            sentence = match.group().strip()
            marker = re.search(r"说错了|改一下|更正|纠正", sentence)
            if not marker or re.search(
                r"如果|假如|假设|(?<!主)要是|会不会|[？?]|(?:没|没有|未)(?:说|更正|改|表示)|"
                r"(?:医生|药师|家属|别人|他|她).{0,6}(?:说|建议|嘱咐|提到)", sentence,
            ):
                continue
            targets = []
            for clause in re.split(r"[，,]", sentence[marker.end():].strip("，, ")):
                copula = re.fullmatch(r"(?P<subject>[^，。！？；,.!?;]{1,24})是[^，。！？；,.!?;]+[。.;]?", clause.strip())
                if not copula:
                    continue
                subject = copula.group("subject").strip()
                # These are grammatical qualifiers/pronouns, not a declared
                # attribute. Never discover a target from arbitrary n-grams.
                if subject in {"我", "它", "这", "那", "有", "无", "不", "没", "未", "没有",
                               "主要", "大多", "通常", "一般", "偶尔", "本来", "现在", "今天", "昨天", "前天", "以前"}:
                    continue
                owners = [answer for answer in answers
                          if positions.get(answer["turn_id"], len(turns)) < index
                          and subject in answer["quote"]]
                if owners:
                    targets.append(owners)
            if not targets:
                continue
            unique = len(targets) == 1 and len(targets[0]) == 1
            fact = sentence if unique and len(row["text"]) <= 120 and not (
                _EXPLICIT_UNKNOWN.search(sentence) or _META_FEEDBACK.search(sentence)
                or _DIAGNOSIS_REQUEST.search(sentence) or _unsafe_reply(sentence)
            ) else ""
            for owners in targets:
                for answer in owners:
                    resolved[answer["category"]] = {"source": row, "excerpt": fact}
    return resolved


def _ground_clinical_state(
        state: dict[str, dict[str, Any]], turns: list[dict[str, Any]],
        health_context: list[dict[str, str]], controller: dict[str, Any],
        model_intent: str) -> None:
    """Only raw words that actually answer a category may close that category."""
    turn_text = {row["turn_id"]: row["text"] for row in turns}
    latest = turns[-1]
    last_category = controller.get("last_question_category")
    negative_categories = {"aggravating_relieving", "associated_symptoms", "relevant_history", "prior_actions_results"}
    # A keyword-free answer remains evidence for the question it answered.
    # Bind the complete patient source, never the model's summary or question
    # text as a patient fact. Edits and corrections invalidate the old binding.
    sources = {row["turn_id"]: row for row in turns}
    origins = [item for item in controller.get("grounded_answers", [])
               if item["turn_id"] in sources
               and sources[item["turn_id"]].get("version", 1) == item["version"]
               and sources[item["turn_id"]]["text"] == item["quote"]
               and sources[item["turn_id"]].get("responding_to") == item["responding_to"]
               and item["question"] in controller["asked_questions"]
               and item["category"] in controller["asked_categories"]
               and controller["question_counts"].get(item["category"], 0) > 0
               and not list(_literal_corrections(item["turn_id"], turns))]
    corrections = _bound_answer_corrections(origins, turns)
    answers = []
    for answer in origins:
        correction = answer.get("correction")
        if correction:
            source = sources.get(correction["turn_id"])
            if not (source and source.get("version", 1) == correction["version"]
                    and source["text"] == correction["quote"]
                    and source.get("responding_to") == correction["responding_to"]):
                continue
        answers.append(answer)
    if answers:
        controller["grounded_answers"] = answers
    else:
        controller.pop("grounded_answers", None)

    for category in CATEGORIES:
        item = state[category]
        refs = [ref for ref in item["evidence_turn_ids"] if ref in turn_text]
        contexts = item["context_ids"] if category == "relevant_history" else []
        targeted = corrections.get(category)
        retired_refs = {answer["turn_id"] for answer in origins
                        if answer["category"] == category and (targeted or answer.get("correction"))}
        if item["status"] == "known" and targeted and targeted["excerpt"] and targeted["source"]["turn_id"] in refs:
            for answer in answers:
                if answer["category"] == category:
                    source = targeted["source"]
                    answer["correction"] = {
                        "turn_id": source["turn_id"], "version": source.get("version", 1),
                        "quote": source["text"], "responding_to": source.get("responding_to"),
                    }
                    controller["grounded_answers"] = answers

        short_answer = (
            category == last_category
            and latest.get("responding_to") is not None
            and len(latest["text"]) <= 120
            and not _META_FEEDBACK.search(latest["text"])
            and not _DIAGNOSIS_REQUEST.search(latest["text"])
            and not _DECLINED.search(latest["text"])
            and not re.search(r"[？?]", latest["text"])
            and model_intent != "correction"
            and (model_intent != "explicit_finish" or _bound_presence_answer(latest, controller["asked_questions"]))
            and not _CORRECTION.search(latest["text"])
            and (not _EXPLICIT_FINISH.fullmatch(latest["text"].strip())
                 or _bound_presence_answer(latest, controller["asked_questions"]))
            and not _source_excerpt(latest["text"], category)
        )
        if short_answer and item["status"] == "known" and latest["turn_id"] in refs:
            question = controller["asked_questions"][-1] if controller["asked_questions"] else ""
            if (question and latest["responding_to"]["text"].endswith(question)
                    and category in controller["asked_categories"]
                    and controller["question_counts"].get(category, 0) > 0):
                binding = {
                    "category": category, "turn_id": latest["turn_id"],
                    "version": latest.get("version", 1), "quote": latest["text"],
                    "responding_to": dict(latest["responding_to"]), "question": question,
                }
                answers = [answer for answer in answers
                           if (answer["category"], answer["question"]) != (category, question)] + [binding]
                controller["grounded_answers"] = answers
            existing_refs = [
                ref for ref in refs
                if ref != latest["turn_id"]
                and not _META_FEEDBACK.search(turn_text[ref])
                and _current_source_excerpt(ref, category, turns)
            ]
            literal_answers = [answer for answer in answers
                               if answer["category"] == category and not answer.get("correction")
                               and answer["turn_id"] in refs]
            existing_refs = list(dict.fromkeys(existing_refs + [answer["turn_id"] for answer in literal_answers]))
            summary = _source_summary(existing_refs, contexts, turns, health_context, category=category)
            state[category] = {
                "status": "known",
                "summary": "；".join(dict.fromkeys(part for part in
                           [summary] + [answer["quote"] for answer in literal_answers] + [latest["text"]] if part)),
                "evidence_turn_ids": list(dict.fromkeys(existing_refs + [latest["turn_id"]])),
                "context_ids": contexts,
            }
            continue

        if item["status"] == "known":
            # A source-checked model may identify a complaint outside the
            # legacy keyword inventory. Preserve only its complete literal
            # source, never an inferred medical meaning or an unsourced recap.
            literal_complaint_refs = []
            if category == "main_complaint" and model_intent in {"health_fact", "answer", "correction"}:
                literal_complaint_refs = [
                    ref for ref in refs
                    if ref not in retired_refs
                    and item["summary"] == turn_text[ref].strip()
                    and not _source_excerpt(turn_text[ref], category)
                    and not list(_literal_corrections(ref, turns))
                    and not _META_FEEDBACK.search(turn_text[ref])
                    and not _DIAGNOSIS_REQUEST.search(turn_text[ref])
                    and not _DECLINED.search(turn_text[ref])
                    and not _EXPLICIT_FINISH.fullmatch(turn_text[ref].strip())
                    and not re.search(r"[？?]", turn_text[ref])
                ]
            literal_answers = []
            for answer in answers:
                if answer["category"] != category:
                    continue
                correction = answer.get("correction")
                if correction:
                    if (targeted and targeted["excerpt"]
                            and targeted["source"]["turn_id"] == correction["turn_id"]
                            and correction["turn_id"] in refs):
                        literal_answers.append((correction["turn_id"], targeted["excerpt"]))
                elif not targeted and answer["turn_id"] in refs:
                    literal_answers.append((answer["turn_id"], answer["quote"]))
            literal_answer_refs = [ref for ref, _text in literal_answers]
            grounded_refs = [
                ref for ref in refs
                if ref not in retired_refs and not _META_FEEDBACK.search(turn_text[ref])
                and _current_source_excerpt(ref, category, turns)
            ] + literal_complaint_refs + literal_answer_refs
            if category == "main_complaint":
                grounded_refs = _current_main_complaint_refs(grounded_refs, turns)
            if (
                category == last_category
                and category in negative_categories
                and latest["turn_id"] in refs
                and not _META_FEEDBACK.search(latest["text"])
                and _NEGATIVE_ANSWER.search(latest["text"].strip())
            ):
                grounded_refs.append(latest["turn_id"])
            grounded_refs = list(dict.fromkeys(grounded_refs))
            if not grounded_refs and not contexts:
                state[category] = {"status": "missing", "summary": "", "evidence_turn_ids": [], "context_ids": []}
                continue
            summary = _source_summary([ref for ref in grounded_refs if ref not in literal_answer_refs],
                                      contexts, turns, health_context, category=category)
            if not summary and literal_complaint_refs:
                summary = turn_text[literal_complaint_refs[0]].strip()
            summary = "；".join(dict.fromkeys(part for part in
                                [summary] + [text for _ref, text in literal_answers] if part))
            state[category] = {
                "status": "known",
                "summary": summary,
                "evidence_turn_ids": grounded_refs,
                "context_ids": contexts,
            }
            continue

        if item["status"] in {"unknown", "declined"}:
            directly_declined = (
                category == last_category
                and latest["turn_id"] in refs
                and bool(_DECLINED.search(latest["text"]))
                and not _source_excerpt(latest["text"], category)
            )
            if directly_declined:
                state[category] = {
                    "status": "declined", "summary": "",
                    "evidence_turn_ids": [latest["turn_id"]], "context_ids": [],
                }
            else:
                state[category] = {"status": "missing", "summary": "", "evidence_turn_ids": [], "context_ids": []}
            continue

        if item["status"] == "not_applicable" and category in CLOSURE_CATEGORIES:
            state[category] = {"status": "missing", "summary": "", "evidence_turn_ids": [], "context_ids": []}


def _merge_obvious_facts(state: dict[str, dict[str, Any]], turns: list[dict[str, Any]], *, infer_associated: bool = False) -> None:
    """Prevent obvious repetition; never create a medical interpretation."""
    for category in _PATTERNS:
        if category == "associated_symptoms" and not infer_associated:
            continue  # A primary symptom does not establish a second symptom.
        if state[category]["status"] != "missing":
            continue
        refs = [
            row["turn_id"] for row in turns
            if not _META_FEEDBACK.search(row["text"]) and _current_source_excerpt(row["turn_id"], category, turns)
        ]
        if category == "main_complaint":
            refs = _current_main_complaint_refs(refs, turns)
        if refs:
            excerpts = [
                _current_source_excerpt(ref, category, turns)
                for ref in refs[-2:]
            ]
            state[category] = {"status": "known", "summary": "；".join(excerpts)[:500], "evidence_turn_ids": refs, "context_ids": []}


def _mock_assessment(turns: list[dict[str, Any]], controller: dict[str, Any], *, infer_associated: bool = True) -> dict[str, Any]:
    latest = turns[-1]
    state = _empty_state()
    _merge_obvious_facts(state, turns, infer_associated=infer_associated)
    text = latest["text"]
    intent = "meta_feedback" if _META_FEEDBACK.search(text) else "patient_question" if _DIAGNOSIS_REQUEST.search(text) or "?" in text or "？" in text else "correction" if _CORRECTION.search(text) else "explicit_finish" if _EXPLICIT_FINISH.fullmatch(text.strip()) else "answer" if len(turns) > 1 else "health_fact"
    earlier = {_normalise_text(row["text"]) for row in turns[:-1]}
    adds_fact = bool(_normalise_text(text)) and _normalise_text(text) not in earlier and intent not in {"meta_feedback", "patient_question", "explicit_finish"} and not _DECLINED.search(text)
    counts = controller.get("question_counts", {})
    next_category = next((category for category in CATEGORIES if state[category]["status"] == "missing" and counts.get(category, 0) < 2), None)
    main_resolved = state["main_complaint"]["status"] == "known"
    ask = bool(next_category and (next_category == "main_complaint" or main_resolved))
    if intent == "meta_feedback":
        ask = False
    reply_text = "您说得对，我刚才没有顺着您的意思回应。" if intent == "meta_feedback" else "好的，我按您刚才更正的原话重新记。" if intent == "correction" else "我不能仅凭聊天判断病因，但可以把您说的情况如实整理，供接诊医生了解。" if intent == "patient_question" else f"您刚才说“{re.sub(r'[。！？!?]+$', '', text.strip())[:48]}”，我记下了。"
    return {
        "user_intent": intent, "latest_turn_adds_fact": adds_fact,
        "reply_text": reply_text,
        "suggested_action": "ask" if ask else "finish", "question_category": next_category if ask else None,
        "question_importance": "essential" if next_category in ESSENTIAL_CATEGORIES else "useful" if ask else None,
        "candidate_question": _fallback_question(next_category, counts.get(next_category, 0)) if ask else "",
        "clinical_state": state, "relevant_context_ids": [], "unknowns": [], "contradictions": [],
    }


def _clean_notes(value: Any, known_turns: set[str], known_context: set[str], *, require_evidence: bool = True) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > 8:
        raise ConversationError("model_schema_invalid", "model_schema_invalid")
    notes = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {"text", "evidence_turn_ids", "context_ids"}:
            raise ConversationError("model_schema_invalid", "model_schema_invalid")
        text, turns, contexts = item["text"], item["evidence_turn_ids"], item["context_ids"]
        if not isinstance(text, str) or not text.strip() or len(text) > 300 or not isinstance(turns, list) or not isinstance(contexts, list):
            raise ConversationError("model_schema_invalid", "model_schema_invalid")
        if any(ref not in known_turns for ref in turns) or any(ref not in known_context for ref in contexts) or require_evidence and not (turns or contexts):
            raise ConversationError("model_evidence_invalid", "model_evidence_invalid")
        notes.append({"text": text.strip(), "evidence_turn_ids": list(dict.fromkeys(turns)), "context_ids": list(dict.fromkeys(contexts))})
    return notes


def _validate_assessment(value: Any, turns: list[dict[str, Any]], health_context: list[dict[str, str]]) -> dict[str, Any]:
    required = {"user_intent", "latest_turn_adds_fact", "suggested_action", "question_category", "question_importance", "candidate_question", "clinical_state", "relevant_context_ids", "unknowns", "contradictions"}
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - {"reply_text", "risk_candidates"} or not isinstance(value.get("clinical_state"), dict) or set(value["clinical_state"]) != set(CATEGORIES):
        raise ConversationError("model_schema_invalid", "model_schema_invalid")
    known_turns = {row["turn_id"] for row in turns}
    known_context = {row["context_id"] for row in health_context}
    cleaned_state = {}
    for category in CATEGORIES:
        item = value["clinical_state"].get(category)
        if not isinstance(item, dict) or set(item) != {"status", "summary", "evidence_turn_ids", "context_ids"} or item.get("status") not in {"known", "unknown", "declined", "not_applicable", "missing"}:
            raise ConversationError("model_schema_invalid", "model_schema_invalid")
        summary, refs, context_refs = item.get("summary"), item.get("evidence_turn_ids"), item.get("context_ids")
        if not isinstance(summary, str) or len(summary) > 500 or not isinstance(refs, list) or not isinstance(context_refs, list):
            raise ConversationError("model_schema_invalid", "model_schema_invalid")
        if any(ref not in known_turns for ref in refs) or any(ref not in known_context for ref in context_refs):
            raise ConversationError("model_evidence_invalid", "model_evidence_invalid")
        sourced = bool(refs or context_refs)
        if item["status"] in {"known", "unknown", "declined"} and not sourced:
            raise ConversationError("model_evidence_invalid", "model_evidence_invalid")
        if item["status"] in {"missing", "not_applicable"} and sourced:
            raise ConversationError("model_evidence_invalid", "model_evidence_invalid")
        if item["status"] == "known" and not summary.strip():
            raise ConversationError("model_evidence_invalid", "model_evidence_invalid")
        cleaned_state[category] = {
            "status": item["status"],
            "summary": summary.strip() if item["status"] == "known" else "",
            "evidence_turn_ids": list(dict.fromkeys(refs)),
            "context_ids": list(dict.fromkeys(context_refs)),
        }

    intent = value.get("user_intent")
    if intent not in {"health_fact", "answer", "correction", "declined", "meta_feedback", "patient_question", "explicit_finish", "unclear"} or not isinstance(value.get("latest_turn_adds_fact"), bool):
        raise ConversationError("model_schema_invalid", "model_schema_invalid")
    reply_text = value.get("reply_text", "")
    if not isinstance(reply_text, str) or len(reply_text) > 500 or re.search(r"[？?]", reply_text):
        raise ConversationError("model_schema_invalid", "model_schema_invalid")
    suggested, category, importance, question = value.get("suggested_action"), value.get("question_category"), value.get("question_importance"), value.get("candidate_question")
    if suggested not in {"ask", "finish"} or not isinstance(question, str) or len(question) > 160:
        raise ConversationError("model_schema_invalid", "model_schema_invalid")
    if suggested == "ask":
        if category not in CATEGORIES or importance not in {"essential", "useful", "optional"} or not question.strip() or len(re.findall(r"[？?]", question)) != 1:
            raise ConversationError("model_schema_invalid", "model_schema_invalid")
    elif category is not None or importance is not None or question:
        raise ConversationError("model_schema_invalid", "model_schema_invalid")
    relevant = value.get("relevant_context_ids")
    if not isinstance(relevant, list) or any(ref not in known_context for ref in relevant):
        raise ConversationError("model_evidence_invalid", "model_evidence_invalid")
    if _unsafe_reply(reply_text) or _unsafe_reply(question) or _NON_HEALTH_ACTION.search(reply_text) or _NON_HEALTH_ACTION.search(question):
        raise ConversationError("model_reply_unsafe", "model_reply_unsafe")
    return {
        "user_intent": intent, "latest_turn_adds_fact": value["latest_turn_adds_fact"],
        "reply_text": reply_text.strip(),
        "suggested_action": suggested, "question_category": category, "question_importance": importance,
        "candidate_question": question.strip(), "clinical_state": cleaned_state,
        "relevant_context_ids": list(dict.fromkeys(relevant)),
        "unknowns": _clean_notes(value.get("unknowns"), known_turns, known_context, require_evidence=False),
        "contradictions": _clean_notes(value.get("contradictions"), known_turns, known_context),
        "risk_candidates": value.get("risk_candidates", []),
    }


def _controller_state(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    raw_counts = source.get("question_counts") if isinstance(source.get("question_counts"), dict) else {}
    counts = {category: min(max(int(raw_counts.get(category, 0) or 0), 0), MAX_QUESTIONS) for category in CATEGORIES}
    legacy = {"main_discomfort": "main_complaint", "onset_change": "onset_course", "life_impact": "functional_impact", "other_facts": "associated_symptoms"}
    for old, new in legacy.items():
        counts[new] = max(counts[new], min(max(int(raw_counts.get(old, 0) or 0), 0), 2))
    asked = [legacy.get(item, item) for item in source.get("asked_categories", []) if legacy.get(item, item) in CATEGORIES]
    closed = [legacy.get(item, item) for item in source.get("closed_categories", []) if legacy.get(item, item) in CATEGORIES]
    asked_questions = [str(item).strip()[:160] for item in source.get("asked_questions", []) if isinstance(item, str) and item.strip()][-12:]
    last = legacy.get(source.get("last_question_category"), source.get("last_question_category"))
    result = {
        "asked_categories": list(dict.fromkeys(asked)), "closed_categories": list(dict.fromkeys(closed)),
        "question_counts": counts, "asked_questions": asked_questions,
        "question_count": min(max(int(source.get("question_count", 0) or 0), 0), MAX_QUESTIONS),
        "no_new_fact_count": min(max(int(source.get("no_new_fact_count", 0) or 0), 0), 2),
        "last_question_category": last if last in CATEGORIES else None,
        "linked_context_ids": [item for item in source.get("linked_context_ids", []) if isinstance(item, str) and _CONTEXT_ID.fullmatch(item)][:30],
    }
    if "followup_questions" in source:
        followups = source["followup_questions"]
        if not isinstance(followups, list) or len(followups) > MAX_QUESTIONS or any(
            not isinstance(question, str) or len(question) > 160
            or not (parts := _presence_items(question)) or len(parts[1]) != 1
            or _unsafe_reply(question) or _NON_HEALTH_ACTION.search(question)
            for question in followups
        ):
            raise ConversationError("controller_followup_invalid")
        result["followup_questions"] = list(dict.fromkeys(followups))
    if "grounded_answers" in source:
        answers = source["grounded_answers"]
        fields = {"category", "turn_id", "version", "quote", "responding_to", "question"}
        if not isinstance(answers, list) or len(answers) > MAX_QUESTIONS:
            raise ConversationError("controller_answer_invalid")
        cleaned = []
        for answer in answers:
            if (not isinstance(answer, dict) or not fields <= set(answer) or set(answer) - fields - {"correction"}
                    or answer.get("category") not in CATEGORIES
                    or not isinstance(answer.get("turn_id"), str) or not _TURN_ID.fullmatch(answer["turn_id"])
                    or type(answer.get("version")) is not int or answer["version"] < 1
                    or not isinstance(answer.get("quote"), str) or not answer["quote"].strip() or len(answer["quote"]) > 120
                    or not isinstance(answer.get("question"), str) or not answer["question"].strip() or len(answer["question"]) > 160
                    or not isinstance(answer.get("responding_to"), dict) or set(answer["responding_to"]) != {"turn_id", "text"}):
                raise ConversationError("controller_answer_invalid")
            question_source = answer["responding_to"]
            if (not isinstance(question_source["turn_id"], str) or not _TURN_ID.fullmatch(question_source["turn_id"])
                    or question_source["turn_id"] == answer["turn_id"]
                    or not isinstance(question_source["text"], str) or len(question_source["text"]) > 1000
                    or not question_source["text"].endswith(answer["question"])
                    or _META_FEEDBACK.search(answer["quote"]) or _DIAGNOSIS_REQUEST.search(answer["quote"])
                    or _DECLINED.search(answer["quote"]) or re.search(r"[？?]", answer["quote"])
                    or (_EXPLICIT_FINISH.fullmatch(answer["quote"].strip())
                        and not _bound_presence_answer({"text": answer["quote"], "responding_to": question_source}, [answer["question"]]))):
                raise ConversationError("controller_answer_invalid")
            cleaned_answer = {**answer, "responding_to": dict(question_source)}
            if "correction" in answer:
                correction = answer["correction"]
                if (not isinstance(correction, dict) or set(correction) != {"turn_id", "version", "quote", "responding_to"}
                        or not isinstance(correction.get("turn_id"), str) or not _TURN_ID.fullmatch(correction["turn_id"])
                        or correction["turn_id"] == answer["turn_id"]
                        or type(correction.get("version")) is not int or correction["version"] < 1
                        or not isinstance(correction.get("quote"), str) or not correction["quote"].strip() or len(correction["quote"]) > 120):
                    raise ConversationError("controller_answer_invalid")
                actual_question = correction["responding_to"]
                if actual_question is not None and (
                    not isinstance(actual_question, dict) or set(actual_question) != {"turn_id", "text"}
                    or not isinstance(actual_question.get("turn_id"), str) or not _TURN_ID.fullmatch(actual_question["turn_id"])
                    or actual_question["turn_id"] == correction["turn_id"]
                    or not isinstance(actual_question.get("text"), str) or not actual_question["text"].strip()
                    or len(actual_question["text"]) > 1000
                ):
                    raise ConversationError("controller_answer_invalid")
                cleaned_answer["correction"] = {**correction, "responding_to": dict(actual_question) if actual_question else None}
            cleaned.append(cleaned_answer)
        if len({(answer["category"], answer["question"]) for answer in cleaned}) != len(cleaned):
            raise ConversationError("controller_answer_invalid")
        if cleaned:
            result["grounded_answers"] = cleaned
    return result


def _response_text(reply: str, question: str) -> str:
    return " ".join(part for part in (reply.strip(), question.strip()) if part)


def _ground_notes(
        notes: list[dict[str, Any]], turns: list[dict[str, Any]],
        health_context: list[dict[str, str]], *, unknowns: bool = False) -> list[dict[str, Any]]:
    """Keep only explicit unknowns; ordinary missing fields are represented by state."""
    grounded = []
    turn_text = {row["turn_id"]: row["text"] for row in turns}
    context_text = {row["context_id"]: row["text"] for row in health_context}
    for item in notes:
        if unknowns:
            source_turns = [ref for ref in item["evidence_turn_ids"] if ref in turn_text and _EXPLICIT_UNKNOWN.search(turn_text[ref])]
            source_contexts = [ref for ref in item["context_ids"] if ref in context_text and _EXPLICIT_UNKNOWN.search(context_text[ref])]
            if not source_turns and not source_contexts:
                continue
            text = _source_summary(source_turns, source_contexts, turns, health_context, 120, "unknown")
            item = {**item, "evidence_turn_ids": source_turns, "context_ids": source_contexts}
        else:
            corrected_turn_ids = {row["turn_id"] for row in turns if _CORRECTION_REPLACEMENT.search(row["text"])}
            if corrected_turn_ids.intersection(item["evidence_turn_ids"]):
                continue
            source_turns = [
                ref for ref in item["evidence_turn_ids"]
                if ref in turn_text
                and not _META_FEEDBACK.search(turn_text[ref])
                and not _DIAGNOSIS_REQUEST.search(turn_text[ref])
                and not _DECLINED.search(turn_text[ref])
                and not _EXPLICIT_FINISH.fullmatch(turn_text[ref].strip())
                and not re.search(r"[？?]", turn_text[ref])
                and any(pattern.search(turn_text[ref]) for pattern in _PATTERNS.values())
            ]
            source_contexts = [ref for ref in item["context_ids"] if ref in context_text]
            if len(set(source_turns + source_contexts)) < 2:
                continue
            item = {**item, "evidence_turn_ids": source_turns, "context_ids": source_contexts}
            text = _source_summary(source_turns, source_contexts, turns, health_context, 240)
        if text:
            grounded.append({**item, "text": text})
    return list({(item["text"], tuple(item["evidence_turn_ids"]), tuple(item["context_ids"])): item for item in grounded}.values())


def _fallback_reply(latest: str, *, meta_feedback: bool, diagnosis_request: bool, correction: bool) -> str:
    if diagnosis_request:
        return "我不能仅凭聊天判断病因，但可以把您说的情况如实整理，供接诊医生了解。"
    if meta_feedback:
        return "您说得对，我刚才没有顺着您的意思回应。"
    if correction:
        return "好的，我按您刚才更正的原话重新记。"
    quote = re.sub(r"[。！？!?]+$", "", latest.strip())[:52]
    return f"您刚才说“{quote}”，我听清了。"


def _result(*, started: float, provider_name: str, model_id: str, action: str, assistant_text: str,
            question_category: str | None, stop_reason: str | None, controller: dict[str, Any],
            clinical_state: dict[str, dict[str, Any]], safety: dict[str, Any], model_intent: str | None = None,
            relevant_context_ids: list[str] | None = None, unknowns: list[dict[str, Any]] | None = None,
            contradictions: list[dict[str, Any]] | None = None,
            risk_assessment: dict[str, Any] | None = None,
            pending_questions: list[str] | None = None) -> dict[str, Any]:
    completeness = {
        "complete": not pending_questions and all(clinical_state[item]["status"] in {"known", "declined"} for item in CLOSURE_CATEGORIES),
        "clinical_state": clinical_state,
        "evidence_turn_ids": list(dict.fromkeys(ref for item in clinical_state.values() for ref in item["evidence_turn_ids"])),
        "relevant_context_ids": relevant_context_ids or [], "unknowns": unknowns or [], "contradictions": contradictions or [],
    }
    if "followup_questions" in controller:
        completeness["pending_questions"] = pending_questions or []
    return {
        "ok": True, "trace_id": "ctr_" + uuid.uuid4().hex, "provider": provider_name,
        "model_id": model_id, "prompt_version": PROMPT_VERSION, "prompt_sha256": PROMPT_SHA256,
        "latency_ms": round((time.perf_counter() - started) * 1000, 2), "action": action,
        "assistant_text": assistant_text, "question_category": question_category, "stop_reason": stop_reason,
        "controller": controller, "completeness": completeness, "model_intent": model_intent,
        "risk_level": risk_assessment["level"] if risk_assessment and risk_assessment["level"] in {"soon_evaluation", "urgent"} else "urgent" if safety.get("danger_detected") else "needs_review" if safety.get("clinical_review_required") else "routine",
        "local_safety": safety,
        "risk_contract_version": RISK_CONTRACT_VERSION,
        "risk_assessment": risk_assessment if risk_assessment is not None else evaluate_reviewed_risk([], []),
    }


def conversation_turn(payload: dict[str, Any], provider=None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ConversationError("payload_invalid")
    turns = _clean_turns(payload)
    health_context = _clean_health_context(payload)
    controller = _controller_state(payload.get("controller"))
    latest = turns[-1]["text"]
    safety = scan_danger(latest)
    risk_registry = load_reviewed_risk_rules()
    started = time.perf_counter()

    if safety["danger_detected"]:
        assessment = _mock_assessment(turns, controller, infer_associated=False)
        return _result(started=started, provider_name="LocalDangerRule", model_id="local-danger-rule-v1", action="urgent", assistant_text=DANGER_REMINDER, question_category=None, stop_reason="urgent_rule", controller={**controller, "last_question_category": None}, clinical_state=assessment["clinical_state"], safety=safety, model_intent=assessment["user_intent"], pending_questions=_pending_followups(controller, turns))

    selected_provider = provider or provider_from()
    if isinstance(selected_provider, MockProvider):
        draft = _mock_assessment(turns, controller)
        model_id = "mock-clinical-intake-v1"
    else:
        draft = selected_provider.complete_json(SYSTEM_PROMPT, {"turns": turns, "health_context": health_context, "controller": controller,
            "approved_risk_rules": [{key: rule[key] for key in ("rule_id", "version", "description")} for rule in risk_registry["rules"]]})
        model_id = getattr(getattr(selected_provider, "c", None), "model", None) or "unknown"
    provider_name = type(selected_provider).__name__
    try:
        assessment = _validate_assessment(draft, turns, health_context)
    except ConversationError as error:
        if error.code != "model_reply_unsafe":
            raise
        fallback = _mock_assessment(turns, controller, infer_associated=isinstance(selected_provider, MockProvider))
        return _result(started=started, provider_name=provider_name, model_id=model_id, action="reply", assistant_text=MODEL_OUTPUT_BLOCKED_TEXT, question_category=None, stop_reason="model_output_blocked", controller=controller, clinical_state=fallback["clinical_state"], safety=safety, pending_questions=_pending_followups(controller, turns))

    clinical_state = assessment["clinical_state"]
    newly_answered_followup = _bound_presence_answer(turns[-1], controller["asked_questions"]) and any(
        turns[-1]["responding_to"]["text"].endswith(asked)
        and _presence_question_key(asked) == _presence_question_key(question)
        for question in _pending_followups(controller, turns[:-1])
        for asked in controller["asked_questions"]
    )
    _ground_clinical_state(clinical_state, turns, health_context, controller, assessment["user_intent"])
    _merge_obvious_facts(clinical_state, turns)
    previous_followups = set(_pending_followups(controller, turns))
    _remember_followups(controller, assessment["candidate_question"], assessment["question_category"], clinical_state)
    pending_questions = _pending_followups(controller, turns)
    risk_assessment = evaluate_reviewed_risk(assessment["risk_candidates"], turns, risk_registry)
    if risk_assessment["level"] in {"soon_evaluation", "urgent"}:
        return _result(started=started, provider_name=provider_name, model_id=model_id,
            action=risk_assessment["level"], assistant_text=risk_assessment["notice"],
            question_category=None, stop_reason="reviewed_risk_rule", controller={**controller, "last_question_category": None},
            clinical_state=clinical_state, safety=safety, model_intent=assessment["user_intent"], risk_assessment=risk_assessment,
            pending_questions=pending_questions)
    latest_normalised = _normalise_text(latest)
    earlier = {_normalise_text(row["text"]) for row in turns[:-1]}
    # Not remembering one detail must not erase separately stated symptoms.
    declined = bool(_DECLINED.search(latest)) and not any(
        _source_excerpt(latest, category) for category in CATEGORIES
    )
    explicit_finish = not _bound_presence_answer(turns[-1], controller["asked_questions"]) and (
        bool(_EXPLICIT_FINISH.fullmatch(latest.strip())) or assessment["user_intent"] == "explicit_finish")
    meta_feedback = bool(_META_FEEDBACK.search(latest)) or assessment["user_intent"] == "meta_feedback"
    diagnosis_request = bool(_DIAGNOSIS_REQUEST.search(latest))
    patient_question = assessment["user_intent"] == "patient_question" or diagnosis_request
    correction = bool(_CORRECTION.search(latest)) or assessment["user_intent"] == "correction"
    conversational_question = meta_feedback or patient_question
    adds_fact = (assessment["latest_turn_adds_fact"] and bool(latest_normalised) and latest_normalised not in earlier or newly_answered_followup) and not declined and not explicit_finish and not conversational_question
    controller["no_new_fact_count"] = 0 if conversational_question or adds_fact else min(2, controller["no_new_fact_count"] + 1)
    last_category = controller["last_question_category"]
    if declined and last_category:
        if last_category not in controller["closed_categories"]:
            controller["closed_categories"].append(last_category)
        clinical_state[last_category] = {"status": "declined", "summary": "", "evidence_turn_ids": [turns[-1]["turn_id"]], "context_ids": []}

    action, assistant_text, next_category, stop_reason = "finish", FINISH_TEXT, None, "enough_information"
    reply = assessment["reply_text"] or _fallback_reply(
        latest, meta_feedback=meta_feedback,
        diagnosis_request=diagnosis_request, correction=correction,
    )
    candidate_question = _single_candidate_question(
        assessment["candidate_question"], assessment["question_category"], controller["asked_questions"] + [
            question for question in controller.get("followup_questions", []) if question not in pending_questions],
    )
    # A coarse category can already have one fact while an original candidate
    # still lacks an answer. Only previously saved items may exceed its old
    # per-category cap; the overall fatigue/end/safety boundaries still apply.
    candidate_followup = next((question for question in pending_questions
                               if _presence_question_key(question) == _presence_question_key(candidate_question)), None)
    followup_eligible = candidate_followup is not None and (
        controller["question_counts"]["associated_symptoms"] < 2 or candidate_followup in previous_followups)
    if explicit_finish:
        # Closing a session needs no model-authored recap, which can invent
        # facts even when every structured fact has a valid source.
        assistant_text = "好的，先到这里。您说过的原话会保留，之后可以回来继续。"
        stop_reason = "user_finished"
    elif meta_feedback:
        action, assistant_text, stop_reason = "reply", reply, "awaiting_user"
    elif patient_question:
        # A user's question must receive an answer even at the follow-up limit;
        # the model may add one useful question only when it explicitly chose it.
        proposed = assessment["question_category"] if assessment["suggested_action"] == "ask" else None
        context_to_verify = [ref for ref in assessment["relevant_context_ids"] if ref not in controller["linked_context_ids"]]
        eligible = [category for category in CATEGORIES if ((clinical_state[category]["status"] == "missing" or category == "relevant_history" and context_to_verify) and controller["question_counts"].get(category, 0) < 2 or category == "associated_symptoms" and followup_eligible) and category not in controller["closed_categories"]]
        candidate = candidate_question
        normalised_questions = {_normalise_text(item) for item in controller["asked_questions"]}
        fatigue = controller["question_count"] >= TYPICAL_QUESTION_LIMIT
        if proposed in eligible and controller["question_count"] < MAX_QUESTIONS and not (fatigue and assessment["question_importance"] != "essential") and candidate and _question_in_scope(candidate, proposed, clinical_state) and _easy_single_question(candidate) and _normalise_text(candidate) not in normalised_questions:
            next_category = proposed
            assistant_text = _response_text(reply, candidate)
            if _unsafe_reply(assistant_text) or _NON_HEALTH_ACTION.search(assistant_text):
                action, assistant_text, stop_reason = "reply", MODEL_OUTPUT_BLOCKED_TEXT, "model_output_blocked"
            else:
                action, stop_reason = "ask", None
                controller["asked_categories"] = list(dict.fromkeys(controller["asked_categories"] + [next_category]))
                controller["question_counts"][next_category] += 1
                controller["asked_questions"] = (controller["asked_questions"] + [candidate])[-12:]
                controller["question_count"] += 1
                controller["last_question_category"] = next_category
        else:
            action, assistant_text, stop_reason = "reply", reply, "awaiting_user"
    elif controller["question_count"] >= MAX_QUESTIONS:
        assistant_text = _response_text(reply, FINISH_TEXT)
        stop_reason = "question_limit"
    elif controller["no_new_fact_count"] >= 2:
        assistant_text = _response_text(reply, FINISH_TEXT)
        stop_reason = "two_no_new_fact_turns"
    else:
        context_to_verify = [ref for ref in assessment["relevant_context_ids"] if ref not in controller["linked_context_ids"]]
        eligible = [category for category in CATEGORIES if ((clinical_state[category]["status"] == "missing" or category == "relevant_history" and context_to_verify) and controller["question_counts"].get(category, 0) < 2 or category == "associated_symptoms" and followup_eligible) and category not in controller["closed_categories"]]
        proposed = assessment["question_category"] if assessment["suggested_action"] == "ask" else None
        enough = all(clinical_state[item]["status"] in {"known", "declined"} for item in CLOSURE_CATEGORIES) and not context_to_verify
        fatigue = controller["question_count"] >= TYPICAL_QUESTION_LIMIT
        # The model picks the next question from the full conversation. The
        # controller only enforces scope, repetition, safety and fatigue; it
        # does not walk a fixed list of missing fields.
        if proposed in eligible and not (fatigue and assessment["question_importance"] != "essential"):
            next_category = proposed

        candidate = candidate_question if proposed == next_category else ""
        normalised_questions = {_normalise_text(item) for item in controller["asked_questions"]}
        candidate_is_valid = bool(candidate and _question_in_scope(candidate, proposed, clinical_state) and _easy_single_question(candidate) and _normalise_text(candidate) not in normalised_questions)
        if next_category and candidate_is_valid:
            previous_count = controller["question_counts"].get(next_category, 0)
            assistant_text = _response_text(reply, candidate)
            if _unsafe_reply(assistant_text) or _NON_HEALTH_ACTION.search(assistant_text):
                assistant_text = MODEL_OUTPUT_BLOCKED_TEXT
                action, stop_reason = "reply", "model_output_blocked"
            else:
                action, stop_reason = "ask", None
                controller["asked_categories"] = list(dict.fromkeys(controller["asked_categories"] + [next_category]))
                controller["question_counts"][next_category] = previous_count + 1
                controller["asked_questions"] = (controller["asked_questions"] + [candidate])[-12:]
                controller["question_count"] += 1
                controller["last_question_category"] = next_category
                if next_category == "relevant_history":
                    controller["linked_context_ids"] = list(dict.fromkeys(controller["linked_context_ids"] + context_to_verify))
        elif assessment["suggested_action"] == "finish" and (enough or not eligible):
            assistant_text = reply or FINISH_TEXT
        else:
            # No canned question replaces a model decision. Keep the session
            # open and let the user continue if the model offered no safe,
            # non-repeated follow-up.
            action, assistant_text, stop_reason = "reply", reply, "awaiting_user"

    if action != "ask":
        next_category = None
    if action in {"finish", "urgent"}:
        controller["last_question_category"] = None
    return _result(
        started=started, provider_name=provider_name, model_id=model_id,
        action=action, assistant_text=assistant_text,
        question_category=next_category, stop_reason=stop_reason,
        controller=controller, clinical_state=clinical_state, safety=safety,
        model_intent=assessment["user_intent"],
        relevant_context_ids=assessment["relevant_context_ids"],
        unknowns=_ground_notes(assessment["unknowns"], turns, health_context, unknowns=True),
        contradictions=_ground_notes(assessment["contradictions"], turns, health_context),
        risk_assessment=risk_assessment,
        pending_questions=pending_questions,
    )


def payload_sha256(payload: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
