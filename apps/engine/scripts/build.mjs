// Bundles the engine to dist/engine.mjs (ESM) for Electron's utilityProcess and server installs
// (ARCHITECTURE §9.1, D-17). Remotion packages and binaries stay external.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await build({
	entryPoints: [join(root, 'src/cli.ts')],
	outfile: join(root, 'dist/engine.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: true,
	legalComments: 'none',
	external: ['@remotion/*', 'remotion', 'esbuild', 'fsevents', '*.node'],
	banner: {
		js: "import { createRequire as __jasperCreateRequire } from 'node:module'; const require = __jasperCreateRequire(import.meta.url);",
	},
	logLevel: 'info',
});
