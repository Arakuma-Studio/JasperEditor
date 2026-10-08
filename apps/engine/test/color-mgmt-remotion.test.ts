// color-mgmt on the Remotion path (REMOTION_E2E=1: bundles the compositions, headless Chrome): a Rec. 2100 PQ
// sequence with Blend Using 1.0 Gamma (refused natively → Remotion) where a 50 % white solid over black blends in
// linear light, graphics map white to the HDR graphics white, a text layer goes through the DOM colour chain, and the
// still is the display rendition (BT.2390 tone mapped). Expected values from the TS colour science. The tracks of a
// linear-light run share one blend scope; an adjustment layer between linear tracks (scopes that would nest) is drawn
// by the flat compositor (compositor workstream).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	defaultWorkingSettings,
	displaySpaceFor,
	outputTransformFn,
	pqDecode,
	pqEncode,
	pqFromNits,
	type Rgb,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, ROOT, tempAppdir } from './helpers.ts';

const stops: (() => Promise<void>)[] = [];
afterAll(async () => {
	await closeApps();
	for (const s of stops) await s();
});

const FFMPEG = join(ROOT, 'vendor', 'ffmpeg-lgpl', 'linux-x64', 'ffmpeg');
function rgbAt(file: string, x: number, y: number, w: number, h: number): number[] {
	const r = spawnSync(
		FFMPEG,
		[
			'-v',
			'error',
			'-i',
			file,
			'-vf',
			`crop=${w}:${h}:${x}:${y}`,
			'-frames:v',
			'1',
			'-f',
			'rawvideo',
			'-pix_fmt',
			'rgb24',
			'-',
		],
		{ maxBuffer: 1 << 26 },
	);
	return [...r.stdout];
}

const display = (signal: number) => {
	const c: Rgb = [signal, signal, signal];
	outputTransformFn(defaultWorkingSettings('rec2100-pq'), displaySpaceFor('rec2100-pq'))!(c);
	return c[1] * 255;
};

describe.runIf(process.env.REMOTION_E2E === '1')(
	'colour management on the Remotion path (REMOTION_E2E=1)',
	() => {
		let engine: RunningEngine;
		let hostH: { host: string };
		beforeAll(async () => {
			engine = await startEngine({
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
			hostH = { host: `127.0.0.1:${engine.port}` };
		}, 120_000);

		/** A PQ sequence blending in linear light: black V1, 50 % white solid V2, then `upper` commands. */
		const build = (upper: object[]) => {
			const d = new DocBuilder();
			d.tx([
				{
					type: 'sequence.updateSettings',
					settings: {
						workingColorSpace: 'rec2100-pq',
						color: { blendLinear: true },
						backgroundColor: [0, 0, 0, 1],
					},
				},
				{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0, 0, 0, 1] },
				{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [1, 1, 1, 1] },
				...upper,
			]);
			const w = d.clipIds().find((id) => {
				const c = d.doc.sequences[d.seqId]!.clips[id]!;
				return c.kind === 'solid' && c.trackId === d.track('V2');
			})!;
			d.tx([{ type: 'param.set', target: ['clip', w, 'opacity'], value: 50 }]);
			return d;
		};
		const still = async (d: DocBuilder) => {
			const r = await engine.app.inject({
				method: 'POST',
				url: '/api/stills',
				headers: { ...JSON_H, ...hostH },
				payload: { envelope: d.envelope(), sequenceId: d.seqId, frame: 3 },
			});
			expect(r.statusCode).toBe(202);
			return { id: r.json().id as string, done: await coreServices(engine.app).queue.wait(r.json().id) };
		};

		it('PQ + Blend Using 1.0 Gamma: linear blend, graphics white, DOM text, display still', async () => {
			const d = build([
				{
					type: 'clip.addText',
					at: 0,
					duration: 30,
					track: 'V3',
					content: { text: 'MMMM', style: { fontSize: 400, fill: [1, 1, 1, 1] } },
				},
			]);
			const { id, done } = await still(d);
			expect(done.error, JSON.stringify(done.error)).toBeUndefined();
			expect((done.result as { renderPath: string }).renderPath).toBe('remotion');
			const png = await engine.app.inject({ method: 'GET', url: `/renders/${id}/output`, headers: hostH });
			const f = join(mkdtempSync(join(tmpdir(), 'jasper-cm-rem-')), 'still.png');
			writeFileSync(f, png.rawPayload);
			// Linear-light 50 % of the graphics white (203 cd/m² → 101.5 cd/m² of light), shown tone mapped.
			const white = pqFromNits(203);
			const mixed = pqEncode(0.5 * pqDecode(white));
			const corner = rgbAt(f, 4, 4, 8, 8);
			const mean = corner.reduce((a, b) => a + b, 0) / corner.length;
			expect(Math.abs(mean - display(mixed))).toBeLessThanOrEqual(3);
			// Encoded (non-linear) blending would land elsewhere:
			expect(Math.abs(display(white * 0.5) - display(mixed))).toBeGreaterThan(10);
			// The text's brightest pixels are the graphics white, tone mapped.
			const text = rgbAt(f, 0, 300, 1920, 480);
			const textMax = text.reduce((a, b) => Math.max(a, b), 0);
			expect(Math.abs(textMax - display(white))).toBeLessThanOrEqual(3);
			process.stderr.write(
				`[color-mgmt] remotion still: corner ${mean.toFixed(1)} (want ${display(mixed).toFixed(1)}), text max ${textMax} (want ${display(white).toFixed(1)})\n`,
			);
		}, 600_000);

		it('an adjustment layer between linear-light tracks renders (compositor: the flat compositor)', async () => {
			const d = build([
				{ type: 'clip.addAdjustment', at: 0, duration: 30, track: 'V3' },
				{
					type: 'clip.addText',
					at: 0,
					duration: 30,
					track: 'V4',
					content: { text: 'MMMM', style: { fontSize: 400, fill: [1, 1, 1, 1] } },
				},
			]);
			const { id, done } = await still(d);
			expect(done.error, JSON.stringify(done.error)).toBeUndefined();
			const png = await engine.app.inject({ method: 'GET', url: `/renders/${id}/output`, headers: hostH });
			const f = join(mkdtempSync(join(tmpdir(), 'jasper-cm-rem-')), 'still.png');
			writeFileSync(f, png.rawPayload);
			// The adjustment layer has no effects: the corner is the linear-light mix of the tracks below, as without it.
			const white = pqFromNits(203);
			const mixed = pqEncode(0.5 * pqDecode(white));
			const corner = rgbAt(f, 4, 4, 8, 8);
			const mean = corner.reduce((a, b) => a + b, 0) / corner.length;
			expect(Math.abs(mean - display(mixed))).toBeLessThanOrEqual(3);
			const text = rgbAt(f, 0, 300, 1920, 480);
			expect(Math.abs(text.reduce((a, b) => Math.max(a, b), 0) - display(white))).toBeLessThanOrEqual(3);
		}, 600_000);
	},
);
