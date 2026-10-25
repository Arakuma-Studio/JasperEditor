// Crop in stack order and Edge Feather on the native path (schema v8, docs/wp-notes/crop-order.md). Lossless PNG
// stills compare original pixels and the Program’s independently tested scalar feather profile with the native
// filter graph, which implements that profile separately (crop-order.md A1–A4).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cropEdgeCoverage } from '@jasper/project';
import { decodePng, encodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, H, JSON_H, makeApp, register, type TestApp, tempAppdir } from './helpers.ts';

const W = 320;
const HH = 180;
let app: TestApp;
let patternMedia: Awaited<ReturnType<typeof register>>;
let pattern: Uint8Array;

beforeAll(async () => {
	app = await makeApp();
	const file = join(tempAppdir('jasper-crop-order-'), 'pattern.png');
	// Asymmetric, opaque: a flip or a misplaced cut changes almost every pixel.
	pattern = new Uint8Array(W * HH * 4);
	for (let y = 0; y < HH; y++)
		for (let x = 0; x < W; x++)
			pattern.set(
				[(x * 7 + y * 3) % 256, (x * 5 + y * 11) % 256, (x * 13 + y * 2) % 256, 255],
				(y * W + x) * 4,
			);
	writeFileSync(file, encodePng({ width: W, height: HH, data: pattern }));
	patternMedia = await register(app, file);
}, 180_000);
afterAll(closeApps);

async function still(d: DocBuilder, frame = 0): Promise<{ rgba: Uint8Array; renderPath: string }> {
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
	expect(png.statusCode, png.body).toBe(200);
	const image = decodePng(png.rawPayload);
	expect([image.width, image.height]).toEqual([W, HH]);
	return { rgba: image.data, renderPath: (done.result as { renderPath: string }).renderPath };
}

function newDoc(): DocBuilder {
	const d = new DocBuilder();
	d.tx([{ type: 'sequence.updateSettings', settings: { width: W, height: HH } }]);
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
	rgba: Uint8Array,
	want: (x: number, y: number) => [number, number, number],
	tol: number,
): { worst: number; bad: number } {
	let worst = 0;
	let bad = 0;
	for (let y = 0; y < HH; y++)
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			const e = want(x, y);
			const d = Math.max(
				Math.abs(rgba[i]! - e[0]),
				Math.abs(rgba[i + 1]! - e[1]),
				Math.abs(rgba[i + 2]! - e[2]),
			);
			worst = Math.max(worst, d);
			if (d > tol) bad++;
		}
	return { worst, bad };
}

const px = (buf: Uint8Array, x: number, y: number): [number, number, number] => {
	const i = (y * W + x) * 4;
	return [buf[i]!, buf[i + 1]!, buf[i + 2]!];
};
const BLACK: [number, number, number] = [0, 0, 0];

/** The four documented edges multiply (crop-order.md A3); native masks do not call this scalar profile. */
function coverageAt(
	x: number,
	y: number,
	w: number,
	h: number,
	insets: readonly number[],
	feather: number,
): number {
	return (
		cropEdgeCoverage(x - insets[0]! * w, feather) *
		cropEdgeCoverage((1 - insets[2]!) * w - x, feather) *
		cropEdgeCoverage(y - insets[1]! * h, feather) *
		cropEdgeCoverage((1 - insets[3]!) * h - y, feather)
	);
}

describe('Crop where it sits in the stack (native)', () => {
	it('Crop → Flip mirrors the cut window; Flip → Crop cuts the flipped picture', async () => {
		const cut = Math.round(0.3 * W);
		const a = await still(patternDoc([add('jasper.crop', { left: 30 }), add('jasper.flip-horizontal')]));
		const b = await still(patternDoc([add('jasper.flip-horizontal'), add('jasper.crop', { left: 30 })]));
		expect(a.renderPath).toBe('native');
		expect(b.renderPath).toBe('native');
		// Crop → Flip: the window [cut, W) is mirrored to [0, W − cut).
		expect(compare(a.rgba, (x, y) => (x < W - cut ? px(pattern, W - 1 - x, y) : BLACK), 0)).toEqual({
			worst: 0,
			bad: 0,
		});
		// Flip → Crop: the flipped picture, cut on the left.
		expect(compare(b.rgba, (x, y) => (x >= cut ? px(pattern, W - 1 - x, y) : BLACK), 0)).toEqual({
			worst: 0,
			bad: 0,
		});
	}, 240_000);

	it('Edge Feather multiplies alpha by the Program profile (≤ 2/255)', async () => {
		const ins: [number, number, number, number] = [0.1, 0.08, 0.15, 0.2];
		const r = await still(
			whiteDoc([add('jasper.crop', { left: 10, top: 8, right: 15, bottom: 20, feather: 40 })]),
		);
		expect(r.renderPath).toBe('native');
		const want = (x: number, y: number): [number, number, number] => {
			const v = Math.round(255 * coverageAt(x + 0.5, y + 0.5, W, HH, ins, 40));
			return [v, v, v];
		};
		const c = compare(r.rgba, want, 2);
		expect(c.bad, `worst ${c.worst}`).toBe(0);
		// The left crop edge is x = 32: twenty pixels into a forty-pixel ramp is about half opacity.
		expect(px(r.rgba, 52, 90)[0]).toBeGreaterThan(120);
		expect(px(r.rgba, 52, 90)[0]).toBeLessThan(136);
	}, 240_000);

	it('a feathered crop before a flip is mirrored with its feather', async () => {
		const ins: [number, number, number, number] = [0.25, 0, 0, 0];
		const r = await still(
			whiteDoc([add('jasper.crop', { left: 25, feather: 30 }), add('jasper.flip-horizontal')]),
		);
		const c = compare(
			r.rgba,
			(x, y) => {
				const v = Math.round(255 * coverageAt(W - 1 - x + 0.5, y + 0.5, W, HH, ins, 30));
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
			r.rgba,
			(x, y) => {
				const v = Math.round(255 * coverageAt(x + 0.5, y + 0.5, W, HH, ins, 30));
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
		const cov = (u: number, v: number) => coverageAt(u + 0.5, v + 0.5, W, HH, ins, 24);
		const c = compare(
			r.rgba,
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
		const d = new DocBuilder();
		d.tx([{ type: 'sequence.updateSettings', settings: { width: W, height: HH } }]);
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

	it('adjustment coverage feathers the grade and follows only flips after the crop', async () => {
		const O = (await still(adjustmentDoc(null))).rgba;
		const A = (await still(adjustmentDoc([grade]))).rgba;
		const r = await still(adjustmentDoc([grade, add('jasper.crop', { left: 20, top: 10, feather: 50 })]));
		expect(r.renderPath).toBe('native');
		const ins: [number, number, number, number] = [0.2, 0.1, 0, 0];
		const c = compare(
			r.rgba,
			(x, y) => {
				const k = coverageAt(x + 0.5, y + 0.5, W, HH, ins, 50);
				const o = px(O, x, y);
				const a = px(A, x, y);
				return [0, 1, 2].map((i) => Math.round(o[i]! + k * (a[i]! - o[i]!))) as [number, number, number];
			},
			3,
		);
		expect(c.bad, `worst ${c.worst}`).toBe(0);
		const half = W / 2;
		const after = await still(
			adjustmentDoc([grade, add('jasper.crop', { left: 50 }), add('jasper.flip-horizontal')]),
		);
		const before = await still(
			adjustmentDoc([grade, add('jasper.flip-horizontal'), add('jasper.crop', { left: 50 })]),
		);
		// Crop → Flip: the window [W/2, W) is mirrored to the left half, which shows the flipped adjusted composite.
		const a = compare(after.rgba, (x, y) => (x < half ? px(A, W - 1 - x, y) : px(O, x, y)), 1);
		expect(a.bad, `worst ${a.worst}`).toBe(0);
		// Flip → Crop: the right half shows the flipped adjusted composite.
		const b = compare(before.rgba, (x, y) => (x >= half ? px(A, W - 1 - x, y) : px(O, x, y)), 1);
		expect(b.bad, `worst ${b.worst}`).toBe(0);
	}, 300_000);
});
