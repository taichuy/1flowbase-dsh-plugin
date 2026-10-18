# 1flowbase-dsh-plugin

DeepSeek Harness Web profile 的 1flowbase 集成插件。它把 1flowbase 实例、Agent Flow 应用模型和 MCP 实例放进同一个设置页表格里管理。

## 功能

1. **实例表格**：新建、测试、删除 1flowbase 实例。每个实例保存部署地址和一份长期凭据。
2. **两种登录方式**
   - **API Key**：直接填写 1flowbase 用户 API Key。
   - **登录授权**：填写账号密码，插件调用 1flowbase 登录接口并自动创建一枚长期用户 API Key。密码不会写入插件状态。
3. **导入 Agent Flow 应用模型**：列出当前凭据可见的 `agent_flow` 应用；导入时自动创建该应用的 Application API Key，读取应用模型元数据，并注册成 Harness 模型选择器里的一个模型。
4. **挂载 MCP 实例**：列出当前工作区的 MCP 实例；启用后动态加载 Harness 自带 MCP client，把实例挂成连接器工具。每个实例的命名空间是 `mcp__<name>_<instance_id>__<tool>`，所以不同 MCP 的同名工具不会互相覆盖。AI 通过 `mcp_list` / `mcp_get` / `mcp_call` 自己发现和调用。

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
| 实例名称 | 显示在模型选择器和 MCP 命名空间里 |
| 1flowbase 地址 | 例如 `http://127.0.0.1:7800` 或 `https://1flowbase.example.com`，不要带查询参数 |
| API Key | 1flowbase 用户 API Key（`/api/console/user-api-keys` 创建的那种） |
| 登录授权 | 账号 + 密码。插件登录后自动创建用户 API Key，并用它完成后续所有调用 |

创建时会立即验证凭据：读取应用列表和 MCP catalog。验证失败不会保存实例。

### 导入应用模型

在实例详情左栏选择 Agent Flow 应用，点击「导入」。导入过程：

```text
1flowbase 应用列表
  -> 创建 Application API Key（明文只在创建时返回）
  -> GET /v1/models（使用应用 Key）
  -> 注册 Harness provider + model
  -> 模型选择器出现「<实例名> / <应用名>」
```

应用必须已经在 1flowbase 发布 API 并完成模型映射，否则导入会提示 `application/not-published`。移除模型只删除本地注册，不撤销 1flowbase 里的 Application API Key。

### 启用 MCP 实例

在实例详情右栏点击「启用」。插件会：

```text
1flowbase MCP catalog
  -> 选择 MCP 实例 instance_id
  -> 动态挂载 @deepseek-ai/dsh-mcp-client
  -> URL: <baseUrl>/api/mcp/<instance_id>
  -> Authorization: Bearer <用户 API Key>
  -> 工具命名: mcp__<name>_<instance_id>__<tool>
```

启用成功后会立刻出现工具；停用会卸载连接和工具。重启 Harness 后，之前启用的实例会自动恢复。

## 状态与安全

- 状态文件：`$DSH_HOME/1flowbase-dsh-plugin/state.json`，目录 `0700`，文件 `0600`。可用 `DSH_1FLOWBASE_STATE_DIR` 覆盖目录。
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
| `src/state.ts` | 原子状态文件与校验 |
| `src/flowbase.ts` | 1flowbase console / app / MCP HTTP 客户端，登录换 API Key |
| `src/adapter.ts` | OpenAI Chat Completions → Harness `StreamChunk` |
| `src/models.ts` | 应用导入与 provider 注册 |
| `src/mcp.ts` | MCP client 动态挂载与命名空间 |
| `src/http.ts` | `/api/1flowbase` 路由与错误映射 |
| `src/client/` | 设置页表格、创建弹窗、模型/MCP 面板 |

## 开发

```bash
pnpm install
pnpm run lint
pnpm test
pnpm run build
npm pack --dry-run
```

`pnpm run check` 依次执行类型检查、测试、构建和打包检查。

## 已知边界

- 应用模型是文本接口：图片和文件会以占位文本发送，不会上传二进制。
- 应用是否支持工具调用取决于 1flowbase 的兼容映射；不支持时请求会自动退化为不带 tools 的调用。
- 登录授权自动创建的用户 API Key 默认有效期 1 年，可在创建时选择 30 天、1 年、3 年或永久。
- 删除实例不会撤销 1flowbase 中已创建的 API Key。
- MCP 动态挂载依赖运行中的 DSH 安装自带 `@deepseek-ai/dsh-mcp-client`；插件会优先从 DSH 安装目录解析，避免复制第二份 MCP 运行时。
