// keyframes.cleanupPath (Clean Up Path) and keyframe.createPathController refusals (easing.md). The controller's
// expression-driven motion is verified in packages/expressions/test/ease-path-controller.test.ts.
import { describe, expect, it } from 'vitest';
import { type Animatable, evaluate, type Vec2 } from '../src/index.ts';
import { distanceToPolyline, expectValid, setup } from './ease-helpers.ts';

function drawn(a: Animatable<Vec2>, t0: number, t1: number, n = 1200): Vec2[] {
	return Array.from({ length: n + 1 }, (_, k) => evaluate(a, t0 + ((t1 - t0) * k) / n));
}

describe('keyframes.cleanupPath', () => {
	function arcKeys() {
		const s = setup();
		const keys: [number, Vec2][] = [[0, [200, 900]]];
		for (let i = 0; i < 40; i++) {
			const th = (Math.PI * i) / 39;
			keys.push([5 + i * 3, [960 - 300 * Math.cos(th), 540 - 300 * Math.sin(th)]]);
		}
		keys.push([140, [1700, 900]]);
		const ids = s.key('transform.position', keys);
		return { ...s, ids };
	}

	it('keeps the drawn path within the tolerance with far fewer keys, linear timing, outside untouched', () => {
		const { h, ids, anim } = arcKeys();
		const before = structuredClone(anim<Vec2>('transform.position'));
		const span = ids.slice(1, 41);
		const r = h.ok([{ type: 'keyframes.cleanupPath', keyframeIds: span, tolerance: 0.5 }]);
		const res = r.results[0] as { properties: { before: number; after: number; maxError: number }[] };
		expect(res.properties[0]!.before).toBe(40);
		expect(res.properties[0]!.after).toBeLessThan(10);
		expect(res.properties[0]!.maxError).toBeLessThanOrEqual(0.5);
		const a = anim<Vec2>('transform.position');
		expect(a.keyframes.length).toBe(res.properties[0]!.after + 2);
		const k = a.keyframes;
		// The span's keys leave linearly (the first keeps its arriving side as Bezier with a linear out ease).
		for (let i = 2; i < k.length - 2; i++) expect(k[i]!.interpolation).toBe('linear');
		expect(k[1]!.easeOut).toEqual({ influence: 1 / 3, slope: 1 });
		const t0 = before.keyframes[1]!.time;
		const t1 = before.keyframes[40]!.time;
		const orig = drawn(before, t0, t1);
		const now = drawn(a, t0, t1);
		let worst = 0;
		for (let i = 0; i < now.length; i += 4) worst = Math.max(worst, distanceToPolyline(now[i]!, orig));
		for (let i = 0; i < orig.length; i += 4) worst = Math.max(worst, distanceToPolyline(orig[i]!, now));
		expect(worst).toBeLessThanOrEqual(0.55);
		// Outside the span the motion is identical.
		for (const [s0, s1] of [
			[before.keyframes[0]!.time, t0],
			[t1, before.keyframes[41]!.time],
		] as const)
			for (let i = 0; i <= 30; i++) {
				const t = s0 + ((s1 - s0) * i) / 30;
				const p = evaluate(a, t);
				const q = evaluate(before, t);
				expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(1e-6);
			}
		expectValid(h);
	});

	it('two keys only lose their easing; non-point properties are refused', () => {
		const { h, key, anim } = setup();
		const ids = key('transform.position', [
			[0, [100, 100] as Vec2],
			[30, [500, 300] as Vec2],
		]);
		h.ok([
			{
				type: 'keyframe.applyEase',
				keyframeIds: ids,
				curve: { kind: 'cubic', x1: 0.5, y1: 0, x2: 0.5, y2: 1 },
			},
		]);
		h.ok([{ type: 'keyframes.cleanupPath', keyframeIds: ids }]);
		const a = anim<Vec2>('transform.position');
		const mid = evaluate(a, (a.keyframes[0]!.time + a.keyframes[1]!.time) / 2);
		expect(mid[0]).toBeCloseTo(300, 6);
		expect(mid[1]).toBeCloseTo(200, 6);
		const rot = key('transform.rotation', [
			[0, 0],
			[30, 90],
		]);
		const bad = h.tx([{ type: 'keyframes.cleanupPath', keyframeIds: rot }]);
		expect(!bad.ok && bad.errors[0]!.message).toMatch(/not a point property/);
		expectValid(h);
	});
});

describe('keyframe.createPathController refusals', () => {
	it('needs one point property of a clip and refuses to overwrite an expression', () => {
		const { h, key, path } = setup();
		const rot = key('transform.rotation', [
			[0, 0],
			[30, 90],
		]);
		const notPoint = h.tx([{ type: 'keyframe.createPathController', keyframeIds: rot }]);
		expect(!notPoint.ok && notPoint.errors[0]!.message).toMatch(/not a point property/);
		const pos = key('transform.position', [
			[0, [100, 100] as Vec2],
			[30, [500, 300] as Vec2],
		]);
		const mixed = h.tx([{ type: 'keyframe.createPathController', keyframeIds: [...pos, rot[0]!] }]);
		expect(!mixed.ok && mixed.errors[0]!.code).toBe('E_INVALID_PARAM');
		h.ok([{ type: 'expression.set', target: path('transform.position'), text: 'value' }]);
		const has = h.tx([{ type: 'keyframe.createPathController', keyframeIds: pos }]);
		expect(!has.ok && has.errors[0]!.message).toMatch(/replaceExpression/);
		const ok = h.ok([{ type: 'keyframe.createPathController', keyframeIds: pos, replaceExpression: true }]);
		expect((ok.results[0] as { effectName: string }).effectName).toBe('Path Progress');
		// A second controller gets a distinct name.
		const again = h.ok([
			{ type: 'keyframe.createPathController', keyframeIds: pos, replaceExpression: true },
		]);
		expect((again.results[0] as { effectName: string }).effectName).toBe('Path Progress 2');
		expectValid(h);
	});
});
