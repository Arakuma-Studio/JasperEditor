// Value / Velocity graph math (S03:KF-022): sampling from the shared evaluator, handle ↔ ease
// conversions, clamping, and the commands a handle edit produces.
import {
	type Animatable,
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	EASE_PRESETS,
	type Ease,
	evaluate,
	type Interpolation,
	type Keyframe,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import {
	easeFromValueDrag,
	easeFromVec2ValueDrag,
	easeFromVelocityDrag,
	effectiveEase,
	fitRange,
	graphKindOf,
	panRange,
	planEaseEdit,
	roundToStep,
	sampleValueCurves,
	sampleVelocityCurve,
	timeMapOf,
	unitVelocity,
	valueHandles,
	vec2ValueHandles,
	velocityHandles,
	zoomRange,
} from '../src/panels/effectControls/graph.ts';
import { exactFrameOf } from '../src/panels/properties/lib/model.ts';

const RATE = { num: 30, den: 1 };
const F = 705_600_000 / 30;
const LIN = EASE_PRESETS.linear;
const clip = { start: 10, duration: 60, sourceIn: 0, speed: { rate: 1, reverse: false } };
const map = timeMapOf(clip, RATE);
const range = { start: 0, end: 80 };

function kf<T>(
	id: string,
	frame: number,
	value: T,
	interpolation: Interpolation = 'linear',
	easeIn: Ease = LIN,
	easeOut: Ease = LIN,
): Keyframe<T> {
	return { id, time: frame * F, value, interpolation, easeIn: { ...easeIn }, easeOut: { ...easeOut } };
}
const anim = <T>(keyframes: Keyframe<T>[]): Animatable<T> => ({ value: keyframes[0]!.value, keyframes });

/** Velocity of the sampled curve just after (out) / before (in) a sequence frame. */
function curveVelocityAt(pts: { x: number; y: number }[], x: number, side: 'in' | 'out'): number {
	const at = pts.filter((p) => Math.abs(p.x - x) < 1e-6);
	return side === 'in' ? at[0]!.y : at[at.length - 1]!.y;
}

describe('graph time mapping', () => {
	it('matches the lanes (exactFrameOf) on normal, sped-up and reversed clips, and inverts', () => {
		const seq = { settings: { frameRate: RATE } } as never;
		for (const c of [
			clip,
			{ ...clip, sourceIn: 5 * F, speed: { rate: 2, reverse: false } },
			{ ...clip, speed: { rate: 1.5, reverse: true } },
		]) {
			const m = timeMapOf(c, RATE);
			for (const t of [0, 7 * F, 33.5 * F]) {
				expect(m.toX(t)).toBeCloseTo(exactFrameOf(c as never, t, seq), 9);
				expect(m.toTime(m.toX(t))).toBeCloseTo(t, 3);
			}
			expect(Math.sign(m.flicksPerX)).toBe(c.speed.reverse ? -1 : 1);
		}
	});
	it('graphs only continuous numbers and vec2', () => {
		expect(graphKindOf({ kind: 'number', animatable: 'continuous' })).toBe('number');
		expect(graphKindOf({ kind: 'vec2', animatable: 'continuous' })).toBe('vec2');
		expect(graphKindOf({ kind: 'number', animatable: 'hold-only' })).toBeNull();
		expect(graphKindOf({ kind: 'color', animatable: 'continuous' })).toBeNull();
	});
});

describe('value curve sampling', () => {
	it('samples the shared evaluator (every point equals evaluate at its time), sorted by x', () => {
		const a = anim([kf('a', 0, 0, 'bezier', LIN, { influence: 0.5, slope: 0 }), kf('b', 30, 100)]);
		const [curve] = sampleValueCurves(a, map, range, 300);
		expect(curve!.length).toBeGreaterThan(50);
		for (let i = 1; i < curve!.length; i++) expect(curve![i]!.x).toBeGreaterThanOrEqual(curve![i - 1]!.x);
		for (const p of curve!) expect(p.y).toBeCloseTo(evaluate(a, map.toTime(p.x)) as number, 9);
		// Flat before the first key / after the last one.
		expect(curve![0]).toEqual({ x: 0, y: 0 });
		expect(curve![curve!.length - 1]).toEqual({ x: 80, y: 100 });
	});
	it('vec2 gives one curve per dimension; holds are vertical steps; clamp options apply', () => {
		const v = anim<[number, number]>([kf('a', 0, [0, 10]), kf('b', 30, [60, -20])]);
		const curves = sampleValueCurves(v, map, range, 300);
		expect(curves).toHaveLength(2);
		expect(curves[1]![0]!.y).toBe(10);
		const h = anim([kf('a', 0, 0, 'hold'), kf('b', 30, 50)]);
		const [step] = sampleValueCurves(h, map, range, 300);
		const keyX = map.toX(30 * F);
		const before = step!.filter((p) => p.x < keyX);
		expect(before[before.length - 1]!.y).toBe(0);
		expect(before[before.length - 1]!.x).toBeCloseTo(keyX, 3);
		const over = anim([kf('a', 0, 0, 'bezier', LIN, { influence: 1, slope: 3 }), kf('b', 30, 100)]);
		const clamped = sampleValueCurves(over, map, range, 300, { clamp: { min: 0, max: 100 } })[0]!;
		expect(Math.max(...clamped.map((p) => p.y))).toBeLessThanOrEqual(100);
		expect(Math.max(...sampleValueCurves(over, map, range, 300)[0]!.map((p) => p.y))).toBeGreaterThan(100);
	});
});

describe('velocity curve', () => {
	it('is the derivative of evaluate in units per second: constant on linear segments, zero outside', () => {
		// 0 → 90 over 30 frames at 30 fps = 90 units / s.
		const a = anim([kf('a', 0, 0), kf('b', 30, 90)]);
		const v = sampleVelocityCurve(a, map, range, 300);
		const inside = v.filter((p) => p.x > map.toX(0) + 0.5 && p.x < map.toX(30 * F) - 0.5);
		for (const p of inside) expect(p.y).toBeCloseTo(90, 6);
		expect(v[0]!.y).toBe(0);
		expect(v[v.length - 1]!.y).toBe(0);
	});
	it('eases to zero speed at an Ease Out key and steps at keys with different in/out speeds', () => {
		const a = anim([
			kf('a', 0, 0, 'bezier', LIN, { influence: 1 / 3, slope: 0 }),
			kf('b', 30, 90),
			kf('c', 45, 0),
		]);
		const v = sampleVelocityCurve(a, map, range, 300);
		expect(Math.abs(curveVelocityAt(v, map.toX(0), 'out'))).toBeLessThan(0.5); // ≈ 0 (one-sided step)
		const xb = map.toX(30 * F);
		expect(curveVelocityAt(v, xb, 'in')).toBeGreaterThan(0);
		expect(curveVelocityAt(v, xb, 'out')).toBeCloseTo(-180, 3); // 90 down over 15 frames
	});
	it('vec2 velocity is the speed along the path; reversed clips flip the sign of numbers', () => {
		const p = anim<[number, number]>([kf('a', 0, [0, 0]), kf('b', 30, [30, 40])]);
		const v = sampleVelocityCurve(p, map, range, 300);
		expect(v.find((q) => q.x > 20 && q.x < 30)!.y).toBeCloseTo(50, 6);
		const rev = timeMapOf({ ...clip, speed: { rate: 1, reverse: true } }, RATE);
		const n = sampleVelocityCurve(anim([kf('a', 0, 0), kf('b', 30, 90)]), rev, range, 300);
		expect(n.find((q) => q.x > 45 && q.x < 60)!.y).toBeCloseTo(-90, 6);
		for (let i = 1; i < n.length; i++) expect(n[i]!.x).toBeGreaterThanOrEqual(n[i - 1]!.x - 1e-9);
	});
	it('holds have zero velocity', () => {
		const v = sampleVelocityCurve(anim([kf('a', 0, 0, 'hold'), kf('b', 30, 90)]), map, range, 300);
		expect(v.every((p) => p.y === 0)).toBe(true);
	});
});

describe('velocity handles ↔ eases', () => {
	const a = anim([
		kf('a', 0, 0),
		kf('b', 30, 90, 'bezier', { influence: 0.25, slope: 0.5 }, { influence: 0.6, slope: 2 }),
		kf('c', 60, 0),
	]);
	it('unit velocity is the linear-equivalent speed of the segment, measured from evaluate', () => {
		expect(unitVelocity(a, 1, 'in', map)).toBeCloseTo(90, 6);
		expect(unitVelocity(a, 1, 'out', map)).toBeCloseTo(-90, 6);
		const p = anim<[number, number]>([kf('a', 0, [0, 0]), kf('b', 30, [30, 40])]);
		expect(unitVelocity(p, 0, 'out', map)).toBeCloseTo(50, 6);
	});
	it('handles sit on the sampled velocity curve at the key and their tips mark the influence', () => {
		const prevBezier = anim([
			kf('a', 0, 0, 'bezier'),
			kf('b', 30, 90, 'bezier', { influence: 0.25, slope: 0.5 }, { influence: 0.6, slope: 2 }),
			kf('c', 60, 0),
		]);
		const hs = velocityHandles(prevBezier, 1, map);
		const curve = sampleVelocityCurve(prevBezier, map, range, 600);
		const xb = map.toX(30 * F);
		const [hin, hout] = hs;
		expect(hin!.side).toBe('in');
		expect(hin!.velocity).toBeCloseTo(curveVelocityAt(curve, xb, 'in'), 0);
		expect(hout!.velocity).toBeCloseTo(curveVelocityAt(curve, xb, 'out'), 0);
		expect(hout!.velocity).toBeCloseTo(-180, 6);
		expect(hout!.tipX).toBeCloseTo(xb + 0.6 * 30, 6);
		expect(hin!.tipX).toBeCloseTo(xb - 0.25 * 30, 6);
	});
	it('a segment leaving a Linear key reads as linear on the arriving side', () => {
		expect(effectiveEase(a.keyframes, 1, 'in')).toEqual(LIN);
		expect(velocityHandles(a, 1, map)[0]!.velocity).toBeCloseTo(90, 6);
		// No handles on the outer sides or across holds.
		expect(velocityHandles(a, 0, map).map((h) => h.side)).toEqual(['out']);
		const h = anim([kf('a', 0, 0, 'hold'), kf('b', 30, 90)]);
		expect(velocityHandles(h, 1, map)).toEqual([]);
	});
	it('drag → ease inverts the handle and clamps influence to 0.01..1; the slope may go negative', () => {
		const [, hout] = velocityHandles(a, 1, map);
		const same = easeFromVelocityDrag(a, hout!, hout!.tipX, hout!.velocity, map);
		expect(same.influence).toBeCloseTo(0.6, 9);
		expect(same.slope).toBeCloseTo(2, 9);
		const faster = easeFromVelocityDrag(a, hout!, map.toX(30 * F) + 15, -270, map);
		expect(faster).toEqual({ influence: expect.closeTo(0.5, 9), slope: expect.closeTo(3, 9) });
		expect(easeFromVelocityDrag(a, hout!, map.toX(30 * F) + 100, 0, map).influence).toBe(1);
		expect(easeFromVelocityDrag(a, hout!, map.toX(30 * F) - 5, 0, map).influence).toBe(0.01);
		// keyframes-blend: through zero = the value first moves away (anticipation), as Premiere's handles allow.
		expect(easeFromVelocityDrag(a, hout!, hout!.tipX, +50, map).slope).toBeCloseTo(50 / hout!.unit, 9);
		const flat = anim([kf('a', 0, 5, 'bezier', LIN, { influence: 0.4, slope: 0.7 }), kf('b', 30, 5)]);
		const [hf] = velocityHandles(flat, 0, map);
		expect(hf!.unit).toBe(0);
		expect(easeFromVelocityDrag(flat, hf!, hf!.tipX, 100, map).slope).toBe(0.7);
	});
});

describe('value-graph Bezier handles', () => {
	const a = anim([
		kf('a', 0, 0, 'bezier', LIN, { influence: 0.5, slope: 0.4 }),
		kf('b', 30, 100, 'bezier', { influence: 0.25, slope: 1 }),
	]);
	it('are the cubic control points in value space and invert on drag', () => {
		const [out] = valueHandles(a, 0, map);
		expect(out!.tipX).toBeCloseTo(map.toX(15 * F), 9);
		expect(out!.tipY).toBeCloseTo(20, 9);
		const [inn] = valueHandles(a, 1, map);
		expect(inn!.tipX).toBeCloseTo(map.toX(22.5 * F), 9);
		expect(inn!.tipY).toBeCloseTo(75, 9);
		expect(easeFromValueDrag(a, out!, out!.tipX, out!.tipY, map)).toEqual({
			influence: expect.closeTo(0.5, 9),
			slope: expect.closeTo(0.4, 9),
		});
		// keyframes-blend: below the key = anticipation (negative slope): −50 at 10 % of a 100-unit segment.
		const e = easeFromValueDrag(a, out!, map.toX(3 * F), -50, map);
		expect(e).toEqual({ influence: expect.closeTo(0.1, 9), slope: expect.closeTo(-5, 9) });
	});
});

describe('handle edits → commands (S01:KF-004)', () => {
	const ease = { influence: 0.5, slope: 2 };
	const up = (cmds: unknown[]) => cmds as Record<string, unknown>[];
	it('Linear and Auto Bezier keys convert to Bezier with the untouched side frozen', () => {
		const kfs = [kf('a', 0, 0, 'bezier'), kf('b', 30, 90), kf('c', 60, 0)];
		expect(up(planEaseEdit(kfs, 1, 'out', ease, false))).toEqual([
			{ type: 'keyframe.update', keyframeId: 'b', interpolation: 'bezier', easeOut: ease, easeIn: LIN },
		]);
		// Arriving segment is linear (previous key Linear): the in ease is not sent (no cascade).
		const lin = [kf('a', 0, 0), kf('b', 30, 90, 'auto-bezier'), kf('c', 60, 0)];
		const [cmd] = up(planEaseEdit(lin, 1, 'out', ease, false));
		expect(cmd).toEqual({ type: 'keyframe.update', keyframeId: 'b', interpolation: 'bezier', easeOut: ease });
	});
	it('Continuous Bezier stays linked (one side sent) unless Alt breaks it into Bezier', () => {
		const kfs = [kf('a', 0, 0, 'bezier'), kf('b', 30, 90, 'continuous-bezier'), kf('c', 60, 200)];
		expect(up(planEaseEdit(kfs, 1, 'in', ease, false))).toEqual([
			{ type: 'keyframe.update', keyframeId: 'b', interpolation: 'continuous-bezier', easeIn: ease },
		]);
		const broken = up(planEaseEdit(kfs, 1, 'in', ease, true));
		expect(broken[0]).toMatchObject({ interpolation: 'bezier', easeIn: ease, easeOut: LIN });
	});
	it('an arriving handle after a Linear key converts that key for non-Bezier targets; holds keep holding', () => {
		const kfs = [kf('a', 0, 0), kf('b', 30, 90, 'continuous-bezier'), kf('c', 60, 200)];
		const cmds = up(planEaseEdit(kfs, 1, 'in', ease, false));
		expect(cmds[0]).toEqual({
			type: 'keyframe.update',
			keyframeId: 'a',
			interpolation: 'bezier',
			easeOut: LIN,
		});
		// Linked: dragging the leaving side also moves the arriving one, so it is converted too.
		expect(up(planEaseEdit(kfs, 1, 'out', ease, false))[0]).toMatchObject({
			keyframeId: 'a',
			interpolation: 'bezier',
		});
		expect(up(planEaseEdit(kfs, 1, 'out', ease, true))).toHaveLength(1); // broken: arriving side untouched
		const hold = [kf('a', 0, 0, 'bezier'), kf('b', 30, 90, 'hold'), kf('c', 60, 200)];
		expect(up(planEaseEdit(hold, 1, 'in', ease, false))).toEqual([
			{ type: 'keyframe.update', keyframeId: 'b', interpolation: 'hold', easeIn: ease },
		]);
	});
	it('applied through the real handlers, the new speed is what the evaluator produces', () => {
		const ids = createCounterIdSource(1);
		let doc = createEmptyProject({ ids, name: 'g', preset: 'hd-1080p-30' });
		const ctx = { ids, now: () => '2026-10-05T00:00:00.000Z', revision: 0, registries: defaultRegistries() };
		const tx = (commands: unknown[]) => {
			const r = applyTransaction(doc, { label: 't', origin: 'user', commands }, ctx);
			expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
			doc = r.document;
			return r.result as unknown as { created: string[] };
		};
		const created = tx([{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [0, 0, 1, 1] }]);
		const clipId = created.created.find((id) => id.startsWith('clp_'))!;
		tx([
			{ type: 'keyframe.add', target: ['clip', clipId, 'opacity'], at: { frames: 0 }, value: 0 },
			{ type: 'keyframe.add', target: ['clip', clipId, 'opacity'], at: { frames: 30 }, value: 90 },
			{ type: 'keyframe.add', target: ['clip', clipId, 'opacity'], at: { frames: 60 }, value: 30 },
		]);
		const seq = () => Object.values(doc.sequences)[0]!;
		const op = () => (seq().clips[clipId] as unknown as { opacity: Animatable<number> }).opacity;
		const cm = timeMapOf(seq().clips[clipId]!, RATE);
		const [, hout] = velocityHandles(op(), 1, cm);
		expect(hout!.velocity).toBeCloseTo(-60, 6);
		// Drag the out handle of the middle (Linear) key to −120 / s at half influence.
		const e = easeFromVelocityDrag(op(), hout!, cm.toX(op().keyframes[1]!.time) + 15, -120, cm);
		tx(planEaseEdit(op().keyframes, 1, 'out', e, false));
		expect(op().keyframes[1]!.interpolation).toBe('bezier');
		const [, after] = velocityHandles(op(), 1, cm);
		expect(after!.velocity).toBeCloseTo(-120, 6);
		expect(after!.ease.influence).toBeCloseTo(0.5, 9);
		const curve = sampleVelocityCurve(op(), cm, { start: 0, end: 90 }, 900);
		expect(curveVelocityAt(curve, 30, 'out')).toBeCloseTo(-120, 0);
		// The arriving side kept its linear speed (90 / s).
		expect(curveVelocityAt(curve, 30, 'in')).toBeCloseTo(90, 0);
	});
});

describe('vertical range', () => {
	it('fits with headroom, can include zero, and widens flat curves', () => {
		expect(fitRange([0, 100])).toEqual({ min: -10, max: 110 });
		expect(fitRange([20, 40], { includeZero: true })).toEqual({ min: -4, max: 44 });
		expect(fitRange([50, 50])).toEqual({ min: 45, max: 55 });
		expect(fitRange([0])).toEqual({ min: -1, max: 1 });
		expect(fitRange([])).toEqual({ min: -1, max: 1 });
		expect(roundToStep(12.34567, 0.1)).toBe(12.346);
		expect(roundToStep(7.25619)).toBe(7.26);
	});
});

// ---------------------------------------------------------------- keyframes-blend

describe('overshoot and anticipation through the handles (keyframes-blend)', () => {
	it('a negative slope makes the value move away first; a steep one passes the next key', () => {
		const back = anim([
			kf('a', 0, 0, 'bezier', LIN, { influence: 0.5, slope: -1 }),
			kf('b', 30, 100, 'bezier'),
		]);
		const early = evaluate(back, 3 * F);
		expect(early).toBeLessThan(0);
		const over = anim([
			kf('a', 0, 0, 'bezier', LIN, { influence: 0.5, slope: 4 }),
			kf('b', 30, 100, 'bezier'),
		]);
		const peak = Math.max(...Array.from({ length: 31 }, (_, f) => evaluate(over, f * F)));
		expect(peak).toBeGreaterThan(100);
	});
});

describe('vec2 value-graph handles (keyframes-blend)', () => {
	const a = anim<[number, number]>([
		kf('a', 0, [0, 100], 'bezier', LIN, { influence: 0.5, slope: 0.4 }),
		kf('b', 30, [200, 50], 'bezier'),
	]);
	it('sit on each component curve, tangent at the key, and invert on drag', () => {
		const hs = vec2ValueHandles(a, 0, map);
		expect(hs.map((h) => [h.side, h.dim])).toEqual([
			['out', 0],
			['out', 1],
		]);
		const [hx, hy] = hs;
		expect(hx!.tipX).toBeCloseTo(map.toX(15 * F), 9);
		// Bezier progress p'(0) = slope: d/dt X = 0.4 · 200 / 30 frames → tip = 0.4 · 200 · 0.5 = 40.
		expect(hx!.tipY).toBeCloseTo(40, 2);
		expect(hy!.tipY).toBeCloseTo(100 - 0.4 * 50 * 0.5, 2);
		const same = easeFromVec2ValueDrag(a, hx!, hx!.tipX, hx!.tipY, map);
		expect(same.influence).toBeCloseTo(0.5, 9);
		expect(same.slope).toBeCloseTo(0.4, 3);
		// Dragging the Y handle down (Y decreases faster) speeds the shared ease up.
		const faster = easeFromVec2ValueDrag(a, hy!, hy!.tipX, 100 - 1 * 50 * 0.5, map);
		expect(faster.slope).toBeCloseTo(1, 3);
	});

	it('a component that does not change only edits the influence', () => {
		const flat = anim<[number, number]>([
			kf('a', 0, [0, 100], 'bezier', LIN, { influence: 0.5, slope: 0.4 }),
			kf('b', 30, [200, 100], 'bezier'),
		]);
		const [, hy] = vec2ValueHandles(flat, 0, map);
		const e = easeFromVec2ValueDrag(flat, hy!, map.toX(9 * F), 300, map);
		expect(e).toEqual({ influence: expect.closeTo(0.3, 9), slope: 0.4 });
	});
});

describe('vertical zoom (keyframes-blend)', () => {
	it('zooms about a value and pans', () => {
		expect(zoomRange({ min: 0, max: 100 }, 50, 0.5)).toEqual({ min: 25, max: 75 });
		expect(zoomRange({ min: 0, max: 100 }, 0, 2)).toEqual({ min: 0, max: 200 });
		expect(panRange({ min: 0, max: 100 }, 10)).toEqual({ min: 10, max: 110 });
	});
});
