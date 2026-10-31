# Setup

The skill needs the `jasper` MCP server (`jasper-mcp`) connected to your agent and a running JasperEditor engine
(the desktop app, `pnpm dev`, or a headless engine started by the server with `--start-engine`). The repository
README section "Use JasperEditor from Claude Code / Codex / Cursor" has the exact commands; in the app,
Help ▸ Connect an AI Agent… shows them with real paths.

- Check the connection: `call_tool` {"name": "engine_status"} (the engine's capabilities), or `list_projects`.
- The session advertises the `core` toolset. More toolsets: `list_toolsets`, `enable_toolsets` {"names": [...]};
  or start the server with `--toolsets all` / `JASPER_MCP_TOOLSETS=all` to advertise every tool from the start
  (more context per turn). Every tool is always reachable through `call_tool`.
- Guides: `get_guide` {"topic"} (the topics are listed in the server instructions and by `get_guide` without a
  topic); the resource jasper://guide/routing maps requests to tools.
- The same tools run from a shell with the `jasper` CLI: `jasper call <tool> k=v…`, `jasper tools`,
  `jasper export --out cut.mp4`.
