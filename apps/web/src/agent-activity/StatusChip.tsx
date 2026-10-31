// Header agent status chip (spec 18 AF-ACT-002, spec 05 AG-010): the agents active in this project and their state —
// idle, working (pulsing `--pr-agent` dot), waiting for your review / approval pending (badge with the count), error
// (red dot) — with each agent's current step in the tooltip. Clicking it opens the Agent Activity panel.
import type { EditorSession } from '@jasper/session';
import { cx, Icon } from '@jasper/ui';
import { Component, type ReactNode } from 'react';
import { type AgentBridge, useAgentBridgeFor, useAgentBridgeState } from '../agent-bridge/index.ts';
import { t } from '../i18n/runtime.ts';
import { useShellRuntimeOrNull } from '../shell/context.tsx';
import { useAgentPresence } from './hooks.ts';
import type { AgentPhase, PresenceSummary } from './presence.ts';
import { chipDescription } from './text.ts';

const DOT: Record<AgentPhase, string> = {
	idle: 'bg-pr-border-strong',
	working: 'bg-pr-agent animate-pulse',
	review: 'bg-pr-agent',
	approval: 'bg-pr-warning',
	error: 'bg-pr-danger',
};

function shortPhase(phase: AgentPhase): string | null {
	switch (phase) {
		case 'idle':
			return null;
		case 'working':
			return t('Working');
		case 'review':
			return t('Review');
		case 'approval':
			return t('Approval');
		case 'error':
			return t('Error');
	}
}

export function AgentStatusChipView(props: { summary: PresenceSummary; relayDown: boolean; onOpen(): void }) {
	const { summary } = props;
	const n = summary.agents.length;
	const name = n === 0 ? t('Agents') : n === 1 ? summary.agents[0]!.agent : t('{0} agents', n);
	const phase = n === 0 ? null : shortPhase(summary.phase);
	const description = chipDescription(summary, props.relayDown);
	return (
		<button
			type="button"
			data-testid="agent-status-chip"
			data-phase={n === 0 ? 'none' : summary.phase}
			aria-label={description}
			title={description}
			onClick={props.onOpen}
			className="relative inline-flex h-6 max-w-[220px] shrink-0 items-center gap-1.5 rounded-pr-control px-2 font-pr text-pr-ui text-pr-text hover:bg-pr-hover"
		>
			<span className={cx('inline-flex shrink-0', n ? 'text-pr-agent' : 'text-pr-icon')} aria-hidden="true">
				<Icon id="agent.sparkle" size={14} />
			</span>
			<span className="min-w-0 truncate" data-no-i18n>
				{name}
			</span>
			{n ? (
				<span
					className={cx('size-2 shrink-0 rounded-full', DOT[summary.phase])}
					data-testid="agent-status-dot"
					aria-hidden="true"
				/>
			) : null}
			{phase ? (
				<span
					className={cx(
						'shrink-0 text-pr-small',
						summary.phase === 'error' ? 'text-pr-danger' : 'text-pr-muted',
					)}
				>
					{phase}
				</span>
			) : null}
			{props.relayDown && n ? (
				<span className="shrink-0 text-pr-warning" aria-hidden="true">
					<Icon id="status.warning" size={12} />
				</span>
			) : null}
			{summary.attention ? (
				<span
					className="min-w-3.5 shrink-0 rounded-full bg-pr-accent-fill px-[3px] text-center text-[10px] leading-3.5 text-pr-on-accent pr-tabular"
					data-testid="agent-status-badge"
					aria-hidden="true"
				>
					{summary.attention > 99 ? '99+' : summary.attention}
				</span>
			) : null}
		</button>
	);
}

function ChipForSession({ session, bridge }: { session: EditorSession; bridge: AgentBridge | null }) {
	const summary = useAgentPresence(session, bridge);
	const relay = useAgentBridgeState(bridge, (s) => s.relay);
	const runtime = useShellRuntimeOrNull();
	return (
		<AgentStatusChipView
			summary={summary}
			relayDown={relay === 'disconnected'}
			onOpen={() => void runtime?.run('panel.focus.agentActivity')}
		/>
	);
}

/**
 * Render boundary sized for the header row (the panel boundary's fallback fills a panel): a failure in the chip shows
 * a small marker with the message instead of taking the header down.
 */
class ChipBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
	state = { error: null as string | null };
	static getDerivedStateFromError(e: unknown) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
	componentDidCatch(e: unknown) {
		console.error('[agent-status] chip failed', e);
	}
	render() {
		if (this.state.error === null) return this.props.children;
		const text = t('Agent status unavailable: {0}', this.state.error);
		return (
			<span
				role="alert"
				aria-label={text}
				title={text}
				className="inline-flex h-6 shrink-0 items-center gap-1 px-2 text-pr-small text-pr-danger"
				data-testid="agent-status-failed"
			>
				<Icon id="status.error" size={12} />
				{t('Agents')}
			</span>
		);
	}
}

/** The header chip for the open project (nothing without one). */
export function AgentStatusChip({ session }: { session: EditorSession | null }) {
	const bridge = useAgentBridgeFor(session);
	if (!session) return null;
	return (
		<ChipBoundary>
			<ChipForSession session={session} bridge={bridge} />
		</ChipBoundary>
	);
}
