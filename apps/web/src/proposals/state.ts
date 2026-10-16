// The editor's side of the session proposals slice (spec 12 §2.5, P3-R4): one `ProposalsController` per open session
// (`proposalsFor`), fed with the engine's `proposal.changed` events and re-read when the event stream (re)opens; React
// hooks for the Program monitor (the heard document), the timeline ghosts and the review UI (WP3.3b).
import type { ProposalChangedEvent } from '@jasper/api';
import {
	type EditorSession,
	heardDocument,
	type ProposalsController,
	type ProposalsState,
	proposalsFor,
} from '@jasper/session';
import { useSessionState, useStoreSelector } from '@jasper/session/react';
import { useEffect, useMemo } from 'react';
import { useEngineOrNull } from '../state/engine.tsx';
import { buildGhostModel, type GhostModel } from './ghosts.ts';

export { proposalsFor };

/** Keeps the session's proposals in sync with the engine (mounted once per open project). */
export function useProposalsSync(session: EditorSession): void {
	const engine = useEngineOrNull();
	const subscribe = engine?.subscribe;
	const connected = engine?.status === 'connected';
	const events = engine?.events;
	useEffect(() => {
		if (!subscribe) return;
		const c = proposalsFor(session);
		return c.connect((cb: (e: ProposalChangedEvent) => void) =>
			subscribe((e) => {
				if (e?.type === 'proposal.changed') cb(e.payload);
			}),
		);
	}, [session, subscribe]);
	useEffect(() => {
		// the list (and the proposal under review) again whenever the stream (re)opens: events may have been missed
		if (!connected || (events !== undefined && events !== 'open')) return;
		void proposalsFor(session).refresh();
	}, [session, connected, events]);
}

/** A slice of the session's proposals state. */
export function useProposals<T>(
	session: EditorSession,
	select: (s: ProposalsState) => T,
	eq?: (a: T, b: T) => boolean,
): T {
	const c = proposalsFor(session);
	return useStoreSelector(c.store, select, eq);
}

/** The controller of a session (stable). */
export function useProposalsController(session: EditorSession): ProposalsController {
	return useMemo(() => proposalsFor(session), [session]);
}

/**
 * The document the Program monitor plays instead of the drawn one: the proposal preview while "Hear proposal" is on
 * (and no gesture draws its own transient), else null.
 */
export function useHeardDocument(session: EditorSession) {
	const gesture = useSessionState((s) => s.gesture !== null);
	const st = useProposals(
		session,
		(s) => ({ hear: s.hear, preview: s.preview, activeId: s.activeId }),
		(a, b) => a.hear === b.hear && a.preview === b.preview && a.activeId === b.activeId,
	);
	void gesture; // re-render when a gesture starts or ends
	return heardDocument(st, session);
}

/** The ghosts of the proposal under review in a sequence, or null when nothing is reviewed there. */
export function useGhostModel(session: EditorSession, sequenceId: string): GhostModel | null {
	const st = useProposals(
		session,
		(s) => ({ preview: s.preview, items: s.items, proposal: s.proposal, activeId: s.activeId }),
		(a, b) =>
			a.preview === b.preview &&
			a.items === b.items &&
			a.proposal === b.proposal &&
			a.activeId === b.activeId,
	);
	return useMemo(() => {
		if (!st.activeId || !st.preview || !st.proposal || st.preview.proposalId !== st.activeId) return null;
		const m = buildGhostModel({
			preview: st.preview,
			committed: st.preview.base,
			sequenceId,
			items: st.items,
			agent: typeof st.proposal.author === 'object',
		});
		return m.items.length ? m : null;
	}, [st, sequenceId]);
}
