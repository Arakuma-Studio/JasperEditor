// Migrations of the stored workspace state (S05:SH-020; `loadVersioned` runs them for `jasper:workspaces`).
// Each step takes the payload stored at version n to n + 1 and never throws on malformed data: what it cannot read it
// leaves alone, and `parseWorkspacesState` / `sanitizeLayout` decide about it afterwards.
//
// v1 → v2 (spec 12 §2.7, WP3.3b): the Sound Design workspace gained the Review panel (a group below the Sound Library
// with Markers, History and Jobs). A stored layout (current or saved) of that built-in keeps the shape it was saved
// in, so it gets the panel as a background tab of the group that holds Markers / History / Jobs (else the Sound
// Library's group): where Window ▸ Review would open it (its home group's peers, then `dockWith: 'markers'`). Nothing
// else moves: no group is split or resized and the active tab stays. A layout that already has a Review panel
// (opened by hand, or saved by a build that had it) is left as it is; null layouts are the factory layout, which has
// it. Custom workspaces are the user's own and are never changed (Window ▸ Review still opens the panel there).
import { panelState } from './layout.ts';

type Obj = Record<string, unknown>;
type LayoutLeafLike = { data: { views: unknown[] } };
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);

/** The workspace whose stored layouts gain the Review panel. */
export const SOUND_DESIGN_WORKSPACE_ID = 'sound-design';
/** Panel kinds whose group receives Review, in order of preference (the old Sound Design left group). */
const REVIEW_HOSTS = ['markers', 'history', 'jobs', 'soundLibrary', 'mediaBrowser', 'project'] as const;
/** Review sits before these in its group (the factory order: Review, Markers, History, Jobs). */
const REVIEW_BEFORE = new Set<string>(['markers', 'history', 'jobs']);
/** The Review panel's state as `buildLayout` writes it (minimum size of `panels/review`; tested against it). */
export const REVIEW_PANEL_STATE = panelState({ kind: 'review', minSize: { w: 300, h: 200 } }, 'Review');

function kindOfPanel(p: unknown): string | null {
	return isObj(p) && isObj(p.params) && typeof p.params.kind === 'string' ? p.params.kind : null;
}

/** Every leaf group of a serialized grid node, floating groups after the grid (depth-bounded). */
function leaves(layout: Obj): LayoutLeafLike[] {
	const out: LayoutLeafLike[] = [];
	const walk = (n: unknown, depth: number) => {
		if (!isObj(n) || depth > 64) return;
		if (n.type === 'leaf' && isObj(n.data) && Array.isArray(n.data.views)) out.push(n as LayoutLeafLike);
		else if (n.type === 'branch' && Array.isArray(n.data)) for (const c of n.data) walk(c, depth + 1);
	};
	if (isObj(layout.grid)) walk(layout.grid.root, 0);
	if (Array.isArray(layout.floatingGroups))
		for (const f of layout.floatingGroups)
			if (isObj(f) && isObj(f.data) && Array.isArray(f.data.views)) out.push(f as LayoutLeafLike);
	return out;
}

/**
 * The layout with a Review tab added (a new object; the input is not mutated), or the layout itself when it already
 * has one, cannot be read, or has none of the host groups.
 */
export function addReviewPanel(layout: unknown): unknown {
	if (!isObj(layout) || !isObj(layout.panels) || !isObj(layout.grid)) return layout;
	const panels = layout.panels;
	if (Object.values(panels).some((p) => kindOfPanel(p) === 'review')) return layout;
	const id = REVIEW_PANEL_STATE.id;
	if (Object.hasOwn(panels, id)) return layout;
	const kindOfView = (v: unknown) =>
		typeof v === 'string' && Object.hasOwn(panels, v) ? kindOfPanel(panels[v]) : null;
	const copy = structuredClone(layout) as Obj;
	const groups = leaves(copy);
	let host: LayoutLeafLike | undefined;
	for (const kind of REVIEW_HOSTS) {
		host = groups.find((g) => g.data.views.some((v) => kindOfView(v) === kind));
		if (host) break;
	}
	if (!host) return layout;
	const views = host.data.views;
	const at = views.findIndex((v) => REVIEW_BEFORE.has(kindOfView(v) ?? ''));
	views.splice(at < 0 ? views.length : at, 0, id);
	(copy.panels as Obj)[id] = { ...REVIEW_PANEL_STATE };
	return copy;
}

function v1ToV2(data: unknown): unknown {
	if (!isObj(data) || !isObj(data.workspaces)) return data;
	const record = Object.hasOwn(data.workspaces, SOUND_DESIGN_WORKSPACE_ID)
		? data.workspaces[SOUND_DESIGN_WORKSPACE_ID]
		: undefined;
	if (!isObj(record)) return data;
	const current = addReviewPanel(record.current);
	const saved = addReviewPanel(record.saved);
	if (current === record.current && saved === record.saved) return data;
	return {
		...data,
		workspaces: { ...data.workspaces, [SOUND_DESIGN_WORKSPACE_ID]: { ...record, current, saved } },
	};
}

/** Migrations by the version they start from. */
const STEPS: Record<number, (data: unknown) => unknown> = { 1: v1ToV2 };

/**
 * Migrates the workspace state stored at `fromVersion` to `toVersion`. A version no build wrote (not an integer ≥ 1)
 * throws, so `loadVersioned` resets it ('invalid') as it did before there were migrations.
 */
export function migrateWorkspacesState(data: unknown, fromVersion: number, toVersion: number): unknown {
	if (!Number.isInteger(fromVersion) || fromVersion < 1)
		throw new Error(`Unknown workspaces version ${fromVersion}`);
	let out = data;
	for (let v = fromVersion; v < toVersion; v++) {
		const step = STEPS[v];
		if (step) out = step(out);
	}
	return out;
}
