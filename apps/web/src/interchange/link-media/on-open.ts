// Premiere shows Link Media when a project opens with offline media (docs/wp-notes/link-media.md §5). Here: once per
// opened project, when the engine has answered for every medium, a writable project whose edit USES offline media (a
// clip in any sequence, nested ones included) opens the Link Media dialog — after any dialog already on screen
// (recovery of unsaved changes) has closed. Offline media nothing uses only get the Project panel's quiet badge.
import type { EngineClient } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import { openDialog, openModals, subscribeModals } from '@jasper/ui';
import { useEffect } from 'react';
import { LINK_MEDIA_DIALOG } from '../dialogs.tsx';
import { offlineSummary } from './offline.ts';

/** How long the media runtime may take to resolve before the check gives up (ms). */
const SETTLE_LIMIT_MS = 120_000;

/** Calls `ready` once every medium of the session has an availability other than `resolving`. */
function whenResolved(session: EditorSession, ready: () => void): () => void {
	let done = false;
	const check = () => {
		if (done) return;
		const st = session.getState();
		const ids = Object.keys(st.document.media);
		if (!ids.length) {
			done = true;
			ready();
			return;
		}
		if (ids.some((id) => (st.media[id]?.availability ?? 'resolving') === 'resolving')) return;
		done = true;
		ready();
	};
	const off = session.store.subscribe(check);
	const timer = setTimeout(() => {
		done = true;
	}, SETTLE_LIMIT_MS);
	check();
	return () => {
		done = true;
		off();
		clearTimeout(timer);
	};
}

function whenNoModal(fn: () => void): () => void {
	if (!openModals().length) {
		fn();
		return () => undefined;
	}
	let fired = false;
	const off = subscribeModals(() => {
		if (fired || openModals().length) return;
		fired = true;
		off();
		// Let the closing dialog's promise settle (it may open another one) before deciding.
		setTimeout(() => (openModals().length ? undefined : fn()), 0);
	});
	return () => {
		fired = true;
		off();
	};
}

/** Sessions already checked (an engine reconnect re-runs the effect; the dialog shows at most once per open). */
const checked = new WeakSet<EditorSession>();

export function useLinkMediaOnOpen(session: EditorSession, engine: EngineClient, connected: boolean): void {
	useEffect(() => {
		if (!connected || checked.has(session) || session.getState().readOnly) return;
		let offModal: () => void = () => undefined;
		const offResolved = whenResolved(session, () => {
			checked.add(session);
			if (!offlineSummary(session).used.length) return;
			offModal = whenNoModal(() => {
				if (!offlineSummary(session).used.length || session.getState().readOnly) return;
				void openDialog(LINK_MEDIA_DIALOG, { session, engine, atOpen: true });
			});
		});
		return () => {
			offResolved();
			offModal();
		};
	}, [session, engine, connected]);
}
