// Persistence controller: one per open session. Wires autosave (S01:PER-020) to the page lifecycle
// (flush on `visibilitychange` → hidden and `pagehide`, S01:PER-022), exposes the read-only reason
// (lease held elsewhere S01:PER-040, newer schema S01:MIG-003) and implements "Take over editing".
import { CURRENT_SCHEMA_VERSION } from '@jasper/project';
import { EditorSession, type SessionContext } from '../session.ts';
import type { SessionState } from '../types.ts';
import { type AutosaveOptions, type Autosaver, createAutosaver } from './autosave.ts';
import type { ProjectStore } from './types.ts';

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
	flush(): Promise<void>;
	/** Flushes, stops autosave and removes the page listeners (the caller closes the session). */
	dispose(): Promise<void>;
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
	} = {},
): PersistenceController {
	const existing = controllers.get(session);
	if (existing) return existing;
	const store = opts.store ?? session.projectStore;
	if (!store) throw new Error('attachPersistence: the session has no ProjectStore');
	const autosaver = createAutosaver(session, store, opts);
	const win =
		opts.window === undefined ? (globalThis as unknown as { window?: LifecycleTarget }).window : opts.window;
	const doc =
		opts.document === undefined
			? (globalThis as unknown as { document?: LifecycleTarget & { visibilityState?: string } }).document
			: opts.document;

	const flushQuietly = () => {
		void autosaver.flush().catch(() => undefined);
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
			(e as unknown as { returnValue: string }).returnValue = '';
		}
	};
	win?.addEventListener('pagehide', flushQuietly);
	win?.addEventListener('beforeunload', onBeforeUnload);
	doc?.addEventListener('visibilitychange', onVisibility);

	let disposed = false;
	const controller: PersistenceController = {
		session,
		autosaver,
		flush: () => autosaver.flush(),
		async dispose() {
			if (disposed) return;
			disposed = true;
			win?.removeEventListener('pagehide', flushQuietly);
			win?.removeEventListener('beforeunload', onBeforeUnload);
			doc?.removeEventListener('visibilitychange', onVisibility);
			// Detach synchronously so a re-attach (React StrictMode remount) gets a fresh controller.
			if (controllers.get(session) === controller) controllers.delete(session);
			try {
				await autosaver.flush();
			} catch {
				// Saving on close is best effort; the error was reported through onError.
			} finally {
				autosaver.dispose();
			}
		},
	};
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
	const sessionId = opts.sessionId ?? `ses_${Math.random().toString(36).slice(2, 12)}`;
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

/** Re-opens a project (after a conflict "Reload" or a lost lease). The old session is closed first. */
export async function reopenSession(
	old: EditorSession,
	opts: { readOnly?: boolean; sessionId?: string } = {},
): Promise<EditorSession> {
	const store = old.projectStore;
	if (!store) throw new Error('reopenSession: the session has no ProjectStore');
	await persistenceFor(old)?.dispose();
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
