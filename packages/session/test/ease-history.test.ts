// Keyframe assistant (easing) commands are one History entry each: undo restores the exact previous document,
// redo the exact result (docs/wp-notes/easing.md).
import {
	type Animatable,
	builtinEasePresets,
	type CommandInput,
	copyEase,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	evaluate,
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

	it('a Penner in-out preset sets the handles of the two keys, so moving a key rescales the ease in time', async () => {
		const { s, clipId } = await open();
		const rotation = ['clip', clipId, 'transform', 'rotation'];
		s.apply({
			label: 'Rotation keys',
			origin: 'user',
			commands: [
				{ type: 'param.setAnimated', target: rotation, animated: true, at: { sequenceFrame: 0 } },
				{ type: 'param.set', target: rotation, value: 0, at: { sequenceFrame: 0 } },
				{ type: 'param.set', target: rotation, value: 90, at: { sequenceFrame: 30 } },
			],
		});
		const anim = (doc: ProjectDocument) =>
			(Object.values(doc.sequences)[0]!.clips[clipId] as SolidClip).transform.rotation as Animatable<number>;
		const ids = anim(s.getCommitted()).keyframes.map((k) => k.id);
		// The curve apply_ease and the Easing panel send for "Cubic In-Out".
		const preset = builtinEasePresets().find((p) => p.id === 'penner.cubic-in-out')!;
		const applied = s.apply({
			label: 'Ease',
			origin: 'user',
			commands: [{ type: 'keyframe.applyEase', keyframeIds: ids, curve: preset.curve } as CommandInput],
		});
		expect(applied.ok, JSON.stringify(applied)).toBe(true);
		const eased = s.getCommitted();
		const keys = anim(eased).keyframes;
		expect(keys.map((k) => k.id)).toEqual(ids);
		expect([keys[0]!.interpolation, keys[1]!.inInterpolation]).toEqual(['bezier', 'bezier']);

		// Penner's easeInOutCubic; the shared evaluator (preview and every export path sample it) stays within 1 % of
		// the 90° change over the key span, before and after the second key moves 30 frames later.
		const penner = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
		const worstError = (a: Animatable<number>) => {
			const [t0, t1] = [a.keyframes[0]!.time, a.keyframes[1]!.time];
			let worst = 0;
			for (let i = 0; i <= 200; i++)
				worst = Math.max(worst, Math.abs(evaluate(a, t0 + ((t1 - t0) * i) / 200) - 90 * penner(i / 200)));
			return worst;
		};
		expect(worstError(anim(eased))).toBeLessThanOrEqual(0.9);
		const span = keys[1]!.time - keys[0]!.time;
		const moved = s.apply({
			label: 'Move',
			origin: 'user',
			commands: [{ type: 'keyframe.move', keyframeIds: [ids[1]!], delta: { frames: 30 } }],
		});
		expect(moved.ok, JSON.stringify(moved)).toBe(true);
		const after = anim(s.getCommitted());
		expect(after.keyframes[1]!.time - after.keyframes[0]!.time).toBe(2 * span);
		expect(worstError(after)).toBeLessThanOrEqual(0.9);

		expect(s.undo().ok).toBe(true);
		expect(s.getCommitted()).toBe(eased);
		expect(s.undo().ok).toBe(true);
		expect(anim(s.getCommitted()).keyframes.map((k) => k.interpolation)).toEqual(['linear', 'linear']);
		expect(s.redo().ok).toBe(true);
		expect(s.getCommitted()).toEqual(eased);
	});
});
