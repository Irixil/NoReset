# 证据记录模板

一份证据只证明它声明的范围。测试通过、Mock 输出和历史文件不能自动证明真实模型、前端、手机或临床效果。

```yaml
evidence_id: E-YYYYMMDD-###
claim: "具体要证明的行为"
scope: "T0/T1/T2/T3/T4/T5/T6"
status: "通过 | 失败 | 阻塞 | 待确认"
baseline:
  repository: "NoReset"
  branch: "main"
  commit: "完整 commit"
  working_tree: "clean | has-untracked | has-changes"
environment:
  os: ""
  python: ""
  dependency_source: "requirements.txt / requirements-dev.txt / other"
  service_scope: "localhost only | other (explain)"
provider:
  kind: "mock | real | not_applicable"
  name: ""
  model: ""
  credentials_read: false
input:
  case_ids: []
  fixture_paths: []
  fixture_sha256: []
  private_medical_data: false
execution:
  started_at: "ISO 8601"
  finished_at: "ISO 8601"
  commands:
    - command: ""
      exit_code: 0
      result_summary: ""
artifacts:
  - path: "相对仓库路径或脱敏临时产物"
    sha256: ""
    description: ""
observations:
  expected: ""
  actual: ""
  retained_raw_or_original: "yes | no | not_applicable"
  source_and_time_preserved: "yes | no | not_applicable"
  danger_notice_persisted: "yes | no | not_applicable"
limitations:
  - ""
review:
  reviewer: ""
  reviewed_at: "ISO 8601"
  follow_up: ""
```

## 最低审阅要求

1. 记录完整提交号、运行环境和命令退出码。
2. 用 `case_id`、夹具校验和或明确的合成数据版本绑定输入。
3. 将预期与实际分开写；`danger_detected=false` 只能表示规则未命中，不能写成“无危险”。
4. 证据路径不得指向 token、`.env`、数据库、私人录音/照片或依赖缓存。
5. `mock` 与 `real` 必须显式区分；未配置服务写 `not_applicable` 或 `blocked`。
6. 失败、缺依赖、未实现和待负责人决定分别记录，不用一个“未通过”掩盖原因。
