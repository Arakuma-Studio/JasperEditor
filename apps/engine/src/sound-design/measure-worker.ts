// Worker-thread entry of the sound-design measurements (wp-note WP6.5b item 7): `runMeasureOp` (solo and bed renders
// through the offline mixer, band analysis) off the engine's main thread. Bundled by `scripts/build.mjs` to
// `dist/sd-measure-worker.mjs`; from the source tree it runs under the tsx loader the dev engine was started with.
// Protocol: `MeasureWorkerRequest` / `MeasureWorkerResponse` in measure-pool.ts. A `{cancel: id}` message aborts that
// op (its ffmpeg decoders are killed through the signal); an op's progress goes back as `{id, progress, stage}`, at
// most one every PROGRESS_MS (the first at once).
import { parentPort } from 'node:worker_threads';
import { Ffmpeg } from '../tools/ffmpeg.ts';
import { runMeasureOp, transferablesOf } from './measure-core.ts';
import type { MeasureWorkerRequest, MeasureWorkerResponse } from './measure-pool.ts';

const running = new Map<number, AbortController>();
const PROGRESS_MS = 200;
const tools = new Map<string, Ffmpeg>();

parentPort?.on('message', (m: MeasureWorkerRequest) => {
	if ('cancel' in m) {
		running.get(m.cancel)?.abort();
		return;
	}
	const ac = new AbortController();
	running.set(m.id, ac);
	const key = JSON.stringify(m.bins);
	let ff = tools.get(key);
	if (!ff) tools.set(key, (ff = new Ffmpeg(m.bins)));
	let sentAt = Number.NEGATIVE_INFINITY;
	const onProgress = (progress: number, stage: string) => {
		const now = Date.now();
		if (now - sentAt < PROGRESS_MS || !Number.isFinite(progress)) return;
		sentAt = now;
		parentPort?.postMessage({ id: m.id, progress, stage } satisfies MeasureWorkerResponse);
	};
	void runMeasureOp(m.op, { ff, signal: ac.signal, onProgress }).then(
		(result) => {
			running.delete(m.id);
			const out: MeasureWorkerResponse = { id: m.id, ok: true, result };
			parentPort?.postMessage(out, transferablesOf(result));
		},
		(e: unknown) => {
			running.delete(m.id);
			const out: MeasureWorkerResponse = {
				id: m.id,
				ok: false,
				message: String((e as Error)?.message ?? 'measurement failed'),
				aborted: ac.signal.aborted,
				...(typeof (e as { code?: unknown })?.code === 'string'
					? { code: (e as { code: string }).code }
					: {}),
				...(typeof (e as { retryable?: unknown })?.retryable === 'boolean'
					? { retryable: (e as { retryable: boolean }).retryable }
					: {}),
			};
			parentPort?.postMessage(out);
		},
	);
});
parentPort?.postMessage({ id: 0, ready: true } satisfies MeasureWorkerResponse);
