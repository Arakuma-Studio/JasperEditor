// Crop in stack order and Edge Feather on the native path (schema v8, docs/wp-notes/crop-order.md). Lossless PNG
// stills; expected pixels come from the layer's own pixels and `cropCoverageAt` (render/crop.ts), the profile the
// preview shader computes too.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cropCoverageAt } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const W = 1280;
const HH = 720;
let app: TestApp;
let patternMedia: Awaited<ReturnType<typeof register>>;
let pattern: Buffer;

function decode(file: string): Buffer {
	const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
		maxBuffer: 64 << 20,
	});
	expect(raw.status, raw.stderr.toString()).toBe(0);
	expect(raw.stdout.length).toBe(W * HH * 3);
	return raw.stdout;
}

beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
	const dir = mkdtempSync(join(tmpdir(), 'jasper-crop-order-'));
	const file = join(dir, 'pattern.png');
	// Asymmetric, opaque: a flip or a misplaced cut changes almost every pixel.
	const res = spawnSync('ffmpeg', [
		...['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${HH}:d=1`],
		...['-vf', "format=rgb24,geq=r='mod(X*7+Y*3,256)':g='mod(X*5+Y*11,256)':b='mod(X*13+Y*2,256)'"],
		...['-frames:v', '1', file],
	]);
	if (res.status !== 0) throw new Error(res.stderr.toString());
	patternMedia = await register(app, file);
	pattern = decode(file);
}, 180_000);
afterAll(closeApps);

async function still(d: DocBuilder, frame = 0): Promise<{ rgb: Buffer; renderPath: string }> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/stills',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, frame },
	});
	expect(r.statusCode, r.body).toBe(202);
	const done = await coreServices(app).queue.wait(r.json().id);
	expect(done.error).toBeUndefined();
	const png = await app.inject({ method: 'GET', url: `/renders/${r.json().id}/output`, headers: H });
	const f = join(mkdtempSync(join(tmpdir(), 'jasper-crop-png-')), 'f.png');
	writeFileSync(f, png.rawPayload);
	return { rgb: decode(f), renderPath: (done.result as { renderPath: string }).renderPath };
}

function newDoc(): DocBuilder {
	const d = new DocBuilder('hd-720p-30');
	d.tx([{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [0, 0, 0, 1] }]);
	d.tx([{ type: 'track.add', kind: 'video', count: 1 }]);
	return d;
}

/** The pattern on V2 over black with these effects (commands with `$l` = the layer). */
function patternDoc(effects: unknown[]): DocBuilder {
	const d = newDoc();
	d.tx([
		{
			type: 'clip.place',
			source: { mediaId: d.addMedia(patternMedia) },
			at: 0,
			tracks: { video: 'V2' },
			ref: '$l',
		},
		...effects,
	]);
	return d;
}

/** A white solid on V2 over black with these effects. */
function whiteDoc(effects: unknown[]): DocBuilder {
	const d = newDoc();
	d.tx([
		{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V2', color: [1, 1, 1, 1], ref: '$l' },
		...effects,
	]);
	return d;
}

const add = (effectId: string, params: Record<string, unknown> = {}) => ({
	type: 'effect.add',
	target: { clipId: '$l' },
	effectId,
	params,
});

/** Largest per-channel difference against `want(x, y)` (rgb), and how many pixels exceed `tol`. */
function compare(
	rgb: Buffer,
	want: (x: number, y: number) => [number, number, number],
	tol: number,
): { worst: number; bad: number } {
	let worst = 0;
	let bad = 0;
	for (let y = 0; y < HH; y++)
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 3;
			const e = want(x, y);
			const d = Math.max(
				Math.abs(rgb[i]! - e[0]),
				Math.abs(rgb[i + 1]! - e[1]),
				Math.abs(rgb[i + 2]! - e[2]),
			);
			worst = Math.max(worst, d);
			if (d > tol) bad++;
		}
	return { worst, bad };
}

const px = (buf: Buffer, x: number, y: number): [number, number, number] => {
	const i = (y * W + x) * 3;
	return [buf[i]!, buf[i + 1]!, buf[i + 2]!];
};
const BLACK: [number, number, number] = [0, 0, 0];

describe('Crop where it sits in the stack (native)', () => {
	it('Crop → Flip mirrors the cut window; Flip → Crop cuts the flipped picture', async () => {
		const cut = Math.round(0.3 * W);
		const a = await still(patternDoc([add('jasper.crop', { left: 30 }), add('jasper.flip-horizontal')]));
		const b = await still(patternDoc([add('jasper.flip-horizontal'), add('jasper.crop', { left: 30 })]));
		expect(a.renderPath).toBe('native');
		expect(b.renderPath).toBe('native');
		// Crop → Flip: the window [cut, W) is mirrored to [0, W − cut).
		expect(compare(a.rgb, (x, y) => (x < W - cut ? px(pattern, W - 1 - x, y) : BLACK), 0)).toEqual({
			worst: 0,
			bad: 0,
		});
		// Flip → Crop: the flipped picture, cut on the left.
		expect(compare(b.rgb, (x, y) => (x >= cut ? px(pattern, W - 1 - x, y) : BLACK), 0)).toEqual({
			worst: 0,
			bad: 0,
		});
	}, 240_000);

	it('Edge Feather multiplies the alpha by the shared profile (exact edges, ≤ 2/255)', async () => {
		const ins: [number, number, number, number] = [0.1, 0.08, 0.15, 0.2];
		const r = await still(
			whiteDoc([add('jasper.crop', { left: 10, top: 8, right: 15, bottom: 20, feather: 40 })]),
		);
		expect(r.renderPath).toBe('native');
		const want = (x: number, y: number): [number, number, number] => {
			const v = Math.round(255 * cropCoverageAt(x + 0.5, y + 0.5, W, HH, ins, 40));
			return [v, v, v];
		};
		const c = compare(r.rgb, want, 2);
		expect(c.bad, `worst ${c.worst}`).toBe(0);
		// The ramp is visible: half way along a 40 px feather is ≈ 50 % (the left edge is at x = 128).
		expect(px(r.rgb, 148, 360)[0]).toBeGreaterThan(120);
		expect(px(r.rgb, 148, 360)[0]).toBeLessThan(136);
	}, 240_000);

	it('a feathered crop before a flip is mirrored with its feather', async () => {
		const ins: [number, number, number, number] = [0.25, 0, 0, 0];
		const r = await still(
			whiteDoc([add('jasper.crop', { left: 25, feather: 30 }), add('jasper.flip-horizontal')]),
		);
		const c = compare(
			r.rgb,
			(x, y) => {
				const v = Math.round(255 * cropCoverageAt(W - 1 - x + 0.5, y + 0.5, W, HH, ins, 30));
				return [v, v, v];
			},
			2,
		);
		expect(c.bad, `worst ${c.worst}`).toBe(0);
	}, 240_000);

	it('keyframed Edge Feather is evaluated per frame', async () => {
		const d = whiteDoc([add('jasper.crop', { left: 20 })]);
		const fxId = Object.values(d.doc.sequences[d.seqId]!.clips)
			.flatMap((x) => (x as { effects?: { id: string; effectId: string }[] }).effects ?? [])
			.find((e) => e.effectId === 'jasper.crop')!.id;
		d.tx([
			{ type: 'keyframe.add', target: ['effect', fxId, 'feather'], at: { sequenceFrame: 0 }, value: 0 },
			{ type: 'keyframe.add', target: ['effect', fxId, 'feather'], at: { sequenceFrame: 30 }, value: 60 },
		]);
		const r = await still(d, 15);
		expect(r.renderPath).toBe('native');
		const ins: [number, number, number, number] = [0.2, 0, 0, 0];
		const cmp = compare(
			r.rgb,
			(x, y) => {
				const v = Math.round(255 * cropCoverageAt(x + 0.5, y + 0.5, W, HH, ins, 30));
				return [v, v, v];
			},
			2,
		);
		expect(cmp.bad, `worst ${cmp.worst}`).toBe(0);
	}, 240_000);

	it('a feathered crop on a sub-pixel layer (kernel path) is the profile resampled at the layer’s offset', async () => {
		const ins: [number, number, number, number] = [0.1, 0.1, 0.1, 0.1];
		const r = await still(
			whiteDoc([
				{
					type: 'param.set',
					target: ['clip', '$l', 'transform', 'position'],
					value: [W / 2 + 0.5, HH / 2 + 0.5],
				},
				add('jasper.crop', { left: 10, top: 10, right: 10, bottom: 10, feather: 24 }),
			]),
		);
		expect(r.renderPath).toBe('native');
		// The output pixel centre (x + ½, y + ½) samples the layer at (x, y): the bilinear mean of the four layer pixels
		// around it.
		const cov = (u: number, v: number) => cropCoverageAt(u + 0.5, v + 0.5, W, HH, ins, 24);
		const c = compare(
			r.rgb,
			(x, y) => {
				const v = Math.round((255 * (cov(x - 1, y - 1) + cov(x, y - 1) + cov(x - 1, y) + cov(x, y))) / 4);
				return [v, v, v];
			},
			3,
		);
		expect(c.bad, `worst ${c.worst}`).toBe(0);
	}, 240_000);
});

describe('adjustment layers: crops limit the region (native)', () => {
	/** Pattern on V1, an adjustment layer on V2 with `effects` (`$l` = the adjustment clip). */
	function adjustmentDoc(effects: unknown[] | null): DocBuilder {
		const d = new DocBuilder('hd-720p-30');
		d.tx([{ type: 'clip.place', source: { mediaId: d.addMedia(patternMedia) }, at: 0, ref: '$p' }]);
		if (effects)
			d.tx([
				{ type: 'track.add', kind: 'video', count: 1 },
				{ type: 'clip.addAdjustment', at: 0, duration: 30, track: 'V2', ref: '$l' },
				...effects,
			]);
		return d;
	}
	const grade = add('jasper.black-white');

	it('Edge Feather fades the adjustment in from the crop edges: original + coverage · (adjusted − original)', async () => {
		const O = (await still(adjustmentDoc(null))).rgb;
		const A = (await still(adjustmentDoc([grade]))).rgb;
		const r = await still(adjustmentDoc([grade, add('jasper.crop', { left: 20, top: 10, feather: 50 })]));
		expect(r.renderPath).toBe('native');
		const ins: [number, number, number, number] = [0.2, 0.1, 0, 0];
		const c = compare(
			r.rgb,
			(x, y) => {
				const k = cropCoverageAt(x + 0.5, y + 0.5, W, HH, ins, 50);
				const o = px(O, x, y);
				const a = px(A, x, y);
				return [0, 1, 2].map((i) => Math.round(o[i]! + k * (a[i]! - o[i]!))) as [number, number, number];
			},
			3,
		);
		expect(c.bad, `worst ${c.worst}`).toBe(0);
	}, 300_000);

	it('a flip after the crop mirrors the region; a flip before it does not', async () => {
		const O = (await still(adjustmentDoc(null))).rgb;
		const A = (await still(adjustmentDoc([grade]))).rgb;
		const half = W / 2;
		const after = await still(
			adjustmentDoc([grade, add('jasper.crop', { left: 50 }), add('jasper.flip-horizontal')]),
		);
		const before = await still(
			adjustmentDoc([grade, add('jasper.flip-horizontal'), add('jasper.crop', { left: 50 })]),
		);
		// Crop → Flip: the window [W/2, W) is mirrored to the left half, which shows the flipped adjusted composite.
		const a = compare(after.rgb, (x, y) => (x < half ? px(A, W - 1 - x, y) : px(O, x, y)), 1);
		expect(a.bad, `worst ${a.worst}`).toBe(0);
		// Flip → Crop: the right half shows the flipped adjusted composite.
		const b = compare(before.rgb, (x, y) => (x >= half ? px(A, W - 1 - x, y) : px(O, x, y)), 1);
		expect(b.bad, `worst ${b.worst}`).toBe(0);
	}, 300_000);
});
