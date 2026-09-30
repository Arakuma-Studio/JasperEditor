// Agent panel, Stage 1 (ARCHITECTURE §11, S05 §17 M1 subset): activity feed of agent transactions,
// pending approval cards, a JSON transaction console and a schema browser.
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { Button, cx, Icon } from '@jasper/ui';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	type ActivityEntry,
	type AgentBridge,
	type PendingApproval,
	useAgentBridgeFor,
	useAgentBridgeState,
} from '../../agent-bridge/index.ts';
import { useShellRuntimeOrNull } from '../../shell/context.tsx';
import { PanelServices } from '../../state/panel-services.ts';
import type { PanelProps } from '../types.ts';
import { type ConsoleOutcome, runConsoleInput } from './console-run.ts';
import { CONSOLE_TEMPLATES, DEFAULT_TEMPLATE, pretty } from './templates.ts';

declare module '../../state/panel-services.ts' {
	interface PanelServiceMap {
		/** The Agent panel's JSON console (commands `agent.console.run`, `panel.focus.agent`). */
		agentConsole: { run(): Promise<void>; focus(): void };
	}
}

/** Services used when the Agent panel is mounted outside the editor shell (tests, standalone). */
export const agentPanelServices = new PanelServices();

type Tab = 'activity' | 'approvals' | 'console' | 'schema';

const timeFmt = (t: number) =>
	new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function Section(props: { children: ReactNode; className?: string }) {
	return (
		<div className={cx('flex min-h-0 flex-1 flex-col overflow-auto', props.className)}>{props.children}</div>
	);
}

function Empty(props: { children: ReactNode }) {
	return <p className="p-4 text-center text-pr-small text-pr-dim">{props.children}</p>;
}

// ---------------------------------------------------------------- activity

function ActivityRow(props: { entry: ActivityEntry; bridge: AgentBridge; session: EditorSession }) {
	const { entry, bridge, session } = props;
	// Re-render when history moves so "Undo" appears only on the top entry.
	useStoreSelector(session.store, (s) => s.history.index);
	const [open, setOpen] = useState(false);
	const ids = [...entry.created, ...entry.changed, ...entry.deleted];
	const top = bridge.isTopOfHistory(entry);
	return (
		<li className="border-b border-pr-border-subtle px-2 py-1.5" data-testid="agent-activity-row">
			<div className="flex items-center gap-2">
				<span className={cx('size-2 shrink-0 rounded-full', entry.ok ? 'bg-pr-success' : 'bg-pr-danger')} />
				<span className="truncate text-pr-ui text-pr-text" title={entry.summary}>
					{entry.dryRun ? 'Dry run: ' : ''}
					{entry.label}
				</span>
				<span className="ml-auto shrink-0 text-pr-small text-pr-dim">{timeFmt(entry.time)}</span>
			</div>
			<div className="mt-0.5 flex items-center gap-2 text-pr-small text-pr-muted">
				<span className="text-pr-agent">{entry.agent}</span>
				<span>· {entry.via}</span>
				{entry.ok ? (
					<span>
						· rev {entry.revision} · {ids.length} affected
					</span>
				) : (
					<span className="text-pr-danger">· {entry.errors.map((e) => e.code).join(', ')}</span>
				)}
				<span className="ml-auto flex gap-1">
					{ids.length > 0 || !entry.ok ? (
						<button className="text-pr-muted hover:text-pr-text" onClick={() => setOpen(!open)}>
							{open ? 'Hide' : 'Details'}
						</button>
					) : null}
					{top ? (
						<button
							className="text-pr-accent hover:underline"
							onClick={() => session.undo()}
							data-testid="agent-activity-undo"
						>
							Undo
						</button>
					) : null}
				</span>
			</div>
			{open ? (
				<pre className="mt-1 max-h-40 overflow-auto rounded-pr-control bg-pr-field-deep p-1.5 font-pr-mono text-pr-small text-pr-muted">
					{entry.ok
						? pretty({
								created: entry.created,
								changed: entry.changed,
								deleted: entry.deleted,
								warnings: entry.warnings,
							})
						: pretty(entry.errors)}
				</pre>
			) : null}
		</li>
	);
}

function ActivityFeed(props: { bridge: AgentBridge; session: EditorSession }) {
	const activity = useAgentBridgeState(props.bridge, (s) => s.activity);
	if (activity.length === 0)
		return (
			<Empty>No agent activity yet. Agents reach this editor through window.jasper or the engine.</Empty>
		);
	return (
		<ul>
			{activity.map((e) => (
				<ActivityRow key={e.id} entry={e} bridge={props.bridge} session={props.session} />
			))}
		</ul>
	);
}

// ---------------------------------------------------------------- approvals

function Countdown(props: { until: string }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	const left = Math.max(0, Math.round((Date.parse(props.until) - now) / 1000));
	return <span className="text-pr-small text-pr-dim">{Number.isFinite(left) ? `${left} s` : ''}</span>;
}

function ApprovalCard(props: { approval: PendingApproval; bridge: AgentBridge }) {
	const { approval: a, bridge } = props;
	const [open, setOpen] = useState(false);
	return (
		<li
			className="m-2 rounded-pr-frame border border-pr-warning bg-pr-raised p-2"
			data-testid="agent-approval-card"
		>
			<div className="flex items-center gap-2">
				<Icon id="panel.agent" size={14} />
				<span className="truncate text-pr-ui text-pr-strong">{a.label}</span>
				<span className="ml-auto">
					<Countdown until={a.expiresAt} />
				</span>
			</div>
			<p className="mt-1 text-pr-small text-pr-muted">
				<span className="text-pr-agent">{a.agent}</span> wants to run {a.commandCount} command
				{a.commandCount === 1 ? '' : 's'}
				{a.summary ? `: ${a.summary}` : ''}
			</p>
			<ul className="mt-1 list-disc pl-5 text-pr-small text-pr-warning">
				{a.reasons.map((r) => (
					<li key={r}>{r}</li>
				))}
			</ul>
			{open && a.commands ? (
				<pre className="mt-1 max-h-40 overflow-auto rounded-pr-control bg-pr-field-deep p-1.5 font-pr-mono text-pr-small text-pr-muted">
					{pretty(a.commands)}
				</pre>
			) : null}
			<div className="mt-2 flex items-center gap-2">
				{a.commands ? (
					<button className="text-pr-small text-pr-muted hover:text-pr-text" onClick={() => setOpen(!open)}>
						{open ? 'Hide commands' : 'Show commands'}
					</button>
				) : null}
				<span className="ml-auto flex gap-2">
					<Button variant="secondary" onClick={() => bridge.resolveApproval(a.approvalId, 'denied')}>
						Deny
					</Button>
					<Button variant="primary" onClick={() => bridge.resolveApproval(a.approvalId, 'approved')}>
						Approve
					</Button>
				</span>
			</div>
		</li>
	);
}

function Approvals(props: { bridge: AgentBridge }) {
	const approvals = useAgentBridgeState(props.bridge, (s) => s.approvals);
	if (approvals.length === 0) return <Empty>No pending approvals.</Empty>;
	return (
		<ul>
			{approvals.map((a) => (
				<ApprovalCard key={a.approvalId} approval={a} bridge={props.bridge} />
			))}
		</ul>
	);
}

// ---------------------------------------------------------------- console

function TransactionConsole(props: { bridge: AgentBridge; instanceId: string; services: PanelServices }) {
	const { bridge } = props;
	const [text, setText] = useState(() => pretty(DEFAULT_TEMPLATE.body));
	const [dryRun, setDryRun] = useState(false);
	const [busy, setBusy] = useState(false);
	const [outcome, setOutcome] = useState<ConsoleOutcome | null>(null);
	const area = useRef<HTMLTextAreaElement>(null);
	const textRef = useRef(text);
	textRef.current = text;
	const dryRef = useRef(dryRun);
	dryRef.current = dryRun;

	const run = useCallback(async () => {
		setBusy(true);
		try {
			setOutcome(await runConsoleInput(bridge, textRef.current, { dryRun: dryRef.current }));
		} finally {
			setBusy(false);
		}
	}, [bridge]);

	useEffect(
		() =>
			props.services.register('agentConsole', props.instanceId, { run, focus: () => area.current?.focus() }),
		[props.services, props.instanceId, run],
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
			<div className="flex items-center gap-2">
				<select
					className="h-6 min-w-0 flex-1 rounded-pr-control border border-pr-border bg-pr-field px-1 text-pr-ui text-pr-text"
					aria-label="Template"
					value=""
					onChange={(e) => {
						const t = CONSOLE_TEMPLATES.find((x) => x.id === e.target.value);
						if (t) setText(pretty(t.body));
					}}
				>
					<option value="">Templates…</option>
					{CONSOLE_TEMPLATES.map((t) => (
						<option key={t.id} value={t.id}>
							{t.label}
						</option>
					))}
				</select>
				<label className="flex items-center gap-1 text-pr-small text-pr-muted">
					<input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Dry run
				</label>
				<Button variant="primary" disabled={busy} onClick={() => void run()} title="Run (Ctrl+Enter)">
					Run
				</Button>
			</div>
			<textarea
				ref={area}
				className="min-h-32 flex-1 resize-none rounded-pr-control border border-pr-border bg-pr-field-deep p-1.5 font-pr-mono text-pr-small text-pr-text"
				spellCheck={false}
				aria-label="Transaction JSON"
				data-testid="agent-console-input"
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
						e.preventDefault();
						void run();
					}
				}}
			/>
			{outcome ? (
				<div className="flex min-h-0 flex-1 flex-col" data-testid="agent-console-result">
					<p className={cx('text-pr-small', outcome.ok ? 'text-pr-success' : 'text-pr-danger')}>
						{outcome.status}
					</p>
					<pre className="min-h-0 flex-1 overflow-auto rounded-pr-control bg-pr-field-deep p-1.5 font-pr-mono text-pr-small text-pr-muted">
						{pretty(outcome.output)}
					</pre>
				</div>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------- schema browser

function SchemaBrowser(props: { bridge: AgentBridge }) {
	const schema = useMemo(() => props.bridge.schema(), [props.bridge]);
	const [filter, setFilter] = useState('');
	const [selected, setSelected] = useState<string | null>(null);
	const commands = schema.commands as Record<
		string,
		{ label: string; implemented: boolean; schema: unknown }
	>;
	const queries = schema.queries as Record<
		string,
		{ description: string; args: unknown; sessionOnly: boolean }
	>;
	const entries = [
		...Object.entries(commands).map(([k, v]) => ({
			key: k,
			kind: 'command' as const,
			label: v.label,
			ok: v.implemented,
			body: v.schema,
		})),
		...Object.entries(queries).map(([k, v]) => ({
			key: k,
			kind: 'query' as const,
			label: v.description,
			ok: true,
			body: v.args,
		})),
	].filter((e) => !filter || e.key.toLowerCase().includes(filter.toLowerCase()));
	const current = entries.find((e) => `${e.kind}:${e.key}` === selected) ?? null;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<input
				className="m-2 h-6 rounded-pr-control border border-pr-border bg-pr-field px-1.5 text-pr-ui text-pr-text"
				placeholder="Filter commands and queries"
				aria-label="Filter schema"
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
			/>
			<div className="flex min-h-0 flex-1">
				<ul
					className="w-1/2 min-w-0 overflow-auto border-r border-pr-border-subtle"
					data-testid="agent-schema-list"
				>
					{entries.map((e) => {
						const id = `${e.kind}:${e.key}`;
						return (
							<li key={id}>
								<button
									className={cx(
										'flex w-full items-center gap-1 px-2 py-0.5 text-left text-pr-small hover:bg-pr-hover',
										selected === id ? 'bg-pr-selected text-pr-strong' : 'text-pr-text',
										!e.ok && 'text-pr-dim',
									)}
									title={e.label}
									onClick={() => setSelected(id)}
								>
									<span className="font-pr-mono">{e.key}</span>
									<span className="ml-auto text-pr-dim">
										{e.kind === 'query' ? 'query' : e.ok ? '' : 'M2'}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
				<div className="min-w-0 flex-1 overflow-auto p-2">
					{current ? (
						<>
							<p className="mb-1 text-pr-small text-pr-muted">{current.label}</p>
							<pre className="font-pr-mono text-pr-small text-pr-muted">{pretty(current.body)}</pre>
						</>
					) : (
						<Empty>
							{Object.keys(commands).length} commands, {Object.keys(queries).length} queries. Select one to
							see its JSON Schema.
						</Empty>
					)}
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------- panel

const RELAY_LABEL = {
	off: 'Relay off',
	connecting: 'Connecting…',
	connected: 'Relay connected',
	disconnected: 'Relay offline',
};

export function AgentPanel(props: PanelProps & { services?: PanelServices }) {
	const session = useSessionOrNull();
	const bridge = useAgentBridgeFor(session);
	const [tab, setTab] = useState<Tab>('activity');
	const approvals = useAgentBridgeState(bridge, (s) => s.approvals.length);
	const relay = useAgentBridgeState(bridge, (s) => s.relay);
	// The shell's registry (S05:SH-005) so `agent.console.run` / `panel.focus.agent` find the console through
	// `ctx.services`; the module-level registry stays as the standalone/test fallback.
	const shellServices = useShellRuntimeOrNull()?.services;
	const services = props.services ?? shellServices ?? agentPanelServices;
	// A new approval pulls the panel to the approvals tab (S01:AGT-011 confirmation).
	const prevApprovals = useRef(0);
	useEffect(() => {
		if (approvals > prevApprovals.current) setTab('approvals');
		prevApprovals.current = approvals;
	}, [approvals]);

	if (!session || !bridge)
		return (
			<div className="flex h-full items-center justify-center" data-panel-kind="agent">
				<Empty>Open a project to use the agent API.</Empty>
			</div>
		);
	const tabs: [Tab, string][] = [
		['activity', 'Activity'],
		['approvals', approvals ? `Approvals (${approvals})` : 'Approvals'],
		['console', 'Console'],
		['schema', 'Schema'],
	];
	return (
		<div
			className="flex h-full min-h-0 flex-col bg-pr-panel"
			data-panel-kind="agent"
			data-instance-id={props.instanceId}
		>
			<div
				className="flex h-7 shrink-0 items-center gap-1 overflow-hidden border-b border-pr-border-subtle px-1"
				role="tablist"
			>
				{tabs.map(([id, label]) => (
					<button
						key={id}
						role="tab"
						aria-selected={tab === id}
						className={cx(
							'h-6 shrink-0 whitespace-nowrap rounded-pr-control px-2 text-pr-ui',
							tab === id ? 'bg-pr-selected text-pr-strong' : 'text-pr-muted hover:bg-pr-hover',
							id === 'approvals' && approvals > 0 && 'text-pr-warning',
						)}
						onClick={() => setTab(id)}
					>
						{label}
					</button>
				))}
				<span
					className={cx(
						'ml-auto flex min-w-0 items-center gap-1 truncate whitespace-nowrap px-1 text-pr-small',
						relay === 'connected' ? 'text-pr-success' : 'text-pr-dim',
					)}
					title="WS /agent relay: external agents reach this editor through the engine"
					data-testid="agent-relay-status"
				>
					<span
						className={cx('size-1.5 rounded-full', relay === 'connected' ? 'bg-pr-success' : 'bg-pr-dim')}
					/>
					{RELAY_LABEL[relay]}
				</span>
				{tab === 'activity' ? (
					<button
						className="px-1 text-pr-small text-pr-muted hover:text-pr-text"
						onClick={() => bridge.clearActivity()}
					>
						Clear
					</button>
				) : null}
			</div>
			<Section>
				{tab === 'activity' ? <ActivityFeed bridge={bridge} session={session} /> : null}
				{tab === 'approvals' ? <Approvals bridge={bridge} /> : null}
				{tab === 'console' ? (
					<TransactionConsole bridge={bridge} instanceId={props.instanceId} services={services} />
				) : null}
				{tab === 'schema' ? <SchemaBrowser bridge={bridge} /> : null}
			</Section>
		</div>
	);
}
