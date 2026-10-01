# 模型与 OpenAI 兼容中转站接入

适配范围为 **OpenAI Chat Completions 非流式 JSON**：服务接受 `POST /chat/completions`、Bearer 密钥、`model` 和 `messages`，并返回 `choices[0].message.content`。支持魔搭、DeepSeek 和兼容中转站；Responses、Anthropic 等专有协议需另加适配，不声称所有站点无差别可用。

将 `.env.example` 复制为本地 `.env` 并填写，启动使用 `python -m backend.run_local`。密钥不能放前端或提交 Git，运行日志及报告不会回显密钥。更换供应商时同时更换 URL、模型名和对应密钥，不能把魔搭密钥填到别的站点。

## AIHubMix：一把 Key 补齐语音和图片（当前低成本推荐）

文字整理继续使用已经完成真实联调的 DeepSeek，本轮不切换。语音转写和照片识字共用一把 AIHubMix Key，只需在本地 `.env` 增加：

```dotenv
MEDIA_RECOGNITION_PROVIDER=aihubmix
AIHUBMIX_API_KEY=填自己的密钥
MEDIA_RECOGNITION_TIMEOUT_SECONDS=60
```

程序会固定使用 AIHubMix 官方 HTTPS 地址，不读取自定义媒体 URL，避免把 Key 误发给其他站点。默认模型如下：

| 能力 | 默认模型 | 当前选择原因 |
|---|---|---|
| 中文语音转写 | `gemini-2.5-flash-lite` | 当前 Key 已开放、可直接理解音频，且比当前账号不可用的 Whisper 通道更便宜 |
| 照片识字 | `qwen3.7-plus` | 真实脱敏单据回归候选；高细节图片、逐行转录、1024思考预算，仍需人工对照原件 |

语音使用 AIHubMix 的 Gemini 原生 HTTPS `generateContent` 接口，在 `inlineData` 中携带原音频，输出只接受转写文字。系统指令把音频明确视为不可信的待转写材料，不执行音频内的指令，也不补写、总结或给医疗建议。AIHubMix 文档的内联多媒体上限为 20MB；应用会在超限时本地拒绝，不产生无效请求。

当前标价为音频输入 `$0.3/百万 token`；按 Gemini 静态音频每秒 32 token 估算，纯音频输入约 `$0.035/小时`，实际账单还包含提示和输出文字。2026-09-16 的 6.892 秒合成 WAV 实测扣费 `$0.000080`。价格和可用性会变化，上线前查 [AIHubMix 模型页](https://aihubmix.com/model/gemini-2.5-flash-lite) 和 Key 的 `/v1/models` 列表。公开模型广场有 Whisper 不代表当前账号已获得该通道。

如需试其他模型，只覆盖 `MEDIA_ASR_MODEL` 或 `MEDIA_OCR_MODEL`，不必重复 Key。ASR 覆盖必须是该 Key 已开放且能接收音频的 Gemini 模型；不对未开通模型自动重试或切换。真实请求结果见 [2026-09-16 合成语音报告](evidence/real-aihubmix-gemini-audio-2026-09-16.md)。

这条接入只用于普通单据、处方、检查单上的可见文字和普通语音转写。心电图、CT/MRI、超声、病理等复杂医学影像仍只保留原件，不能作为 OCR 成功或诊断结论。

## 魔搭配置

令牌管理页 `https://www.modelscope.cn/my/settings/token` 用于获取密钥，不能作为模型 API 地址。官方推理入口为 `https://api-inference.modelscope.cn/v1`；模型必须使用该账号有权限的 ModelScope Model ID。

```dotenv
MODEL_PROVIDER=modelscope
MODELSCOPE_BASE_URL=https://api-inference.modelscope.cn/v1
MODELSCOPE_ACCESS_TOKEN=填自己的令牌
MODELSCOPE_MODEL=deepseek-ai/DeepSeek-V4-Pro-0813
MODEL_TIMEOUT_SECONDS=60
MODEL_MAX_TOKENS=4096
LLM_JSON_MODE=false
LLM_EXTRA_BODY_JSON={}
```

模型名按用户最新选择设为 `deepseek-ai/DeepSeek-V4-Pro-0813`。2026-09-12 已核对官方页面的 API-Inference 面板，按其确切 ID 取得真实输出；现有非流式接口无需修改即可调用。首次项目单条通过 13 项自动断言，耗时约 41.9 秒，完整批次结果见联调报告。当前保留默认推理设置，不附加旧 Qwen 的 `enable_thinking` 参数。模型提供方仍为魔搭，不要把 `MODEL_PROVIDER` 改成 `deepseek`，否则将调用 DeepSeek 官方服务。更改 `.env` 后需重新启动服务；shell 中同名环境变量优先于 `.env`。

**历史错误**：此前 401 的原因为 `Please bind your Alibaba Cloud account before use.`，用户绑定后消失；随后 V4.1-Flash 返回 `has no provider supported`。这两次错误不代表当前 V4-Pro-0813 状态。账号要求参考 [官方绑定教程](https://www.modelscope.cn/docs/accounts/aliyun-binding-and-authorization)。代码对已知绑定错误返回固定中文提示 `model_account_binding_required`，不回显原始服务端正文。

真实调用使用本地令牌，已更新本地所选模型配置；仓库示例仍默认 Mock。连接成功不代表复杂语义和临床安全验收完成；机器辅助核对也不代替真实用户或医生试用。

## 兼容中转站配置

```dotenv
MODEL_PROVIDER=openai_compatible
LLM_BASE_URL=https://你的中转站/v1
LLM_API_KEY=该中转站的密钥
LLM_MODEL=该站点提供的模型名
MODEL_TIMEOUT_SECONDS=60
MODEL_MAX_TOKENS=4096
LLM_JSON_MODE=false
LLM_EXTRA_BODY_JSON={}
```

`LLM_BASE_URL` 保留站点要求的版本和路径，也接受完整 `/chat/completions` 地址，不会重复附加。外部服务必须 HTTPS，本机测试可 HTTP。拒绝 URL 内的账号、密码、query 和 fragment；不跟随 HTTP 重定向，避免原文与密钥被送到另一个地址。

`LLM_JSON_MODE=true` 会附加 `response_format={"type":"json_object"}`，仅在服务支持时开启。`LLM_EXTRA_BODY_JSON` 是附加请求参数，可用于 `enable_thinking` 等提供方参数，不能覆盖 model、messages、stream、token 上限或工具调用等核心字段。输出仍执行同一套来源、安全和完整原文校验。

旧 `MODEL_PROVIDER=deepseek` 与 `DEEPSEEK_*` 配置继续有效，默认请求 JSON 模式；Mock 仍可显式选择作离线演示。

## 验证命令

```bash
# 先发一条合成输入确认配置
python -m backend.evaluate_real --dataset data/synthetic/c-model-smoke.json --limit 1 --out runtime/evaluations/connection.json
# 全部 11 条合成输入，包含数字、否定、来源和冲突对抗
python -m backend.evaluate_real --dataset data/synthetic/c-model-smoke.json --out runtime/evaluations/c-real.json
# 1 位公开病例的 3 段许可改编摘要
python -m backend.evaluate_real --dataset data/public_cases/cases.json --out runtime/evaluations/public-real.json
```

旧命令 `python -m backend.evaluate_modelscope` 保留兼容，参数相同。报告保存通过应用校验的完整输出供核查，并区分自动断言和人工待复核；`--limit` 明确记录实际执行与跳过数量，不能当作整个数据集通过。

严格解析拒绝重复 JSON 字段、空内容、截断（finish_reason=length）、工具调用、超大响应、非法 JSON 与非成功 HTTP 状态；不会自动修补成成功输出。接口调用失败时，后端已保存原文与危险提醒的行为不变。

HTTP 200 也不自动视为成功：顶层包含非空 error、消息显式为非 assistant 角色时拒绝。为兼容部分中转站，允许省略 role，但完整内容仍经过应用 Schema、来源和安全校验。通用 provider 无默认站点，漏填 URL 立即失败，不把其他站点密钥发给魔搭。

官方参考（2026-09-12 核对）：[API 推理介绍](https://www.modelscope.cn/docs/model-service/API-Inference/intro)、[当前选择 DeepSeek-V4-Pro-0813](https://www.modelscope.cn/models/deepseek-ai/DeepSeek-V4-Pro-0813)。先前 Qwen、V4.1-Flash 联调历史和当前切换证据见 [模型联调报告](MODEL-INTEGRATION.md)。
