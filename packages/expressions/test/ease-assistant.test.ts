// Keyframe assistant × expressions: keyframe.createPathController (slider-driven motion along the path) and the
// Overshoot / Bounce presets (docs/wp-notes/easing.md).
import {
	type Animatable,
	type ExpressionRef,
	evaluate,
	evaluateKeyframes,
	type SolidClip,
	type Vec2,
} from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	EXPRESSION_PRESETS,
	evaluateExpressionText,
	loadExpressionEngine,
	propertyStatusAt,
	storedTimeAtFrame,
} from '../src/index.ts';
import { Doc } from './fixture.ts';

beforeAll(async () => {
	await loadExpressionEngine();
});

function rig() {
	const d = new Doc();
	d.tx([{ type: 'clip.addSolid', at: 30, duration: 200, track: 'V1', color: [1, 0, 0, 1], ref: '$a' }]);
	const target = ['clip', '$a', 'transform', 'position'];
	const frames: [number, Vec2][] = [
		[40, [200, 800]],
		[70, [700, 250]],
		[110, [1300, 650]],
		[150, [1600, 300]],
	];
	d.tx([
		{ type: 'param.setAnimated', target, animated: true, at: { sequenceFrame: 40 } },
		...frames.map(([f, value]) => ({ type: 'param.set', target, value, at: { sequenceFrame: f } })),
	]);
	const clip = () => d.doc.sequences[d.seqId]!.clips[d.refs.$a!] as SolidClip;
	const pos = () => clip().transform.position as Animatable<Vec2>;
	// Ease the original motion so the controller has timing to replace.
	const ids = pos().keyframes.map((k) => k.id);
	d.tx([
		{
			type: 'keyframe.setInterpolation',
			keyframeIds: ids,
			interpolation: 'bezier',
			easeIn: { influence: 0.5, slope: 0 },
			easeOut: { influence: 0.5, slope: 0 },
		},
	]);
	return { d, clip, pos, ids };
}

const dist = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]);
/** Distance from p to the polyline (segments, not just vertices). */
function toPolyline(p: Vec2, poly: readonly Vec2[]): number {
	let best = Number.POSITIVE_INFINITY;
	for (let k = 0; k + 1 < poly.length; k++) {
		const a = poly[k]!;
		const b = poly[k + 1]!;
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		const L2 = dx * dx + dy * dy;
		const t = L2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
		best = Math.min(best, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t));
	}
	return best;
}

describe('keyframe.createPathController', () => {
	it('drives the original motion path from the slider; outside the span nothing changes', () => {
		const { d, clip, pos, ids } = rig();
		const before = structuredClone(pos());
		const tA = before.keyframes[0]!.time;
		const tB = before.keyframes[2]!.time;
		const tEnd = before.keyframes[3]!.time;
		const polyline = Array.from({ length: 1501 }, (_, k) => evaluate(before, tA + ((tB - tA) * k) / 1500));
		const r = d.tx([{ type: 'keyframe.createPathController', keyframeIds: [ids[0]!, ids[2]!] }]);
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		const res = r.results[0] as { effectInstanceId: string; effectName: string; rovingKeyframeIds: string[] };
		expect(res.effectName).toBe('Path Progress');
		expect(res.rovingKeyframeIds).toEqual([ids[1]]);
		const fx = clip().effects!.find((e) => e.id === res.effectInstanceId)!;
		const slider = fx.params.slider as Animatable<number>;
		expect(slider.keyframes.map((k) => [k.time, k.value])).toEqual([
			[tA, 0],
			[tB, 100],
		]);
		const ref: ExpressionRef = { seq: d.seqId, owner: d.refs.$a!, path: 'transform.position' };
		const keyed = pos();
		let worstOnPath = 0;
		for (let k = 0; k <= 60; k++) {
			const t = tA + ((tB - tA) * k) / 60;
			const st = propertyStatusAt(d.doc, ref, t)!;
			expect(st.expressionError ?? null).toBeNull();
			const p = st.value as Vec2;
			// Exactly the constant-speed keyframed path at the time the slider maps to …
			const s = evaluateKeyframes(slider, t);
			const q = evaluateKeyframes(keyed, tA + (s / 100) * (tB - tA));
			expect(dist(p, q)).toBeLessThan(1e-6);
			// … which lies on the original drawn path.
			worstOnPath = Math.max(worstOnPath, toPolyline(p, polyline));
		}
		expect(worstOnPath).toBeLessThan(0.05);
		// Ends and the segment after the span are the original values.
		const at = (t: number) => propertyStatusAt(d.doc, ref, t)!.value as Vec2;
		expect(dist(at(tA), before.keyframes[0]!.value)).toBeLessThan(1e-9);
		expect(dist(at(tB), [1300, 650])).toBeLessThan(1e-6);
		for (let k = 1; k < 10; k++) {
			const t = tB + ((tEnd - tB) * k) / 10;
			expect(dist(at(t), evaluate(before, t))).toBeLessThan(1e-6);
		}
		// The keyed path moves at constant speed between the span's ends: half the time = half the length.
		let L = 0;
		for (let i = 1; i < polyline.length; i++) L += dist(polyline[i]!, polyline[i - 1]!);
		let acc = 0;
		let half: Vec2 = polyline[0]!;
		for (let i = 1; i < polyline.length && acc < L / 2; i++) {
			acc += dist(polyline[i]!, polyline[i - 1]!);
			half = polyline[i]!;
		}
		expect(dist(evaluateKeyframes(keyed, (tA + tB) / 2), half)).toBeLessThan(2);
	}, 120_000);
});

describe('Overshoot and Bounce presets', () => {
	function keyedRotation(d: Doc, end = 100) {
		d.tx([{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V1', color: [1, 0, 0, 1], ref: '$r' }]);
		const target = ['clip', '$r', 'transform', 'rotation'];
		d.tx([
			{ type: 'param.setAnimated', target, animated: true, at: { sequenceFrame: 0 } },
			{ type: 'param.set', target, value: 0, at: { sequenceFrame: 0 } },
			{ type: 'param.set', target, value: end, at: { sequenceFrame: 30 } },
		]);
		return { seq: d.seqId, owner: d.refs.$r!, path: 'transform.rotation' } satisfies ExpressionRef;
	}
	const run = (d: Doc, ref: ExpressionRef, id: string, frame: number) => {
		const text = EXPRESSION_PRESETS.find((p) => p.id === id)!.text;
		const r = evaluateExpressionText(d.doc, ref, text, storedTimeAtFrame(d.doc, ref, frame));
		if (r.error) throw new Error(r.error);
		return r.value as number;
	};

	it('Overshoot passes the final value, then settles on it', () => {
		const d = new Doc();
		const ref = keyedRotation(d);
		expect(run(d, ref, 'overshoot', 15)).toBeCloseTo(50, 9); // before the key: the keyframed value
		const after = [33, 36, 39].map((f) => run(d, ref, 'overshoot', f));
		expect(Math.max(...after)).toBeGreaterThan(102);
		expect(Math.abs(run(d, ref, 'overshoot', 150) - 100)).toBeLessThan(0.01);
	});

	it('Bounce comes back off the final value without passing it, losing height each bounce', () => {
		const d = new Doc();
		const ref = keyedRotation(d, 1000); // arrives at 1000 °/s
		const vals = Array.from({ length: 60 }, (_, k) => run(d, ref, 'bounce-back', 31 + k));
		expect(Math.max(...vals)).toBeLessThanOrEqual(1000 + 1e-9);
		expect(Math.min(...vals)).toBeLessThan(970);
		// Successive bounces (local minima below the final value) get lower.
		const dips: number[] = [];
		for (let i = 1; i + 1 < vals.length; i++)
			if (vals[i]! < vals[i - 1]! && vals[i]! <= vals[i + 1]! && vals[i]! < 999.9) dips.push(1000 - vals[i]!);
		expect(dips.length).toBeGreaterThanOrEqual(2);
		for (let i = 1; i < dips.length; i++) expect(dips[i]!).toBeLessThan(dips[i - 1]!);
		expect(run(d, ref, 'bounce-back', 280)).toBeCloseTo(1000, 9);
	});
});
