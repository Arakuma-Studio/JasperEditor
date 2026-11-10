// Autosave (S01:PER-020, ARCHITECTURE §6):
// - the committed document is saved 1.5 s after the last commit, and at least every 10 s during continuous
//   editing (the first unsaved change starts the 10 s clock);
// - the timer never saves while a gesture is in progress (AC-13); the gesture's commit reschedules;
// - `flush()` saves immediately (Ctrl+S, pagehide, close) and waits for an in-flight save;
// - a 409 conflict pauses autosave until the user chooses Overwrite (or reloads) (S01:PER-025);
// - read-only sessions and sessions whose lease was lost never save;
// - the view record is saved with a 1 s debounce (S01:SES-004).
import type { AgentPersistence } from '@jasper/api';
import { jsonWarmUnits } from '@jasper/project';
import type { EditorSession } from '../session.ts';
import type { ProjectStore } from './types.ts';

export type AutosaveOptions = {
	/**
	 * Read at every scheduling: `enabled` false = the timer never saves (Save / Ctrl+S
	 * and closing the project still do; the crash-recovery journal keeps unsaved edits); `maxIntervalMs` = the longest
	 * an unsaved change waits during continuous editing (default 10 s).
	 */
	policy?(): { enabled: boolean; maxIntervalMs?: number };
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
	/** Server revision the next save is based on (If-Match); the crash-recovery journal records it. */
	serverRevision: number;
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
	/** Whether automatic saving is enabled; explicit saves remain available. */
	readonly automatic: boolean;
	/** Whether the session's live revision is on disk, and the revision that is (agents: get_project, transactions). */
	persistence(): AgentPersistence;
};

export function createAutosaver(
	session: EditorSession,
	store: ProjectStore,
	opts: AutosaveOptions = {},
): Autosaver {
	const idleMs = 1500;
	const defaultMaxIntervalMs = 10_000;
	const viewMs = 1000;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let viewTimer: ReturnType<typeof setTimeout> | null = null;
	let firstDirtyAt: number | null = null;
	let inFlight: Promise<void> | null = null;
	let disposed = false;
	/**
	 * Server revision our next save is based on (If-Match): the revision the session was opened at — edits the
	 * session made before autosave attached (spec 13 SH-004: measuring pending text) are unsaved, not saved.
	 */
	let savedBase = Math.min(session.openedRevision, session.store.getState().revision);
	let status: AutosaveStatus = {
		saving: false,
		lastSavedRevision: savedBase,
		lastSavedAt: null,
		conflict: null,
		error: null,
		paused: null,
		saves: 0,
		serverRevision: savedBase,
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
		if (timer !== null) globalThis.clearTimeout(timer);
		timer = null;
	};
	const schedule = () => {
		if (disposed || syncPause() || !unsaved()) return;
		const policy = opts.policy?.();
		if (policy && !policy.enabled) return;
		const maxIntervalMs = Math.max(idleMs, policy?.maxIntervalMs ?? defaultMaxIntervalMs);
		firstDirtyAt ??= Date.now();
		cancelTimer();
		const wait = Math.max(0, Math.min(idleMs, firstDirtyAt + maxIntervalMs - Date.now()));
		timer = globalThis.setTimeout(() => {
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
						lastSavedAt: Date.now(),
						error: null,
						saves: status.saves + 1,
						serverRevision: r.revision,
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
				timer = globalThis.setTimeout(() => {
					timer = null;
					void save();
				}, defaultMaxIntervalMs);
			}
		})();
		return inFlight;
	}

	// While the browser is idle after an edit, serialise the parts of the document the cache does not hold yet
	// (`jsonWarmUnits`), a few milliseconds at a time, so the save joins cached text instead of serialising 8 MB at
	// once (the first save after opening a large project). Browsers only.
	let warm: { cancel(): void } | null = null;
	const warmUp = () => {
		const g = globalThis as {
			requestIdleCallback?: (cb: (d: { timeRemaining(): number }) => void, o?: { timeout: number }) => number;
			cancelIdleCallback?: (h: number) => void;
		};
		if (!g.requestIdleCallback || !g.cancelIdleCallback) return;
		warm?.cancel();
		const units = jsonWarmUnits(session.getCommitted());
		let handle = 0;
		let done = false;
		const step = (d: { timeRemaining(): number }) => {
			if (done || disposed) return;
			while (d.timeRemaining() > 2) {
				const u = units.next();
				if (u.done) {
					done = true;
					return;
				}
				u.value();
			}
			handle = g.requestIdleCallback!(step);
		};
		handle = g.requestIdleCallback(step);
		warm = {
			cancel() {
				done = true;
				g.cancelIdleCallback!(handle);
			},
		};
	};
	const offDoc = session.on('doc.changed', () => {
		schedule();
		warmUp();
	});
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
		if (viewTimer !== null) globalThis.clearTimeout(viewTimer);
		viewTimer = globalThis.setTimeout(() => {
			viewTimer = null;
			void store.saveView(session.projectId, session.viewRecord()).catch((e) => opts.onError?.(e));
		}, viewMs);
	});
	syncPause();
	schedule();

	return {
		async flush() {
			cancelTimer();
			await save();
		},
		dispose() {
			disposed = true;
			warm?.cancel();
			offDoc();
			offGesture();
			offStore();
			cancelTimer();
			if (viewTimer !== null) globalThis.clearTimeout(viewTimer);
			listeners.clear();
		},
		get saving() {
			return status.saving;
		},
		get lastSavedRevision() {
			return status.lastSavedRevision;
		},
		get automatic() {
			return opts.policy?.().enabled ?? true;
		},
		getStatus: () => status,
		persistence() {
			const s = session.store.getState();
			const conflict = status.conflict;
			const savedRevision =
				conflict && conflict.serverRevision >= 0 ? conflict.serverRevision : status.serverRevision;
			const state: AgentPersistence['state'] = s.readOnly
				? 'read-only'
				: s.lease.status === 'lost'
					? 'lease-lost'
					: conflict
						? 'paused-conflict'
						: !unsaved()
							? 'saved'
							: status.error
								? 'save-failing'
								: 'pending';
			return { state, savedRevision };
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async overwrite() {
			if (!status.conflict) return;
			if (status.conflict.serverRevision >= 0) savedBase = status.conflict.serverRevision;
			setStatus({ conflict: null, serverRevision: savedBase });
			syncPause();
			await save();
		},
	};
}
