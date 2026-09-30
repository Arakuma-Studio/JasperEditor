// Web Worker: waveform level reduction off the main thread (S02:TL-157, ARCHITECTURE §13).
import { type ColumnRequest, reduceColumns } from '../model/waveform.ts';

type LoadMsg = { type: 'load'; key: string; peaks: Float32Array };
type ReduceMsg = { type: 'reduce'; id: number; key: string; req: ColumnRequest };

const store = new Map<string, Float32Array>();
const scope = self as unknown as {
	onmessage: ((e: MessageEvent<LoadMsg | ReduceMsg>) => void) | null;
	postMessage(msg: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
	const m = e.data;
	if (m.type === 'load') {
		store.set(m.key, m.peaks);
		return;
	}
	const peaks = store.get(m.key) ?? new Float32Array(0);
	const columns = reduceColumns(peaks, m.req);
	scope.postMessage({ id: m.id, columns }, [columns.buffer]);
};
