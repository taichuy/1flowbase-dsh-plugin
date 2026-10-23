# 1flowbase-dsh-plugin

DeepSeek Harness Web profile 的 1flowbase 集成插件。它在设置页里管理 1flowbase 实例，并把 Agent Flow 应用注册成模型、把 MCP 实例挂成连接器工具。

设置页分两级：**实例列表** 只回答「我有哪些实例、接入了多少资源」；打开一个实例后进入 **详情视图**，用「应用 / MCP / 连接设置」三个标签管理这一个实例。页面只用 Harness 自带的 UI primitives，因此几何、圆角、焦点和 Escape 行为与设置里的其他页面一致。

**一个导入的 Agent Flow 应用 = 模型选择器里的一个供应商**，它的 `GET /v1/models` 目录整体成为该供应商下的模型：

![模型选择器](https://raw.githubusercontent.com/taichuy/1flowbase-dsh-plugin/main/docs/model-selector.png)

![实例列表](https://raw.githubusercontent.com/taichuy/1flowbase-dsh-plugin/main/docs/settings.png)

| 新建实例 | 实例详情 · 应用 | 实例详情 · MCP |
| --- | --- | --- |
| ![新建实例](https://raw.githubusercontent.com/taichuy/1flowbase-dsh-plugin/main/docs/create-instance.png) | ![应用](https://raw.githubusercontent.com/taichuy/1flowbase-dsh-plugin/main/docs/detail-applications.png) | ![MCP](https://raw.githubusercontent.com/taichuy/1flowbase-dsh-plugin/main/docs/detail-mcps.png) |

## 功能

1. **实例列表与详情**：新建、测试、删除实例；打开实例后按标签管理它的模型、MCP 和凭据。每个实例保存部署地址和一份长期凭据。
2. **两种登录方式**
   - **API Key**：直接填写 1flowbase 用户 API Key。
   - **登录授权**：填写账号密码，插件调用 1flowbase 登录接口并自动创建一枚长期用户 API Key。密码不会写入插件状态。
3. **导入 Agent Flow 应用为模型供应商**：列出当前凭据可见的 `agent_flow` 应用；导入时自动创建该应用的 Application API Key，读取它发布的 `/v1/models` 目录，并把**整个目录**注册成 Harness 模型选择器里的一个供应商分组（应用名 = 分组名，目录条目 = 分组下的模型）。
4. **编辑实例与轮换凭据**：改名、迁移地址、替换 API Key 或重新登录授权，都在「连接设置」标签里完成。地址或凭据变更前会先验证；变更后已启用的 MCP 会用新配置重新连接，重新连接失败的连接器以警告列出，实例本身仍然保存。
5. **挂载 MCP 实例**：列出当前工作区的 MCP 实例；启用后动态加载 Harness 自带 MCP client，把实例挂成连接器工具。每个实例的命名空间是 `mcp__<name>_<instance_id>__<tool>`，所以不同 MCP 的同名工具不会互相覆盖。AI 通过 `mcp_list` / `mcp_get` / `mcp_call` 自己发现和调用。

## 安装

从 npm 安装（插件只装到 `web` profile，不修改 Harness 主仓库）：

```bash
dsh plugin --profile web add 1flowbase-dsh-plugin@latest
dsh web
```

从本地源码安装：

```bash
cd /path/to/1flowbase-dsh-plugin
corepack enable
pnpm install
pnpm run build
dsh plugin --profile web add /absolute/path/to/1flowbase-dsh-plugin
dsh web
```

安装后打开 **设置 → 1flowbase**。

## 使用

### 新建实例

| 字段 | 说明 |
| --- | --- |
| 实例名称 | 显示在设置页和 MCP 命名空间里（不是模型选择器的分组名；分组名来自应用） |
| 1flowbase 地址 | 例如 `http://127.0.0.1:7800` 或 `https://1flowbase.example.com`，不要带查询参数 |
| API Key | 1flowbase 用户 API Key（`/api/console/user-api-keys` 创建的那种） |
| 登录授权 | 账号 + 密码。插件登录后自动创建用户 API Key，并用它完成后续所有调用 |

创建时会立即验证凭据：读取应用列表和 MCP catalog。验证失败不会保存实例。

### 打开实例

列表行显示实例名、地址、认证方式和「已接入 N 个应用 · N 个模型 · N 个 MCP」；行尾的 `⋯` 菜单提供打开 / 测试 / 删除。点击行进入详情：

| 标签 | 内容 |
| --- | --- |
| 应用 | 当前凭据可见的 `agent_flow` 应用；导入过的排在「已导入」分组并列出它发布的模型 id，其余在「未导入」分组 |
| MCP | 当前工作区的 MCP 实例，行尾开关即时启用 / 停用 |
| 连接设置 | 实例名、地址、认证方式与凭据（留空表示保持当前凭据） |

详情页头部的「‹ 实例」返回列表；「测试 / 编辑 / 删除」作用于当前实例。

### 编辑实例与轮换凭据

![连接设置](https://raw.githubusercontent.com/taichuy/1flowbase-dsh-plugin/main/docs/detail-connection.png)

「连接设置」标签对应 `POST /api/1flowbase/instances/:id/update`：

- 只填名称或地址时，凭据保持不变（输入框留空即不修改）。
- 切换「登录方式」或填入新 API Key / 账号密码时，插件先验证新凭据，再把实例写回状态文件；验证失败时旧配置继续生效。
- 地址或凭据变更后，已启用的 MCP 会断开并按新配置重连；重连失败的连接器不会回滚实例保存，而是以警告提示到「MCP」标签重新启用。

### 导入应用模型

在实例详情「应用」标签里选择 Agent Flow 应用，点击「导入」。映射关系：

```text
1flowbase 实例        -> 地址 + 长期凭据（只是凭据容器，不出现在模型选择器里）
1flowbase 应用        -> 一个 DSH provider（分组名 = 应用名）
应用 GET /v1/models   -> 该 provider 下的模型（模型 id = 应用发布的模型 id）
```

导入过程：

```text
应用列表（GET /api/console/applications）
  -> 创建 Application API Key（明文只在创建时返回）
  -> GET /v1/models（使用应用 Key，取回整份目录）
  -> 每个目录条目注册为一个模型，各自携带自己的 context window / 输出上限 / 推理强度
  -> 模型选择器出现「<应用名>」分组，下面列出全部模型
```

应用必须已经在 1flowbase 发布 API 并完成模型映射，否则导入会提示 `application/not-published`；只发布 0 个模型的应用不会被导入成空分组。

插件启动时、以及打开「应用」标签时，都会用应用自己的 `/v1/models` 对账本地目录：上游加了模型、改了上下文长度都会同步；上游暂时不可达时保留上一次的目录，不丢 provider。移除应用只删除本地注册，不撤销 1flowbase 里的 Application API Key。

模型目录中的 `reasoning.supported_efforts` 和 `reasoning.default_effort` 会同步到 DSH 原生模型选择器。选中模型后，打开「推理等级 / Effort」选择档位；所选值通过 `reasoning_effort` 原样发送给应用。插件不根据模型名称猜测档位，也不会给未声明推理能力的模型添加选项。已导入应用在重启或重新打开「应用」标签后自动补齐，无需删除重导入。

### 应用请求协议与远程压缩

点击「导入」时可选择协议；已导入应用行的「编辑」允许统一调整该供应商下所有模型，保留应用密钥、模型标识和目录。旧版本记录默认保持 Chat Completions。

| 协议 | 请求接口 | 传输 |
| --- | --- | --- |
| Chat Completions | `/v1/chat/completions` | HTTP / SSE |
| Responses | `/v1/responses` | WebSocket 优先，连接失败总计 5 次后 SSE |
| Anthropic Messages | `/v1/messages` | HTTP / SSE |

Responses 的失败预算按运行中的会话和供应商隔离，首次连接计入 5 次；成功连接不清除累计失败次数，降级后该会话/供应商保持 SSE，重启后重新尝试 WebSocket。鉴权或协议拒绝、取消、已经连接后的流中断不会被当成连接失败重放。后台标题生成使用 SSE，不消耗会话连接预算。

Responses 默认开启远程压缩，使用 `/v1/responses/compact`。应用必须支持该接口。插件保存原始加密压缩结果并用于后续 Responses 请求，不把它伪装成文本摘要；失败或取消时保留原历史。含原生压缩结果的会话必须继续使用原应用、原模型和 Responses 协议，否则明确报错，需新建会话后切换。

插件通过临时配置覆盖扩展使用 DSH 内置 BasicCompactionEngine 的 Agent preset，复用其压缩触发、锁、原子替换和保守的大小校验，不改写用户 preset 文件。自定义压缩引擎保持不变。已运行的 Agent 保留原 preset 代次；首次安装此能力后重启 DSH，使重新加载的会话使用新引擎。远程结果若未通过 DSH 的保守大小检查，不替换原历史。

### Application protocols and native compaction (English)

Choose a protocol in the Import dialog, or use **Edit** on an imported application. The selection applies to every model in that provider and keeps its application key and stable model ids. Existing imports remain on Chat Completions.

Responses prefers WebSocket. Five total connection failures (including the first attempt), accumulated per live session/provider, switch it to SSE for the rest of that runtime session. Successful connections do not reset the budget. Authentication/protocol rejections, cancellation, and failures after a connection opens are not replayed as connection attempts. Auxiliary title generation uses SSE.

Remote compaction is enabled by default for Responses and requires the application's `/v1/responses/compact` endpoint. Native encrypted output is durably retained and replayed without converting it into a text summary. Failed/cancelled compaction preserves prior history. A conversation containing native compacted context must stay on its original application/model and Responses protocol; start a new conversation to change routes.

The plugin extends presets using DSH's BasicCompactionEngine through a temporary effective-config overlay, retaining its atomic history transaction and conservative shrink check. User preset files and custom compaction engines are unchanged. Restart DSH after first installing this feature because running agents retain their existing preset generation. Results that fail the conservative shrink check do not replace history.

### 启用 MCP 实例

在实例详情「MCP」标签里打开开关。插件会：

```text
1flowbase MCP catalog
  -> 选择 MCP 实例 instance_id
  -> 动态挂载 @deepseek-ai/dsh-mcp-client
  -> URL: <baseUrl>/api/mcp/<instance_id>
  -> Authorization: Bearer <用户 API Key>
  -> 工具命名: mcp__<name>_<instance_id>__<tool>
```

启用成功后会立刻出现工具；停用会卸载连接和工具。重启 Harness 后，之前启用的实例会自动恢复。

在对话输入框输入 `@`，可以按 MCP 名称、1flowbase 实例名称或服务命名空间搜索已启用且成功挂载的实例。选择后插入引用标签；同名 MCP 通过所属实例和命名空间区分。发送时引用会解析为明确的 MCP 服务与工具命名空间，提示模型使用该实例，不会绕过工具权限或强制执行工具。

停用或删除后，该实例不再出现在下一次候选查询中。如果草稿中已经有引用，发送时会提示重新启用或移除引用。重启后连接恢复成功才重新提供候选。

### MCP references and reasoning effort (English)

After enabling an MCP instance, type `@` in the conversation composer and search by MCP name, 1flowbase instance name, or server namespace. Picking a result inserts a reference chip. On send, the plugin resolves it against the currently mounted connector and includes the server/tool namespace in the user message. This guides the model; it does not force a tool call or bypass permissions. Disabled, deleted, or unsuccessfully restored connectors are not offered. A stale draft reference blocks sending until it is removed or the connector is enabled again.

Imported models expose the exact `reasoning.supported_efforts` and optional `reasoning.default_effort` published by the application. Use the native model selector's **Effort** menu; the selected id is sent unchanged as `reasoning_effort`. Models without declared reasoning levels keep the provider default and gain no invented options. Existing imports refresh at plugin startup and when the Applications tab is opened, so re-importing is unnecessary.

## 状态与安全

- 状态文件：`$DSH_HOME/1flowbase-dsh-plugin/state.json`，目录 `0700`，文件 `0600`。可用 `DSH_1FLOWBASE_STATE_DIR` 覆盖目录。
- 状态文件格式为 `version: 2`（每个导入的应用保存整份模型目录）；`version: 1` 的旧文件会被自动读取并迁移，已导入的应用、应用 Key 和实例凭据都不丢，第一次写入时落成 v2。旧格式里只记录了 1 个模型，插件启动时会在后台对账补齐（打开「应用」标签也会对账），因此重启一次即可，不需要额外操作。
- 更新实例的接口是 `POST /api/1flowbase/instances/:id/update`；地址或凭据变更前先用新配置跑一次验证，验证失败时状态文件不变。
- 保存的内容包括用户 API Key、每个导入应用的 Application API Key、实例地址和名称。登录密码不保存。
- 浏览器端只能看到脱敏后的实例视图；API Key 不会出现在任何 HTTP 响应里。
- 设置 API 位于 `/api/1flowbase`，与 Harness 同源；写操作要求 `x-1flowbase-request: 1` 请求头，并拒绝跨站 Origin。
- 登录授权会创建真实的 1flowbase 用户 API Key；如需回收，在 1flowbase「设置 → API Key」中撤销。
- 登录密码在传输中依赖 1flowbase 地址的 HTTPS 保护；连接远程部署时请使用 `https://`，不要用明文 HTTP 发送账号密码。

## 架构

```text
Browser settings table
  -> /api/1flowbase (plugin-owned same-origin routes)
      -> StateStore (atomic JSON, 0600)
      -> ModelRegistry -> ctx.llm.registerAdapter (OpenAI-compatible adapter)
      -> McpRegistry   -> ctx.plugin(@deepseek-ai/dsh-mcp-client) per enabled MCP
```

Host 侧文件：

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | Cordis 入口、路由注册、生命周期 |
| `src/state.ts` | 原子状态文件、v1 → v2 状态迁移与校验 |
| `src/flowbase.ts` | 1flowbase console / app / MCP HTTP 客户端，登录换 API Key |
| `src/adapter.ts` | OpenAI Chat Completions → Harness `StreamChunk` |
| `src/reasoning.ts` | 应用推理能力 JSON 校验与 DSH 元数据投影 |
| `src/client/mcp-references.ts` | 原生 `@` 候选、引用标签与发送时解析 |
| `src/models.ts` | 应用导入、provider id 派生、应用目录对账与注册 |
| `src/mcp.ts` | MCP client 动态挂载与命名空间 |
| `src/http.ts` | `/api/1flowbase` 路由（含实例更新）与错误映射 |
| `src/client/panel.tsx` | 实例列表、详情视图、标签与行内操作 |
| `src/client/forms.tsx` | 创建弹窗、删除确认、连接设置表单 |
| `src/client/copy.ts` | 页面文案（中/英） |
| `src/client/styles.ts` | 仅保留布局样式；控件样式全部来自 UI primitives |

## 开发

```bash
pnpm install
pnpm run lint
pnpm test
pnpm run build
npm pack --dry-run
```

`pnpm run check` 依次执行类型检查、测试、构建和打包检查。

### 发布到 npm

仓库的 `.github/workflows/release.yml` 在推送 `v*` tag 或手动触发时执行检查并发布。首次使用前需要在 GitHub 仓库设置 `NPM_TOKEN` secret（npm Automation token）。

```bash
pnpm version patch      # 或 minor / major，自动生成 commit 和 tag
git push origin main --follow-tags
```

`pnpm version` 生成 tag 后，Actions 会用当前版本号发布到 npm。已经发布过的版本不要重复推 tag。

## 已知边界

- 应用模型是文本接口：图片和文件会以占位文本发送，不会上传二进制。
- 应用是否支持工具调用取决于 1flowbase 的兼容映射；不支持时请求会自动退化为不带 tools 的调用。
- 登录授权自动创建的用户 API Key 默认有效期 1 年，可在创建时选择 30 天、1 年、3 年或永久。
- 模型 id 就是应用 `/v1/models` 里发布的 id（例如 `claude-opus-5-5`），不是应用 id；应用改名只改分组显示名，provider id 由实例 id + 应用 id 派生，因此不会漂移。
- 应用在 1flowbase 侧下线或目录清空后，该分组会在下一次对账时消失；想立刻生效可以重启 Harness。
- 删除实例不会撤销 1flowbase 中已创建的 API Key；更换凭据后旧 API Key 同样需要到 1flowbase 后台撤销。
- 更换地址或凭据后，已启用的 MCP 会重新连接；若某个连接失败，实例仍保存，并在页面上以警告提示到「MCP」标签重新启用。
- 页面文案跟随浏览器语言（`navigator.language`），不注入 Harness 的语言服务。
- MCP 动态挂载依赖运行中的 DSH 安装自带 `@deepseek-ai/dsh-mcp-client`；插件会优先从 DSH 安装目录解析，避免复制第二份 MCP 运行时。
