// wp masks: mask.* commands, mask ParamPaths (param.set / keyframes), ids on copies, invariants and repair.
import { describe, expect, it } from 'vitest';
import {
	type BezierPath,
	buildRenderSnapshot,
	checkInvariants,
	createCounterIdSource,
	defaultEffectRegistry,
	evaluate,
	flicksPerFrame,
	type Mask,
	pathLength,
	repairDocument,
	resolveMask,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F = flicksPerFrame({ num: 30, den: 1 });

function setup() {
	const h = new Harness();
	const m = h.registerVideo({ seconds: 4, audio: false, width: 1920, height: 1080 });
	h.ok([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at: 0,
			sourceRange: { in: { flicks: 0 }, out: { flicks: 60 * F } },
		},
	]);
	const clipId = h.clips('V1')[0]!.id;
	h.ok([{ type: 'effect.add', target: { clipId }, effectId: 'jasper.gaussian-blur', ref: '$fx' }]);
	const fxId = (h.seq.clips[clipId] as { effects: { id: string }[] }).effects[0]!.id;
	return { h, clipId, fxId };
}

const masksOf = (h: Harness, clipId: string) =>
	((h.seq.clips[clipId] as { masks?: Mask[] }).masks ?? []) as Mask[];
const fxMasksOf = (h: Harness, clipId: string) =>
	((h.seq.clips[clipId] as { effects: { masks?: Mask[] }[] }).effects[0]!.masks ?? []) as Mask[];

describe('mask commands', () => {
	it('adds ellipse / polygon / pen masks to Opacity and to an effect, with Premiere defaults and names', () => {
		const { h, clipId, fxId } = setup();
		const r = h.ok([
			{ type: 'mask.add', clipId, shape: 'ellipse', ref: '$m1' },
			{ type: 'mask.add', clipId, shape: 'polygon' },
			{
				type: 'mask.add',
				effectId: fxId,
				shape: 'bezier',
				path: {
					closed: true,
					vertices: [0.1, 0.5, 0.9].map((x, i) => ({ p: [x, i === 1 ? 0.1 : 0.9], in: [0, 0], out: [0, 0] })),
				},
			},
		]);
		expect((r.results[0] as { name: string }).name).toBe('Mask (1)');
		expect((r.results[1] as { name: string }).name).toBe('Mask (2)');
		const ms = masksOf(h, clipId);
		expect(ms).toHaveLength(2);
		expect(ms[0]!.feather.value).toBe(10);
		expect(ms[0]!.opacity.value).toBe(100);
		expect(ms[0]!.expansion.value).toBe(0);
		expect(ms[0]!.mode).toBe('add');
		expect(ms[0]!.path.value.vertices).toHaveLength(4);
		// A centred circle on a 16:9 box: equal pixel radii.
		const v = ms[0]!.path.value.vertices;
		expect((v[1]!.p[0] - 0.5) * 1920).toBeCloseTo((v[2]!.p[1] - 0.5) * 1080, 6);
		expect(fxMasksOf(h, clipId)).toHaveLength(1);
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
		// A pen mask without a path is refused; two owners at once too.
		expect(h.tx([{ type: 'mask.add', clipId, shape: 'bezier' }]).ok).toBe(false);
		expect(h.tx([{ type: 'mask.add', clipId, effectId: fxId, shape: 'ellipse' }]).ok).toBe(false);
	});

	it('update, reorder, duplicate (new ids) and remove (empty list dropped)', () => {
		const { h, clipId, fxId } = setup();
		h.ok([
			{ type: 'mask.add', clipId, shape: 'ellipse', ref: '$a' },
			{ type: 'mask.add', clipId, shape: 'polygon', ref: '$b' },
		]);
		const [a, b] = masksOf(h, clipId).map((m) => m.id);
		h.ok([
			{
				type: 'mask.update',
				maskId: a,
				mode: 'subtract',
				inverted: true,
				name: 'Hole',
				featherFalloff: 'linear',
				locked: true,
			},
		]);
		const m = masksOf(h, clipId)[0]!;
		expect([m.mode, m.inverted, m.name, m.featherFalloff, m.locked]).toEqual([
			'subtract',
			true,
			'Hole',
			'linear',
			true,
		]);
		h.ok([{ type: 'mask.reorder', maskId: b, index: 0 }]);
		expect(masksOf(h, clipId).map((x) => x.id)).toEqual([b, a]);
		const d = h.ok([{ type: 'mask.duplicate', maskIds: [a] }]);
		const dupId = (d.results[0] as { maskIds: string[] }).maskIds[0]!;
		expect(dupId).not.toBe(a);
		expect(masksOf(h, clipId)).toHaveLength(3);
		h.ok([{ type: 'mask.duplicate', maskIds: [a], toEffectId: fxId }]);
		expect(fxMasksOf(h, clipId)).toHaveLength(1);
		h.ok([{ type: 'mask.remove', maskIds: masksOf(h, clipId).map((x) => x.id) }]);
		expect((h.seq.clips[clipId] as { masks?: unknown }).masks).toBeUndefined();
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
	});

	it('mask properties are ParamPaths: param.set, stopwatch, keyframes, evaluation', () => {
		const { h, clipId } = setup();
		h.ok([{ type: 'mask.add', clipId, shape: 'polygon' }]);
		const id = masksOf(h, clipId)[0]!.id;
		h.ok([{ type: 'param.set', target: ['mask', id, 'feather'], value: 25 }]);
		expect(masksOf(h, clipId)[0]!.feather.value).toBe(25);
		const r = h.tx([{ type: 'param.set', target: ['mask', id, 'opacity'], value: 150 }]);
		expect(r.ok && r.warnings.some((w) => w.code === 'W_VALUE_CLAMPED')).toBe(true);
		h.ok([
			{ type: 'param.setAnimated', target: ['mask', id, 'path'], animated: true, at: { frames: 0 } },
			{
				type: 'mask.editPath',
				maskId: id,
				at: { frames: 30 },
				ops: [{ op: 'moveVertices', vertices: [0, 1, 2, 3], delta: [0.1, 0] }],
			},
		]);
		const mk = masksOf(h, clipId)[0]!;
		expect(mk.path.keyframes).toHaveLength(2);
		const mid = resolveMask(mk, 15 * F);
		expect(mid.path.vertices[0]!.p[0]).toBeCloseTo(mk.path.keyframes[0]!.value.vertices[0]!.p[0] + 0.05, 9);
		// keyframe.* commands find mask keys (they are animatables of the clip).
		h.ok([
			{ type: 'keyframe.setInterpolation', keyframeIds: [mk.path.keyframes[0]!.id], interpolation: 'hold' },
		]);
		expect(resolveMask(masksOf(h, clipId)[0]!, 15 * F).path.vertices[0]!.p[0]).toBeCloseTo(
			mk.path.keyframes[0]!.value.vertices[0]!.p[0],
			9,
		);
		// Invalid path values are refused.
		expect(
			h.tx([{ type: 'param.set', target: ['mask', id, 'path'], value: { closed: true, vertices: 'x' } }]).ok,
		).toBe(false);
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
	});

	it('editPath: topology edits apply to every key; shape edits at the time; pen workflow', () => {
		const { h, clipId } = setup();
		h.ok([
			{
				type: 'mask.add',
				clipId,
				shape: 'bezier',
				path: { closed: false, vertices: [{ p: [0.2, 0.2], in: [0, 0], out: [0, 0] }] },
				ref: '$m',
			},
		]);
		const id = masksOf(h, clipId)[0]!.id;
		h.ok([
			{
				type: 'mask.editPath',
				maskId: id,
				ops: [
					{ op: 'appendVertex', p: [0.8, 0.2] },
					{ op: 'appendVertex', p: [0.5, 0.8], in: [-0.05, 0], out: [0.05, 0] },
					{ op: 'setClosed', closed: true },
				],
			},
		]);
		let p = masksOf(h, clipId)[0]!.path.value;
		expect(p.closed).toBe(true);
		expect(p.vertices).toHaveLength(3);
		h.ok([
			{ type: 'param.setAnimated', target: ['mask', id, 'path'], animated: true, at: { frames: 0 } },
			{ type: 'mask.editPath', maskId: id, at: { frames: 20 }, ops: [{ op: 'transform', scale: 0.5 }] },
			{ type: 'mask.editPath', maskId: id, ops: [{ op: 'insertVertex', segment: 0, t: 0.5 }] },
		]);
		const mk = masksOf(h, clipId)[0]!;
		expect(mk.path.keyframes.map((k) => k.value.vertices.length)).toEqual([4, 4]);
		expect(pathLength(mk.path.keyframes[1]!.value)).toBeLessThan(pathLength(mk.path.keyframes[0]!.value));
		// Removing to fewer than 3 vertices of a closed mask is refused.
		expect(
			h.tx([{ type: 'mask.editPath', maskId: id, ops: [{ op: 'removeVertices', vertices: [0, 1] }] }]).ok,
		).toBe(false);
		h.ok([
			{
				type: 'mask.editPath',
				maskId: id,
				at: { frames: 0 },
				ops: [{ op: 'convert', vertices: [0], to: 'smooth' }],
			},
		]);
		p = masksOf(h, clipId)[0]!.path.keyframes[0]!.value;
		expect(Math.hypot(...p.vertices[0]!.out)).toBeGreaterThan(0);
		// Rotation is on screen: rotating a square 90° about its centre maps it onto itself (pixel space).
		h.ok([{ type: 'mask.add', clipId, shape: 'polygon', ref: '$sq' }]);
		const sq = masksOf(h, clipId)[1]!;
		h.ok([{ type: 'mask.editPath', maskId: sq.id, ops: [{ op: 'transform', rotation: 90 }] }]);
		const after = masksOf(h, clipId)[1]!.path.value.vertices.map((v) => v.p);
		const before = sq.path.value.vertices.map((v) => v.p);
		expect(after[0]![0]).toBeCloseTo(before[1]![0], 9);
		expect(after[0]![1]).toBeCloseTo(before[1]![1], 9);
		// Variable feather points.
		h.ok([
			{
				type: 'mask.editPath',
				maskId: sq.id,
				ops: [{ op: 'addFeatherPoint', point: { segment: 0, t: 0.5, radius: 20, tension: 0 } }],
			},
			{ type: 'mask.editPath', maskId: sq.id, ops: [{ op: 'setFeatherPoint', index: 0, radius: -10 }] },
		]);
		expect(masksOf(h, clipId)[1]!.path.value.feather).toEqual([
			{ segment: 0, t: 0.5, radius: -10, tension: 0 },
		]);
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
	});

	it('setPathKeys writes tracking keys in one step and replaces a span', () => {
		const { h, clipId } = setup();
		h.ok([{ type: 'mask.add', clipId, shape: 'ellipse' }]);
		const mk = masksOf(h, clipId)[0]!;
		const base = mk.path.value;
		const shifted = (dx: number): BezierPath => ({
			...base,
			vertices: base.vertices.map((v) => ({ ...v, p: [v.p[0] + dx, v.p[1]] })),
		});
		h.ok([
			{
				type: 'mask.setPathKeys',
				maskId: mk.id,
				keys: Array.from({ length: 10 }, (_, i) => ({ at: { frames: i }, path: shifted(i * 0.01) })),
			},
		]);
		let m = masksOf(h, clipId)[0]!;
		expect(m.path.keyframes).toHaveLength(10);
		expect(evaluate(m.path, 4.5 * F).vertices[0]!.p[0]).toBeCloseTo(base.vertices[0]!.p[0] + 0.045, 9);
		h.ok([
			{
				type: 'mask.setPathKeys',
				maskId: mk.id,
				clearSpan: true,
				keys: [
					{ at: { frames: 2 }, path: shifted(0) },
					{ at: { frames: 6 }, path: shifted(0) },
				],
			},
		]);
		m = masksOf(h, clipId)[0]!;
		expect(m.path.keyframes.map((k) => Math.round(k.time / F))).toEqual([0, 1, 2, 6, 7, 8, 9]);
	});

	it('split and duplicate give masks fresh ids; the snapshot carries them; locked tracks refuse edits', () => {
		const { h, clipId, fxId } = setup();
		h.ok([
			{ type: 'mask.add', clipId, shape: 'ellipse' },
			{ type: 'mask.add', effectId: fxId, shape: 'polygon' },
		]);
		h.ok([{ type: 'clip.split', clipIds: [clipId], at: 30 }]);
		const [left, right] = h.clips('V1');
		expect(masksOf(h, right!.id)[0]!.id).not.toBe(masksOf(h, left!.id)[0]!.id);
		expect(fxMasksOf(h, right!.id)[0]!.id).not.toBe(fxMasksOf(h, left!.id)[0]!.id);
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		const vc = snap.videoTracks[0]!.clips[0]!;
		expect(vc.masks).toHaveLength(1);
		expect(vc.effects[0]!.masks).toHaveLength(1);
		const track = h.seq.videoTracks[0]!.id;
		h.ok([{ type: 'track.update', trackId: track, patch: { locked: true } }]);
		const r = h.tx([{ type: 'mask.update', maskId: masksOf(h, left!.id)[0]!.id, inverted: true }]);
		expect(r.ok).toBe(false);
	});

	it('invariants flag broken masks and repair removes them', () => {
		const { h, clipId } = setup();
		h.ok([{ type: 'mask.add', clipId, shape: 'polygon' }]);
		const doc = JSON.parse(JSON.stringify(h.doc));
		const seq = Object.values(doc.sequences)[0] as { clips: Record<string, { masks: Mask[] }> };
		seq.clips[clipId]!.masks[0]!.path.value = { closed: true, vertices: [] } as never;
		seq.clips[clipId]!.masks[0]!.opacity.value = 300;
		const issues = checkInvariants(doc, { effects: defaultEffectRegistry });
		expect(issues.some((i) => i.message.includes('Mask'))).toBe(true);
		const { document, report } = repairDocument(doc, createCounterIdSource(900));
		expect(report.some((r) => r.action === 'drop-mask')).toBe(true);
		expect(checkInvariants(document, { effects: defaultEffectRegistry })).toEqual([]);
	});
});
