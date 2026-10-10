// Roving keyframes (keyframes-blend; After Effects' Rove Across Time): a run of roving keys between two fixed keys is
// one segment — constant speed with linear ends (EffectCraft `roving_keys_get_constant_speed_times`), the fixed keys'
// eases shaping the whole run otherwise (better than EffectCraft, which spaces the keys for constant speed only) —
// and the stored times follow the motion. Commands: keyframe.setRoving, moves turn roving off, invariants / repair.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	type Clip,
	checkInvariants,
	contentTimeAt,
	createCounterIdSource,
	evaluate,
	type Keyframe,
	type Rational,
	repairDocument,
	retimeRoving,
	rovingRuns,
	type Vec2,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const SEC = 705_600_000;
const LIN = { influence: 1 / 3, slope: 1 };
const EASY = { influence: 1 / 3, slope: 0 };

function k<T>(id: string, sec: number, value: T, extra: Partial<Keyframe<T>> = {}): Keyframe<T> {
	return {
		id,
		time: Math.round(sec * SEC),
		value,
		interpolation: 'linear',
		easeIn: LIN,
		easeOut: LIN,
		...extra,
	};
}
const speedAt = (a: Animatable<Vec2>, sec: number) => {
	const h = SEC / 1000;
	const p = evaluate(a, sec * SEC - h);
	const q = evaluate(a, sec * SEC + h);
	return Math.hypot(q[0] - p[0], q[1] - p[1]) / (2 / 1000);
};

describe('roving evaluation', () => {
	it('linear ends: constant speed through the run and times proportional to the distance (EffectCraft case)', () => {
		const kfs = [
			k<Vec2>('kf_a', 0, [0, 0]),
			k<Vec2>('kf_b', 0.2, [300, 0], { roving: true }),
			k<Vec2>('kf_c', 2, [400, 0]),
		];
		expect(retimeRoving(kfs)).toBe(true);
		// 300 of 400 px → 75 % of the 2 s span.
		expect(kfs[1]!.time / SEC).toBeCloseTo(1.5, 6);
		const a: Animatable<Vec2> = { value: [0, 0], keyframes: kfs };
		for (const t of [0.1, 0.5, 1.2, 1.6, 1.9]) expect(speedAt(a, t)).toBeCloseTo(200, 3);
		expect(evaluate(a, kfs[1]!.time)[0]).toBeCloseTo(300, 6);
	});

	it('ignores the stored time of a roving key: the value depends on the run only', () => {
		const kfs = [
			k<number>('kf_a', 0, 0),
			k<number>('kf_b', 0.1, 30, { roving: true }),
			k<number>('kf_c', 1, 100),
		];
		const a: Animatable<number> = { value: 0, keyframes: kfs };
		for (const t of [0.05, 0.3, 0.5, 0.9]) expect(evaluate(a, t * SEC)).toBeCloseTo(100 * t, 9);
	});

	it('eased fixed keys shape the whole run (one ease across the roving keys, smooth speed)', () => {
		const kfs = [
			k<number>('kf_a', 0, 0, { interpolation: 'bezier', easeOut: EASY }),
			k<number>('kf_b', 0.3, 40, { roving: true }),
			k<number>('kf_c', 0.6, 60, { roving: true }),
			k<number>('kf_d', 2, 100, { interpolation: 'bezier', easeIn: EASY }),
		];
		retimeRoving(kfs);
		const a: Animatable<number> = { value: 0, keyframes: kfs };
		const single: Animatable<number> = { value: 0, keyframes: [kfs[0]!, kfs[3]!] };
		for (let t = 0; t <= 2; t += 0.05) expect(evaluate(a, t * SEC)).toBeCloseTo(evaluate(single, t * SEC), 6);
		// The roving keys sit where the eased motion passes their values.
		expect(evaluate(a, kfs[1]!.time)).toBeCloseTo(40, 4);
		expect(evaluate(a, kfs[2]!.time)).toBeCloseTo(60, 4);
		// The run is symmetric: 50 at the middle of the span.
		expect(evaluate(a, SEC)).toBeCloseTo(50, 6);
	});

	it('first / last / hold keys never rove; runs are split by fixed keys', () => {
		const kfs = [
			k<number>('kf_a', 0, 0, { roving: true }),
			k<number>('kf_b', 1, 10, { roving: true }),
			k<number>('kf_c', 2, 20),
			k<number>('kf_d', 3, 30, { roving: true, interpolation: 'hold' }),
			k<number>('kf_e', 4, 40, { roving: true }),
		];
		expect(rovingRuns(kfs).map((r) => [r.a, r.b])).toEqual([[0, 2]]);
		retimeRoving(kfs);
		expect(kfs.map((x) => !!x.roving)).toEqual([false, true, false, false, false]);
	});

	it('property: key values are passed at the stored times, runs are continuous', () => {
		fc.assert(
			fc.property(
				fc.array(fc.double({ min: -500, max: 500, noNaN: true }), { minLength: 3, maxLength: 7 }),
				fc.array(fc.boolean(), { minLength: 7, maxLength: 7 }),
				fc.constantFrom(LIN, EASY, { influence: 0.8, slope: 0.4 }),
				(values, roving, ease) => {
					const kfs = values.map((v, i) =>
						k<number>(`kf_${i}`, i, v, {
							interpolation: 'bezier',
							easeIn: ease,
							easeOut: ease,
							roving: roving[i]!,
						}),
					);
					retimeRoving(kfs);
					for (let i = 1; i < kfs.length; i++) expect(kfs[i]!.time).toBeGreaterThan(kfs[i - 1]!.time);
					const a: Animatable<number> = { value: 0, keyframes: kfs };
					for (const key of kfs) {
						const tol = 1e-6 * (1 + Math.abs(key.value)) + 5e-3; // whole-flick rounding of the times
						expect(Math.abs(evaluate(a, key.time) - key.value)).toBeLessThan(tol);
					}
					// No jumps: neighbouring samples stay close.
					let prev = evaluate(a, 0);
					for (let t = 0; t <= (kfs.length - 1) * SEC; t += SEC / 50) {
						const v = evaluate(a, t);
						expect(Math.abs(v - prev)).toBeLessThan((1000 / 50) * 6);
						prev = v;
					}
				},
			),
			{ numRuns: 200, seed: 42 },
		);
	});
});

describe('roving commands', () => {
	type VClip = Extract<Clip, { kind: 'solid' }>;
	const pos = (id: string) => ['clip', id, 'transform', 'position'];
	function setup() {
		const h = new Harness();
		h.ok([{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [1, 0, 0, 1] }]);
		const id = h.clips('V1')[0]!.id;
		h.ok([
			{ type: 'param.setAnimated', target: pos(id), animated: true, at: { sequenceFrame: 0 } },
			{ type: 'param.set', target: pos(id), value: [0, 0], at: { sequenceFrame: 0 } },
			{ type: 'param.set', target: pos(id), value: [300, 0], at: { sequenceFrame: 6 } },
			{ type: 'param.set', target: pos(id), value: [400, 0], at: { sequenceFrame: 60 } },
		]);
		const clip = () => h.seq.clips[id] as VClip;
		return { h, id, clip, keys: () => clip().transform.position.keyframes };
	}

	it('keyframe.setRoving re-times the key; first / last are refused with a warning', () => {
		const { h, keys, clip } = setup();
		const [a, b, c] = keys();
		const r = h.ok([{ type: 'keyframe.setRoving', keyframeIds: [a!.id, b!.id, c!.id], roving: true }]);
		expect(r.warnings.length).toBe(2);
		expect(keys().map((x) => !!x.roving)).toEqual([false, true, false]);
		// 300 of 400 px of a 2 s span (60 frames at 30 fps) → frame 45.
		const F = SEC / 30;
		expect(keys()[1]!.time / F).toBeCloseTo(45, 3);
		expect(checkInvariants(h.doc)).toEqual([]);
		// Editing a fixed key re-times the roving one.
		h.ok([{ type: 'keyframe.update', keyframeId: c!.id, value: [600, 0] }]);
		expect(keys()[1]!.time / F).toBeCloseTo(30, 3);
		const cl = clip();
		const v = evaluate(cl.transform.position, contentTimeAt(cl, 15, h.seq.settings.frameRate as Rational));
		expect(v[0]).toBeCloseTo(150, 3);
	});

	it('dragging a roving key in time turns roving off and keeps the speed through it', () => {
		const { h, keys } = setup();
		const [, b] = keys();
		h.ok([{ type: 'keyframe.setRoving', keyframeIds: [b!.id], roving: true }]);
		h.ok([{ type: 'keyframe.move', keyframeIds: [b!.id], delta: { frames: 3 } }]);
		const kb = keys()[1]!;
		expect(kb.roving).toBeUndefined();
		expect(kb.interpolation).toBe('continuous-bezier');
		h.ok([{ type: 'keyframe.setRoving', keyframeIds: [b!.id], roving: true }]);
		h.ok([{ type: 'keyframe.setRoving', keyframeIds: [b!.id], roving: false }]);
		// Off again: still continuous with eases carrying the constant run speed (no jump, same speed both sides).
		const a = { value: [0, 0] as Vec2, keyframes: keys() };
		const t = keys()[1]!.time;
		const d = SEC / 1000;
		const before = evaluate(a, t - d);
		const after = evaluate(a, t + d);
		const at = evaluate(a, t);
		expect(at[0] - before[0]).toBeCloseTo(after[0] - at[0], 3);
	});

	it('repairDocument drops roving flags on keys that cannot rove', () => {
		const { h, keys } = setup();
		const doc = structuredClone(h.doc);
		const seq = Object.values(doc.sequences)[0]!;
		const c = Object.values(seq.clips)[0] as VClip;
		c.transform.position.keyframes[0]!.roving = true;
		expect(checkInvariants(doc).some((i) => i.message.includes('rove'))).toBe(true);
		const { document, report } = repairDocument(doc, createCounterIdSource(99));
		expect(report.some((r) => r.action === 'drop-roving')).toBe(true);
		expect(checkInvariants(document)).toEqual([]);
		expect(keys().length).toBe(3);
	});
});
