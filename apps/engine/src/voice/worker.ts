// Worker-thread entry of the voice analysis (pool.ts): `VoiceFeatureExtractor` blocks off the engine's main thread.
// Bundled by `scripts/build.mjs` to `dist/voice-worker.mjs`; from the source tree it runs under the tsx loader the dev
// engine was started with. Protocol: `VoiceWorkerRequest` / `VoiceWorkerResponse` in pool.ts.
import { parentPort } from 'node:worker_threads';
import { VoiceFeatureExtractor } from '@jasper/audio-dsp';
import { computeBlock, type VoiceWorkerRequest, type VoiceWorkerResponse } from './pool.ts';

const extractor = new VoiceFeatureExtractor();

parentPort?.on('message', (m: VoiceWorkerRequest) => {
	let out: VoiceWorkerResponse;
	try {
		if (!(m.signal instanceof Float32Array)) throw new Error('the block has no samples');
		out = { id: m.id, ok: true, ...computeBlock(extractor, m) };
	} catch (e) {
		out = { id: m.id, ok: false, message: String((e as Error)?.message ?? 'feature extraction failed') };
	}
	if (out.ok) parentPort?.postMessage(out, [out.level.buffer, out.voicing.buffer, out.flatness.buffer]);
	else parentPort?.postMessage(out);
});
parentPort?.postMessage({ id: 0, ready: true } satisfies VoiceWorkerResponse);
