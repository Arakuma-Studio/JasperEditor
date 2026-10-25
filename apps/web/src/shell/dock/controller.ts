// Dock controller (S05 §5, ARCHITECTURE §7.1): wraps the dockview API with the shell's semantics —
// apply a workspace layout (reusing panel instances, HD-010), open panels in their home group
// (DK-050/051), maximize/restore without mutating the tree (DK-040/041), float, close, focus cycling in
// reading order (FO-003), and layout-change persistence (WS-011, SH-022).
import type { DockviewApi, IDockviewPanel, SerializedDockview } from 'dockview-react';
import type { PanelDefinition, PanelKind } from '../../panels/types.ts';
import { focusStore, PANEL_INSTANCE_ATTR, panelUnderPointer, pointer } from '../focus.ts';
import { builtinWorkspace, DEFAULT_WORKSPACE_ID, type LayoutNode } from '../workspaces/definitions.ts';
import {
	buildLayout,
	instanceIdFor,
	PANEL_COMPONENT,
	PANEL_TAB,
	panelState,
	sanitizeLayout,
} from '../workspaces/layout.ts';
import type { WorkspaceStore } from '../workspaces/store.ts';

export type DockEvents = {
	/** A stored layout could not be applied and the factory layout was used instead. */
	onLayoutFallback?(workspaceId: string): void;
};

function kindOf(p: IDockviewPanel): PanelKind | null {
	return ((p.params as { kind?: PanelKind } | undefined)?.kind ?? null) as PanelKind | null;
}

function groupElement(p: IDockviewPanel): HTMLElement | null {
	const el = p.group?.element as HTMLElement | undefined;
	if (!el) return null;
	return el.classList.contains('dv-groupview')
		? el
		: ((el.querySelector('.dv-groupview') as HTMLElement | null) ?? el);
}

/**
 * polish: dockview names a floating group (`role="dialog"`) after its panel's title once, when the group is created;
 * keep that name on the title the tab shows (another UI language, a context title).
 */
export function labelFloatingGroup(p: IDockviewPanel, title: string): void {
	if (p.group?.activePanel && p.group.activePanel.id !== p.id) return;
	const floating = p.group?.element?.closest?.('.dv-resize-container');
	if (floating && floating.getAttribute('aria-label') !== title) floating.setAttribute('aria-label', title);
}

/** Groups (by panel kind) of a layout definition, used to find a closed panel's home group. */
function homeGroups(node: LayoutNode): PanelKind[][] {
	if ('group' in node) return [node.group];
	return node.children.flatMap((c) => homeGroups(c.node));
}

/** The panels a definition prefers to dock next to, in order. */
function dockNeighbours(def: Pick<PanelDefinition, 'dockWith'>): readonly PanelKind[] {
	const d = def.dockWith;
	return d === undefined ? [] : typeof d === 'string' ? [d] : d;
}

export class DockController {
	api: DockviewApi | null = null;
	private host: HTMLElement | null = null;
	private workspaceId = DEFAULT_WORKSPACE_ID;
	private applying = 0;
	private readonly disposers: (() => void)[] = [];
	private focusedGroupEl: HTMLElement | null = null;
	/** Theme gutter in px (set by the dock host). */
	gap = 3;

	constructor(
		private readonly store: WorkspaceStore,
		private readonly panels: ReadonlyMap<PanelKind, PanelDefinition>,
		private readonly events: DockEvents = {},
	) {}

	attach(api: DockviewApi, host: HTMLElement | null): void {
		this.detach();
		this.api = api;
		this.host = host;
		this.disposers.push(
			api.onDidLayoutChange(() => {
				if (this.applying || !this.api) return;
				this.store.setCurrent(this.workspaceId, this.api.toJSON());
			}).dispose,
		);
		this.disposers.push(
			api.onDidMaximizedGroupChange((e) => {
				this.host?.classList.toggle('pr-maximized', e.isMaximized);
			}).dispose,
		);
		// A panel closed by dockview itself (tab ×, group close, layout switch) must not stay focused:
		// its scope would keep winning key resolution and panel.close/float would target nothing.
		this.disposers.push(
			api.onDidRemovePanel((p) => {
				if (focusStore.getState().instanceId === p.id) focusStore.clear();
			}).dispose,
		);
		const unsub = focusStore.subscribe(() => this.syncFocusOutline());
		this.disposers.push(unsub);
	}

	detach(): void {
		for (const d of this.disposers.splice(0)) d();
		this.api = null;
	}

	get currentWorkspaceId(): string {
		return this.workspaceId;
	}

	/** Dock area size used for factory layouts (WS-003). */
	size(): { width: number; height: number } {
		const w =
			this.api?.width || this.host?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1600);
		const h =
			this.api?.height ||
			this.host?.clientHeight ||
			(typeof window !== 'undefined' ? window.innerHeight - 64 : 900);
		return { width: w || 1600, height: h || 900 };
	}

	private definitionFor(id: string) {
		return builtinWorkspace(id) ?? builtinWorkspace(DEFAULT_WORKSPACE_ID)!;
	}

	/** The factory layout of a workspace at the current dock size. */
	factoryLayout(id: string): SerializedDockview {
		const def = this.definitionFor(id);
		return buildLayout({ ...def, id }, this.size(), this.panels, undefined, this.gap);
	}

	/** Applies a workspace: its current layout (or `layout`), falling back to the factory layout. */
	apply(id: string, layout?: SerializedDockview | null): void {
		const api = this.api;
		if (!api) return;
		const record = this.store.get(id);
		const stored = layout === undefined ? (record?.current ?? null) : layout;
		const known = new Set<string>([...this.panels.keys()]);
		let json = stored ? sanitizeLayout(stored, known) : null;
		const usedFallback = !!stored && !json;
		const factory = !json;
		json ??= this.factoryLayout(id);
		this.applying++;
		try {
			if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
			try {
				api.fromJSON(json, { reuseExistingPanels: true });
			} catch (e) {
				console.warn('[dock] layout could not be applied, using the factory layout', e);
				api.fromJSON(this.factoryLayout(id), { reuseExistingPanels: true });
				this.events.onLayoutFallback?.(id);
			}
			// Re-fit to the real size: stored layouts may come from another window size (DK-013).
			const { width, height } = this.size();
			if (width && height) api.layout(width, height, true);
			this.syncTitles();
		} finally {
			this.applying--;
		}
		if (factory) this.pinFixedWidths(id);
		if (usedFallback) this.events.onLayoutFallback?.(id);
		this.workspaceId = id;
		if (!record?.current) this.store.setCurrent(id, api.toJSON());
		this.syncFocusOutline();
	}

	/**
	 * Factory layouts: make fixed-size frames exactly their declared pixel width after dockview applied
	 * gutters and proportional rounding (Tools 40 px, Audio Meters 52 px; WS-003).
	 */
	private pinFixedWidths(id: string): void {
		const api = this.api;
		if (!api) return;
		const wanted = new Map<PanelKind, number>();
		const walk = (n: LayoutNode) => {
			if ('group' in n) return;
			for (const c of n.children) {
				if (typeof c.size === 'object' && 'group' in c.node && c.node.group.length === 1 && n.split === 'row')
					wanted.set(c.node.group[0] as PanelKind, c.size.px);
				walk(c.node);
			}
		};
		walk(this.definitionFor(id).layout);
		// Resizing one frame can nudge its neighbors, so settle in a few passes.
		for (let pass = 0; pass < 3; pass++) {
			let changed = false;
			for (const [kind, px] of wanted) {
				const panel = this.panelOf(kind);
				const el = panel ? groupElement(panel) : null;
				const actual = el?.getBoundingClientRect().width ?? 0;
				if (!panel || !actual || Math.abs(actual - px) < 0.5) continue;
				panel.group.api.setSize({ width: panel.group.api.width + (px - actual) });
				changed = true;
			}
			if (!changed) break;
		}
	}

	currentLayout(): SerializedDockview | null {
		return this.api?.toJSON() ?? null;
	}

	panelOf(kind: PanelKind): IDockviewPanel | undefined {
		return this.api?.panels.find((p) => kindOf(p) === kind);
	}

	isOpen(kind: PanelKind): boolean {
		return !!this.panelOf(kind);
	}

	/**
	 * polish: stored layouts carry the panel titles of the moment they were saved (another UI language, an older
	 * name). Titles come from the panel definitions; visible tabs then add their context ("Program: Sequence 01").
	 */
	private syncTitles(): void {
		for (const p of this.api?.panels ?? []) {
			const kind = kindOf(p);
			const def = kind ? this.panels.get(kind) : undefined;
			if (!def) continue;
			let title: string;
			try {
				title = def.title({ params: p.params as Record<string, unknown> | undefined });
			} catch {
				continue;
			}
			if (title && p.title !== title) p.api.setTitle(title);
			if (title) labelFloatingGroup(p, title);
		}
	}

	/** Opens a closed panel in its home group, else as a floating group near the center (DK-050). */
	open(kind: PanelKind): IDockviewPanel | undefined {
		const api = this.api;
		const def = this.panels.get(kind);
		if (!api || !def) return undefined;
		const existing = this.panelOf(kind);
		if (existing) return existing;
		const state = panelState(def, def.title({}), instanceIdFor(kind));
		const base = {
			id: state.id,
			component: PANEL_COMPONENT,
			tabComponent: PANEL_TAB,
			title: state.title,
			params: state.params,
			renderer: state.renderer,
			minimumWidth: state.minimumWidth,
			minimumHeight: state.minimumHeight,
			maximumWidth: state.maximumWidth,
		};
		const peers = homeGroups(this.definitionFor(this.workspaceId).layout).find((g) => g.includes(kind)) ?? [];
		const peer = peers.map((k) => this.panelOf(k)).find(Boolean);
		if (peer) return api.addPanel({ ...base, position: { referencePanel: peer.id, direction: 'within' } });
		// polish: a panel the workspace has no place for docks next to its first preferred neighbour that is open.
		const neighbour = dockNeighbours(def)
			.map((k) => this.panelOf(k))
			.find(Boolean);
		if (neighbour)
			return api.addPanel({ ...base, position: { referencePanel: neighbour.id, direction: 'within' } });
		if (api.panels.length === 0) return api.addPanel(base);
		const { width, height } = this.size();
		const w = Math.min(560, Math.max(def.minSize.w, 360));
		const h = Math.min(420, Math.max(def.minSize.h, 260));
		return api.addPanel({
			...base,
			floating: { x: Math.max(0, (width - w) / 2), y: Math.max(0, (height - h) / 3), width: w, height: h },
		});
	}

	/** Brings a panel to front, focuses it and moves DOM focus into it (DK-050/051, FO-001). */
	focus(kind: PanelKind): boolean {
		const panel = this.panelOf(kind) ?? this.open(kind);
		if (!panel) return false;
		if (this.api?.hasMaximizedGroup() && !panel.api.isMaximized()) this.api.exitMaximizedGroup();
		panel.api.setActive();
		focusStore.focus(panel.id, kind);
		this.focusDom(panel.id);
		return true;
	}

	focusInstance(instanceId: string): void {
		const panel = this.api?.getPanel(instanceId);
		const kind = panel ? kindOf(panel) : null;
		if (!panel || !kind) return;
		panel.api.setActive();
		focusStore.focus(panel.id, kind);
		this.focusDom(panel.id);
	}

	private focusDom(instanceId: string) {
		const doc = this.host?.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
		const run = () => {
			const el = doc?.querySelector<HTMLElement>(
				`[${PANEL_INSTANCE_ATTR}="${CSS.escape(instanceId)}"][data-panel-body]`,
			);
			if (!el || el.contains(doc?.activeElement ?? null)) return;
			const target = el.querySelector<HTMLElement>('[autofocus],[data-panel-autofocus]') ?? el;
			target.focus({ preventScroll: true });
		};
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
		else run();
	}

	close(instanceId?: string): void {
		const id = instanceId ?? focusStore.getState().instanceId;
		const panel = id ? this.api?.getPanel(id) : undefined;
		if (!panel) return;
		panel.api.close();
		if (focusStore.getState().instanceId === id) focusStore.clear();
	}

	float(instanceId?: string): void {
		const id = instanceId ?? focusStore.getState().instanceId;
		const panel = id ? this.api?.getPanel(id) : undefined;
		if (!panel || !this.api) return;
		const { width, height } = this.size();
		this.api.addFloatingGroup(panel, {
			x: width / 4,
			y: height / 5,
			width: Math.min(560, width / 2),
			height: Math.min(420, height / 2),
		});
	}

	/** Floats every other panel of the group (Undock Other Panels in Group). */
	floatOthers(instanceId: string): void {
		const panel = this.api?.getPanel(instanceId);
		for (const p of [...(panel?.group.panels ?? [])]) if (p.id !== instanceId) this.float(p.id);
	}

	closeOthers(instanceId: string): void {
		const panel = this.api?.getPanel(instanceId);
		for (const p of [...(panel?.group.panels ?? [])]) if (p.id !== instanceId) p.api.close();
	}

	closeGroup(instanceId: string): void {
		const panel = this.api?.getPanel(instanceId);
		panel?.group.api.close();
	}

	floatGroup(instanceId: string): void {
		const panel = this.api?.getPanel(instanceId);
		if (panel && this.api) {
			const { width, height } = this.size();
			this.api.addFloatingGroup(panel.group, {
				x: width / 4,
				y: height / 5,
				width: Math.min(640, width / 2),
				height: Math.min(480, height / 2),
			});
		}
	}

	isMaximized(): boolean {
		return !!this.api?.hasMaximizedGroup();
	}

	/** Maximize toggle for the group under the pointer or the focused group (DK-040). */
	toggleMaximize(target: 'pointer' | 'focused', instanceId?: string): boolean {
		const api = this.api;
		if (!api) return false;
		if (api.hasMaximizedGroup()) {
			api.exitMaximizedGroup();
			return false;
		}
		let panel: IDockviewPanel | undefined;
		if (instanceId) panel = api.getPanel(instanceId);
		else if (target === 'pointer') {
			const hit = panelUnderPointer(this.host?.ownerDocument ?? document);
			panel = hit ? api.getPanel(hit.instanceId) : this.groupAtPointer();
		}
		if (!panel) {
			const f = focusStore.getState().instanceId;
			panel = f ? api.getPanel(f) : api.activePanel;
		}
		if (panel?.group.api.location.type !== 'grid') return false;
		const active = panel.group.activePanel ?? panel;
		api.maximizeGroup(active);
		return api.hasMaximizedGroup();
	}

	private groupAtPointer(): IDockviewPanel | undefined {
		if (!this.api || pointer.x < 0) return undefined;
		for (const g of this.api.groups) {
			const r = (g.element as HTMLElement).getBoundingClientRect();
			if (pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom)
				return g.activePanel;
		}
		return undefined;
	}

	/** Visible panels in reading order (top-left → bottom-right by group center, FO-003). */
	readingOrder(): IDockviewPanel[] {
		const api = this.api;
		if (!api) return [];
		const groups = api.groups
			.filter((g) => g.activePanel)
			.map((g) => {
				const r = (g.element as HTMLElement).getBoundingClientRect();
				return { g, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
			})
			.sort((a, b) => (Math.abs(a.cy - b.cy) > 24 ? a.cy - b.cy : a.cx - b.cx));
		return groups.map((x) => x.g.activePanel!).filter(Boolean);
	}

	cycleFocus(direction: 1 | -1): void {
		const order = this.readingOrder();
		if (!order.length) return;
		const cur = focusStore.getState().instanceId;
		const i = order.findIndex((p) => p.id === cur);
		// Nothing focused: forward starts at the first panel, backward at the last.
		const at =
			i < 0 ? (direction === 1 ? 0 : order.length - 1) : (i + direction + order.length) % order.length;
		const next = order[at] ?? order[0];
		if (next) this.focusInstance(next.id);
	}

	/** Paints the 1 px focus outline on the focused group only (FO-002). */
	syncFocusOutline(): void {
		const id = focusStore.getState().instanceId;
		const panel = id ? this.api?.getPanel(id) : undefined;
		const el = panel ? groupElement(panel) : null;
		if (el === this.focusedGroupEl) return;
		this.focusedGroupEl?.classList.remove('pr-focused');
		el?.classList.add('pr-focused');
		this.focusedGroupEl = el;
	}
}
