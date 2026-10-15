// Bundles the engine to dist/engine.mjs (ESM) for Electron's utilityProcess and server installs
// (ARCHITECTURE §9.1, D-17). Remotion packages and binaries stay external; so does pdfjs-dist (imports: it loads its
// worker module relative to its own files), staged with the runtime closure by the desktop packager.

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
	external: ['@remotion/*', 'remotion', 'esbuild', 'fsevents', 'pdfjs-dist', 'pdfjs-dist/*', '*.node'],
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
	// M2 (S11): the anime.js licence text for About ▸ Licenses (the package itself ships in the Remotion bundle).
	cpSync(join(root, 'src', 'anime', 'third-party'), join(root, 'dist', 'third-party'), { recursive: true });
	// Sound design (spec 12 §2.1): the bundled starter kit (`manifest.json`, the audio files and their
	// `.attribution` sidecars) next to engine.mjs, where `src/sounds/starter.ts` looks for `sounds/starter`.
	const { existsSync, rmSync } = await import('node:fs');
	rmSync(join(root, 'dist', 'sounds'), { recursive: true, force: true });
	if (existsSync(join(root, 'sounds')))
		cpSync(join(root, 'sounds'), join(root, 'dist', 'sounds'), { recursive: true });
}

// Sound design (spec 12 WP1.2): the sound-analysis worker thread (`analyzeSound` + visual data off the engine's main
// thread), loaded by src/sounds/analysis.ts from `sound-worker.mjs` next to engine.mjs.
await build({
	entryPoints: [join(root, 'src/sounds/analysis-worker.ts')],
	outfile: join(root, 'dist/sound-worker.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: false,
	legalComments: 'none',
	banner: {
		js: "import { createRequire as __jasperCreateRequire } from 'node:module'; const require = __jasperCreateRequire(import.meta.url);",
	},
	logLevel: 'warning',
});

// wp speech: jasper-speech.mjs (the speech-to-text worker, run as a child process by `transcription` jobs) next to
// engine.mjs. onnxruntime-node (native binding) stays external like jasper-proc's.
await build({
	entryPoints: [join(root, 'src/speech/worker/cli.ts')],
	outfile: join(root, 'dist/jasper-speech.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: false,
	legalComments: 'none',
	external: ['onnxruntime-node', '*.node'],
	banner: {
		js: "import { createRequire as __jasperCreateRequire } from 'node:module'; const require = __jasperCreateRequire(import.meta.url);",
	},
	logLevel: 'warning',
});

// three-d: jasper-camtrack.mjs (3D Camera Tracker feature tracking + camera solve, run as a child process by `camtrack`
// jobs) next to engine.mjs. OpenCV.js (staged with the engine runtime) stays external.
await build({
	entryPoints: [join(root, 'src/camtrack/worker/cli.ts')],
	outfile: join(root, 'dist/jasper-camtrack.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: false,
	legalComments: 'none',
	external: ['@techstark/opencv-js', '*.node'],
	banner: {
		js: "import { createRequire as __jasperCreateRequire } from 'node:module'; const require = __jasperCreateRequire(import.meta.url);",
	},
	logLevel: 'warning',
});

// parity roto: jasper-roto.mjs (Roto Brush segmentation / face tracking, run as a child process by `roto` jobs) next to
// engine.mjs. onnxruntime-node (native binding) and OpenCV.js (staged with the engine runtime) stay external.
await build({
	entryPoints: [join(root, 'src/roto/worker/cli.ts')],
	outfile: join(root, 'dist/jasper-roto.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: false,
	legalComments: 'none',
	external: ['onnxruntime-node', '@techstark/opencv-js', '*.node'],
	banner: {
		js: "import { createRequire as __jasperCreateRequire } from 'node:module'; const require = __jasperCreateRequire(import.meta.url);",
	},
	logLevel: 'warning',
});
