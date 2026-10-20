// shape.addTrimTracer is one undoable History step: undo removes the follower, the track it added and the
// expressions it wrote (or restores a driven clip's previous expression); redo brings them back.
import {
	checkInvariants,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	type ShapeClip,
	type VectorShapeData,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EditorSession, MemoryProjectStore } from '../src/index.ts';

async function setup() {
	const ids = createCounterIdSource(1);
	const now = () => '2026-10-20T10:00:00.000Z';
	const store = new MemoryProjectStore({ ids, now });
	const doc = createEmptyProject({ ids, name: 'Tracer', preset: 'hd-1080p-30' });
	store.put(doc);
	const s = await EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now, registries: defaultRegistries() },
		sessionId: 's1',
	});
	return s;
}

const seqOf = (d: ProjectDocument) => Object.values(d.sequences)[0]!;

describe('shape.addTrimTracer undo / redo', () => {
	it('undoes and redoes the follower, its new track and its expressions as one step', async () => {
		const s = await setup();
		const r = s.apply({
			label: 'Shape',
			origin: 'user',
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V2', color: [0, 0, 0, 1] },
				{
					type: 'clip.addShape',
					at: 0,
					duration: 60,
					track: 'V1',
					shape: {
						type: 'vector',
						contents: [{ type: 'path', path: 'M0 0 L100 0' }, { type: 'trim', name: 'T' }, { type: 'stroke' }],
					},
					ref: '$s',
				},
			],
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		const shapeId = r.refs.$s!;
		const before = s.getCommitted();
		const trimId = ((seqOf(before).clips[shapeId] as ShapeClip).shape as VectorShapeData).contents[1]!.id;
		const t = s.apply({
			label: 'Add Trim Tracer',
			origin: 'user',
			commands: [{ type: 'shape.addTrimTracer', clipId: shapeId, trimItemId: trimId, orient: true }],
		});
		if (!t.ok) throw new Error(JSON.stringify(t.errors));
		const after = s.getCommitted();
		const follower = (t.results[0] as { clipId: string }).clipId;
		// V2 was busy: a new track was inserted above V1
		expect(seqOf(after).videoTracks).toHaveLength(seqOf(before).videoTracks.length + 1);
		expect(seqOf(after).clips[follower]).toBeDefined();
		expect(checkInvariants(after)).toEqual([]);
		expect(s.undo().ok).toBe(true);
		expect(s.getCommitted()).toBe(before);
		expect(seqOf(s.getCommitted()).clips[follower]).toBeUndefined();
		expect(s.redo().ok).toBe(true);
		expect(s.getCommitted()).toBe(after);

		// driving an existing clip: undo restores its previous expression
		const prev = s.apply({
			label: 'Expr',
			origin: 'user',
			commands: [{ type: 'expression.set', target: ['clip', follower, 'transform', 'position'], text: '[1, 2]' }],
		});
		expect(prev.ok).toBe(true);
		const withExpr = s.getCommitted();
		const again = s.apply({
			label: 'Retrace',
			origin: 'user',
			commands: [{ type: 'shape.addTrimTracer', clipId: shapeId, trimItemId: trimId, follower: { clipId: follower } }],
		});
		expect(again.ok && again.warnings.map((w) => w.code)).toEqual(['W_EXPRESSION_REPLACED']);
		expect(s.undo().ok).toBe(true);
		expect(s.getCommitted()).toBe(withExpr);
		const pos = (seqOf(withExpr).clips[follower] as ShapeClip).transform.position;
		expect(pos.expression?.text).toBe('[1, 2]');
	});
});
