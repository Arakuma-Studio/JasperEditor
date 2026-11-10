# Setup

The skill needs the `jasper` MCP server (`jasper-mcp`) connected to your agent and a running JasperEditor engine
(the desktop app, `pnpm dev`, or a headless engine started by the server with `--start-engine`). The repository
README section "Use JasperEditor from Claude Code / Codex / Cursor" has the exact commands; in the app,
Help ▸ Connect an AI Agent… shows them with real paths.

- Check the connection: `call_tool` {"name": "engine_status"} (the engine's capabilities), or `list_projects`.
- The session advertises the `core` toolset. Other tools: `list_toolsets` {"names": [...]}, `describe_tool`,
  `call_tool`; or start the server with `--toolsets all` / `JASPER_MCP_TOOLSETS=all` to advertise every tool from the start
  (more context per turn). Every tool is always reachable through `call_tool`.
- Guides: `get_guide` {"topic"} (`get_guide` without a topic lists them); the resource jasper://guide/routing maps requests to tools.
- Before a long export with titles, shapes or effects, check `engine_status` → `render.remotionGraphics`. With
  `hardware: false` the render browser draws on the CPU (SwiftShader) and the layer bake takes hours; `start_export`'s
  plan warns about it too. Tell the user before starting the export. The warning names the fix: restart the engine
  inside the desktop session, or with its `DISPLAY` and `XAUTHORITY`, or set `JASPER_REMOTION_GL=angle-egl`.
- The same tools run from a shell with the `jasper` CLI: `jasper call <tool> k=v…`, `jasper tools`,
  `jasper export --out cut.mp4`.
