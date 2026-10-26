// The export cost of cut kits (spec 15 EA-033, AGENTS §5): a 1080p 30 fps edit of 101 pictures (100 cuts, 2 s each)
// exported as it is (native) and with 100 long-form kits from Decorate Cuts (the Remotion path the planner routes them
// to), wall time of each export with the same settings; and the same with the shorts shake kit. Opt-in: KITS_BENCH=1
// (plus REMOTION_E2E environment: headless Chrome, ffmpeg). Hold the bench lock while it runs (wp-note).
import { writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningEngine } from '../src/index.ts';
import type { DocBuilder } from './helpers.ts';
import { tempAppdir } from './temp.ts';

const enabled = process.env.KITS_BENCH === '1';
let engineApi: typeof import('../src/index.ts');
let services: typeof import('../src/tools/services.ts');
let helpers: typeof import('./helpers.ts');
let project: typeof import('@jasper/project');
if (enabled)
	[engineApi, services, helpers, project] = await Promise.all([
		import('../src/index.ts'),
		import('../src/tools/services.ts'),
		import('./helpers.ts'),
		import('@jasper/project'),
	]);

const CLIP = 60;
const CLIPS = 101;
const settings = (sequenceId: string) => ({
	sequenceId,
	range: { type: 'entire' },
	container: 'mp4',
	engine: 'auto',
	video: {
		codec: 'h264',
		width: 1920,
		height: 1080,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 20 },
		encoderSpeed: 'fast',
	},
});

describe.runIf(enabled)('cut kit export cost (KITS_BENCH=1)', () => {
	let engine: RunningEngine;
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });
	beforeAll(async () => {
		engine = await engineApi.startEngine({
			appdir: tempAppdir('jasper-kits-bench-'),
			port: 0,
			insecure: true,
			dev: true,
			env: {
				PATH: process.env.PATH,
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
	}, 600_000);
	afterAll(async () => engine?.stop());

	function edit(preset: string): DocBuilder {
		const d = new helpers.DocBuilder(preset);
		const colours = [
			[0.1, 0.2, 0.8, 1],
			[0.15, 0.6, 0.2, 1],
			[0.7, 0.2, 0.3, 1],
		];
		d.tx([
			...Array.from({ length: CLIPS }, (_, i) => ({
				type: 'clip.addSolid',
				at: i * CLIP,
				duration: CLIP,
				track: 'V1',
				color: colours[i % 3],
			})),
			{ type: 'track.add', kind: 'video' },
			{ type: 'clip.addSolid', at: 0, duration: CLIPS * CLIP, track: 'V2', color: [0.95, 0.8, 0.1, 1], ref: '$sq' },
			{ type: 'param.set', target: ['clip', '$sq', 'transform', 'scale'], value: 20 },
		]);
		return d;
	}

	async function timedExport(d: DocBuilder) {
		const t0 = performance.now();
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...helpers.JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(r.statusCode, r.body).toBe(202);
		const done = await services.coreServices(engine.app).queue.wait(r.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		return { seconds: (performance.now() - t0) / 1000, path: (done.result as { renderPath?: string }).renderPath };
	}

	it('100 kits: native vs Remotion export time', async () => {
		const out: Record<string, unknown> = {
			machine: { cpus: cpus().length, model: cpus()[0]?.model, memGB: Math.round(totalmem() / 2 ** 30) },
			loadBefore: loadavg(),
			frames: CLIPS * CLIP,
			at: new Date().toISOString(),
		};
		const plain = edit('hd-1080p-30');
		const pt = await timedExport(plain);
		out.plain = pt;
		for (const pack of ['long-pack', 'shorts-shake'] as const) {
			const d = edit('hd-1080p-30');
			const plan = project.planDecorateCuts(d.doc, d.seqId, { pack, sfx: { enabled: false }, seed: 1 });
			expect(plan.kits.length).toBe(100);
			d.tx(project.passItems(d.doc, plan).items.flatMap((it) => it.commands));
			const t = await timedExport(d);
			out[pack] = { ...t, families: plan.families, perKitSeconds: (t.seconds - pt.seconds) / 100 };
		}
		out.loadAfter = loadavg();
		console.info(`[kits bench] ${JSON.stringify(out)}`);
		writeFileSync(join(process.cwd(), 'bench', 'automation-kits.results.json'), `${JSON.stringify(out, null, 2)}\n`);
	}, 7_200_000);
});
