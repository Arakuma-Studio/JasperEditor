// A static DOM layer (a shape, a text) in a GL-composited blend mode, exported through Remotion over many frames.
// Regression (verify workstream): the blend scope's layer tap was keyed by the clip alone, so a layer whose picture
// does not change delivered it only on the first frame each Remotion page rendered; the scope's delayRender then
// timed out on the page's next frame ("Blend modes at frame 6"). Stills (one frame) never showed it. Checked against
// `blendPixel` (the native kernel's formulas) on early and late frames. REMOTION_E2E=1.
import { spawnSync } from 'node:child_process';
import { blendPixel, type Rgba } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, JSON_H, tempAppdir } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const W = 640;
const H = 360;
const FRAMES = 36;
type Rgb = [number, number, number];

const to8 = (c: Rgba): Rgb => [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];

describe.runIf(enabled)(
	'static DOM layers in GL blend modes, exported over many frames (REMOTION_E2E=1)',
	() => {
		let engine: RunningEngine;
		let hostH: Record<string, string>;

		beforeAll(async () => {
			engine = await startEngine({
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
			hostH = { host: `127.0.0.1:${engine.port}` };
		}, 120_000);
		afterAll(async () => {
			await engine?.stop();
		});

		function pixel(file: string, frame: number, x: number, y: number): Rgb {
			const r = spawnSync('ffmpeg', [
				...['-v', 'error', '-i', file],
				...['-vf', `select=eq(n\\,${frame}),format=rgb24,crop=1:1:${x}:${y}`],
				...['-frames:v', '1', '-f', 'rawvideo', '-'],
			]);
			return [r.stdout[0]!, r.stdout[1]!, r.stdout[2]!];
		}
		const near = (a: Rgb, b: Rgb, tol: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

		it('a shape in Color Dodge renders every frame (no delayRender timeout) with the blended colour', async () => {
			const base: Rgba = [0.4, 0.3, 0.2, 1];
			const fill: Rgba = [0.5, 0.6, 0.7, 1];
			const d = new DocBuilder();
			d.tx([
				{ type: 'sequence.updateSettings', settings: { width: W, height: H, backgroundColor: [0, 0, 0, 1] } },
			]);
			const shape = d.tx([
				{ type: 'clip.addSolid', at: 0, duration: FRAMES, track: 'V1', color: base },
				{
					type: 'clip.addShape',
					at: 0,
					duration: FRAMES,
					track: 'V2',
					shape: { type: 'rect', size: [300, 200], fill },
					transform: { position: [W / 2, H / 2] },
					ref: '$s',
				},
			]).refs.$s!;
			d.tx([{ type: 'clip.update', clipIds: [shape], patch: { blendMode: 'color-dodge' } }]);
			const start = await engine.app.inject({
				method: 'POST',
				url: '/api/exports',
				headers: { ...JSON_H, ...hostH },
				payload: {
					envelope: d.envelope(),
					sequenceId: d.seqId,
					settings: {
						sequenceId: d.seqId,
						range: { type: 'entire' },
						container: 'mp4',
						video: {
							codec: 'h264',
							width: W,
							height: H,
							frameRate: { num: 30, den: 1 },
							scaling: 'fit',
							quality: { mode: 'crf', value: 12 },
							encoderSpeed: 'fast',
							colorTags: 'rec709',
						},
						audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
						engine: 'remotion',
					},
				},
			});
			expect(start.statusCode, start.body).toBe(202);
			const done = await coreServices(engine.app).queue.wait(start.json().id);
			expect(done.error, JSON.stringify(done.error)).toBeUndefined();
			expect((done.result as { renderPath: string }).renderPath).toBe('remotion');
			const file = (await coreServices(engine.app).exports.outputFile(start.json().id))!;
			const inside = to8(blendPixel('color-dodge', base, fill, 0));
			const outside = to8(base);
			for (const f of [0, 1, 7, 20, FRAMES - 1]) {
				const c = pixel(file, f, W / 2, H / 2);
				expect(near(c, inside, 6), `frame ${f}: centre ${c}, expected ${inside}`).toBe(true);
				const o = pixel(file, f, 20, 20);
				expect(near(o, outside, 6), `frame ${f}: corner ${o}, expected ${outside}`).toBe(true);
			}
		}, 600_000);
	},
);
