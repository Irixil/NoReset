# 拿到 Demo 后如何在线自测

2026-10-01 更新：图片现在必须在详情中“对照照片原件”，修订错误、将看不清处标为 `[无法辨认]`，勾选后“保存原件核对结果”，才能执行整理与确认。HTTP 自测只验证未核对图片被拦截并作为待核对附件保留，不冒充人工完成原件核对；`passed/online_passed` 也不表示整页 OCR 准确或图片人工验收完成。通用文档评测若缺少显式来源核对数据会被拒绝，不自动给公开病例补核对声明。以下旧 Demo 命令适用服务端兼容模式；当前内测入口应按 README 使用 `scripts.start_app` 的本机加密模式。

当前后端媒体候选在 `codex/backend-integration-2026-09-14`；main 合并前，请克隆该分支。此指南的命令会访问你配置的真实供应商，产生请求用量。测试数据明确为合成资料，测试记录会留在本地数据库中。

## 1. 安装并填配置

需要 Python 3.12 和 Git。无需前端构建工具。安装项目依赖后，系统没有 FFmpeg 时会使用固定版本的项目备用二进制，供浏览器 WebM 录音转换。

```bash
git clone --branch codex/backend-integration-2026-09-14 https://github.com/Irixil/NoReset.git
cd NoReset
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
cp .env.example .env
```

Windows PowerShell 用 `py -3.12 -m venv .venv` 和 `.venv\Scripts\Activate.ps1`，复制文件用 `Copy-Item .env.example .env`。已有系统 `ffmpeg` 时项目会优先使用；否则使用 `imageio-ffmpeg==0.6.0` 携带的可执行文件。

在本地 `.env` 填三项服务的配置。密钥由运行 Demo 的人自行提供，GitHub 只包含示例字段；不要把一个站点的密钥填给另一个站点。当前最低成本的媒体方案是一把 AIHubMix Key 同时供语音和图片使用。

| 能力 | 需要填写 |
|---|---|
| 文字整理 | `MODELSCOPE_ACCESS_TOKEN`；确认 `MODELSCOPE_MODEL` 是该账号可用的模型 ID |
| 语音转写和照片识字 | `MEDIA_RECOGNITION_PROVIDER=aihubmix`、`AIHUBMIX_API_KEY`；默认分别使用 `gemini-2.5-flash-lite` 和 `qwen3.7-plus` |

AIHubMix ASR 使用 Gemini 原生 `generateContent` 接口的内联音频；支持浏览器录制的 WebM 和项目合成 WAV，单文件上限 20MB。原件不会被覆盖，仅把机器转写作为待核对初稿，再执行危险扫描和记录关联。此版本是结束录音后转写，没有实现边说边显示字幕，也没有改 P2 VAD。原 DashScope WebSocket 与通用 OpenAI-compatible 配置仍保留为备选，详见 [模型接入说明](MODEL-CONNECTION.md)。

```bash
python -m scripts.start_demo --check-config
python -m scripts.start_demo
```

第一条仅检查字段与依赖，没有调用真实 API；配置检查通过不等于接口能用。第二条通过检查后才启动。统一打开 **http://localhost:18768/**，前端和后端同源。不再需要另开 5173；只有前端开发时才需要另设 `ALLOWED_ORIGIN=http://localhost:5173`。修改 `.env` 后重启服务，已有 shell 同名变量优先。

数据库与原件默认在 `runtime/records.sqlite3` 和 `runtime/media`。不要删除 runtime 来“修复”失败；重启不会主动清空已保存数据。

## 2. 运行真实 HTTP 自测

保持服务运行，在第二个已激活虚拟环境的终端执行：

```bash
python -m scripts.selftest --audio data/synthetic/selftest/voice.wav --audio-expect 胸口疼 --audio-expect 喘不上气 --image data/synthetic/selftest/card.png --image-expect 胸口疼 --image-expect 喘不上气 --out runtime/selftest-online-1.json
```

依次重复并将输出改为 `selftest-online-2.json`、`selftest-online-3.json`。每轮必须退出码 0 且报告同时为 `passed: true`、`online_passed: true`。不把分次重试中的成功拼成“同一轮通过”。失败报告保留 HTTP 状态、失败检查、供应商元数据、记录 ID、文件哈希与耗时，不输出密钥。

检查顺序包含文字保存、相同幂等键重放、不同内容同键 409、整理、核对、历史、修订、旧原文、危险提醒、交接快照；音频和图片各自上传、分片、完成重放、原件字节比对、识别、预期关键词、关联记录及交接附件。识别失败仍检查原件是否可读。默认拒绝 Mock，缺素材、关键词不符和超时均失败。

素材说明见 [合成素材](../data/synthetic/selftest/README.md)。可换成自己有权使用且无个人信息的素材，同时更新 `--audio-expect` 与 `--image-expect`；关键词匹配只检验该样本，不代表通用准确率。

## 3. 浏览器逐按钮验收（每轮都完整执行）

HTTP 自测不会点击浏览器按钮，不能替代这一节。每一步必须看见上一步结果才继续，在每轮记录表中保存对应记录 ID、媒体 ID、结果或失败截图。

1. 首页点“说给我听”，点“开始说”，读合成音频文字前半段；再点正在录音的主按钮暂停，观察时间至少五秒保持不变。点“继续说”，读后半段，暂停后点“说完了”。应进入资料页，先显示原件保存，再显示转写文字，核对前后两段都在。
2. 点击该录音“查看原件”，播放并听到完整两段；点击“查看识别文字”和“核对识别记录”。识别成功后应能进入关联记录，危险提醒保留。
3. 点“整理记录”，等待成功草稿，逐字检查原文；点“我核对过了”，看到已核对状态。点“查看历史”，检查保存、整理、核对版本。
4. 点“修订记录”，填写更正及原因，点“保存修订”；点“查看历史”，再点“查看修订前原文”，核对旧原文未改写、历史危险提醒没有消失。
5. 回到记录页，点“生成就诊交接材料”，核对该条记录、媒体和待处理状态；点击“打印”确认浏览器打印预览可用。
6. 首页点“拍下来”，选择合成 `card.png`，点“上传保存原件”；资料页点击“查看原件”，再点“识别 / 重试”，核对文字，点“核对识别记录”，再走完整第 3–5 步。
7. 资料页使用“上传已有录音”选择 `voice.wav`，点击识别并核对。相同文件再次上传应复用媒体 ID。文字补充连续点击保存，只出现一条新增记录。
8. 刷新页面，读取上述记录和原件；终端 Ctrl-C 停止再启动服务，在页面点刷新，确认同一 ID 仍可查询。

还需单独保存失败演练：让真实 AI 请求失败，确认已保存原文、原件及危险提醒仍能查询，页面明确说明失败，可重试，不出现虚假成功草稿。不能通过删除安全校验让真实接口测试变绿。

已知录音边界：原有“静音”回调只是固定 12 秒计时，不检测实际静音，也未满足“先提醒、无回应再暂停”完整策略。本次只修复暂停计时、续录、结束保存和失败重试，不声称这项已验收。

## 离线回归的明确入口

只有检查软件接线时才使用：

```bash
python -m scripts.start_demo --offline
python -m scripts.selftest --allow-mock --audio data/synthetic/selftest/voice.wav --image data/synthetic/selftest/card.png --out runtime/selftest-offline.json
```

离线结果的 `online_passed` 永远为 false。`python -m pytest -q`、`python -m backend.evaluate_mock`、`python -m scripts.demo` 同样不能证明当前真实服务已接通。

## ASR 官方协议来源

- [模型与音频规格](https://help.aliyun.com/zh/model-studio/asr-model)
- [WebSocket 接入流程和域名](https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api)
- [客户端 run-task / finish-task 事件](https://help.aliyun.com/zh/model-studio/fun-asr-client-events)
- [服务端最终句和任务状态事件](https://help.aliyun.com/zh/model-studio/fun-asr-server-events)
- [AIHubMix Gemini 多媒体指南](https://docs.aihubmix.com/cn/api/Gemini-Guides)
- [Gemini 2.5 Flash Lite 模型页与价格](https://aihubmix.com/model/gemini-2.5-flash-lite)
- [AIHubMix 图像理解](https://docs.aihubmix.com/cn/api/vision)

核对日期：2026-09-16。必须匹配账号的模型权限；官方协议核对与替身测试不代替真实 Key 的请求验收。当前仅完成一次合成 WAV 真实转写，不能代替本文第 2–3 节的完整三轮和浏览器验收。
