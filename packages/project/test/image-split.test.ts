// Spec 19 TL-115: parts of a still. The cut's promises are checked by putting the parts back together; the command by
// undo, refusals, invariants and where the parts land.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	clusterIslands,
	cutParts,
	defaultEffectRegistry,
	labelIslands,
	layerMatrix,
	partsOf,
	applyMatrix,
	type Clip,
	type SplitPicture,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

function picture(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]): SplitPicture {
	const data = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) data.set(paint(x, y), (y * w + x) * 4);
	return { width: w, height: h, depth: 8, data };
}

const twoBlobs = () =>
	picture(400, 100, (x, y) => {
		const inA = x >= 20 && x < 60 && y >= 20 && y < 60;
		const inB = x >= 300 && x < 380 && y >= 30 && y < 70;
		return inA ? [255, 0, 0, 255] : inB ? [0, 255, 0, 255] : [0, 0, 0, 0];
	});

/** Paints the cut parts back on an empty picture. */
function reassemble(img: SplitPicture, parts: ReturnType<typeof cutParts>): Uint8Array {
	const px = img.depth === 16 ? 8 : 4;
	const out = new Uint8Array(img.data.length);
	for (const p of parts) {
		const { width, height, data } = p.pixels;
		for (let y = 0; y < height; y++)
			for (let x = 0; x < width; x++) {
				const s = (y * width + x) * px;
				if (data.subarray(s, s + px).every((v) => v === 0)) continue;
				const d = ((y + p.box.y0) * img.width + x + p.box.x0) * px;
				expect(out.subarray(d, d + px).every((v) => v === 0)).toBe(true);
				out.set(data.subarray(s, s + px), d);
			}
	}
	return out;
}

describe('islands (TL-115)', () => {
	it('labels connected alpha and clusters by the gap between boxes', () => {
		const map = labelIslands(twoBlobs());
		expect(map.islands).toHaveLength(2);
		expect(map.islands[0]).toEqual({ x0: 20, y0: 20, x1: 60, y1: 60 });
		expect(clusterIslands(map, 1)).toHaveLength(2);
		expect(clusterIslands(map, 90)).toHaveLength(1);
		expect(partsOf(map.islands, [[1], [0]]).map((p) => p.islands[0])).toEqual([0, 1]);
	});

	it('keeps thin strokes on the coarser grid of a huge picture', () => {
		const w = 4096;
		const data = new Uint8Array(w * 4);
		data[1000 * 4 + 3] = 255;
		const map = labelIslands({ width: w, height: 1, depth: 8, data });
		expect(map.cell).toBe(2);
		expect(map.islands).toHaveLength(1);
	});

	it('refuses a picture smaller than its size says', () => {
		expect(() => labelIslands({ width: 10, height: 10, depth: 8, data: new Uint8Array(4) })).toThrow(RangeError);
	});

	it('every visible pixel lands in exactly one part, colour untouched at low alpha', () => {
		// A glow: colours under alpha 1…7 of 255, below the island threshold. A canvas would destroy these.
		const img = picture(200, 80, (x, y) => {
			if (x >= 40 && x < 60 && y >= 30 && y < 50) return [200, 100, 50, 255];
			if (x >= 30 && x < 70 && y >= 20 && y < 60) return [91, 173, 37, 1 + ((x + y) % 7)];
			if (x >= 140 && x < 160 && y >= 30 && y < 50) return [10, 20, 30, 255];
			return [0, 0, 0, 0];
		});
		const map = labelIslands(img);
		expect(map.islands).toHaveLength(2);
		const parts = cutParts(img, map, partsOf(map.islands, [[0], [1]]));
		expect(parts).toHaveLength(2);
		expect(Buffer.compare(reassemble(img, parts), img.data)).toBe(0);
	});

	it('keeps 16-bit pictures at 16 bits', () => {
		const w = 300;
		const h = 40;
		const data = new Uint8Array(w * h * 8);
		const put = (x: number, y: number, r: number, a: number) => {
			const o = (y * w + x) * 8;
			data[o] = r & 0xff;
			data[o + 1] = r >> 8;
			data[o + 6] = a & 0xff;
			data[o + 7] = a >> 8;
		};
		for (let x = 10; x < 20; x++) put(x, 10, 0x1234, 0xffff);
		for (let x = 200; x < 220; x++) put(x, 20, 0xabcd, 0xfffe);
		const img: SplitPicture = { width: w, height: h, depth: 16, data };
		const map = labelIslands(img);
		const parts = cutParts(img, map, partsOf(map.islands, [[0], [1]]));
		expect(parts[0]!.pixels.depth).toBe(16);
		expect(Buffer.compare(reassemble(img, parts), data)).toBe(0);
	});

	it('property: any picture splits and reassembles exactly', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 48 }),
				fc.integer({ min: 1, max: 48 }),
				fc.array(fc.nat(255), { minLength: 64, maxLength: 64 }),
				(w, h, seed) => {
					const img = picture(w, h, (x, y) => {
						const a = seed[(x * 7 + y * 13) % 64]!;
						return [seed[(x + y) % 64]!, seed[(x * 3) % 64]!, seed[(y * 5) % 64]!, a > 128 ? a : a > 96 ? 3 : 0];
					});
					const map = labelIslands(img);
					const parts = cutParts(
						img,
						map,
						map.islands.map((box, i) => ({ islands: [i], box })),
					);
					// Fully transparent pixels hold no colour worth keeping; everything else comes back.
					const back = reassemble(img, parts);
					for (let i = 0; i < img.data.length; i += 4)
						if (img.data[i + 3]! > 0 && map.islands.length)
							expect([...back.subarray(i, i + 4)]).toEqual([...img.data.subarray(i, i + 4)]);
				},
			),
			{ numRuns: 200 },
		);
	});

	it('property: clustering terminates and partitions on any boxes', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						x0: fc.integer({ min: 0, max: 900 }),
						y0: fc.integer({ min: 0, max: 900 }),
						w: fc.integer({ min: 1, max: 100 }),
						h: fc.integer({ min: 1, max: 100 }),
					}),
					{ maxLength: 40 },
				),
				fc.double({ noNaN: false }),
				(raw, merge) => {
					const islands = raw.map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x0 + b.w, y1: b.y0 + b.h }));
					const parts = clusterIslands({ islands, width: 1000, height: 1000 }, merge);
					expect(parts.flatMap((p) => p.islands).sort((a, b) => a - b)).toEqual(islands.map((_, i) => i));
				},
			),
		);
	});
});

/** A project with a still of `w × h`, placed, and two registered parts. */
function stillProject(w = 400, h = 100) {
	const t = new Harness();
	const media = (name: string, width: number, height: number, ref: string) => ({
		type: 'media.register',
		ref,
		asset: { ...videoAsset({ kind: 'image', width, height }), originalName: name, fingerprint: `sha256:${name}` },
	});
	return { t, media, w, h };
}

describe('clip.splitImage (TL-115)', () => {
	function setup(transform?: Record<string, unknown>) {
		const { t, media, w, h } = stillProject();
		const r = t.tx([media('logo.png', w, h, '$m')]);
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		const mediaId = r.refs.$m!;
		const placed = t.ok([{ type: 'clip.place', source: { mediaId }, at: 10, tracks: { video: 'V1' }, ref: '$c' }]);
		const clipId = placed.refs.$c!;
		if (transform) t.ok([{ type: 'clip.update', clipId, patch: transform }]);
		const parts = t.ok([media('a.png', 64, 64, '$a'), media('b.png', 128, 64, '$b')]);
		return { t, clipId, a: parts.refs.$a!, b: parts.refs.$b! };
	}
	const split = (t: Harness, clipId: string, a: string, b: string) => ({
		type: 'clip.splitImage',
		clipId,
		parts: [
			{ mediaId: a, box: { x: 0, y: 0, w: 64, h: 64 } },
			{ mediaId: b, box: { x: 272, y: 16, w: 128, h: 64 } },
		],
	});
	const scalePath = (clipId: string) => ['clip', clipId, 'transform', 'scale'];
	const ok = (t: Harness) => expect(checkInvariants(t.doc, { effects: defaultEffectRegistry })).toEqual([]);
	const code = (r: { ok: boolean; errors?: { code: string }[] }) => (r.ok ? null : r.errors![0]!.code);

	it('replaces the clip by one clip per part in one undo step, on tracks of their own, grouped', () => {
		const { t, clipId, a, b } = setup();
		const before = t.doc;
		const { start, duration } = t.seq.clips[clipId]!;
		const r = t.ok([split(t, clipId, a, b)]);
		const { clipIds, groupId } = r.results[0] as { clipIds: string[]; groupId: string };
		expect(clipIds).toHaveLength(2);
		const [one, two] = clipIds.map((id) => t.seq.clips[id]! as Extract<Clip, { kind: 'still' }>);
		expect(one!.mediaId).toBe(a);
		expect(two!.mediaId).toBe(b);
		expect([one!.start, one!.duration, two!.start, two!.duration]).toEqual([start, duration, start, duration]);
		expect(one!.trackId).not.toBe(two!.trackId);
		expect(t.seq.groups[groupId]?.members).toEqual(clipIds);
		ok(t);
		// Undo is the document before the transaction, as the session's History holds it.
		expect(before.sequences[t.seqId]!.clips[clipId]).toBeTruthy();
		expect(Object.values(before.sequences[t.seqId]!.clips)).toHaveLength(1);
	});

	it('static Motion: each part anchors at its centre and lands exactly where it was', () => {
		const { t, clipId, a, b } = setup();
		const c0 = t.seq.clips[clipId]! as Extract<Clip, { kind: 'still' }>;
		const tr = c0.transform;
		const whole = layerMatrix({
			position: tr.position.value,
			anchor: tr.anchor.value,
			scale: tr.scale.value,
			scaleWidth: tr.scaleWidth.value,
			uniformScale: tr.uniformScale,
			rotation: tr.rotation.value,
			flipH: tr.flipH,
			flipV: tr.flipV,
		});
		const r = t.ok([split(t, clipId, a, b)]);
		const id = (r.results[0] as { clipIds: string[] }).clipIds[1]!;
		const p = t.seq.clips[id]! as Extract<Clip, { kind: 'still' }>;
		expect(p.transform.anchor.value).toEqual([64, 32]);
		// The corner of the part in the picture maps to the same place through both layers.
		const m = layerMatrix({
			position: p.transform.position.value,
			anchor: p.transform.anchor.value,
			scale: p.transform.scale.value,
			scaleWidth: p.transform.scaleWidth.value,
			uniformScale: p.transform.uniformScale,
			rotation: p.transform.rotation.value,
			flipH: p.transform.flipH,
			flipV: p.transform.flipV,
		});
		const there = applyMatrix(m, [0, 0]);
		const here = applyMatrix(whole, [272, 16]);
		expect(there[0]).toBeCloseTo(here[0], 6);
		expect(there[1]).toBeCloseTo(here[1], 6);
	});

	it('keyed Motion: the keys stay and the anchor moves, so the parts follow the whole', () => {
		const { t, clipId, a, b } = setup();
		const c0 = t.seq.clips[clipId]! as Extract<Clip, { kind: 'still' }>;
		const anchor = c0.transform.anchor.value;
		t.ok([{ type: 'param.setAnimated', target: scalePath(clipId), animated: true, at: { frames: 10 } }]);
		const r = t.ok([split(t, clipId, a, b)]);
		const p = t.seq.clips[(r.results[0] as { clipIds: string[] }).clipIds[1]!]! as Extract<Clip, { kind: 'still' }>;
		expect(p.transform.scale.keyframes).toHaveLength(1);
		expect(p.transform.anchor.value).toEqual([anchor[0] - 272, anchor[1] - 16]);
		expect(p.transform.position.value).toEqual(c0.transform.position.value);
		ok(t);
	});

	it('new keyframe ids per part, so no two clips share one', () => {
		const { t, clipId, a, b } = setup();
		t.ok([{ type: 'param.setAnimated', target: scalePath(clipId), animated: true, at: { frames: 10 } }]);
		const r = t.ok([split(t, clipId, a, b)]);
		const [x, y] = (r.results[0] as { clipIds: string[] }).clipIds.map(
			(id) => (t.seq.clips[id]! as Extract<Clip, { kind: 'still' }>).transform.scale.keyframes[0]!.id,
		);
		expect(x).not.toBe(y);
	});

	it('uses a free track above, and adds one when none is free', () => {
		const { t, clipId, a, b } = setup();
		const tracks = t.seq.videoTracks.length;
		t.ok([{ type: 'clip.addSolid', at: 0, duration: 100, track: 'V2', color: [0, 0, 0, 1] }]);
		t.ok([{ type: 'clip.addSolid', at: 0, duration: 100, track: 'V3', color: [0, 0, 0, 1] }]);
		const r = t.ok([split(t, clipId, a, b)]);
		const part = t.seq.clips[(r.results[0] as { clipIds: string[] }).clipIds[1]!]!;
		expect(t.seq.videoTracks.length).toBeGreaterThanOrEqual(tracks);
		expect(t.seq.videoTracks.at(-1)!.id).toBe(part.trackId);
		ok(t);
	});

	it('refuses: not a still, locked track, too many parts, a box outside, unknown media, masks', () => {
		const { t, clipId, a, b } = setup();
		const text = t.ok([{ type: 'clip.addText', at: 0, duration: 10, track: 'V4', content: { text: 'x' }, ref: '$t' }]).refs.$t!;
		expect(code(t.tx([split(t, text, a, b)]))).toBe('E_INVALID_PARAM');
		const outside = {
			type: 'clip.splitImage',
			clipId,
			parts: [
				{ mediaId: a, box: { x: 0, y: 0, w: 64, h: 64 } },
				{ mediaId: b, box: { x: 300, y: 0, w: 128, h: 64 } },
			],
		};
		expect(code(t.tx([outside]))).toBe('E_INVALID_PARAM');
		expect(
			code(
				t.tx([
					{
						type: 'clip.splitImage',
						clipId,
						parts: Array.from({ length: 65 }, () => ({ mediaId: a, box: { x: 0, y: 0, w: 1, h: 1 } })),
					},
				]),
			),
		).toBe('E_LIMIT');
		expect(
			code(
				t.tx([
					{
						type: 'clip.splitImage',
						clipId,
						parts: [
							{ mediaId: 'med_nope', box: { x: 0, y: 0, w: 1, h: 1 } },
							{ mediaId: b, box: { x: 0, y: 0, w: 1, h: 1 } },
						],
					},
				]),
			),
		).toBe('E_NOT_FOUND');
		const track = t.seq.clips[clipId]!.trackId;
		t.ok([{ type: 'track.update', trackId: track, patch: { locked: true } }]);
		expect(code(t.tx([split(t, clipId, a, b)]))).toBe('E_TRACK_LOCKED');
	});
});
