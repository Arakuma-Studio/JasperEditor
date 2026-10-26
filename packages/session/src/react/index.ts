import type { ProjectDocument } from '@jasper/project';
import {
	createContext,
	createElement,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { derivedPreviewDocument, derivedPreviewFor } from '../derived-preview.ts';
import { gestureFrames } from '../gesture-frames.ts';
import type { EditorSession } from '../session.ts';
import type { TransportState, TransportStore } from '../transport.ts';
import type { Selection, SequenceViewState, SessionState } from '../types.ts';

const SessionContext = createContext<EditorSession | null>(null);

export function SessionProvider(props: { session: EditorSession | null; children?: ReactNode }) {
	return createElement(SessionContext.Provider, { value: props.session }, props.children);
}

/** The current session, or null outside an open project. */
export function useSessionOrNull(): EditorSession | null {
	return useContext(SessionContext);
}

export function useSession(): EditorSession {
	const s = useContext(SessionContext);
	if (!s) throw new Error('useSession must be used inside <SessionProvider session={…}>');
	return s;
}

/**
 * ui-perf: subtrees that nobody sees (a panel in a background tab) stop following store updates while `frozen`:
 * `useStoreSelector` keeps returning the value it last rendered, so a gesture or an edit does not re-render them;
 * they read the current state again the moment they are unfrozen. Effects stay mounted (services, listeners).
 */
const FreezeContext = createContext(false);

export function FreezeStoreUpdates(props: { frozen: boolean; children?: ReactNode }) {
	return createElement(FreezeContext.Provider, { value: props.frozen }, props.children);
}

/**
 * Selector hook over the session store. The selector result is memoized by the store state
 * reference and compared with `equality` (default `Object.is`) so unrelated updates do not re-render.
 * Inside a frozen subtree (`FreezeStoreUpdates`) it keeps the last rendered value until unfrozen.
 */
export function useStoreSelector<S, T>(
	store: { getState(): S; subscribe(l: (s: S, p: S) => void): () => void },
	selector: (s: S) => T,
	equality: (a: T, b: T) => boolean = Object.is,
): T {
	const committed = useRef<{ value: T } | null>(null);
	const frozen = useContext(FreezeContext);
	const getSnapshot = useMemo(() => {
		let cache: { state: S; value: T } | null = null;
		return () => {
			if (frozen && committed.current) return committed.current.value;
			const state = store.getState();
			if (cache && cache.state === state) return cache.value;
			const selected = selector(state);
			const previous = cache ?? committed.current;
			const value = previous && equality(previous.value, selected) ? previous.value : selected;
			cache = { state, value };
			return value;
		};
	}, [store, selector, equality, frozen]);
	const value = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
	useEffect(() => {
		committed.current = { value };
	}, [value]);
	return value;
}

export function useSessionState<T>(selector: (s: SessionState) => T, equality?: (a: T, b: T) => boolean): T {
	return useStoreSelector(useSession().store, selector, equality);
}

/** Selects from the drawn document (transient gesture document when present, S01:SES-007). */
export function useDocument<T>(selector: (doc: ProjectDocument) => T, equality?: (a: T, b: T) => boolean): T {
	return useSessionState((s) => selector(s.transient ?? s.document), equality);
}

/**
 * The drawn document for costly views (Program monitor): like `useDocument((d) => d)`, but gesture frames arrive
 * throttled to what the views can afford (`gestureFrames`, ui-perf); commits, undo and cancels arrive at once.
 */
export function useGestureFrameDocument(): ProjectDocument {
	const frames = gestureFrames(useSession().store);
	return useSyncExternalStore(frames.subscribe, frames.getState, frames.getState);
}

export function useSelection(): Selection {
	return useSessionState((s) => s.selection);
}

export function useSequenceView(sequenceId: string | null): SequenceViewState | null {
	return useSessionState((s) => (sequenceId ? (s.views[sequenceId] ?? null) : null));
}

export function useTransport(): TransportStore {
	return useSession().transport;
}

/** Transport state with at most one re-render per `throttleMs` (the playhead line itself writes to the DOM). */
export function useTransportFrame(throttleMs = 100): TransportState {
	const transport = useTransport();
	const [state, setState] = useState(transport.getState());
	useEffect(() => {
		let last = 0;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const off = transport.subscribe((s) => {
			const now = Date.now();
			const wait = throttleMs - (now - last);
			if (wait <= 0) {
				last = now;
				setState(s);
			} else if (!timer) {
				timer = setTimeout(() => {
					timer = null;
					last = Date.now();
					setState(transport.getState());
				}, wait);
			}
		});
		return () => {
			off();
			if (timer) clearTimeout(timer);
		};
	}, [transport, throttleMs]);
	return state;
}

/**
 * The derived preview the Program monitor plays instead of the sequence (spec 14 "Play result"), or null: none
 * running, or a gesture draws its own transient.
 */
export function useDerivedPreviewDocument(session: EditorSession): ProjectDocument | null {
	const active = useStoreSelector(derivedPreviewFor(session).store, (s) => s.active);
	const gesture = useStoreSelector(session.store, (s) => s.gesture !== null);
	void gesture; // re-render when a gesture starts or ends
	return derivedPreviewDocument({ active }, session);
}
