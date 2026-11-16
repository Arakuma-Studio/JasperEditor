// The blend pipeline of the native export (keyframes-blend): the processes before the composite (`NativeGraph.blend`
// segments), each one's raw output (composite below ‖ blend layer) through the blend kernel (pool.ts) into the next
// process's backdrop pipe (`pipe:3`), the last kernel into the composite. An adjustment layer's segment with geometric
// effects (`seg.adjust`, adjust.ts) outputs the composite alone and its kernel writes the composite ‖ the chain's output
// (passes.ts). Every process also gets its own sub-pixel streams. Backpressure: a fixed set of shared frame slots; a
// process's stdout is paused while none is free, a slot is reused once the sink accepted its frame. A failure anywhere stops the whole pipeline and is reported.
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { Ffmpeg } from '../../tools/ffmpeg.ts';
import { terminateTree } from '../../tools/process.ts';
import type { BlendSegment } from '../native.ts';
import { AdjustPool, BlendPool } from './pool.ts';

export class BlendPipelineError extends Error {
	constructor(
		readonly code: 'JOB_CANCELLED' | 'TOOL_FAILED',
		message: string,
	) {
		super(message);
		this.name = 'BlendPipelineError';
	}
}

export type BlendRunOptions = {
	workers: number;
	signal: AbortSignal;
	onSpawn?(child: ChildProcess): void;
	/** Starts the sub-pixel streams of a spawned process (they write into its pipes). */
	runStreams(child: ChildProcess, streams: BlendSegment['streams']): void;
};

/**
 * Runs `segments` in order, feeding the last kernel's output into `sink` (the composite's backdrop pipe). Resolves
 * when every frame reached the sink.
 */
export async function runBlendPipeline(
	ff: Ffmpeg,
	segments: readonly BlendSegment[],
	size: { width: number; height: number },
	sink: Writable,
	opts: BlendRunOptions,
): Promise<void> {
	const children: ChildProcess[] = [];
	try {
		// Spawn from the last segment backwards: each kernel's sink is the next process's backdrop pipe.
		const sinks: Writable[] = new Array(segments.length);
		sinks[segments.length - 1] = sink;
		const spawned: ChildProcess[] = new Array(segments.length);
		for (let i = segments.length - 1; i >= 0; i--) {
			const seg = segments[i]!;
			const pipes = (seg.backdropFd !== null ? 1 : 0) + seg.streams.length;
			const child = ff.spawnRaw(seg.args, {
				signal: opts.signal,
				...(pipes > 0 ? { pipes } : {}),
				...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
			});
			children.push(child);
			spawned[i] = child;
			if (seg.streams.length > 0) opts.runStreams(child, seg.streams);
			if (i > 0) sinks[i - 1] = child.stdio[3] as Writable;
		}
		await Promise.all(
			segments.map((seg, i) => blendSegment(spawned[i]!, seg, size, sinks[i]!, opts.workers, opts.signal)),
		);
	} finally {
		for (const c of children) if (c.exitCode === null && c.signalCode === null) await terminateTree(c, 500);
	}
}

/** A frame slot of either kernel: its input frame and its output frame. */
type Slot = { index: number; src: Uint8Array; out: Uint8Array };

/** One process's frames through the kernel into `sink`. */
async function blendSegment(
	child: ChildProcess,
	seg: BlendSegment,
	size: { width: number; height: number },
	sink: Writable,
	workers: number,
	signal: AbortSignal,
): Promise<void> {
	const total = seg.frames;
	const opts = { workers: Math.max(1, Math.min(workers, total)), slots: Math.min(total, workers + 3) };
	const W = size.width;
	const H = size.height;
	const adjust = seg.adjust;
	// Blend layers read `2W×H` frames (composite ‖ layer); a geometric adjustment reads the composite alone.
	const frameBytes = W * H * (adjust ? 4 : 8);
	const what = adjust ? 'adjustment layer' : 'blend layer';
	let pool: { slots: Slot[]; close(): Promise<void> };
	let runSlot: (slot: Slot, i: number) => Promise<void>;
	if (adjust) {
		const p = new AdjustPool({ W, H }, opts);
		pool = p;
		runSlot = (slot, i) => p.run(p.slots[slot.index]!, adjust.frames[i] ?? null);
	} else {
		const p = new BlendPool({ W, H }, opts);
		pool = p;
		runSlot = (slot, i) => p.run(p.slots[slot.index]!, seg.mode, seg.seeds[i] ?? 0, seg.active[i] ?? false);
	}
	try {
		await new Promise<void>((resolve, reject) => {
			let failed = false;
			let stderr = '';
			const fail = (e: Error) => {
				if (failed) return;
				failed = true;
				signal.removeEventListener('abort', onAbort);
				reject(signal.aborted ? new BlendPipelineError('JOB_CANCELLED', 'cancelled') : e);
			};
			const onAbort = () => fail(new Error('cancelled'));
			if (signal.aborted) return fail(new Error('cancelled'));
			signal.addEventListener('abort', onAbort, { once: true });
			sink.on('error', (e) => fail(new BlendPipelineError('TOOL_FAILED', `blend stream: ${e.message}`)));
			child.stderr!.setEncoding('utf8').on('data', (c: string) => {
				stderr = (stderr + c).slice(-8000);
			});
			child.on('error', (e) => fail(new BlendPipelineError('TOOL_FAILED', `${what}: ${e.message}`)));

			const free: Slot[] = [...pool.slots].reverse();
			const ready = new Map<number, Slot>();
			let dispatched = 0;
			let nextWrite = 0;
			let accepted = 0;
			let cur: Slot | null = null;
			let curOff = 0;
			let stash: Buffer | null = null;
			let closed = false;

			const dispatch = (slot: Slot) => {
				const i = dispatched++;
				runSlot(slot, i).then(
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
					sink.write(Buffer.from(slot.out.buffer, slot.out.byteOffset, slot.out.byteLength), (err) => {
						if (err) return fail(new BlendPipelineError('TOOL_FAILED', `blend stream: ${err.message}`));
						free.push(slot);
						accepted++;
						if (accepted === total) {
							signal.removeEventListener('abort', onAbort);
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
						dispatch(s);
					}
				}
				return true;
			};
			const slotFreed = () => {
				if (failed || !stash) return;
				const c = stash;
				stash = null;
				if (consume(c) && !closed) child.stdout!.resume();
			};
			child.stdout!.on('data', (c: Buffer) => {
				if (failed) return;
				if (stash) {
					stash = Buffer.concat([stash, c]);
					return;
				}
				if (!consume(c)) child.stdout!.pause();
			});
			child.on('close', (code, sig) => {
				if (failed) return;
				closed = true;
				if (code !== 0)
					return fail(
						new BlendPipelineError(
							'TOOL_FAILED',
							`${what} process exited ${code ?? sig}: ${stderr.trim().slice(-1500)}`,
						),
					);
				// Every frame must have come out of the process (it renders exactly `frames`).
				const check = () => {
					if (failed) return;
					if (stash) return void setTimeout(check, 5);
					if (dispatched < total)
						fail(
							new BlendPipelineError(
								'TOOL_FAILED',
								`${what} process produced ${dispatched} of ${total} frames: ${stderr.trim().slice(-500)}`,
							),
						);
				};
				check();
			});
		});
	} finally {
		await pool.close();
	}
}
