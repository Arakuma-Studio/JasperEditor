// Scopes worker (S06:SCP-003): computes the waveform / parade / vectorscope trace image or the histogram of one
// read-back frame off the main thread. Transfers the buffers back.
import { computeScope, type ScopeRequest } from './math.ts';

const ctx = self as unknown as {
	onmessage: ((e: MessageEvent<ScopeRequest>) => void) | null;
	postMessage(msg: unknown, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
	const r = computeScope(e.data);
	const transfer: Transferable[] = [r.image.buffer as ArrayBuffer];
	if (r.histogram)
		transfer.push(
			r.histogram.r.buffer as ArrayBuffer,
			r.histogram.g.buffer as ArrayBuffer,
			r.histogram.b.buffer as ArrayBuffer,
			r.histogram.y.buffer as ArrayBuffer,
		);
	ctx.postMessage(r, transfer);
};
