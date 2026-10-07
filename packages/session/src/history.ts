// Snapshot history (S01 §17, ARCHITECTURE §6): labeled, origin-aware, coalescing, linear.
import type { Origin, ProjectDocument } from '@jasper/project';
import type { HistoryEntryView, HistoryState, Selection } from './types.ts';

export type HistoryEntry = HistoryEntryView & {
	before: ProjectDocument;
	after: ProjectDocument;
	selectionBefore: Selection;
	selectionAfter: Selection;
	coalesceKey?: string;
};

export const DEFAULT_HISTORY_CAPACITY = 200;
export const COALESCE_WINDOW_MS = 750;

export function agentLabel(label: string, origin: Origin): string {
	return typeof origin === 'object' && !label.startsWith('Agent: ') ? `Agent: ${label}` : label;
}

export class History {
	private entries: HistoryEntry[] = [];
	/** Number of applied entries (entries[index - 1] is the top of the undo stack). */
	private index = 0;
	private nextId = 1;

	constructor(private capacity = DEFAULT_HISTORY_CAPACITY) {
		this.capacity = Math.min(1000, Math.max(32, capacity));
	}

	/** Records a commit; discards the redo stack (S01:UND-005); coalesces when allowed (UND-006). */
	push(e: Omit<HistoryEntry, 'id'>, now: number, windowMs = COALESCE_WINDOW_MS): HistoryEntry {
		this.entries.length = this.index;
		const top = this.entries[this.index - 1];
		if (
			top &&
			e.coalesceKey !== undefined &&
			top.coalesceKey === e.coalesceKey &&
			top.origin === 'user' &&
			e.origin === 'user' &&
			top.label === e.label &&
			now - top.time <= windowMs
		) {
			top.after = e.after;
			top.revisionAfter = e.revisionAfter;
			top.selectionAfter = e.selectionAfter;
			top.time = now;
			top.created = [...new Set([...top.created, ...e.created])];
			top.changed = [...new Set([...top.changed, ...e.changed])];
			top.deleted = [...new Set([...top.deleted, ...e.deleted])];
			return top;
		}
		const entry: HistoryEntry = { ...e, id: this.nextId++, time: now };
		this.entries.push(entry);
		this.index = this.entries.length;
		while (this.entries.length > this.capacity) {
			this.entries.shift();
			this.index--;
		}
		return entry;
	}

	peekUndo(): HistoryEntry | undefined {
		return this.entries[this.index - 1];
	}
	peekRedo(): HistoryEntry | undefined {
		return this.entries[this.index];
	}
	undo(): HistoryEntry | undefined {
		const e = this.peekUndo();
		if (e) this.index--;
		return e;
	}
	redo(): HistoryEntry | undefined {
		const e = this.peekRedo();
		if (e) this.index++;
		return e;
	}
	clear(): void {
		this.entries = [];
		this.index = 0;
	}
	get position(): number {
		return this.index;
	}
	view(): HistoryState {
		return {
			entries: this.entries.map(
				({ id, label, origin, time, revisionBefore, revisionAfter, created, changed, deleted }) => ({
					id,
					label,
					origin,
					time,
					revisionBefore,
					revisionAfter,
					created,
					changed,
					deleted,
				}),
			),
			index: this.index,
			canUndo: this.index > 0,
			canRedo: this.index < this.entries.length,
		};
	}
}
