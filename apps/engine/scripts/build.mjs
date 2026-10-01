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

// Clip processing (wp-m2-process, S07:PRC-011): jasper-proc.mjs, its worker, the vid.stab WASM module and the
// bundled models next to engine.mjs; licence texts the engine shows in Help ▸ About ▸ Licenses.
{
	const { spawnSync } = await import('node:child_process');
	const { cpSync, mkdirSync } = await import('node:fs');
	const r = spawnSync(
		process.execPath,
		[join(root, 'scripts', 'build-proc.mjs'), '--out', join(root, 'dist')],
		{
			stdio: 'inherit',
		},
	);
	if (r.status !== 0) throw new Error('build-proc failed');
	mkdirSync(join(root, 'dist', 'third-party'), { recursive: true });
	cpSync(join(root, 'src', 'processing', 'third-party'), join(root, 'dist', 'third-party'), {
		recursive: true,
	});
}
