// Undo history of headless agent transactions (S01:UND-008, AGT-020): what `history.undo` / `history.redo` step
// through when no editor session has the project open. Like the editor's History (ARCHITECTURE D-05) it holds document
// snapshots, here per project and only in this engine process's memory: an engine restart forgets it, and so does any
// change the engine did not make headlessly (an editor session, another writer, a version restore), because the stacks
// are valid only while the stored project is still at the revision they recorded.

import type { Origin, ProjectDocument } from '@jasper/project';

export type HeadlessEntry = {
	/** The History label (`Agent: …` for agent transactions). */
	label: string;
	origin: Origin;
	before: ProjectDocument;
	after: ProjectDocument;
};

type Stacks = { revision: number; undo: HeadlessEntry[]; redo: HeadlessEntry[] };

/** Entries kept per project (each holds up to a whole document). */
const DEPTH = 16;
/** Projects with a history; the least recently edited is forgotten first. */
const MAX_PROJECTS = 8;

export class HeadlessHistory {
	private readonly projects = new Map<string, Stacks>();

	/**
	 * A headless commit over `baseRevision` saved as `revision`. Clears the redo stack; when the project was changed
	 * by anyone else since the last recorded step, nothing older can be undone any more and is dropped.
	 */
	record(projectId: string, baseRevision: number, revision: number, entry: HeadlessEntry): void {
		const prev = this.projects.get(projectId);
		const s: Stacks = prev && prev.revision === baseRevision ? prev : { revision, undo: [], redo: [] };
		s.undo.push(entry);
		if (s.undo.length > DEPTH) s.undo.shift();
		s.redo = [];
		s.revision = revision;
		this.projects.delete(projectId);
		this.projects.set(projectId, s);
		for (const id of this.projects.keys()) {
			if (this.projects.size <= MAX_PROJECTS) break;
			this.projects.delete(id);
		}
	}

	/** The entry the next undo / redo would apply and the revision the stored project must still have, or null. */
	peek(projectId: string, kind: 'undo' | 'redo'): { entry: HeadlessEntry; revision: number } | null {
		const s = this.projects.get(projectId);
		const entry = s?.[kind].at(-1);
		return s && entry ? { entry, revision: s.revision } : null;
	}

	/** The undo / redo peeked at was saved as `revision`: its entry moves to the other stack. */
	stepped(projectId: string, kind: 'undo' | 'redo', revision: number): void {
		const s = this.projects.get(projectId);
		const entry = s?.[kind].pop();
		if (!s || !entry) return;
		s[kind === 'undo' ? 'redo' : 'undo'].push(entry);
		s.revision = revision;
	}

	/** The project changed since the stacks were recorded: none of their entries can be applied any more. */
	drop(projectId: string): void {
		this.projects.delete(projectId);
	}
}
