// Optical flow runs the project kernel in worker threads, inlined so workers need no module loading.
// Each task reuses the flow of its source-frame pair for every requested interpolation fraction.
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { flowKernelSource } from '@jasper/project';
import { ExportWorkerPool } from '../worker-pool.ts';

const WORKER_SOURCE = `
// Functions are inlined by their source text: under tsx (dev engine) esbuild's keepNames wraps them in __name().
var __name = (f) => f;
const { parentPort } = require('node:worker_threads');
const K = ${flowKernelSource()};
let pairKey = null;
let pair = null;
parentPort.on('message', (m) => {
	try {
		const a = { width: m.w, height: m.h, data: new Uint8Array(m.a) };
		const b = { width: m.w, height: m.h, data: new Uint8Array(m.b) };
		if (pairKey !== m.key) {
			pair = K.computeFlowPair(a, b, 255);
			pairKey = m.key;
		}
		const outs = m.ws.map((w) => {
			const data = new Uint8Array(m.w * m.h * 4);
			K.interpolateFlow(a, b, w, pair, { data });
			return data.buffer;
		});
		parentPort.postMessage({ outs }, outs);
	} catch (e) {
		parentPort.postMessage({ error: String(e && e.stack || e) });
	}
});
`;

type FlowRequest = {
	key: string;
	a: ArrayBuffer;
	b: ArrayBuffer;
	w: number;
	h: number;
	ws: number[];
};

type FlowResponse = { outs: ArrayBuffer[] } | { error: string };

export class FlowPool {
	private readonly pool: ExportWorkerPool<FlowRequest, FlowResponse>;

	constructor(workers = Math.max(1, Math.min(8, availableParallelism() - 1))) {
		this.pool = new ExportWorkerPool('flow', workers, () => new Worker(WORKER_SOURCE, { eval: true }));
	}

	get size(): number {
		return this.pool.size;
	}

	/** Interpolates RGBA frames at each fraction in `ws`; `key` identifies the cached flow pair. */
	async run(
		key: string,
		a: Uint8Array,
		b: Uint8Array,
		w: number,
		h: number,
		ws: number[],
	): Promise<Uint8Array[]> {
		const ac = a.slice().buffer;
		const bc = b.slice().buffer;
		const response = await this.pool.run({ key, a: ac, b: bc, w, h, ws }, [ac, bc]);
		if ('error' in response) throw new Error(`optical flow worker: ${response.error}`);
		return response.outs.map((buffer) => new Uint8Array(buffer));
	}

	close(): Promise<void> {
		return this.pool.close();
	}
}
