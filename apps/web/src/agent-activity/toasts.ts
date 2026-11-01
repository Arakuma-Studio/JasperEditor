// Agent activity toasts (spec 18 AF-ACT-003), wired by the editor shell (shell/AgentApprovals.tsx).
import type { EditorSession } from '@jasper/session';
import { toast } from '@jasper/ui';
import type { ActivityEntry, AgentBridge } from '../agent-bridge/bridge.ts';
import { t } from '../i18n/runtime.ts';
import { type AgentBurst, AgentBurstTracker, burstToastText } from './bursts.ts';
import { undoAgentEdits, undoRefusalText } from './model.ts';

/** Shows the bridge's activity as burst toasts; returns the unsubscribe function. */
export function wireActivityToasts(bridge: AgentBridge, session: EditorSession): () => void {
	const bursts = new AgentBurstTracker();
	return bridge.on('activity', (e) => activityToast(e as ActivityEntry, bursts, session));
}

/**
 * The activity toast (spec 18 AF-ACT-003): what an external agent changed, one toast per burst — transactions less
 * than 2 s apart whose History entries follow each other — "Agent: N edits" with an Undo that takes back exactly that
 * burst (refused, with the reason, when an edit came after it). Dry runs, rejections and in-page calls stay quiet.
 */
function activityToast(entry: ActivityEntry, bursts: AgentBurstTracker, session: EditorSession): void {
	if (entry.via !== 'relay' || !entry.ok || entry.dryRun) return;
	const burst = bursts.add(entry, session.getState().history);
	const { title, detail } = burstToastText(burst);
	const dedupeKey = `agent-burst:${burst.id}`;
	toast({
		kind: 'agent',
		title,
		detail,
		source: 'agent',
		dedupeKey,
		// The toast host dismisses the burst toast after its action runs: the result gets a key of its own.
		actions: [{ label: t('Undo'), run: () => undoBurst(burst, session, `agent-burst-undo:${burst.id}`) }],
	});
}

function undoBurst(burst: AgentBurst, session: EditorSession, dedupeKey: string): void {
	const r = undoAgentEdits(session, burst.historyIds);
	if (r.ok) {
		const missing = burst.historyIds.length - r.undone;
		toast({
			kind: 'info',
			title: r.undone === 1 ? t('Undid 1 agent edit') : t('Undid {0} agent edits', r.undone),
			...(missing > 0
				? { detail: t('{0} of the burst were already undone or are no longer in History', missing) }
				: {}),
			source: 'user',
			dedupeKey,
		});
		return;
	}
	toast({
		kind: 'warning',
		title: r.undone
			? t('Undid {0} agent edits, then stopped', r.undone)
			: t('The agent’s edits were not undone'),
		detail: r.message ? `${undoRefusalText(r.reason)}: ${r.message}` : undoRefusalText(r.reason),
		source: 'user',
		dedupeKey,
	});
}
