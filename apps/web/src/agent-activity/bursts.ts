// Burst grouping of agent transactions for the activity toast (spec 18 AF-ACT-003): transactions an external agent
// applies less than BURST_WINDOW_MS apart collapse into one toast, "Agent: N edits", whose Undo takes back exactly
// that burst (`undoAgentEdits` on its History entries). A burst only grows while its History entries stay contiguous
// on the undo stack: a user edit (or an undo) between two agent transactions starts a new burst, so a burst's Undo
// never has to step over the user's own work.
import type { HistoryState } from '@jasper/session';
import type { ActivityEntry } from '../agent-bridge/bridge.ts';
import { t } from '../i18n/runtime.ts';

/** Gap between two agent transactions that still counts as one burst. */
export const BURST_WINDOW_MS = 2000;
/** Bounds the ids a burst keeps (an agent applying every second forever is one burst). */
export const MAX_BURST_ENTRIES = 1000;

export type AgentBurst = {
	id: number;
	/** Transactions in the burst. */
	count: number;
	/** Items created, changed or deleted, summed over the transactions. */
	items: number;
	/** The agents, in order of their first transaction. */
	agents: string[];
	/** Label of the first transaction (the toast of a burst of one shows it). */
	label: string;
	/** The burst's History entries (what its Undo takes back), oldest first. */
	historyIds: number[];
	firstTime: number;
	lastTime: number;
};

export class AgentBurstTracker {
	private current: AgentBurst | null = null;
	private seq = 0;

	/** Adds an applied agent transaction; returns the (new snapshot of the) burst it belongs to. */
	add(entry: ActivityEntry, history: Pick<HistoryState, 'entries'>): AgentBurst {
		const items = entry.created.length + entry.changed.length + entry.deleted.length;
		const cur = this.current;
		if (cur && this.joins(cur, entry, history)) {
			const next: AgentBurst = {
				...cur,
				count: cur.count + 1,
				items: cur.items + items,
				agents: cur.agents.includes(entry.agent) ? cur.agents : [...cur.agents, entry.agent],
				historyIds:
					entry.historyEntryId === null ? cur.historyIds : [...cur.historyIds, entry.historyEntryId],
				lastTime: entry.time,
			};
			this.current = next;
			return next;
		}
		const burst: AgentBurst = {
			id: ++this.seq,
			count: 1,
			items,
			agents: [entry.agent],
			label: entry.label,
			historyIds: entry.historyEntryId === null ? [] : [entry.historyEntryId],
			firstTime: entry.time,
			lastTime: entry.time,
		};
		this.current = burst;
		return burst;
	}

	private joins(cur: AgentBurst, entry: ActivityEntry, history: Pick<HistoryState, 'entries'>): boolean {
		if (cur.count >= MAX_BURST_ENTRIES) return false;
		const gap = entry.time - cur.lastTime;
		if (!Number.isFinite(gap) || gap > BURST_WINDOW_MS) return false;
		const last = cur.historyIds.at(-1);
		if (entry.historyEntryId === null || last === undefined) return true;
		// the entry right below this transaction's must be the burst's last one
		const i = history.entries.findIndex((e) => e.id === entry.historyEntryId);
		return i > 0 && history.entries[i - 1]!.id === last;
	}
}

/** The toast of a burst: "Agent: <label>" for one transaction, "Agent: N edits" for more. */
export function burstToastText(b: AgentBurst): { title: string; detail: string } {
	const title = b.count === 1 ? t('Agent: {0}', b.label) : t('Agent: {0} edits', b.count);
	const items = b.items === 1 ? t('1 item changed') : t('{0} items changed', b.items);
	return { title: title.slice(0, 80), detail: `${b.agents.join(', ')} · ${items}` };
}
