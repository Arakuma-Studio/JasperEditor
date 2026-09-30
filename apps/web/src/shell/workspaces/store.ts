// Workspace store (S05 §2.2 workspaceStore, §4, WS-002/010…014, SH-020…024): the active workspace and,
// per workspace, a *current* and a *saved* layout snapshot. Built-ins cannot be deleted; their saved
// layout starts as the factory layout (null = build from the definition at the real window size).
// Persisted per user/machine through the versioned shell storage (never in project files, SH-024).
import type { SerializedDockview } from 'dockview-react';
import { BUILTIN_WORKSPACES, COMPACT_WORKSPACE, DEFAULT_WORKSPACE_ID } from './definitions.ts';
import { loadVersioned, type ShellStorage, saveVersioned, type VersionedKey } from './storage.ts';

export type WorkspaceRecord = {
	id: string;
	name: string;
	builtIn: boolean;
	showInBar: boolean;
	/** Current layout (auto-saved on every change); null = factory layout. */
	current: SerializedDockview | null;
	/** Saved layout ("Reset to Saved Layout" target); null = factory layout. */
	saved: SerializedDockview | null;
};

export type WorkspacesState = {
	activeId: string;
	order: string[];
	workspaces: Record<string, WorkspaceRecord>;
};

export const WORKSPACES_KEY = 'jasper:workspaces';
export const WORKSPACES_VERSION = 1;
export const SAVE_DEBOUNCE_MS = 300;

function builtinRecord(id: string, name: string): WorkspaceRecord {
	return { id, name, builtIn: true, showInBar: true, current: null, saved: null };
}

export function defaultWorkspacesState(): WorkspacesState {
	const workspaces: Record<string, WorkspaceRecord> = {};
	for (const w of BUILTIN_WORKSPACES) workspaces[w.id] = builtinRecord(w.id, w.name);
	workspaces[COMPACT_WORKSPACE.id] = {
		...builtinRecord(COMPACT_WORKSPACE.id, COMPACT_WORKSPACE.name),
		showInBar: false,
	};
	return { activeId: DEFAULT_WORKSPACE_ID, order: BUILTIN_WORKSPACES.map((w) => w.id), workspaces };
}

function isLayout(x: unknown): x is SerializedDockview | null {
	return x === null || (!!x && typeof x === 'object' && 'grid' in (x as object) && 'panels' in (x as object));
}

/** Validates stored data; unknown built-ins are re-added, missing ones restored (new builds). */
export function parseWorkspacesState(data: unknown): WorkspacesState | null {
	if (!data || typeof data !== 'object') return null;
	const d = data as Partial<WorkspacesState>;
	if (
		typeof d.activeId !== 'string' ||
		!Array.isArray(d.order) ||
		!d.workspaces ||
		typeof d.workspaces !== 'object'
	)
		return null;
	const base = defaultWorkspacesState();
	const workspaces: Record<string, WorkspaceRecord> = { ...base.workspaces };
	for (const [id, r] of Object.entries(d.workspaces)) {
		if (!r || typeof r !== 'object' || typeof r.name !== 'string') return null;
		if (!isLayout(r.current ?? null) || !isLayout(r.saved ?? null)) return null;
		const builtIn = id in base.workspaces;
		workspaces[id] = {
			id,
			name: builtIn ? (base.workspaces[id]?.name ?? r.name) : r.name,
			builtIn,
			showInBar: typeof r.showInBar === 'boolean' ? r.showInBar : true,
			current: r.current ?? null,
			saved: r.saved ?? null,
		};
	}
	const order = d.order.filter(
		(id): id is string => typeof id === 'string' && id in workspaces && id !== COMPACT_WORKSPACE.id,
	);
	for (const w of BUILTIN_WORKSPACES) if (!order.includes(w.id)) order.push(w.id);
	for (const id of Object.keys(workspaces))
		if (!order.includes(id) && id !== COMPACT_WORKSPACE.id) order.push(id);
	const activeId =
		d.activeId in workspaces && d.activeId !== COMPACT_WORKSPACE.id ? d.activeId : DEFAULT_WORKSPACE_ID;
	return { activeId, order, workspaces };
}

const SPEC: VersionedKey<WorkspacesState> = {
	key: WORKSPACES_KEY,
	version: WORKSPACES_VERSION,
	parse: parseWorkspacesState,
	fallback: defaultWorkspacesState,
};

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };

export class WorkspaceStore {
	private state: WorkspacesState;
	private readonly listeners = new Set<() => void>();
	private timer: unknown = null;
	private readonly timers: Timers;
	/** Set when loading discarded corrupt/newer data (the shell shows one toast, SH-021). */
	readonly resetReason: 'corrupt' | 'newer' | 'invalid' | null;

	constructor(
		private readonly storage: ShellStorage | null,
		opts: { timers?: Timers } = {},
	) {
		this.timers = opts.timers ?? {
			setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
			clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
		};
		const loaded = loadVersioned(storage, SPEC);
		this.state = loaded.value;
		this.resetReason = loaded.status === 'reset' ? loaded.reason : null;
	}

	getState = (): WorkspacesState => this.state;
	subscribe = (l: () => void): (() => void) => {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	};

	private set(next: WorkspacesState, persist: 'now' | 'debounced' = 'now') {
		this.state = next;
		for (const l of [...this.listeners]) l();
		if (persist === 'now') this.flush();
		else this.schedule();
	}
	private patch(id: string, patch: Partial<WorkspaceRecord>, persist: 'now' | 'debounced' = 'now') {
		const r = this.state.workspaces[id];
		if (!r) return;
		this.set({ ...this.state, workspaces: { ...this.state.workspaces, [id]: { ...r, ...patch } } }, persist);
	}
	private schedule() {
		if (this.timer !== null) this.timers.clearTimeout(this.timer);
		this.timer = this.timers.setTimeout(() => {
			this.timer = null;
			this.flush();
		}, SAVE_DEBOUNCE_MS);
	}

	/** Writes immediately (pagehide/beforeunload, SH-022). */
	flush(): void {
		if (this.timer !== null) this.timers.clearTimeout(this.timer);
		this.timer = null;
		saveVersioned(this.storage, SPEC, this.state);
	}

	get(id: string): WorkspaceRecord | undefined {
		return this.state.workspaces[id];
	}
	get active(): WorkspaceRecord {
		return (
			this.state.workspaces[this.state.activeId] ??
			(this.state.workspaces[DEFAULT_WORKSPACE_ID] as WorkspaceRecord)
		);
	}

	/** Workspaces shown in the header, in list order. */
	barList(): WorkspaceRecord[] {
		return this.state.order
			.map((id) => this.state.workspaces[id])
			.filter((r): r is WorkspaceRecord => !!r && r.showInBar);
	}
	/** All user-visible workspaces in list order. */
	list(): WorkspaceRecord[] {
		return this.state.order.map((id) => this.state.workspaces[id]).filter((r): r is WorkspaceRecord => !!r);
	}
	/** `Alt+Shift+N` number (1…9) for the first nine visible entries (WS-012). */
	shortcutNumber(id: string): number | null {
		const i = this.barList().findIndex((r) => r.id === id);
		return i >= 0 && i < 9 ? i + 1 : null;
	}
	/** Workspace id for `Alt+Shift+N`. */
	byNumber(n: number): string | null {
		return this.barList()[n - 1]?.id ?? null;
	}

	setActive(id: string): void {
		if (!this.state.workspaces[id] || id === COMPACT_WORKSPACE.id || id === this.state.activeId) return;
		this.set({ ...this.state, activeId: id });
	}

	/** Any layout change updates the current snapshot (debounced, WS-011, SH-022). */
	setCurrent(id: string, layout: SerializedDockview): void {
		this.patch(id, { current: layout }, 'debounced');
	}

	/** Save Changes to This Workspace: current → saved. */
	saveChanges(id: string, layout?: SerializedDockview): void {
		const r = this.state.workspaces[id];
		if (!r) return;
		const cur = layout ?? r.current;
		this.patch(id, { current: cur, saved: cur });
	}

	/** Reset to Saved Layout: saved → current (built-ins: factory until first save). Returns the layout. */
	resetToSaved(id: string): SerializedDockview | null {
		const r = this.state.workspaces[id];
		if (!r) return null;
		this.patch(id, { current: r.saved });
		return r.saved;
	}

	/** Edit Workspaces ▸ Restore factory layout (built-ins). */
	restoreFactory(id: string): void {
		const r = this.state.workspaces[id];
		if (!r?.builtIn) return;
		this.patch(id, { current: null, saved: null });
	}

	checkName(name: string, exceptId?: string): NameCheck {
		const n = name.trim();
		if (n.length < 1 || n.length > 40) return { ok: false, error: 'Names are 1–40 characters' };
		const clash = Object.values(this.state.workspaces).some(
			(r) => r.id !== exceptId && r.id !== COMPACT_WORKSPACE.id && r.name.toLowerCase() === n.toLowerCase(),
		);
		return clash ? { ok: false, error: 'A workspace with this name already exists' } : { ok: true, name: n };
	}

	/** Save as New Workspace: current and saved are both the present layout (WS-011). */
	saveAs(
		name: string,
		layout: SerializedDockview | null,
		opts: { activate?: boolean } = {},
	): NameCheck & { id?: string } {
		const check = this.checkName(name);
		if (!check.ok) return check;
		let id = `custom:${check.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
		for (let i = 2; this.state.workspaces[id]; i++) id = `${id.replace(/-\d+$/, '')}-${i}`;
		const record: WorkspaceRecord = {
			id,
			name: check.name,
			builtIn: false,
			showInBar: true,
			current: layout,
			saved: layout,
		};
		this.set({
			activeId: opts.activate === false ? this.state.activeId : id,
			order: [...this.state.order, id],
			workspaces: { ...this.state.workspaces, [id]: record },
		});
		return { ...check, id };
	}

	rename(id: string, name: string): NameCheck {
		const r = this.state.workspaces[id];
		if (!r || r.builtIn) return { ok: false, error: 'Built-in workspaces cannot be renamed' };
		const check = this.checkName(name, id);
		if (check.ok) this.patch(id, { name: check.name });
		return check;
	}

	remove(id: string): boolean {
		const r = this.state.workspaces[id];
		if (!r || r.builtIn) return false;
		const workspaces = { ...this.state.workspaces };
		delete workspaces[id];
		this.set({
			activeId: this.state.activeId === id ? DEFAULT_WORKSPACE_ID : this.state.activeId,
			order: this.state.order.filter((x) => x !== id),
			workspaces,
		});
		return true;
	}

	reorder(order: string[]): void {
		const known = order.filter((id) => id in this.state.workspaces && id !== COMPACT_WORKSPACE.id);
		for (const id of this.state.order) if (!known.includes(id)) known.push(id);
		this.set({ ...this.state, order: known });
	}

	/** Moves `id` before `beforeId` (header tab drag, HD-004). */
	move(id: string, beforeId: string | null): void {
		const order = this.state.order.filter((x) => x !== id);
		const at = beforeId ? order.indexOf(beforeId) : -1;
		order.splice(at < 0 ? order.length : at, 0, id);
		this.reorder(order);
	}

	setShowInBar(id: string, show: boolean): void {
		this.patch(id, { showInBar: show });
	}

	/** Export Workspace… (WS-010): a portable JSON document. */
	exportJson(id: string): string | null {
		const r = this.state.workspaces[id];
		if (!r) return null;
		return JSON.stringify(
			{ kind: 'jasper.workspace', version: 1, name: r.name, layout: r.current ?? r.saved },
			null,
			2,
		);
	}

	/** Import Workspace… (WS-014): validated; name conflicts get " (2)". Returns the new id or an error. */
	importJson(
		text: string,
		sanitize: (layout: unknown) => SerializedDockview | null,
	): { ok: true; id: string } | { ok: false; error: string } {
		let doc: unknown;
		try {
			doc = JSON.parse(text);
		} catch {
			return { ok: false, error: 'The file is not valid JSON' };
		}
		const d = doc as { kind?: unknown; name?: unknown; layout?: unknown };
		if (d?.kind !== 'jasper.workspace' || typeof d.name !== 'string')
			return { ok: false, error: 'Not a JasperEditor workspace file' };
		const layout = sanitize(d.layout);
		if (!layout) return { ok: false, error: 'The workspace layout could not be read' };
		let name = d.name.trim().slice(0, 40) || 'Imported';
		for (let i = 2; !this.checkName(name).ok && i < 100; i++) name = `${d.name.trim().slice(0, 34)} (${i})`;
		const r = this.saveAs(name, layout, { activate: false });
		return r.ok && r.id ? { ok: true, id: r.id } : { ok: false, error: r.ok ? 'Import failed' : r.error };
	}
}
