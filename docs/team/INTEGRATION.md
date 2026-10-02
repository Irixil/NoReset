# 两人开发、提交与整合

## 获取仓库与开始开发

需要 Python 3.12、Git、Codex，以及仓库写权限或自己的 fork。GitHub 登录在本人电脑完成，不把 token 发给别人或提交仓库。

有原仓库写权限的同学使用下面的命令。

```bash
git clone https://github.com/Irixil/NoReset.git
cd NoReset
git status --short --branch
```

让 Codex 读取 [团队入口](README.md)，说明自己负责 A 或 B。确认当前路线后，从最新 main 创建本人分支。

任务 A：

```bash
git switch main
git pull --ff-only origin main
git switch -c feat/media-storage-api
```

任务 B：

```bash
git switch main
git pull --ff-only origin main
git switch -c feat/media-recognition
```

已有分支先核对再切换；有未提交改动先保存，不执行丢弃／强制切换。没有仓库写权限则使用 fork 和 PR，或请负责人添加协作者。ZIP 可以阅读，但后续仍建议重新 Git 克隆，不把旧目录整包覆盖到新仓库。

使用 fork 的同学先在 GitHub 创建自己的 fork，克隆自己的 URL，`origin` 应指向自己的仓库；然后添加原仓库并同步：

```bash
# 首次 git clone 使用自己 fork 页面的地址，不使用上面原仓库地址
git remote add upstream https://github.com/Irixil/NoReset.git
git fetch upstream
git switch main
git merge --ff-only upstream/main
```

再从这个 main 创建 A 或 B 分支，后续仍推 `origin`，PR 的目标选择 `Irixil/NoReset` 的 main。下文同步代码时，fork 用户将 `origin/main` 换为 `upstream/main` 并先 `git fetch upstream`。若已误克隆原仓库，先检查 `git remote -v`，让 Codex 协助调整远端，不要尝试向无权限的地址强推。

环境安装及启动见 [根 README](../../README.md)。首先运行现有测试确认本机基线；失败先报告和定位。模型缓存、依赖及运行数据都留在被忽略的本地目录。

## 拆小提交，先对齐合同

| 顺序 | 提交内容 | 谁接着用 |
|---|---|---|
| 1 | A 的接口合同 PR，经 B／前端核对；必要的依赖配置及明确标记的测试替身 | 两人从同一合同继续，不等页面完成 |
| 2 | A 的原件保存／状态／恢复底座，可使用测试替身验证 | B 可把真实结果接入；前端可开始媒体状态接线 |
| 3 | B 的真实 ASR/OCR 模块及成功／失败证据 | A 完成 HTTP 到识别模块的调用与原子关联 |
| 4 | A 的接线与联合验收 PR，前端集成提交 | 项目负责人在同一版本跑整套演示 |

第 2、3 步开发可并行；合并顺序由依赖决定。B 若先合并，模块必须可独立导入，不能破坏默认 Mock 文本服务；A 若先合并，真实识别未接时必须明确未配置或 Mock，不能冒充完成。依赖、配置与调用方必须在 main 上相容，避免合入一个无法启动的中间状态。

## 完成一块以后怎么交

先让 Codex 查看实际变更和敏感内容，明确哪些文件属于自己。只 stage 审阅过的具体文件，不使用整包上传或无检查的 `git add .`。

```bash
git status --short
git diff --check
git diff
# git add 后面填写本人已审阅的具体文件路径
git diff --cached --stat
git diff --cached
git commit -m "完成本人负责的媒体功能和验证"
```

任务 A 推送：

```bash
git push -u origin feat/media-storage-api
```

任务 B 推送：

```bash
git push -u origin feat/media-recognition
```

在 GitHub 点击 “Compare & pull request”，目标分支选 main，填写仓库 PR 模板。可以先开 Draft PR 暴露合同和依赖；达到验收再改成可审阅。Codex 可协助提交和 PR，但开工授权不自动等于任意付费、上传真实医疗资料或部署授权。

每份 PR 都带 `HANDOFF-A.md` 或 `HANDOFF-B.md`，写明基线、运行方式、实际支持范围、测试结果与证据、未完成事项、依赖 PR 和谁来接。尚无真实服务证据写“未验证”，不要勾通过。

## 合并新 main，保留另一人的成果

在自己的分支、工作区干净时：

```bash
git fetch origin
git merge origin/main
```

逐个理解冲突，结合另一份任务的合同和实现解决。不要使用 `reset --hard`、强制推送或整文件选“我的／对方的”快速消除红字。无法判断时保留工作并找对应负责人。完成冲突处理后重跑受影响测试及关键文本路径，再推同一分支。

`.dz/state.json`、`.dz/journal.jsonl` 和生成视图的冲突由集成人处理：先保留两份历史作为参考，确定 main 为共同基线，按实际分支记录用 DZ 状态工具逐条记录有效变更，再生成视图并 check。不能把 JSONL 直接拼接或把一个分支的历史伪装成两个都记录了；分支中的产出和证据仍按其真实提交归属保留。

## 合并前检查

由每位作者运行与本次改动相关的检查。媒体涉及共同合同和持久化，最终整合版本至少完整运行：

```bash
python -m pytest -q
python -m backend.evaluate_mock
python -m scripts.demo --out runtime/demo-result.json
```

现有 GitHub Actions 会跑这些命令，但它不会自动拥有识别密钥、真实样例或手机；CI 绿灯不能替代真实服务和手机验收。新增必须依赖真实服务的检查应单独明确运行，默认测试不能偷偷联网付费。

手机联调由项目负责人／集成人准备受控的访问方式、HTTPS／安全上下文和测试设备，A 配合服务可达性与同源／会话规则，B 提供编码支持范围，前端负责麦克风／相机权限与录音操作。电脑上的 `127.0.0.1` 只指向电脑本机，不能靠上面的本地启动步骤完成手机验收；也不能为方便联调直接把现有接口公开到公网。

| 联合验收 | 通过时必须看到 |
|---|---|
| 真实录音、清楚照片 | 原件先保存，真实服务文字可核对，来源和 Mock 标识正确 |
| 提醒后暂停、再接着说 | 真机验证小声／停顿／电视噪声；最终录音前后内容仍在。阈值与方法确认后再验，不恢复 60 秒限制 |
| 识别超时或失败 | 刷新仍能找到并播放原件，原因清楚，可重试，无 Event 的媒体也可找回 |
| 丢响应、重复／并发请求 | 上传不重复、识别任务不重复占用、Event 不重复；同键变内容与版本冲突正确返回 409 |
| 重启 | 原件、机器初稿、状态、关联仍在；中断任务可重试，无永久 processing |
| 人工改错 | 原件和机器初稿仍可查，已命中提醒不会因核对消失，迟到识别不覆盖修改 |
| 后续整理 422 | 原件、文字和已有危险提醒仍保留；界面未声称整理成功 |
| 就诊材料 | 来源与待核对状态清楚，失败媒体未被静默遗漏，旧快照不被后续修订改变 |
| 备份恢复 | 空目录恢复后文字、原件、状态、来源链接可用，校验和相符 |
| 现有文本流程 | 保存、整理、核对、修订、历史、幂等、409、422 和危险提醒没有回归 |

集成人在同一个明确提交上记录命令、日期、环境、模型、样例授权与结果，更新 `docs/VALIDATION.md` 并链接两人的证据。未通过项目保持可见；项目负责人决定演示范围，不能删除验收项来声称完成。

## 合并与回退

有写权限的项目负责人／指定集成人负责合并，不让两人同时抢着改 main。普通功能 PR 建议 squash 合并，使一个可审阅功能对应一个提交；相关依赖 PR 先合。任何保护规则、必需检查与审阅都照仓库实际设置执行，不绕过。

合并后两人各自在干净工作区拉取最新 main，在同一版本重新启动。若需要撤回有问题的功能，优先 revert 明确提交，数据库有变化时先检查恢复方案和备份；不要强制重写远端历史。恢复旧代码不代表已自动撤销数据库变化。
