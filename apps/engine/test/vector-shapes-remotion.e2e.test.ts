// Vector shapes rendered for real (wp shapes, REMOTION_E2E=1). One 720p scene exercises both renderers of the shape
// layer and the operators:
// - V1 an inside-stroked rectangle (the converted form of a rectangle clip), V2 Merge Paths ▸ Subtract (a ring),
//   V3 a Repeater with an opacity ramp, V4 a linear gradient fill, V5 a Linear Burn paint (the canvas compositor
//   through the shared blend kernel), V6 a dashed, tapered stroke and Trim Paths, V7 a radial gradient with a
//   highlight; V8 Wiggle Paths moves over time;
// - golden probes: colours at points away from edges computed from the model (formulas, not a capture);
// - parity: the still (the composition as the Program monitor draws it) against an exported MP4 (layer bake +
//   native composite) of the same frame, every pixel, within H.264's tolerance; and two frames of the wiggling
//   shape differ in both (the bake is not a frozen still).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, JSON_H, ROOT, tempAppdir } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const W = 1280;
const H = 720;

const FFMPEG = (() => {
	const vendor = join(ROOT, 'vendor', 'ffmpeg-lgpl', 'linux-x64', 'ffmpeg');
	return process.env.JASPER_FFMPEG || (spawnSync(vendor, ['-version']).status === 0 ? vendor : 'ffmpeg');
})();

type RGB = [number, number, number];

function rgbOf(file: string, frame?: number): Uint8Array {
	const args = ['-v', 'error', '-i', file];
	if (frame !== undefined) args.push('-vf', `select=eq(n\\,${frame})`, '-vsync', '0', '-frames:v', '1');
	args.push('-s', `${W}x${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
	const r = spawnSync(FFMPEG, args, { maxBuffer: 1 << 26 });
	if (r.status !== 0) throw new Error(r.stderr.toString());
	return new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength);
}

const px = (img: Uint8Array, x: number, y: number): RGB => {
	const i = (y * W + x) * 3;
	return [img[i]!, img[i + 1]!, img[i + 2]!];
};

function scene(d: DocBuilder) {
	const shape = (track: string, contents: unknown[], position: [number, number], extra: Record<string, unknown> = {}) => ({
		type: 'clip.addShape',
		at: 0,
		duration: 30,
		track,
		shape: { type: 'vector', contents },
		transform: { position },
		...extra,
	});
	d.tx([
		{ type: 'track.add', kind: 'video', count: 6 },
		shape(
			'V1',
			[
				{ type: 'rect', size: [400, 200] },
				{ type: 'stroke', color: [0, 0, 1, 1], width: 10, position: 'inside' },
				{ type: 'fill', color: [1, 0, 0, 1] },
			],
			[320, 200],
		),
		shape(
			'V2',
			[
				{ type: 'ellipse', size: [300, 300] },
				{ type: 'ellipse', size: [150, 150] },
				{ type: 'mergePaths', mode: 'subtract' },
				{ type: 'fill', color: [1, 1, 0, 1] },
			],
			[900, 250],
		),
		shape(
			'V3',
			[
				{ type: 'rect', size: [40, 40] },
				{ type: 'fill', color: [1, 1, 1, 1] },
				{ type: 'repeater', copies: 4, composite: 'above', transform: { position: [80, 0], startOpacity: 100, endOpacity: 25 } },
			],
			[200, 560],
		),
		shape(
			'V4',
			[
				{ type: 'rect', size: [300, 100] },
				{
					type: 'gradientFill',
					startPoint: [-150, 0],
					endPoint: [150, 0],
					colors: {
						colors: [
							{ position: 0, color: [0, 0, 0] },
							{ position: 1, color: [1, 1, 1] },
						],
						opacities: [
							{ position: 0, opacity: 1 },
							{ position: 1, opacity: 1 },
						],
					},
				},
			],
			[900, 560],
		),
		shape(
			'V5',
			[
				{
					type: 'group',
					name: 'Top',
					contents: [{ type: 'rect', size: [100, 60], position: [50, 0] }, { type: 'fill', color: [1, 1, 0, 1], blendMode: 'linear-burn' }],
				},
				{ type: 'group', name: 'Bottom', contents: [{ type: 'rect', size: [200, 60] }, { type: 'fill', color: [0.5, 0.5, 0.5, 1] }] },
			],
			[620, 660],
		),
		shape(
			'V6',
			[
				{ type: 'path', path: 'M-150 0 L150 0' },
				{ type: 'stroke', color: [0, 1, 0, 1], width: 20, dashes: [40, 20] },
				{ type: 'trim', start: 0, end: 50 },
			],
			[620, 420],
		),
		shape(
			'V7',
			[
				{ type: 'ellipse', size: [160, 160] },
				{
					type: 'gradientFill',
					gradientType: 'radial',
					startPoint: [0, 0],
					endPoint: [80, 0],
					colors: {
						colors: [
							{ position: 0, color: [1, 1, 1] },
							{ position: 1, color: [0, 0, 0] },
						],
						opacities: [
							{ position: 0, opacity: 1 },
							{ position: 1, opacity: 1 },
						],
					},
				},
			],
			[1150, 120],
		),
		shape(
			'V8',
			[{ type: 'rect', size: [80, 80] }, { type: 'wiggle', size: 15, detail: 4, speed: 4 }, { type: 'fill', color: [1, 0, 1, 1] }],
			[1150, 600],
		),
	]);
}

const near = (c: RGB, want: RGB, tol: number) => c.every((v, k) => Math.abs(v - want[k]!) <= tol);

function probes(img: Uint8Array, tol: number) {
	const check = (x: number, y: number, want: RGB, what: string) =>
		expect(near(px(img, x, y), want, tol), `${what} at ${x},${y}: ${px(img, x, y).join(',')} vs ${want.join(',')}`).toBe(true);
	// V1: red interior, 10 px blue inside stroke.
	check(320, 200, [255, 0, 0], 'rect fill');
	check(125, 200, [0, 0, 255], 'inside stroke');
	check(115, 200, [0, 0, 0], 'nothing outside the outline');
	// V2: a ring between r = 75 and r = 150.
	check(900, 250, [0, 0, 0], 'subtracted hole');
	check(900 + 110, 250, [255, 255, 0], 'ring');
	// V3: four squares with opacity 100, 75, 50, 25 % (white over black).
	[255, 191, 128, 64].forEach((g, i) => check(200 + 80 * i, 560, [g, g, g], `repeater copy ${i}`));
	// V4: black → white along x: a quarter and three quarters.
	check(900 - 75, 560, [64, 64, 64], 'gradient 25 %');
	check(900 + 75, 560, [191, 191, 191], 'gradient 75 %');
	// V5: Linear Burn of yellow over 50 % gray = (0.5, 0.5, 0); gray alone; yellow over black stays yellow.
	check(560, 660, [128, 128, 128], 'linear burn backdrop');
	check(650, 660, [128, 128, 0], 'linear burn');
	check(690, 660, [128, 128, 0], 'linear burn');
	// V6: dashes 40 on / 20 off from x = 470, trimmed at the middle (x = 620).
	check(490, 420, [0, 255, 0], 'dash');
	check(520, 420, [0, 0, 0], 'gap');
	check(550, 420, [0, 255, 0], 'dash');
	check(660, 420, [0, 0, 0], 'trimmed away');
	// V7: radial white → black over r = 80: half way = 128.
	check(1150, 120, [255, 255, 255], 'radial centre');
	check(1150 + 40, 120, [128, 128, 128], 'radial 50 %');
}

describe.runIf(enabled)('vector shapes: golden probes and preview ↔ export parity (REMOTION_E2E=1)', () => {
	it('renders operators, gradients and blend modes identically in the still and the export', async () => {
		const engine: RunningEngine = await startEngine({
			appdir: tempAppdir(),
			port: 0,
			dev: true,
			env: {
				PATH: process.env.PATH,
				...(process.env.JASPER_BROWSER_EXECUTABLE ? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE } : {}),
			},
		});
		const hostH = { host: `127.0.0.1:${engine.port}` };
		try {
			const d = new DocBuilder('hd-720p-30');
			scene(d);
			const dir = mkdtempSync(join(tmpdir(), 'jasper-vshapes-'));
			const still = async (frame: number) => {
				const r = await engine.app.inject({
					method: 'POST',
					url: '/api/stills',
					headers: { ...JSON_H, ...hostH },
					payload: { envelope: d.envelope(), sequenceId: d.seqId, frame },
				});
				expect(r.statusCode, r.body).toBeLessThan(300);
				const done = await coreServices(engine.app).queue.wait(r.json().id);
				expect(done.error, JSON.stringify(done.error)).toBeUndefined();
				const png = await engine.app.inject({ method: 'GET', url: `/renders/${r.json().id}/output`, headers: hostH });
				expect(r.statusCode, r.body).toBeLessThan(300);
				const f = join(dir, `still-${frame}.png`);
				writeFileSync(f, png.rawPayload);
				return rgbOf(f);
			};
			const s5 = await still(5);
			probes(s5, 4);

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
						container: 'mov',
						video: {
							codec: 'h264',
							width: W,
							height: H,
							frameRate: { num: 30, den: 1 },
							scaling: 'fit',
							quality: { mode: 'crf', value: 4 },
							encoderSpeed: 'fast',
							colorTags: 'rec709',
						},
						audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
						engine: 'auto',
					},
				},
			});
			expect(start.statusCode, start.body).toBe(202);
			const done = await coreServices(engine.app).queue.wait(start.json().id);
			expect(done.error, JSON.stringify(done.error)).toBeUndefined();
			const file = (await coreServices(engine.app).exports.outputFile(start.json().id))!;
			const e5 = rgbOf(file, 5);
			probes(e5, 10);
			// Every pixel: export vs still (chroma subsampling and quantisation only).
			let sum = 0;
			let worst = 0;
			let big = 0;
			let bigWiggle = 0;
			for (let i = 0; i < s5.length; i++) {
				const dv = Math.abs(s5[i]! - e5[i]!);
				sum += dv;
				worst = Math.max(worst, dv);
				if (dv > 24) {
					big++;
					const p = Math.floor(i / 3);
					if (p % W >= 1090 && Math.floor(p / W) >= 540) bigWiggle++;
				}
			}
			const mean = sum / s5.length;
			const stats = `[shapes] export vs still frame 5: mean ${mean.toFixed(3)}, worst ${worst}, ${big} values > 24 (${bigWiggle} in the wiggle region); render path ${(done.result as { renderPath?: string }).renderPath ?? '?'}`;
			console.info(stats);

			expect(mean).toBeLessThan(1.5);
			expect(big / s5.length).toBeLessThan(0.003);
			// Away from edges (H.264 4:2:0 chroma and its deblocking smear saturated edges by a few pixels) the export
			// equals the still.
			let flatWorst = 0;
			let flatOff = 0;
			let flat = 0;
			for (let y = 6; y < H - 6; y++)
				for (let x = 6; x < W - 6; x++) {
					const c = px(s5, x, y);
					let uniform = true;
					for (let j = -6; j <= 6 && uniform; j += 2)
						for (let i = -6; i <= 6 && uniform; i += 2) if (!near(px(s5, x + i, y + j), c, 2)) uniform = false;
					if (!uniform) continue;
					flat++;
					const e = px(e5, x, y);
					const dd = Math.max(...c.map((v, k) => Math.abs(v - e[k]!)));
					if (dd > 8) flatOff++;
					flatWorst = Math.max(flatWorst, dd);
				}
			const flatStats = `[shapes] flat pixels ${flat}: ${flatOff} differ by > 8 (encoder ringing next to saturated edges), worst ${flatWorst}`;
			console.info(flatStats);
			if (process.env.SHAPES_STATS) writeFileSync(process.env.SHAPES_STATS, `${stats}\n${flatStats}`);
			expect(flat).toBeGreaterThan(W * H * 0.7);
			expect(flatOff).toBeLessThanOrEqual(50);
			expect(flatWorst).toBeLessThanOrEqual(40);
			// Wiggle Paths animates: frames 5 and 20 differ around V8 in both the still and the export.
			const s20 = await still(20);
			const e20 = rgbOf(file, 20);
			const region = (img: Uint8Array) => {
				let n = 0;
				for (let y = 540; y < 660; y++) for (let x = 1090; x < 1210; x++) n += px(img, x, y)[0] > 128 ? 1 : 0;
				return n;
			};
			let diffS = 0;
			let diffE = 0;
			for (let y = 540; y < 660; y++)
				for (let x = 1090; x < 1210; x++) {
					diffS += Math.abs(px(s5, x, y)[0] - px(s20, x, y)[0]) > 100 ? 1 : 0;
					diffE += Math.abs(px(e5, x, y)[0] - px(e20, x, y)[0]) > 100 ? 1 : 0;
				}
			expect(region(s5)).toBeGreaterThan(3000);
			expect(diffS).toBeGreaterThan(50);
			expect(diffE).toBeGreaterThan(50);
		} finally {
			await engine.stop();
		}
	}, 600_000);
});
