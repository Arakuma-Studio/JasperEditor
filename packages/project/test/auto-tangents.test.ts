// EffectCraft `auto_spatial`: tangents follow next − prev, each handle is ⅓ of its neighbouring chord.
// Keys without an `auto` marker retain the Catmull–Rom rule for saved-project compatibility.
import { describe, expect, it } from 'vitest';
import { autoTangents, evaluate, type Keyframe, type Spatial, type Vec2 } from '../src/index.ts';

const F = 23_520_000;
const LIN = { influence: 1 / 3, slope: 1 };
const key = (frame: number, value: Vec2, auto?: Spatial['auto']): Keyframe<Vec2> => ({
	id: `kf_${frame}`,
	time: frame * F,
	value,
	interpolation: 'linear',
	easeIn: LIN,
	easeOut: LIN,
	spatial: { mode: 'auto-bezier', inTangent: [0, 0], outTangent: [0, 0], ...(auto ? { auto } : {}) },
});

describe('Auto Bezier spatial tangents', () => {
	it('proportional: unequal neighbours give unequal handles along next − prev', () => {
		const kfs = [
			key(0, [0, 0], 'proportional'),
			key(30, [90, 0], 'proportional'),
			key(60, [90, 300], 'proportional'),
		];
		const t = autoTangents(kfs, 1);
		const n = [90 / Math.hypot(90, 300), 300 / Math.hypot(90, 300)];
		expect(t.outTangent[0]).toBeCloseTo(n[0]! * 100, 12);
		expect(t.outTangent[1]).toBeCloseTo(n[1]! * 100, 12);
		expect(t.inTangent[0]).toBeCloseTo(-n[0]! * 30, 12);
		expect(t.inTangent[1]).toBeCloseTo(-n[1]! * 30, 12);
		expect(autoTangents(kfs, 0)).toEqual({ inTangent: [0, 0], outTangent: [0, 0] });
		expect(autoTangents(kfs, 2)).toEqual({ inTangent: [0, 0], outTangent: [0, 0] });
	});

	it('equal, collinear neighbours: both rules agree', () => {
		const a = [key(0, [0, 0]), key(30, [100, 0]), key(60, [200, 0])];
		const b = a.map((k) => ({ ...k, spatial: { ...k.spatial!, auto: 'proportional' as const } }));
		expect(autoTangents(b, 1).outTangent[0]).toBeCloseTo(autoTangents(a, 1).outTangent[0], 12);
	});

	it('legacy keys (no marker) keep (next − prev) / 6 exactly', () => {
		const kfs = [key(0, [0, 0]), key(30, [90, 0]), key(60, [90, 300])];
		expect(autoTangents(kfs, 1)).toEqual({ inTangent: [-15, -50], outTangent: [15, 50] });
		const v = evaluate({ value: [0, 0], keyframes: kfs }, 15 * F);
		expect(v).toEqual(evaluate({ value: [0, 0], keyframes: structuredClone(kfs) }, 15 * F));
	});
});
