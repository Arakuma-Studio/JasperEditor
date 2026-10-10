// Bundles jasper-mcp and the `jasper` CLI into executable ESM files: apps/mcp/dist/jasper-mcp.mjs and
// apps/mcp/dist/jasper.mjs (`pnpm mcp:build`).
// Everything (the MCP SDK, zod, @jasper/*) is inlined, so the file runs with plain `node` from anywhere
// (and with Electron's binary under ELECTRON_RUN_AS_NODE=1 in the packaged desktop app).
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { BUILD_OPTIONS } from './build-options.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const [entry, out] of [
	['src/cli.ts', 'dist/jasper-mcp.mjs'],
	// mcp-cli: the one-shot `jasper` CLI (same tools, run in process).
	['src/jasper.ts', 'dist/jasper.mjs'],
]) {
	const outfile = join(root, out);
	await build({ ...BUILD_OPTIONS, entryPoints: [join(root, entry)], outfile, logLevel: 'info' });
	chmodSync(outfile, 0o755);
}
