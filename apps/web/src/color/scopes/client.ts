import { computeScopes, type ScopesRequest, type ScopesResult } from './compute.ts';

export function createScopesComputer(onResult: (result: ScopesResult) => void) {
	let worker: Worker | null = null;
	try {
		if (typeof Worker !== 'undefined')
			worker = new Worker(new URL('./scopes.worker.ts', import.meta.url), { type: 'module' });
	} catch {
		worker = null;
	}
	if (worker) worker.onmessage = (event: MessageEvent<ScopesResult>) => onResult(event.data);
	return {
		post(request: ScopesRequest) {
			if (worker) worker.postMessage(request, [request.data.buffer as ArrayBuffer]);
			else onResult(computeScopes(request));
		},
		dispose() {
			worker?.terminate();
		},
	};
}
