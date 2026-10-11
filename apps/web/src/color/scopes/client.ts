// Scope computation client: a module Worker with a main-thread fallback (tests, old browsers).
import { computeScopes, type ScopesRequest, type ScopesResult } from './compute.ts';

/** One worker per panel computes every scope of its layout for each frame. */
export function createScopesComputer(onResult: (r: ScopesResult) => void) {
	let worker: Worker | null = null;
	try {
		if (typeof Worker !== 'undefined')
			worker = new Worker(new URL('./scopes.worker.ts', import.meta.url), { type: 'module' });
	} catch {
		worker = null;
	}
	if (worker) worker.onmessage = (e: MessageEvent<ScopesResult>) => onResult(e.data);
	return {
		post(req: ScopesRequest) {
			if (worker) worker.postMessage(req, [req.data.buffer as ArrayBuffer]);
			else onResult(computeScopes(req));
		},
		dispose() {
			worker?.terminate();
		},
	};
}
