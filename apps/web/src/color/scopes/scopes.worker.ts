// Computes every scope of the panel's layout off the main thread and transfers the trace buffers back.
import { computeScopes, type ScopesRequest } from './compute.ts';

const ctx = self as unknown as {
	onmessage: ((e: MessageEvent<ScopesRequest>) => void) | null;
	postMessage(msg: unknown, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
	const r = computeScopes(e.data);
	const transfer: Transferable[] = r.images.map((i) => i.image.buffer as ArrayBuffer);
	if (r.histogram)
		transfer.push(
			r.histogram.r.buffer as ArrayBuffer,
			r.histogram.g.buffer as ArrayBuffer,
			r.histogram.b.buffer as ArrayBuffer,
			r.histogram.y.buffer as ArrayBuffer,
		);
	ctx.postMessage(r, transfer);
};
