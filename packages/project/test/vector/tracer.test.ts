// shape.addTrimTracer: the follower it creates or drives, the expressions it writes, its refusals and invariants.
// The tip positions those expressions compute are verified in packages/expressions/test/trim-tracer.test.ts.
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	type Clip,
	type ShapeClip,
	type ShapeItem,
	trimInputPaths,
	type VectorShapeData,
} from '../../src/index.ts';
import { Harness } from '../helpers.ts';

type Tracer = {
	clipId: string;
	created: boolean;
	trackId: string;
	trimItemId: string;
	pathItemId: string | null;
	mode: string;
	tip: string;
	expressions: { position: string; rotation?: string };
};

function setup(trim: Record<string, unknown> = { end: 50 }, extraPaths: unknown[] = []) {
	const h = new Harness();
	const r = h.ok([
		{
			type: 'clip.addShape',
			at: 10,
			duration: 80,
			track: 'V1',
			name: 'Logo',
			shape: {
				type: 'vector',
				contents: [
					{
						type: 'group',
						name: 'G',
						contents: [{ type: 'path', name: 'P', path: 'M0 0 L100 0' }, ...extraPaths, { type: 'stroke' }],
					},
					{ type: 'trim', name: 'T', ...trim },
				],
			},
			ref: '$s',
		},
	]);
	const shapeId = r.refs.$s!;
	const contents = (h.seq.clips[shapeId] as ShapeClip).shape as VectorShapeData;
	const group = contents.contents[0] as Extract<ShapeItem, { type: 'group' }>;
	return { h, shapeId, groupId: group.id, pathId: group.contents[0]!.id, trimId: contents.contents[1]!.id };
}

const tracer = (h: Harness, cmd: Record<string, unknown>) =>
	h.ok([{ type: 'shape.addTrimTracer', ...cmd }]).results[0] as Tracer;
const codeOf = (h: Harness, cmd: Record<string, unknown>) => {
	const r = h.tx([{ type: 'shape.addTrimTracer', ...cmd }]);
	return r.ok ? 'ok' : r.errors[0]!.code;
};
const posExpr = (h: Harness, id: string) =>
	(h.seq.clips[id] as Clip & { transform: { position: { expression?: { text: string } } } }).transform.position
		.expression?.text;

describe('shape.addTrimTracer', () => {
	it('creates a dot clip on the track above over the same span, driven by an id-addressed expression', () => {
		const { h, shapeId, groupId, pathId, trimId } = setup();
		const r = tracer(h, { clipId: shapeId, trimItemId: trimId, ref: '$f' });
		expect(r).toMatchObject({ created: true, trimItemId: trimId, pathItemId: pathId, mode: 'simultaneous', tip: 'end' });
		const f = h.seq.clips[r.clipId]!;
		expect(f.trackId).toBe(h.seq.videoTracks[1]!.id);
		expect([f.start, f.duration, f.name, f.kind]).toEqual([10, 80, 'Tracer', 'shape']);
		const dot = ((f as ShapeClip).shape as VectorShapeData).contents;
		expect(dot.map((i) => i.type)).toEqual(['ellipse', 'stroke', 'fill']);
		const text = posExpr(h, r.clipId)!;
		expect(text).toBe(r.expressions.position);
		expect(text).toContain(`thisComp.layer(${JSON.stringify(shapeId)})`);
		expect(text).toContain(`.content(${JSON.stringify(trimId)})`);
		expect(text).toContain(`trim.trimPath(${JSON.stringify(pathId)})`);
		expect(text).toContain('trim.end / 100');
		expect(text).toContain('if (u > 1) u -= 1;');
		// the trim is top level: no group in its chain; the path's group id is not needed (trimPath finds it).
		expect(text).not.toContain(groupId);
		expect(r.expressions.rotation).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('picks the tip whose keyframes change most (End on a tie), follows Individually trims along every path', () => {
		const a = setup({ end: 100 });
		a.h.ok([
			{ type: 'keyframe.add', target: ['clip', a.shapeId, 'shape', 'items', a.trimId, 'start'], at: { frames: 0 }, value: 0 },
			{ type: 'keyframe.add', target: ['clip', a.shapeId, 'shape', 'items', a.trimId, 'start'], at: { frames: 30 }, value: 100 },
		]);
		const ra = tracer(a.h, { clipId: a.shapeId, trimItemId: a.trimId });
		expect(ra.tip).toBe('start');
		expect(ra.expressions.position).toContain('trim.start / 100');
		expect(ra.expressions.position).toContain('if (u >= 1) u -= 1;');
		const b = setup({ end: 100, mode: 'individual' }, [{ type: 'ellipse', name: 'E', size: [40, 40] }]);
		const rb = tracer(b.h, { clipId: b.shapeId, trimItemId: b.trimId, tip: 'auto', orient: true });
		expect(rb).toMatchObject({ tip: 'end', mode: 'individual', pathItemId: null });
		expect(rb.expressions.position).toContain('trim.trimPath();');
		expect(rb.expressions.rotation).toContain('tangentOnPath(u)');
		expect(
			(b.h.seq.clips[rb.clipId] as Clip & { transform: { rotation: { expression?: { text: string } } } })
				.transform.rotation.expression?.text,
		).toBe(rb.expressions.rotation);
		// the paths it measures, in stacking order
		const contents = ((b.h.seq.clips[b.shapeId] as ShapeClip).shape as VectorShapeData).contents;
		expect(trimInputPaths(contents, b.trimId, 0)!.paths.map((p) => p.itemId)).toHaveLength(2);
	});

	it('inserts a new track when the track above is busy or locked; drives an existing follower and warns on replace', () => {
		const { h, shapeId, trimId } = setup();
		h.ok([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [0, 0, 1, 1], ref: '$busy' }]);
		const v2 = h.seq.videoTracks[1]!.id;
		const r = tracer(h, { clipId: shapeId, trimItemId: trimId, name: 'Spark' });
		expect(h.seq.videoTracks.map((t) => t.id).indexOf(r.trackId)).toBe(1);
		expect(h.seq.videoTracks[2]!.id).toBe(v2);
		expect(h.seq.clips[r.clipId]!.name).toBe('Spark');

		const solid = h.ok([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V4', color: [1, 0, 0, 1], ref: '$x' },
			{ type: 'expression.set', target: ['clip', '$x', 'transform', 'position'], text: '[0, 0]' },
		]).refs.$x!;
		const res = h.ok([{ type: 'shape.addTrimTracer', clipId: shapeId, trimItemId: trimId, follower: { clipId: solid } }]);
		expect((res.results[0] as Tracer).created).toBe(false);
		expect(res.warnings.map((w) => w.code)).toContain('W_EXPRESSION_REPLACED');
		expect(posExpr(h, solid)).toContain('pointOnPath(u)');
		expect(checkInvariants(h.doc)).toEqual([]);

		const l = setup();
		l.h.ok([{ type: 'track.update', trackId: 'V2', patch: { locked: true } }]);
		const rl = tracer(l.h, { clipId: l.shapeId, trimItemId: l.trimId });
		expect(l.h.seq.videoTracks[1]!.id).toBe(rl.trackId);
		expect(l.h.seq.videoTracks[2]!.locked).toBe(true);
	});

	it('refuses unknown items, non-trims, non-vector clips, foreign or locked followers and self-following', () => {
		const { h, shapeId, groupId, trimId } = setup();
		expect(codeOf(h, { clipId: shapeId, trimItemId: 'shp_missing' })).toBe('E_NOT_FOUND');
		expect(codeOf(h, { clipId: shapeId, trimItemId: groupId })).toBe('E_INVALID_PARAM');
		expect(codeOf(h, { clipId: shapeId, trimItemId: trimId, pathItemId: 'shp_missing' })).toBe('E_NOT_FOUND');
		const items = ((h.seq.clips[shapeId] as ShapeClip).shape as VectorShapeData).contents;
		const stroke = (items[0] as Extract<ShapeItem, { type: 'group' }>).contents[1]!.id;
		expect(codeOf(h, { clipId: shapeId, trimItemId: trimId, pathItemId: stroke })).toBe('E_INVALID_PARAM');
		expect(codeOf(h, { clipId: 'clp_missing', trimItemId: trimId })).toBe('E_NOT_FOUND');
		expect(codeOf(h, { clipId: shapeId, trimItemId: trimId, follower: { clipId: shapeId } })).toBe('E_CYCLE');
		const rect = h.ok([
			{ type: 'clip.addShape', at: 0, track: 'V3', shape: { type: 'rect', size: [10, 10] }, ref: '$r' },
		]).refs.$r!;
		expect(codeOf(h, { clipId: rect, trimItemId: trimId })).toBe('E_INVALID_PARAM');
		const locked = h.ok([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V4', color: [1, 0, 0, 1], ref: '$l' },
			{ type: 'track.update', trackId: 'V4', patch: { locked: true } },
		]).refs.$l!;
		expect(codeOf(h, { clipId: shapeId, trimItemId: trimId, follower: { clipId: locked } })).toBe('E_TRACK_LOCKED');
		const other = h.ok([{ type: 'sequence.create', name: 'Other', ref: '$seq' }]).refs.$seq!;
		const foreign = h.ok([
			{ type: 'clip.addSolid', sequenceId: other, at: 0, duration: 30, track: 'V1', color: [0, 1, 0, 1], ref: '$o' },
		]).refs.$o!;
		expect(codeOf(h, { clipId: shapeId, trimItemId: trimId, follower: { clipId: foreign } })).toBe('E_INVALID_PARAM');
		// nothing was created by the refused transactions
		expect(Object.values(h.seq.clips).filter((c) => c.name === 'Tracer')).toEqual([]);
	});

	it('refuses a trim with no path above it and a trim in a disabled group', () => {
		const h = new Harness();
		const id = h.ok([
			{
				type: 'clip.addShape',
				at: 0,
				track: 'V1',
				shape: {
					type: 'vector',
					contents: [
						{ type: 'trim', name: 'Lonely' },
						{ type: 'group', name: 'Off', enabled: false, contents: [{ type: 'path', path: 'M0 0 L9 9' }, { type: 'trim' }] },
					],
				},
				ref: '$s',
			},
		]).refs.$s!;
		const items = ((h.seq.clips[id] as ShapeClip).shape as VectorShapeData).contents;
		const inner = (items[1] as Extract<ShapeItem, { type: 'group' }>).contents[1]!.id;
		expect(codeOf(h, { clipId: id, trimItemId: items[0]!.id })).toBe('E_INVALID_PARAM');
		expect(codeOf(h, { clipId: id, trimItemId: inner })).toBe('E_INVALID_PARAM');
	});
});
