# Changelog

## 0.1.0

- Add the 1flowbase instance table under Settings → 1flowbase.
- Support API Key and account sign-in (sign-in exchanges a durable user API key).
- Import published Agent Flow applications as DeepSeek Harness models through the OpenAI-compatible application endpoint.
- Mount 1flowbase MCP instances as dynamic `mcp-client` connectors named `<name>_<instance_id>`.
- Persist instances, imported models and enabled MCPs in `$DSH_HOME/1flowbase-dsh-plugin/state.json`.
