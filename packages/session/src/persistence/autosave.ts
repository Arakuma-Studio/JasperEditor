// Autosave (S01:PER-020, ARCHITECTURE §6): 1.5 s after the last commit, at most every 10 s during
// continuous editing, never while a gesture is in progress; view state saved with a 1 s debounce.
import type { EditorSession } from '../session.ts';
import type { ProjectStore } from './types.ts';

export type AutosaveOptions = {
	idleMs?: number;
	maxIntervalMs?: number;
	viewDebounceMs?: number;
	timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
	now?: () => number;
	onConflict?(serverRevision: number): void;
	onError?(e: unknown): void;
};

export type Autosaver = {
	flush(): Promise<void>;
	dispose(): void;
	readonly saving: boolean;
	readonly lastSavedRevision: number;
};

export function createAutosaver(
	session: EditorSession,
	store: ProjectStore,
	opts: AutosaveOptions = {},
): Autosaver {
	const idleMs = opts.idleMs ?? 1500;
	const maxIntervalMs = opts.maxIntervalMs ?? 10_000;
	const viewMs = opts.viewDebounceMs ?? 1000;
	const timers = opts.timers ?? {
		setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
		clearTimeout: (h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
	};
	const now = opts.now ?? (() => Date.now());
	let timer: unknown = null;
	let viewTimer: unknown = null;
	let firstDirtyAt: number | null = null;
	let saving = false;
	let lastSavedRevision = session.store.getState().revision;
	let savedBase = lastSavedRevision;

	const schedule = () => {
		if (session.store.getState().readOnly) return;
		firstDirtyAt ??= now();
		if (timer !== null) timers.clearTimeout(timer);
		const wait = Math.max(0, Math.min(idleMs, firstDirtyAt + maxIntervalMs - now()));
		timer = timers.setTimeout(() => {
			timer = null;
			void save();
		}, wait);
	};

	async function save(): Promise<void> {
		const s = session.store.getState();
		if (s.gesture) {
			// Never save mid-gesture; retry after it ends (the commit reschedules anyway).
			return;
		}
		if (saving || s.revision === lastSavedRevision) return;
		saving = true;
		const revision = s.revision;
		try {
			const r = await store.save(session.projectId, session.getCommitted(), {
				revision,
				baseRevision: savedBase,
			});
			if (r.ok) {
				lastSavedRevision = revision;
				savedBase = r.revision;
				firstDirtyAt = null;
				session.markSaved(revision);
			} else opts.onConflict?.(r.revision);
		} catch (e) {
			opts.onError?.(e);
		} finally {
			saving = false;
		}
		if (session.store.getState().revision !== lastSavedRevision) schedule();
	}

	const offDoc = session.on('doc.changed', () => schedule());
	const offGesture = session.on('gesture.changed', ({ active }) => {
		if (!active && session.store.getState().revision !== lastSavedRevision) schedule();
	});
	let lastViews = session.store.getState().views;
	const offView = session.store.subscribe((st) => {
		if (st.views === lastViews) return;
		lastViews = st.views;
		if (viewTimer !== null) timers.clearTimeout(viewTimer);
		viewTimer = timers.setTimeout(() => {
			viewTimer = null;
			void store.saveView(session.projectId, session.viewRecord()).catch((e) => opts.onError?.(e));
		}, viewMs);
	});

	return {
		async flush() {
			if (timer !== null) timers.clearTimeout(timer);
			timer = null;
			await save();
		},
		dispose() {
			offDoc();
			offGesture();
			offView();
			if (timer !== null) timers.clearTimeout(timer);
			if (viewTimer !== null) timers.clearTimeout(viewTimer);
		},
		get saving() {
			return saving;
		},
		get lastSavedRevision() {
			return lastSavedRevision;
		},
	};
}
