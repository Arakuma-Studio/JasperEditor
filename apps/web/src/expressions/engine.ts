// Loads the QuickJS engine on demand and refreshes expression-aware views when it becomes ready.
import { isExpressionEngineLoaded, loadExpressionEngine } from '@jasper/expressions';
import { documentHasAnyExpressions, type ProjectDocument } from '@jasper/project';
import { useEffect, useSyncExternalStore } from 'react';

let ready = isExpressionEngineLoaded();
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Loads the engine once; listeners re-render when it is ready. */
export function ensureExpressionEngine(): Promise<void> {
	if (ready) return Promise.resolve();
	if (!pending)
		pending = loadExpressionEngine().then(
			() => {
				ready = true;
				for (const l of listeners) l();
			},
			() => {
				pending = null;
				for (const l of listeners) l();
			},
		);
	return pending;
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};

/**
 * Starts loading the engine as soon as the document has an expression and returns whether it is ready (callers put
 * the flag in their memo dependencies so they rebuild with bound values once it is).
 */
export function useExpressionsFor(doc: ProjectDocument | null): boolean {
	const isReady = useSyncExternalStore(subscribe, () => ready);
	const needs = !!doc && documentHasAnyExpressions(doc);
	useEffect(() => {
		if (needs && !isReady) void ensureExpressionEngine();
	}, [needs, isReady]);
	return isReady;
}
