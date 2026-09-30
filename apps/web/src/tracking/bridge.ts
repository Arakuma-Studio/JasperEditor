// Engine ↔ tracking state bridge: forwards `tracking.progress` and job end events to the tracking actions. Mounted
// by every tracking UI (section, overlays); ref-counted so exactly one subscription is live per engine.
import type { EditorSession } from '@jasper/session';
import { useEffect } from 'react';
import { type EngineState, useEngineOrNull } from '../state/engine.tsx';
import { handleEngineEvent, type TrackingEngine } from './actions.ts';

type Subscribe = EngineState['subscribe'];

let active: {
	subscribe: Subscribe;
	count: number;
	off: () => void;
	session: { current: EditorSession };
} | null = null;

export function attachTrackingBridge(
	subscribe: Subscribe,
	engine: TrackingEngine,
	session: EditorSession,
): () => void {
	if (active && active.subscribe === subscribe) {
		active.count++;
		active.session.current = session;
	} else {
		active?.off();
		const ref = { current: session };
		const off = subscribe((_e, raw) => handleEngineEvent(ref.current, engine, raw));
		active = { subscribe, count: 1, off, session: ref };
	}
	const mine = active;
	return () => {
		if (active !== mine) return;
		mine.count--;
		if (mine.count <= 0) {
			mine.off();
			active = null;
		}
	};
}

/** Keeps the tracking state fed with engine events while the calling component is mounted. */
export function useTrackingBridge(session: EditorSession): TrackingEngine | null {
	const engine = useEngineOrNull();
	const subscribe = engine?.subscribe;
	const client = engine?.client ?? null;
	useEffect(() => {
		if (!subscribe || !client) return;
		return attachTrackingBridge(subscribe, client, session);
	}, [subscribe, client, session]);
	return client;
}
