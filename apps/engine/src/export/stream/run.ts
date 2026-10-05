// Streams one sub-pixel layer (plan.ts) into the composite: decoder ffmpeg (source chain → raw RGBA on stdout) →
// warp worker pool (bilinear, premultiplied, pixel centres; frames in parallel, written in order) → `sink`, the
// composite ffmpeg's `pipe:N` input. Backpressure: a fixed set of shared frame slots; the decoder's stdout is paused
// while none is free, a slot is reused once the sink accepted its frame.
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { Ffmpeg } from '../../tools/ffmpeg.ts';
import { terminateTree } from '../../tools/process.ts';
import { WarpPool, type WarpSlot } from '../warp/pool.ts';
import { decoderArgs } from '../warp/render.ts';
import type { StreamLayerPlan } from './plan.ts';

export class StreamLayerError extends Error {
	constructor(
		readonly code: 'JOB_CANCELLED' | 'TOOL_FAILED',
		message: string,
	) {
		super(message);
		this.name = 'StreamLayerError';
	}
}

export type StreamRunOptions = {
	workers: number;
	signal: AbortSignal;
	onSpawn?(child: ChildProcess): void;
};

/** Writes the layer's frames to `sink` and ends it. Resolves when every frame was accepted by the sink. */
export async function streamLayer(
	ff: Ffmpeg,
	plan: StreamLayerPlan,
	sink: Writable,
	opts: StreamRunOptions,
): Promise<void> {
	const total = plan.frames.length;
	const frameBytes = plan.srcW * plan.srcH * 4;
	const workers = Math.max(1, Math.min(opts.workers, total));
	const pool = new WarpPool(
		{ sw: plan.srcW, sh: plan.srcH, dw: plan.outW, dh: plan.outH, format: 'rgba' },
		{ workers, slots: Math.min(total, workers + 3) },
	);
	let dec: ChildProcess | null = null;
	try {
		await new Promise<void>((resolve, reject) => {
			let failed = false;
			let decStderr = '';
			const fail = (e: Error) => {
				if (failed) return;
				failed = true;
				opts.signal.removeEventListener('abort', onAbort);
				reject(opts.signal.aborted ? new StreamLayerError('JOB_CANCELLED', 'cancelled') : e);
			};
			const onAbort = () => fail(new Error('cancelled'));
			if (opts.signal.aborted) return fail(new Error('cancelled'));
			opts.signal.addEventListener('abort', onAbort, { once: true });
			sink.on('error', (e) => fail(new StreamLayerError('TOOL_FAILED', `layer stream: ${e.message}`)));

			dec = ff.spawnRaw(decoderArgs(plan.inputs, plan.filter, total), {
				signal: opts.signal,
				...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
			});
			const d = dec;
			d.stderr!.setEncoding('utf8').on('data', (c: string) => {
				decStderr = (decStderr + c).slice(-8000);
			});
			d.on('error', (e) => fail(new StreamLayerError('TOOL_FAILED', `layer decoder: ${e.message}`)));

			const free: WarpSlot[] = [...pool.slots].reverse();
			const ready = new Map<number, WarpSlot>();
			let dispatched = 0;
			let nextWrite = 0;
			let accepted = 0;
			let cur: WarpSlot | null = null;
			let curOff = 0;
			let stash: Buffer | null = null;
			let decodeDone = false;
			let decClosed = false;

			const dispatch = (slot: WarpSlot, pad: boolean) => {
				const i = dispatched++;
				const spec = plan.frames[i]!;
				pool
					.run({ slot, inv: pad ? null : spec.inv, rect: pad ? null : spec.rect, opacity: spec.opacity })
					.then(
						() => {
							ready.set(i, slot);
							flush();
						},
						(e: Error) => fail(e),
					);
			};
			const flush = () => {
				while (!failed && ready.has(nextWrite)) {
					const slot = ready.get(nextWrite)!;
					ready.delete(nextWrite);
					nextWrite++;
					// The slot is reused once the write callback fired (the bytes are with the OS then).
					sink.write(Buffer.from(slot.dst.buffer, slot.dst.byteOffset, slot.dst.byteLength), (err) => {
						if (err) return fail(new StreamLayerError('TOOL_FAILED', `layer stream: ${err.message}`));
						free.push(slot);
						accepted++;
						if (accepted === total) {
							opts.signal.removeEventListener('abort', onAbort);
							sink.end();
							resolve();
						}
						slotFreed();
					});
				}
			};
			const consume = (chunk: Buffer): boolean => {
				let pos = 0;
				while (pos < chunk.length) {
					if (dispatched >= total) return true;
					if (!cur) {
						const s = free.pop();
						if (!s) {
							stash = chunk.subarray(pos);
							return false;
						}
						cur = s;
						curOff = 0;
					}
					const k = Math.min(frameBytes - curOff, chunk.length - pos);
					cur.src.set(chunk.subarray(pos, pos + k), curOff);
					curOff += k;
					pos += k;
					if (curOff === frameBytes) {
						const s = cur;
						cur = null;
						dispatch(s, false);
					}
				}
				return true;
			};
			const pad = () => {
				while (decodeDone && dispatched < total) {
					const s = free.pop();
					if (!s) return;
					dispatch(s, true);
				}
			};
			const tryFinish = () => {
				if (!decClosed || stash || decodeDone) return;
				if (cur) {
					free.push(cur);
					cur = null;
				}
				decodeDone = true;
				pad();
			};
			const slotFreed = () => {
				if (failed) return;
				if (stash) {
					const c = stash;
					stash = null;
					if (consume(c) && !decClosed) d.stdout!.resume();
				}
				tryFinish();
				pad();
			};
			d.stdout!.on('data', (c: Buffer) => {
				if (failed) return;
				if (stash) {
					stash = Buffer.concat([stash, c]);
					return;
				}
				if (!consume(c)) d.stdout!.pause();
			});
			d.on('close', (code, sig) => {
				if (failed) return;
				if (code !== 0)
					return fail(
						new StreamLayerError(
							'TOOL_FAILED',
							`layer decoder exited ${code ?? sig}: ${decStderr.trim().slice(-1500)}`,
						),
					);
				decClosed = true;
				tryFinish();
			});
		});
	} finally {
		if (dec) {
			const c = dec as ChildProcess;
			if (c.exitCode === null && c.signalCode === null) await terminateTree(c, 500);
		}
		await pool.close();
	}
}
