// keyframe-sides: commands that set one side of a key (Premiere's Ease In / Ease Out), undo / redo, refusals,
// invariants, repair and paste (docs/wp-notes/keyframe-sides.md).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	buildKeyframesPayload,
	type Clip,
	checkInvariants,
	contentTimeAt,
	createCounterIdSource,
	evaluate,
	type Interpolation,
	type Keyframe,
	loadProject,
	type ProjectDocument,
	type Rational,
	repairDocument,
	segmentShape,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

type VClip = Extract<Clip, { kind: 'solid' }>;
const EASY = { influence: 1 / 3, slope: 0 };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function setup(values = [0, 100, 20], interps: Interpolation[] = ['linear', 'linear', 'linear']) {
	const h = new Harness();
	h.ok([{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V1', color: [1, 0, 0, 1] }]);
	const id = h.clips('V1')[0]!.id;
	const op = ['clip', id, 'opacity'];
	const r = h.ok(
		values.map((value, i) => ({
			type: 'keyframe.add',
			target: op,
			at: { sequenceFrame: i * 100 },
			value,
			interpolation: interps[i],
			ref: `$k${i}`,
		})),
	);
	const ids = values.map((_, i) => r.refs[`$k${i}`]!);
	const clip = () => h.seq.clips[id] as VClip;
	const keys = () => clip().opacity.keyframes as Keyframe<number>[];
	const at = (frame: number) =>
		evaluate(clip().opacity, contentTimeAt(clip(), frame, h.seq.settings.frameRate as Rational));
	const samples = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, j) => at(from + j));
	return { h, id, ids, keys, at, samples };
}

describe('keyframe.setInterpolation with a side (keyframe-sides)', () => {
	it('Ease In (side in) after a Linear key: only the incoming side changes, the curve eases into the key; undo / redo', () => {
		const { h, ids, keys, at, samples } = setup();
		const before = h.doc;
		const snapshot = clone(h.doc);
		const after = samples(100, 200);
		h.ok([
			{
				type: 'keyframe.setInterpolation',
				keyframeIds: [ids[1]],
				interpolation: 'bezier',
				easeIn: EASY,
				side: 'in',
			},
		]);
		const [a, b] = keys();
		expect(a!.interpolation).toBe('linear');
		expect(a).not.toHaveProperty('inInterpolation');
		expect(b).toMatchObject({ interpolation: 'linear', inInterpolation: 'bezier', easeIn: EASY });
		// The eased side shapes the segment from the Linear key (After Effects: ⅙ linear side).
		expect(segmentShape(keys(), 0)).toEqual({ out: { influence: 1 / 6, slope: 1 }, in: EASY });
		expect(at(50)).toBeGreaterThan(50);
		expect(at(99) - at(98)).toBeLessThan(0.2);
		// The segment leaving the key is untouched.
		expect(samples(100, 200)).toEqual(after);
		expect(checkInvariants(h.doc)).toEqual([]);
		// undo = the document before; redo = the same document
		expect(clone(before)).toEqual(snapshot);
		const done = clone(h.doc.sequences);
		h.doc = before;
		h.ok([
			{
				type: 'keyframe.setInterpolation',
				keyframeIds: [ids[1]],
				interpolation: 'bezier',
				easeIn: EASY,
				side: 'in',
			},
		]);
		expect(clone(h.doc.sequences)).toEqual(done);
	});

	it('Ease Out (side out): the arriving segment stays exactly as it was; the leaving one eases out', () => {
		const { h, ids, keys, at, samples } = setup();
		const arriving = samples(0, 100);
		h.ok([
			{
				type: 'keyframe.setInterpolation',
				keyframeIds: [ids[1]],
				interpolation: 'bezier',
				easeOut: EASY,
				side: 'out',
			},
		]);
		const [, b, c] = keys();
		expect(b).toMatchObject({ interpolation: 'bezier', inInterpolation: 'linear', easeOut: EASY });
		expect(c).toMatchObject({ interpolation: 'linear', inInterpolation: 'linear' });
		expect(samples(0, 100)).toEqual(arriving);
		expect(Math.abs(at(101) - at(100))).toBeLessThan(0.05);
		expect(segmentShape(keys(), 1)).toEqual({ out: EASY, in: { influence: 1 / 6, slope: 1 } });
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('property: an outgoing edit never changes the arriving segment, an incoming edit never changes the leaving one', () => {
		const interp = fc.constantFrom<Interpolation>(
			'linear',
			'bezier',
			'auto-bezier',
			'continuous-bezier',
			'hold',
		);
		const sideEdit = fc.record({
			side: fc.constantFrom<'in' | 'out'>('in', 'out'),
			interpolation: fc.constantFrom<Interpolation>('linear', 'bezier', 'hold'),
			ease: fc.record({
				influence: fc.double({ min: 0.05, max: 1, noNaN: true }),
				slope: fc.double({ min: -1, max: 3, noNaN: true }),
			}),
		});
		fc.assert(
			fc.property(
				fc.tuple(interp, interp, interp, interp),
				fc.tuple(
					fc.integer({ min: -50, max: 150 }),
					fc.integer({ min: -50, max: 150 }),
					fc.integer({ min: -50, max: 150 }),
					fc.integer({ min: -50, max: 150 }),
				),
				fc.integer({ min: 0, max: 3 }),
				sideEdit,
				(interps, values, i, edit) => {
					fc.pre(!(edit.side === 'in' && edit.interpolation === 'hold'));
					const s = setup(
						values.map((v) => Math.max(0, Math.min(100, v))),
						interps,
					);
					// Bezier keys with distinctive stored eases.
					s.h.ok(
						s.ids.map((kid, j) =>
							interps[j] === 'bezier' || interps[j] === 'continuous-bezier'
								? {
										type: 'keyframe.update',
										keyframeId: kid,
										easeIn: { influence: 0.4, slope: 0.5 },
										easeOut: { influence: 0.7, slope: 1.5 },
									}
								: { type: 'keyframe.update', keyframeId: kid, value: s.keys()[j]!.value },
						),
					);
					const keep = edit.side === 'out' ? [(i - 1) * 100, i * 100] : [i * 100, (i + 1) * 100];
					const lo = Math.max(0, keep[0]!);
					const hi = Math.min(300, keep[1]!);
					const auto = s.keys().some((k) => k.interpolation === 'auto-bezier');
					const before = hi > lo ? s.samples(lo, hi) : [];
					s.h.ok([
						{
							type: 'keyframe.setInterpolation',
							keyframeIds: [s.ids[i]],
							interpolation: edit.interpolation,
							side: edit.side,
							...(edit.side === 'in' ? { easeIn: edit.ease } : { easeOut: edit.ease }),
						},
					]);
					expect(checkInvariants(s.h.doc)).toEqual([]);
					// Auto Bezier neighbours measure values only, so their shape is unchanged too.
					if (hi > lo) {
						const now = s.samples(lo, hi);
						now.forEach((v, j) => {
							expect(v).toBeCloseTo(before[j]!, auto ? 9 : 12);
						});
					}
				},
			),
			{ numRuns: 120 },
		);
	});

	it('Hold on both sides only changes the outgoing side; Linear / Bezier on both make the key explicit', () => {
		const { h, ids, keys, samples } = setup([0, 100, 20], ['bezier', 'linear', 'linear']);
		const arriving = samples(0, 100);
		h.ok([{ type: 'keyframe.setInterpolation', keyframeIds: [ids[1]], interpolation: 'hold' }]);
		expect(keys()[1]).toMatchObject({ interpolation: 'hold', inInterpolation: 'bezier' });
		expect(samples(0, 100)).toEqual(arriving);
		h.ok([{ type: 'keyframe.setInterpolation', keyframeIds: [ids[1]], interpolation: 'bezier' }]);
		expect(keys()[1]).toMatchObject({ interpolation: 'bezier', inInterpolation: 'bezier' });
		expect(keys()[2]).toMatchObject({ inInterpolation: 'linear' });
	});

	it('refusals: Hold on the incoming side, Auto / Continuous on one side, an ease for the other side', () => {
		const { h, ids } = setup();
		const doc = h.doc;
		for (const cmd of [
			{ interpolation: 'hold', side: 'in' },
			{ interpolation: 'auto-bezier', side: 'out' },
			{ interpolation: 'continuous-bezier', side: 'in' },
			{ interpolation: 'bezier', side: 'in', easeOut: EASY },
			{ interpolation: 'bezier', side: 'out', easeIn: EASY },
		]) {
			const r = h.tx([{ type: 'keyframe.setInterpolation', keyframeIds: [ids[1]], ...cmd }]);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.errors[0]!.code).toBe('E_INVALID_PARAM');
			expect(h.doc).toBe(doc);
		}
		const bad = h.tx([
			{ type: 'keyframe.setInterpolation', keyframeIds: [ids[1]], interpolation: 'bezier', side: 'left' },
		]);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors[0]!.code).toBe('E_SCHEMA');
		expect(h.doc).toBe(doc);
	});
});

describe('keyframe.update / keyframe.add with sides (keyframe-sides)', () => {
	it('keyframe.update side in edits only the incoming ease (graph handle drag)', () => {
		const { h, ids, keys, samples } = setup([0, 100, 20], ['bezier', 'bezier', 'linear']);
		const leaving = samples(100, 200);
		h.ok([
			{
				type: 'keyframe.update',
				keyframeId: ids[1],
				interpolation: 'bezier',
				easeIn: { influence: 0.8, slope: 0.1 },
				side: 'in',
			},
		]);
		expect(keys()[1]).toMatchObject({
			interpolation: 'bezier',
			inInterpolation: 'bezier',
			easeIn: { influence: 0.8, slope: 0.1 },
		});
		expect(samples(100, 200)).toEqual(leaving);
		const doc = h.doc;
		const r = h.tx([{ type: 'keyframe.update', keyframeId: ids[1], interpolation: 'hold', side: 'in' }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_INVALID_PARAM');
		expect(h.doc).toBe(doc);
	});

	it('keyframe.add accepts inInterpolation and refuses a one-sided Auto Bezier', () => {
		const { h, id, keys } = setup([0, 100], ['linear', 'linear']);
		h.ok([
			{
				type: 'keyframe.add',
				target: ['clip', id, 'opacity'],
				at: { sequenceFrame: 200 },
				value: 50,
				inInterpolation: 'bezier',
				easeIn: EASY,
			},
		]);
		expect(keys()[2]).toMatchObject({ interpolation: 'linear', inInterpolation: 'bezier' });
		const r = h.tx([
			{
				type: 'keyframe.add',
				target: ['clip', id, 'opacity'],
				at: { sequenceFrame: 250 },
				value: 5,
				interpolation: 'auto-bezier',
				inInterpolation: 'linear',
			},
		]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_INVALID_PARAM');
		const unknown = h.tx([
			{
				type: 'keyframe.add',
				target: ['clip', id, 'opacity'],
				at: { sequenceFrame: 250 },
				value: 5,
				inInterpolation: 'hold',
			},
		]);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.errors[0]!.code).toBe('E_SCHEMA');
	});
});

describe('invariants, repair and paste (keyframe-sides)', () => {
	it('INV-011 reports unreadable incoming types; repairDocument fixes them with a report', () => {
		const { h, ids } = setup();
		const doc = clone(h.doc) as ProjectDocument;
		const c = Object.values(Object.values(doc.sequences)[0]!.clips)[0] as VClip;
		c.opacity.keyframes[0]!.interpolation = 'hold';
		c.opacity.keyframes[0]!.inInterpolation = 'continuous-bezier';
		(c.opacity.keyframes[1] as { inInterpolation?: unknown }).inInterpolation = 'sideways';
		c.opacity.keyframes[2]!.interpolation = 'auto-bezier';
		c.opacity.keyframes[2]!.inInterpolation = 'linear';
		const issues = checkInvariants(doc).filter((i) => i.invariant === 'INV-011');
		expect(issues.map((i) => ({ code: i.code, key: i.path?.at(-1) }))).toEqual([
			{ code: 'E_INVARIANT', key: ids[0] },
			{ code: 'E_INVARIANT', key: ids[1] },
			{ code: 'E_INVARIANT', key: ids[2] },
		]);
		const { document, report } = repairDocument(doc, createCounterIdSource(99));
		expect(report.filter((r) => r.action === 'repair-key-sides').map((r) => r.entity)).toEqual([
			ids[0],
			ids[1],
			ids[2],
		]);
		expect(checkInvariants(document)).toEqual([]);
		const kfs = (Object.values(Object.values(document.sequences)[0]!.clips)[0] as VClip).opacity.keyframes;
		expect(kfs[0]).toMatchObject({ interpolation: 'hold', inInterpolation: 'bezier' });
		expect(kfs[1]).not.toHaveProperty('inInterpolation');
		expect(kfs[2]).toMatchObject({ interpolation: 'bezier', inInterpolation: 'linear' });
		// Idempotent.
		expect(
			repairDocument(document, createCounterIdSource(99)).report.filter(
				(r) => r.action === 'repair-key-sides',
			),
		).toEqual([]);
	});

	it('copied keys keep their incoming side when pasted', () => {
		const { h, id, ids, samples } = setup();
		h.ok([
			{
				type: 'keyframe.setInterpolation',
				keyframeIds: [ids[1]],
				interpolation: 'bezier',
				easeIn: EASY,
				side: 'in',
			},
		]);
		const payload = JSON.parse(JSON.stringify(buildKeyframesPayload(h.doc, id, ids)));
		h.ok([{ type: 'clip.addSolid', at: 400, duration: 300, track: 'V2', color: [0, 1, 0, 1] }]);
		const other = h.clips('V2')[0]!.id;
		h.ok([{ type: 'keyframe.paste', payload, clipId: other, at: { sequenceFrame: 400 } }]);
		const pasted = (h.seq.clips[other] as VClip).opacity.keyframes;
		expect(pasted.map((k) => k.inInterpolation)).toEqual([undefined, 'bezier', undefined]);
		const c = h.seq.clips[other]!;
		const rate = h.seq.settings.frameRate as Rational;
		const there = Array.from({ length: 201 }, (_, j) =>
			evaluate((c as VClip).opacity, contentTimeAt(c, 400 + j, rate)),
		);
		const original = samples(0, 200);
		there.forEach((v, j) => {
			expect(v).toBeCloseTo(original[j]!, 9);
		});
		// A tampered payload cannot smuggle an unreadable side in: the payload schema refuses it.
		payload.keyframes.keyframes[1].inInterpolation = 'hold';
		h.ok([{ type: 'clip.addSolid', at: 800, duration: 300, track: 'V3', color: [0, 0, 1, 1] }]);
		const third = h.clips('V3')[0]!.id;
		const doc = h.doc;
		const r = h.tx([{ type: 'keyframe.paste', payload, clipId: third, at: { sequenceFrame: 800 } }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_SCHEMA');
		expect(h.doc).toBe(doc);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('loadProject reads a damaged incoming side leniently: dropped before validation and reported', () => {
		const { h, ids } = setup();
		const raw = clone(h.doc) as unknown as { sequences: Record<string, { clips: Record<string, VClip> }> };
		const c = Object.values(Object.values(raw.sequences)[0]!.clips)[0]!;
		(c.opacity.keyframes[1] as { inInterpolation?: unknown }).inInterpolation = { evil: true };
		(c.opacity.keyframes[2] as { inInterpolation?: unknown }).inInterpolation = 'bezier';
		const before = clone(raw);
		const r = loadProject(raw);
		expect(raw).toEqual(before); // the caller's data is not mutated
		expect(r.repairs.filter((x) => x.action === 'repair-key-sides').map((x) => x.entity)).toEqual([ids[1]]);
		const kfs = (Object.values(Object.values(r.document.sequences)[0]!.clips)[0] as VClip).opacity.keyframes;
		expect(kfs[1]).not.toHaveProperty('inInterpolation');
		expect(kfs[2]!.inInterpolation).toBe('bezier');
		expect(r.issues).toEqual([]);
		expect(loadProject(r.document).repairs).toEqual([]);
	});
});
