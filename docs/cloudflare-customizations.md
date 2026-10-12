# pi-web cf-workers 定制清单

核对日期：2026-10-12。比较对象是 `shanexi/pi-web` 的 Cloudflare fork 与 `agegr/pi-web` 上游，不包含 `pi-cf` 后端自己的代码改动。可追溯比较基线是上游 v0.12.0 [`894e1a2`](https://github.com/agegr/pi-web/commit/894e1a28dbeeb7b457c7712e495d975fe9927b89) 与同步后的 fork [`f7df1c6`](https://github.com/shanexi/pi-web/commit/f7df1c6d62bd14a2279a7e3b5e56caf653a1f96c)。下文的功能清单包含随后完成的子智能体移除与导出分页修复；数字统计明确对应移除前的 Git 基线。

本次改造后保留：Cloudflare 部署与飞书登录、普通主会话及 fork/历史操作、账号沙箱文件与暂停/唤醒、Skills、Plugins 管理及普通 exec/transcript 等扩展能力、模型选择和图片能力接线、浏览器完整历史导出。子智能体 UI、Agent/result/steer、后台委派、inference 模型代理和权限入口从前后端移除，当前功能清单不再包含这些能力。

`demo/` 是冻结的上游演示副本，独立构建并由上游 mock 驱动，不进入这个 Cloudflare 应用或其发布范围。当前云应用的主组件、hooks 和协议已经实际删除子智能体功能。

## 当前 fork 做了什么

核心改造是：把上游在用户本机运行的 Next.js + Pi 服务，拆成 Cloudflare 上的网页 Worker 与独立 `pi-cf` 后端；网页调用后端，文件、技能和扩展改由用户的 E2B 工作区承载。

| 定制能力 | 当前行为与代表文件 | 对应提交 |
| --- | --- | --- |
| Cloudflare 部署与双 Worker 架构 | OpenNext 构建和部署；网页为 Worker A，所有 agent/session/model/file API 走 Worker B。配置 `NEXT_PUBLIC_AGENT_BASE_URL`，默认工作目录 `/workspace`。代表：`open-next.config.ts`、`wrangler.jsonc`、`next.config.ts`、`package.json`、`.env.example`。 | [`74f3908`](https://github.com/shanexi/pi-web/commit/74f3908)；本轮更新 [`2d6e806`](https://github.com/shanexi/pi-web/commit/2d6e806)、[`f7df1c6`](https://github.com/shanexi/pi-web/commit/f7df1c6) |
| 跨 Worker API 与飞书登录接线 | `apiUrl` 解析后端地址；`apiFetch` 带登录 cookie，遇 401 跳飞书登录并返回原页面；SSE 使用带凭据的 `apiEvents`。页面启动查询 `/api/auth/me`。代表：`lib/api-base.ts`、`lib/agent-client.ts`、`hooks/useAgentSession.ts`、`components/AppShell.tsx`、`components/MessageView.tsx`。飞书 OAuth 与 owner 校验的实现属于 `pi-cf`。 | [`ccd1d16`](https://github.com/shanexi/pi-web/commit/ccd1d16)；本轮认证回归测试 [`f7df1c6`](https://github.com/shanexi/pi-web/commit/f7df1c6) |
| 上游本机功能门控 | `LOCAL_PANELS=false`，关闭依赖本机 Node 服务的模型凭据/OAuth 管理、MCP、终端、Git diff、项目 trust、本机 web-auth、Web Push、应用版本检查等入口。Skills、Plugins、文件面板按独立开关恢复。代表：`lib/feature-flags.ts`、`components/SettingsPanel.tsx`、`components/AppShell.tsx`、`components/ChatWindow.tsx`、`components/FileViewer.tsx`。 | [`25ebc64`](https://github.com/shanexi/pi-web/commit/25ebc64)、[`f7df1c6`](https://github.com/shanexi/pi-web/commit/f7df1c6) |
| Node 服务端裁剪 | 删除网页仓库里的本机 API 与 Node-only 服务库，避免在 Worker A 加载文件系统、进程、Pi 本地 runtime、MCP 服务等。代表：原 `app/api/**`、`lib/rpc-manager.ts`、`lib/session-reader.ts`、`lib/mcp-*.ts`、`instrumentation*.ts`、`proxy.ts`。启用的接口由 `pi-cf` 承担，其余入口通过门控关闭。 | [`74f3908`](https://github.com/shanexi/pi-web/commit/74f3908)、[`cb45e0a`](https://github.com/shanexi/pi-web/commit/cb45e0a)、[`8230f8a`](https://github.com/shanexi/pi-web/commit/8230f8a)、[`2d6e806`](https://github.com/shanexi/pi-web/commit/2d6e806) |
| 沙箱文件与目录界面 | 恢复 FileExplorer、FileViewer、`@` 文件索引和工作目录选择；通过后端访问账号工作区。增加沙箱目录选择器；文件 watch 与媒体地址都走后端。浏览与显式初始化分开。代表：`components/SandboxDirPicker.tsx`、`components/DirectoryPicker.tsx`、`components/FileExplorer.tsx`、`components/FileViewer.tsx`、`components/ChatInput.tsx`。 | [`4b4b6e9`](https://github.com/shanexi/pi-web/commit/4b4b6e9) |
| 沙箱状态与暂停/唤醒 | 侧栏显示账号沙箱 cold/running/paused 状态；调用 `/api/workspace/state`、`/pause`、`/resume`。后台拒绝暂停仍有会话运行的工作区，前端呈现原因。代表：`components/SandboxStatusChip.tsx`、`components/AppShell.tsx`。 | [`6ee9dd1`](https://github.com/shanexi/pi-web/commit/6ee9dd1)、[`4ef00f2`](https://github.com/shanexi/pi-web/commit/4ef00f2) |
| Skills 的沙箱接入 | Skills 界面改为后端工作区列表、启用/停用、搜索与安装流程，替代本机 skills 服务。代表：`components/SkillsConfig.tsx`、`lib/api-types.ts`、`lib/feature-flags.ts`。本清单将后端已经提供的列表、开关、搜索与安装作为沙箱 Skills 能力；继承的本机服务未计入。 | [`5dec507`](https://github.com/shanexi/pi-web/commit/5dec507)、[`cb45e0a`](https://github.com/shanexi/pi-web/commit/cb45e0a) |
| Plugins 内置与第三方管理 | 内置扩展开关；第三方 bundle 或 Source 安装、启用/停用、卸载；master-detail 管理器；整包资源分类计数；显示 DW/E2B transport、实际 storage、native 入口与 missing 状态。代表：`components/PluginsConfig.tsx`、`lib/api-types.ts`。DW 与 E2B 的执行隔离和安装解析在 `pi-cf`。 | [`f4883f3`](https://github.com/shanexi/pi-web/commit/f4883f3)、[`116e199`](https://github.com/shanexi/pi-web/commit/116e199)、[`c16eda1`](https://github.com/shanexi/pi-web/commit/c16eda1)、[`d00479e`](https://github.com/shanexi/pi-web/commit/d00479e)、[`0dc729a`](https://github.com/shanexi/pi-web/commit/0dc729a)、[`c66ff0a`](https://github.com/shanexi/pi-web/commit/c66ff0a) |
| 第三方扩展能力授予 | 展示声明与用户授予的能力；保留 promptDrive、modelSteering、toolInput、transcript、exec。沙箱 transport 可追加 transcript 同意而免重装。inference 授予与模型代理入口已随子智能体移除。代表：`components/PluginsConfig.tsx`、`lib/api-types.ts`。 | [`11e8091`](https://github.com/shanexi/pi-web/commit/11e8091)、[`27ef0c5`](https://github.com/shanexi/pi-web/commit/27ef0c5) |
| 图片输入与模型能力接线 | 将后端模型的 `input` 能力交给聊天 UI，限制纯文本模型的图片输入；图片、lazy thinking 与历史工具图片 URL 指向后端。早期 fork 加过客户端图片压缩，但当前上游也已有图片处理，因此当前差异以能力接线和跨 Worker 地址为主。代表：`hooks/useAgentSession.ts`、`components/MessageView.tsx`、`components/ChatInput.tsx`。 | [`5b906e8`](https://github.com/shanexi/pi-web/commit/5b906e8)、[`2d6e806`](https://github.com/shanexi/pi-web/commit/2d6e806) |
| 会话操作和浏览器导出 | 会话 rename/delete、running 订阅接后端；使用浏览器生成 HTML 下载，替代上游服务端 export route。代表：`lib/session-export.ts`、`components/AppShell.tsx`、`components/SessionSidebar.tsx`。导出固定目标 leaf，沿 before cursor 分页取完历史后生成 HTML，避免 tail=50 静默截断；重复 cursor 会被检测。 | [`932ec78`](https://github.com/shanexi/pi-web/commit/932ec78)；本轮分页修复记录于本文件所在的 Cloudflare 清理提交 |
| 上游 v0.12 / Pi 1.1 云 API 适配 | 同步新的 history/state 分离、分页、session UI state、可见页 running/lease 轮询、lazy 图片、fork/批删/search 调用；跨 Worker 认证贯穿这些新入口。这里的分页、fork、批删、search、sidebar pins/archive 主要是上游原生功能，fork 自己做的是对接云后端。代表：`hooks/useAgentSession.ts`、`hooks/useSessionUiState.ts`、`components/SessionSidebar.tsx`、`lib/api-base.test.mjs`。 | [`2d6e806`](https://github.com/shanexi/pi-web/commit/2d6e806)、[`f7df1c6`](https://github.com/shanexi/pi-web/commit/f7df1c6) |

## 子智能体：哪些来自上游，哪些是我们加的

子智能体概念与大部分 UI 不是 Cloudflare fork 发明的。上游 v0.12.0 已有 Agents profiles/settings、`Agent` 工具、后台运行、`get_subagent_result`、`steer_subagent`、恢复运行、worktree 隔离、可检查的子会话以及通知与会话 family 呈现。

| 层 | 上游原生部分 | Cloudflare fork / pi-cf 自定义部分 |
| --- | --- | --- |
| pi-web 前端 | `components/AgentsConfig.tsx`、`components/SubagentViewer.tsx`、`components/AgentSessionPanel.tsx`、subagent tools 的卡片与通知、sidebar subagent relation，以及 `lib/subagents.ts` / `lib/subagent-extension.ts` 原来的类型和本机 runtime。 | fork 对这些组件主要换成 `apiFetch`；Agents 设置被 LOCAL_PANELS 门控。Node 执行逻辑裁掉后，少量共享类型留给 UI。`2d6e806` 还增加了前台结束后对 custom 消息重新读历史的接线，最初是为后台通知服务。 |
| pi-cf 扩展桥 | 兼容上游或第三方子智能体工具的名称与上下文语义。 | E9 的零密钥 inference broker 和 sandbox 模型 catalog；`dw-proxy.ts` / `ext-host-core.ts` / `sandbox-ext-host.ts` 中 Agent/result/steer 代理；sandbox 一次性子智能体执行。 |
| pi-cf 后台会话 | 后台委派、结果查询、通知等产品语义与上游相似。 | E11 的 headless child SessionDO、持久化 background_agents 表、owner 并发限制、wall-clock cap、alarm/eviction 兜底、子会话 registry relation、结果通知和 steer 回主循环，都是这里的自定义实现。 |

本次从整个产品的前后端删除子智能体能力：配置/查看界面、专用 tool cards 与类型、profiles/settings/subagent API 调用、`Agent` / `get_subagent_result` / `steer_subagent` 工具和代理、后台 child SessionDO 生成与调度、查询/steer/通知回执、inference broker/catalog 及其授予入口。后端同时过滤旧的子智能体插件和后台 session 记录，拒绝重新安装包含这些专用工具的扩展；不删除旧 SQL 历史数据。后端执行移除可追溯到 [`e18c5b5`](https://github.com/shanexi/pi-cf/commit/e18c5b58512e35aec0d408cf3dbc254b70f7b5bd)。

普通主会话的 Pi `AgentSession`、会话 fork/分页、普通扩展注册与 exec/transcript 能力保留。generic custom message 本身也不是子智能体能力，因此保留普通扩展的 custom 消息展示和 idle 刷新。

## 改动量的正确读法

在上述删除前快照中，`git log upstream/main..HEAD` 有 21 个 fork 提交；`git diff upstream/main..HEAD` 涉及 312 个文件，新增 8,081 行、删除 49,865 行。文件状态为 10 个新增、37 个修改、265 个删除；删除项包括 93 个 `app/api` 文件和 169 个 `lib` 文件，且有相当一部分是对应 Node 服务端测试。

因此这不是新增了 312 项功能。当前独立功能主要集中在部署/认证适配、E2B 工作区、Skills 与 Plugins 管理，以及少量模型和会话接线；大量 diff 是从网页 Worker 移走上游本机服务端代码。本轮子智能体删除与导出分页修复是在该基线之后完成的增量，不混入上述历史统计。

本次核对使用本地 Git 中已验证的完整 commit；旧定制提交没有在日志里提供 PR 编号，因此以可定位的 commit 链接作为追溯依据，不推测 PR 对应关系。CF AI Gateway 与 Run token 配置在 `pi-cf` 后端，未混入这份 pi-web 前端差异统计。
