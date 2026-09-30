// S07:PRC-006 property tests: Motion compensation for source swaps keeps the rendered framing identical, and a
// swap followed by the inverse swap restores Motion (random scales/anchors/keyframes/trackers/sizes, including
// anisotropic size changes such as 848×480 → 1920×1080).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	applyMatrix,
	buildRenderSnapshot,
	type ClipTracker,
	type EffectInstance,
	INTERPOLATIONS,
	isIsotropicResize,
	type Keyframe,
	type PixelSize,
	type ProjectDocument,
	type RenderVisualClip,
	rescaleClipForSource,
	resolveLayerProps,
	resolveSceneAt,
	type Transform,
	type Vec2,
	type VideoClip,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

type Clipish = { transform: Transform; trackers?: ClipTracker[]; effects: EffectInstance[] };

// ---------------------------------------------------------------- arbitraries

let kfSeq = 0;
const kfId = () => `kf_${(++kfSeq).toString(32).toUpperCase().padStart(16, '0').slice(-16)}`;

const easeArb = fc.record({
	influence: fc.double({ min: 0.01, max: 1, noNaN: true }),
	slope: fc.double({ min: 0, max: 3, noNaN: true }),
});

function animArb<T>(valueArb: fc.Arbitrary<T>, maxKeys = 4): fc.Arbitrary<Animatable<T>> {
	return fc
		.record({
			value: valueArb,
			times: fc.uniqueArray(fc.integer({ min: 0, max: 20 }), { maxLength: maxKeys }),
			keys: fc.array(
				fc.record({
					value: valueArb,
					interpolation: fc.constantFrom(...INTERPOLATIONS),
					easeIn: easeArb,
					easeOut: easeArb,
				}),
				{ minLength: maxKeys, maxLength: maxKeys },
			),
		})
		.map(({ value, times, keys }) => ({
			value,
			keyframes: [...times]
				.sort((a, b) => a - b)
				.map((t, i): Keyframe<T> => ({ id: kfId(), time: t * 23_520_000, ...keys[i]! })),
		}));
}

// Documents are JSON: no -0 (it would come back as 0).
const num = (min: number, max: number) => fc.double({ min, max, noNaN: true }).map((v) => v + 0);
const scaleValue = num(1, 400);
const coord = num(-2000, 2000);
const vec2 = fc.tuple(coord, coord) as fc.Arbitrary<Vec2>;

const copyWithNewIds = (a: Animatable<number>): Animatable<number> => ({
	value: a.value,
	keyframes: a.keyframes.map((k) => ({ ...k, id: kfId() })),
});

const transformArb: fc.Arbitrary<Transform> = fc
	.record({
		position: animArb(vec2),
		anchor: animArb(vec2),
		scale: animArb(scaleValue),
		scaleWidth: animArb(scaleValue),
		uniformScale: fc.boolean(),
		rotation: animArb(num(-720, 720)),
		flipH: fc.boolean(),
		flipV: fc.boolean(),
	})
	// While Uniform Scale is on, Scale Width mirrors Scale (what factories and Scale to Frame Size write).
	.map((t) => (t.uniformScale ? { ...t, scaleWidth: copyWithNewIds(t.scale) } : t));

const trackerArb: fc.Arbitrary<ClipTracker> = fc
	.record({
		planar: fc.boolean(),
		corners: fc.array(vec2, { minLength: 4, maxLength: 4 }),
		point: vec2,
		patch: fc.integer({ min: 1, max: 100 }),
		search: fc.integer({ min: 1, max: 200 }),
		data: fc.array(coord, { minLength: 0, maxLength: 5 }),
	})
	.map(({ planar, corners, point, patch, search, data }) => {
		const stride = planar ? 8 : 2;
		const n = data.length;
		const flat = Array.from({ length: n * stride }, (_, i) => data[i % n]! + i);
		return {
			id: 'tkr_0000000000000001',
			name: 'T',
			kind: planar ? 'planar' : 'point',
			reference: planar ? { time: 0, corners, search } : { time: 0, point, patch, search },
			samples: n ? { start: 0, step: 23_520_000, stride, data: flat, confidence: data.map(() => 1) } : null,
			method: 'klt@1',
		};
	});

const dim = fc.integer({ min: 16, max: 4096 });
/** Old/new layer boxes: exact 2×/4× upscales, `size`-style anisotropic targets, arbitrary sizes. */
const sizesArb: fc.Arbitrary<[PixelSize, PixelSize]> = fc.oneof(
	fc.record({ w: dim, h: dim, k: fc.constantFrom(2, 4) }).map(({ w, h, k }): [PixelSize, PixelSize] => [
		{ width: w, height: h },
		{ width: w * k, height: h * k },
	]),
	fc.constant<[PixelSize, PixelSize]>([
		{ width: 848, height: 480 },
		{ width: 1920, height: 1080 },
	]),
	fc.tuple(dim, dim, dim, dim).map(([a, b, c, d]): [PixelSize, PixelSize] => [
		{ width: a, height: b },
		{ width: c, height: d },
	]),
);

const cropArb = fc
	.record({
		left: fc.double({ min: 0, max: 45, noNaN: true }),
		right: fc.double({ min: 0, max: 45, noNaN: true }),
		top: fc.double({ min: 0, max: 45, noNaN: true }),
		bottom: fc.double({ min: 0, max: 45, noNaN: true }),
	})
	.map(
		(c): EffectInstance => ({
			id: 'fx_0000000000000001',
			effectId: 'jasper.crop',
			effectVersion: 1,
			enabled: true,
			params: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { value: v, keyframes: [] }])),
		}),
	);

const clipArb: fc.Arbitrary<Clipish> = fc.record({
	transform: transformArb,
	trackers: fc.array(trackerArb, { maxLength: 2 }),
	effects: fc.option(cropArb, { nil: undefined }).map((c) => (c ? [c] : [])),
});

// ---------------------------------------------------------------- helpers

const TOL = 1e-9;
const close = (a: number, b: number, scale = 1) =>
	Math.abs(a - b) <= TOL * Math.max(scale, Math.abs(a), Math.abs(b));

/** Deep equality with a relative tolerance on numbers. Returns the first differing path, or null. */
function diffDeep(a: unknown, b: unknown, path = ''): string | null {
	if (typeof a === 'number' && typeof b === 'number') return close(a, b) ? null : `${path}: ${a} ≠ ${b}`;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return `${path}: length ${a.length} ≠ ${b.length}`;
		for (let i = 0; i < a.length; i++) {
			const d = diffDeep(a[i], b[i], `${path}[${i}]`);
			if (d) return d;
		}
		return null;
	}
	if (a && b && typeof a === 'object' && typeof b === 'object') {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		for (const k of keys) {
			const d = diffDeep(
				(a as Record<string, unknown>)[k],
				(b as Record<string, unknown>)[k],
				`${path}.${k}`,
			);
			if (d) return d;
		}
		return null;
	}
	return Object.is(a, b) ? null : `${path}: ${String(a)} ≠ ${String(b)}`;
}

function renderClip(c: Clipish, box: PixelSize): RenderVisualClip {
	return {
		transform: c.transform,
		opacity: { value: 100, keyframes: [] },
		effects: c.effects,
		intrinsicBox: box,
	} as unknown as RenderVisualClip;
}

/** Content times to probe: every keyframe time, midpoints, and outside the keyframe range. */
function sampleTimes(t: Transform): number[] {
	const times = new Set<number>([-1, 0]);
	for (const a of [t.position, t.anchor, t.scale, t.scaleWidth, t.rotation]) {
		for (const k of a.keyframes) {
			times.add(k.time);
			times.add(k.time + 7_840_000);
			times.add(k.time + 15_680_000);
		}
	}
	times.add(21 * 23_520_000);
	return [...times];
}

const UV: Vec2[] = [
	[0, 0],
	[1, 0],
	[1, 1],
	[0, 1],
	[0.5, 0.5],
	[0.25, 0.8],
	[0.9, 0.13],
];

/**
 * Asserts that `a` on a layer of `oldSize` and `b` on `newSize` draw the same picture at every probe: the same
 * sequence point for the same normalised source point, the same cropped quad, the same tracker points. The
 * error is measured relative to the magnitude of the coordinates involved (translation and result).
 */
function expectSameFraming(a: Clipish, b: Clipish, oldSize: PixelSize, newSize: PixelSize): void {
	const ra = renderClip(a, oldSize);
	const rb = renderClip(b, newSize);
	let worst = 0;
	let where = '';
	const check = (x: Vec2, y: Vec2, extra: number, what: string) => {
		const mag = 1 + extra + Math.abs(x[0]) + Math.abs(x[1]);
		const err = Math.max(Math.abs(x[0] - y[0]), Math.abs(x[1] - y[1])) / mag;
		if (err > worst) {
			worst = err;
			where = `${what}: ${x} vs ${y}`;
		}
	};
	for (const t of sampleTimes(a.transform)) {
		const pa = resolveLayerProps(ra, t);
		const pb = resolveLayerProps(rb, t);
		const m = pa.matrix;
		const extra = Math.abs(m.e) + Math.abs(m.f) + Math.abs(pb.matrix.e) + Math.abs(pb.matrix.f);
		for (const [u, v] of UV)
			check(
				applyMatrix(m, [u * oldSize.width, v * oldSize.height]),
				applyMatrix(pb.matrix, [u * newSize.width, v * newSize.height]),
				extra,
				`t=${t} uv=${u},${v}`,
			);
		for (let i = 0; i < 4; i++) check(pa.quad[i]!, pb.quad[i]!, extra, `t=${t} quad ${i}`);
		(a.trackers ?? []).forEach((tr, ti) => {
			const tb = b.trackers![ti]!;
			const pairs: [Vec2, Vec2][] = [];
			tr.reference.corners?.forEach((p, i) => {
				pairs.push([p, tb.reference.corners![i]!]);
			});
			if (tr.reference.point) pairs.push([tr.reference.point, tb.reference.point!]);
			const da = tr.samples?.data ?? [];
			const db = tb.samples?.data ?? [];
			for (let i = 0; i + 1 < da.length; i += 2)
				pairs.push([
					[da[i]!, da[i + 1]!],
					[db[i]!, db[i + 1]!],
				]);
			for (const [p, q] of pairs)
				check(
					applyMatrix(m, p),
					applyMatrix(pb.matrix, q),
					extra + 16 * (Math.abs(p[0]) + Math.abs(p[1])),
					`t=${t} tracker`,
				);
		});
	}
	expect(worst, where).toBeLessThanOrEqual(TOL);
}

/**
 * Round-trip comparison. Under anisotropic changes `auto-bezier` anchor keyframes come back as `bezier` with
 * the eases auto-bezier had (same motion, see rescale.ts); integer template sizes round-trip exactly when the
 * first swap enlarges them.
 */
function normalizeForRoundTrip(c: Clipish, anisotropic: boolean, growing: boolean): unknown {
	const x = JSON.parse(JSON.stringify(c)) as Clipish;
	if (anisotropic)
		for (const k of x.transform.anchor.keyframes) {
			const kk = k as Partial<Keyframe<Vec2>>;
			delete kk.interpolation;
			delete kk.easeIn;
			delete kk.easeOut;
		}
	if (!growing)
		for (const tr of x.trackers ?? []) {
			delete tr.reference.patch;
			delete tr.reference.search;
		}
	return x;
}

// ---------------------------------------------------------------- properties

describe('rescaleClipForSource (S07:PRC-006)', () => {
	it('keeps the rendered framing identical (matrix, cropped quad, tracker points) for any size change', () => {
		fc.assert(
			fc.property(clipArb, sizesArb, (clip, [oldSize, newSize]) => {
				const next = rescaleClipForSource(clip, oldSize, newSize, { newKeyframeId: kfId });
				expectSameFraming(clip, next, oldSize, newSize);
				// Unrelated fields are untouched; the input is not mutated.
				expect(next.effects).toEqual(clip.effects);
				expect(next.transform.position).toEqual(clip.transform.position);
				expect(next.transform.rotation).toEqual(clip.transform.rotation);
				expect([next.transform.flipH, next.transform.flipV]).toEqual([
					clip.transform.flipH,
					clip.transform.flipV,
				]);
			}),
			{ numRuns: 400 },
		);
	});

	it('a swap and its inverse restore Motion and trackers (within 1e-9)', () => {
		fc.assert(
			fc.property(clipArb, sizesArb, (clip, [oldSize, newSize]) => {
				const there = rescaleClipForSource(clip, oldSize, newSize, { newKeyframeId: kfId });
				const back = rescaleClipForSource(there, newSize, oldSize, { newKeyframeId: kfId });
				const anisotropic = !isIsotropicResize(oldSize, newSize);
				const growing = newSize.width * newSize.height >= oldSize.width * oldSize.height;
				const d = diffDeep(
					normalizeForRoundTrip(back, anisotropic, growing),
					normalizeForRoundTrip(clip, anisotropic, growing),
				);
				expect(d).toBeNull();
				if (anisotropic && clip.transform.uniformScale) expect(there.transform.uniformScale).toBe(false);
				if (!anisotropic) expect(there.transform.uniformScale).toBe(clip.transform.uniformScale);
			}),
			{ numRuns: 400 },
		);
	});

	it('exact powers of two round-trip bit-exactly', () => {
		fc.assert(
			fc.property(clipArb, dim, dim, fc.constantFrom(2, 4), (clip, w, h, k) => {
				const a = { width: w, height: h };
				const b = { width: w * k, height: h * k };
				expect(rescaleClipForSource(rescaleClipForSource(clip, a, b), b, a)).toEqual(clip);
			}),
			{ numRuns: 200 },
		);
	});

	it('848×480 → 1920×1080: per-axis factors, Uniform Scale split and restored', () => {
		const t: Transform = {
			position: { value: [960, 540], keyframes: [] },
			anchor: { value: [424, 240], keyframes: [] },
			scale: { value: 226.4, keyframes: [] },
			scaleWidth: { value: 226.4, keyframes: [] },
			uniformScale: true,
			rotation: { value: 0, keyframes: [] },
			flipH: false,
			flipV: false,
		};
		const a = { width: 848, height: 480 };
		const b = { width: 1920, height: 1080 };
		const up = rescaleClipForSource({ transform: t }, a, b);
		expect(up.transform.uniformScale).toBe(false);
		expect(up.transform.anchor.value).toEqual([960, 540]);
		expect(up.transform.scaleWidth.value).toBeCloseTo((226.4 * 848) / 1920, 12);
		expect(up.transform.scale.value).toBeCloseTo((226.4 * 480) / 1080, 12);
		const back = rescaleClipForSource(up, b, a);
		expect(back.transform.uniformScale).toBe(true);
		expect(diffDeep(back.transform, t)).toBeNull();
	});

	it('same size is a plain copy; animated Uniform Scale splits need new keyframe ids', () => {
		const clip = fc.sample(clipArb, { numRuns: 1, seed: 3 })[0]!;
		const s = { width: 100, height: 50 };
		const copy = rescaleClipForSource(clip, s, s);
		expect(copy).toEqual(clip);
		expect(copy).not.toBe(clip);
		const t: Transform = {
			...clip.transform,
			uniformScale: true,
			scale: {
				value: 100,
				keyframes: [
					{
						id: 'kf_A',
						time: 0,
						value: 100,
						interpolation: 'linear',
						easeIn: { influence: 0.3, slope: 0 },
						easeOut: { influence: 0.3, slope: 0 },
					},
				],
			},
			scaleWidth: { value: 100, keyframes: [] },
		};
		expect(() =>
			rescaleClipForSource({ transform: t }, { width: 848, height: 480 }, { width: 1920, height: 1080 }),
		).toThrow(/newKeyframeId/);
		const ok = rescaleClipForSource(
			{ transform: t },
			{ width: 848, height: 480 },
			{ width: 1920, height: 1080 },
			{
				newKeyframeId: () => 'kf_B',
			},
		);
		expect(ok.transform.scaleWidth.keyframes.map((k) => k.id)).toEqual(['kf_B']);
	});
});

// ---------------------------------------------------------------- through the commands

describe('clip.replaceSource with random Motion (S07 §8 test 1)', () => {
	it('keeps the rendered layer identical and restores Motion when swapping back; invariants hold', () => {
		fc.assert(
			fc.property(transformArb, sizesArb, (transform, [oldSize, newSize]) => {
				const h = new Harness();
				const mediaId = h.registerVideo({ width: oldSize.width, height: oldSize.height, seconds: 10 });
				const {
					kind: _k,
					derivation: _d,
					importedAt: _i,
					id: _id,
					...file
				} = videoAsset({
					width: newSize.width,
					height: newSize.height,
					seconds: 10,
				});
				const r = h.ok([
					{ type: 'clip.place', source: { mediaId }, at: 0 },
					{
						type: 'media.derive',
						fromMediaId: mediaId,
						recipe: { op: 'process', steps: [{ op: 'upscale', model: 'm', scale: 2 }] },
						asset: { ...file, recipeVersion: 1, recipeHash: 'sha256:x' },
						ref: '$v',
					},
				]);
				const version = r.refs.$v!;
				const clipId = h.clips('V1')[0]!.id;
				// Give the clip the random Motion (valid ids from the harness).
				const doc = JSON.parse(JSON.stringify(h.doc)) as ProjectDocument;
				const withIds = JSON.parse(JSON.stringify(transform), (k, v) =>
					k === 'id' && typeof v === 'string' ? h.ids.next('kf') : v,
				) as Transform;
				(doc.sequences[h.seqId]!.clips[clipId] as VideoClip).transform = withIds;
				h.doc = doc;
				const original = h.seq.clips[clipId] as VideoClip;
				const layersAt = (d: ProjectDocument) =>
					[0, 5, 11, 17].map(
						(f) =>
							resolveSceneAt(
								buildRenderSnapshot(d, h.seqId, { resolveMedia: () => null, resolveFont: () => null }),
								f,
							)[0]!.props,
					);
				const before = layersAt(h.doc);

				h.ok([{ type: 'clip.replaceSource', clipId, mediaId: version }]);
				const swapped = h.seq.clips[clipId] as VideoClip;
				expect(swapped.mediaId).toBe(version);
				const after = layersAt(h.doc);
				before.forEach((p, i) => {
					const q = after[i]!;
					const mag = 1 + 4 * 4096 * 4 * 4;
					for (let c = 0; c < 4; c++) {
						expect(Math.abs(p.quad[c]![0] - q.quad[c]![0])).toBeLessThanOrEqual(TOL * mag);
						expect(Math.abs(p.quad[c]![1] - q.quad[c]![1])).toBeLessThanOrEqual(TOL * mag);
					}
				});

				h.ok([{ type: 'clip.replaceSource', clipId, mediaId }]);
				const back = h.seq.clips[clipId] as VideoClip;
				const anisotropic = !isIsotropicResize(oldSize, newSize);
				expect(
					diffDeep(
						normalizeForRoundTrip({ ...back, effects: [] }, anisotropic, true),
						normalizeForRoundTrip({ ...original, effects: [] }, anisotropic, true),
					),
				).toBeNull();
			}),
			{ numRuns: 60 },
		);
	});
});
