// Locates the `jasper-mcp` stdio bundle that belongs to this engine, for Help ▸ Connect an AI Agent…
// (GET /api/agent/mcp-info). Layouts: a checkout has apps/mcp/dist/jasper-mcp.mjs next to apps/engine
// (the engine runs from apps/engine/src/** or apps/engine/dist); a packaged desktop app has
// resources/mcp/jasper-mcp.mjs next to resources/engine. JASPER_MCP_ENTRY overrides both.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV, type Env } from '@jasper/config';

const MCP_BUNDLE_NAME = 'jasper-mcp.mjs';

export function findMcpEntry(
	env: Env = process.env,
	here = dirname(fileURLToPath(import.meta.url)),
): string | null {
	const explicit = env[ENV.MCP_ENTRY];
	if (explicit) return existsSync(explicit) ? resolve(explicit) : null;
	let dir = resolve(here);
	for (let i = 0; i < 5; i++) {
		for (const c of [join(dir, 'mcp', 'dist', MCP_BUNDLE_NAME), join(dir, 'mcp', MCP_BUNDLE_NAME)])
			if (existsSync(c)) return c;
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return null;
}
