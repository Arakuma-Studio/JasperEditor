// Smooth Slide in the editor history: adding it, editing its params (static and keyframed) and removing it are
// single undoable steps; undo restores the exact previous document and redo reapplies the same edit.
import {
	checkInvariants,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type Transition,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EditorSession } from '../src/session.ts';

function fixture() {
	const ids = createCounterIdSource(1);
	const session = new EditorSession({
		projectId: 'smooth-slide-history',
		document: createEmptyProject({ ids, name: 'Smooth Slide', preset: 'hd-1080p-30' }),
		ctx: { ids, now: () => '2026-10-25T00:00:00.000Z', registries: defaultRegistries() },
	});
	const seed = session.apply({
		label: 'Seed',
		origin: 'user',
		commands: [
			{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1] },
			{ type: 'clip.addSolid', at: 60, duration: 60, track: 'V1', color: [0, 0, 1, 1] },
		],
	});
	expect(seed.ok).toBe(true);
	return session;
}

const transitions = (s: EditorSession) =>
	Object.values(Object.values(s.getCommitted().sequences)[0]!.transitions) as Transition[];

describe('Smooth Slide history', () => {
	it('add, edit and remove are undoable and redoable', () => {
		const s = fixture();
		const empty = structuredClone(s.getCommitted());
		const add = s.apply({
			label: 'Add Smooth Slide',
			origin: 'user',
			commands: [
				{
					type: 'transition.add',
					trackId: 'V1',
					at: 60,
					effectId: 'jasper.smooth-slide',
					duration: 15,
					params: { direction: 'up', dolly: 0.5 },
				},
			],
		});
		expect(add.ok).toBe(true);
		const added = structuredClone(s.getCommitted());
		const t = transitions(s)[0]!;
		expect(t.effectId).toBe('jasper.smooth-slide');

		const edit = s.apply({
			label: 'Edit Smooth Slide',
			origin: 'user',
			commands: [
				{ type: 'param.set', target: ['transition', t.id, 'motionBlur'], value: 'low' },
				{ type: 'param.set', target: ['transition', t.id, 'reflection'], value: true },
				{ type: 'keyframe.add', target: ['transition', t.id, 'dolly'], at: { sequenceFrame: 53 }, value: 0 },
				{ type: 'keyframe.add', target: ['transition', t.id, 'dolly'], at: { sequenceFrame: 60 }, value: 1 },
			],
		});
		expect(edit.ok).toBe(true);
		const edited = structuredClone(s.getCommitted());
		expect(transitions(s)[0]!.params.motionBlur!.value).toBe('low');
		expect(transitions(s)[0]!.params.dolly!.keyframes).toHaveLength(2);
		expect(checkInvariants(s.getCommitted())).toEqual([]);

		const remove = s.apply({
			label: 'Remove Smooth Slide',
			origin: 'user',
			commands: [{ type: 'transition.remove', transitionIds: [t.id] }],
		});
		expect(remove.ok).toBe(true);
		expect(transitions(s)).toEqual([]);

		expect(s.undo().ok).toBe(true);
		expect(s.getCommitted().sequences).toEqual(edited.sequences);
		expect(s.undo().ok).toBe(true);
		expect(s.getCommitted().sequences).toEqual(added.sequences);
		expect(s.undo().ok).toBe(true);
		expect(s.getCommitted().sequences).toEqual(empty.sequences);
		expect(s.redo().ok).toBe(true);
		expect(s.getCommitted().sequences).toEqual(added.sequences);
		expect(s.redo().ok).toBe(true);
		expect(s.getCommitted().sequences).toEqual(edited.sequences);
		expect(s.redo().ok).toBe(true);
		expect(transitions(s)).toEqual([]);
		expect(checkInvariants(s.getCommitted())).toEqual([]);
	});

	it('a refused edit (unknown option) leaves the document and the history untouched', () => {
		const s = fixture();
		expect(
			s.apply({
				label: 'Add',
				origin: 'user',
				commands: [
					{ type: 'transition.add', trackId: 'V1', at: 60, effectId: 'jasper.smooth-slide', duration: 10 },
				],
			}).ok,
		).toBe(true);
		const before = structuredClone(s.getCommitted());
		const t = transitions(s)[0]!;
		const bad = s.apply({
			label: 'Bad',
			origin: 'user',
			commands: [{ type: 'param.set', target: ['transition', t.id, 'animation'], value: 'bounce' }],
		});
		expect(bad.ok).toBe(false);
		expect(s.getCommitted().sequences).toEqual(before.sequences);
		expect(s.undo().ok).toBe(true);
		expect(transitions(s)).toEqual([]);
	});
});
