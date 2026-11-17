// Persistence controller: one per open session. Wires autosave (S01:PER-020) to the page lifecycle
// (flush on `visibilitychange` → hidden and `pagehide`, S01:PER-022), exposes the read-only reason
// (lease held elsewhere S01:PER-040, newer schema S01:MIG-003) and implements "Take over editing". The crash-
// recovery journal (S01:PER-021, AC-18, D-39) runs next to autosave when the store supports it. When a heartbeat
// re-acquires a lease the engine had forgotten (restart, expiry while the tab was throttled), the controller reads
// the project: saved elsewhere meanwhile, a clean window takes the newer document and a window with unsaved changes
// shows the conflict at once, with what Overwrite and Reload would each discard (docs/project-files.md).
import { CURRENT_SCHEMA_VERSION } from '@jasper/project';
import { EditorSession, type SessionContext } from '../session.ts';
import { createSessionId } from '../session-id.ts';
import type { SessionState } from '../types.ts';
import { type AutosaveOptions, type Autosaver, createAutosaver } from './autosave.ts';
import {
	type ChangeSet,
	type ConflictDetails,
	MAX_CHANGE_LABELS,
	shareStructure,
	summarizeChanges,
} from './conflict.ts';
import { createRecoveryJournal, type RecoveryJournalWriter } from './recovery.ts';
import { hasRecovery, type OpenedProject, type ProjectStore } from './types.ts';

export type ReadOnlyReason = 'lease' | 'schema' | 'requested' | null;

/** Why a session is read-only (drives the banner text and whether "Take over" is offered). */
export function readOnlyReason(state: Pick<SessionState, 'readOnly' | 'lease' | 'document'>): ReadOnlyReason {
	if (!state.readOnly) return null;
	if ((state.document?.schemaVersion ?? 1) > CURRENT_SCHEMA_VERSION) return 'schema';
	if (state.lease.status === 'read-only') return 'lease';
	return 'requested';
}

/** Minimal page-lifecycle target (window in browsers; a fake in tests). */
export type LifecycleTarget = {
	addEventListener(type: string, cb: (e: Event) => void): void;
	removeEventListener(type: string, cb: (e: Event) => void): void;
};

export type PersistenceController = {
	readonly session: EditorSession;
	readonly autosaver: Autosaver;
	/** The crash-recovery journal, when the store keeps one. */
	readonly journal: RecoveryJournalWriter | null;
	flush(): Promise<void>;
	/**
	 * A transaction saved by someone else (the engine's headless `doc.changed` events): its label names the change in
	 * conflict details and the update notice.
	 */
	noteExternalChange(change: { revision: number; label: string }): void;
	/** Settles once the check a re-acquired lease started has finished (tests, diagnostics). */
	idle(): Promise<void>;
	/**
	 * Flushes, stops autosave and removes the page listeners (the caller closes the session). With
	 * `discardUnsaved` (File ▸ Revert) nothing is saved and the session's recovery journal is deleted.
	 */
	dispose(opts?: { discardUnsaved?: boolean }): Promise<void>;
};

const controllers = new WeakMap<EditorSession, PersistenceController>();

/** The controller attached to a session (Ctrl+S, close handlers). */
export function persistenceFor(session: EditorSession | null | undefined): PersistenceController | null {
	return session ? (controllers.get(session) ?? null) : null;
}

export function attachPersistence(
	session: EditorSession,
	opts: AutosaveOptions & {
		store?: ProjectStore;
		/** Window-like target for pagehide/beforeunload; `document` for visibilitychange. */
		window?: LifecycleTarget | null;
		document?: (LifecycleTarget & { visibilityState?: string }) | null;
		/** Crash-recovery journal timing (`false` turns it off). */
		recovery?: { idleMs?: number; maxIntervalMs?: number } | false;
		/**
		 * A re-acquired lease found the project saved elsewhere and this window, having nothing unsaved, took the newer
		 * document (`revision` on disk; `incoming` what changed).
		 */
		onUpdated?(e: { revision: number; incoming: ChangeSet }): void;
	} = {},
): PersistenceController {
	const existing = controllers.get(session);
	if (existing) return existing;
	const store = opts.store ?? session.projectStore;
	if (!store) throw new Error('attachPersistence: the session has no ProjectStore');
	let journal: RecoveryJournalWriter | null = null;
	let disposed = false;
	const autosaver = createAutosaver(session, store, {
		...opts,
		onSaved: (revision) => {
			opts.onSaved?.(revision);
			void journal?.saved(revision);
		},
		onConflict: (revision) => {
			opts.onConflict?.(revision);
			track(explainConflict('save'));
		},
	});
	if (opts.recovery !== false && hasRecovery(store))
		journal = createRecoveryJournal(session, store, {
			...(opts.recovery ?? {}),
			baseRevision: () => autosaver.getStatus().serverRevision,
			onError: (e) => console.warn('[recovery] journal write failed', e),
		});
	const win = opts.window === undefined ? globalThis.window : opts.window;
	const doc = opts.document === undefined ? globalThis.document : opts.document;

	const flushQuietly = () => {
		// gaps (Auto Save off): leaving the page journals the unsaved edits instead of saving them.
		if (autosaver.automatic) void autosaver.flush().catch(() => undefined);
		void journal?.flush().catch(() => undefined);
	};
	const onVisibility = () => {
		if (doc?.visibilityState === 'hidden') flushQuietly();
	};
	const onBeforeUnload = (e: Event) => {
		const st = autosaver.getStatus();
		const dirty = session.store.getState().dirty;
		if ((dirty && st.paused === null) || st.saving) {
			flushQuietly();
			e.preventDefault();
			(e as BeforeUnloadEvent).returnValue = '';
		}
	};
	win?.addEventListener('pagehide', flushQuietly);
	win?.addEventListener('beforeunload', onBeforeUnload);
	doc?.addEventListener('visibilitychange', onVisibility);

	const offPersistence = session.reportPersistence(() => autosaver.persistence());

	// Headless transactions seen on the engine's event stream (labels for the conflict details and update notice).
	const external: { revision: number; label: string }[] = [];
	const incomingLabels = (after: number, upTo: number) =>
		external
			.filter((c) => c.revision > after && c.revision <= upTo)
			.map((c) => c.label)
			.slice(-MAX_CHANGE_LABELS);
	const localChanges = (): ChangeSet => ({
		labels: journal?.unsavedLabels() ?? [],
		summary: summarizeChanges(autosaver.baseDocument(), session.getCommitted()),
	});
	const incomingChanges = (opened: OpenedProject): { doc: OpenedProject['document']; set: ChangeSet } => {
		const base = autosaver.baseDocument();
		const doc = shareStructure(base, opened.document);
		return {
			doc,
			set: {
				labels: incomingLabels(autosaver.getStatus().serverRevision, opened.revision),
				summary: summarizeChanges(base, doc),
			},
		};
	};
	const details = (source: ConflictDetails['source'], opened: OpenedProject): ConflictDetails => ({
		serverRevision: opened.revision,
		source,
		incoming: incomingChanges(opened).set,
		local: localChanges(),
	});
	const live = () => !disposed && !session.getState().readOnly && session.getState().lease.status === 'held';

	let pending: Promise<void> = Promise.resolve();
	const track = (p: Promise<void>) => {
		pending = pending.then(() => p).catch(() => undefined);
	};

	/** A conflict is pending without details: read the project on disk and say what each choice discards. */
	async function explainConflict(source: ConflictDetails['source'], read?: OpenedProject): Promise<void> {
		const c = autosaver.getStatus().conflict;
		if (disposed || !c || c.details) return;
		let opened: OpenedProject;
		try {
			opened = read ?? (await store!.open(session.projectId));
		} catch (e) {
			console.warn('[persistence] could not read the project to describe the conflict', e);
			return;
		}
		if (disposed || !autosaver.getStatus().conflict) return;
		autosaver.setConflictDetails(details(source, opened));
	}

	/**
	 * The lease was re-acquired: the project was unleased in between, so a headless write may have landed. Compares
	 * the revision on disk with the one this window's next save is based on.
	 */
	async function reconcile(): Promise<void> {
		// A save that starts while the project is read decides by itself (saved, or a 409): look again after it.
		for (let attempt = 0; attempt < 3; attempt++) {
			await autosaver.settled();
			if (!live()) return;
			if (autosaver.getStatus().conflict) return explainConflict('save');
			let opened: OpenedProject;
			try {
				opened = await store!.open(session.projectId);
			} catch (e) {
				// The next autosave still sends If-Match: a change saved elsewhere surfaces as a 409 then.
				console.warn('[persistence] could not check the project after re-acquiring the lease', e);
				return;
			}
			if (!live()) return;
			const st = autosaver.getStatus();
			if (st.saving) continue;
			if (st.conflict) return explainConflict('save', opened);
			if (opened.revision === st.serverRevision) return;
			const s = session.getState();
			const clean =
				!s.dirty && s.revision === st.lastSavedRevision && !session.gestureActive && !opened.readOnly;
			if (!clean) {
				autosaver.reportConflict(opened.revision, details('lease', opened));
				opts.onConflict?.(opened.revision);
				return;
			}
			const incoming = incomingChanges(opened);
			const r = session.adoptSaved(incoming.doc, opened.revision, `Updated to revision ${opened.revision}`);
			if (!r.ok) {
				autosaver.reportConflict(opened.revision, details('lease', opened));
				opts.onConflict?.(opened.revision);
				return;
			}
			autosaver.adopted(opened.revision, r.revision, incoming.doc);
			void journal?.saved(r.revision);
			opts.onUpdated?.({ revision: opened.revision, incoming: incoming.set });
			return;
		}
	}
	const offReacquired = session.on('lease.reacquired', () => track(reconcile()));
	// While the conflict shows, what Reload would discard follows the edits still made here.
	const offDocChanged = session.on('doc.changed', () => {
		const d = autosaver.getStatus().conflict?.details;
		if (d) autosaver.setConflictDetails({ ...d, local: localChanges() });
	});

	// Closing the session first (the project host unmounts before its subtree) must not release the lease under the
	// last save and journal write.
	let offClose = () => {};
	const controller: PersistenceController = {
		session,
		autosaver,
		journal,
		flush: () => autosaver.flush(),
		noteExternalChange(change) {
			if (!Number.isFinite(change.revision)) return;
			external.push({ revision: change.revision, label: change.label });
			if (external.length > MAX_CHANGE_LABELS * 4)
				external.splice(0, external.length - MAX_CHANGE_LABELS * 4);
		},
		idle: () => pending,
		async dispose(o = {}) {
			if (disposed) return;
			disposed = true;
			offClose();
			offPersistence();
			offReacquired();
			offDocChanged();
			win?.removeEventListener('pagehide', flushQuietly);
			win?.removeEventListener('beforeunload', onBeforeUnload);
			doc?.removeEventListener('visibilitychange', onVisibility);
			// Detach synchronously so a re-attach (React StrictMode remount) gets a fresh controller.
			if (controllers.get(session) === controller) controllers.delete(session);
			if (o.discardUnsaved) {
				autosaver.dispose();
				await journal?.discard();
				return;
			}
			try {
				await autosaver.flush();
			} catch {
				// Saving on close is best effort; the error was reported through onError.
			} finally {
				autosaver.dispose();
			}
			// A clean close deletes the journal; changes a failed save left unsaved stay journalled.
			await journal?.close().catch(() => undefined);
		},
	};
	offClose = session.beforeClose(() => controller.dispose());
	controllers.set(session, controller);
	return controller;
}

/**
 * "Take over editing" (S01:PER-040): takes the lease from the other session (engine `takeOver`), closes
 * this read-only session and re-opens the project (latest saved document) as the lease holder.
 */
export async function takeOverSession(
	old: EditorSession,
	opts: { sessionId?: string; ctx?: SessionContext } = {},
): Promise<EditorSession> {
	const store = old.projectStore;
	if (!store) throw new Error('takeOverSession: the session has no ProjectStore');
	const sessionId = opts.sessionId ?? createSessionId();
	await store.acquireLease(old.projectId, sessionId, { takeOver: true });
	await old.close();
	return EditorSession.open({
		store,
		projectId: old.projectId,
		ctx: opts.ctx ?? old.ctx,
		engine: old.engine,
		sessionId,
	});
}

/**
 * Re-opens a project (after a conflict "Reload", a lost lease, File ▸ Revert with `discardUnsaved`, or a version
 * restore). The old session is closed first.
 */
export async function reopenSession(
	old: EditorSession,
	opts: { readOnly?: boolean; sessionId?: string; discardUnsaved?: boolean } = {},
): Promise<EditorSession> {
	const store = old.projectStore;
	if (!store) throw new Error('reopenSession: the session has no ProjectStore');
	await persistenceFor(old)?.dispose({ discardUnsaved: opts.discardUnsaved });
	await old.close();
	return EditorSession.open({
		store,
		projectId: old.projectId,
		ctx: old.ctx,
		engine: old.engine,
		readOnly: opts.readOnly,
		sessionId: opts.sessionId,
	});
}
