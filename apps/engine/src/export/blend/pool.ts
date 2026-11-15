// Worker-thread pools of the blend pipeline's kernels (keyframes-blend; like stream/pool.ts): each worker runs
// `blendStackedFrame` with `makeBlendKernel` (blend layers), or `adjustStackedFrame` with `drawTaps` (Transform
// adjustment layers, adjust.ts), from their source text on frame slots that live in SharedArrayBuffers, no copies
// across threads.
import { Worker } from 'node:worker_threads';
import { makeBlendKernel } from '@jasper/project';
import { drawTaps } from '../stream/kernel.ts';
import { ExportWorkerPool, framePoolSize } from '../worker-pool.ts';
import { adjustStackedFrame } from './adjust.ts';
import { blendStackedFrame } from './kernel.ts';

/** One reusable frame slot: `src` (composite ‖ layer, `2W×H` RGBA) and `out` (`W×H` RGBA). */
export type BlendSlot = { index: number; src: Uint8Array; out: Uint8Array };

const WORKER_SOURCE = `
// Functions are inlined by their source text: under tsx (dev engine) esbuild's keepNames wraps them in __name().
var __name = (f) => f;
const { parentPort, workerData } = require('node:worker_threads');
const makeBlendKernel = ${makeBlendKernel.toString()};
const blendStackedFrame = ${blendStackedFrame.toString()};
const K = makeBlendKernel();
const len = workerData.W * workerData.H * 4;
const slots = workerData.slots.map((buf) => ({
	src: new Uint8Array(buf, 0, 2 * len),
	out: new Uint8Array(buf, 2 * len, len),
}));
parentPort.on('message', (m) => {
	const s = slots[m.slot];
	blendStackedFrame(K, s.src, workerData.W, workerData.H, m.mode, m.seed, m.active, s.out);
	parentPort.postMessage(m.slot);
});
`;

type Msg = { slot: number; mode: number; seed: number; active: boolean };

export class BlendPool {
	readonly slots: BlendSlot[] = [];
	private readonly pool: ExportWorkerPool<Msg, number>;

	constructor(size: { W: number; H: number }, opts: { workers: number; slots: number }) {
		const counts = framePoolSize(opts);
		const len = size.W * size.H * 4;
		const bufs: SharedArrayBuffer[] = [];
		for (let i = 0; i < counts.slots; i++) {
			const buf = new SharedArrayBuffer(len * 3);
			bufs.push(buf);
			this.slots.push({
				index: i,
				src: new Uint8Array(buf, 0, 2 * len),
				out: new Uint8Array(buf, 2 * len, len),
			});
		}
		this.pool = new ExportWorkerPool(
			'blend',
			opts.workers,
			() => new Worker(WORKER_SOURCE, { eval: true, workerData: { slots: bufs, W: size.W, H: size.H } }),
		);
	}

	run(slot: BlendSlot, mode: number, seed: number, active: boolean): Promise<void> {
		return this.pool.run({ slot: slot.index, mode, seed, active }).then(() => undefined);
	}

	close(): Promise<void> {
		return this.pool.close();
	}
}

/** One frame slot of a Transform adjustment cut: `src` (the composite, `W×H` RGBA) and `out` (`2W×H` RGBA). */
export type AdjustSlot = { index: number; src: Uint8Array; out: Uint8Array };

const ADJUST_WORKER_SOURCE = `
// Functions are inlined by their source text: under tsx (dev engine) esbuild's keepNames wraps them in __name().
var __name = (f) => f;
const { parentPort, workerData } = require('node:worker_threads');
const drawTaps = ${drawTaps.toString()};
const adjustStackedFrame = ${adjustStackedFrame.toString()};
const len = workerData.W * workerData.H * 4;
const slots = workerData.slots.map((buf) => ({
	src: new Uint8Array(buf, 0, len),
	out: new Uint8Array(buf, len, 2 * len),
}));
const tmp = new Uint8Array(len);
let acc = new Float32Array(0);
parentPort.on('message', (m) => {
	const s = slots[m.slot];
	if (m.rect) {
		const need = Math.max(1, (m.rect[2] - m.rect[0]) * (m.rect[3] - m.rect[1]) * 4);
		if (acc.length < need) acc = new Float32Array(need);
	}
	adjustStackedFrame(drawTaps, s.src, workerData.W, workerData.H, m.prog, m.rect, s.out, tmp, acc);
	parentPort.postMessage(m.slot);
});
`;

type AdjustMsg = { slot: number; prog: readonly number[] | null; rect: readonly number[] | null };

/** Worker pool of the Transform adjustment kernel (`adjustStackedFrame`), slots in SharedArrayBuffers. */
export class AdjustPool {
	readonly slots: AdjustSlot[] = [];
	private readonly pool: ExportWorkerPool<AdjustMsg, number>;

	constructor(size: { W: number; H: number }, opts: { workers: number; slots: number }) {
		const counts = framePoolSize(opts);
		const len = size.W * size.H * 4;
		const bufs: SharedArrayBuffer[] = [];
		for (let i = 0; i < counts.slots; i++) {
			const buf = new SharedArrayBuffer(len * 3);
			bufs.push(buf);
			this.slots.push({ index: i, src: new Uint8Array(buf, 0, len), out: new Uint8Array(buf, len, 2 * len) });
		}
		this.pool = new ExportWorkerPool(
			'adjust',
			opts.workers,
			() =>
				new Worker(ADJUST_WORKER_SOURCE, { eval: true, workerData: { slots: bufs, W: size.W, H: size.H } }),
		);
	}

	/** Draws frame `prog` / `rect` (null = not drawn) of the slot's composite. */
	run(slot: AdjustSlot, prog: readonly number[] | null, rect: readonly number[] | null): Promise<void> {
		return this.pool.run({ slot: slot.index, prog, rect }).then(() => undefined);
	}

	close(): Promise<void> {
		return this.pool.close();
	}
}
