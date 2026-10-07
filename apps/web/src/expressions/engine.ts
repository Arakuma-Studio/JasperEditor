// Wave expressions in the editor: loading the QuickJS engine on demand (a lazy chunk) and the bound document that
// every expression-aware view reads (Program overlays, Effect Controls values and graphs).
import { isExpressionEngineLoaded, loadExpressionEngine } from '@jasper/expressions';
import { bindExpressions, documentExpressions, type ProjectDocument } from '@jasper/project';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

let ready = isExpressionEngineLoaded();
let failed: string | null = null;
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
			(e) => {
				failed = (e as Error).message ?? String(e);
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

/** True once the expression engine is loaded (re-renders when it becomes ready). */
export function useExpressionEngineReady(): boolean {
	return useSyncExternalStore(subscribe, () => ready);
}

/** The load error, if loading failed. */
export function expressionEngineError(): string | null {
	return failed;
}

const hasAny = new WeakMap<object, boolean>();
/** True when the document stores any expression (enabled or not). */
export function documentHasExpressions(doc: ProjectDocument): boolean {
	const hit = hasAny.get(doc.sequences);
	if (hit !== undefined) return hit;
	const v = !documentExpressions(doc).next().done;
	hasAny.set(doc.sequences, v);
	return v;
}

/**
 * Starts loading the engine as soon as the document has an expression and returns whether it is ready (callers put
 * the flag in their memo dependencies so they rebuild with bound values once it is).
 */
export function useExpressionsFor(doc: ProjectDocument | null): boolean {
	const isReady = useExpressionEngineReady();
	const needs = !!doc && documentHasExpressions(doc);
	useEffect(() => {
		if (needs && !isReady) void ensureExpressionEngine();
	}, [needs, isReady]);
	return isReady;
}

/** The document with its expressions bound (identity without expressions or before the engine is loaded). */
export function useBoundDocument(doc: ProjectDocument): ProjectDocument {
	const isReady = useExpressionsFor(doc);
	return useMemo(() => (isReady ? bindExpressions(doc) : doc), [doc, isReady]);
}
