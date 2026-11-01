// Agent Activity panel (spec 18 AF-ACT-001): the agents active in this project with their state (AF-ACT-002), and the
// bridge's activity log — time, agent, action, outcome — newest first, filtered by agent and outcome. A row's Undo
// takes back its transaction while it is the agent's entry at the top of the undo stack; otherwise the button says
// why it cannot (already undone, newer edits on top, no longer in History). Rows are keyboard navigable (↑/↓, Home /
// End move between rows, Enter shows the details, Tab reaches the row's Undo). The log holds at most 200 entries
// (the bridge's cap), so the list is not virtualised.
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { Button, cx, Icon, Select, toast } from '@jasper/ui';
import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import { useAgentPresence } from '../../agent-activity/hooks.ts';
import {
	ACTIVITY_OUTCOMES,
	type ActivityFilter,
	type ActivityOutcome,
	activityAgents,
	activityOutcome,
	entryUndoPlan,
	filterActivity,
	outcomeLabel,
	undoAgentEdits,
	undoRefusalText,
} from '../../agent-activity/model.ts';
import type { AgentPresence } from '../../agent-activity/presence.ts';
import { phaseLabel } from '../../agent-activity/text.ts';
import {
	type ActivityEntry,
	type AgentBridge,
	useAgentBridgeFor,
	useAgentBridgeState,
} from '../../agent-bridge/index.ts';
import { t } from '../../i18n/runtime.ts';
import { useShellRuntimeOrNull } from '../../shell/context.tsx';
import type { PanelProps } from '../types.ts';

const ALL = '*';

const OUTCOME_TONE: Record<ActivityOutcome, string> = {
	applied: 'text-pr-success',
	failed: 'text-pr-danger',
	denied: 'text-pr-warning',
	dryRun: 'text-pr-muted',
};

const PHASE_TONE: Record<AgentPresence['phase'], string> = {
	idle: 'text-pr-muted',
	working: 'text-pr-agent',
	review: 'text-pr-agent',
	approval: 'text-pr-warning',
	error: 'text-pr-danger',
};

function clock(ms: number): string {
	const d = new Date(ms);
	return Number.isFinite(d.getTime()) ? d.toLocaleTimeString() : '—';
}

export function AgentActivityPanel(props: PanelProps) {
	const session = useSessionOrNull();
	const bridge = useAgentBridgeFor(session);
	return (
		<div
			className="flex h-full min-h-0 flex-col bg-pr-panel font-pr text-pr-ui text-pr-text"
			data-panel-kind="agentActivity"
			data-instance-id={props.instanceId}
			data-testid="agent-activity-panel"
		>
			{session ? (
				<WithPresence session={session} bridge={bridge} />
			) : (
				<p className="p-3 text-pr-small text-pr-muted">{t('No project open.')}</p>
			)}
		</div>
	);
}

function WithPresence({ session, bridge }: { session: EditorSession; bridge: AgentBridge | null }) {
	const presence = useAgentPresence(session, bridge);
	return <AgentActivityView session={session} bridge={bridge} agents={presence.agents} />;
}

/** The panel body (exported for tests: the agents' presence comes in as a prop). */
export function AgentActivityView(props: {
	session: EditorSession;
	bridge: AgentBridge | null;
	agents: readonly AgentPresence[];
}) {
	const { session, bridge } = props;
	const activity = useAgentBridgeState(bridge, (s) => s.activity);
	const history = useStoreSelector(session.store, (s) => s.history);
	const [filter, setFilter] = useState<ActivityFilter>({ agent: null, outcome: null });
	const [active, setActive] = useState<number | null>(null);
	const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
	const listRef = useRef<HTMLUListElement>(null);

	const agentNames = useMemo(() => activityAgents(activity), [activity]);
	const agentOptions = useMemo(
		() => [{ value: ALL, label: t('All agents') }, ...agentNames.map((a) => ({ value: a, label: a }))],
		[agentNames],
	);
	const outcomeOptions = useMemo(
		() => [
			{ value: ALL, label: t('All outcomes') },
			...ACTIVITY_OUTCOMES.map((o) => ({ value: o, label: outcomeLabel(o) })),
		],
		[],
	);
	const rows = useMemo(() => filterActivity(activity, filter), [activity, filter]);
	const activeId = rows.some((r) => r.id === active) ? active : (rows[0]?.id ?? null);

	const focusRow = (id: number) => {
		setActive(id);
		listRef.current?.querySelector<HTMLElement>(`[data-activity-id="${id}"]`)?.focus();
	};
	const toggle = (id: number) =>
		setExpanded((s) => {
			const next = new Set(s);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.defaultPrevented || rows.length === 0) return;
		const i = Math.max(
			0,
			rows.findIndex((r) => r.id === activeId),
		);
		let to: number | null = null;
		if (e.key === 'ArrowDown') to = Math.min(rows.length - 1, i + 1);
		else if (e.key === 'ArrowUp') to = Math.max(0, i - 1);
		else if (e.key === 'Home') to = 0;
		else if (e.key === 'End') to = rows.length - 1;
		else if (e.key === 'Enter' && (e.target as HTMLElement).dataset.activityId !== undefined) {
			e.preventDefault();
			toggle(rows[i]!.id);
			return;
		}
		if (to === null) return;
		e.preventDefault();
		focusRow(rows[to]!.id);
	};
	const undo = (entry: ActivityEntry) => {
		if (entry.historyEntryId === null) return;
		const r = undoAgentEdits(session, [entry.historyEntryId]);
		if (r.ok) toast({ kind: 'info', title: t('Undid {0}', entry.label).slice(0, 80), source: 'user' });
		else
			toast({
				kind: 'warning',
				title: t('The agent’s edit was not undone'),
				detail: r.message ? `${undoRefusalText(r.reason)}: ${r.message}` : undoRefusalText(r.reason),
				dedupeKey: `agent-activity-undo:${entry.id}`,
			});
	};

	return (
		<>
			<AgentList agents={props.agents} />
			<div className="flex shrink-0 items-center gap-2 border-b border-pr-border-subtle px-2 py-1">
				<Select
					label={t('Agent')}
					value={filter.agent ?? ALL}
					onValueChange={(v) => setFilter((f) => ({ ...f, agent: v === ALL ? null : v }))}
					options={agentOptions}
					className="min-w-0 max-w-[220px] flex-1"
				/>
				<Select
					label={t('Outcome')}
					value={filter.outcome ?? ALL}
					onValueChange={(v) =>
						setFilter((f) => ({
							...f,
							outcome: v === ALL ? null : (ACTIVITY_OUTCOMES.find((o) => o === v) ?? null),
						}))
					}
					options={outcomeOptions}
					className="min-w-0 max-w-[220px] flex-1"
				/>
			</div>
			{rows.length === 0 ? (
				<p className="p-3 text-pr-small text-pr-muted" data-testid="agent-activity-empty">
					{activity.length === 0
						? t('No agent activity in this window yet. Agent transactions appear here as they arrive.')
						: t('No activity matches the filters.')}
				</p>
			) : (
				<ul
					ref={listRef}
					aria-label={t('Agent activity')}
					className="min-h-0 flex-1 overflow-y-auto"
					onKeyDown={onKeyDown}
					data-testid="agent-activity-list"
				>
					{rows.map((e) => (
						<ActivityRow
							key={e.id}
							entry={e}
							active={e.id === activeId}
							expanded={expanded.has(e.id)}
							undo={entryUndoPlan(e, history)}
							onFocus={() => setActive(e.id)}
							onToggle={() => toggle(e.id)}
							onUndo={() => undo(e)}
						/>
					))}
				</ul>
			)}
		</>
	);
}

function AgentList({ agents }: { agents: readonly AgentPresence[] }) {
	const runtime = useShellRuntimeOrNull();
	if (agents.length === 0)
		return (
			<div
				className="flex shrink-0 items-center gap-2 border-b border-pr-border-subtle px-2 py-1.5 text-pr-small text-pr-muted"
				data-testid="agent-activity-agents"
			>
				<span className="min-w-0 flex-1">{t('No agent is active in this project.')}</span>
				{runtime ? (
					<Button variant="quiet" onClick={() => void runtime.run('help.connectAgent')}>
						{t('Connect an AI Agent…')}
					</Button>
				) : null}
			</div>
		);
	return (
		<ul
			className="flex shrink-0 flex-col gap-0.5 border-b border-pr-border-subtle px-2 py-1.5"
			aria-label={t('Agents')}
			data-testid="agent-activity-agents"
		>
			{agents.map((a) => (
				<li key={a.agent} className="flex min-w-0 items-center gap-2" data-agent-phase={a.phase}>
					<span className="inline-flex shrink-0 text-pr-agent" aria-hidden="true">
						<Icon id="agent.sparkle" size={12} />
					</span>
					<span
						className="max-w-[40%] shrink-0 truncate font-semibold text-pr-strong"
						title={a.agent}
						data-no-i18n
					>
						{a.agent}
					</span>
					<span className={cx('shrink-0 text-pr-small', PHASE_TONE[a.phase])}>{phaseLabel(a.phase)}</span>
					{a.phase === 'error' ? (
						a.error ? (
							<span
								className="min-w-0 flex-1 truncate text-pr-small text-pr-danger"
								title={a.error}
								data-no-i18n
							>
								{a.error}
							</span>
						) : null
					) : a.step ? (
						<span className="min-w-0 flex-1 truncate text-pr-small text-pr-muted" title={a.step} data-no-i18n>
							{a.step}
						</span>
					) : null}
				</li>
			))}
		</ul>
	);
}

function ActivityRow(props: {
	entry: ActivityEntry;
	active: boolean;
	expanded: boolean;
	undo: ReturnType<typeof entryUndoPlan>;
	onFocus(): void;
	onToggle(): void;
	onUndo(): void;
}) {
	const { entry: e, undo } = props;
	const outcome = activityOutcome(e);
	const firstError = e.errors[0];
	const undoable = e.historyEntryId !== null;
	const detailsId = `agent-activity-details-${e.id}`;
	return (
		<li
			tabIndex={props.active ? 0 : -1}
			aria-label={t('{0} by {1} at {2}: {3}', e.label, e.agent, clock(e.time), outcomeLabel(outcome))}
			data-activity-id={e.id}
			data-outcome={outcome}
			data-testid="agent-activity-row"
			onFocus={(ev) => {
				if (ev.target === ev.currentTarget) props.onFocus();
			}}
			className="border-b border-pr-border-subtle outline-none focus-visible:bg-pr-hover"
		>
			<div className="flex min-h-[var(--pr-row-h)] items-center gap-2 px-2">
				<button
					type="button"
					tabIndex={-1}
					className="inline-flex w-3 shrink-0 justify-center text-pr-muted"
					aria-label={props.expanded ? t('Hide details') : t('Show details')}
					aria-expanded={props.expanded}
					aria-controls={props.expanded ? detailsId : undefined}
					data-testid="agent-activity-toggle"
					onClick={props.onToggle}
				>
					{props.expanded ? '▾' : '▸'}
				</button>
				<span className="w-[64px] shrink-0 text-pr-small text-pr-muted pr-tabular">{clock(e.time)}</span>
				<span
					className="max-w-[96px] shrink-0 truncate text-pr-small text-pr-agent"
					title={e.agent}
					data-no-i18n
				>
					{e.agent}
				</span>
				<span className="min-w-0 flex-1 truncate" title={`${e.label} — ${e.summary}`} data-no-i18n>
					{e.label}
					<span className="ml-1.5 text-pr-small text-pr-muted">{e.summary}</span>
				</span>
				<span
					className={cx('shrink-0 text-pr-small', OUTCOME_TONE[outcome])}
					title={firstError ? `${firstError.code}: ${firstError.message}` : undefined}
					data-testid="agent-activity-outcome"
				>
					{outcomeLabel(outcome)}
				</span>
				{undoable ? (
					<Button
						variant="quiet"
						tabIndex={props.active ? 0 : -1}
						disabled={!undo.ok}
						disabledReason={undo.ok ? undefined : undoRefusalText(undo.reason)}
						aria-label={t('Undo {0}', e.label)}
						onClick={props.onUndo}
						data-testid="agent-activity-undo"
						data-undo={undo.ok ? 'ok' : undo.reason}
					>
						{t('Undo')}
					</Button>
				) : null}
			</div>
			{props.expanded ? (
				<div id={detailsId} className="flex flex-col gap-0.5 px-8 pb-1.5 text-pr-small text-pr-muted">
					<span>
						{t(
							'{0} created · {1} changed · {2} deleted · {3} commands · revision {4} · via {5}',
							e.created.length,
							e.changed.length,
							e.deleted.length,
							e.commandCount,
							e.revision,
							e.via,
						)}
					</span>
					{e.errors.map((x) => (
						<span key={`${x.commandIndex}:${x.code}:${x.message}`} className="text-pr-danger" data-no-i18n>
							{x.commandIndex >= 0 ? `#${x.commandIndex} ` : ''}
							{x.code}: {x.message}
						</span>
					))}
					{e.warnings.map((w) => (
						<span key={`${w.code}:${w.message}`} className="text-pr-warning" data-no-i18n>
							{w.code}: {w.message}
						</span>
					))}
				</div>
			) : null}
		</li>
	);
}
