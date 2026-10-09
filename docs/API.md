# 前后端接口合同 v0.5

## 2026-10-01 照片来源核对门槛

照片 OCR 只生成候选文字。`source_kind:document` 的记录必须有绑定当前完整 `raw_text` 的 `source_review:{method:"original_comparison",text,confirmed_at}`，才能进入整理、记录确认和交接正文。它表示使用者对照原件后的声明，不代表系统证明视觉识别准确或医学确认。创建、OCR 和修订不能自行设置该声明；修订清空声明，历史 `recorded` 状态不替代原件核对，旧修订即使误标为自述也继承照片来源。

本机 `POST /api/events/:id/source-review` 请求 `{expected_version,compared_with_original:true}`；界面先展示原件，再允许逐行核对和明确勾选。看不清、遮挡、裁切处应修订为 `[无法辨认]`。该动作清除旧 AI 草稿，保留原件、原识别和修订历史。SQLite 兼容接口执行同一门槛。无状态 `/api/ai/organize` 也检查当前记录与历史中的照片声明；缺失或文字版本不一致时在模型请求前返回 `409 document_source_review_required`。原件核对只能防止未经确认的自动流转，不能阻止使用者错误确认。

交接 `items` 不含未核对照片文字、旧 AI 摘要或风险结论，另以 `pending_documents:[{record_id,recorded_at,reason:"document_source_review_required"}]` 提醒查看原件。附件只含状态，不再夹带整份识别内容。恢复加密备份后使用相同判断。照片记录不能通过修订改成患者自述，也不能作为语音对话回合提交。

供应商明确表示输出被截断/未正常结束时，返回可重试的 `incomplete_provider_response`，不把半截文字关联为成功记录。HTML 清理保留表格行列分隔、比较符和上下标，不推测单位或缺失项。已核对资料再进入整理时，原有完整原文约束仍阻断模型补写未知项。

## 内测版的正式边界

`APP_MODE=local_first` 是内测版的正式运行模式。记录、修订历史、媒体原件和备份由浏览器的 Web Crypto + IndexedDB 处理，后端不创建 SQLite 健康数据库，并对旧 `/api/events`、`/api/media`、`/api/handoffs` 服务端路由返回 `404 legacy_api_disabled`。前端保留同形本地请求层，用于降低旧界面迁移风险；这些本地请求不会离开浏览器。

### 2026-10-09 隔离语音试验保护

受预算 gate 管理的 ASR 成功响应增加顶层 `trial_control:{review_required:true}`。该字段由服务端依据本次实际预占与同次用量生成；HTTP 入参、供应商同名字段、媒体 `attempt_id` 和前端按钮不能批准预算。客户端先加密保存原件、转写和来源版本，再持久停在 `review_required`，不自动请求后续 LLM。缺少标记的普通产品流程沿用原行为；存在但非法的标记保守停止。

本机 `POST /api/conversations/:id/trial-continue` 接受 `{expected_version,turn_id,turn_version}`，只核当前原话/事件版本并继续一次既有 LLM 路由。它不是新的后端授权接口：必须另有受信的有效授权，且完整派生请求 SHA、范围和累计预算符合 gate。继续前持久 `continuing`，刷新不补发，重复点击不增加请求。任何本次发送、计量或服务端业务失败都会停止后续受控请求；包括 HTTP 200 的 `model_output_blocked` 安全阻断。成功 ASR 不因后续 LLM 失败变成可重试识别，原件继续保留。

本地可信 `append_trial` 支持在同一累计账本追加 v3 授权快照，保留旧 attempt、原报价、用量及预占；不从空库创建 v3，不退款、不重算旧价，也不解除冻结。v2/v3 金额硬界模式仍要求完整计费合同界、有效许可与准确来源/请求 SHA。另有独立 `noreset-synthetic-trial-informed-risk-v1` 有限请求模式，只能在所有者明确接受最终费用未知后使用，严格限制次数、时效、精确输入、模型、参数、顺序和逐笔业务审核；它不声称美元硬封顶。该模式的 `remaining_usd:null`、`cost_bound_known:false` 和新条目 `reserved_usd:0` 分别表示金额剩余未知、成本界未知和没有硬界预占，不表示免费、零扣费或释放历史预占。

实际请求先写入对应控制记录，再从同次有界响应校验模型与完整用量；不额外请求计量或重试。Gemini 仅在非负整数 `promptTokenCount + candidatesTokenCount = totalTokenCount` 时把缺省 `thoughtsTokenCount` 规范为0；缺总量、不平衡、非法类型、未知模型和异常结束仍拒绝并停止。该推断只表示同次用量平衡，不表示未知费用为0。LLM wire 上限24000 bytes/输出至多2048，ASR wire 上限3145728 bytes/输出1024/思考0，仅是请求控制，不能代替供应商所有尝试和失败收费的总金额保证。

2026-10-09 曾激活上述独立有限请求许可并实际执行1次合成ASR，因解析失败停止，0次LLM、0次重试；旧3行账本和USD0.9510912历史保守预占保留。该失败批已关闭、账本保持冻结，剩余3次名义次数不自动续用；当前免费诊断不是新收费许可。解析修复已有离线证据，尚未重新调用真实服务；转写输出与参考台词有语义差异，发音尚未独立听取。[实际失败记录](evidence/goal-audit-2026-10-09/real-voice-attempt/README.md)与[免费诊断](evidence/goal-audit-2026-10-09/asr-free-diagnosis/business-diagnosis.md)分别说明实际结果和未测边界。

ASR文字是机器初稿，可供正常对话整理，但会话报告保持 `auto_unreviewed`/“本人未核对”，当前摘要仍标“待核对”，不表示本人或医生已确认病情。当前语音可在保留期内对照原录音、修改文字；修改保留旧版，后续模型输入与报告绑定当前文字和版本。成功结果展示不自动暂停；普通流程仍在使用者主动离开或结束时清理成功的临时录音，保留文字与修改历史。受控试验原件按其停止和人工审核规则保留；播放器的内存链接释放不等于删除加密原件。

函数服务只提供以下无状态能力：

- `GET /health`：返回 `mode:"local_first"` 和 `storage:"encrypted_on_device"`，不返回旧 `session_token`。
- `GET /api/app/config`：返回产品名、数据位置、访问保护、私有云备份配置，以及 `provider` 和 `capabilities.text_ai/audio_recognition/image_recognition`。每项含 `available` 与 `reason`；`provider_mock` 表示模拟且 `available:false`；`provider_configured_connection_unverified` 仅表示配置校验通过，不保证网络连通和识别质量。
- `GET /api/app/session`：返回当前浏览器是否已登录；已登录时同时返回 CSRF 令牌和过期时间。
- `POST /api/app/login`：请求 `{"password":"..."}`，成功设置已签名、HttpOnly、SameSite=Strict 的 Cookie。
- `POST /api/app/logout`：需 Cookie + `X-CSRF-Token`，清除当前 Cookie。
- `POST /api/ai/organize`：需 Cookie + CSRF + `consent:true`；只返回经验证的草稿和本地安全字段，不写数据库。
- `POST /api/ai/conversation-turn`：需精确 Origin、签名 Cookie 和 CSRF。`turns` 为 1–40 条老人原话，每条 `{turn_id,text,version?,responding_to?:{turn_id,text}}`；`responding_to` 只解释回答语境，助手 ID 不能作为患者事实来源。`health_context` 在客户端发送前限制为本次显式勾选的最多 5 项；未勾选内容不外发。完整对话仍保存在本机。`action` 可为 `ask / reply / finish / urgent`：`reply` 表示本轮仅回应、不结束、不新增追问计数；`assistant_text` 是已经验证的完整回应，模型内部 `reply_text` 不作为患者事实。
- `POST /api/ai/media/recognize`：需 Cookie + CSRF，`multipart/form-data` 严格包含 `kind` / `content_type` / `attempt_id` / `file`；原件只写入临时文件，请求完成或失败后删除。
- `GET /api/backups`：需登录 Cookie；只列出私有 TOS 中 `backups/` 下密文对象的名称、大小和时间，不返回内容。
- `POST /api/backups/upload-grant`：需 Cookie + CSRF，请求 `size` 与 64 位十六进制 `sha256`；返回服务端生成对象名及最多 15 分钟、默认 5 分钟有效的 TOS `PUT` 地址。浏览器直接上传已经加密的 `.bingli` 包。
- `POST /api/backups/download-grant`：需 Cookie + CSRF，请求 `object_key`；只允许当前备份前缀内的 `.bingli` 对象，返回短时 `GET` 地址。下载后仍须在浏览器验证恢复口令并预览，不能静默覆盖当前设备。

`POST /api/ai/organize` 的文字请求最多 10000 字符，历史证据最多 20 条；媒体默认最大 20 MiB，可用 `APP_AI_MEDIA_MAX_BYTES` 下调，不可超过 25 MiB。付费 AI 失败后不在函数内自动重试。密文备份最大 100 MiB；签名地址属于短时持有者权限，不能写入日志、反馈或长期存储。

2026-09-30 本地实现：所有 `/api/ai/*` 在调用供应商前检查来源、签名会话与 CSRF。缺配置返回 503，未授权 401，来源/CSRF 不符 403；单进程频率或并发超限返回 429 和 `Retry-After`，不会触发模型。默认每会话每分钟 12 次、全进程 120 次，并发分别 2/8；它不是跨实例或可持久化的费用上限，公开部署还需网关/供应商总预算控制。`scripts.start_app` 仅在回环监听和回环前端时启用静默本地会话；无第二个老人端密码。公网不自动签发该会话。

本地优先公开 AI 接口拒绝 Mock：文字接口返回 `503 provider_mock_unavailable`，媒体识别返回 `503 media_mock_unavailable`，均可在真实服务恢复后重试。直接引擎的显式 Mock 仍供隔离自动化测试使用，不能作为用户功能验收。客户端也拒绝 `recognition.is_mock` 或旧 `[Mock ASR/OCR]` 占位文字进入患者事实，并保留录音。历史模拟回合标记 `is_mock:true`，从模型输入与报告事实中排除，历史不静默删除。

本机接口 `POST /api/conversations/:id/context {context_ids:[...]}` 只保存这次选择，不请求 AI；下次发言或主动重试才发送。`POST /api/conversations/:id/resume-assistant` 可重试未完成回复或失败提示，保留同一条老人原话。交接材料带记录/日期筛选时只附所选记录关联的原件；未关联原件仍在“看病资料”。首次空库可直接从已验证加密备份恢复，已有库覆盖恢复仍需明确确认。

生产环境的 TOS 签名使用函数所绑定 IAM 角色的请求级 STS 凭据（`X-Faas-Access-Key-Id`、`X-Faas-Secret-Access-Key`、`X-Faas-Session-Token`），不配置长期 TOS AK/SK。角色策略必须限制到目标私有 Bucket 的 `backups/` 前缀。函数到 TOS 的列表请求使用同地域内网 Endpoint；签发给浏览器的短链接使用公网 HTTPS Endpoint。

下文的 SQLite/分片媒体合同仅保留为旧开发模式和回归测试合同，不是公网内测版的数据落盘设计。

本页描述现有文本接口，以及已经由 `backend/server.py` 和 HTTP 专项测试固定的媒体接口。启动已经连接本地文件存储、SQLite 媒体状态和识别模块；需显式设置 `MEDIA_RECOGNITION_PROVIDER=mock` 才启用离线 Mock，未配置 provider 不会静默回退。`feaf182` 已用仓库合成 WAV/PNG 完成一次真实 ASR/OCR 全链路验收；这不证明浏览器 WebM、手机、真实患者、临床准确率或生产部署可用。

后端 API 地址默认 `http://127.0.0.1:18768`；使用者前端默认 `http://127.0.0.1:5173`。两者是独立服务，产品只分享前端地址。

本地优先内测模式使用签名 HttpOnly Cookie、精确 `ALLOWED_ORIGIN` 和 CSRF 令牌保护 `/api/app/*`、`/api/ai/*` 和 `/api/backups/*`。下文的 `X-Session-Token` 和 SQLite 事件 API 是历史兼容模式；`APP_MODE=local_first` 时不用它们保存健康资料。

所有 JSON 使用 UTF-8。媒体上传按下文使用 `multipart/form-data`。文本记录只有创建要求 `Idempotency-Key`；媒体创建、分片、完成和识别启动都要求各自的 `Idempotency-Key`。

`organize`、`review`、`revise` 的 `expected_version` 都必须是正整数。缺失、布尔值、字符串、零或负数返回 `400 expected_version_must_positive_integer`；与当前版本不一致返回 `409 stale_version`。服务器不会替调用方自动选择最新版本。

本 MVP 用单人本地会话，不发送 `X-Auth-Token`。已有 `/api/auth/*` 属于保留的账号兼容接口，不属于此次老人端必接合同，也不代表多家庭鉴权已安全完成。

## 核心流程

### `POST /api/events` 保存原话

请求：

```json
{"raw_text":"今天胸口疼，喘不上气","source_kind":"elder","actor_name":"老人"}
```

成功 `201`（重复幂等请求为 `200`）：`{ok:true, created:true|false, event}`。event 立即含 `raw_text`、`state:"inbox"`、`version:1`、`local_safety`。前端收到这个响应后就可以显示“已保存”，不要等 AI。

完整 Event 包含：`record_id`、`raw_text`、`source_kind`、`actor_name`、`occurred_time`、`recorded_at`、`state`、`version`、`draft`、`result_meta`、`review_notes`、`related_record_ids`、`supersedes_id`、`created_at`、`updated_at`、`household_id`、`local_safety`、`confirmation_scope`。未整理时 `draft/result_meta` 为 null；只有状态为 `recorded` 时 `confirmation_scope` 为 `record_accuracy`。本地单人 MVP 的前端不要根据 `household_id` 构建账号或家庭功能。

`raw_text` 必填，最多 10000 字符；`actor_name` 必填，最多 80 字符。`source_kind` 必填，可用 `elder`、`document`、`family_observation`、`family_report`、`caregiver`、`clinician_evidence`、`audio_transcript`、`system`、`unknown`。老人手输用 elder；公开论文摘要用 document，不能冒充亲口自述。

可选 `occurred_time:string|null`、`related_record_ids:string[]`（最多 10 个已存在记录 ID）。`occurred_time` 如果提供了非字符串、非 null 值，返回 `400 occurred_time_required`。不要传 `recorded_at`，让服务器记录输入时间；创建或修订时传入该字段会返回 `400 recorded_at_read_only`。不知道发生时间就不填。新记录 ID 由后端生成。

每次新建先生成 `crypto.randomUUID()` 作为幂等键，同一请求超时重试必须复用原键和原请求体。同键不同内容返回 409；用户新建另一条记录使用新键，即使文字相同也保留两条。

### `POST /api/events/{record_id}/organize` 整理

请求：`{"expected_version":1}`。可选 `actor_name`；省略时使用“本地用户”，如果提供，必须是非空字符串且最多 80 字符。成功 `200`，event 变为 `draft`、版本加一，并返回 `ok:true`、`ai_failed:false`、`event`、`output`、`provider`、`trace_id`、`prompt_version`、`schema_version`、`latency_ms`、`safety_guard_applied`、`raw_text_preserved:true`、`local_safety` 及扁平安全字段。output 是 `event-v0.3` 草稿，仍需人工核对；`event.draft` 与本次保存的 output 一致。后端持久化接缝会再校验草稿的 Schema、来源、记录 ID、时间和结果元数据，不会保存绕过 `event-v0.3` 规则的输出。

AI 失败、超时、断网或结果非法时为 `422`，响应仍含 `event`、`raw_text_preserved:true`、`ai_failed:true`、`failure_reason`、`local_safety` 和扁平的 `danger_detected/escalation_level/review_role/danger_reminder`。第一次整理失败时 event 保持 `inbox`，没有伪造 draft。若旧草稿已存在，失败保留原版本和旧草稿；页面必须注明本次重新整理失败，不能把旧结果当成本次成功。危险原文仍可用详情和历史接口查询。

C 部分修订：成功响应及 `event.result_meta` 增加 `model_id`、`prompt_sha256`、`input_sha256`，失败响应与审计也包含这些标识（配置不可读时模型标识为空）。旧记录可能没有新增字段；它们用于开发核查，前端主流程无需展示。提示词版本以 `prompts/VERSION` 为准，哈希覆盖实际拼接的提示词与 Schema，输入哈希覆盖实际发送的原文证据对象。历史草稿和核对备注不会作为新一轮模型证据发送。

通用模型适配后的 422 可额外包含 `failure_code` 和 `provider_http_status`。模型 401/403 展示鉴权或访问权限失败，429 展示限流或额度不足；超时、截断和协议错误有固定原因。它们是下游模型状态，前端仍按 HTTP 422 的原文保真合同处理，不当成当前本地用户登录失效。未知异常不回显原始错误体。

魔搭官方明确返回未绑定阿里云账号时，使用 `failure_code=model_account_binding_required`、`failure_reason=魔搭账号需先绑定阿里云账号`，仍保留 `provider_http_status`。这是精确已知错误的白名单映射，不是把所有 401 都解释为绑定问题。

当前采用结构整理：`summary` 保留完整当前原文，`claims` 逐条保留所引用记录的完整原文，只允许去除外围空白；追问限制为固定中性模板。模型分类和冲突候选仍需核对。自由摘要和片段截取无法通过证据校验时返回 422；界面继续显示原文，不把失败解释为输入无效或医学正常。没有后端 `occurred_time` 时保持 `time.occurred=null`，原文中的时间表达完整保留。

规则升级时，旧记录按新规则重新扫描，旧版本已出现的提醒仍保留，旧数据库证据和历史快照不改写。`local_safety` 可增加 `previous_rule_version`、`previous_danger_detected`、`previous_matched_rules`、`historical_notice_preserved`。最后一项为 true 表示新规则未命中但旧提醒仍在；此时本地 `emergency` 可以与 AI 草稿的 `none` 并存，页面必须显示“历史记录曾触发提醒”，不能只看草稿降级。旧交接卡保持生成时快照；查看最新规则结果应读取事件或重新生成交接材料。每次规则行为变化必须升级规则版本。

新增 `local_safety.clinical_review_flags/clinical_review_required/clinical_review_role/clinical_review_notice/clinical_review_version/clinical_review_status` 为可选兼容字段。`offline-review-flags-v1` 仅对带明确心率指标、分钟单位的 `0 < 数值 <= 40` 表达生成 `low_heart_rate_candidate`；这是工程复核线索，不是医学阈值认证。历史、否定和假设也可能标记，状态始终为 `candidate_unverified`，没有匹配为 `not_flagged`，不得显示“医学正常”。标记会随保存/详情/失败响应保留；新成功草稿至少路由专业复核，既有急救级别优先。记录确认不能清除交接中的 `clinical_measurement_review_required`。旧候选版本变化时可带 `previous_clinical_review_version/previous_clinical_review_flags/historical_clinical_review_preserved`，保留历史待核线索和旧证据；旧卡仍是历史快照。上线前医学审阅清单见 [临床规则草案](CLINICAL-RULE-DRAFT.md)。

```json
{
  "ok": false,
  "ai_failed": true,
  "error": "ai_organize_failed",
  "record_id": "rec_实际ID",
  "raw_text_preserved": true,
  "failure_reason": "网络连接失败",
  "danger_detected": true,
  "escalation_level": "emergency",
  "review_role": "emergency_services",
  "danger_reminder": "原始记录中出现需要及时人工或急救专业人员判断的描述，请联系当地急救服务或专业人员，不要自行改药。"
}
```

上面省略了完整 `event`、`local_safety`、`trace_id` 和审计元数据以便阅读，实际响应还包含 `failure_type`、`failure_cause_type`、`raw_text_sha256`、`prompt_version`、`schema_version`。这些字段用于问题追踪和审计关联；普通页面应依赖 `error`、`failure_reason`、`event`、`raw_text_preserved`、`local_safety` 与扁平安全字段，不应根据异常类名决定用户流程。可以从历史的 `audit` 看到失败类型和原因。前端应先解析 JSON 再处理 `response.ok`，不能遇到非 2xx 就丢掉响应体。

### `POST /api/events/{record_id}/review` 核对

请求：`{"expected_version":2,"action":"confirm","note":"仅确认记录准确"}`。`actor_name` 规则与整理接口一致；`note` 若提供必须是字符串，非字符串返回 `400 note_required`。成功 `200`，event 变为 `recorded`。`confirm` 只表示原文/整理是否记录准确，不能表示医生确认，也不能消除 `local_safety` 危险状态。退回时用 `action:"return"`，必须带原因。

### `POST /api/events/{record_id}/revise` 修订

请求带新 `raw_text`、`source_kind`、`actor_name`、`expected_version`、`reason`；`actor_name` 必填，非空且最多 80 字符。成功 `201` 返回 `{ok:true,event:新记录}`。旧版本标记为 `superseded` 并留在历史，新版本重新扫描危险描述；旧原文不覆盖。新记录 version 从 1 开始，`supersedes_id` 指向旧记录，后续用新 ID 整理与核对。

### `GET /api/events`、`GET /api/events/{id}`、`GET /api/events/{id}/history`

成功均为 200：列表 `{ok:true,events:[Event]}`；详情 `{ok:true,event:Event}`；历史 `{ok:true,history:[{revision_id,record_id,action,version,snapshot,actor_name,at}],audit:[{audit_id,record_id,action,version,actor_name,at,details}]}`。history 是该 ID 的版本，新旧修订 ID 通过 `supersedes_id` 关联。

列表包含 superseded 记录，主列表可筛掉，历史入口保留。每个 event 都有 `local_safety`。详情/历史查询不到返回 `404`。

### `POST /api/handoffs`、`GET /api/handoffs/{id}`

生成请求体必须严格为 `{}`，非空对象返回 `400 handoff_body_must_be_empty_object`。成功返回 `201 {ok:true,handoff}`；读取返回 `200 {ok:true,handoff}`。handoff 包含 `handoff_id`、`created_at`、`household_id`、`items`、`unresolved_count`。每个 item 是完整 Event，加上 `unresolved` 和 `unresolved_reasons`。本地单人前端不使用 `household_id`；它只是兼容层归属信息。

危险记录会带 `unresolved:true`、`unresolved_reasons` 中的 `local_danger_detected`；核对记录不会把它清掉。未核对、用药/医嘱、专业复核要求、升级和冲突也会成为未解决原因；不要自行把这些字段清空。

卡片是生成时的快照。后续修订不会修改旧卡片；希望显示最新内容需要重新 POST 生成。当前不直接提供 PDF 或真正的分享链接，前端负责可读页面或浏览器打印。

## 媒体 HTTP 适配器

当前可验证范围包括默认本地后端的文件存储、SQLite 状态、识别编排，以及 HTTP 的 session/Origin 保护、上传与分片重放、原件读取与 Range、异步识别入口。HTTP 专项测试使用替身隔离解析层，默认后端另有组合测试；合成 WAV/PNG 的真实服务链路已有绑定 `feaf182` 的历史证据，浏览器生成的一次 WebM 真实识别失败且原件被保留，手机与生产仍未验收。

所有媒体写请求带 `X-Session-Token` 和 `Idempotency-Key`；带 JSON 正文的请求使用 `application/json`，上传步骤使用 `multipart/form-data`。创建上传、上传分片和完成上传都会持久化幂等信息并检查冲突；同一次可重试请求应复用同一键和完全相同的内容，下一步操作使用新键。

媒体能力由 `GET /api/media/capabilities` 公开。必须配置合法正整数 `MEDIA_UPLOAD_MAX_BYTES`、`MEDIA_UPLOAD_PART_MAX_BYTES`、`MEDIA_UPLOAD_MAX_PARTS` 才能写入媒体；任一缺失或非法时写入口返回 `503 media_limits_not_configured`。`MEDIA_REQUEST_MAX_BYTES` 仍可作为额外的 multipart 请求保护上限。所有这些都是资源保护边界，不是产品文件大小、录音时长或图片像素限制。

### `GET /api/media/capabilities` 能力发现

成功返回 `200`：

```json
{
  "ok": true,
  "capabilities": {
    "enabled": true,
    "disabled_reason": null,
    "max_total_bytes": 1048576,
    "max_part_bytes": 1048576,
    "max_parts": 16,
    "max_audio_duration_seconds": null,
    "max_image_pixels": null,
    "audio_content_types": ["audio/wav", "audio/webm"],
    "image_content_types": ["image/png", "image/jpeg"],
    "multipart_upload": true,
    "resumable_parts": true
  }
}
```

未配置或配置非法时仍返回 `200`，但 `capabilities.enabled=false`、`disabled_reason="media_limits_not_configured"`，所有媒体写请求返回 `503`。音频时长和图片像素保持 `null`；当前真实设备格式、时长、像素和大文件性能仍未验证。

### `POST /api/media/uploads` 创建上传元数据

请求是 `multipart/form-data`，这一步**不带文件**。字段为：

| 字段 | 当前形状 |
|---|---|
| `kind` | `audio` 或 `image` |
| `content_type` | 预期媒体 MIME，例如 `audio/webm`、`image/png` |
| `total_parts` | 十进制整数；片段索引随后使用 `0..total_parts-1` |
| `actor_name` | 可选上传人；省略为“老人”，最多 80 字符 |
| `occurred_time` | 可选发生时间字符串；未知时省略 |
| `original_filename` | 可选展示名；不能作为服务端路径 |
| `expected_size` | 可选十进制整数 |
| `expected_sha256` | 可选 SHA-256 |

首次返回 `201 {ok:true,created:true,upload}`；相同请求重放返回 `200` 且 `created:false`。`upload` 至少包含 `upload_id`、`media_id`、`kind`、`content_type`、`total_parts`、`status:"uploading"`。创建元数据不表示原件已保存，媒体在完成前不能显示“上传成功”。

### `POST /api/media/uploads/{upload_id}/parts/{index}` 上传片段

请求是 `multipart/form-data`，并且只能有一个名为 `file` 的文件字段，不能夹带其他文本字段。第一个片段索引为 `0`。首次返回 `201 {ok:true,created:true,part}`；重放同一片返回 `200` 且 `created:false`。`part` 至少包含 `upload_id`、`index` 和 `size_bytes`。同一幂等键或同一片索引改成其他内容属于冲突，不得覆盖已保存片段。

### `POST /api/media/uploads/{upload_id}/complete` 完成上传

请求当前必须是 JSON 空对象 `{}`；**不要发送**早期草案中的 `expected_version` 或 `part_count`，片段总数已经在创建上传时声明。请求仍必须带 `Idempotency-Key`。完成步骤会持久化该键及最终上传摘要：同一上传、同一摘要的重放返回 `200 created:false`；同键用于另一上传或不同最终摘要返回 `409 idempotency_key_payload_mismatch`。所有片段存在并完成后，首次返回 `201 {ok:true,created:true,media}`；只有响应中 `media.save_status="saved"` 才能显示“原件已保存”。缺片返回 `409 upload_incomplete`。

公共 `media` 不包含服务端路径或原件字节，核心字段为 `media_id`、`kind`、`content_type`、`size_bytes`、`sha256`、`save_status`、`recognition_status`、`link_status` 和 `version`。当前持久化层还会返回 `original_filename`、上传进度、`attempts`、当前 `recognition` 和 `event_link`；实现还保留了兼容别名 `upload_status`，前端应以 `save_status` 为准。状态集合为：

```text
save_status:        uploading | saved | failed
recognition_status: not_started | processing | succeeded | failed | interrupted
link_status:        not_linked | pending | linked | link_failed
```

`media.local_safety` 是媒体顶层的已持久化危险扫描结果，扫描前可以为 null；识别尝试里可能含兼容副本。识别状态已经 `succeeded` 时，安全扫描和 Event 关联仍可能在继续；此时 `link_pending_reason` 为 `safety_scan_pending` 或 `event_link_pending`，前端应继续轮询到 `linked`，或明确显示仍待处理。`raw_text_too_long`、`event_validation_failed` 等原因表示需要处理后才能关联，不得将有文字等同于已有记录。类型声明与实现保留这些可选字段。

### 查询媒体与读取原件

- `GET /api/media` 返回 `200 {ok:true,media:[...]}`。
- `GET /api/media/{media_id}` 返回 `200 {ok:true,media}`，是识别轮询入口；识别尝试列表位于 `media.attempts`，详情可包含完整机器初稿，列表不返回完整文字。
- `GET /api/media/{media_id}/original` 必须带 `X-Session-Token`，返回原件字节和媒体 `Content-Type`，并声明 `Accept-Ranges: bytes`。

原件读取支持单个 `Range: bytes=start-end`、`bytes=start-` 或 `bytes=-length`；成功为 `206` 并带 `Content-Range`，非法范围为 `416 invalid_range`。token 不得放进 URL。HTTP 专项测试覆盖了按 ID 读取和路径穿越拒绝，但真实浏览器 Blob 播放、手机媒体格式、超大原件的内存表现和磁盘完整性故障仍未验收。

### `POST /api/media/{media_id}/recognize` 启动识别

请求为：

```json
{"expected_version":1,"actor_name":"老人"}
```

`actor_name` 可选，省略时后端使用“本地用户”。新识别任务入口返回 `202 {ok:true,accepted:true,attempt_id,media}`；同一请求重放、已有处理中任务仍返回 `202` 和同一 `attempt_id`；已有成功结果的重放返回 `200`，不重新识别。`202` 只表示任务已经接受或处于处理中，**不表示识别成功**。前端随后轮询媒体详情的 `recognition_status`，不能等待这个 POST 返回识别全文。

识别结果若含 `recognition.is_mock:true`，页面必须明确写“离线 Mock 演示模式”，不能冒充真实 ASR/OCR。Mock 不证明音频或图片内容被真实识别。合成 WAV/PNG 的一次真实服务链路通过也不能替代浏览器 WebM、手机、真实患者或通用准确率验收；任何识别失败都必须保留可读取原件。`POST /api/media/{media_id}/link` 可复用已经保存的成功初稿恢复 Event 关联，不会再次调用识别服务。

### `POST /api/media/{media_id}/link` 恢复 Event 关联

当前请求必须带正整数 `expected_version`，也可带可选的 `actor_name`：

```json
{"actor_name":"老人","expected_version":6}
```

请求必须带新的 `Idempotency-Key`；版本过期返回 `409 stale_version`。该接口只复用已持久化的成功初稿，不再次调用识别；首次创建 Event 返回 `201`，已有链接或重复恢复返回 `200`。识别未成功、危险扫描未完成或全文超过 10000 字符时不会创建空 Event，并保留媒体和可恢复状态。

媒体常见错误为 `{ok:false,error:"稳定错误码"}`，包括 `media_limits_not_configured`、`request_too_large`、`unsupported_format`、`media_not_found`、`upload_not_found`、`upload_incomplete`、`idempotency_key_payload_mismatch`、`stale_version`、`provider_not_configured`、`provider_timeout`、`invalid_range`、`media_backend_unavailable` 和 `media_request_failed`。不要向用户展示路径、供应商原始正文或内部异常。

## 状态和常见错误

| 状态 | 含义 | 可继续动作 |
|---|---|---|
| inbox | 原话已保存 | 整理、修订、查历史、生成材料 |
| draft | 已有草稿，未核对 | 核对、退回、重新整理、修订 |
| recorded | 已核对记录准确 | 查历史、退回、修订、生成材料 |
| needs_review | 已退回待整理 | 重新整理、修订 |
| superseded | 已被新记录替代 | 查看旧原文和历史 |

所有状态都不是医学安全等级。200/201 为成功；400 为字段或请求格式错误；403 为本地 token/Origin 错误；404 为记录不存在；409 为版本、状态或幂等键冲突；422 为整理失败；500 为未预期的服务端错误。一般错误格式 `{ok:false,error:"错误码"}`。未预期异常只返回 `internal_server_error`，不会向客户端暴露数据库路径、供应商正文或内部异常信息。数据库本身无法保存时，不能显示“已保存”。

浏览器不使用开发代理而直接跨域访问时，后端 `.env` 的 `ALLOWED_ORIGIN` 必须与页面 Origin 完全一致。预检支持 `GET, POST, OPTIONS`，并允许 `Content-Type`、`Idempotency-Key`、`X-Session-Token`、原件读取使用的 `Range` 和兼容账号接口使用的 `X-Auth-Token`。不匹配的 Origin 不会获得跨域许可，写请求返回 403。

## 前端必须怎么处理

- 保存接口成功后立刻展示已保存；危险输入把 `danger_reminder` 放在页面顶部，不能藏在折叠菜单。
- 422 不是“没有记录”。展示“原文已保存，AI 整理失败”，保留原话和重试按钮；不要显示空白卡片或“整理成功”。
- `danger_detected=false` 只表示本地规则没命中，文案不得写“无危险”“正常”。
- `local_safety` 与 AI 草稿的升级字段都要看；本地未命中不能抵消草稿中已有的 `urgent/emergency`。本地命中也不能被 AI 漏标或“核对准确”抵消。
- `review_role=emergency_services` 时只显示联系当地急救服务/专业人员的固定提醒，不显示疾病名、剂量或家庭处置建议。
- 版本冲突 `409` 时重新 GET 详情，让用户选择重载或修订，不能覆盖别人新版本。

完整 TypeScript 类型在 `contracts/api.ts`。Schema 只约束 AI 草稿；`local_safety` 是后端外层安全字段。
