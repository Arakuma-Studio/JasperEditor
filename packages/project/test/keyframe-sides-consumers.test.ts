// keyframe-sides: every consumer of keyframe evaluation agrees with the per-side evaluator — Lottie export, 3D
// Orientation, Sound Design dips on volume curves, keyframe simplification, effect presets, effect.add, multicam /
// grade re-timing (docs/wp-notes/keyframe-sides.md).
import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	buildEffectPreset,
	type Clip,
	contentTimeAt,
	evaluate,
	exportSequenceToLottie,
	FLICKS_PER_SECOND,
	type Keyframe,
	orientationMatrixAt,
	parseEffectPreset,
	type Rational,
	retimeKeyframes,
	simplifyKeyframes,
	type Vec3,
} from '../src/index.ts';
import { retimeAnim } from '../src/multicam/resolve.ts';
import { Harness } from './helpers.ts';

type VClip = Extract<Clip, { kind: 'solid' }>;
const EASY = { influence: 1 / 3, slope: 0 };

function easeInSolid() {
	const h = new Harness();
	h.ok([{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V1', color: [1, 0, 0, 1] }]);
	const id = h.clips('V1')[0]!.id;
	const op = ['clip', id, 'opacity'];
	const r = h.ok([
		{ type: 'keyframe.add', target: op, at: { sequenceFrame: 0 }, value: 0, ref: '$a' },
		{ type: 'keyframe.add', target: op, at: { sequenceFrame: 60 }, value: 100, ref: '$b' },
	]);
	h.ok([
		{
			type: 'keyframe.setInterpolation',
			keyframeIds: [r.refs.$b],
			interpolation: 'bezier',
			easeIn: EASY,
			side: 'in',
		},
	]);
	return { h, id };
}

describe('keyframe-sides consumers', () => {
	it('Lottie: a Linear key into an Ease In key exports the After Effects tangents (⅙ linear side)', () => {
		const { h } = easeInSolid();
		const { json } = exportSequenceToLottie(h.doc, h.seqId);
		const layer = (
			json.layers as {
				ks: { o: { a: number; k: { o?: { x: number; y: number }; i?: { x: number; y: number } }[] } };
			}[]
		)[0]!;
		expect(layer.ks.o.a).toBe(1);
		const k0 = layer.ks.o.k[0]!;
		expect(k0.o!.x).toBeCloseTo(1 / 6, 5);
		expect(k0.o!.y).toBeCloseTo(1 / 6, 5);
		expect(k0.i!.x).toBeCloseTo(2 / 3, 5);
		expect(k0.i!.y).toBeCloseTo(1, 5);
	});

	it('3D Orientation follows the per-side progress', () => {
		const kfs: Keyframe<Vec3>[] = [
			{ id: 'a', time: 0, value: [0, 0, 0], interpolation: 'linear', easeIn: EASY, easeOut: EASY },
			{
				id: 'b',
				time: 1000,
				value: [0, 90, 0],
				interpolation: 'linear',
				inInterpolation: 'bezier',
				easeIn: EASY,
				easeOut: EASY,
			},
		];
		const anim: Animatable<Vec3> = { value: [0, 0, 0], keyframes: kfs };
		const m = orientationMatrixAt(anim, 500);
		// Independent cubic (1/6, 1/6), (2/3, 1) gives p=0.6370633395427247 at half time.
		// Rotation about Y has diagonal cos(p · π/2), regardless of matrix storage order.
		expect(m[0]).toBeCloseTo(0.5397158767532739, 6);
	});

	it('simplify keeps a per-side segment arriving at the simplified span', () => {
		const F = FLICKS_PER_SECOND / 30;
		const keys: Keyframe<number>[] = [
			{ id: 'k0', time: 0, value: 0, interpolation: 'linear', easeIn: EASY, easeOut: EASY },
			{
				id: 'k1',
				time: 30 * F,
				value: 60,
				interpolation: 'linear',
				inInterpolation: 'bezier',
				easeIn: EASY,
				easeOut: EASY,
			},
		];
		for (let i = 2; i <= 20; i++)
			keys.push({
				id: `k${i}`,
				time: (30 + (i - 1) * 2) * F,
				value: 60 + (i - 1) * 2,
				interpolation: 'linear',
				easeIn: EASY,
				easeOut: EASY,
			});
		const times = Array.from({ length: 70 }, (_, j) => j * F);
		const orig = { value: 0, keyframes: keys };
		const res = simplifyKeyframes({
			channels: [{ keys, span: [1, keys.length - 1] }],
			times,
			tolerance: 0.01,
			deviation: (s, values) => Math.abs(values[0]![0]! - evaluate(orig, times[s]!)),
		});
		const out = { value: 0, keyframes: res.keys[0]! };
		expect(res.keys[0]!.length).toBeLessThan(keys.length);
		for (let j = 0; j <= 30; j++) expect(evaluate(out, j * F)).toBeCloseTo(evaluate(orig, j * F), 6);
		expect(res.maxError).toBeLessThanOrEqual(0.01);
	});

	it('effect.add keeps a valid incoming side and refuses an inconsistent one', () => {
		const { h, id } = easeInSolid();
		const kfs = [
			{ time: 0, value: 0, interpolation: 'linear' },
			{ time: 1_000_000, value: 30, interpolation: 'linear', inInterpolation: 'bezier', easeIn: EASY },
		];
		const added = h.ok([
			{
				type: 'effect.add',
				target: { clipId: id },
				effectId: 'jasper.gaussian-blur',
				params: { radius: { value: 0, keyframes: kfs } },
			},
		]);
		expect(added.ok).toBe(true);
		const fx2 = (h.seq.clips[id] as VClip).effects!.at(-1)!;
		expect(fx2.params.radius!.keyframes.map((k) => k.inInterpolation)).toEqual([undefined, 'bezier']);
		const bad = h.tx([
			{
				type: 'effect.add',
				target: { clipId: id },
				effectId: 'jasper.gaussian-blur',
				params: {
					radius: {
						value: 0,
						keyframes: [{ time: 0, value: 0, interpolation: 'auto-bezier', inInterpolation: 'linear' }],
					},
				},
			},
		]);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors[0]!.code).toBe('E_INVALID_PARAM');
	});

	it('effect presets carry the incoming side (Save Preset → Apply)', () => {
		const { h, id } = easeInSolid();
		h.ok([{ type: 'clip.addSolid', at: 200, duration: 120, track: 'V2', color: [0, 1, 0, 1] }]);
		const other = h.clips('V2')[0]!.id;
		const preset = buildEffectPreset(h.doc, id, {
			name: 'Ease',
			type: 'anchor-in',
			sections: { opacity: true },
			id: 'fxp_SIDES',
		});
		const parsed = parseEffectPreset(JSON.parse(JSON.stringify(preset)));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		h.ok([{ type: 'effect.applyPreset', preset: parsed.preset, clipIds: [other] }]);
		const b = (h.seq.clips[other] as VClip).opacity;
		expect(b.keyframes.map((k) => k.inInterpolation)).toEqual([undefined, 'bezier']);
		for (let f = 0; f <= 60; f += 7)
			expect(
				evaluate(b, contentTimeAt(h.seq.clips[other]!, 200 + f, h.seq.settings.frameRate as Rational)),
			).toBeCloseTo(
				evaluate(
					(h.seq.clips[id] as VClip).opacity,
					contentTimeAt(h.seq.clips[id]!, f, h.seq.settings.frameRate as Rational),
				),
				9,
			);
	});

	it('re-timing onto a reversed clip mirrors per-side keys exactly (multicam, Paste Grade)', () => {
		const kfs: Keyframe<number>[] = [
			{ id: 'a', time: 0, value: 0, interpolation: 'linear', easeIn: EASY, easeOut: EASY },
			{
				id: 'b',
				time: 3000,
				value: 90,
				interpolation: 'linear',
				inInterpolation: 'bezier',
				easeIn: { influence: 0.6, slope: 0.2 },
				easeOut: EASY,
			},
		];
		const anim = { value: 0, keyframes: kfs };
		const rev = retimeAnim(anim, { a: 3000, b: -1 });
		for (const t of [100, 700, 1500, 2600]) expect(evaluate(rev, 3000 - t)).toBeCloseTo(evaluate(anim, t), 9);
		expect(rev.keyframes.every((k) => k.inInterpolation === undefined)).toBe(true);
		const rate: Rational = { num: 30, den: 1 };
		const F = FLICKS_PER_SECOND / 30;
		const from = { start: 0, duration: 31, sourceIn: 0, speed: { rate: 1, reverse: false } };
		const to = { start: 0, duration: 31, sourceIn: 0, speed: { rate: 1, reverse: true } };
		const src = { value: 0, keyframes: [kfs[0]!, { ...kfs[1]!, time: 30 * F }] };
		const out = { value: 0, keyframes: retimeKeyframes(src.keyframes, from, to, rate) };
		const fromClip = { ...from, kind: 'solid' } as unknown as Clip;
		const toClip = { ...to, kind: 'solid' } as unknown as Clip;
		for (const f of [3, 10, 17, 25])
			expect(evaluate(out, contentTimeAt(toClip, f, rate))).toBeCloseTo(
				evaluate(src, contentTimeAt(fromClip, f, rate)),
				6,
			);
	});
});
