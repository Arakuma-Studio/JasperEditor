// Converts workspace definitions into dockview's serialized layout and sanitizes stored layouts
// (S05:WS-003, SH-023, WS-014). Pure functions: unit-tested without a DOM.
import type { SerializedDockview } from 'dockview-react';
import { PANEL_KINDS, type PanelDefinition, type PanelKind } from '../../panels/types.ts';
import type { LayoutNode, LayoutSize, WorkspaceDefinition } from './definitions.ts';

/** Stable instance ids so a panel present in two workspaces keeps its state across switches (HD-010). */
export function instanceIdFor(kind: PanelKind, n = 1): string {
	return `${kind}-${n}`;
}

export const PANEL_COMPONENT = 'panel';
export const PANEL_TAB = 'panelTab';

/** Default minimum group size (S05:DK-003) unless the panel declares its own. */
const MIN_W = 120;
const MIN_H = 80;
/** Upper bounds for fixed-axis panels: Tools stays 40 px; meters resize 40–120 (MTR-001). */
/** (+4 px so the visible frame stays at the declared size inside a 3–4 px gutter.) */
const FIXED_MAX: Partial<Record<PanelKind, number>> = { tools: 44, audioMeters: 124 };
// dockview takes gap·(n−1)/n from each of n views in a row: 2.25 px for the 3 px gutter in the Editing
// bottom row (Project | Tools | Timeline | Meters). Rounding this up to 3 left Tools at 40.75 px (WS-003).
const GUTTER_ALLOWANCE = 2.25;

export function panelState(
	def: Pick<PanelDefinition, 'kind' | 'minSize' | 'fixedAxis' | 'keepAlive'>,
	title: string,
	id = instanceIdFor(def.kind),
) {
	// Fixed-width frames: the view includes its share of the gutter, so the visible frame keeps the size.
	const minW = def.fixedAxis === 'width' ? def.minSize.w + GUTTER_ALLOWANCE : Math.max(MIN_W, def.minSize.w);
	const minH = def.fixedAxis === 'height' ? def.minSize.h : Math.max(MIN_H, def.minSize.h);
	const maxW = def.fixedAxis === 'width' ? FIXED_MAX[def.kind] : undefined;
	return {
		id,
		contentComponent: PANEL_COMPONENT,
		tabComponent: PANEL_TAB,
		title,
		params: { kind: def.kind },
		minimumWidth: minW,
		minimumHeight: minH,
		...(maxW ? { maximumWidth: maxW } : {}),
		...(def.keepAlive ? { renderer: 'always' as const } : {}),
	};
}

/** Distributes `total` pixels over sizes: px first, fractions of `total`, `fill` takes the rest. */
export function distribute(sizes: readonly LayoutSize[], total: number): number[] {
	const out = sizes.map((s) =>
		typeof s === 'object' ? s.px : typeof s === 'number' ? Math.round(s * total) : 0,
	);
	const fixed = out.reduce((a, b) => a + b, 0);
	const fills = sizes.map((s, i) => (s === 'fill' ? i : -1)).filter((i) => i >= 0);
	const rest = Math.max(0, total - fixed);
	if (fills.length) {
		const each = Math.floor(rest / fills.length);
		fills.forEach((i, k) => {
			out[i] = k === fills.length - 1 ? rest - each * (fills.length - 1) : each;
		});
	} else if (out.length) {
		// No fill: give rounding error to the last proportional child.
		const last =
			sizes
				.map((s, i) => (typeof s === 'number' ? i : -1))
				.filter((i) => i >= 0)
				.pop() ?? out.length - 1;
		out[last] = (out[last] ?? 0) + (total - fixed);
	}
	return out;
}

type Serialized = SerializedDockview['grid']['root'];

/**
 * Builds a dockview layout for `def` at `size` (the dock area, WS-003). `panels` supplies definitions and
 * titles; kinds without a definition are skipped (SH-023).
 */
export function buildLayout(
	def: WorkspaceDefinition,
	size: { width: number; height: number },
	panels: ReadonlyMap<PanelKind, PanelDefinition>,
	titleOf: (kind: PanelKind) => string = (k) => panels.get(k)?.title({}) ?? k,
	/** Gap between groups (theme gutter): fixed px sizes are grown so the visible frame keeps its size. */
	gap = 0,
): SerializedDockview {
	const width = Math.max(320, Math.round(size.width));
	const height = Math.max(240, Math.round(size.height));
	const panelStates: SerializedDockview['panels'] = {};
	let groupSeq = 0;
	const rootOrientation = 'split' in def.layout && def.layout.split === 'column' ? 'VERTICAL' : 'HORIZONTAL';

	const node = (
		n: LayoutNode,
		orientation: 'HORIZONTAL' | 'VERTICAL',
		mainSize: number,
		crossSize: number,
	): Serialized | null => {
		if ('group' in n) {
			const kinds = n.group.filter((k) => panels.has(k));
			if (!kinds.length) return null;
			const views = kinds.map((k) => {
				const d = panels.get(k)!;
				const id = instanceIdFor(k);
				panelStates[id] = panelState(d, titleOf(k), id);
				return id;
			});
			const active = n.active && kinds.includes(n.active) ? instanceIdFor(n.active) : views[0];
			return {
				type: 'leaf',
				data: { views, activeView: active, id: `${def.id}-g${++groupSeq}` },
				size: mainSize,
			};
		}
		const expected = n.split === 'row' ? 'HORIZONTAL' : 'VERTICAL';
		if (expected !== orientation) throw new Error(`Workspace ${def.id}: nested ${n.split} must alternate`);
		const count = n.children.length;
		const marginShare = count > 1 ? (gap * (count - 1)) / count : 0;
		const sizes = distribute(
			n.children.map((c) => (typeof c.size === 'object' ? { px: c.size.px + marginShare } : c.size)),
			crossSize,
		);
		const children = n.children
			.map((c, i) =>
				node(c.node, orientation === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL', sizes[i] ?? 0, mainSize),
			)
			.filter((c): c is Serialized => c !== null);
		if (!children.length) return null;
		return { type: 'branch', data: children, size: mainSize };
	};

	// Root: its `size` is the orthogonal extent; children are laid along `orientation`.
	const rootMain = rootOrientation === 'HORIZONTAL' ? height : width;
	const rootCross = rootOrientation === 'HORIZONTAL' ? width : height;
	const root = node(def.layout, rootOrientation, rootMain, rootCross) ?? {
		type: 'branch',
		data: [],
		size: rootMain,
	};
	const wrapped: Serialized = root.type === 'leaf' ? { type: 'branch', data: [root], size: rootMain } : root;
	return {
		grid: { root: wrapped, width, height, orientation: rootOrientation as never },
		panels: panelStates,
	};
}

// ------------------------------------------------------------------ sanitize (SH-023, WS-014)

const KNOWN = new Set<string>(PANEL_KINDS);

type Leaf = {
	type: 'leaf';
	data: { views: string[]; activeView?: string; id: string };
	size: number;
	visible?: boolean;
};
type Branch = { type: 'branch'; data: (Leaf | Branch)[]; size: number; visible?: boolean };

function isObj(x: unknown): x is Record<string, unknown> {
	return !!x && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Validates a stored dockview layout and drops panels whose kind is unknown (their space goes to
 * neighbors). Returns null when the layout is unusable (caller falls back to the factory layout).
 */
export function sanitizeLayout(raw: unknown, known: ReadonlySet<string> = KNOWN): SerializedDockview | null {
	if (!isObj(raw) || !isObj(raw.grid) || !isObj(raw.panels)) return null;
	const grid = raw.grid as Record<string, unknown>;
	if (!isObj(grid.root) || typeof grid.width !== 'number' || typeof grid.height !== 'number') return null;
	if (grid.orientation !== 'HORIZONTAL' && grid.orientation !== 'VERTICAL') return null;
	const panels: Record<string, unknown> = {};
	for (const [id, p] of Object.entries(raw.panels as Record<string, unknown>)) {
		if (!isObj(p) || typeof p.id !== 'string') continue;
		const kind = isObj(p.params) ? p.params.kind : undefined;
		if (typeof kind !== 'string' || !known.has(kind)) continue;
		panels[id] = p;
	}
	const clean = (n: unknown): Leaf | Branch | null => {
		if (!isObj(n) || typeof n.size !== 'number') return null;
		if (n.type === 'leaf') {
			if (!isObj(n.data) || !Array.isArray(n.data.views) || typeof n.data.id !== 'string') return null;
			const views = (n.data.views as unknown[]).filter(
				(v): v is string => typeof v === 'string' && v in panels,
			);
			if (!views.length) return null;
			const active =
				typeof n.data.activeView === 'string' && views.includes(n.data.activeView)
					? n.data.activeView
					: views[0];
			return { ...(n as Leaf), data: { ...(n.data as Leaf['data']), views, activeView: active } };
		}
		if (n.type === 'branch' && Array.isArray(n.data)) {
			const kids = n.data.map(clean).filter((c): c is Leaf | Branch => c !== null);
			if (!kids.length) return null;
			return { ...(n as Branch), data: kids };
		}
		return null;
	};
	const root = clean(grid.root);
	const floating = Array.isArray(raw.floatingGroups)
		? (raw.floatingGroups as unknown[]).flatMap((f) => {
				if (!isObj(f) || !isObj(f.data)) return [];
				const views = Array.isArray(f.data.views)
					? (f.data.views as unknown[]).filter((v): v is string => typeof v === 'string' && v in panels)
					: [];
				if (!views.length) return [];
				return [
					{
						...f,
						data: {
							...f.data,
							views,
							activeView: views.includes(f.data.activeView as string) ? f.data.activeView : views[0],
						},
					},
				];
			})
		: undefined;
	if (!root && !floating?.length) return null;
	const rootNode: Branch =
		root === null
			? {
					type: 'branch',
					data: [],
					size: grid.orientation === 'HORIZONTAL' ? (grid.height as number) : (grid.width as number),
				}
			: root.type === 'leaf'
				? { type: 'branch', data: [root], size: root.size }
				: root;
	// Drop panels no group references (orphans would be created detached).
	const referenced = new Set<string>();
	const collect = (n: Leaf | Branch) => {
		if (n.type === 'leaf') for (const v of n.data.views) referenced.add(v);
		else for (const c of n.data) collect(c);
	};
	collect(rootNode);
	for (const f of floating ?? []) for (const v of (f.data as { views: string[] }).views) referenced.add(v);
	for (const id of Object.keys(panels)) if (!referenced.has(id)) delete panels[id];
	const out: Record<string, unknown> = {
		grid: { ...grid, root: rootNode },
		panels,
	};
	if (floating?.length) out.floatingGroups = floating;
	if (typeof raw.activeGroup === 'string') out.activeGroup = raw.activeGroup;
	return out as unknown as SerializedDockview;
}

/** Panel kinds present in a serialized layout. */
export function kindsInLayout(layout: SerializedDockview): PanelKind[] {
	return Object.values(layout.panels)
		.map((p) => (p.params as { kind?: PanelKind } | undefined)?.kind)
		.filter((k): k is PanelKind => !!k);
}
