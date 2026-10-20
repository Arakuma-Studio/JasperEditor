// Keyframe assistant (easing) commands are one History entry each: undo restores the exact previous document,
// redo the exact result (docs/wp-notes/easing.md).
import {
	type Animatable,
	type CommandInput,
	copyEase,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	type SolidClip,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EditorSession, MemoryProjectStore } from '../src/index.ts';

async function open() {
	const ids = createCounterIdSource(1);
	const now = () => '2026-10-20T10:00:00.000Z';
	const store = new MemoryProjectStore({ ids, now });
	const doc = createEmptyProject({ ids, name: 'Ease', preset: 'hd-1080p-30' });
	store.put(doc);
	const s = await EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now, registries: defaultRegistries() },
		sessionId: 's1',
	});
	s.apply({
		label: 'Add',
		origin: 'user',
		commands: [{ type: 'clip.addSolid', at: 0, duration: 200, track: 'V1', color: [1, 0, 0, 1] }],
	});
	const clipId = Object.keys(Object.values(s.getCommitted().sequences)[0]!.clips)[0]!;
	const pos = ['clip', clipId, 'transform', 'position'];
	s.apply({
		label: 'Keys',
		origin: 'user',
		commands: [
			{ type: 'param.setAnimated', target: pos, animated: true, at: { sequenceFrame: 0 } },
			...(
				[
					[0, [100, 100]],
					[10, [300, 400]],
					[20, [500, 150]],
					[30, [800, 500]],
				] as const
			).map(([f, value]) => ({
				type: 'param.set' as const,
				target: pos,
				value,
				at: { sequenceFrame: f },
			})),
		],
	});
	const keys = (doc: ProjectDocument) =>
		(Object.values(doc.sequences)[0]!.clips[clipId] as SolidClip).transform.position as Animatable<unknown>;
	return { s, clipId, keys };
}

describe('ease commands in the session history', () => {
	it('each command undoes to the exact previous document and redoes to the exact result', async () => {
		const { s, keys } = await open();
		const ids = keys(s.getCommitted()).keyframes.map((k) => k.id);
		const copied = copyEase(s.getCommitted(), [ids[0]!, ids[1]!]);
		if (!copied.ok) throw new Error(copied.message);
		const commands: unknown[] = [
			{
				type: 'keyframe.applyEase',
				keyframeIds: [ids[0]!, ids[1]!],
				curve: { kind: 'cubic', x1: 0.3, y1: 0, x2: 0.2, y2: 1 },
			},
			{
				type: 'keyframe.applyEase',
				keyframeIds: [ids[0]!, ids[3]!],
				curve: {
					kind: 'multi',
					points: [
						{ x: 0, y: 0 },
						{ x: 0.6, y: 1.1, in: [0.5, 1.1], out: [0.7, 1.1] },
						{ x: 1, y: 1 },
					],
				},
			},
			{ type: 'keyframe.pasteEase', keyframeIds: [ids[1]!, ids[2]!], clip: copied.clip },
			{ type: 'keyframe.pasteValues', keyframeIds: [ids[1]!], values: [[10, 20]] },
			{ type: 'keyframe.setVelocity', keyframeId: ids[1]!, side: 'both', speed: 500, influence: 40 },
			{ type: 'keyframe.createPathController', keyframeIds: [ids[0]!, ids[2]!] },
			{ type: 'keyframes.cleanupPath', keyframeIds: ids, tolerance: 1 },
		];
		for (const cmd of commands) {
			const before = s.getCommitted();
			const snapshot = structuredClone(before);
			const r = s.apply({ label: 'Ease', origin: 'user', commands: [cmd as CommandInput] });
			expect(r.ok, JSON.stringify(r)).toBe(true);
			const after = s.getCommitted();
			const afterSnapshot = structuredClone(after);
			expect(after).not.toBe(before);
			expect(s.undo().ok).toBe(true);
			expect(s.getCommitted()).toBe(before);
			expect(s.getCommitted()).toEqual(snapshot);
			expect(s.redo().ok).toBe(true);
			expect(s.getCommitted()).toEqual(afterSnapshot);
			expect(s.undo().ok).toBe(true);
		}
	});
});
