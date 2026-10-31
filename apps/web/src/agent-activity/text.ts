// UI text of agent states (spec 18 AF-ACT-002), shared by the header chip and the Agent Activity panel.
import { t } from '../i18n/runtime.ts';
import type { AgentPhase, AgentPresence, PresenceSummary } from './presence.ts';

export function phaseLabel(phase: AgentPhase): string {
	switch (phase) {
		case 'idle':
			return t('Idle');
		case 'working':
			return t('Working');
		case 'review':
			return t('Waiting for your review');
		case 'approval':
			return t('Approval pending');
		case 'error':
			return t('Error');
	}
}

/** One agent as a sentence: "claude-code: Working — Add marker". */
export function agentLine(a: AgentPresence): string {
	const extra = a.phase === 'error' ? a.error : a.step;
	return extra
		? t('{0}: {1} — {2}', a.agent, phaseLabel(a.phase), extra)
		: t('{0}: {1}', a.agent, phaseLabel(a.phase));
}

/** The chip's accessible name and tooltip. */
export function chipDescription(summary: PresenceSummary, relayDown: boolean): string {
	const parts = [
		summary.agents.length === 0
			? t('Agents: none active in this project')
			: t('Agents: {0}', summary.agents.map(agentLine).join('; ')),
	];
	if (relayDown) parts.push(t('The live link to the engine is down; agent edits cannot reach this window'));
	parts.push(t('Open the Agent Activity panel'));
	return parts.join('. ');
}
