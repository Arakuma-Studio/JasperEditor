// The tracking job and the warp pool inside the esbuild bundle (dist/engine.mjs is built with the options of
// scripts/build.mjs): their worker threads evaluate function source text, which must survive bundling (renamed
// symbols, ESM `require` shims). Builds a small bundle with the same options and runs both from it.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureFixtures, FIXTURES, fixture, ROOT } from './helpers.ts';

const ENGINE = join(ROOT, 'apps', 'engine');
const OUT = join(ENGINE, 'node_modules', '.cache', 'jasper-tracking-bundle', 'bundle.mjs');

beforeAll(async () => {
	ensureFixtures();
	mkdirSync(join(OUT, '..'), { recursive: true });
	// Same options as scripts/build.mjs (entry aside).
	await build({
		stdin: {
			contents: [
				"export { TrackingService } from './src/tracking/service.ts';",
				"export { WarpPool } from './src/export/warp/pool.ts';",
				"export { Broadcaster } from './src/events/broadcaster.ts';",
				"export { Ffmpeg, resolveBinaries } from './src/tools/ffmpeg.ts';",
			].join('\n'),
			resolveDir: ENGINE,
			loader: 'ts',
			sourcefile: 'tracking-bundle-entry.ts',
		},
		outfile: OUT,
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node20',
		legalComments: 'none',
		external: ['@remotion/*', 'remotion', 'esbuild', 'fsevents', '*.node'],
		banner: {
			js: "import { createRequire as __jasperCreateRequire } from 'node:module'; const require = __jasperCreateRequire(import.meta.url);",
		},
		logLevel: 'error',
	});
}, 120_000);

describe('bundled engine (scripts/build.mjs options)', () => {
	it('runs a planar track job from the bundle', async () => {
		const mod = await import(pathToFileURL(OUT).href);
		const truth = JSON.parse(readFileSync(join(FIXTURES, 'plate-planar.json'), 'utf8'));
		const core = { ffmpeg: new mod.Ffmpeg(mod.resolveBinaries()), broadcaster: new mod.Broadcaster() };
		const svc = new mod.TrackingService(core);
		const request = {
			mediaKey: 'mk_bundle',
			kind: 'planar',
			reference: { frame: 75, corners: truth.corners[75] },
			range: { startFrame: 70, endFrame: 85 },
			direction: 'both',
			quality: 'fast',
			options: { refineEdges: true },
		};
		const ctx = {
			job: { id: 'job_bundle' },
			input: {
				request,
				file: fixture('plate-planar.mp4'),
				display: { width: 1920, height: 1080 },
				fps: { num: 30, den: 1 },
				frameCount: 150,
			},
			signal: new AbortController().signal,
			slots: 2,
			progress: () => undefined,
			trackChild: () => undefined,
			addPartial: () => undefined,
			scratchDir: async () => '/tmp',
			log: () => undefined,
		};
		try {
			const result = await svc.runner(ctx);
			expect(result.startFrame).toBe(70);
			expect(result.data).toHaveLength(15 * 8);
			let max = 0;
			for (let i = 0; i < 15; i++)
				for (let k = 0; k < 4; k++)
					max = Math.max(
						max,
						Math.hypot(
							result.data[i * 8 + 2 * k] - truth.corners[70 + i][k][0],
							result.data[i * 8 + 2 * k + 1] - truth.corners[70 + i][k][1],
						),
					);
			expect(max).toBeLessThan(1.5);
		} finally {
			svc.shutdown();
		}
	}, 120_000);

	it('runs the warp pool workers from the bundle', async () => {
		const mod = await import(pathToFileURL(OUT).href);
		const pool = new mod.WarpPool({ sw: 4, sh: 4, dw: 4, dh: 4, format: 'rgba' }, { workers: 1, slots: 1 });
		try {
			const slot = pool.slots[0];
			slot.src.fill(255);
			await pool.run({ slot, inv: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity: 1, rect: [0, 0, 4, 4] });
			expect(slot.dst[(1 * 4 + 1) * 4 + 3]).toBe(255);
		} finally {
			await pool.close();
		}
	}, 60_000);
});
