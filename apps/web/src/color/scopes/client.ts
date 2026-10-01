// Scope computation client: a module Worker (scopes.worker.ts) with a main-thread fallback (tests, old browsers).
import { computeScope, type ScopeRequest, type ScopeResult } from './math.ts';

/** One worker per panel; falls back to computing on the main thread when Workers are unavailable. */
export function createScopeComputer(onResult: (r: ScopeResult) => void) {
	let worker: Worker | null = null;
	try {
		if (typeof Worker !== 'undefined')
			worker = new Worker(new URL('./scopes.worker.ts', import.meta.url), { type: 'module' });
	} catch {
		worker = null;
	}
	if (worker) worker.onmessage = (e: MessageEvent<ScopeResult>) => onResult(e.data);
	return {
		post(req: ScopeRequest) {
			if (worker) worker.postMessage(req, [req.data.buffer as ArrayBuffer]);
			else onResult(computeScope(req));
		},
		dispose() {
			worker?.terminate();
		},
	};
}
