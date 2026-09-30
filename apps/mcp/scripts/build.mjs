// Bundles jasper-mcp into one executable ESM file: apps/mcp/dist/jasper-mcp.mjs (`pnpm mcp:build`).
// Everything (the MCP SDK, zod, @jasper/*) is inlined, so the file runs with plain `node` from anywhere
// (and with Electron's binary under ELECTRON_RUN_AS_NODE=1 in the packaged desktop app).
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'dist/jasper-mcp.mjs');
await build({
	entryPoints: [join(root, 'src/cli.ts')],
	outfile,
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: false,
	legalComments: 'none',
	banner: {
		js: "#!/usr/bin/env node\nimport { createRequire as __jasperCreateRequire } from 'node:module'; const require = __jasperCreateRequire(import.meta.url);",
	},
	logLevel: 'info',
});
chmodSync(outfile, 0o755);
