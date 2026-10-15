import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LUMETRI_EFFECT_ID } from '@jasper/project';
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
	const d = new DocBuilder();
	const c = d.addMedia(chart);
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
		{ type: 'effect.add', target: { clipId: clip }, effectId: LUMETRI_EFFECT_ID, params: { exposure: -1 } },
		// Blank text keeps the chart comparable while the nested blend mode forces the Remotion path.
		{
			type: 'clip.addText',
			at: 0,
			duration: 30,
			track: 'V2',
			content: { text: ' ' },
			ref: '$t',
		},
	]);
	// Nested text with a blend mode forces Remotion; standalone text and blend modes can render natively.
	const text = d.clipIds().find((id) => d.doc.sequences[d.seqId]!.clips[id]!.kind === 'text')!;
	d.tx([
		{ type: 'clip.update', clipIds: [text], patch: { blendMode: 'screen' } },
		{ type: 'clip.nest', clipIds: [text] },
	]);
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
	it('a chart behind nested text renders -1 EV in linear light (≤ 2/255 on 99.5 %)', async () => {
		ensureFixtures();
		// A listening engine: the headless browser fetches the signed media URLs over HTTP.
		const engine = await startEngine({
			appdir: tempAppdir(),
			port: Number(process.env.JASPER_E2E_PORT ?? 0),
			// These tests drive the engine itself, not its authentication (server.test.ts, security-hardening.test.ts).
			insecure: true,
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
		expect(webgl.state).toBe('ok');
		expect(done.error).toBeUndefined();
		expect((done.result as { renderPath: string }).renderPath).toBe('remotion');
		const png = await app.inject({ method: 'GET', url: `/renders/${r.json().id}/output`, headers: hostH });
		const f = join(mkdtempSync(join(tmpdir(), 'jasper-color-rem-')), 'still.png');
		writeFileSync(f, png.rawPayload);

		const src = rgb(fixture('chart.png'));
		const got = rgb(f);
		expect(got.length).toBe(src.length);
		const hist = new Array<number>(256).fill(0);
		const n = src.length;
		// S06 §3: v^2.4 × 2^(-1), re-encoded as v × 2^(-1/2.4).
		for (let i = 0; i < n; i++) {
			const want = Math.round(src[i]! * 2 ** (-1 / 2.4));
			hist[Math.abs(got[i]! - want)]!++;
		}
		const within = (t: number) => hist.slice(0, t + 1).reduce((a, b) => a + b, 0) / n;
		let max = 0;
		hist.forEach((v, d) => {
			if (v > 0) max = d;
		});
		console.info(
			`[S06 §9.6] Remotion still vs analytic -1 EV: exact ${(within(0) * 100).toFixed(3)} %, ≤1 ${(within(1) * 100).toFixed(3)} %, ≤2 ${(within(2) * 100).toFixed(3)} %, max ${max}`,
		);
		expect(within(2)).toBeGreaterThanOrEqual(0.995);
	}, 300_000);
});
