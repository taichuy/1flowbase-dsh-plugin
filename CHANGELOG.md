# Changelog

## 0.2.0

- Rework the settings page into two levels: an instance list, then one instance's detail view with 模型 / MCP / 连接设置 tabs, so the list no longer pushes the detail it selects off screen.
- Rebuild the page on the shell's `@deepseek-ai/dsh-client-ui-primitives`: modals, menus, inputs, tabs, switches and tags now carry the host's geometry, tokens and focus treatment. The create dialog is a registered modal layer, so Escape closes it (and returns focus to its trigger) instead of closing Settings, and Tab stays inside it.
- Add `POST /api/1flowbase/instances/:id/update`: rename, move the address, or replace the credential (API key or account sign-in). The connection is verified before anything is persisted, and enabled MCP connectors are remounted onto the new address/credential; a failed remount is reported as a warning instead of rolling back the save.
- Replace the instance table's per-row filled buttons with row cards plus a `⋯` overflow menu (测试 / 打开 / 删除), and load destructive confirmation in a modal instead of `window.confirm`.
- Localize the MCP state tags (the raw upstream `status` no longer leaks English into a Chinese page) and drop raw UUID subtitles.

## 0.1.0

- Add the 1flowbase instance table under Settings → 1flowbase.
- Support API Key and account sign-in (sign-in exchanges a durable user API key).
- Import published Agent Flow applications as DeepSeek Harness models through the OpenAI-compatible application endpoint.
- Mount 1flowbase MCP instances as dynamic `mcp-client` connectors named `<name>_<instance_id>`.
- Persist instances, imported models and enabled MCPs in `$DSH_HOME/1flowbase-dsh-plugin/state.json`.
