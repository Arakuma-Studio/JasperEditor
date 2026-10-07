// three-d: 3D edits through the session — each is one undoable step (3D Layer switch, a 3D property, New Camera /
// Light, the 3D renderer, the camera tools); undo restores the exact earlier document and redo reapplies it.
import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EditorSession, MemoryProjectStore } from '../src/index.ts';

async function open() {
	const ids = createCounterIdSource(1);
	const store = new MemoryProjectStore({ ids, now: () => '2026-10-07T10:00:00.000Z' });
	const doc = createEmptyProject({ ids, name: 'S', preset: 'hd-1080p-30' });
	store.put(doc);
	const ctx = { ids, now: () => '2026-10-07T10:00:00.000Z', registries: defaultRegistries() };
	return EditorSession.open({ store, projectId: doc.projectId, ctx, sessionId: 's1' });
}

describe('3D edits are undoable', () => {
	it('every 3D command is one step; undo / redo restore the documents exactly', async () => {
		const s = await open();
		const add = s.apply({
			label: 'Add',
			origin: 'user',
			commands: [{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1] }],
		});
		expect(add.ok).toBe(true);
		const solidId = (add.ok && (add.results[0] as { clipId: string }).clipId) || '';
		const steps: { label: string; commands: unknown[] }[] = [
			{ label: '3D Layer', commands: [{ type: 'clip.set3d', clipIds: [solidId], enabled: true }] },
			{
				label: 'Z Position',
				commands: [{ type: 'param.set', target: ['clip', solidId, 'threeD', 'positionZ'], value: 200 }],
			},
			{ label: 'New Camera', commands: [{ type: 'clip.addCamera', at: 0, preset: '35mm' }] },
			{
				label: 'New Light',
				commands: [{ type: 'clip.addLight', at: 0, lightType: 'spot', castsShadows: true }],
			},
			{ label: '3D Renderer', commands: [{ type: 'sequence.set3dRenderer', renderer: 'advanced' }] },
		];
		const docs = [s.getCommitted()];
		for (const st of steps) {
			const r = s.apply({ label: st.label, origin: 'user', commands: st.commands as never[] });
			expect(r.ok, st.label).toBe(true);
			docs.push(s.getCommitted());
		}
		const camId = Object.values(Object.values(s.getCommitted().sequences)[0]!.clips).find(
			(c) => c.kind === 'camera',
		)!.id;
		const tool = s.apply({
			label: 'Orbit Camera',
			origin: 'user',
			commands: [{ type: 'camera.orbit', clipId: camId, yaw: 20, pitch: 10 }],
		});
		expect(tool.ok).toBe(true);
		docs.push(s.getCommitted());
		expect(
			s
				.getState()
				.history.entries.map((e) => e.label)
				.slice(-7),
		).toEqual(['Add', '3D Layer', 'Z Position', 'New Camera', 'New Light', '3D Renderer', 'Orbit Camera']);
		for (let i = docs.length - 1; i > 0; i--) {
			expect(s.undo().ok).toBe(true);
			expect(s.getCommitted()).toBe(docs[i - 1]);
		}
		for (let i = 1; i < docs.length; i++) {
			expect(s.redo().ok).toBe(true);
			expect(JSON.stringify(s.getCommitted())).toBe(JSON.stringify(docs[i]));
		}
	});
});
