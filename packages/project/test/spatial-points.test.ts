// spatial-points: curved (spatial Bézier) motion paths on effect point params — values and tangents normalised to the
// layer box, lengths measured in the box's pixels (docs/wp-notes/spatial-points.md).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	buildEffectPreset,
	buildKeyframesPayload,
	checkInvariants,
	defaultEffectRegistry,
	type EffectInstance,
	effectiveTangents,
	evaluate,
	type Keyframe,
	planSimplify,
	resolveLayerProps,
	type Spatial,
	type SpatialMetric,
	type Vec2,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F = 23_520_000; // flicks per frame at 30 fps
const LIN = { influence: 1 / 3, slope: 1 };
const W = 1920;
const H = 1080;
const M: SpatialMetric = [W, H];

function key(frame: number, value: Vec2, spatial?: Spatial, extra: Partial<Keyframe<Vec2>> = {}) {
	return {
		id: `kf_${String(frame).padStart(6, '0')}`,
		time: frame * F,
		value,
		interpolation: 'linear',
		easeIn: LIN,
		easeOut: LIN,
		...(spatial ? { spatial } : {}),
		...extra,
	} as Keyframe<Vec2>;
}
const bez = (inTangent: Vec2, outTangent: Vec2): Spatial => ({ mode: 'bezier', inTangent, outTangent });
const anim = (keyframes: Keyframe<Vec2>[]): Animatable<Vec2> => ({ value: [0, 0], keyframes });
const px = (v: Vec2): Vec2 => [v[0] * W, v[1] * H];
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** De Casteljau subdivision, independent of the production polynomial evaluator. */
function cubic(seg: [Vec2, Vec2, Vec2, Vec2], t: number): Vec2 {
	const p = seg.map((v) => [...v]);
	for (let n = 3; n > 0; n--)
		for (let i = 0; i < n; i++)
			for (let axis = 0; axis < 2; axis++) p[i]![axis] = (1 - t) * p[i]![axis]! + t * p[i + 1]![axis]!;
	return p[0] as Vec2;
}

/** Numerical arc-length oracle in pixels: construct one immutable 100,000-step table per authored segment. */
function reference(seg: [Vec2, Vec2, Vec2, Vec2]): (s: number) => Vec2 {
	const N = 100_000;
	const cum = new Float64Array(N + 1);
	let prev = px(seg[0]);
	for (let j = 1; j <= N; j++) {
		const p = px(cubic(seg, j / N));
		cum[j] = cum[j - 1]! + dist(p, prev);
		prev = p;
	}
	return (s) => {
		const target = s * cum[N]!;
		let j = 0;
		while (j < N && cum[j + 1]! < target) j++;
		const f = cum[j + 1]! > cum[j]! ? (target - cum[j]!) / (cum[j + 1]! - cum[j]!) : 0;
		return cubic(seg, (j + f) / N);
	};
}

describe('evaluation with a layer-box metric', () => {
	const A: Vec2 = [0.2, 0.3];
	const B: Vec2 = [0.8, 0.6];
	const a = anim([key(0, A, bez([0, 0], [0.1, 0.5])), key(60, B, bez([0, 0.4], [0, 0]))]);
	const seg: [Vec2, Vec2, Vec2, Vec2] = [A, [0.3, 0.8], [0.8, 1.0], B];

	it('a curved effect point lies on the Bézier of its normalised control points, timed by arc length in px', () => {
		const at = reference(seg);
		const before = structuredClone(a);
		for (let f = 0; f <= 60; f += 3) {
			const got = evaluate(a, f * F, { metric: M });
			const want = at(f / 60);
			// The evaluator's 64-sample arc-length table: ≲ 1e-4 of the path length (S03:KF-031).
			expect(dist(px(got), px(want))).toBeLessThan(0.25);
		}
		expect(a).toEqual(before);
	});

	it('Linear temporal = constant speed in layer pixels (not in normalised units)', () => {
		const speeds = (metric?: SpatialMetric) => {
			const out: number[] = [];
			for (let f = 0; f < 60; f++)
				out.push(
					dist(
						px(evaluate(a, f * F, metric ? { metric } : undefined)),
						px(evaluate(a, (f + 1) * F, metric ? { metric } : undefined)),
					),
				);
			return out;
		};
		const spread = (v: number[]) =>
			(Math.max(...v) - Math.min(...v)) / (v.reduce((x, y) => x + y) / v.length);
		expect(spread(speeds(M))).toBeLessThan(0.01);
		// Without the metric the speed is constant in normalised units, which is uneven on a 16:9 layer.
		expect(spread(speeds())).toBeGreaterThan(0.05);
	});

	it('a circle drawn on a 16:9 layer stays round and is travelled at constant pixel speed', () => {
		// A circle of radius 300 px around the box centre, four Bezier keys (κ = 0.5523), normalised per axis.
		const k = 0.5522847498 * 300;
		const c: Vec2 = [W / 2, H / 2];
		const n = (p: Vec2): Vec2 => [p[0] / W, p[1] / H];
		const pts: Vec2[] = [
			[c[0] + 300, c[1]],
			[c[0], c[1] + 300],
			[c[0] - 300, c[1]],
			[c[0], c[1] - 300],
			[c[0] + 300, c[1]],
		];
		const tan: Vec2[] = [
			[0, k],
			[-k, 0],
			[0, -k],
			[k, 0],
			[0, k],
		];
		const keys = pts.map((p, i) => {
			const t = n(tan[i]!);
			return key(i * 30, n(p), { mode: 'continuous-bezier', inTangent: [-t[0], -t[1]], outTangent: t });
		});
		const circle = anim(keys);
		const radii: number[] = [];
		const steps: number[] = [];
		let prev: Vec2 | null = null;
		for (let f = 0; f <= 120; f++) {
			const p = px(evaluate(circle, f * F, { metric: M }));
			radii.push(dist(p, c));
			if (prev) steps.push(dist(p, prev));
			prev = p;
		}
		for (const r of radii) expect(Math.abs(r - 300)).toBeLessThan(0.1); // κ approximation: ≤ 0.03 %
		const mean = steps.reduce((x, y) => x + y) / steps.length;
		for (const s of steps) expect(Math.abs(s - mean) / mean).toBeLessThan(0.002);
	});

	it('Auto Bezier (proportional) handles are measured in pixels', () => {
		const auto = (): Spatial => ({
			mode: 'auto-bezier',
			inTangent: [0, 0],
			outTangent: [0, 0],
			auto: 'proportional',
		});
		const kfs = [key(0, [0.1, 0.5], auto()), key(30, [0.5, 0.2], auto()), key(60, [0.6, 0.9], auto())];
		const t = effectiveTangents(kfs, 1, M);
		// Reference computed by hand in px: direction next − prev, each handle ⅓ of its own chord in px.
		const P = px([0.1, 0.5]);
		const K = px([0.5, 0.2]);
		const N = px([0.6, 0.9]);
		const d: Vec2 = [N[0] - P[0], N[1] - P[1]];
		const l = Math.hypot(d[0], d[1]);
		const lin = dist(K, P) / 3;
		const lout = dist(N, K) / 3;
		const want = {
			inTangent: [((-d[0] / l) * lin) / W, ((-d[1] / l) * lin) / H],
			outTangent: [((d[0] / l) * lout) / W, ((d[1] / l) * lout) / H],
		};
		for (const s of ['inTangent', 'outTangent'] as const)
			for (const i of [0, 1]) expect(t[s][i]).toBeCloseTo(want[s][i]!, 12);
		// The same keys without a metric get handles of other lengths (the ratio of the chords differs).
		const plain = effectiveTangents(kfs, 1);
		expect(Math.abs(plain.outTangent[0] - t.outTangent[0])).toBeGreaterThan(1e-3);
	});

	it('property: no metric, an isotropic metric and straight segments evaluate bit-identically to before', () => {
		const vec = fc.tuple(
			fc.double({ min: -2, max: 2, noNaN: true }),
			fc.double({ min: -2, max: 2, noNaN: true }),
		);
		fc.assert(
			fc.property(
				fc.array(vec, { minLength: 2, maxLength: 5 }),
				fc.double({ min: 0.1, max: 4000, noNaN: true }),
				fc.constantFrom('linear', 'bezier', 'hold'),
				(values, s, interp) => {
					const kfs = values.map((v, i) =>
						key(i * 10, v as Vec2, undefined, {
							interpolation: interp as Keyframe<Vec2>['interpolation'],
							easeIn: { influence: 0.4, slope: 0.3 },
							easeOut: { influence: 0.5, slope: 1.7 },
						}),
					);
					const a = anim(kfs);
					for (let f = -2; f <= values.length * 10; f += 3) {
						const ref = evaluate(a, f * F);
						expect(evaluate(a, f * F, { metric: [s, s] })).toEqual(ref);
						// Straight segments (no spatial data): the metric only changes progress that depends on distances
						// (temporal auto-bezier, roving); these keys have none, so the values are the same lerp.
						expect(evaluate(a, f * F, { metric: [s, 2 * s] })).toEqual(ref);
					}
				},
			),
			{ numRuns: 80 },
		);
	});
});

type VClip = {
	id: string;
	effects: EffectInstance[];
	start: number;
	duration: number;
	sourceIn: number;
	speed: { rate: number; reverse?: boolean };
};

function withTransform(duration = 90) {
	const h = new Harness();
	h.ok([{ type: 'clip.addSolid', at: 0, duration, track: 'V1', color: [1, 0, 0, 1] }]);
	const id = h.clips('V1')[0]!.id;
	h.ok([{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.transform' }]);
	const clip = () => h.seq.clips[id] as unknown as VClip;
	const fx = () => clip().effects[0]!;
	const target = (name = 'position') => ['effect', fx().id, name];
	const keys = (name = 'position') => fx().params[name]!.keyframes as Keyframe<Vec2>[];
	return { h, id, clip, fx, target, keys };
}

describe('commands on effect points', () => {
	it('new keys are Auto Bezier spatial; three keys make a curve the resolver evaluates in layer pixels', () => {
		const { h, clip, target, keys } = withTransform();
		h.ok([
			{ type: 'param.setAnimated', target: target(), animated: true, at: { sequenceFrame: 0 } },
			{ type: 'param.set', target: target(), value: [0.2, 0.5], at: { sequenceFrame: 0 } },
			{ type: 'param.set', target: target(), value: [0.5, 0.2], at: { sequenceFrame: 30 } },
			{ type: 'keyframe.add', target: target(), value: [0.8, 0.5], at: { sequenceFrame: 60 } },
		]);
		expect(keys().map((k) => k.spatial?.mode)).toEqual(['auto-bezier', 'auto-bezier', 'auto-bezier']);
		// The middle handle is horizontal, one third of the 576×324 px chord.
		const handle = Math.hypot(576, 324) / (3 * W);
		expect(keys()[1]!.spatial!.outTangent[0]).toBeCloseTo(handle, 12);
		expect(keys()[1]!.spatial!.outTangent[1]).toBe(0);
		const left = reference([
			[0.2, 0.5],
			[0.2, 0.5],
			[0.5 - handle, 0.2],
			[0.5, 0.2],
		]);
		const right = reference([
			[0.5, 0.2],
			[0.5 + handle, 0.2],
			[0.8, 0.5],
			[0.8, 0.5],
		]);
		const c = clip();
		for (const f of [5, 15, 45]) {
			const props = resolveLayerProps(
				{
					transform: null,
					opacity: { value: 100, keyframes: [] },
					intrinsicBox: { width: W, height: H },
					effects: c.effects,
				},
				f * F,
			);
			const want = f <= 30 ? left(f / 30) : right((f - 30) / 30);
			expect(dist(px(props.effects[0]!.params.position as Vec2), px(want))).toBeLessThan(0.25);
		}
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('keyframe commands store pixel-scaled spatial tangents without mutating the previous document', () => {
		const { h, target, keys } = withTransform();
		h.ok([
			{ type: 'keyframe.add', target: target(), value: [0.2, 0.5], at: { sequenceFrame: 0 } },
			{
				type: 'keyframe.add',
				target: target(),
				value: [0.8, 0.5],
				at: { sequenceFrame: 60 },
				spatial: { mode: 'bezier', inTangent: [0, -0.3], outTangent: [0, 0] },
			},
		]);
		expect(keys()[1]!.spatial).toEqual({ mode: 'bezier', inTangent: [0, -0.3], outTangent: [0, 0] });
		const before = h.doc;
		const snapshot = structuredClone(before);
		const k0 = keys()[0]!.id;
		h.ok([{ type: 'keyframe.setTangents', keyframeId: k0, outTangent: [0.1, 0] }]);
		// Continuous: the other side opposite, its length kept in PIXELS (it had none: mirrored).
		expect(keys()[0]!.spatial).toMatchObject({
			mode: 'continuous-bezier',
			outTangent: [0.1, 0],
			inTangent: [-0.1, 0],
		});
		h.ok([{ type: 'keyframe.setTangents', keyframeId: k0, inTangent: [0, 0.1] }]);
		// The out side turns opposite the new in side and keeps its 192 px length: 192 px / 1080 px = 0.1778 in y.
		const s0 = keys()[0]!.spatial!;
		expect(s0.mode).toBe('continuous-bezier');
		expect(s0.outTangent[0]).toBeCloseTo(0, 12);
		expect(s0.outTangent[1]).toBeCloseTo(-192 / 1080, 12);
		h.ok([{ type: 'keyframe.update', keyframeId: k0, spatial: { mode: 'linear' } }]);
		expect(keys()[0]!.spatial).toEqual({ mode: 'linear', inTangent: [0, 0], outTangent: [0, 0] });
		h.ok([
			{ type: 'keyframe.setSpatialInterpolation', keyframeIds: keys().map((k) => k.id), mode: 'auto-bezier' },
		]);
		expect(keys().every((k) => k.spatial?.mode === 'auto-bezier')).toBe(true);
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(before).toEqual(snapshot);
	});

	it('refuses spatial data on params that are not points (numbers, colour wheels, transitions)', () => {
		const { h, id, target, keys } = withTransform();
		h.ok([{ type: 'keyframe.add', target: target('rotation'), value: 10, at: { sequenceFrame: 0 } }]);
		const rot = keys('rotation')[0]!.id;
		const before = h.doc;
		for (const cmd of [
			{
				type: 'keyframe.add',
				target: target('rotation'),
				at: { sequenceFrame: 5 },
				spatial: { mode: 'bezier' },
			},
			{ type: 'keyframe.update', keyframeId: rot, spatial: { mode: 'bezier' } },
			{ type: 'keyframe.setSpatialInterpolation', keyframeIds: [rot], mode: 'bezier' },
			{ type: 'keyframe.setTangents', keyframeId: rot, outTangent: [1, 0] },
		]) {
			expect(h.tx([cmd])).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] });
			expect(h.doc).toBe(before);
		}
		const lumetri = defaultEffectRegistry
			.list()
			.find((s) => s.params.some((p) => p.ui?.control === 'wheel'))!;
		const wheel = lumetri.params.find((p) => p.ui?.control === 'wheel')!;
		h.ok([{ type: 'effect.add', target: { clipId: id }, effectId: lumetri.id, ref: '$l' }]);
		const lfx = (h.seq.clips[id] as unknown as VClip).effects.find((e) => e.effectId === lumetri.id)!;
		expect(
			h.tx([
				{
					type: 'keyframe.add',
					target: ['effect', lfx.id, wheel.name],
					value: [0.1, 0.1],
					at: { sequenceFrame: 0 },
					spatial: { mode: 'bezier' },
				},
			]),
		).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] });
		// Plain keys on a wheel never get spatial data.
		h.ok([
			{
				type: 'keyframe.add',
				target: ['effect', lfx.id, wheel.name],
				value: [0.1, 0.1],
				at: { sequenceFrame: 0 },
			},
		]);
		const wk = (h.seq.clips[id] as unknown as VClip).effects.find((e) => e.id === lfx.id)!.params[
			wheel.name
		]!;
		expect(wk.keyframes[0]!.spatial).toBeUndefined();
	});

	it('paste, effect presets and simplify keep effect point paths and measure them in pixels', () => {
		const { h, id, clip, fx, target, keys } = withTransform();
		h.ok([
			{ type: 'keyframe.add', target: target(), value: [0.2, 0.5], at: { sequenceFrame: 0 } },
			{ type: 'keyframe.add', target: target(), value: [0.5, 0.2], at: { sequenceFrame: 30 } },
			{ type: 'keyframe.add', target: target(), value: [0.8, 0.5], at: { sequenceFrame: 60 } },
		]);
		h.ok([
			{
				type: 'keyframe.setTangents',
				keyframeId: keys()[1]!.id,
				outTangent: [0.1, 0.05],
				breakContinuity: true,
			},
		]);
		// Keyframe paste onto another Transform's Position keeps the spatial data.
		h.ok([{ type: 'clip.addSolid', at: 100, duration: 90, track: 'V1', color: [0, 1, 0, 1] }]);
		const other = h.clips('V1')[1]!.id;
		h.ok([{ type: 'effect.add', target: { clipId: other }, effectId: 'jasper.transform' }]);
		const ofx = (h.seq.clips[other] as unknown as VClip).effects[0]!;
		const payload = buildKeyframesPayload(
			h.doc,
			id,
			keys().map((k) => k.id),
		);
		h.ok([
			{
				type: 'keyframe.paste',
				clipId: other,
				payload,
				at: { sequenceFrame: 100 },
				target: ['effect', ofx.id, 'position'],
			},
		]);
		const pasted = (h.seq.clips[other] as unknown as VClip).effects[0]!.params.position!.keyframes;
		expect(pasted.map((k) => k.spatial?.mode)).toEqual(['auto-bezier', 'bezier', 'auto-bezier']);
		expect(pasted[1]!.spatial!.outTangent).toEqual([0.1, 0.05]);
		// Effect presets carry the path.
		const preset = buildEffectPreset(h.doc, id, {
			name: 'P',
			type: 'anchor-in',
			sections: { effectIds: [fx().id] },
		});
		expect((preset.effects![0]!.params.position!.keyframes![1] as { spatial?: Spatial }).spatial?.mode).toBe(
			'bezier',
		);
		h.ok([{ type: 'effect.applyPreset', preset, clipIds: [other] }]);
		const applied = (h.seq.clips[other] as unknown as VClip).effects.at(-1)!.params.position!.keyframes;
		expect(applied[1]!.spatial).toMatchObject({ mode: 'bezier', outTangent: [0.1, 0.05] });
		// Simplify measures an effect point's deviation in layer pixels.
		const c = clip();
		const plan = planSimplify(
			h.doc,
			[
				{
					path: ['effect', fx().id, 'position'],
					anim: fx().params.position as never,
					seq: h.seq,
					clip: c as never,
				},
			],
			0.1,
		);
		expect(plan.report.groups[0]!.unit).toBe('px');
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('Corner Pin corners (native warp stage input)', () => {
	it('the pinned quad follows the corner paths evaluated in layer-box pixels', () => {
		const h = new Harness();
		h.ok([{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [1, 0, 0, 1] }]);
		const id = h.clips('V1')[0]!.id;
		h.ok([{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.corner-pin', ref: '$p' }]);
		const fxId = (h.seq.clips[id] as unknown as VClip).effects[0]!.id;
		const tl = ['effect', fxId, 'topLeft'];
		h.ok([
			{
				type: 'keyframe.add',
				target: tl,
				value: [0, 0],
				at: { sequenceFrame: 0 },
				spatial: { mode: 'bezier', inTangent: [0, 0], outTangent: [0.2, 0] },
			},
			{
				type: 'keyframe.add',
				target: tl,
				value: [0.1, 0.3],
				at: { sequenceFrame: 60 },
				spatial: { mode: 'bezier', inTangent: [0, -0.2], outTangent: [0, 0] },
			},
		]);
		const c = h.seq.clips[id] as unknown as VClip & { transform: never; opacity: never };
		const t = 25 * F;
		const props = resolveLayerProps(
			{
				transform: null,
				opacity: { value: 100, keyframes: [] },
				intrinsicBox: { width: W, height: H },
				effects: c.effects,
			},
			t,
		);
		const want = reference([
			[0, 0],
			[0.2, 0],
			[0.1, 0.1],
			[0.1, 0.3],
		])(25 / 60);
		expect(dist(props.quad[0], px(want))).toBeLessThan(0.25);
	});
});
