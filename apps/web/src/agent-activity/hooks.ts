// React wiring of the agent presence (spec 18 AF-ACT-002): the bridge's activity log and approvals, the session's
// proposals and the project's engine jobs, re-evaluated when any of them changes and when time alone changes the
// result (a working agent turning idle).
import type { EditorSession } from '@jasper/session';
import { useEffect, useMemo, useState } from 'react';
import { type AgentBridge, useAgentBridgeState } from '../agent-bridge/index.ts';
import { useProposals } from '../proposals/state.ts';
import { useJobs } from '../state/engine.tsx';
import { agentPresence, type PresenceSummary } from './presence.ts';

/** Longest wait a timer may be given (setTimeout's 32-bit limit). */
const MAX_TIMER_MS = 2 ** 31 - 1;

export function useAgentPresence(session: EditorSession, bridge: AgentBridge | null): PresenceSummary {
	const activity = useAgentBridgeState(bridge, (s) => s.activity);
	const approvals = useAgentBridgeState(bridge, (s) => s.approvals);
	const proposals = useProposals(session, (s) => s.list);
	const { jobs } = useJobs({ projectId: session.projectId });
	const [tick, setTick] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-evaluates at the time the summary changes by itself
	const summary = useMemo(
		() => agentPresence({ activity, approvals, proposals, jobs, now: Date.now() }),
		[activity, approvals, proposals, jobs, tick],
	);
	const next = summary.nextChangeAt;
	useEffect(() => {
		if (next === null) return;
		const wait = Math.min(MAX_TIMER_MS, Math.max(0, next - Date.now()) + 50);
		const timer = setTimeout(() => setTick((n) => n + 1), wait);
		return () => clearTimeout(timer);
	}, [next]);
	return summary;
}
