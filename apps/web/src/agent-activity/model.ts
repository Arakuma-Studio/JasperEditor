// Agent activity log model (spec 18 AF-ACT-001/003): outcomes and filters of the bridge's activity entries, and which
// agent History entries may be undone from the Agent Activity panel or a burst toast. The rule both share: Undo only
// ever steps back through the agent's own entries at the top of the undo stack. An edit made after them — the user's,
// or another agent's — or a user edit between them refuses the Undo (the History panel can still go back), so the
// user's own work is never undone by an agent-activity Undo.
import type { EditorSession, HistoryState } from '@jasper/session';
import type { ActivityEntry } from '../agent-bridge/bridge.ts';
import { t } from '../i18n/runtime.ts';

export type ActivityOutcome = 'applied' | 'failed' | 'denied' | 'dryRun';
export const ACTIVITY_OUTCOMES: readonly ActivityOutcome[] = ['applied', 'failed', 'denied', 'dryRun'];

/** Refusals the user decided (or let time out): not the agent's errors. */
const DENIAL_CODES = new Set(['E_APPROVAL_DENIED', 'E_APPROVAL_TIMEOUT']);

export function activityOutcome(e: Pick<ActivityEntry, 'ok' | 'dryRun' | 'errors'>): ActivityOutcome {
	if (e.dryRun) return 'dryRun';
	if (e.ok) return 'applied';
	return e.errors.some((x) => DENIAL_CODES.has(x.code)) ? 'denied' : 'failed';
}

export function outcomeLabel(o: ActivityOutcome): string {
	switch (o) {
		case 'applied':
			return t('Applied');
		case 'failed':
			return t('Failed');
		case 'denied':
			return t('Denied');
		case 'dryRun':
			return t('Dry run');
	}
}

export type ActivityFilter = { agent: string | null; outcome: ActivityOutcome | null };

export function filterActivity(list: readonly ActivityEntry[], f: ActivityFilter): ActivityEntry[] {
	return list.filter(
		(e) =>
			(f.agent === null || e.agent === f.agent) && (f.outcome === null || activityOutcome(e) === f.outcome),
	);
}

/** The agents of the log, once each, in name order. */
export function activityAgents(list: readonly Pick<ActivityEntry, 'agent'>[]): string[] {
	return [...new Set(list.map((e) => e.agent))].sort((a, b) => a.localeCompare(b));
}

export type UndoRefusal =
	/** Nothing of an agent's to undo (failed, dry run, history step, changed nothing). */
	| 'not-undoable'
	/** Already undone (in the redo part of the stack). */
	| 'undone'
	/** No longer in History (cleared, or dropped at the history capacity). */
	| 'gone'
	/** A newer edit — the user's or another agent's — is on top of it. */
	| 'newer-edits'
	/** A user edit sits between the agent's edits. */
	| 'interleaved'
	/** The project is read-only or a drag is in progress. */
	| 'busy'
	/** Undo itself failed (`UndoOutcome.message`). */
	| 'error';

export type UndoPlan = { ok: true; count: number } | { ok: false; reason: UndoRefusal };

/**
 * How many entries to undo to take back the agent History entries `historyIds` (a burst, or one activity row): the
 * contiguous run of them at the top of the applied stack, and only when none of them is buried under another edit.
 */
export function planAgentUndo(
	historyIds: readonly number[],
	history: Pick<HistoryState, 'entries' | 'index'>,
): UndoPlan {
	const index = Math.max(0, Math.min(history.entries.length, Math.trunc(history.index) || 0));
	const wanted = new Set(historyIds);
	const mine = new Set<number>();
	let foreign = false;
	for (const e of history.entries) {
		if (!wanted.has(e.id)) continue;
		if (typeof e.origin === 'object') mine.add(e.id);
		else foreign = true;
	}
	if (mine.size === 0) return { ok: false, reason: foreign || wanted.size === 0 ? 'not-undoable' : 'gone' };
	let count = 0;
	while (count < index && mine.has(history.entries[index - 1 - count]!.id)) count++;
	let buried = false;
	for (let i = 0; i < index - count; i++) if (mine.has(history.entries[i]!.id)) buried = true;
	if (count === 0) return { ok: false, reason: buried ? 'newer-edits' : 'undone' };
	if (buried) return { ok: false, reason: 'interleaved' };
	return { ok: true, count };
}

/** Undo of one activity row: its entry must be the top of the stack. */
export function entryUndoPlan(
	entry: Pick<ActivityEntry, 'historyEntryId'>,
	history: Pick<HistoryState, 'entries' | 'index'>,
): UndoPlan {
	if (entry.historyEntryId === null) return { ok: false, reason: 'not-undoable' };
	return planAgentUndo([entry.historyEntryId], history);
}

export function undoRefusalText(reason: UndoRefusal): string {
	switch (reason) {
		case 'not-undoable':
			return t('Nothing of the agent’s to undo');
		case 'undone':
			return t('Already undone');
		case 'gone':
			return t('No longer in History');
		case 'newer-edits':
			return t('Newer edits came after it; use the History panel');
		case 'interleaved':
			return t('Your own edits are between the agent’s; use the History panel');
		case 'busy':
			return t('Undo is not available while the project is read-only or a drag is in progress');
		case 'error':
			return t('Undo failed');
	}
}

export type UndoOutcome =
	| { ok: true; undone: number }
	| { ok: false; reason: UndoRefusal; undone: number; message?: string };

/**
 * Runs the plan: undoes the agent's entries one by one, re-checking that each is still the agent's top entry. Never
 * throws (it runs from toast and button handlers): a failure comes back as `error` with its message.
 */
export function undoAgentEdits(session: EditorSession, historyIds: readonly number[]): UndoOutcome {
	let undone = 0;
	try {
		return runUndo(session, historyIds, () => undone++);
	} catch (e) {
		return { ok: false, reason: 'error', undone, message: e instanceof Error ? e.message : String(e) };
	}
}

function runUndo(session: EditorSession, historyIds: readonly number[], counted: () => void): UndoOutcome {
	const st = session.getState();
	if (st.readOnly || st.gesture) return { ok: false, reason: 'busy', undone: 0 };
	const plan = planAgentUndo(historyIds, st.history);
	if (!plan.ok) return { ...plan, undone: 0 };
	const wanted = new Set(historyIds);
	let undone = 0;
	for (; undone < plan.count; undone++) {
		const h = session.getState().history;
		const top = h.entries[h.index - 1];
		if (!top || !wanted.has(top.id) || typeof top.origin !== 'object')
			return { ok: false, reason: 'newer-edits', undone };
		const r = session.undo({ agent: top.origin.agent });
		if (!r.ok) return { ok: false, reason: r.code === 'E_BUSY' ? 'busy' : 'newer-edits', undone };
		counted();
	}
	return { ok: true, undone };
}
