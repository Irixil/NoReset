---
name: "病历不归零·内测版"
description: "面向老年使用者，以耐心对话、清晰状态和可追溯报告承接每一次不舒服。"
colors:
  ink: "#202442"
  muted: "#5d637b"
  primary: "#5857d9"
  primary-dark: "#4442bb"
  primary-soft: "#e9e9ff"
  warm: "#c66f42"
  warm-soft: "#fff0e5"
  surface: "#ffffff"
  surface-soft: "#f7f8ff"
  report-surface: "#f8f8fd"
  canvas: "#f3f5ff"
  line: "#dfe3f2"
  control-line: "#cfd2eb"
  success: "#277b57"
  danger: "#a94830"
  danger-soft: "#fff0ea"
  focus: "#302b9d"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "clamp(32px, 9vw, 40px)"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "31px"
    fontWeight: 700
    lineHeight: 1.2
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "21px"
    fontWeight: 700
    lineHeight: 1.35
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.62
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.45
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  compact: "9px"
  sm: "10px"
  md: "12px"
  control: "14px"
  report: "15px"
  card: "16px"
  chat: "17px"
  sheet: "24px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  compact: "10px"
  md: "12px"
  field: "14px"
  lg: "16px"
  xl: "20px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
    height: "54px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary-dark}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    height: "48px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "10px 11px"
    height: "48px"
  action-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "16px"
    height: "88px"
  chat-assistant:
    backgroundColor: "rgba(255, 255, 255, 0.94)"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.chat}"
    padding: "15px 16px"
  chat-user:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.chat}"
    padding: "15px 16px"
  report-section:
    backgroundColor: "{colors.report-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.report}"
    padding: "15px 16px"
  modal-sheet:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
    padding: "22px"
    width: "720px"
---

# Design System: 病历不归零·内测版

## Overview

**Creative North Star: “耐心陪诊本”**

界面应像一本有人耐心陪着填写的就诊笔记：清楚、温和、可信，但不冒充医生。老人首先看到自然语言和明确动作，而不是字段、工作流或医疗后台术语。视觉密度偏低，字号偏大，信息通过卡片、对话和短句逐层展开。

主色负责确认当前位置和主要动作，暖色只承担提醒、资料与安全边界。白色和极浅靛蓝表面构成主要阅读环境，轻微阴影帮助老人分清可操作区域。品牌吉祥物只出现在品牌、助手头像和继续对话选择等陪伴性位置，不替代按钮标签或状态文字。

设计记录的是沟通材料，而不是诊断结论。每个报告、整理结果和核对动作都要保留“自动整理”“本人未核对”“用于沟通，不是诊断”等可见边界，并允许回到老人原话。

**Key Characteristics:**

- 老人友好的大字号、高行高、低密度和直接动词。
- 手机优先，桌面端仍保持适合阅读与触控的单任务体验。
- 助手在左、老人回答在右的连续对话模式。
- 主色靛蓝负责行动与方向，暖橙负责提醒和非主要资料入口。
- 报告分区、原话可展开、整理状态可见，不把推断伪装成事实。
- 状态不仅靠颜色，还必须有文字、图标、位置或边框等第二条线索。

## Colors

颜色以柔和靛蓝建立安心与连续性，以克制暖橙补充人情味和安全提示；整体保持低刺激、高可读。

### Primary

- **陪伴靛蓝** (`colors.primary`)：主要按钮、语音入口、麦克风和强调文字。
- **深靛蓝** (`colors.primary-dark`)：链接、当前导航、报告分区标题和高对比次级动作。
- **雾紫底色** (`colors.primary-soft`)：老人对话气泡、标签和轻量选中区域，不能单独表示状态。

### Secondary

- **暖陶橙** (`colors.warm`)：拍照资料入口和少量辅助图标。
- **暖纸底色** (`colors.warm-soft`)：安全说明、安静提示、资料卡和温和警示区。

### Tertiary

- **确认绿** (`colors.success`)：保存成功、连接成功等已完成状态，必须同时显示说明文字。
- **克制砖红** (`colors.danger`) 与 **浅砖红底** (`colors.danger-soft`)：失败、需要关注和录音中状态；避免大面积使用，也不借此暗示诊断等级。
- **聚焦深紫** (`colors.focus`)：键盘聚焦环，保证在浅色表面上清晰可见。

### Neutral

- **深墨蓝** (`colors.ink`)：正文和主标题，比纯黑更柔和。
- **灰紫文字** (`colors.muted`)：说明、来源、时间和次级状态；不用于关键动作。
- **白色表面** (`colors.surface`)：卡片、按钮、对话气泡和弹层。
- **淡紫表面** (`colors.surface-soft`) 与 **报告浅面** (`colors.report-surface`)：输入区、原话框、报告分区和低层级容器。
- **雾蓝画布** (`colors.canvas`)：全局冷色背景基底。
- **柔和分隔线** (`colors.line`) 与 **控件边线** (`colors.control-line`)：内容分区和输入边框，只用于帮助辨认结构。

### Named Rules

**The One Primary Voice Rule.** 同一屏只有一个最明确的主动作使用实心靛蓝；其余动作降为描边、文字或卡片入口。

**The Color Is Never the Message Rule.** 成功、失败、待核对和风险提醒必须配有可读文字，不能只改颜色。

## Typography

**Display Font:** 系统中文无衬线字体栈（优先设备原生字体）  
**Body Font:** 与标题相同的系统中文无衬线字体栈  
**Label Font:** 与正文相同，通过字重而不是换字体区分

**Character:** 字体选择追求熟悉、稳定和无需加载。标题有适度紧凑感，正文保持宽松行距，避免医疗后台式的小字高密度。

### Hierarchy

- **Display** (`typography.display`)：首页问候和主要页面标题；一屏通常只出现一次。
- **Headline** (`typography.headline`)：记录、资料和设置等页面级标题。
- **Title** (`typography.title`)：对话顶部、卡片标题和报告小节标题。
- **Body** (`typography.body`)：老人原话、助手提问、报告正文和主要说明。对话气泡最大宽度约为 34 个全角字符的阅读尺度。
- **Label** (`typography.label`)：按钮、字段标签和可操作链接。依靠较高字重清晰表达动作。
- **Meta** (`typography.meta`)：来源、时间、版本和状态补充；不能承载唯一的安全信息。

### Named Rules

**The Read It Once Rule.** 重要句子优先用短句、常用词和正常大小写；不要通过全大写、缩小字号或长段落压缩空间。

**The Elder Baseline Rule.** 常规正文以 18px 为基准，关键操作和对话不得退回 14px 的后台密度；14px 只用于可省略的元信息。

## Layout

系统采用手机优先的纵向单任务布局。常规页面使用 20px 水平留白，顶部栏最小高度 70px，底部三栏导航固定为 78px；页面底部必须为导航和设备安全区预留空间。首页和资料页以单列卡片为主，筛选、日期和设置字段在空间允许时使用两列。

对话页进入沉浸模式后隐藏全局顶部栏和底部导航，占满动态视口。消息流最大宽度 760px，输入区最大宽度 820px；消息区独立滚动，输入区固定在底部，并尊重设备底部安全区。报告弹层在桌面端最大宽度 720px，以标签列和原话列形成清晰交接单；手机端回到单列底部卡，内部独立滚动。

在 720px 及以上，健康背景字段扩展为两列；在 370px 以下，基础字号降为 17px、页面留白降为 15px、事实网格改为单列。桌面端不应改造成高密度医疗仪表盘，宽屏主要用于增加呼吸空间和稳定居中阅读宽度。

核心触控目标至少为 44px，高频按钮通常为 48–56px，底部导航项为 58px，主要快捷卡为 88px。当前设置图标按钮是 42px 的已知实现例外，不应作为新控件模板；新增或修改时应提升到至少 44px。

**The One Task per View Rule.** 首页负责进入记录，聊天页负责说清情况，报告弹层负责阅读与核对；不要在同一视图堆叠多套主要流程。

## Elevation & Depth

系统以浅色层级为主、环境阴影为辅。常规卡片使用柔和阴影（`0 16px 42px rgba(45, 49, 98, .1)`），聊天气泡使用更轻的阴影（`0 12px 30px rgba(45, 49, 98, .07)`）；老人气泡保持无阴影，以雾紫底色区分。输入框、报告分区和记录条目主要依靠细边框与底色，而不是层层浮起。

弹层需要明确压住背景。报告弹层使用半透明深色遮罩和模糊，卡片使用更强阴影（`0 28px 80px rgba(30, 33, 74, .24)`）；本机资料解锁卡同样使用高层级阴影。遮罩只服务于阻断式阅读或解锁，不用于普通卡片。

### Named Rules

**The Ambient, Not Dramatic Rule.** 常态阴影只帮助分层，不制造悬浮炫技；更强阴影仅属于弹层、解锁和明确的当前任务。

## Shapes

形状语言以柔和圆角矩形为主。普通内容和动作卡使用 16px 左右的圆角，按钮与输入框使用 12–14px，对话气泡使用 17px，弹层和继续对话选择卡使用 24px。状态徽章和设备状态使用胶囊形，语音按钮和头像使用圆形。

边框保持一像素、低对比，主要负责让白色表面在淡色背景中可辨。虚线边框只用于照片上传区域，表示“把内容放到这里”的特殊动作。不要用尖角、重黑框或过度切割来模拟医疗系统后台。

## Components

所有组件都应在触控、键盘和读屏环境中表达相同含义。可交互控件继承系统字体；禁用状态降低透明度并保留不可用的语义，不用隐藏来制造“消失”。

### Buttons

- **Primary:** 满宽实心靛蓝、白字、54px 高，用于“保存”“继续”“生成”等当前最重要动作。
- **Secondary / Outline:** 白底、浅边框、深靛蓝文字、48px 高，用于取消、返回、刷新和次要路径。
- **Text action:** 至少 44px 高，透明背景，始终带有动作文字；箭头或图标只能辅助。
- **Focus:** 键盘聚焦使用 3px 深紫外轮廓并外移 3px，不能仅依靠背景变化。
- **Pointer states:** 只有支持悬停的精细指针设备才启用悬停变化；按下时轻微下移 1px。

### Quick Action Cards

首页“说给我听”和“拍下来”是大面积按钮，不是装饰卡片。每张卡都有 54px 图标块、20px 主标签、15px 解释和尾部方向箭头。语音入口使用靛蓝体系，照片入口使用暖橙体系；两者都要保留完整动作文字。

### Conversation

- **Assistant:** 左侧显示 40px 吉祥物头像，白色气泡承载一次一个问题；提供“再听一遍”文字按钮。
- **Elder:** 右侧雾紫气泡，显示“已加密保存在本机”或语音转文字来源，并提供至少 44px 高的“修改”入口。
- **Error:** 使用浅砖红底和明确失败文案，原文字仍保留并给出重试路径。
- **Composer:** 文本区最小高度 52px，发送按钮 52px，圆形麦克风 56px。录音中用砖红和文字状态共同反馈。
- **Editing:** 原话修改在原气泡内完成，保存和取消并列；修改结果会更新报告，但失败时保留待重试文字。

对话切换使用轻微淡入和位移，页面进入动画约 220ms，沉浸对话进入动画约 340ms。系统检测到 `prefers-reduced-motion: reduce` 时，把动画和过渡压缩到近乎即时，并取消平滑滚动。

### Report Modal

报告是底部弹出的就诊交接单，而不是医疗后台。顶端并列显示“自动整理 · 本人未核对”、报告标题和清晰的“关闭”按钮；其后先出现暖纸色安全说明，再按“主要不适、起病与变化、症状特点与生活影响、相关背景与已做处理、尚待医生核实”排列。每条整理内容直接展示患者原话和来源标签，不使用模型自由改写的病情摘要，最后允许按说话顺序展开全部原话和版本来源。

弹层使用 `role="dialog"`、`aria-modal="true"` 和标题关联。打开时把焦点移到关闭按钮，并让背景不可交互；Tab 焦点限制在弹层内，Escape 可关闭，关闭后焦点返回触发按钮。这套行为是新弹层的最低标准。

### Cards / Containers

- **Record item:** 白色半透明背景、柔和边框、14px 圆角；时间与状态在上，原话在下。
- **Draft / report section:** 轻紫底、细边框、清晰小标题，结构化整理和原话不混成一段。
- **Safety note:** 暖纸或浅砖红底，同时包含明确标题与处理文字。
- **Settings card:** 白色半透明表面与环境阴影；“仅存本机”等状态以文字徽章呈现。

### Inputs / Fields

输入框默认白底、浅蓝灰边框、48px 最小高度和 11–12px 圆角。字段标签直接说明要填什么，示例放在占位文字中但不能替代标签。长内容使用可纵向调整的文本区；错误和保存状态在字段附近以 `role="status"` 或 `aria-live` 更新。

### Navigation and Feedback

底部导航固定三项，每项同时显示 25px 线性图标和 14px 文字，当前项使用深靛蓝、较高字重和 `aria-current="page"`。页面切换后把焦点移到新页面主标题。加载、保存、失败和恢复状态使用短句并提供可见重试按钮；Toast 只做补充，不能承载唯一结果。

## Do's and Don'ts

### Do:

- **Do** 用“说给我听”“接着上次说”“查看老人原话”这类直接动作和生活化语言。
- **Do** 让主要正文保持老人可读的字号与行距，并为核心触控提供至少 44px 的目标。
- **Do** 在聊天、整理结果和报告中始终保留原话来源、版本、待核对状态和修改入口。
- **Do** 在所有报告和交接材料中明确显示“用于沟通，不是诊断”，并说明不包含用药或治疗建议。
- **Do** 把风险、错误、成功和禁用状态写成文字；颜色只是辅助。
- **Do** 为弹层保留焦点进入、焦点圈定、Escape 关闭、背景不可交互和焦点返回。
- **Do** 在窄屏保持单列，在宽屏只增加必要的两列字段和阅读留白。
- **Do** 尊重系统的减弱动态效果设置，并让所有流程在无动画时同样清楚。

### Don't:

- **Don't** 把老人端改成医疗机构后台、密集表格或需要理解内部字段的表单流程。
- **Don't** 使用“诊断结果”“治疗建议”“建议加药、减药、停药”“建议做某项检查”等越界表达。
- **Don't** 把“已核对文字准确”设计成“医学上已经安全”或“风险已经解除”。
- **Don't** 让模型生成的风险判断依靠醒目颜色获得权威感；紧急提醒只能呈现预先审核的固定文案和明确求助方向。
- **Don't** 隐藏原话、冲突、未知、拒答或未核对状态，也不要把这些内容补写成确定事实。
- **Don't** 新增小于 44px 的核心触控目标，或复制当前 42px 设置按钮这个已知例外。
- **Don't** 用只有图标的主要按钮、低对比灰字或只在悬停时出现的关键操作。
- **Don't** 用大幅弹跳、长距离位移或循环动画分散注意力；录音波形也必须在减弱动态效果时停止。
