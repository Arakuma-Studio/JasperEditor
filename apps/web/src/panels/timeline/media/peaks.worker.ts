import { reduceColumns } from '../model/waveform.ts';
import type { PeaksWorkerRequest, PeaksWorkerResponse } from './peaks-protocol.ts';

const store = new Map<string, Float32Array>();

self.onmessage = (e: MessageEvent<PeaksWorkerRequest>) => {
	const m = e.data;
	if (m.type === 'load') {
		store.set(m.key, m.peaks);
		return;
	}
	const peaks = store.get(m.key) ?? new Float32Array(0);
	const columns = reduceColumns(peaks, m.req);
	self.postMessage({ id: m.id, columns } satisfies PeaksWorkerResponse, { transfer: [columns.buffer] });
};
