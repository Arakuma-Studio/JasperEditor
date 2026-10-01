// Colour grading on the Remotion path (S06:CG-042, §9 test 6): a graded clip in a sequence that also has a text
// clip (forces Remotion) renders graded through the compositions' WebGL2 colour stage; an engine without WebGL2
// fails such renders with WEBGL_UNAVAILABLE (never silently ungraded).
// The browser part is gated by REMOTION_E2E=1 (bundles the compositions, launches headless Chrome).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	applyLut,
	bakeColorRun,
	defaultEffectRegistry,
	LUMETRI_EFFECT_ID,
	parseCube,
	type Rgb,
} from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	ROOT,
	register,
	tempAppdir,
} from './helpers.ts';

const stops: (() => Promise<void>)[] = [];
afterAll(async () => {
	await closeApps();
	for (const s of stops) await s();
});

const GRADE = (look: string) => ({
	temperature: -30,
	tint: 6,
	exposure: 0.3,
	contrast: 15,
	highlights: -25,
	shadows: 30,
	saturation: 115,
	look: { mediaId: look },
	lookIntensity: 80,
	vibrance: 15,
	curveMaster: {
		curve: [
			[0, 0.02],
			[0.5, 0.52],
			[1, 0.98],
		],
	},
	midtonesWheel: [0.1, 0.2],
});

const FFMPEG = (() => {
	const vendor = join(ROOT, 'vendor', 'ffmpeg-lgpl', 'linux-x64', 'ffmpeg');
	return process.env.JASPER_FFMPEG || (spawnSync(vendor, ['-version']).status === 0 ? vendor : 'ffmpeg');
})();
const rgb = (file: string) =>
	spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
		maxBuffer: 1 << 28,
	}).stdout;

async function gradedWithText(app: FastifyInstance, headers: Record<string, string> = {}) {
	const chart = await register(app, fixture('chart.png'), headers);
	const look = await register(app, fixture('look-33.cube'), headers);
	const d = new DocBuilder();
	const c = d.addMedia(chart);
	const l = d.addMedia(look);
	const clip = d.tx([
		{
			type: 'clip.place',
			source: { mediaId: c },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
			ref: '$c',
		},
	]).refs.$c!;
	d.tx([
		{ type: 'effect.add', target: { clipId: clip }, effectId: LUMETRI_EFFECT_ID, params: GRADE(l) },
		// A text clip forces the Remotion path (S06 §9 test 6); a blank text keeps the chart comparable everywhere.
		{
			type: 'clip.addText',
			at: 0,
			duration: 30,
			track: 'V2',
			content: { text: ' ' },
			ref: '$t',
		},
	]);
	// M2 (wp-m2-layer-bake): text alone is baked natively now (S11:LBK-001); a blend mode keeps it a Remotion-only
	// layer (S04:RP-005), so this sequence still renders through the compositions' colour stage.
	const text = d.clipIds().find((id) => d.doc.sequences[d.seqId]!.clips[id]!.kind === 'text')!;
	d.tx([{ type: 'clip.update', clipIds: [text], patch: { blendMode: 'screen' } }]);
	return d;
}

describe('WEBGL_UNAVAILABLE (S06:CG-042)', () => {
	it('an engine without WebGL2 fails a graded Remotion still with WEBGL_UNAVAILABLE', async () => {
		ensureFixtures();
		const app = await makeApp({ env: { JASPER_REMOTION_GL: 'off' } as Record<string, string> });
		const d = await gradedWithText(app);
		const r = await app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, frame: 0 },
		});
		expect(r.statusCode).toBe(202);
		const done = await coreServices(app).queue.wait(r.json().id);
		expect(done.state).toBe('failed');
		expect(done.error?.code).toBe('WEBGL_UNAVAILABLE');
	}, 60_000);
});

describe.runIf(process.env.REMOTION_E2E === '1')('Remotion path renders graded (REMOTION_E2E=1)', () => {
	it('a graded chart + (blank) text still matches the TS reference (≤ 2/255 on 99.5 %)', async () => {
		ensureFixtures();
		// A listening engine: the headless browser fetches the signed media URLs over HTTP.
		const engine = await startEngine({
			appdir: tempAppdir(),
			port: Number(process.env.JASPER_E2E_PORT ?? 0),
			dev: true,
			env: {
				PATH: process.env.PATH,
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
		stops.push(() => engine.stop());
		const app = engine.app;
		const hostH = { host: `127.0.0.1:${engine.port}` };
		const webgl = await coreServices(app).remotion.probeWebgl();
		const d = await gradedWithText(app, hostH);
		const r = await app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: { ...JSON_H, ...hostH },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, frame: 3 },
		});
		const done = await coreServices(app).queue.wait(r.json().id);
		console.info(
			`[S06 §9.6] WebGL2 probe: ${JSON.stringify(webgl)}; still: ${done.state} ${done.error?.code ?? ''} ${done.error?.message ?? ''}`,
		);
		if (webgl.state !== 'ok') {
			expect(done.error?.code).toBe('WEBGL_UNAVAILABLE');
			return;
		}
		expect(done.error).toBeUndefined();
		expect((done.result as { renderPath: string }).renderPath).toBe('remotion');
		const png = await app.inject({ method: 'GET', url: `/renders/${r.json().id}/output`, headers: hostH });
		const f = join(mkdtempSync(join(tmpdir(), 'jasper-color-rem-')), 'still.png');
		writeFileSync(f, png.rawPayload);
		const look = parseCube(readFileSync(fixture('look-33.cube'), 'utf8'));
		const lut = bakeColorRun(
			[{ id: 'g', effectId: LUMETRI_EFFECT_ID, effectVersion: 1, enabled: true, params: GRADE('L') }],
			defaultEffectRegistry,
			{ lut: (id) => (id === 'L' ? look : null) },
			33,
		)!;
		const src = rgb(fixture('chart.png'));
		const got = rgb(f);
		expect(got.length).toBe(src.length);
		const W = 1920;
		const hist = new Array<number>(256).fill(0);
		let n = 0;
		const c: Rgb = [0, 0, 0];
		for (let y = 0; y < 1080; y++)
			for (let x = 0; x < W; x++) {
				const i = (y * W + x) * 3;
				c[0] = src[i]! / 255;
				c[1] = src[i + 1]! / 255;
				c[2] = src[i + 2]! / 255;
				applyLut(lut, c);
				for (let k = 0; k < 3; k++) {
					hist[Math.abs(got[i + k]! - Math.round(c[k]! * 255))]!++;
					n++;
				}
			}
		const within = (t: number) => hist.slice(0, t + 1).reduce((a, b) => a + b, 0) / n;
		let max = 0;
		hist.forEach((v, d) => {
			if (v > 0) max = d;
		});
		console.info(
			`[S06 §9.6] Remotion still vs TS reference: exact ${(within(0) * 100).toFixed(3)} %, ≤1 ${(within(1) * 100).toFixed(3)} %, ≤2 ${(within(2) * 100).toFixed(3)} %, max ${max}`,
		);
		expect(within(2)).toBeGreaterThanOrEqual(0.995);
	}, 300_000);
});
