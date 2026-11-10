// Undo history of headless agent transactions (S01:UND-008, AGT-020): what `history.undo` / `history.redo` step
// through when no editor session has the project open. Like the editor's History (ARCHITECTURE D-05) it holds document
// snapshots, here per project and only in this engine process's memory: an engine restart forgets it, and so does any
// change the engine did not make headlessly (an editor session, another writer, a version restore), because the stacks
// are valid only while the stored project is still at the revision they recorded.
//
// Memory: the stacks also keep the document the project is at (`current`), and the next headless transaction applies
// on that object instead of a fresh load (`document`), so consecutive snapshots share structure (Immer) the way the
// editor's do; an entry costs what its transaction changed. The bounds below cap the number of entries and of
// projects whose current document is kept.

import type { Origin, ProjectDocument } from '@jasper/project';

export type HeadlessEntry = {
	/** The History label (`Agent: …` for agent transactions). */
	label: string;
	origin: Origin;
	before: ProjectDocument;
	after: ProjectDocument;
};

type Stacks = { revision: number; current: ProjectDocument; undo: HeadlessEntry[]; redo: HeadlessEntry[] };

/** Entries kept per project. */
const DEPTH = 16;
/**
 * Entries kept across all projects: past it, the least recently edited project loses its oldest entries first (and
 * is forgotten when it has none left).
 */
const TOTAL = 32;
/** Projects with a history (each keeps its current document); the least recently edited is forgotten first. */
const MAX_PROJECTS = 8;

export class HeadlessHistory {
	/** In order of the last headless edit, least recent first. */
	private readonly projects = new Map<string, Stacks>();

	/**
	 * The document the project is at when its stored revision is still `revision` (the one the last headless commit,
	 * undo or redo saved), so a transaction can apply on it instead of on a fresh load; null otherwise.
	 */
	document(projectId: string, revision: number): ProjectDocument | null {
		const s = this.projects.get(projectId);
		return s && s.revision === revision ? s.current : null;
	}

	/**
	 * A headless commit over `baseRevision` saved as `revision`. Clears the redo stack; when the project was changed
	 * by anyone else since the last recorded step, nothing older can be undone any more and is dropped.
	 */
	record(projectId: string, baseRevision: number, revision: number, entry: HeadlessEntry): void {
		const prev = this.projects.get(projectId);
		const undo = prev && prev.revision === baseRevision ? prev.undo : [];
		undo.push(entry);
		if (undo.length > DEPTH) undo.shift();
		this.projects.delete(projectId);
		this.projects.set(projectId, { revision, current: entry.after, undo, redo: [] });
		for (const id of this.projects.keys()) {
			if (this.projects.size <= MAX_PROJECTS) break;
			this.projects.delete(id);
		}
		let total = 0;
		for (const s of this.projects.values()) total += s.undo.length + s.redo.length;
		for (const [id, s] of this.projects) {
			while (total > TOTAL && (s.undo.length || s.redo.length)) {
				// the oldest step: the bottom of the undo stack, else the farthest redo
				if (s.undo.length) s.undo.shift();
				else s.redo.shift();
				total--;
			}
			if (!s.undo.length && !s.redo.length) this.projects.delete(id);
			if (total <= TOTAL) break;
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
		s.current = kind === 'undo' ? entry.before : entry.after;
	}

	/** The project changed since the stacks were recorded: none of their entries can be applied any more. */
	drop(projectId: string): void {
		this.projects.delete(projectId);
	}
}
