import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	applyMatrix,
	type ClipTracker,
	type EffectInstance,
	INTERPOLATIONS,
	type Keyframe,
	type PixelSize,
	type RenderVisualClip,
	rescaleClipForSource,
	resolveLayerProps,
	type Transform,
	type Vec2,
} from '../src/index.ts';

type Clipish = { transform: Transform; trackers?: ClipTracker[]; effects: EffectInstance[] };

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

const TOL = 1e-9;
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

describe('rescaleClipForSource (S07:PRC-006)', () => {
	it('keeps the rendered framing identical (matrix, cropped quad, tracker points) for any size change', () => {
		fc.assert(
			fc.property(clipArb, sizesArb, (clip, [oldSize, newSize]) => {
				const next = rescaleClipForSource(clip, oldSize, newSize, { newKeyframeId: kfId });
				expectSameFraming(clip, next, oldSize, newSize);
			}),
			{ numRuns: 400 },
		);
	});
});
