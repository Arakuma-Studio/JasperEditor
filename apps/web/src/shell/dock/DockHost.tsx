// Dock host (S05 §5–§6, ARCHITECTURE §7.1): dockview-react themed through packages/ui dockview.css;
// panels come from the panel registry; Program and Timeline are keep-alive (renderer "always", SH-006);
// every panel has an error boundary (PC-032) and receives `visible` (SH-007). Tabs follow PC-001…009:
// context titles, the ≡ panel menu on the active tab, × on hover, middle-click close, overflow list,
// attention dot; the empty workspace shows DK-043; a maximized group shows a Restore button (DK-041).
import type { SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import {
	ContextMenu,
	cx,
	DropdownMenu,
	EmptyState,
	Icon,
	IconButton,
	PanelErrorBoundary,
	type ResolvedMenuItem,
} from '@jasper/ui';
import {
	DockviewReact,
	type DockviewReadyEvent,
	type DockviewTheme,
	type IDockviewHeaderActionsProps,
	type IDockviewPanelHeaderProps,
	type IDockviewPanelProps,
	type IWatermarkPanelProps,
} from 'dockview-react';
import {
	createContext,
	type MouseEvent,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { sourceMonitorState } from '../../panels/source/source-state.ts';
import type { PanelDefinition, PanelKind, PanelTitleContext } from '../../panels/types.ts';
import { useCommandCtx, useShellRuntime } from '../context.tsx';
import { PANEL_INSTANCE_ATTR, PANEL_KIND_ATTR } from '../focus.ts';
import { activeSequenceName } from '../header/TitleBar.tsx';
import { type MenuEnv, resolveMenu, type ShellMenuItem } from '../menus/resolve.ts';
import { useUiPrefs } from '../prefs.ts';
import { PANEL_COMPONENT, PANEL_TAB } from '../workspaces/layout.ts';
import type { DockController } from './controller.ts';

type DockCtx = {
	controller: DockController;
	panels: ReadonlyMap<PanelKind, PanelDefinition>;
	providers: MenuEnv['providers'];
	windowMenu: ShellMenuItem[];
};
const DockContext = createContext<DockCtx | null>(null);
function useDock(): DockCtx {
	const d = useContext(DockContext);
	if (!d) throw new Error('DockContext missing');
	return d;
}

// ------------------------------------------------------------------ attention dots (PC-009)

const attention = new Set<PanelKind>();
const attentionListeners = new Set<() => void>();
let attentionVersion = 0;
/** Marks an inactive tab (new agent message, finished job); cleared when the tab becomes active. */
export function setPanelAttention(kind: PanelKind, on = true): void {
	if (on === attention.has(kind)) return;
	if (on) attention.add(kind);
	else attention.delete(kind);
	attentionVersion++;
	for (const l of [...attentionListeners]) l();
}
function useAttention(kind: PanelKind): boolean {
	useSyncExternalStore(
		(l) => {
			attentionListeners.add(l);
			return () => attentionListeners.delete(l);
		},
		() => attentionVersion,
	);
	return attention.has(kind);
}

// ------------------------------------------------------------------ titles (PC-002)

function useTitleContext(params: Record<string, unknown> | undefined): PanelTitleContext {
	const session = useSessionOrNull();
	const sequenceName = useStoreSelector(session?.store ?? NULL_STORE, (s: SessionState | null) =>
		activeSequenceName(s),
	);
	// "Source: <clip>" tab label (S05:PC-002): the item open in the Source monitor.
	const sourceItemId = useStoreSelector(sourceMonitorState, (s) => s.itemId);
	const sourceName = useStoreSelector(session?.store ?? NULL_STORE, (s: SessionState | null) =>
		sourceItemId && s ? (s.document.items[sourceItemId]?.name ?? null) : null,
	);
	return { params, sequenceName, sourceName };
}
const NULL_STORE = { getState: (): SessionState | null => null, subscribe: () => () => {} };

function panelTitle(def: PanelDefinition | undefined, ctx: PanelTitleContext, fallback: string): string {
	if (!def) return fallback;
	try {
		return def.title(ctx);
	} catch {
		return fallback;
	}
}

// ------------------------------------------------------------------ panel menu (PC-010/011)

function usePanelMenu(instanceId: string, def: PanelDefinition | undefined): () => ResolvedMenuItem[] {
	const { controller } = useDock();
	const runtime = useShellRuntime();
	const getCtx = useCommandCtx();
	return () => {
		const env: MenuEnv = {
			ctx: getCtx(),
			platform: runtime.platform,
			runtime: runtime.runtime,
			run: (id, args) => void runtime.run(id, args),
		};
		const specific = def?.menu?.length
			? resolveMenu(def.menu as ShellMenuItem[], env, `pm.${instanceId}`)
			: [];
		const item = (
			id: string,
			label: string,
			onSelect: () => void,
			extra: Partial<Extract<ResolvedMenuItem, { type: 'item' }>> = {},
		): ResolvedMenuItem => ({
			type: 'item',
			id: `${instanceId}.${id}`,
			label,
			onSelect,
			...extra,
		});
		const maximized = controller.isMaximized();
		const common: ResolvedMenuItem[] = [
			item('undock', 'Undock Panel', () => controller.float(instanceId)),
			item('undockOthers', 'Undock Other Panels in Group', () => controller.floatOthers(instanceId)),
			{ type: 'separator', id: `${instanceId}.s2` },
			item('close', 'Close Panel', () => controller.close(instanceId), {
				shortcut: runtime.runtime === 'desktop' ? 'Ctrl+W' : 'Alt+W',
			}),
			item('closeOthers', 'Close Other Panels in Group', () => controller.closeOthers(instanceId)),
			{
				type: 'submenu',
				id: `${instanceId}.group`,
				label: 'Panel Group Settings',
				items: [
					item('closeGroup', 'Close Panel Group', () => controller.closeGroup(instanceId)),
					item('undockGroup', 'Undock Panel Group', () => controller.floatGroup(instanceId)),
					item(
						'maximize',
						maximized ? 'Restore Panel Group' : 'Maximize Panel Group',
						() => controller.toggleMaximize('focused', instanceId),
						{ shortcut: 'Shift+`' },
					),
				],
			},
		];
		return specific.length ? [...specific, { type: 'separator', id: `${instanceId}.s1` }, ...common] : common;
	};
}

// ------------------------------------------------------------------ tab

function PanelTab(props: IDockviewPanelHeaderProps<{ kind: PanelKind }>) {
	const { panels, controller } = useDock();
	const kind = props.params.kind;
	const def = panels.get(kind);
	const title = panelTitle(def, useTitleContext(props.params), props.api.title ?? kind);
	const [active, setActive] = useState(props.api.isVisible);
	const attn = useAttention(kind);
	const menu = usePanelMenu(props.api.id, def);
	// Fixed-width strips (Tools 40 px, Audio Meters 52 px): the title cannot fit, so the tab shows only the
	// centered panel-menu glyph, as in Premiere; the title stays available as tooltip and aria-label.
	const narrow = def?.fixedAxis === 'width';

	useEffect(() => {
		const d = props.api.onDidVisibilityChange((e) => setActive(e.isVisible));
		setActive(props.api.isVisible);
		return () => d.dispose();
	}, [props.api]);
	useEffect(() => {
		if (active && attn) setPanelAttention(kind, false);
	}, [active, attn, kind]);
	useEffect(() => {
		if (props.api.title !== title) props.api.setTitle(title);
	}, [props.api, title]);

	const onAux = (e: MouseEvent) => {
		if (e.button === 1) {
			e.preventDefault();
			controller.close(props.api.id);
		}
	};

	return (
		<ContextMenu items={menu}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: middle-click closes a tab (PC-006); the dock tab owns keyboard focus */}
			<div
				{...{ [PANEL_INSTANCE_ATTR]: props.api.id, [PANEL_KIND_ATTR]: kind }}
				data-testid={`tab-${kind}`}
				title={title}
				onAuxClick={onAux}
				onMouseDown={(e) => e.button === 1 && e.preventDefault()}
				className={cx(
					'group/tab flex h-full max-w-[220px] min-w-0 items-center gap-1 overflow-hidden font-pr text-pr-ui select-none',
					narrow ? 'justify-center px-1' : 'pr-1 pl-3',
					active ? 'text-pr-strong' : 'text-pr-muted hover:text-pr-text',
				)}
			>
				<span className={narrow ? 'sr-only' : 'truncate'}>{title}</span>
				{attn && !active ? (
					<span className="size-1.5 shrink-0 rounded-full bg-pr-accent" data-testid="tab-attention" />
				) : null}
				{active && props.tabLocation === 'header' ? (
					<DropdownMenu
						items={menu}
						trigger={
							<button
								type="button"
								aria-label={`${title} panel menu`}
								data-testid={`panel-menu-${kind}`}
								onPointerDown={(e) => e.stopPropagation()}
								className="inline-flex size-4 shrink-0 items-center justify-center rounded-[2px] text-pr-icon hover:bg-pr-hover hover:text-pr-icon-hover"
							>
								<Icon id="panel.menu" size={14} />
							</button>
						}
					/>
				) : null}
				<button
					type="button"
					aria-label={`Close ${title}`}
					onPointerDown={(e) => e.stopPropagation()}
					onClick={(e) => {
						e.stopPropagation();
						controller.close(props.api.id);
					}}
					className={cx(
						'inline-flex size-4 shrink-0 items-center justify-center rounded-[2px] text-pr-icon opacity-0 group-hover/tab:opacity-100 hover:bg-pr-hover focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100',
						narrow ? 'hidden' : '',
					)}
				>
					<Icon id="app.close" size={12} />
				</button>
			</div>
		</ContextMenu>
	);
}

// ------------------------------------------------------------------ panel body

function PanelContent(props: IDockviewPanelProps<{ kind: PanelKind } & Record<string, unknown>>) {
	const { panels } = useDock();
	const kind = props.params.kind;
	const def = panels.get(kind);
	const [visible, setVisible] = useState(props.api.isVisible);
	useEffect(() => {
		const d = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
		setVisible(props.api.isVisible);
		return () => d.dispose();
	}, [props.api]);
	const Component = def?.component;
	const title = def ? panelTitle(def, {}, kind) : kind;
	return (
		<div
			{...{ [PANEL_INSTANCE_ATTR]: props.api.id, [PANEL_KIND_ATTR]: kind }}
			data-slot={kind}
			data-panel-body=""
			data-visible={visible}
			tabIndex={-1}
			className="relative h-full w-full overflow-hidden bg-pr-panel text-pr-text outline-none"
		>
			{Component ? (
				<PanelErrorBoundary name={title}>
					<Component instanceId={props.api.id} visible={visible} params={props.params} />
				</PanelErrorBoundary>
			) : (
				<EmptyState icon="status.warning" message={`Unknown panel “${kind}”`} />
			)}
		</div>
	);
}

// ------------------------------------------------------------------ header actions + watermark

function HeaderActions(props: IDockviewHeaderActionsProps) {
	const [maximized, setMaximized] = useState(() => props.api.isMaximized());
	useEffect(() => {
		const d = props.containerApi.onDidMaximizedGroupChange(() => setMaximized(props.api.isMaximized()));
		return () => d.dispose();
	}, [props.api, props.containerApi]);
	if (!maximized) return null;
	return (
		<div className="flex h-full items-center pr-1">
			<IconButton
				icon="app.restore"
				label="Restore Panel Group"
				shortcut="`"
				size="small"
				onClick={() => props.api.exitMaximized()}
				data-testid="restore-maximized"
			/>
		</div>
	);
}

function EmptyWorkspace(_props: IWatermarkPanelProps) {
	const runtime = useShellRuntime();
	const getCtx = useCommandCtx();
	const { windowMenu, providers } = useDock();
	return (
		<div
			className="flex h-full w-full flex-col items-center justify-center gap-3 bg-pr-app"
			data-testid="empty-workspace"
		>
			<EmptyState
				icon="app.workspaces"
				message="No panels open"
				detail="Drop a panel here, reset the layout, or open panels from the Window menu."
				action={{ label: 'Reset to Saved Layout', onClick: () => void runtime.run('workspace.reset') }}
				className="h-auto"
			/>
			<DropdownMenu
				trigger={
					<button
						type="button"
						className="h-6 rounded-pr-control border border-pr-border-strong px-2.5 font-pr text-pr-ui text-pr-text hover:bg-pr-hover"
					>
						Window menu
					</button>
				}
				items={() =>
					resolveMenu(windowMenu, {
						ctx: getCtx(),
						platform: runtime.platform,
						runtime: runtime.runtime,
						run: (id, args) => void runtime.run(id, args),
						providers,
					})
				}
			/>
		</div>
	);
}

const COMPONENTS = { [PANEL_COMPONENT]: PanelContent };
const TABS = { [PANEL_TAB]: PanelTab };

// ------------------------------------------------------------------ host

export type DockHostProps = {
	controller: DockController;
	panels: ReadonlyMap<PanelKind, PanelDefinition>;
	/** Effective workspace id (the active one, or `compact` in the compact layout). */
	workspaceId: string;
	providers: MenuEnv['providers'];
	windowMenu: ShellMenuItem[];
	onReady?(): void;
};

export function DockHost({ controller, panels, workspaceId, providers, windowMenu, onReady }: DockHostProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const { contrast } = useUiPrefs();
	// Gutters are real gaps between groups: 3 px, 4 px in high contrast (DK-002, §8.2).
	controller.gap = contrast === 'high' ? 4 : 3;
	const theme = useMemo<DockviewTheme>(
		() => ({
			name: 'jasper',
			className: 'dockview-theme-jasper',
			colorScheme: 'dark',
			gap: contrast === 'high' ? 4 : 3,
			dndOverlayMounting: 'absolute',
			dndPanelOverlay: 'group',
			dndTabIndicator: 'line',
			dndOverlayBorder: '2px solid var(--pr-accent)',
		}),
		[contrast],
	);
	const wsRef = useRef(workspaceId);
	wsRef.current = workspaceId;
	const ctx = useMemo(
		() => ({ controller, panels, providers, windowMenu }),
		[controller, panels, providers, windowMenu],
	);

	const ready = (e: DockviewReadyEvent) => {
		controller.attach(e.api, hostRef.current);
		controller.apply(wsRef.current);
		onReady?.();
	};

	useEffect(() => {
		if (controller.api && controller.currentWorkspaceId !== workspaceId) controller.apply(workspaceId);
	}, [controller, workspaceId]);

	useEffect(() => () => controller.detach(), [controller]);

	// Double-click on the empty part of a tab strip toggles maximize (PC-008).
	const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
		const t = e.target as HTMLElement;
		if (!t.closest('.dv-void-container')) return;
		const groupEl = t.closest('.dv-groupview');
		const group = controller.api?.groups.find((g) => (g.element as HTMLElement).contains(groupEl));
		const panel = group?.activePanel;
		if (panel) controller.toggleMaximize('focused', panel.id);
	};

	return (
		<DockContext.Provider value={ctx}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: double-click on tab strips is a pointer shortcut for Shift+` */}
			<div
				ref={hostRef}
				className="dock-host relative h-full w-full"
				data-testid="dock-host"
				onDoubleClick={onDoubleClick}
			>
				<DockviewReact
					className="dockview-theme-jasper h-full w-full"
					components={COMPONENTS}
					tabComponents={TABS}
					defaultTabComponent={PanelTab}
					rightHeaderActionsComponent={HeaderActions}
					watermarkComponent={EmptyWorkspace}
					onReady={ready}
					floatingGroupBounds="boundedWithinViewport"
					keyboardNavigation={false}
					singleTabMode="default"
					theme={theme}
				/>
			</div>
		</DockContext.Provider>
	);
}
