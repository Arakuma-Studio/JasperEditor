import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const common = {
	bundle: true,
	platform: 'node',
	target: 'node20',
	sourcemap: true,
	external: ['electron'],
	logLevel: 'info',
};
await Promise.all([
	build({
		...common,
		entryPoints: [join(root, 'src/main.ts')],
		outfile: join(root, 'dist-electron/main.mjs'),
		format: 'esm',
	}),
	build({
		...common,
		entryPoints: [join(root, 'src/preload.cts')],
		outfile: join(root, 'dist-electron/preload.cjs'),
		format: 'cjs',
	}),
]);
