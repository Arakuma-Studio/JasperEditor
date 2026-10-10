// compositor: the stacks whose canvas scopes used to nest (CANVAS_NESTED on the Remotion path) exported through every
// path the planner picks — Remotion (adjustment layers with GPU effects, 3D runs, linear light), native (blend modes
// and an adjustment layer with a native colour effect between them), hybrid layer bakes (a text layer in such a
// stack) — and the same documents forced through Remotion, against values computed with `blendPixel` (the native
// kernel's formulas). REMOTION_E2E=1 (real engine, headless Chrome, LGPL ffmpeg).
import { spawnSync } from 'node:child_process';
import { blendPixel, type Rgba } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, JSON_H, tempAppdir } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const W = 640;
const H = 360;
type Rgb = [number, number, number];

const settings = (seqId: string, engine: 'auto' | 'native' | 'remotion') => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	video: {
		codec: 'h264',
		width: W,
		height: H,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 18 },
		encoderSpeed: 'fast',
		colorTags: 'rec709',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine,
});

const to8 = (c: Rgba): Rgb => [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];
const invert = (c: Rgba): Rgba => [1 - c[0], 1 - c[1], 1 - c[2], c[3]];
const gray = (c: Rgba): Rgba => {
	// Black & White: Rec. 709 luma of the encoded values (the colour op of jasper.black-white).
	const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
	return [y, y, y, c[3]];
};
const over = (layers: { c: Rgba; mode?: string }[], from: Rgba = [0, 0, 0, 1]): Rgba => {
	let dst = from;
	for (const l of layers) dst = blendPixel(l.mode ?? 'normal', dst, l.c, 0);
	return dst;
};

describe.runIf(enabled)('stacks that used to nest canvas scopes, exported (REMOTION_E2E=1)', () => {
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

	const doc = (commands: unknown[]) => {
		const d = new DocBuilder();
		d.tx([
			{ type: 'sequence.updateSettings', settings: { width: W, height: H, backgroundColor: [0, 0, 0, 1] } },
		]);
		d.tx(commands);
		return d;
	};

	async function exportDoc(
		d: DocBuilder,
		engineChoice: 'auto' | 'native' | 'remotion',
	): Promise<{ file: string; path: string }> {
		const start = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...JSON_H, ...hostH },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, engineChoice) },
		});
		expect(start.statusCode, start.body).toBe(202);
		const done = await coreServices(engine.app).queue.wait(start.json().id);
		expect(done.error, JSON.stringify(done.error)).toBeUndefined();
		const file = (await coreServices(engine.app).exports.outputFile(start.json().id))!;
		return { file, path: (done.result as { renderPath: string }).renderPath };
	}

	function pixel(file: string, frame: number, x: number, y: number): Rgb {
		const r = spawnSync('ffmpeg', [
			...['-v', 'error', '-i', file],
			...['-vf', `select=eq(n\\,${frame}),format=rgb24,crop=1:1:${x}:${y}`],
			...['-frames:v', '1', '-f', 'rawvideo', '-'],
		]);
		return [r.stdout[0]!, r.stdout[1]!, r.stdout[2]!];
	}
	const near = (a: Rgb, b: Rgb, tol: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
	const check = (file: string, x: number, y: number, want: Rgba, tol = 5) => {
		const got = pixel(file, 3, x, y);
		expect(near(got, to8(want), tol), `(${x}, ${y}) ${got} want ${to8(want)}`).toBe(true);
	};

	const base: Rgba = [0.8, 0.4, 0.2, 1];
	const mid: Rgba = [0.3, 0.6, 0.9, 1];
	const top: Rgba = [0.5, 0.5, 0.25, 1];
	const solid = (track: string, color: Rgba, ref: string) => ({
		type: 'clip.addSolid',
		at: 0,
		duration: 10,
		track,
		color,
		ref,
	});
	const mode = (ref: string, blendMode: string) => ({
		type: 'clip.update',
		clipId: ref,
		patch: { blendMode },
	});
	const adjustment = (track: string, ref: string) => ({
		type: 'clip.addAdjustment',
		at: 0,
		duration: 10,
		track,
		ref,
	});
	const effect = (ref: string, effectId: string) => ({
		type: 'effect.add',
		target: { clipId: ref },
		effectId,
	});

	it('an adjustment layer with GPU effects over a GL blend: Remotion path', async () => {
		const d = doc([
			solid('V1', base, '$a'),
			solid('V2', mid, '$b'),
			mode('$b', 'linear-burn'),
			adjustment('V3', '$j'),
			effect('$j', 'jasper.invert'),
		]);
		const { file, path } = await exportDoc(d, 'auto');
		expect(path).toBe('remotion');
		check(file, W / 2, H / 2, invert(over([{ c: base }, { c: mid, mode: 'linear-burn' }])));
	}, 600_000);

	it('two GL blend tracks separated by an adjustment layer: native and Remotion agree with the formulas', async () => {
		const d = doc([
			solid('V1', base, '$a'),
			solid('V2', mid, '$b'),
			mode('$b', 'linear-burn'),
			adjustment('V3', '$j'),
			effect('$j', 'jasper.black-white'),
			solid('V4', top, '$t'),
			mode('$t', 'color-dodge'),
		]);
		const want = over([
			{ c: gray(over([{ c: base }, { c: mid, mode: 'linear-burn' }])) },
			{ c: top, mode: 'color-dodge' },
		]);
		const auto = await exportDoc(d, 'auto');
		expect(auto.path).toBe('native');
		check(auto.file, W / 2, H / 2, want, 6);
		const rem = await exportDoc(d, 'remotion');
		expect(rem.path).toBe('remotion');
		check(rem.file, W / 2, H / 2, want, 6);
	}, 900_000);

	it('a text layer in such a stack: the hybrid layer bake and Remotion agree', async () => {
		const d = doc([
			solid('V1', base, '$a'),
			{
				type: 'clip.addText',
				at: 0,
				duration: 10,
				track: 'V2',
				content: { text: 'MM', style: { fontSize: 200, fill: [1, 1, 1, 1] } },
			},
			solid('V3', mid, '$b'),
			mode('$b', 'linear-burn'),
			adjustment('V4', '$j'),
			effect('$j', 'jasper.black-white'),
			solid('V5', top, '$t'),
			mode('$t', 'color-dodge'),
		]);
		const hybrid = await exportDoc(d, 'auto');
		expect(hybrid.path).toBe('hybrid');
		const rem = await exportDoc(d, 'remotion');
		// A corner (no text) against the formulas, and the frames against each other.
		const want = over([
			{ c: gray(over([{ c: base }, { c: mid, mode: 'linear-burn' }])) },
			{ c: top, mode: 'color-dodge' },
		]);
		check(hybrid.file, 10, 10, want, 6);
		check(rem.file, 10, 10, want, 6);
		let inGlyph = 0;
		let differ = 0;
		let n = 0;
		for (let x = 120; x < 520; x += 8) {
			const h = pixel(hybrid.file, 3, x, H / 2);
			const r = pixel(rem.file, 3, x, H / 2);
			n++;
			if (!near(r, to8(want), 30)) inGlyph++;
			// Glyph edges are anti-aliased by two rasterisations (the bake and the page): a few may differ more.
			if (!near(h, r, 12)) differ++;
		}
		expect(inGlyph).toBeGreaterThan(3);
		expect(differ / n).toBeLessThanOrEqual(0.1);
	}, 900_000);

	it('a 3D run between GL blend tracks and linear light around an adjustment layer: Remotion path', async () => {
		const run = doc([
			solid('V1', base, '$a'),
			solid('V2', mid, '$b'),
			mode('$b', 'linear-burn'),
			solid('V3', [1, 0, 0, 1], '$c'),
			{ type: 'param.set', target: ['clip', '$c', 'transform', 'scale'], value: 30 },
			{ type: 'clip.set3d', clipIds: ['$c'], enabled: true },
			solid('V4', top, '$t'),
			mode('$t', 'color-dodge'),
		]);
		const r1 = await exportDoc(run, 'auto');
		expect(r1.path).toBe('remotion');
		check(
			r1.file,
			10,
			10,
			over([{ c: base }, { c: mid, mode: 'linear-burn' }, { c: top, mode: 'color-dodge' }]),
		);
		check(r1.file, W / 2, H / 2, over([{ c: [1, 0, 0, 1] }, { c: top, mode: 'color-dodge' }]));

		const lin = doc([
			{ type: 'sequence.updateSettings', settings: { color: { blendLinear: true } } },
			solid('V1', base, '$a'),
			solid('V2', mid, '$b'),
			{ type: 'param.set', target: ['clip', '$b', 'opacity'], value: 50 },
			adjustment('V3', '$j'),
			effect('$j', 'jasper.invert'),
			solid('V4', top, '$t'),
			{ type: 'param.set', target: ['clip', '$t', 'opacity'], value: 50 },
		]);
		const r2 = await exportDoc(lin, 'auto');
		expect(r2.path).toBe('remotion');
		const dec = (v: number) => v ** 2.4;
		const enc = (x: number) => x ** (1 / 2.4);
		const mix = (a: Rgba, b: Rgba): Rgba => [
			enc((dec(a[0]) + dec(b[0])) / 2),
			enc((dec(a[1]) + dec(b[1])) / 2),
			enc((dec(a[2]) + dec(b[2])) / 2),
			1,
		];
		check(r2.file, W / 2, H / 2, mix(invert(mix(base, mid)), top));
	}, 900_000);
});
