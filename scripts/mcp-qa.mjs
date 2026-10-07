#!/usr/bin/env node
// `pnpm qa:mcp`: the MCP scenario QA suite (docs/wp-notes/mcp-cli.md §6) — rough cut, colour grade, titles,
// transitions, keyframes, export + re-import and cancellation, driven over real MCP JSON-RPC against a real
// engine with pixel assertions. Also runs with the opt-in render tier (REMOTION_E2E=1).
// MCP_QA_PORT picks the engine port (default 49025); MCP_QA_KEEP=1 keeps the rendered frames in
// test-results/mcp-qa/.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync(
	'pnpm',
	[
		'exec',
		'vitest',
		'run',
		'--project',
		'@jasper/mcp',
		'apps/mcp/test/qa/',
		'--maxWorkers=1',
		...process.argv.slice(2),
	],
	{ cwd: root, stdio: 'inherit', env: { ...process.env, MCP_QA: '1' } },
);
process.exit(r.status ?? 1);
