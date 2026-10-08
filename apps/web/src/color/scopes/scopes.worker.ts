// Scopes worker (S06:SCP-003; color-grade): computes the scopes of one read-back frame off the main thread —
// `computeScopes` (every scope of the panel's layout, shared maths of @jasper/project) — and transfers the buffers
// back. The M2 single-scope request (`computeScope`, math.ts) is still answered for older callers.
import { computeScopes, type ScopesRequest } from './compute.ts';
import { computeScope, type ScopeRequest } from './math.ts';

const ctx = self as unknown as {
	onmessage: ((e: MessageEvent<ScopeRequest | ScopesRequest>) => void) | null;
	postMessage(msg: unknown, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
	if ('kinds' in e.data) {
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
		return;
	}
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
