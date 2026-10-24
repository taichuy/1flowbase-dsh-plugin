# Changelog

## 0.6.0-local.1 (local preview)

- Reuse Responses WebSocket connections and send safe incremental continuations, with full-history recovery for unsupported or expired continuations.
- Resolve Responses image inputs through the host durable attachment service for generation and remote compaction.
- Negotiate WebSocket compression explicitly and send honest client identity with opaque session/cache affinity.
- This preview is installed locally and is not an npm release.

## 0.5.0

- Add application-wide import/edit selection for Chat Completions, Responses and Anthropic Messages.
- Prefer Responses WebSocket with a five-total-connection-failure, session/provider-scoped SSE fallback.
- Preserve native Responses compaction checkpoints through DSH history and reject incompatible route switches.
- Reuse the host Anthropic implementation with reasoning-effort and thinking-signature replay.

## 0.4.0

- Add native `@` references for enabled, mounted MCP instances, with disambiguation across 1flowbase connections and send-time validation.
- Import and persist published reasoning efforts and defaults, refresh existing imports, notify the model selector on capability changes, and forward the selected `reasoning_effort` to the application.

## 0.3.1

- Reconcile every imported application's catalogue in the background at startup, so restarting is enough to pick up the models a version 1 migration could not know about; previously they only appeared after opening the settings page.

## 0.3.0

- Fix the model mapping: an imported Agent Flow **application** is now one model provider, and the whole catalogue it publishes through `GET /v1/models` becomes that provider's models. Previously every instance was a single provider and an import exposed only the first catalogue entry — a five-model application showed up as one model.
- Provider ids now derive from `instance id + application id` and the group label is the application name only, so a rename never moves a route and the instance stays a credential container.
- Each model carries its own context window and output limit; the model id is the catalogue's model id (for example `claude-opus-5-5`).
- Reading the application list reconciles each imported application's catalogue with its own `/v1/models`; an unreachable catalogue keeps the stored models instead of dropping the provider.
- State moves to `version: 2` (`applications[]` with a `models[]` catalogue). `version: 1` files are migrated on read and written back as version 2, so existing instances and credentials survive the upgrade.
- `resolveModel` now rejects instead of throwing synchronously, matching its Promise-returning contract.

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
