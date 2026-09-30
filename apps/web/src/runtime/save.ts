// Session saving for the shell (file.save, S01:PER-020): one autosaver per EditorSession, created on
// demand and shared by everyone who calls ensureAutosaver (WP-2E persistence UI should use it too so a
// session never has two savers). Flushed on pagehide and when the session closes.
import { type Autosaver, createAutosaver, type EditorSession } from '@jasper/session';

const savers = new WeakMap<EditorSession, Autosaver>();
const conflicts = new WeakMap<EditorSession, number>();

/** The session's autosaver (created once); null when the session has no store or is read-only. */
export function ensureAutosaver(session: EditorSession): Autosaver | null {
	const existing = savers.get(session);
	if (existing) return existing;
	const store = session.projectStore;
	if (!store || session.getState().readOnly) return null;
	const saver = createAutosaver(session, store, {
		onConflict: (rev) => conflicts.set(session, rev),
		onError: (e) => console.warn('[autosave] save failed', e),
	});
	savers.set(session, saver);
	const off = session.on('closed', () => {
		off();
		saver.dispose();
		savers.delete(session);
	});
	return saver;
}

export type SaveOutcome = 'saved' | 'unchanged' | 'no-store' | 'read-only' | 'conflict' | 'error';

/** Forces a save now (Ctrl+S). */
export async function saveNow(session: EditorSession): Promise<SaveOutcome> {
	if (session.getState().readOnly) return 'read-only';
	const saver = ensureAutosaver(session);
	if (!saver) return 'no-store';
	const before = saver.lastSavedRevision;
	conflicts.delete(session);
	try {
		await saver.flush();
	} catch {
		return 'error';
	}
	if (conflicts.has(session)) return 'conflict';
	if (session.getState().dirty) return 'error';
	return saver.lastSavedRevision === before ? 'unchanged' : 'saved';
}

/** Flushes every live saver (pagehide/beforeunload). */
export function flushAutosaver(session: EditorSession | null | undefined): void {
	if (session) void savers.get(session)?.flush();
}
