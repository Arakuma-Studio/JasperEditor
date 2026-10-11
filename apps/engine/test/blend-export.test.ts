// PNG avoids chroma subsampling; native pixels and preview GL shaders share the blendPixel oracle.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	BLEND_MODES,
	blendPixel,
	dissolveNoise,
	dissolveSeed,
	makeBlendKernel,
	type Rgba,
	storePremul8,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blendStackedFrame } from '../src/export/blend/kernel.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	H,
	JSON_H,
	makeApp,
	register,
	type TestApp,
} from './helpers.ts';

const W = 1920;
const HH = 1080;
let app: TestApp;
let baseMedia: Awaited<ReturnType<typeof register>>;
let layerMedia: Awaited<ReturnType<typeof register>>;

function pattern(file: string, r: string, g: string, b: string) {
	const res = spawnSync('ffmpeg', [
		...['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${HH}:d=1`],
		...['-vf', `format=rgb24,geq=r='${r}':g='${g}':b='${b}'`, '-frames:v', '1', file],
	]);
	if (res.status !== 0) throw new Error(res.stderr.toString());
}

beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
	const dir = mkdtempSync(join(tmpdir(), 'jasper-blend-'));
	pattern(join(dir, 'base.png'), 'mod(X*7+Y*3,256)', 'mod(X*5+Y*11,256)', 'mod(X*13+Y*2,256)');
	pattern(join(dir, 'layer.png'), 'mod(X*3+Y*17,256)', 'mod(X*11+Y*5,256)', 'mod(X*2+Y*9,256)');
	baseMedia = await register(app, join(dir, 'base.png'));
	layerMedia = await register(app, join(dir, 'layer.png'));
}, 180_000);
afterAll(closeApps);

async function still(d: DocBuilder, frame = 0): Promise<{ rgb: Buffer; renderPath: string }> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/stills',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, frame },
	});
	expect(r.statusCode).toBe(202);
	const done = await coreServices(app).queue.wait(r.json().id);
	expect(done.error).toBeUndefined();
	const png = await app.inject({ method: 'GET', url: `/renders/${r.json().id}/output`, headers: H });
	const f = join(mkdtempSync(join(tmpdir(), 'jasper-blend-png-')), 'f.png');
	writeFileSync(f, png.rawPayload);
	const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
		maxBuffer: 64 << 20,
	});
	expect(raw.stdout.length).toBe(W * HH * 3);
	return { rgb: raw.stdout, renderPath: (done.result as { renderPath: string }).renderPath };
}

function doc(mode: string, opacity = 100, layer = true): { d: DocBuilder; clip: string } {
	const d = new DocBuilder();
	const a = d.addMedia(baseMedia);
	const b = d.addMedia(layerMedia);
	d.tx([{ type: 'clip.place', source: { mediaId: a }, at: 0 }]);
	let clip = '';
	if (layer) {
		const r = d.tx([
			{ type: 'clip.place', source: { mediaId: b }, at: 0, tracks: { video: 'V2' }, ref: '$l' },
		]);
		clip = r.refs.$l!;
		d.tx([{ type: 'clip.update', clipIds: [clip], patch: { blendMode: mode } }]);
		if (opacity !== 100) d.tx([{ type: 'param.set', target: ['clip', clip, 'opacity'], value: opacity }]);
	}
	return { d, clip };
}

const STEP = 37;

describe('blend modes on the native export (real ffmpeg + blend kernel)', () => {
	let base: Buffer;
	let layer: Buffer;
	beforeAll(async () => {
		const b = await still(doc('normal', 100, false).d);
		expect(b.renderPath).toBe('native');
		base = b.rgb;
		const l = await still(doc('normal').d);
		layer = l.rgb;
	}, 120_000);

	const STEEP = new Set([
		'dissolve',
		'color-burn',
		'color-dodge',
		'vivid-light',
		'hard-mix',
		'divide',
		'darker-color',
		'lighter-color',
		'hue',
		'saturation',
		'color',
		'luminosity',
	]);
	it.each(BLEND_MODES.filter((m) => m !== 'normal').map((m) => [m]))(
		'%s at 60 % opacity = blendPixel',
		async (mode) => {
			const { d, clip } = doc(mode, 60);
			const out = await still(d);
			expect(out.renderPath).toBe('native');
			// Layer alpha after the opacity multiply: 0.6 · 255 → 153.
			const sa = 153 / 255;
			const seed = dissolveSeed(clip, 0);
			let bad = 0;
			let n = 0;
			for (let p = 0; p < W * HH; p += STEP) {
				const i = p * 3;
				const x = p % W;
				const y = Math.floor(p / W);
				const dst: Rgba = [base[i]! / 255, base[i + 1]! / 255, base[i + 2]! / 255, 1];
				const src: Rgba = [
					(layer[i]! / 255) * sa,
					(layer[i + 1]! / 255) * sa,
					(layer[i + 2]! / 255) * sa,
					sa,
				];
				const want = storePremul8(blendPixel(mode, dst, src, dissolveNoise(x, y, seed)));
				n++;
				// Stencils / silhouettes can make the composite transparent: the still shows it over the black background.
				let e = 0;
				for (let k = 0; k < 3; k++) e = Math.max(e, Math.abs(want[k]! * 255 - out.rgb[i + k]!));
				if (e > 2.5) bad++;
			}
			expect(bad / n, `${mode}: ${bad} of ${n} pixels off`).toBeLessThanOrEqual(STEEP.has(mode) ? 0.002 : 0);
		},
		60_000,
	);

	it('two blend layers with a Normal layer between them', async () => {
		const { d } = doc('multiply');
		const b = d.addMedia(baseMedia);
		const n = d.tx([
			{ type: 'clip.place', source: { mediaId: b }, at: 0, tracks: { video: 'V3' }, ref: '$n' },
		]).refs.$n!;
		const r = d.tx([
			{ type: 'clip.place', source: { mediaId: b }, at: 0, tracks: { video: 'V4' }, ref: '$s' },
		]);
		d.tx([
			{ type: 'param.set', target: ['clip', n, 'opacity'], value: 50 },
			{ type: 'clip.update', clipIds: [r.refs.$s!], patch: { blendMode: 'difference' } },
		]);
		const out = await still(d);
		expect(out.renderPath).toBe('native');
		let worst = 0;
		for (let p = 0; p < W * HH; p += STEP * 3) {
			const i = p * 3;
			const B: Rgba = [base[i]! / 255, base[i + 1]! / 255, base[i + 2]! / 255, 1];
			const L: Rgba = [layer[i]! / 255, layer[i + 1]! / 255, layer[i + 2]! / 255, 1];
			let acc = storePremul8(blendPixel('multiply', B, L, 0));
			const half: Rgba = [B[0] * (128 / 255), B[1] * (128 / 255), B[2] * (128 / 255), 128 / 255];
			acc = storePremul8(blendPixel('normal', acc, half, 0));
			acc = storePremul8(blendPixel('difference', acc, B, 0));
			for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(acc[k]! * 255 - out.rgb[i + k]!));
		}
		expect(worst).toBeLessThanOrEqual(3);
	}, 60_000);

	it('the planner keeps blend modes native and refuses them inside nested sequences', async () => {
		const { d } = doc('linear-light');
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: {
				sequenceId: d.seqId,
				range: { type: 'entire' },
				container: 'mp4',
				video: {
					codec: 'h264',
					width: 1920,
					height: 1080,
					frameRate: { num: 30, den: 1 },
					scaling: 'fit',
					quality: { mode: 'crf', value: 18 },
					encoderSpeed: 'fast',
				},
				audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
				engine: 'auto',
			} as never,
		});
		expect(planned.plan.path).toBe('native');
		expect(planned.plan.blockers).toEqual([]);
	});
});

describe('blend kernel (unit)', () => {
	it('copies the composite on inactive frames and through transparent layer pixels; stencils clear', () => {
		const K = makeBlendKernel();
		const src = new Uint8Array([10, 20, 30, 255, 0, 0, 0, 0]);
		const out = new Uint8Array(4);
		blendStackedFrame(K, src, 1, 1, 3, 0, true, out);
		expect([...out]).toEqual([10, 20, 30, 255]);
		blendStackedFrame(K, src, 1, 1, 27, 0, true, out);
		expect([...out]).toEqual([0, 0, 0, 0]);
		blendStackedFrame(K, src, 1, 1, 27, 0, false, out);
		expect([...out]).toEqual([10, 20, 30, 255]);
	});

	it('equals blendPixel + storePremul8 on random pixels for every mode', () => {
		const K = makeBlendKernel();
		let s = 7;
		const rnd = () => {
			s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
			return s >>> 24;
		};
		for (const [mi, mode] of BLEND_MODES.entries()) {
			const Wn = 64;
			const src = new Uint8Array(Wn * 2 * 4);
			for (let i = 0; i < src.length; i++) src[i] = rnd();
			const out = new Uint8Array(Wn * 4);
			blendStackedFrame(K, src, Wn, 1, mi, 99, true, out);
			for (let x = 0; x < Wn; x++) {
				const i = x * 4;
				const j = i + Wn * 4;
				const da = src[i + 3]! / 255;
				const sa = src[j + 3]! / 255;
				if (src[j + 3] === 0 && mode !== 'stencil-alpha' && mode !== 'stencil-luma') continue;
				const want = storePremul8(
					blendPixel(
						mode,
						[(src[i]! / 255) * da, (src[i + 1]! / 255) * da, (src[i + 2]! / 255) * da, da],
						[(src[j]! / 255) * sa, (src[j + 1]! / 255) * sa, (src[j + 2]! / 255) * sa, sa],
						dissolveNoise(x, 0, 99),
					),
				);
				expect(Math.abs(want[3]! * 255 - out[i + 3]!), mode).toBeLessThanOrEqual(0.5);
				if (out[i + 3]! > 0)
					for (let k = 0; k < 3; k++)
						expect(Math.abs((want[k]! / want[3]!) * 255 - out[i + k]!), `${mode} ch${k}`).toBeLessThanOrEqual(
							255 / out[i + 3]! + 0.5,
						);
			}
		}
	});
});
