// Hooks run before an agent transaction (or an agent's undo / redo) reaches a session. A UI feature that holds the
// session's gesture slot for its own preview, not for an edit the user is making (the Sound Library's In Context
// audition), yields it here, so the agent's edit applies at once instead of waiting in the session's queue
// (S01:SES-006) behind a preview that may play for minutes — or forever when no Program monitor plays it.
import type { EditorSession } from '@jasper/session';

type Hook = (session: EditorSession) => void;

const hooks = new Set<Hook>();

/** Registers a hook; returns its remover. */
export function beforeAgentTransaction(hook: Hook): () => void {
	hooks.add(hook);
	return () => {
		hooks.delete(hook);
	};
}

/** Runs the hooks (a hook that throws is skipped: it never blocks the agent's transaction). */
export function runBeforeAgentTransaction(session: EditorSession): void {
	for (const hook of [...hooks]) {
		try {
			hook(session);
		} catch {
			// a preview that cannot stop must not refuse the agent; the session queues the transaction then
		}
	}
}
