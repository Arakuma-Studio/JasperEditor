// Crash-recovery journal writer (S01:PER-021, AC-18; ARCHITECTURE D-39; docs/project-files.md "Crash recovery").
// - While the session has unsaved changes, its committed document is journalled through the store about 1 s after
//   the last edit, and at most every 5 s while edits keep coming (the first unjournalled change starts the clock);
// - the journal is written only while this session holds the lease (the engine refuses anything else);
// - when autosave catches up (nothing unsaved), the journal is deleted; a clean close deletes it too, unless
//   changes are still unsaved (a failed save), so they are offered on the next open;
// - `discard()` (File ▸ Revert) deletes it whatever is unsaved.
import type { EditorSession } from '../session.ts';
import type { RecoveryStore } from './types.ts';

export type RecoveryJournalOptions = {
	/** Quiet time after the last edit before writing (default 1000 ms). */
	idleMs?: number;
	/** Longest time an unsaved change waits while edits keep coming (default 5000 ms). */
	maxIntervalMs?: number;
	onError?(e: unknown): void;
};

export type RecoveryJournalStatus = {
	/** A journal of this session exists on the engine. */
	written: boolean;
	lastWrittenAt: number | null;
	/** Session revision of the last journalled document. */
	lastWrittenRevision: number | null;
	writes: number;
	error: string | null;
};

export type RecoveryJournalWriter = {
	/** Writes the unsaved document now (if anything is unsaved and not yet journalled). */
	flush(): Promise<void>;
	/** Autosave saved local `revision`: forget the labels it covers; delete the journal when nothing is unsaved. */
	saved(revision: number): Promise<void>;
	/** Clean close: deletes the journal when nothing is unsaved, keeps it (for the next open) otherwise. */
	close(): Promise<void>;
	/** Deletes the journal whatever is unsaved (File ▸ Revert) and stops. */
	discard(): Promise<void>;
	/** Stops timers and listeners; the journal stays as it is. */
	dispose(): void;
	getStatus(): RecoveryJournalStatus;
	/** Labels of the unsaved History steps, oldest first (the last `MAX_LABELS`). */
	unsavedLabels(): string[];
};

/** Labels kept for the recovery prompt. */
const MAX_LABELS = 50;

export function createRecoveryJournal(
	session: EditorSession,
	store: RecoveryStore,
	opts: RecoveryJournalOptions & {
		/** Server revision the unsaved changes are based on (the autosaver's If-Match base). */
		baseRevision(): number;
	},
): RecoveryJournalWriter {
	const idleMs = opts.idleMs ?? 1000;
	const maxIntervalMs = opts.maxIntervalMs ?? 5000;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let firstPendingAt: number | null = null;
	let inFlight: Promise<void> | null = null;
	let disposed = false;
	let warned = false;
	/** Unsaved History steps: local revision and label. */
	let changes: { revision: number; label: string }[] = [];
	let changeCount = 0;
	let status: RecoveryJournalStatus = {
		written: false,
		lastWrittenAt: null,
		lastWrittenRevision: null,
		writes: 0,
		error: null,
	};

	const leaseId = () => {
		const l = session.store.getState().lease;
		return l.status === 'held' && l.leaseId ? l.leaseId : null;
	};
	const pending = () => {
		const s = session.store.getState();
		return s.dirty && !s.readOnly && s.revision !== status.lastWrittenRevision;
	};
	const cancelTimer = () => {
		if (timer !== null) globalThis.clearTimeout(timer);
		timer = null;
	};
	const report = (e: unknown) => {
		status = { ...status, error: e instanceof Error ? e.message : String(e) };
		if (!warned) {
			warned = true;
			opts.onError?.(e);
		}
	};

	function schedule(): void {
		if (disposed || !pending() || !leaseId()) return;
		firstPendingAt ??= Date.now();
		cancelTimer();
		const wait = Math.max(0, Math.min(idleMs, firstPendingAt + maxIntervalMs - Date.now()));
		timer = globalThis.setTimeout(() => {
			timer = null;
			void write();
		}, wait);
	}

	function write(): Promise<void> {
		if (inFlight) return inFlight.then(() => (pending() ? write() : undefined));
		const lease = leaseId();
		if (disposed || !pending() || !lease) return Promise.resolve();
		const s = session.store.getState();
		const revision = s.revision;
		inFlight = (async () => {
			try {
				await store.writeRecovery(session.projectId, session.sessionId, {
					leaseId: lease,
					baseRevision: opts.baseRevision(),
					revision,
					changes: changes.map((c) => c.label),
					changeCount,
					document: session.getCommitted(),
				});
				firstPendingAt = null;
				status = {
					...status,
					written: true,
					lastWrittenAt: Date.now(),
					lastWrittenRevision: revision,
					writes: status.writes + 1,
					error: null,
				};
			} catch (e) {
				report(e);
				// Back off: retry one interval later instead of hammering a failing engine.
				firstPendingAt = null;
				cancelTimer();
				if (!disposed)
					timer = globalThis.setTimeout(() => {
						timer = null;
						void write();
					}, maxIntervalMs);
				return;
			} finally {
				inFlight = null;
			}
			schedule();
		})();
		return inFlight;
	}

	async function remove(): Promise<void> {
		cancelTimer();
		await inFlight;
		if (!status.written) return;
		try {
			await store.discardRecovery(session.projectId, session.sessionId, leaseId() ?? undefined);
			status = { ...status, written: false, lastWrittenRevision: null };
		} catch (e) {
			report(e);
		}
	}

	const offDoc = session.on('doc.changed', (e) => {
		const label = e.isUndo ? `Undo ${e.label}` : e.isRedo ? `Redo ${e.label}` : e.label;
		changes = [...changes, { revision: e.revision, label }].slice(-MAX_LABELS);
		changeCount++;
		schedule();
	});
	const offStore = session.store.subscribe((st, prev) => {
		if (st.lease !== prev.lease && st.lease.status === 'held') schedule();
	});

	return {
		flush: () => {
			cancelTimer();
			return write();
		},
		async saved(revision) {
			const kept = changes.filter((c) => c.revision > revision);
			changeCount = Math.max(0, changeCount - (changes.length - kept.length));
			changes = kept;
			if (session.store.getState().dirty) return;
			changes = [];
			changeCount = 0;
			firstPendingAt = null;
			await remove();
		},
		async close() {
			disposed = true;
			offDoc();
			offStore();
			if (session.store.getState().dirty) {
				disposed = false;
				await write();
				disposed = true;
				cancelTimer();
				return;
			}
			await remove();
		},
		async discard() {
			disposed = true;
			offDoc();
			offStore();
			changes = [];
			changeCount = 0;
			await remove();
		},
		dispose() {
			disposed = true;
			offDoc();
			offStore();
			cancelTimer();
		},
		getStatus: () => status,
		unsavedLabels: () => changes.map((c) => c.label),
	};
}
