# `@helmx/web` 宿主前端工程约定

> [!IMPORTANT]
> **UI 设计标准与组件选型单一真源**：Quiet Surface 视觉原则、「模式随业务多元，外壳与原子零件全站唯一」总纲、`32 / 28 / 22px` 控件尺码、5 变体 `Button`、选择器与 5 类舞台/列表范式、统一 `<Screen toolbar>` 外壳及标准 JSX 范例，统一由 **[`.helmx/skills/helmx-ui/SKILL.md`](../../.helmx/skills/helmx-ui/SKILL.md)** 与 **[`references/patterns.md`](../../.helmx/skills/helmx-ui/references/patterns.md)** 维护（运行期插件通过 `helmx-cli` 的 `references/ui-hig.md` 读取同一真源）。本文不再重复组件清单，仅承载 `@helmx/web` 宿主内部工程边界与运行时契约；导航与深链见[Web 导航与 URL Hash 约定](web-navigation.md)。

## CSS 级联层与宿主/SDK 边界

Web 主控台基于 React 19 + Vite 6（`packages/web`），`src/styles.css` 显式声明四层 CSS 级联顺序：

```css
@layer ui-base, ui-primitives, host-components, plugin-ui;
```

- **`ui-base`**：`@helmx/ui/tokens.css`（亮暗语义色、间距 `--space-1..6`、控件尺码 `--control-h-md/sm/xs`、圆角与 z-index 阶梯）与 `@helmx/ui/base.css`；
- **`ui-primitives`**：`@helmx/ui/styles.css`（按组件就近拆分的原语样式，如 `Button.css` / `Select.css` / `Screen.css` / `DetailDrawer.css` / `Utilities.css` 等，仅由 CSS 入口引入，TS/TSX 绝不直接 import CSS 以保持 SSR 与 `tsx --test` 零 loader）；
- **`host-components`**：`packages/web/src/styles/*.css` 与 `src/responsive.css`（`main.tsx` 在 `styles.css` 之后引入，仍归入 `host-components`）；
- **`plugin-ui`**：插件注入的样式由宿主以零优先级 `:where([data-plugin-id="<pluginId>"])` 作用域化并放进 `@layer plugin-ui`，无需 `!important` 即可可预测覆盖设计系统原语与宿主默认样式，停用或重载时随生命周期回收；
- **单向包依赖**：`@helmx/ui` 是零插件运行时依赖的独立 Quiet Surface 设计系统包；`@helmx/plugin-client` 依赖 `@helmx/ui` 与 `@helmx/protocol/browser`，承载插件运行时上下文、Hooks、插槽与宿主耦合组件（`ModelPickerControl` / `Markdown*` / `ToolCallDetails`），绝不反向依赖 `@helmx/web`；`HelmxStoreProvider` 挂载 `globalThis.__helmx_shared_ui` 与 `globalThis.__helmx_shared_plugin_client` 并经 `UiLocaleProvider` / `PluginClientHostContext` 注入真实数据与宿主能力，核心页面与插件共享同一运行时实例；外部插件严禁导入 `@helmx/ui/pure` 或 `@helmx/plugin-client/pure`。

## SSR 与单测防破裂契约

所有共享 Radix 交互原语与页面外壳必须在 Node / `renderToString` 环境下直出可断言的真实标记，不得因缺少 `document` / `window` 返回空 DOM 或抛错：

- **Portal 自动降级**：`Dialog` / `DetailDrawer` / `Select` / `MultiSelect` / `Popover` / `AlertDialog` / `ConfirmDialog` 在 `typeof window === 'undefined'` 或显式传入 `inline` 时跳过 DOM Portal 直出内联树；
- **`Screen` 顶栏与工具栏槽位回落**：挂载于宿主 `ScreenHost` 时，`Screen` 经 `ScreenHostContext` 结构化省略重复标题，并将 `actions` 与 `toolbar` portal 到宿主顶栏/工具栏槽位（React 树仍留在插件内，上下文与 `data-plugin-id` 作用域保持完整）；在 SSR 或独立单测无槽位时自动退回内联渲染；
- **禁止手写定位浮层**：所有浮层与选择器必须经 Radix 封装承载 WAI-ARIA、Focus Trap、Escape 退出与遮罩隔离，禁止 `div` + `position: absolute` 拼装假弹层。

## 阅读字体阶梯与移动端视口规范

控件尺码（`32/28/22px`）与控件字号（`13/12/11px`）归属 `helmx-ui` HIG；以下为 `@helmx/web` 宿主阅读档排版与移动端视口契约：

| 宿主阅读区域 | 字号 / 行高 |
| :--- | :--- |
| 会话阅读档：AI 正文与产物/工作区 Markdown 预览（`.msg-ai-body`） | `15px` / `1.65`（标题按 `em` 比例） |
| 人类提问胶囊与 Composer 输入框（含待命页，桌面/移动/分屏一致） | `15px` / `1.55` |
| 思考过程正文 | `13.5px` |
| 会话内代码块与工具输出代码 | `13px`（行内代码 `0.88em`） |
| 顶栏与主舞台大标题 | `15px` / `16px` |

### 移动端（`@media (max-width: 680px)`）与粗指针触控

- **视口与安全区**：`index.html` 通过 `maximum-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content` 防止 iOS `15px` 输入框自动缩放（保留双指缩放）并覆盖安全区；启动内联脚本与 `applyDocumentTheme` 同步 `<meta name="theme-color">`；主顶栏（`<= 860px`）、侧栏与全宽抽屉头尾显式叠加 `env(safe-area-inset-*)`；
- **输入法与触控策略**：Composer `<textarea>` 声明 `enterKeyHint="send"`；带搜索框的浮层在 `@media (hover: none) and (pointer: coarse)` 下打开时不自动聚焦输入框（防误弹软键盘）；`@media (pointer: coarse)` 适度放宽触控热区，桌面端保持紧凑密度；
- **视口分界**：`MobileQuickNavSlot` 仅在 `<= 680px` 渲染并置顶占位，681–860px 平板档仅保留左上角汉堡开关，侧栏滑动手势阈值（`<= 860px`）与 CSS 抽屉断点一致；
- **全宽抽屉与禁放大红线**：弹窗与抽屉在 `<= 680px` 下全宽铺满（`width: 100vw; max-width: 100vw; left: 0; right: 0;`）；**严禁任何输入框在移动端或分屏下突兀放大到 `16px`**（含 `.ask-dock` 与分屏表单）；
- **悬停门禁**：所有 `:hover` 规则必须位于 `@media (hover: hover)` 内（`pnpm check:hygiene` 强制），`:focus-visible` / `[aria-expanded]` / `.is-active` 等持久态留在门禁外；悬停显露的控件须在 `@media (hover: none)` 下常显或由 `:focus-within` 替代；系统点按高亮已在 `base.css` 关闭，按压反馈统一走 `:active`。

## Fast Refresh 与异步数据竞争保护

- **Fast Refresh 铁律**：`.tsx` 文件**只导出 React 组件与 TypeScript 类型**；纯数据转换、枚举映射、排序过滤函数与常量必须拆至独立 `*-model.ts` / `.ts` 模块；
- **代数竞争保护**：异步数据加载必须维护递增代数守卫（`loadGeneration.current += 1`），防止切换目标后滞后响应反向覆盖新状态。

## 会话工具轨迹宿主渲染契约

- 常规工具保留 `26px` 单行静音轨迹与 `StepGroup` 折叠；专属展开体按语义呈现（`edit` 展示差异、`bash` 展示命令与输出尾部）并保留原始数据入口；
- 折叠开关统一位于行首左侧 chevron（`x=8px`，`<= 450px` 容器为 `6px`），其后是状态图标；行尾仅放状态、耗时、徽标与外链跳转（`external-link` / `.trace-row-link`），禁止行尾再放 chevron；`replaceRow` 插件卡仅在存在跳转目标时把主体作为导航按钮，入参/输出统一走宿主 IO 面板，插件不得自建重复 `ToolCallDetails`；
- 如实区分待执行、成功、失败与未知状态：`oldText / newText` 不代表已落盘；成功差异只消费内核实际返回结果（经 `@helmx/protocol` 的 `EditToolResult` / `EDIT_TOOL_RESULT_SCHEMA` 在消费边界校验），禁止重读当前文件冒充历史快照；失败态不承诺「未写入」；
- 明确区分内容折叠与数据截断：截断必须如实说明未传回部分，不提供虚假「展开全部」；脱敏影响行号映射时省略差异正文并显式标记。

## 表单真实性与整体替换（PUT）保存契约

- **真实编辑入口铁律**：凡渲染为可编辑的表单控件，保存链路必须真实落盘该字段；无法持久化的配置只读呈现并指明真实修改入口（如模型中心插件托管网关标注由对应插件配置管理）；必填项清空保存必须显式报错；
- **PUT 整体替换基底**：抽屉表单以最近一次完整详情为基底，仅覆写表单暴露字段并原样回传未暴露字段；可选绑定置空时必须显式删除键（避免基底复活旧绑定）；
- **绑定类 `Select` 选项集**：始终提供「未绑定」空值项、全量资源（含在线/离线状态标注）与未知值回退项；既有绑定不在当前目录时只读展示原值并标注未知，绝不静默清空。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| UI HIG 唯一真源 | `.helmx/skills/helmx-ui/SKILL.md`、`references/patterns.md` |
| Web 应用入口与路由装配 | `packages/web/src/App.tsx`、`main.tsx` |
| Web 专有 UI 组件 | `packages/web/src/ui/` |
| 共享 UI 设计系统原语与样式 | `packages/ui/src/`（`tokens.css`、`base.css`、`styles.css`、`primitives/`、`primitives.tsx`） |
| 共享插件运行时 SDK 与宿主耦合组件 | `packages/plugin-client/src/`（Hooks、`PluginSlot`、`PluginScope`、`ModelPicker.tsx`、`markdown*`、`tool-details.tsx`） |
| 宿主业务样式分片与响应式 | `packages/web/src/styles/`、`responsive.css` |
| 浏览器验收服务 | `scripts/web-acceptance.mjs` |
| 前端单测 | `packages/web/test/*.test.ts(x)`、`packages/ui/test/`、`packages/plugin-client/test/` |

## 相关文档

- [Helmx UI HIG 技能真源](../../.helmx/skills/helmx-ui/SKILL.md) 与 [标准 JSX 范例](../../.helmx/skills/helmx-ui/references/patterns.md)
- [Web 导航与 URL Hash 约定](web-navigation.md)：位置契约、深链与历史语义
- [插件开发实战](../plugins/plugin-development.md)：`client.tsx` 单轨与共享 SDK
- [微内核架构总览](../architecture/overview.md)：Web 与 SDK 的包依赖方向
