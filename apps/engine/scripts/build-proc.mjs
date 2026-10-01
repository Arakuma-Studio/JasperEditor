// Bundles jasper-proc (S07:PRC-011) into a self-contained directory (default apps/engine/dist):
//
//   jasper-proc.mjs        the CLI (esbuild ESM bundle; @jasper/* and zod inlined)
//   dejudder-worker.mjs    the de-judder warp worker (worker_threads entry)
//   vidstab.wasm (+ VIDSTAB-WASM.json, LICENSE-vidstab.txt)   the LGPL vid.stab WASM module
//   models/                bundled super-resolution models (+ licences, provenance)
//   jasper-proc.package.json   the runtime dependencies (onnxruntime-node, OpenCV.js) pinned exactly like
//                          apps/engine/package.json — remote setup uploads it as package.json and runs npm install
//
// onnxruntime-node (native binding) and @techstark/opencv-js (10 MB of JS/WASM) stay external: locally they
// resolve from apps/engine/node_modules (or the packaged app's node_modules), remotely from npm install.
//
//   node apps/engine/scripts/build-proc.mjs [--out <dir>]
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const out = outIdx >= 0 ? argv[outIdx + 1] : join(root, 'dist');
mkdirSync(out, { recursive: true });

export const PROC_EXTERNALS = ['onnxruntime-node', '@techstark/opencv-js', '*.node'];
const banner =
	"import { createRequire as __jasperCreateRequire } from 'node:module'; const require = __jasperCreateRequire(import.meta.url);";
const common = {
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: false,
	legalComments: 'none',
	external: PROC_EXTERNALS,
	banner: { js: banner },
	logLevel: 'warning',
	loader: { '.wasm': 'file' },
};

const procDir = join(root, 'src', 'processing', 'proc');
await build({ ...common, entryPoints: [join(procDir, 'cli.ts')], outfile: join(out, 'jasper-proc.mjs') });
chmodSync(join(out, 'jasper-proc.mjs'), 0o755);

// The de-judder worker (worker_threads entry, bundled separately; dejudder/pool.ts resolveWorkerUrl finds it
// next to the bundle). opencv.js is CommonJS and reads __dirname under Node: the banner defines it. OpenCV.js
// is inlined here (the worker is ~11 MB) so the worker has no runtime dependency.
const workerBanner =
	"import { createRequire as __jcr } from 'node:module'; import { fileURLToPath as __jfu } from 'node:url'; import { dirname as __jdn } from 'node:path'; const require = __jcr(import.meta.url); const __filename = __jfu(import.meta.url); const __dirname = __jdn(__filename);";
await build({
	...common,
	external: ['*.node'],
	banner: { js: workerBanner },
	entryPoints: [join(procDir, 'dejudder', 'worker.mjs')],
	outfile: join(out, 'dejudder-worker.mjs'),
});

// vid.stab WASM module and its licence/provenance.
const vsDir = join(procDir, 'vidstab');
for (const f of ['vidstab.wasm', 'VIDSTAB-WASM.json', 'LICENSE-vidstab.txt', 'NOTICE-vidstab.txt']) {
	if (existsSync(join(vsDir, f))) copyFileSync(join(vsDir, f), join(out, f));
}

// Bundled models.
const modelsSrc = join(root, 'models');
if (existsSync(modelsSrc)) {
	mkdirSync(join(out, 'models'), { recursive: true });
	for (const f of readdirSync(modelsSrc)) copyFileSync(join(modelsSrc, f), join(out, 'models', f));
}

// Runtime dependencies for a standalone install (remote hosts).
const enginePkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const deps = {};
for (const d of ['onnxruntime-node', '@techstark/opencv-js']) deps[d] = enginePkg.dependencies[d];
writeFileSync(
	join(out, 'jasper-proc.package.json'),
	`${JSON.stringify({ name: 'jasper-proc-runtime', private: true, type: 'module', dependencies: deps }, null, 2)}\n`,
);
console.log(`[build-proc] ${out}/jasper-proc.mjs`);
