// Session write helpers for the inspector panels: discrete edits (one History entry each) and scrubs
// (one gesture per drag, S05:CT-023 / S03:PRP-023: transient updates never reach History).
import type { Command, TransactionResult } from '@jasper/project';
import type { EditorSession, Gesture } from '@jasper/session';
import { useMemo, useRef } from 'react';

type ScrubHandle = {
	start(label: string): boolean;
	update(commands: Command[]): TransactionResult | null;
	end(cancelled: boolean): TransactionResult | null;
};

export type InspectorOps = {
	apply(label: string, commands: Command[], opts?: { coalesceKey?: string }): TransactionResult | null;
	scrub: ScrubHandle;
};

/** Applies a user transaction; empty command lists are a no-op. */
function applyUser(
	session: EditorSession,
	label: string,
	commands: Command[],
	opts: { coalesceKey?: string } = {},
): TransactionResult | null {
	if (commands.length === 0) return null;
	const r = session.apply({ label, origin: 'user', commands, ...opts });
	if (!r.ok) console.warn(`[inspector] ${label} refused`, r.errors);
	return r;
}

/** One gesture per scrub; `update` re-applies to the gesture base (S01:SES-006). */
export function createScrub(session: EditorSession): ScrubHandle {
	let gesture: Gesture | null = null;
	return {
		start(label) {
			if (gesture?.active) return true;
			if (session.gestureActive) return false;
			gesture = session.beginGesture(label);
			return true;
		},
		update(commands) {
			if (!gesture?.active) return null;
			return gesture.update(commands);
		},
		end(cancelled) {
			const g = gesture;
			gesture = null;
			if (!g?.active) return null;
			if (cancelled) {
				g.cancel();
				return null;
			}
			return g.commit();
		},
	};
}

export function useInspectorOps(session: EditorSession): InspectorOps {
	const scrubRef = useRef<{ session: EditorSession; handle: ScrubHandle } | null>(null);
	if (!scrubRef.current || scrubRef.current.session !== session)
		scrubRef.current = { session, handle: createScrub(session) };
	const scrub = scrubRef.current.handle;
	return useMemo(
		() => ({
			apply: (label, commands, opts) => applyUser(session, label, commands, opts),
			scrub,
		}),
		[session, scrub],
	);
}
