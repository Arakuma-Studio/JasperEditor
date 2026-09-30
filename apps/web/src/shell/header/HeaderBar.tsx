// Row B — header bar (S05:HD-003/004/010/012): Home, Import/Edit/Export mode tabs, workspace tabs (Edit
// mode; drag to reorder; right-click menu; » overflow), Workspaces menu, and the right cluster: engine
// chip, background jobs with a badge, Quick Export (`export.quick`), Agent (`panel.focus.agent`),
// command palette and full screen. Every icon button has a `Name (Shortcut)` tooltip.

import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { ContextMenu, cx, DropdownMenu, Icon, IconButton, type ResolvedMenuItem } from '@jasper/ui';
import { Popover } from 'radix-ui';
import {
	type DragEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { subscribeCommands } from '../../commands/registry.ts';
import { usePersistenceStatus } from '../../home/ProjectLifecycle.tsx';
import { useJobsSummary } from '../../panels/jobs/JobsPanel.tsx';
import { useEngine, useJobs } from '../../state/engine.tsx';
import { type ShellMode, useCommandCtx, useShellRuntime } from '../context.tsx';
import type { ShellMenuItem } from '../menus/resolve.ts';
import { commandState, type MenuEnv, resolveMenu } from '../menus/resolve.ts';
import type { WorkspaceRecord, WorkspaceStore } from '../workspaces/store.ts';

let registryVersion = 0;
subscribeCommands(() => {
	registryVersion++;
});
function useRegistryVersion(): number {
	return useSyncExternalStore(
		(l) => subscribeCommands(l),
		() => registryVersion,
	);
}

/** Live label/enabled/shortcut for a command id (header buttons reflect SH-031). */
export function useCommandButton(id: string, fallback: string) {
	useRegistryVersion();
	const runtime = useShellRuntime();
	const getCtx = useCommandCtx();
	const st = commandState(
		id,
		{ ctx: getCtx(), platform: runtime.platform, runtime: runtime.runtime },
		fallback,
	);
	return { ...st, run: (args?: unknown) => void runtime.run(id, args) };
}

function CommandIconButton(props: {
	id: string;
	label: string;
	icon: Parameters<typeof IconButton>[0]['icon'];
	badge?: number | null;
	dot?: boolean;
	toggled?: 'off' | 'on';
	testId?: string;
}) {
	const b = useCommandButton(props.id, props.label);
	return (
		<IconButton
			icon={props.icon}
			label={b.registered ? b.label : props.label}
			shortcut={b.shortcut}
			disabled={!b.enabled}
			disabledReason={b.reason}
			badge={props.badge}
			dot={props.dot}
			toggled={props.toggled}
			onClick={() => b.run()}
			data-testid={props.testId}
			data-command-id={props.id}
		/>
	);
}

// ------------------------------------------------------------------ mode tabs

const MODES: { id: ShellMode; label: string }[] = [
	{ id: 'import', label: 'Import' },
	{ id: 'edit', label: 'Edit' },
	{ id: 'export', label: 'Export' },
];

function ModeTabs({ mode, onMode }: { mode: ShellMode; onMode(m: ShellMode): void }) {
	return (
		<div role="tablist" aria-label="Mode" className="flex h-full items-stretch">
			{MODES.map((m) => (
				<button
					key={m.id}
					type="button"
					role="tab"
					aria-selected={mode === m.id}
					data-testid={`mode-${m.id}`}
					onClick={() => onMode(m.id)}
					className={cx(
						'px-2.5 font-pr text-[length:var(--pr-font-size-mode-tab)] outline-none focus-visible:bg-pr-hover',
						mode === m.id
							? 'text-pr-strong shadow-[inset_0_-2px_0_var(--pr-text-strong)]'
							: 'text-pr-muted hover:text-pr-text',
					)}
				>
					{m.label}
				</button>
			))}
		</div>
	);
}

// ------------------------------------------------------------------ workspace tabs

function WorkspaceTabs(props: {
	store: WorkspaceStore;
	activeId: string;
	list: WorkspaceRecord[];
	tabMenu(ws: WorkspaceRecord): ResolvedMenuItem[];
	onSwitch(id: string): void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const [overflow, setOverflow] = useState(false);
	const [dragId, setDragId] = useState<string | null>(null);

	const count = props.list.length;
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const check = () => setOverflow(count > 0 && el.scrollWidth > el.clientWidth + 1);
		check();
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(check);
		ro.observe(el);
		return () => ro.disconnect();
	}, [count]);

	const onDrop = (e: DragEvent, beforeId: string) => {
		e.preventDefault();
		const id = dragId ?? e.dataTransfer.getData('application/x-jasper-workspace');
		setDragId(null);
		if (id && id !== beforeId) props.store.move(id, beforeId);
	};

	return (
		<div className="flex h-full min-w-0 items-stretch">
			<div
				ref={scroller}
				role="tablist"
				aria-label="Workspaces"
				className="flex min-w-0 items-stretch overflow-hidden"
				data-testid="workspace-tabs"
			>
				{props.list.map((ws) => {
					const active = ws.id === props.activeId;
					const n = props.store.shortcutNumber(ws.id);
					return (
						<ContextMenu key={ws.id} items={() => props.tabMenu(ws)}>
							<button
								type="button"
								role="tab"
								aria-selected={active}
								draggable
								data-testid={`workspace-tab-${ws.id}`}
								title={n ? `${ws.name} (Alt+Shift+${n})` : ws.name}
								onDragStart={(e) => {
									setDragId(ws.id);
									e.dataTransfer.setData('application/x-jasper-workspace', ws.id);
									e.dataTransfer.effectAllowed = 'move';
								}}
								onDragOver={(e) => {
									if (dragId) e.preventDefault();
								}}
								onDrop={(e) => onDrop(e, ws.id)}
								onDragEnd={() => setDragId(null)}
								onClick={() => props.onSwitch(ws.id)}
								className={cx(
									'shrink-0 whitespace-nowrap px-2.5 font-pr text-[length:var(--pr-font-size-mode-tab)] outline-none focus-visible:bg-pr-hover',
									active
										? 'text-pr-accent shadow-[inset_0_-2px_0_var(--pr-accent)]'
										: 'text-pr-muted hover:text-pr-text',
									dragId === ws.id && 'opacity-50',
								)}
							>
								{ws.name}
							</button>
						</ContextMenu>
					);
				})}
			</div>
			{overflow ? (
				<DropdownMenu
					trigger={
						<IconButton icon="panel.overflow" label="More workspaces" size="small" className="self-center" />
					}
					items={props.list.map((ws) => ({
						type: 'item' as const,
						id: `ws-over-${ws.id}`,
						label: ws.name,
						checked: ws.id === props.activeId,
						onSelect: () => props.onSwitch(ws.id),
					}))}
				/>
			) : null}
		</div>
	);
}

// ------------------------------------------------------------------ engine chip (SH-030, HD-003)

function EngineChip() {
	const engine = useEngine();
	const { status, capabilities: caps } = engine;
	const label =
		status === 'connected'
			? caps?.engine.mode === 'remote'
				? 'Remote'
				: 'Local'
			: status === 'connecting'
				? 'Connecting'
				: 'Offline';
	const dot =
		status === 'connected' ? 'bg-pr-success' : status === 'connecting' ? 'bg-pr-warning' : 'bg-pr-danger';
	const rows: [string, ReactNode][] = [
		['Status', status],
		['Engine', engine.version ?? '—'],
		['FFmpeg', caps?.media?.ffmpegVersion ?? '—'],
		['Native export', caps ? (caps.render.native ? 'ready' : 'unavailable') : '—'],
		['Remotion render', caps?.render.remotionLocal ?? '—'],
		['fframes', caps?.render.fframes ?? '—'],
	];
	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<button
					type="button"
					data-testid="engine-chip"
					aria-label={`Engine: ${label}`}
					title="Engine status"
					className="inline-flex h-6 items-center gap-1.5 rounded-pr-control px-2 font-pr text-pr-ui text-pr-text hover:bg-pr-hover data-[state=open]:bg-pr-pressed"
				>
					<span className={cx('size-2 rounded-full', dot)} />
					{label}
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={4}
					className="z-[var(--pr-z-popover)] w-[280px] rounded-pr-menu border border-pr-menu-border bg-pr-menu p-3 font-pr text-pr-ui text-pr-text shadow-pr-overlay"
					data-testid="engine-popover"
				>
					<div className="mb-2 font-semibold text-pr-strong">Engine</div>
					<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
						{rows.map(([k, v]) => (
							<div key={k} className="contents">
								<dt className="text-pr-muted">{k}</dt>
								<dd className="truncate pr-tabular">{v}</dd>
							</div>
						))}
					</dl>
					{engine.capabilitiesError ? (
						<p className="mt-2 text-pr-small text-pr-muted">
							Capabilities unavailable ({engine.capabilitiesError}).
						</p>
					) : null}
					<div className="mt-3 flex gap-2">
						<button
							type="button"
							className="h-6 rounded-pr-control border border-pr-border-strong px-2.5 hover:bg-pr-hover"
							onClick={() => engine.refresh()}
						>
							Reconnect
						</button>
						<button
							type="button"
							disabled
							title="Remote engines arrive in M2"
							className="h-6 rounded-pr-control px-2.5 text-pr-dim"
						>
							Connect to engine…
						</button>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

function JobsButton({ projectId }: { projectId?: string }) {
	const { jobs } = useJobs({ projectId, activeOnly: true });
	// Badge = engine + client (upload) jobs that are running or queued (WP-2E summary, S05 header badge).
	const summary = useJobsSummary();
	const count = summary.running + summary.queued;
	const recent: ResolvedMenuItem[] = jobs.slice(-5).map((j) => ({
		type: 'item',
		id: `job-${j.id}`,
		label: `${j.kind} · ${j.state}${typeof j.progress === 'number' ? ` · ${Math.round(j.progress * 100)}%` : ''}`,
		disabled: true,
		onSelect: () => {},
	}));
	return (
		<ContextMenu
			items={recent.length ? recent : [{ type: 'label', id: 'none', label: 'No background jobs' }]}
		>
			<span
				className="inline-flex"
				data-testid="jobs-badge"
				data-active={count}
				data-failed={summary.failed}
				title={
					count
						? `${summary.running} running · ${summary.queued} queued${summary.progress !== null ? ` · ${Math.round(summary.progress * 100)}%` : ''}`
						: undefined
				}
			>
				<CommandIconButton
					id="panel.focus.jobs"
					label="Background Jobs"
					icon="app.jobs"
					badge={count || null}
					testId="jobs-button"
				/>
			</span>
		</ContextMenu>
	);
}

type AnyStore = { getState(): unknown; subscribe(l: (s: unknown, p: unknown) => void): () => void };
const NO_STORE: AnyStore = { getState: () => null, subscribe: () => () => {} };

/** Header save state (S05 header dirty/saving indicator): autosave status of the open session. */
function SaveStatus() {
	const session = useSessionOrNull();
	const status = usePersistenceStatus(session);
	const dirty = useStoreSelector(
		(session?.store ?? NO_STORE) as AnyStore,
		(s) => !!(s as { dirty?: boolean } | null)?.dirty,
	);
	if (!session) return null;
	const [label, tone] = status.conflict
		? ['Save conflict', 'text-pr-warning']
		: status.error
			? ['Save failed', 'text-pr-danger']
			: status.paused === 'read-only'
				? ['Read-only', 'text-pr-muted']
				: status.paused === 'lease-lost'
					? ['Not saving', 'text-pr-warning']
					: status.saving
						? ['Saving…', 'text-pr-muted']
						: dirty
							? ['Edited', 'text-pr-muted']
							: ['Saved', 'text-pr-dim'];
	const state = status.conflict
		? 'conflict'
		: status.error
			? 'error'
			: status.paused
				? status.paused
				: status.saving
					? 'saving'
					: dirty
						? 'dirty'
						: 'saved';
	return (
		<span
			className={cx('mr-1 inline-flex items-center gap-1 text-pr-small', tone)}
			data-testid="save-status"
			data-state={state}
			title={
				status.error ??
				(status.lastSavedAt ? `Last saved ${new Date(status.lastSavedAt).toLocaleTimeString()}` : undefined)
			}
		>
			{state === 'dirty' || state === 'saving' ? (
				<span className="size-1.5 rounded-full bg-pr-accent" aria-hidden />
			) : null}
			{label}
		</span>
	);
}

// ------------------------------------------------------------------ header

export type HeaderBarProps = {
	mode: ShellMode;
	onMode(m: ShellMode): void;
	store: WorkspaceStore;
	activeWorkspaceId: string;
	showWorkspaceTabs: boolean;
	workspaceMenu: ShellMenuItem[];
	menuEnv: Omit<MenuEnv, 'ctx'>;
	tabMenu(ws: WorkspaceRecord): ResolvedMenuItem[];
	onSwitchWorkspace(id: string): void;
	projectId?: string;
	fullscreen: boolean;
	/** Compact header: app menu + title merged into this row (HD-005). */
	leading?: ReactNode;
	center?: ReactNode;
};

export function HeaderBar(props: HeaderBarProps) {
	const getCtx = useCommandCtx();
	// Re-render on workspace list changes (order, names, visibility).
	useSyncExternalStore(props.store.subscribe, props.store.getState);
	const bar = props.store.barList();
	return (
		<div
			className="flex h-[var(--pr-header-h)] shrink-0 items-center gap-1 border-t border-pr-app bg-pr-header px-1.5"
			data-testid="header-bar"
		>
			{props.leading}
			<CommandIconButton id="app.goHome" label="Home" icon="app.home" testId="home-button" />
			<ModeTabs mode={props.mode} onMode={props.onMode} />
			<span className="mx-1 h-4 w-px shrink-0 bg-pr-border" />
			{props.mode === 'edit' && props.showWorkspaceTabs ? (
				<WorkspaceTabs
					store={props.store}
					activeId={props.activeWorkspaceId}
					list={bar}
					tabMenu={props.tabMenu}
					onSwitch={props.onSwitchWorkspace}
				/>
			) : (
				<div className="min-w-0" />
			)}
			<DropdownMenu
				trigger={
					<button
						type="button"
						aria-label="Workspaces menu"
						title="Workspaces"
						data-testid="workspaces-menu"
						className="inline-flex h-6 shrink-0 items-center gap-0.5 rounded-pr-control px-1 text-pr-icon hover:bg-pr-hover hover:text-pr-icon-hover data-[state=open]:bg-pr-pressed"
					>
						<Icon id="app.workspaces" size={16} />
						<Icon id="app.chevronDown" size={12} />
					</button>
				}
				items={() => resolveMenu(props.workspaceMenu, { ...props.menuEnv, ctx: getCtx() })}
			/>
			<div className="flex-1">{props.center}</div>
			<div className="flex shrink-0 items-center gap-0.5">
				<SaveStatus />
				<EngineChip />
				<JobsButton projectId={props.projectId} />
				<CommandIconButton
					id="export.quick"
					label="Quick Export"
					icon="app.quickExport"
					testId="quick-export"
				/>
				<CommandIconButton id="panel.focus.agent" label="Agent" icon="agent.sparkle" testId="agent-button" />
				<CommandIconButton
					id="palette.open"
					label="Command Palette"
					icon="app.search"
					testId="palette-button"
				/>
				<CommandIconButton
					id="view.fullscreen"
					label="Full Screen"
					icon={props.fullscreen ? 'app.exitFullscreen' : 'app.fullscreen'}
					testId="fullscreen-button"
				/>
			</div>
		</div>
	);
}

export function useFullscreen(): boolean {
	const [fs, setFs] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement);
	useEffect(() => {
		const on = () => setFs(!!document.fullscreenElement);
		document.addEventListener('fullscreenchange', on);
		return () => document.removeEventListener('fullscreenchange', on);
	}, []);
	return fs;
}
