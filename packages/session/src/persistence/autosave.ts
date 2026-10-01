// Autosave (S01:PER-020, ARCHITECTURE §6):
// - the committed document is saved 1.5 s after the last commit, and at least every 10 s during continuous
//   editing (the first unsaved change starts the 10 s clock);
// - the timer never saves while a gesture is in progress (AC-13); the gesture's commit reschedules;
// - `flush()` saves immediately (Ctrl+S, pagehide, close) and waits for an in-flight save;
// - a 409 conflict pauses autosave until the user chooses Overwrite (or reloads) (S01:PER-025);
// - read-only sessions and sessions whose lease was lost never save;
// - the view record is saved with a 1 s debounce (S01:SES-004).
import type { EditorSession } from '../session.ts';
import type { ProjectStore } from './types.ts';

export type AutosaveTimers = {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(h: unknown): void;
};

export type AutosaveOptions = {
	idleMs?: number;
	maxIntervalMs?: number;
	viewDebounceMs?: number;
	timers?: AutosaveTimers;
	now?: () => number;
	onConflict?(serverRevision: number): void;
	onError?(e: unknown): void;
	onSaved?(revision: number): void;
};

export type AutosavePause = 'read-only' | 'lease-lost' | 'conflict' | null;

export type AutosaveStatus = {
	saving: boolean;
	lastSavedRevision: number;
	lastSavedAt: number | null;
	/** Server revision reported by a 409 (autosave is paused until resolved). */
	conflict: { serverRevision: number } | null;
	error: string | null;
	paused: AutosavePause;
	/** Number of successful saves (diagnostics/tests). */
	saves: number;
};

export type Autosaver = {
	/** Saves the committed document now (even mid-gesture: SES-007) and waits for completion. */
	flush(): Promise<void>;
	dispose(): void;
	readonly saving: boolean;
	readonly lastSavedRevision: number;
	getStatus(): AutosaveStatus;
	subscribe(listener: (s: AutosaveStatus) => void): () => void;
	/** Conflict resolution "Overwrite": saves over the server revision reported by the 409. */
	overwrite(): Promise<void>;
};

const defaultTimers: AutosaveTimers = {
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createAutosaver(
	session: EditorSession,
	store: ProjectStore,
	opts: AutosaveOptions = {},
): Autosaver {
	const idleMs = opts.idleMs ?? 1500;
	const maxIntervalMs = opts.maxIntervalMs ?? 10_000;
	const viewMs = opts.viewDebounceMs ?? 1000;
	const timers = opts.timers ?? defaultTimers;
	const now = opts.now ?? (() => Date.now());
	let timer: unknown = null;
	let viewTimer: unknown = null;
	let firstDirtyAt: number | null = null;
	let inFlight: Promise<void> | null = null;
	let disposed = false;
	/** Server revision our next save is based on (If-Match). */
	let savedBase = session.store.getState().revision;
	let status: AutosaveStatus = {
		saving: false,
		lastSavedRevision: savedBase,
		lastSavedAt: null,
		conflict: null,
		error: null,
		paused: null,
		saves: 0,
	};
	const listeners = new Set<(s: AutosaveStatus) => void>();
	const setStatus = (patch: Partial<AutosaveStatus>) => {
		status = { ...status, ...patch };
		for (const l of [...listeners]) l(status);
	};

	const pauseReason = (): AutosavePause => {
		const s = session.store.getState();
		if (s.readOnly) return 'read-only';
		if (s.lease.status === 'lost') return 'lease-lost';
		if (status.conflict) return 'conflict';
		return null;
	};
	const syncPause = () => {
		const p = pauseReason();
		if (p !== status.paused) setStatus({ paused: p });
		return p;
	};
	const unsaved = () => session.store.getState().revision !== status.lastSavedRevision;

	const cancelTimer = () => {
		if (timer !== null) timers.clearTimeout(timer);
		timer = null;
	};
	const schedule = () => {
		if (disposed || syncPause() || !unsaved()) return;
		firstDirtyAt ??= now();
		cancelTimer();
		const wait = Math.max(0, Math.min(idleMs, firstDirtyAt + maxIntervalMs - now()));
		timer = timers.setTimeout(() => {
			timer = null;
			// Never save mid-gesture (AC-13): the gesture's end reschedules.
			if (session.gestureActive || session.store.getState().gesture) return;
			void save();
		}, wait);
	};

	function save(): Promise<void> {
		if (inFlight) {
			// A save is running: chain one more after it (it re-checks whether anything is left).
			return inFlight.then(() => (unsaved() ? save() : undefined));
		}
		if (syncPause() || !unsaved()) return Promise.resolve();
		const revision = session.store.getState().revision;
		const doc = session.getCommitted();
		setStatus({ saving: true });
		inFlight = (async () => {
			try {
				const r = await store.save(session.projectId, doc, { revision, baseRevision: savedBase });
				if (r.ok) {
					savedBase = r.revision;
					firstDirtyAt = null;
					session.markSaved(revision);
					setStatus({
						lastSavedRevision: revision,
						lastSavedAt: now(),
						error: null,
						saves: status.saves + 1,
					});
					opts.onSaved?.(revision);
				} else {
					setStatus({ conflict: { serverRevision: r.revision } });
					syncPause();
					opts.onConflict?.(r.revision);
				}
			} catch (e) {
				setStatus({ error: e instanceof Error ? e.message : String(e) });
				opts.onError?.(e);
			} finally {
				inFlight = null;
				setStatus({ saving: false });
			}
			// Edits made while saving (or a failed save) get their own timer.
			if (!status.error) schedule();
			else if (!disposed && !syncPause()) {
				cancelTimer();
				timer = timers.setTimeout(() => {
					timer = null;
					void save();
				}, maxIntervalMs);
			}
		})();
		return inFlight;
	}

	const offDoc = session.on('doc.changed', schedule);
	const offGesture = session.on('gesture.changed', ({ active }) => {
		if (!active) schedule();
	});
	const offStore = session.store.subscribe((st, prev) => {
		if (st.readOnly !== prev.readOnly || st.lease !== prev.lease) {
			const before = status.paused;
			if (syncPause() === null && before !== null) schedule();
		}
		if (st.views === prev.views && st.tabs === prev.tabs && st.activeSequenceId === prev.activeSequenceId)
			return;
		if (st.readOnly) return;
		if (viewTimer !== null) timers.clearTimeout(viewTimer);
		viewTimer = timers.setTimeout(() => {
			viewTimer = null;
			void store.saveView(session.projectId, session.viewRecord()).catch((e) => opts.onError?.(e));
		}, viewMs);
	});
	syncPause();

	return {
		async flush() {
			cancelTimer();
			await save();
		},
		dispose() {
			disposed = true;
			offDoc();
			offGesture();
			offStore();
			cancelTimer();
			if (viewTimer !== null) timers.clearTimeout(viewTimer);
			listeners.clear();
		},
		get saving() {
			return status.saving;
		},
		get lastSavedRevision() {
			return status.lastSavedRevision;
		},
		getStatus: () => status,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async overwrite() {
			if (!status.conflict) return;
			if (status.conflict.serverRevision >= 0) savedBase = status.conflict.serverRevision;
			setStatus({ conflict: null });
			syncPause();
			await save();
		},
	};
}
