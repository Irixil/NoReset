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
import uuid
from typing import Any

try:
    from .adapter import MockProvider, provider_from
    from .safety import DANGER_REMINDER, scan_danger
except ImportError:
    from adapter import MockProvider, provider_from
    from safety import DANGER_REMINDER, scan_danger


PROMPT_VERSION = "clinical-intake-v7"
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
_PATTERNS = {
    "main_complaint": re.compile(r"疼|痛|酸|胀|刺痛|灼痛|晕|咳|喘|闷|恶心|吐|发热|发烧|无力|没劲|麻|痒|肿胀|肿起来|肿得|发肿|不舒服|难受|睡不着|吃不下|伸不直"),
    "onset_course": re.compile(r"今天|昨天|前天|刚才|早上|上午|中午|下午|晚上|半夜|最近|小时|分钟|天|周|月|年|开始|一直|后来|突然|慢慢|越来越|反复|时好时坏"),
    "symptom_character": re.compile(r"刺痛|胀痛|酸痛|酸|麻|烧|灼|跳着|隐隐|钝|刀割|压着|一阵|持续|较轻|轻微|不算重|偏重|剧烈疼痛|很疼|非常疼|程度|[一二三四五六七八九十\d]+分"),
    "aggravating_relieving": re.compile(r"活动|走路|上楼|下楼|弯|伸|躺|坐|站|休息|吃饭|空腹|更疼|减轻|缓解"),
    "associated_symptoms": re.compile(r"同时|还会|伴随|另外|胸(?:口|部)?(?:疼|痛)|胸闷|发烧|咳|吐|恶心|晕|麻|肿|喘|心慌|出汗"),
    "functional_impact": re.compile(r"影响|费劲|不稳|抓不住|拿不住|抬不起来|睡不着|睡不好|睡得(?:还好|好|不好)|睡眠(?:正常|还好|不好|受影响)|睡觉(?:受影响|不好|还好)|吃不下|走不了|不能走|平地(?:能|可)走|能(?:自己)?走路|可以自己走|走楼梯|上下楼|下不了地|起不来|伸不直|活动|自理|干活"),
    "relevant_history": re.compile(r"以前|之前也|老毛病|长期|过敏|手术|住院|一直吃|既往|病史"),
    "prior_actions_results": re.compile(r"量过|测过|做过|看过|查过|用了|吃了|处理|结果|报告|数值"),
}
_QUESTION_SCOPE = re.compile(r"哪里|哪儿|部位|感觉|怎么|什么时候|多久|开始|变化|后来|突然|逐渐|加重|减轻|反复|程度|影响|走|站|起|拿|抬|吃|睡|活动|发生|之前|前后|还有|伴随|同时|以前|类似|用药|过敏|手术|住院|量过|测过|做过|结果|资料|报告")
_UNSAFE_REPLY = re.compile(
    r"(?:可能|考虑|怀疑|应当|应该|建议|最好).{0,12}(?:是|病|炎|癌|症|就医|检查|治疗|服用|用药)|"
    r"(?:建议|应该|应当|最好|可以|需要|请|先|自行|直接).{0,8}(?:吃药|服药|用药|做(?:核磁|CT|彩超|B超|化验|检查))|"
    r"加药|减药|停药|换药|加量|减量|改药|处方|剂量|药量|治疗方案|"
    r"去医院|去急诊|拨打\s*120|做(?:核磁|CT|彩超|B超|化验|检查)",
    re.IGNORECASE,
)
_NON_HEALTH_ACTION = re.compile(r"银行卡|支付|付款|转账|密码|验证码|身份证|手机号|下载|打开链接|点击链接|扫码")
_CONTEXT_CATEGORIES = {"conditions", "medications", "allergies", "procedures", "tests", "similar_episodes"}


def _unsafe_reply(text: str) -> bool:
    """Allow recording past facts while still blocking new medical advice."""
    factual = re.sub(
        r"(?:没|没有|尚未|还没|已经|曾经|以前|有没有|是否)?做(?:过)?(?:核磁|CT|彩超|B超|化验|检查)",
        "已核对既往资料",
        text,
        flags=re.IGNORECASE,
    )
    factual = re.sub(
        r"(?:没|没有|尚未|还没|已经|曾经|以前|有没有|是否)(?:吃|服|用)(?:过)?药",
        "已核对既往用药",
        factual,
    )
    return bool(_UNSAFE_REPLY.search(factual))


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
        turn: dict[str, Any] = {"turn_id": turn_id, "text": text.strip()}
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


def _correction_span(text: str) -> tuple[int, int] | None:
    match = _CORRECTION_REPLACEMENT.search(text)
    return (match.start("new"), match.end("new")) if match else None


def _source_excerpt(text: str, category: str | None = None) -> str:
    """Keep complete source clauses that actually match the requested fact."""
    matcher = _EXPLICIT_UNKNOWN if category == "unknown" else _PATTERNS.get(category) if category else None
    if matcher is None:
        return text.strip()
    correction = _correction_span(text)
    search_start, search_end = correction if correction else (0, len(text))
    matches = list(matcher.finditer(text, search_start, search_end))
    if not matches:
        return ""
    separators = "，。！？；,.!?;\n"
    excerpts = []
    for match in matches:
        previous = max((text.rfind(char, 0, match.start()) for char in separators), default=-1)
        following = [index for char in separators if (index := text.find(char, match.end())) >= 0]
        start = max(previous + 1, search_start)
        end = min(min(following) + 1 if following else len(text), search_end)
        clause = text[start:end].strip()
        if re.search(r"[？?]", clause):
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


def _current_main_complaint_refs(refs: list[str], turns: list[dict[str, Any]]) -> list[str]:
    """Drop an earlier side-specific complaint explicitly replaced by a correction."""
    positions = {row["turn_id"]: index for index, row in enumerate(turns)}
    current = set(refs)
    for correction in turns:
        match = _CORRECTION_REPLACEMENT.search(correction["text"])
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
    values = [_source_excerpt(turn_text[ref], category) for ref in turn_ids if ref in turn_text]
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


def _ground_clinical_state(
        state: dict[str, dict[str, Any]], turns: list[dict[str, Any]],
        health_context: list[dict[str, str]], controller: dict[str, Any]) -> None:
    """Only raw words that actually answer a category may close that category."""
    turn_text = {row["turn_id"]: row["text"] for row in turns}
    latest = turns[-1]
    last_category = controller.get("last_question_category")
    negative_categories = {"aggravating_relieving", "associated_symptoms", "relevant_history", "prior_actions_results"}

    for category in CATEGORIES:
        item = state[category]
        refs = [ref for ref in item["evidence_turn_ids"] if ref in turn_text]
        contexts = item["context_ids"] if category == "relevant_history" else []

        short_answer = (
            category == last_category
            and latest.get("responding_to") is not None
            and len(latest["text"]) <= 120
            and not _META_FEEDBACK.search(latest["text"])
            and not _DIAGNOSIS_REQUEST.search(latest["text"])
            and not _DECLINED.search(latest["text"])
            and not re.search(r"[？?]", latest["text"])
            and not _EXPLICIT_FINISH.fullmatch(latest["text"].strip())
            and not _source_excerpt(latest["text"], category)
        )
        if short_answer and item["status"] == "known" and latest["turn_id"] in refs:
            existing_refs = [
                ref for ref in refs
                if ref != latest["turn_id"]
                and not _META_FEEDBACK.search(turn_text[ref])
                and _source_excerpt(turn_text[ref], category)
            ]
            summary = _source_summary(existing_refs, contexts, turns, health_context, category=category)
            state[category] = {
                "status": "known",
                "summary": "；".join(part for part in (summary, latest["text"]) if part),
                "evidence_turn_ids": list(dict.fromkeys(existing_refs + [latest["turn_id"]])),
                "context_ids": contexts,
            }
            continue

        if item["status"] == "known":
            grounded_refs = [
                ref for ref in refs
                if not _META_FEEDBACK.search(turn_text[ref])
                and _source_excerpt(turn_text[ref], category)
            ]
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
            summary = _source_summary(grounded_refs, contexts, turns, health_context, category=category)
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


def _merge_obvious_facts(state: dict[str, dict[str, Any]], turns: list[dict[str, Any]]) -> None:
    """Prevent obvious repetition; never create a medical interpretation."""
    for category in _PATTERNS:
        if state[category]["status"] != "missing":
            continue
        refs = [
            row["turn_id"] for row in turns
            if not _META_FEEDBACK.search(row["text"]) and _source_excerpt(row["text"], category)
        ]
        if category == "main_complaint":
            refs = _current_main_complaint_refs(refs, turns)
        if refs:
            excerpts = [
                _source_excerpt(next(row["text"] for row in turns if row["turn_id"] == ref), category)
                for ref in refs[-2:]
            ]
            state[category] = {"status": "known", "summary": "；".join(excerpts)[:500], "evidence_turn_ids": refs, "context_ids": []}


def _mock_assessment(turns: list[dict[str, Any]], controller: dict[str, Any]) -> dict[str, Any]:
    latest = turns[-1]
    state = _empty_state()
    _merge_obvious_facts(state, turns)
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
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - {"reply_text"} or not isinstance(value.get("clinical_state"), dict) or set(value["clinical_state"]) != set(CATEGORIES):
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
    }


def _controller_state(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    raw_counts = source.get("question_counts") if isinstance(source.get("question_counts"), dict) else {}
    counts = {category: min(max(int(raw_counts.get(category, 0) or 0), 0), 3) for category in CATEGORIES}
    legacy = {"main_discomfort": "main_complaint", "onset_change": "onset_course", "life_impact": "functional_impact", "other_facts": "associated_symptoms"}
    for old, new in legacy.items():
        counts[new] = max(counts[new], min(max(int(raw_counts.get(old, 0) or 0), 0), 2))
    asked = [legacy.get(item, item) for item in source.get("asked_categories", []) if legacy.get(item, item) in CATEGORIES]
    closed = [legacy.get(item, item) for item in source.get("closed_categories", []) if legacy.get(item, item) in CATEGORIES]
    asked_questions = [str(item).strip()[:160] for item in source.get("asked_questions", []) if isinstance(item, str) and item.strip()][-12:]
    last = legacy.get(source.get("last_question_category"), source.get("last_question_category"))
    return {
        "asked_categories": list(dict.fromkeys(asked)), "closed_categories": list(dict.fromkeys(closed)),
        "question_counts": counts, "asked_questions": asked_questions,
        "question_count": min(max(int(source.get("question_count", 0) or 0), 0), MAX_QUESTIONS),
        "no_new_fact_count": min(max(int(source.get("no_new_fact_count", 0) or 0), 0), 2),
        "last_question_category": last if last in CATEGORIES else None,
        "linked_context_ids": [item for item in source.get("linked_context_ids", []) if isinstance(item, str) and _CONTEXT_ID.fullmatch(item)][:30],
    }


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
            contradictions: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    completeness = {
        "complete": all(clinical_state[item]["status"] in {"known", "declined"} for item in CLOSURE_CATEGORIES),
        "clinical_state": clinical_state,
        "evidence_turn_ids": list(dict.fromkeys(ref for item in clinical_state.values() for ref in item["evidence_turn_ids"])),
        "relevant_context_ids": relevant_context_ids or [], "unknowns": unknowns or [], "contradictions": contradictions or [],
    }
    return {
        "ok": True, "trace_id": "ctr_" + uuid.uuid4().hex, "provider": provider_name,
        "model_id": model_id, "prompt_version": PROMPT_VERSION, "prompt_sha256": PROMPT_SHA256,
        "latency_ms": round((time.perf_counter() - started) * 1000, 2), "action": action,
        "assistant_text": assistant_text, "question_category": question_category, "stop_reason": stop_reason,
        "controller": controller, "completeness": completeness, "model_intent": model_intent,
        "risk_level": "urgent" if safety.get("danger_detected") else "needs_review" if safety.get("clinical_review_required") else "routine",
        "local_safety": safety,
    }


def conversation_turn(payload: dict[str, Any], provider=None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ConversationError("payload_invalid")
    turns = _clean_turns(payload)
    health_context = _clean_health_context(payload)
    controller = _controller_state(payload.get("controller"))
    latest = turns[-1]["text"]
    safety = scan_danger(latest)
    started = time.perf_counter()

    if safety["danger_detected"]:
        assessment = _mock_assessment(turns, controller)
        return _result(started=started, provider_name="LocalDangerRule", model_id="local-danger-rule-v1", action="urgent", assistant_text=DANGER_REMINDER, question_category=None, stop_reason="urgent_rule", controller={**controller, "last_question_category": None}, clinical_state=assessment["clinical_state"], safety=safety, model_intent=assessment["user_intent"])

    selected_provider = provider or provider_from()
    if isinstance(selected_provider, MockProvider):
        draft = _mock_assessment(turns, controller)
        model_id = "mock-clinical-intake-v1"
    else:
        draft = selected_provider.complete_json(SYSTEM_PROMPT, {"turns": turns, "health_context": health_context, "controller": controller})
        model_id = getattr(getattr(selected_provider, "c", None), "model", None) or "unknown"
    provider_name = type(selected_provider).__name__
    try:
        assessment = _validate_assessment(draft, turns, health_context)
    except ConversationError as error:
        if error.code != "model_reply_unsafe":
            raise
        fallback = _mock_assessment(turns, controller)
        return _result(started=started, provider_name=provider_name, model_id=model_id, action="reply", assistant_text=MODEL_OUTPUT_BLOCKED_TEXT, question_category=None, stop_reason="model_output_blocked", controller=controller, clinical_state=fallback["clinical_state"], safety=safety)

    clinical_state = assessment["clinical_state"]
    _ground_clinical_state(clinical_state, turns, health_context, controller)
    _merge_obvious_facts(clinical_state, turns)
    latest_normalised = _normalise_text(latest)
    earlier = {_normalise_text(row["text"]) for row in turns[:-1]}
    # Not remembering one detail must not erase separately stated symptoms.
    declined = bool(_DECLINED.search(latest)) and not any(
        _source_excerpt(latest, category) for category in CATEGORIES
    )
    explicit_finish = bool(_EXPLICIT_FINISH.fullmatch(latest.strip())) or assessment["user_intent"] == "explicit_finish"
    meta_feedback = bool(_META_FEEDBACK.search(latest)) or assessment["user_intent"] == "meta_feedback"
    diagnosis_request = bool(_DIAGNOSIS_REQUEST.search(latest))
    patient_question = assessment["user_intent"] == "patient_question" or diagnosis_request
    correction = bool(_CORRECTION.search(latest)) or assessment["user_intent"] == "correction"
    conversational_question = meta_feedback or patient_question
    adds_fact = assessment["latest_turn_adds_fact"] and bool(latest_normalised) and latest_normalised not in earlier and not declined and not explicit_finish and not conversational_question
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
        eligible = [category for category in CATEGORIES if (clinical_state[category]["status"] == "missing" or category == "relevant_history" and context_to_verify) and category not in controller["closed_categories"] and controller["question_counts"].get(category, 0) < 2]
        candidate = assessment["candidate_question"]
        normalised_questions = {_normalise_text(item) for item in controller["asked_questions"]}
        if proposed in eligible and controller["question_count"] < MAX_QUESTIONS and candidate and _QUESTION_SCOPE.search(candidate) and _normalise_text(candidate) not in normalised_questions:
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
        eligible = [category for category in CATEGORIES if (clinical_state[category]["status"] == "missing" or category == "relevant_history" and context_to_verify) and category not in controller["closed_categories"] and controller["question_counts"].get(category, 0) < 2]
        proposed = assessment["question_category"] if assessment["suggested_action"] == "ask" else None
        enough = all(clinical_state[item]["status"] in {"known", "declined"} for item in CLOSURE_CATEGORIES) and not context_to_verify
        fatigue = controller["question_count"] >= TYPICAL_QUESTION_LIMIT
        # The model picks the next question from the full conversation. The
        # controller only enforces scope, repetition, safety and fatigue; it
        # does not walk a fixed list of missing fields.
        if proposed in eligible and not (fatigue and assessment["question_importance"] != "essential"):
            next_category = proposed

        candidate = assessment["candidate_question"] if proposed == next_category else ""
        normalised_questions = {_normalise_text(item) for item in controller["asked_questions"]}
        candidate_is_valid = bool(candidate and _QUESTION_SCOPE.search(candidate) and _normalise_text(candidate) not in normalised_questions)
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
    )


def payload_sha256(payload: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
