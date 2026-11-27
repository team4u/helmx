# Web 前端设计系统与开发约定

本文是 `@helmx/web` 与所有插件 `client.tsx` 前端代码的可执行贡献指南：编写或重构 Web 界面、新增主舞台/视图/弹窗/抽屉，或排查移动端样式与字号问题前，必须先阅读并遵守本文。五条硬铁律（零 Emoji、视图形态三级、Radix 唯一原语、唯一 Hash 导航、Fast Refresh）在仓库根 [AGENTS.md](../../AGENTS.md) 同步声明；导航与深链契约见[Web 导航与 URL Hash 约定](web-navigation.md)。

## 当前状态

Web 主控台基于 React 19 + Vite 6（`packages/web`），交互原语统一 Radix UI 封装，样式由 `src/styles.css` 聚合的 `src/styles/` 分片与 `src/responsive.css` 承载。本约定对内置界面与插件前端一体适用，违规会在代码评审被打回。

## 视图形态三级（硬契约）

界面按信息量与操作复杂度分三档。选择哪一档不是审美问题：海量内容禁止进入居中模态。

### 一级主舞台（Primary Stage）

- 适用：会话、插件 Screen、插件中心、模型/角色/技能/节点中心等管理与市场类界面；
- 形态：占满中央视口，响应式多列自适应卡片网格，顶部集成检索框、多维分类切换与实时统计；
- **页头主动作位置统一**：新建/刷新等视图级动作放页头右侧动作区（Web 中心 `headerActions`，插件 `Screen actions` 挂载于 `ScreenHost` 时自动落入宿主顶栏 `.pane-actions` 动作槽），按钮用 `icon` + `<span className="pane-action-label">` 文案，窄屏由 `.pane-action-label` 收敛为居中纯图标；检索/筛选工具栏（`ScreenToolbar`）只承载搜索框、分类胶囊与列表级动作，**不得把新建类主按钮塞进工具栏**（窄屏会孤立换行成单独一行）；
- **严禁将海量项、多维检索、管理与市场类界面塞进居中模态弹窗**。

### 右侧深度配置抽屉（Slide-out Detail Drawer）

- 适用：主舞台卡片点击后的深层详情、能力透视（Tools / Actions / Hooks 清单）、动态配置表单与设置面板扩展；
- 尺寸：桌面端固定宽度 520px~560px 贴右侧全高；移动端（≤680px）自适应 100% 全宽；
- 实现：基于 `@helmx/plugin-client` 的 Radix `Dialog` 原语封装，支持 Escape 退出、点击遮罩关闭与受管焦点圈定。

### 轻量居中模态（Centered Modal）

- 仅限轻量操作：危险二次确认、短表单创建、单一密钥/凭据录入、即时图片或 Mermaid 预览；
- 最大宽度克制在 480px~640px，避免多层嵌套卡片与臃肿滚动条。

## 设计系统原语与 CSS 架构

- **严禁大面积内联样式**（`style={{ ... }}`）：除极少数动态计算的尺寸/坐标外，排版、间距与颜色一律使用设计系统原语组件、公共原语类与 CSS 变量（间距阶梯 `--space-1`..`--space-6` = `4/8/12/16/20/24px`）；
- 常用通用类速查（定义在 `primitives.css` 与位于 `@layer host-components` 末尾的 `utilities.css`，插件优先使用下方 SDK 组件而非手拼类）：通用弹性布局与文本修饰 `.flex-1` / `.flex-row` / `.flex-row-between` / `.flex-row-wrap` / `.flex-col` / `.flex-col-xs` / `.text-muted` / `.text-subtle` / `.text-err` / `.mono` / `.nowrap` / `.break-word`；平坦分节 `.section-flat` 系列；表单 `.form-grid` / `.form-grid-label` / `.input` / `.input-sm` / `.textarea`（含 `[aria-invalid='true']` 统一错误描边）；搜索框 `.search-box` / `.search-box-toolbar` / `.search-box-clear`；空状态 `.empty-state`（含 `.empty-state-compact` / `.empty-state-prominent` / `.empty-state-hint` / `.empty-state-action`）；表格 `.helmx-table-wrap` / `.helmx-table`（统一内边距、12.5px 字体、表头 `var(--bg-subtle)`、`tr:hover`）；插件页面 `.screen-host-body`（单层滚动舞台）/ `.screen-container` / `.screen-header` / `.screen-section`；工具栏行 `.screen-toolbar` / `.screen-toolbar-actions`（内含 `.search-box` 自动获得伸展权重）；键值 `.kv-grid` / `.kv-list`；提示横幅 `.callout`（`.callout-warn/-error/-ok`）；加载态 `.loading-state`；
- **插件布局、表单与展示原语组件**（全部由 `@helmx/plugin-client` 根入口导出，优先复用不要手写 div+className；外部插件不得导入 `@helmx/plugin-client/pure`）：
  - 页面与容器：`Screen`（页面容器+页头，支持 `layout="contained" | "full-bleed"`；挂载于宿主 `ScreenHost` 内时通过 `ScreenHostContext` 结构化省略重复 `.screen-title`、把 `actions` 经宿主提供的 `headerActionsSlot` portal 进顶栏 `.pane-actions`（React 树仍留在插件内，上下文与 `data-plugin-id` 作用域 CSS 不变；无槽位如 SSR/独立挂载时回落为内联 `.screen-header` 右侧动作簇），并在无副标题与动作时省略空 `.screen-header`，统一由 `.screen-host-body` 承担单一垂直滚动）、`ScreenSection`（分节）、`ScreenToolbar`（页头与正文之间的工具栏行）、`Stack`（间距映射 `--space-1..5` 的弹性排布）、`Card`（静态结构化容器，含 `elevated | subtle` 与 `default | warn | danger`）、`SelectCard` + `CardGrid`（主舞台可点选对象卡与窄分屏防溢出响应网格）、`DataTable`（统一 loading/empty 的组合式表格外壳）、`KvGrid`（键值概览）、`DetailDrawer`（右侧详情抽屉外壳）；
  - 表单与操作：`Button` / `IconButton`（强类型变体/尺寸、`pending` 忙态与 `forwardRef` 兼容 Radix `asChild`；`Button` 子节点直接作为 `.btn` 的 flex 项，**不包包裹层**，因此被响应式 `display: none` 隐藏的 `.pane-action-label` 不会留下 ghost gap，图标始终居中）、`Input` / `Textarea`、`Field` / `HelperText` / `ErrorText`（非包裹式 `<label htmlFor>` 与 `FieldContext` 自动贯通 `Input` / `Textarea` / `Select` / `MultiSelect` / `Switch` / `Checkbox`；多控件或自带 label 控件传 `htmlFor={false}`）；
  - 展示与反馈：`Badge`、`MonoId`（截断等宽标识 + 一键复制）、`SearchBox`（统一搜索框，支持 `variant="default" | "toolbar"` 与标准 `.search-box-clear` 清除按钮）、`EmptyState`（全站统一空状态原语，支持 `icon` 传 `HelmxIcon` 图标名或节点、`iconSize`、`hintSubtle`、`action` 动作槽位及 `compact` / `prominent` 舞台级密度）、`LoadingState`、`StatusLight`（推荐传强类型 `tone: StatusLightTone` + `label`/`aria-label`，同时导出 `STATUS_LIGHT_TONES` / `normalizeStatusLightTone` / `isKnownStatusLightStatus`）、`Callout`、`ModelPickerControl`；屏内嵌套组件读参数用 `useScreenParams()`（宿主 `ScreenHost` 建立的屏内 scope，非全屏上下文返回 `null`）；插件屏内的右侧 `DetailDrawer` 统一配对使用 `useScreenDrawer()`，自动接入 URL Hash 与移动端/浏览器后退语义；
- **强制样式复用铁律**：全仓所有插件必须优先复用主框架设计系统原语，严禁在插件内复制通用表格、页面布局、键值列表或提示条样式；插件本地 `.css` 只写业务特异结构（如 Mermaid 缩放画布、Workflow DAG 卡片）。

### Radix UI 唯一无头交互原语底座

凡涉及浮层、对话框、下拉选择、标签页、气泡提示等复杂交互，**必须使用已有 Radix 封装**。共享实现位于 `packages/plugin-client/src/ui/`，经 `@helmx/plugin-client` 公开；Web 专有组件位于 `packages/web/src/ui/`。严禁原生控件或第三方重量级 UI 库：

| 场景 | 用什么 |
| :--- | :--- |
| 弹窗与抽屉 | SDK `Dialog` / `DetailDrawer`；危险确认用 SDK `AlertDialog` / `ConfirmDialog` |
| 下拉选择 | **全仓严禁原生 `<select>`**，统一 SDK `Select` / `MultiSelect`（无障碍 combobox 契约） |
| 下拉菜单与气泡 | SDK `DropdownMenu`；共享气泡 SDK `Popover` |
| 标签页、分段与分类胶囊 | SDK `Tabs`（支持 `variant="underline" | "segmented" | "pills"`，完整 Roving `tabIndex` 与方向键导航）/ `SegmentedControl` |
| 轻量提示 / 开关勾选 | SDK `Tooltip`（全局由 `App` 的 `TooltipProvider` 托管 `skipDelayDuration`）；SDK `Switch` / `Checkbox` |

SDK 不导入 Web store、路由或渲染实现。`HelmxStoreProvider` 经 `PluginClientHostContext` 注入真实数据与宿主能力；插件与宿主共享同一 SDK 上下文实例。

**严禁手写简陋交互浮层**：不得用原生 `div` + `position: absolute` + 随意 `onClick` 拼凑浮层，杜绝缺乏 WAI-ARIA、Focus Trap 焦点逃逸、Escape 无法退出与遮罩穿透。

**SSR 与单测防破裂契约**：所有 Radix 封装原语必须可在 Node / `renderToString` 环境直出降级渲染（不依赖 Portal），避免测试断言拿到空 DOM。

## 字体层次与移动端规范

### 字体阶梯

| 用途 | 字号 |
| :--- | :--- |
| 工作台主文本与输入框（侧栏、顶栏、表单、按钮、抽屉） | 13px / 14px |
| 会话阅读档：AI 正文、人类提问胶囊与 Composer 输入框 | 15px |
| 会话内代码块与工具输出代码 | 13px（行内代码 0.88em） |
| 思考过程正文 | 13.5px |
| 辅助文本与表单标签 | 12px |
| 状态徽章与胶囊计数 | 11px |
| 顶栏与主舞台大标题 | 15px / 16px |

- 会话与产物/工作区 Markdown 预览共用同一套阅读档排版（`.msg-ai-block` 与 `.artifact-markdown-preview` 内的 `.msg-ai-body`：正文 15px / 行高 1.65，标题阶梯按 em 比例）；
- **提问与输入字号一致**：人类提问胶囊与 Composer 输入框（含待命页）均为 15px / 行高 1.55，桌面、移动与分屏同字号。

### 移动端（`@media (max-width: 680px)`）与粗指针触控

- **视口与安全区**：`index.html` 通过 `maximum-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content` 防止 iOS 15px 输入自动放大（保留 iOS 10+ 双指缩放）、覆盖刘海/Home Indicator 安全区，并由启动内联脚本与 `applyDocumentTheme` 同步 `<meta name="theme-color">`；主顶栏（`<= 860px`）、侧栏与全宽抽屉头尾显式叠加 `env(safe-area-inset-*)`；
- **输入法与触控策略**：Composer `<textarea>` 声明 `enterKeyHint="send"`，保持桌面与移动端统一的 Enter 发送行为；大纲等带搜索框的浮层在 `@media (hover: none) and (pointer: coarse)` 下打开时不自动聚焦内部输入框（防止软键盘误弹出）；`@media (pointer: coarse)` 适度放宽工具按钮/下拉选项点按热区，桌面端仍保持紧凑密度；
- **视口分界**：`MobileQuickNavSlot` 仅在移动端紧凑视口（`<= 680px`）渲染并置顶占位，681–860px 平板档仅保留左上角汉堡抽屉开关，侧栏滑动手势判定（`<= 860px`）与 CSS 抽屉断点对齐；
- 弹窗与抽屉在 `<= 680px` 下 `width: 100vw; max-width: 100vw; left: 0; right: 0;` 全宽自适应；头部容器保持关闭按钮与截断保底；
- **严禁任何输入框在移动端或分屏宽度下字号突兀放大**（包括 `.ask-dock` 与分屏表单，必须坚持 12–15px 统一字阶，禁止 `font-size: 16px` 这类破坏性补丁）；
- **悬停样式必须门禁**：所有 `:hover` 规则包在 `@media (hover: hover)` 内（`pnpm check:hygiene` 强制），`:focus-visible` / `[aria-expanded]` / `.is-active` 等持久态选择器留在门禁外；悬停才显露的控件在 `@media (hover: none)` 下常显或经 `:focus-within` 显露；系统原生点按高亮已在 `base.css` 全局关闭，按压反馈统一走 `:active`。

## 零 Emoji 铁律

界面文案、导航、标题、按钮、徽章、卡片**严禁任何 Emoji**。图标统一 `lucide-react` 线性矢量图标（经 `HelmxIcon` 组件）或纯文本排版。

## Fast Refresh 与数据加载

- `.tsx` 组件文件**只导出 React 组件与 TypeScript 类型**；纯数据转换、枚举映射、排序过滤纯函数剥离到独立 `*-model.ts` 模块；
- 异步数据加载必须引入代数竞争保护（`loadGeneration.current += 1`），避免切换目标后旧请求反向覆盖新状态。

## 会话工具展示

- 常规工具保留 26px 单行轨迹与 `StepGroup` 折叠；专属展开体按工具语义呈现（`edit` 展示变更、`bash` 展示命令与输出尾部），提供原始数据入口；
- 折叠开关统一为行首左侧 chevron：默认工具行、`ask_user` 行、思考/过程组与 `replaceRow` 插件卡的宿主 IO 开关同在 x=8px（≤450px 容器为 6px），其后才是状态图标；行尾只放状态/耗时/徽标，跳转提示用 `external-link`（`.trace-row-link`），行尾不得再出现 chevron 或其他折叠图标；`replaceRow` 卡的行主体仅在存在跳转目标时是导航按钮，入参/输出展开统一走宿主 IO 面板，插件不得再自建 `ToolCallDetails` 折叠入口；
- 待执行、成功、失败与未知状态必须如实区分：`oldText / newText` 只是片段对比不代表已落盘；成功后的差异只消费内核实际执行结果，禁止重读当前文件冒充历史快照；失败态不承诺「未写入」；
- `edit` 结果遵循 `@helmx/protocol` 的 `EditToolResult` 与 `EDIT_TOOL_RESULT_SCHEMA`，Web 在消费边界校验；
- 内容折叠与数据截断须分清：折叠可展开已有全文，截断明确说明部分数据未传回，不提供虚假「展开全部」；脱敏影响行号映射时省略差异正文并明确标记。

## 表单真实性与整体替换保存契约

- **真实编辑入口铁律**：凡渲染为可编辑的表单控件，保存链路必须真实持久化该字段；无法落盘的配置只读展示并指明真实修改路径（范例：模型中心供应商抽屉——插件网关配置只读标注「由插件 X 的配置管理」并指引插件中心，仅自定义网关端点可编辑）。必填字段清空保存必须显式报错；
- **整体替换（PUT）保存契约**：抽屉表单以最近一次完整详情为基底，仅覆写表单暴露字段，未暴露字段原样回传；可选绑定字段显式表达空值语义（非空写入、置空显式删除键，防止基底复活旧绑定）；
- **绑定类 Select 选项集**：提供「未绑定」空值项、资源全量（在线/离线标注）与未知值回退项；既有绑定不在列表时只读呈现原值并标注未知，不静默清空。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| Web 应用入口与路由装配 | `packages/web/src/App.tsx`、`main.tsx` |
| Web 专有 UI 组件 | `packages/web/src/ui/` |
| 共享 SDK 原语 | `packages/plugin-client/src/ui/`、`primitives.tsx` |
| 样式分片与响应式 | `packages/web/src/styles/`、`responsive.css` |
| 浏览器验收服务 | `scripts/web-acceptance.mjs` |
| 测试 | `packages/web/test/*.test.ts(x)`（happy-dom 单测）；`packages/plugin-client/test/` |

## 相关文档

- [Web 导航与 URL Hash 约定](web-navigation.md)：位置契约、深链与历史语义
- [插件开发实战](../plugins/plugin-development.md)：client.tsx 单轨与共享 SDK
- [微内核架构总览](../architecture/overview.md)：Web 与 SDK 的包依赖方向
