// Worker-thread entry of the sound analysis (wp-note "WP1.2"): `runAnalysis` off the engine's main thread. Bundled by
// `scripts/build.mjs` to `dist/sound-worker.mjs`; from the source tree it runs under the tsx loader the dev engine
// was started with. Protocol: `WorkerRequest` / `WorkerResponse` in analysis.ts.
import { parentPort } from 'node:worker_threads';
import type { WorkerRequest, WorkerResponse } from './analysis.ts';
import { runAnalysis } from './analysis-core.ts';

parentPort?.on('message', (m: WorkerRequest) => {
	let out: WorkerResponse;
	try {
		out = { id: m.id, ok: true, result: runAnalysis(m.job) };
	} catch (e) {
		out = { id: m.id, ok: false, message: String((e as Error)?.message ?? 'analysis failed') };
	}
	parentPort?.postMessage(out);
});
parentPort?.postMessage({ id: 0, ready: true } satisfies WorkerResponse);
