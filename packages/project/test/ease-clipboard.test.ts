// copyEase / keyframe.pasteEase, copyValues / keyframe.pasteValues, describeKeyframeEases / keyframe.setVelocity.
import { describe, expect, it } from 'vitest';
import {
	type CubicEase,
	copyEase,
	copyValues,
	cubicToEases,
	describeKeyframeEases,
	evaluate,
	evaluateEaseCurve,
	type Vec2,
} from '../src/index.ts';
import { cssCubic, expectValid, SEC, setup } from './ease-helpers.ts';

const SWIFT: CubicEase = { kind: 'cubic', x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
const SNAP: CubicEase = { kind: 'cubic', x1: 0.1, y1: 0.9, x2: 0.2, y2: 1 };

describe('copyEase / keyframe.pasteEase', () => {
	it('one key copies its two eases; pasting sets both sides of every target key', () => {
		const { h, key, anim } = setup();
		const src = key('transform.rotation', [
			[0, 0],
			[10, 50],
			[20, 0],
		]);
		h.ok([
			{
				type: 'keyframe.update',
				keyframeId: src[1]!,
				interpolation: 'bezier',
				easeIn: { influence: 0.6, slope: 0.2 },
				easeOut: { influence: 0.25, slope: 1.5 },
			},
		]);
		const c = copyEase(h.doc, [src[1]!]);
		// keyframe-sides: the key's two sides, each with its type (the segment into it is per side: key 0's Linear
		// side does not make it linear, so its incoming ease is the one set).
		expect(c.ok && c.clip).toEqual({
			kind: 'key',
			easeIn: { influence: 0.6, slope: 0.2 },
			easeOut: { influence: 0.25, slope: 1.5 },
			inInterpolation: 'bezier',
			interpolation: 'bezier',
		});
		const dst = key('opacity', [
			[0, 0],
			[10, 80],
			[20, 20],
			[30, 90],
		]);
		if (!c.ok) throw new Error(c.message);
		h.ok([{ type: 'keyframe.pasteEase', keyframeIds: [dst[1]!, dst[2]!], clip: c.clip }]);
		const k = anim<number>('opacity').keyframes;
		for (const i of [1, 2]) {
			expect(k[i]!.easeIn).toEqual({ influence: 0.6, slope: 0.2 });
			expect(k[i]!.easeOut).toEqual({ influence: 0.25, slope: 1.5 });
			expect(k[i]!.interpolation).toBe('bezier');
		}
		// The neighbours' far sides stay linear: key 0 leaves linearly, key 3 arrives linearly.
		expect(k[0]!.easeOut).toEqual({ influence: 1 / 3, slope: 1 });
		expect(k[3]!.easeIn).toEqual({ influence: 1 / 3, slope: 1 });
		expectValid(h);
	});

	it('segments: one curve goes onto every target segment; n curves in order with a count warning', () => {
		const { h, key, anim } = setup();
		const src = key('transform.rotation', [
			[0, 0],
			[10, 40],
			[20, 100],
		]);
		h.ok([{ type: 'keyframe.applyEase', keyframeIds: [src[0]!, src[1]!], curve: SWIFT }]);
		h.ok([{ type: 'keyframe.applyEase', keyframeIds: [src[1]!, src[2]!], curve: SNAP }]);
		const two = copyEase(h.doc, [src[0]!, src[1]!, src[2]!]);
		if (!two.ok) throw new Error(two.message);
		expect(two.clip.kind).toBe('segments');
		if (two.clip.kind !== 'segments') return;
		expect(two.clip.segments.length).toBe(2);
		expect(two.clip.segments[0]!.x1).toBeCloseTo(SWIFT.x1, 12);
		expect(two.clip.segments[1]!.y1).toBeCloseTo(SNAP.y1, 12);
		expect(two.clip.curve?.points.length).toBe(3);
		const dst = key('opacity', [
			[0, 0],
			[10, 50],
			[20, 60],
			[30, 100],
		]);
		const r = h.ok([{ type: 'keyframe.pasteEase', keyframeIds: dst, clip: two.clip, mode: 'segments' }]);
		expect(r.warnings.map((w) => w.code)).toContain('W_EASE_COUNT_MISMATCH');
		const a = anim<number>('opacity');
		const t = a.keyframes.map((k) => k.time);
		expect(evaluate(a, (t[0]! + t[1]!) / 2)).toBeCloseTo(50 * cssCubic(SWIFT, 0.5), 9);
		expect(evaluate(a, (t[1]! + t[2]!) / 2)).toBeCloseTo(50 + 10 * cssCubic(SNAP, 0.5), 9);
		expect(evaluate(a, (t[2]! + t[3]!) / 2)).toBeCloseTo(80, 9); // third segment untouched (linear)
		// One copied segment → every target segment.
		const one = copyEase(h.doc, [src[0]!, src[1]!]);
		if (!one.ok) throw new Error(one.message);
		const r2 = h.ok([{ type: 'keyframe.pasteEase', keyframeIds: dst, clip: one.clip }]);
		expect(r2.warnings.map((w) => w.code)).not.toContain('W_EASE_COUNT_MISMATCH');
		const b = anim<number>('opacity');
		expect(evaluate(b, (t[2]! + t[3]!) / 2)).toBeCloseTo(60 + 40 * cssCubic(SWIFT, 0.5), 9);
		expectValid(h);
	});

	it('a copied multi-key curve pastes as a multi-point rebuild unless mode is "segments"', () => {
		const { h, key, anim } = setup();
		const src = key('transform.rotation', [
			[0, 0],
			[12, 120],
			[30, 100],
		]);
		h.ok([{ type: 'keyframe.applyEase', keyframeIds: src, curve: SWIFT }]);
		const c = copyEase(h.doc, src);
		if (!c.ok || c.clip.kind !== 'segments' || !c.clip.curve) throw new Error('no curve');
		const curve = c.clip.curve;
		expect(curve.points[1]!.x).toBeCloseTo(0.4, 9);
		expect(curve.points[1]!.y).toBeCloseTo(1.2, 9);
		const dst = key('transform.scale', [
			[40, 100],
			[70, 300],
		]);
		h.ok([{ type: 'keyframe.pasteEase', keyframeIds: dst, clip: c.clip }]);
		const a = anim<number>('transform.scale');
		expect(a.keyframes.length).toBe(3);
		const [t0, t1] = [a.keyframes[0]!.time, a.keyframes[2]!.time];
		for (let k = 0; k <= 50; k++) {
			const u = k / 50;
			expect((evaluate(a, t0 + u * (t1 - t0)) - 100) / 200).toBeCloseTo(evaluateEaseCurve(curve, u), 6);
		}
		const noCurve = h.tx([
			{
				type: 'keyframe.pasteEase',
				keyframeIds: dst,
				clip: { kind: 'segments', segments: [SWIFT] },
				mode: 'curve',
			},
		]);
		expect(!noCurve.ok && noCurve.errors[0]!.code).toBe('E_INVALID_PARAM');
		expectValid(h);
	});

	it('refuses an ease copy from non-adjacent keys of several properties; reads locked tracks', () => {
		const { h, key } = setup();
		const a = key('transform.rotation', [
			[0, 0],
			[10, 10],
			[20, 20],
		]);
		const b = key('opacity', [
			[0, 0],
			[10, 10],
			[20, 20],
		]);
		const bad = copyEase(h.doc, [a[0]!, a[2]!, b[0]!, b[2]!]);
		expect(bad.ok).toBe(false);
		h.ok([{ type: 'track.update', trackId: 'V1', patch: { locked: true } }]);
		expect(copyEase(h.doc, [a[0]!, a[1]!]).ok).toBe(true);
		expect(copyValues(h.doc, [b[2]!, a[1]!])).toEqual({ ok: true, values: [10, 20] });
		expect(copyEase(h.doc, ['kf_missing'])).toMatchObject({ ok: false, code: 'E_NOT_FOUND' });
	});
});

describe('copyValues / keyframe.pasteValues', () => {
	it('pastes in order (property, then time), keeping times and eases; validates like keyframe.update', () => {
		const { h, key, anim } = setup();
		const rot = key('transform.rotation', [
			[0, 5],
			[10, 15],
			[20, 25],
		]);
		const copied = copyValues(h.doc, rot);
		expect(copied).toEqual({ ok: true, values: [5, 15, 25] });
		const op = key('opacity', [
			[0, 0],
			[30, 0],
		]);
		const timesBefore = anim('opacity').keyframes.map((k) => k.time);
		const r = h.ok([{ type: 'keyframe.pasteValues', keyframeIds: op, values: [40, 150, 7] }]);
		expect(r.warnings.map((w) => w.code).sort()).toEqual(['W_EASE_COUNT_MISMATCH', 'W_VALUE_CLAMPED']);
		expect(anim('opacity').keyframes.map((k) => k.value)).toEqual([40, 100]);
		expect(anim('opacity').keyframes.map((k) => k.time)).toEqual(timesBefore);
		const bad = h.tx([{ type: 'keyframe.pasteValues', keyframeIds: op, values: [[1, 2]] }]);
		expect(!bad.ok && bad.errors[0]!.code).toBe('E_INVALID_PARAM');
		expectValid(h);
	});
});

describe('describeKeyframeEases / keyframe.setVelocity', () => {
	it('speed ↔ slope through the segment average speed (numbers, signed)', () => {
		const { h, key, anim } = setup();
		const ids = key('transform.rotation', [
			[0, 100],
			[30, 0],
			[60, 0],
		]);
		// 100 → 0 in one second: average −100 °/s.
		const d0 = describeKeyframeEases(h.doc, [ids[0]!]);
		if (!d0.ok) throw new Error(d0.message);
		expect(d0.properties[0]!.keys[0]!.easeOut!.speed).toBeCloseTo(-100, 9);
		expect(d0.properties[0]!.keys[0]!.easeIn).toBeNull();
		h.ok([{ type: 'keyframe.setVelocity', keyframeId: ids[0]!, side: 'out', speed: -250, influence: 60 }]);
		const k = anim<number>('transform.rotation').keyframes[0]!;
		expect(k.easeOut.slope).toBeCloseTo(2.5, 12);
		expect(k.easeOut.influence).toBeCloseTo(0.6, 12);
		const d1 = describeKeyframeEases(h.doc, [ids[0]!]);
		if (!d1.ok) throw new Error(d1.message);
		expect(d1.properties[0]!.keys[0]!.easeOut!.speed).toBeCloseTo(-250, 9);
		expect(d1.properties[0]!.keys[0]!.easeOut!.influencePercent).toBeCloseTo(60, 9);
		// The evaluator's speed right after the key matches.
		const a = anim<number>('transform.rotation');
		const dt = SEC / 100_000;
		expect((evaluate(a, k.time + dt) - evaluate(a, k.time)) / (dt / SEC)).toBeCloseTo(-250, 0);
		// A flat segment cannot hold a speed.
		const flat = h.tx([{ type: 'keyframe.setVelocity', keyframeId: ids[2]!, side: 'in', speed: 10 }]);
		expect(!flat.ok && flat.errors[0]!.message).toMatch(/does not change the value/);
		// No segment after the last key; nothing given.
		expect(h.tx([{ type: 'keyframe.setVelocity', keyframeId: ids[2]!, side: 'out', speed: 0 }]).ok).toBe(
			false,
		);
		expect(h.tx([{ type: 'keyframe.setVelocity', keyframeId: ids[1]!, side: 'in' }]).ok).toBe(false);
		// 'both' on the last key sets the side it has; influence only keeps the speed.
		h.ok([{ type: 'keyframe.setVelocity', keyframeId: ids[1]!, side: 'both', influence: 80 }]);
		const d2 = describeKeyframeEases(h.doc, [ids[1]!]);
		if (!d2.ok) throw new Error(d2.message);
		expect(d2.properties[0]!.keys[0]!.easeIn!.influencePercent).toBeCloseTo(80, 9);
		expect(d2.properties[0]!.keys[0]!.easeIn!.speed).toBeCloseTo(-100, 9);
		expectValid(h);
	});

	it('point properties: px/s along the curved path; round trip through describe', () => {
		const { h, key, anim } = setup();
		const ids = key('transform.position', [
			[0, [100, 100] as Vec2],
			[30, [700, 400] as Vec2],
			[60, [1200, 100] as Vec2],
		]);
		h.ok([{ type: 'keyframe.setVelocity', keyframeId: ids[1]!, side: 'both', speed: 300 }]);
		const d = describeKeyframeEases(h.doc, [ids[1]!]);
		if (!d.ok) throw new Error(d.message);
		const p = d.properties[0]!;
		expect(p.spatial).toBe(true);
		expect(p.keys[0]!.easeIn!.speed).toBeCloseTo(300, 9);
		expect(p.keys[0]!.easeOut!.speed).toBeCloseTo(300, 9);
		expect(p.segments.map((s) => s.section)).toEqual(['in', 'out']);
		const a = anim<Vec2>('transform.position');
		const t = a.keyframes[1]!.time;
		const dt = SEC / 10_000;
		const q0 = evaluate(a, t);
		const q1 = evaluate(a, t + dt);
		expect(Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) / (dt / SEC)).toBeCloseTo(300, -1);
		expectValid(h);
	});

	it('roving keys refuse a speed of their own', () => {
		const { h, key } = setup();
		const ids = key('transform.rotation', [
			[0, 0],
			[10, 30],
			[30, 60],
		]);
		h.ok([{ type: 'keyframe.setRoving', keyframeIds: [ids[1]!], roving: true }]);
		const r = h.tx([{ type: 'keyframe.setVelocity', keyframeId: ids[1]!, side: 'in', speed: 1 }]);
		expect(!r.ok && r.errors[0]!.message).toMatch(/roves/);
	});

	it('segments report cubic-bezier curves per section', () => {
		const { h, key } = setup();
		const ids = key('transform.rotation', [
			[0, 0],
			[10, 10],
			[20, 20],
		]);
		h.ok([{ type: 'keyframe.applyEase', keyframeIds: [ids[0]!, ids[1]!], curve: SWIFT }]);
		const d = describeKeyframeEases(h.doc, [ids[0]!, ids[1]!]);
		if (!d.ok) throw new Error(d.message);
		const segs = d.properties[0]!.segments;
		expect(segs.map((s) => s.section)).toEqual(['middle', 'out']);
		const back = cubicToEases(segs[0]!.curve);
		expect(back.easeOut.influence).toBeCloseTo(cubicToEases(SWIFT).easeOut.influence, 12);
	});
});
