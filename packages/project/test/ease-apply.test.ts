// keyframe.applyEase — cubic sections, neighbour preservation, roving, refusals (docs/wp-notes/easing.md).
import { describe, expect, it } from 'vitest';
import { type Animatable, type CubicEase, evaluate, unknownCommandKeyIssues } from '../src/index.ts';
import { cssCubic, expectValid, sample, setup } from './ease-helpers.ts';

const SWIFT: CubicEase = { kind: 'cubic', x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
const BACK: CubicEase = { kind: 'cubic', x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 };

describe('keyframe.applyEase (cubic)', () => {
	it("two keys: the middle segment follows cubic-bezier exactly; the segment's sides become Bezier", () => {
		const { h, key, anim } = setup();
		const ids = key('transform.rotation', [
			[0, 0],
			[30, 90],
		]);
		const r = h.ok([{ type: 'keyframe.applyEase', keyframeIds: ids, curve: SWIFT }]);
		const res = r.results[0] as { affected: string[]; created: string[]; removed: string[] };
		expect(res.affected.sort()).toEqual([...ids].sort());
		expect(res.created).toEqual([]);
		const a = anim<number>('transform.rotation');
		// keyframe-sides: the first key leaves Bezier; the last key arrives Bezier (its own incoming side) and keeps its
		// Linear outgoing side.
		expect(a.keyframes.map((k) => k.interpolation)).toEqual(['bezier', 'linear']);
		expect(a.keyframes[1]!.inInterpolation).toBe('bezier');
		const [t0, t1] = [a.keyframes[0]!.time, a.keyframes[1]!.time];
		for (let k = 0; k <= 100; k++) {
			const u = k / 100;
			expect(evaluate(a, t0 + u * (t1 - t0))).toBeCloseTo(90 * cssCubic(SWIFT, u), 9);
		}
		expectValid(h);
	});

	it('one key: default sections in + out; sections pick segments exactly', () => {
		const { h, key, anim } = setup();
		const ids = key('transform.rotation', [
			[0, 0],
			[10, 10],
			[20, 30],
			[30, 60],
		]);
		h.ok([{ type: 'keyframe.applyEase', keyframeIds: [ids[1]!], curve: SWIFT }]);
		let k = anim<number>('transform.rotation').keyframes;
		const initial = anim<number>('transform.rotation');
		for (const s of [0, 1]) {
			const at = k[s]!.time + (k[s + 1]!.time - k[s]!.time) / 4;
			const want = s === 0 ? 10 * cssCubic(SWIFT, 0.25) : 10 + 20 * cssCubic(SWIFT, 0.25);
			expect(evaluate(initial, at)).toBeCloseTo(want, 9);
		}
		// keyframe-sides: key 2 arrives Bezier and still leaves Linear.
		expect(k[2]!.inInterpolation).toBe('bezier');
		expect(k[2]!.interpolation).toBe('linear');
		// Segment 2 → 3 stays linear (key 2 leaves Linear, key 3 is untouched and read the legacy way).
		const a = anim<number>('transform.rotation');
		const mid = (k[2]!.time + k[3]!.time) / 2;
		expect(evaluate(a, mid)).toBeCloseTo(45, 9);
		expect(k[3]!.interpolation).toBe('linear');
		// sections: ['out'] of keys 1 and 2 → only segment 2 → 3.
		h.ok([{ type: 'keyframe.applyEase', keyframeIds: [ids[1]!, ids[2]!], curve: BACK, sections: ['out'] }]);
		k = anim<number>('transform.rotation').keyframes;
		const after = anim<number>('transform.rotation');
		const chosen = k[2]!.time + (k[3]!.time - k[2]!.time) / 4;
		expect(evaluate(after, chosen)).toBeCloseTo(30 + 30 * cssCubic(BACK, 0.25), 9);
		const unchanged = k[1]!.time + (k[2]!.time - k[1]!.time) / 4;
		expect(evaluate(after, unchanged)).toBeCloseTo(10 + 20 * cssCubic(SWIFT, 0.25), 9);
		// sections: ['in', 'middle'] with non-adjacent keys 0 and 2: only the in segment (none before key 0) → refused.
		const bad = h.tx([
			{
				type: 'keyframe.applyEase',
				keyframeIds: [ids[0]!, ids[2]!],
				curve: BACK,
				sections: ['in', 'middle'],
			},
		]);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors[0]!.code).toBe('E_INVALID_PARAM');
		expectValid(h);
	});

	it('neighbouring segments keep their shape: linear B with an Auto Bezier C, hold, continuous', () => {
		const { h, key, anim } = setup();
		const ids = key('transform.rotation', [
			[0, 0],
			[10, 40],
			[20, 20],
			[30, 80],
			[40, 50],
		]);
		h.ok([
			{ type: 'keyframe.update', keyframeId: ids[0]!, interpolation: 'auto-bezier' },
			{ type: 'keyframe.update', keyframeId: ids[2]!, interpolation: 'auto-bezier' },
			{
				type: 'keyframe.update',
				keyframeId: ids[3]!,
				interpolation: 'continuous-bezier',
				easeIn: { influence: 0.5, slope: 0.4 },
			},
		]);
		const before = structuredClone(anim<number>('transform.rotation'));
		const t = before.keyframes.map((k) => k.time);
		h.ok([{ type: 'keyframe.applyEase', keyframeIds: [ids[0]!, ids[1]!], curve: BACK }]);
		const after = anim<number>('transform.rotation');
		// Target segment exact.
		for (let k = 0; k <= 50; k++) {
			const u = k / 50;
			expect(evaluate(after, t[0]! + u * (t[1]! - t[0]!))).toBeCloseTo(40 * cssCubic(BACK, u), 9);
		}
		// Every other segment unchanged.
		const s0 = sample(before, t[1]!, t[4]!, 300);
		const s1 = sample(after, t[1]!, t[4]!, 300);
		for (let i = 0; i < s0.length; i++) expect(s1[i]).toBeCloseTo(s0[i]!, 9);
		expectValid(h);
	});

	it('a hold A becomes Bezier; auto / continuous B keeps its out ease', () => {
		const { h, key, anim } = setup();
		const ids = key('transform.rotation', [
			[0, 0],
			[10, 50],
			[20, 0],
		]);
		h.ok([
			{ type: 'keyframe.update', keyframeId: ids[0]!, interpolation: 'hold' },
			{ type: 'keyframe.update', keyframeId: ids[1]!, interpolation: 'auto-bezier' },
		]);
		const before = structuredClone(anim<number>('transform.rotation'));
		const t = before.keyframes.map((k) => k.time);
		h.ok([{ type: 'keyframe.applyEase', keyframeIds: [ids[0]!, ids[1]!], curve: SWIFT }]);
		const a = anim<number>('transform.rotation');
		expect(a.keyframes[0]!.interpolation).toBe('bezier');
		expect(a.keyframes[1]!.interpolation).toBe('bezier');
		expect(evaluate(a, (t[0]! + t[1]!) / 2)).toBeCloseTo(50 * cssCubic(SWIFT, 0.5), 9);
		const ref = sample(before, t[1]!, t[2]!);
		for (let i = 0; i < ref.length; i++)
			expect(evaluate(a, t[1]! + ((t[2]! - t[1]!) * i) / (ref.length - 1))).toBeCloseTo(ref[i]!, 9);
	});

	it('roving: a segment touching a roving key is the run between the fixed keys', () => {
		const { h, key, anim } = setup();
		const ids = key('transform.rotation', [
			[0, 0],
			[10, 30],
			[60, 100],
		]);
		h.ok([{ type: 'keyframe.setRoving', keyframeIds: [ids[1]!], roving: true }]);
		// Selecting only the roving key: in + out are the same run → one span.
		h.ok([{ type: 'keyframe.applyEase', keyframeIds: [ids[1]!], curve: SWIFT }]);
		const a = anim<number>('transform.rotation');
		expect(a.keyframes[1]!.roving).toBe(true);
		const [t0, t2] = [a.keyframes[0]!.time, a.keyframes[2]!.time];
		for (let k = 0; k <= 40; k++) {
			const u = k / 40;
			expect(evaluate(a, t0 + u * (t2 - t0))).toBeCloseTo(100 * cssCubic(SWIFT, u), 6);
		}
		// The roving key was re-timed to where the eased motion passes 30.
		expect(evaluate(a, a.keyframes[1]!.time)).toBeCloseTo(30, 3);
		expectValid(h);
	});
});

describe('keyframe.applyEase refusals and skips', () => {
	it('hold-only properties are skipped with a warning; only hold-only → refused', () => {
		const { h, key, id } = setup();
		const rot = key('transform.rotation', [
			[0, 0],
			[30, 90],
		]);
		h.ok([{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.checkbox-control', ref: '$cb' }]);
		const fx = (
			h.seq.clips[id] as unknown as { effects: { id: string; params: Record<string, Animatable<unknown>> }[] }
		).effects[0]!;
		h.ok([
			{
				type: 'param.setAnimated',
				target: ['effect', fx.id, 'checkbox'],
				animated: true,
				at: { sequenceFrame: 0 },
			},
			{ type: 'param.set', target: ['effect', fx.id, 'checkbox'], value: true, at: { sequenceFrame: 20 } },
		]);
		const cb = (
			h.seq.clips[id] as unknown as { effects: { params: Record<string, Animatable<unknown>> }[] }
		).effects[0]!.params.checkbox!.keyframes.map((k) => k.id);
		const r = h.ok([{ type: 'keyframe.applyEase', keyframeIds: [...rot, ...cb], curve: SWIFT }]);
		expect(r.warnings.map((w) => w.code)).toContain('W_EASE_SKIPPED');
		expect(r.warnings.find((w) => w.code === 'W_EASE_SKIPPED')!.message).toMatch(/do not interpolate/);
		const only = h.tx([{ type: 'keyframe.applyEase', keyframeIds: cb, curve: SWIFT }]);
		expect(only.ok).toBe(false);
		if (!only.ok) expect(only.errors[0]!.code).toBe('E_INVALID_PARAM');
	});

	it('locked tracks refuse with E_TRACK_LOCKED; unknown ids with E_NOT_FOUND', () => {
		const { h, key } = setup();
		const ids = key('transform.rotation', [
			[0, 0],
			[30, 90],
		]);
		const missing = h.tx([{ type: 'keyframe.applyEase', keyframeIds: ['kf_nope'], curve: SWIFT }]);
		expect(!missing.ok && missing.errors[0]!.code).toBe('E_NOT_FOUND');
		h.ok([{ type: 'track.update', trackId: 'V1', patch: { locked: true } }]);
		const r = h.tx([{ type: 'keyframe.applyEase', keyframeIds: ids, curve: SWIFT }]);
		expect(!r.ok && r.errors[0]!.code).toBe('E_TRACK_LOCKED');
	});

	it('3D Orientation: an overshooting curve warns that the overshoot is clamped', () => {
		const { h, id } = setup();
		h.ok([{ type: 'clip.set3d', clipIds: [id], enabled: true }]);
		const path = ['clip', id, 'threeD', 'orientation'];
		h.ok([
			{ type: 'param.setAnimated', target: path, animated: true, at: { sequenceFrame: 0 } },
			{ type: 'param.set', target: path, value: [0, 90, 0], at: { sequenceFrame: 30 } },
		]);
		const clip = h.seq.clips[id] as unknown as { threeD: { orientation: Animatable<unknown> } };
		const ids = clip.threeD.orientation.keyframes.map((k) => k.id);
		const r = h.ok([{ type: 'keyframe.applyEase', keyframeIds: ids, curve: BACK }]);
		expect(r.warnings.map((w) => w.code)).toContain('W_EASE_CLAMPED');
		const r2 = h.ok([{ type: 'keyframe.applyEase', keyframeIds: ids, curve: SWIFT }]);
		expect(r2.warnings.map((w) => w.code)).not.toContain('W_EASE_CLAMPED');
		expectValid(h);
	});

	it('strict agent key checks identify an unknown key inside an ease curve', () => {
		const issues = unknownCommandKeyIssues([
			{
				type: 'keyframe.applyEase',
				keyframeIds: ['kf_1'],
				curve: { kind: 'cubic', x1: 0.4, y1: 0, x2: 0.6, y2: 1, bogus: 1 },
			},
		]);
		expect(issues).toEqual([expect.objectContaining({ code: 'E_SCHEMA', path: ['curve'], commandIndex: 0 })]);
	});
});
