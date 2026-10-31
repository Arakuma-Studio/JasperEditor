// Spec 18 AF-BRF-001 / AF-BRF-002: `sequence.setBrief` merges fields into the sequence's brief (null clears it) and
// `project.addAgentNote` / `project.removeAgentNote` edit the project's agent notes. Each is one undo step; stored values
// are always canonical (`canonicalBrief`, no null fields) and pass INV-BRIEF / INV-AGENT-NOTES.
// docs/wp-notes/agent-footage-brief.md.
import {
	AGENT_NOTE_LIMITS,
	type AgentNote,
	agentNotesIssue,
	canonicalBrief,
	type ProjectAgentNotes,
	readAgentNotes,
	readSequenceBrief,
	type SequenceBrief,
	sequenceBriefIssue,
} from '../../brief/model.ts';
import { latest } from '../draft-read.ts';
import { clone, type HandlerMap } from './util.ts';

export const BRIEF_OWNER = 'agent-brief';

export const briefHandlers = {
	'sequence.setBrief': (doc, cmd, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const r = seq as unknown as { brief?: SequenceBrief };
		if (cmd.brief === null) {
			delete r.brief;
			return { sequenceId: seq.id, brief: null };
		}
		const cur = readSequenceBrief(latest(seq) as { brief?: unknown }) ?? { text: '' };
		const merged: SequenceBrief = { ...clone(cur) };
		for (const k of ['text', 'platform', 'targetDurationSec', 'aspect'] as const)
			if (cmd.brief[k] !== undefined) (merged as Record<string, unknown>)[k] = cmd.brief[k];
		const next = canonicalBrief(merged);
		if (next) {
			const bad = sequenceBriefIssue(next);
			if (bad) h.fail('E_INVALID_PARAM', `Brief: ${bad}`);
			r.brief = next;
		} else delete r.brief;
		return { sequenceId: seq.id, brief: next };
	},
	'project.addAgentNote': (doc, cmd, h) => {
		const d = doc as { agentNotes?: ProjectAgentNotes };
		const stored = latest(d.agentNotes) as unknown;
		if (stored !== undefined && agentNotesIssue(stored))
			h.fail('E_INVALID_PARAM', 'The project agent notes are unreadable: reopen the project to repair them');
		const entries = readAgentNotes({ agentNotes: stored });
		if (entries.length >= AGENT_NOTE_LIMITS.maxEntries)
			h.fail(
				'E_LIMIT',
				`A project keeps at most ${AGENT_NOTE_LIMITS.maxEntries} agent notes: ask the user to remove some (Sequence ▸ Brief…)`,
			);
		const origin = h.agentAuthor();
		const author = (typeof origin === 'object' ? origin.agent : (cmd.author ?? 'user'))
			.trim()
			.slice(0, AGENT_NOTE_LIMITS.maxAuthor);
		const note: AgentNote = {
			id: h.ids.next('agn'),
			at: h.ctx.now(),
			author: author || 'agent',
			text: cmd.text,
		};
		if (!d.agentNotes) d.agentNotes = { entries: [] };
		d.agentNotes.entries.push(note);
		const bad = agentNotesIssue(latest(d.agentNotes));
		if (bad) h.fail('E_INVALID_PARAM', `Agent note: ${bad}`);
		return { noteId: note.id, at: note.at, author: note.author };
	},
	'project.removeAgentNote': (doc, cmd, h) => {
		const d = doc as { agentNotes?: ProjectAgentNotes };
		const list = d.agentNotes?.entries;
		const i = list ? (latest(list) as AgentNote[]).findIndex((n) => n?.id === cmd.noteId) : -1;
		if (!list || i < 0) return h.fail('E_NOT_FOUND', `The project has no agent note ${cmd.noteId}`);
		list.splice(i, 1);
		if (list.length === 0) delete d.agentNotes;
		return { noteId: cmd.noteId };
	},
} satisfies HandlerMap;
