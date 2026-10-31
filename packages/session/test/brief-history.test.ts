// Spec 18 AF-BRF in the session: `sequence.setBrief`, `project.addAgentNote` (an agent transaction, signed with the
// agent's name) and `project.removeAgentNote` are one History entry each (undo restores the exact previous document,
// redo the exact result); a read-only session (a newer-schema file, a held lease) refuses them.
import {
	type CommandInput,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	readAgentNotes,
	readSequenceBrief,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EditorSession } from '../src/index.ts';

const REG = defaultRegistries();

function open(readOnly = false) {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'Brief', preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-10-31T10:00:00.000Z', registries: REG },
		readOnly,
	});
	return { session, seqId: Object.keys(doc.sequences)[0]! };
}

describe('brief and agent notes in the session history (AF-BRF)', () => {
	it('each command is one undo step, exact both ways', () => {
		const { session, seqId } = open();
		const step = (commands: CommandInput[], origin: 'user' | { agent: string } = 'user') => {
			const before = structuredClone(session.getCommitted());
			const depth = session.getState().history.index;
			const r = session.apply({ label: 'Brief', origin, sequenceId: seqId, commands });
			expect(r.ok, JSON.stringify(r)).toBe(true);
			expect(session.getState().history.index).toBe(depth + 1);
			const after = structuredClone(session.getCommitted());
			expect(session.undo().ok).toBe(true);
			expect(session.getCommitted()).toEqual(before);
			expect(session.redo().ok).toBe(true);
			expect(session.getCommitted()).toEqual(after);
			return r;
		};
		step([
			{
				type: 'sequence.setBrief',
				brief: { text: 'A reel', platform: 'instagram-reels', targetDurationSec: 45 },
			},
		]);
		expect(readSequenceBrief(session.getCommitted().sequences[seqId])).toEqual({
			text: 'A reel',
			platform: 'instagram-reels',
			targetDurationSec: 45,
		});
		const r = step([{ type: 'project.addAgentNote', text: 'Take 3 is the best' }], { agent: 'claude-code' });
		const noteId = (r.ok ? r.results[0] : null) as { noteId: string };
		expect(readAgentNotes(session.getCommitted())).toEqual([
			{
				id: noteId.noteId,
				at: '2026-10-31T10:00:00.000Z',
				author: 'claude-code',
				text: 'Take 3 is the best',
			},
		]);
		step([{ type: 'project.removeAgentNote', noteId: noteId.noteId }]);
		expect(session.getCommitted().agentNotes).toBeUndefined();
		step([{ type: 'sequence.setBrief', brief: null }]);
		expect(readSequenceBrief(session.getCommitted().sequences[seqId])).toBeNull();
	});

	it('a read-only session refuses them and keeps the document', () => {
		const { session } = open(true);
		const before = session.getCommitted();
		for (const c of [
			{ type: 'sequence.setBrief', brief: { text: 'x' } },
			{ type: 'project.addAgentNote', text: 'x' },
		] as CommandInput[]) {
			const r = session.apply({ label: 'x', origin: 'user', commands: [c] });
			expect(r).toMatchObject({ ok: false, errors: [{ code: 'E_NOT_OWNER' }] });
		}
		expect(session.getCommitted()).toBe(before);
	});
});
