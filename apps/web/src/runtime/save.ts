// Session saving for the shell (file.save, S01:PER-020). A session has exactly one autosaver: the one
// owned by @jasper/session's persistence controller (attached by WP-2E's <ProjectLifecycle>). The shell
// reuses it; only when nothing attached one yet (e.g. the shell mounted without ProjectLifecycle) does
// ensureAutosaver attach it through the same registry, so two savers never race on If-Match.
import { type Autosaver, attachPersistence, type EditorSession, persistenceFor } from '@jasper/session';

/** The session's autosaver (shared); null when the session has no store or is read-only. */
export function ensureAutosaver(session: EditorSession): Autosaver | null {
	const existing = persistenceFor(session);
	if (existing) return existing.autosaver;
	if (!session.projectStore || session.getState().readOnly) return null;
	const controller = attachPersistence(session, {
		onError: (e) => console.warn('[autosave] save failed', e),
	});
	const off = session.on('closed', () => {
		off();
		void controller.dispose();
	});
	return controller.autosaver;
}

export type SaveOutcome = 'saved' | 'unchanged' | 'no-store' | 'read-only' | 'conflict' | 'error';

/** Forces a save now (Ctrl+S). */
export async function saveNow(session: EditorSession): Promise<SaveOutcome> {
	if (session.getState().readOnly) return 'read-only';
	const saver = ensureAutosaver(session);
	if (!saver) return 'no-store';
	const before = saver.lastSavedRevision;
	try {
		await saver.flush();
	} catch {
		return 'error';
	}
	if (saver.getStatus().conflict) return 'conflict';
	if (session.getState().dirty) return 'error';
	return saver.lastSavedRevision === before ? 'unchanged' : 'saved';
}

let skipUnloadFlush = false;
/**
 * gaps (File ▸ Exit ▸ Don't Save): the window is closing on purpose without saving; the pagehide / beforeunload flush
 * must not save the pending edits (they stay in the crash-recovery journal and are offered on the next open).
 */
export function setSkipUnloadFlush(on: boolean): void {
	skipUnloadFlush = on;
}

/** Flushes every live saver (pagehide/beforeunload). */
export function flushAutosaver(session: EditorSession | null | undefined): void {
	if (skipUnloadFlush) return;
	if (session)
		void persistenceFor(session)
			?.flush()
			.catch(() => undefined);
}
