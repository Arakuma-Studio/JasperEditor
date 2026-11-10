// Persistence controller: one per open session. Wires autosave (S01:PER-020) to the page lifecycle
// (flush on `visibilitychange` → hidden and `pagehide`, S01:PER-022), exposes the read-only reason
// (lease held elsewhere S01:PER-040, newer schema S01:MIG-003) and implements "Take over editing". The crash-
// recovery journal (S01:PER-021, AC-18, D-39) runs next to autosave when the store supports it.
import { CURRENT_SCHEMA_VERSION } from '@jasper/project';
import { EditorSession, type SessionContext } from '../session.ts';
import { createSessionId } from '../session-id.ts';
import type { SessionState } from '../types.ts';
import { type AutosaveOptions, type Autosaver, createAutosaver } from './autosave.ts';
import { createRecoveryJournal, type RecoveryJournalWriter } from './recovery.ts';
import { hasRecovery, type ProjectStore } from './types.ts';

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
	} = {},
): PersistenceController {
	const existing = controllers.get(session);
	if (existing) return existing;
	const store = opts.store ?? session.projectStore;
	if (!store) throw new Error('attachPersistence: the session has no ProjectStore');
	let journal: RecoveryJournalWriter | null = null;
	const autosaver = createAutosaver(session, store, {
		...opts,
		onSaved: (revision) => {
			opts.onSaved?.(revision);
			void journal?.saved(revision);
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
	let disposed = false;
	// Closing the session first (the project host unmounts before its subtree) must not release the lease under the
	// last save and journal write.
	let offClose = () => {};
	const controller: PersistenceController = {
		session,
		autosaver,
		journal,
		flush: () => autosaver.flush(),
		async dispose(o = {}) {
			if (disposed) return;
			disposed = true;
			offClose();
			offPersistence();
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
