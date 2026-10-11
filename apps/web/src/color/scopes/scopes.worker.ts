import { computeScopes, type ScopesRequest } from './compute.ts';

self.onmessage = (event: MessageEvent<ScopesRequest>) => {
	const result = computeScopes(event.data);
	const transfer: Transferable[] = result.images.map((image) => image.image.buffer as ArrayBuffer);
	if (result.histogram)
		transfer.push(
			result.histogram.r.buffer as ArrayBuffer,
			result.histogram.g.buffer as ArrayBuffer,
			result.histogram.b.buffer as ArrayBuffer,
			result.histogram.y.buffer as ArrayBuffer,
		);
	self.postMessage(result, { transfer });
};
