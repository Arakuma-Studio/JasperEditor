// Scope computation client: a module Worker (scopes.worker.ts) with a main-thread fallback (tests, old browsers).
import { computeScopes, type ScopesRequest, type ScopesResult } from './compute.ts';
import { computeScope, type ScopeRequest, type ScopeResult } from './math.ts';

/** One worker per panel; falls back to computing on the main thread when Workers are unavailable. */
export function createScopeComputer(onResult: (r: ScopeResult) => void) {
	return createWorkerClient<ScopeRequest, ScopeResult>(onResult, computeScope);
}

/** color-grade: every scope of a layout per frame (`computeScopes`). */
export function createScopesComputer(onResult: (r: ScopesResult) => void) {
	return createWorkerClient<ScopesRequest, ScopesResult>(onResult, computeScopes);
}

function createWorkerClient<Q extends { data: Uint8ClampedArray }, R>(
	onResult: (r: R) => void,
	local: (q: Q) => R,
) {
	let worker: Worker | null = null;
	try {
		if (typeof Worker !== 'undefined')
			worker = new Worker(new URL('./scopes.worker.ts', import.meta.url), { type: 'module' });
	} catch {
		worker = null;
	}
	if (worker) worker.onmessage = (e: MessageEvent<R>) => onResult(e.data);
	return {
		post(req: Q) {
			if (worker) worker.postMessage(req, [req.data.buffer as ArrayBuffer]);
			else onResult(local(req));
		},
		dispose() {
			worker?.terminate();
		},
	};
}
