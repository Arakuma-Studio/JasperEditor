// spec 13 AS-072 — kernel streams with many layers: one raw RGBA pipe into the composite for a run of layers of one
// track (or for one lowered layer), instead of one ffmpeg input (decoder, frame queue, overlay filter) per clip.
// Composite memory and the overlay chain then follow what is on screen, not the clip count (textperf: ≈ 40 MB per
// looped caption PNG, ≈ 165 MB per sub-pixel stream, 17 fps at 1 000 overlays).
//
// A member is a layer whose picture does not change over its frames (a baked still, a lowered layer's still, a still
// image or solid with sub-pixel Motion): its pictures (one per mip level it uses) are decoded once, when the stream
// is about to reach the member, by a one-frame ffmpeg decode, and released after its last frame. Members never
// overlap in time (one track, no transition handles), so each output frame draws at most one of them, through the
// sub-pixel kernel (`drawLayer`, one tap) or the multi-tap kernel (`drawTaps`, lowered effects) — or, when the
// stream has an OpenCL layout (`plan.gpu`, opencl.ts), by the same kernel on the GPU inside the composite. Frames
// between members are transparent. The stream covers the members' union rectangle over `[g0, g1)`.
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import type { Ffmpeg } from '../../tools/ffmpeg.ts';
import { terminateTree } from '../../tools/process.ts';
import { decoderArgs } from '../warp/render.ts';
import { ExportWorkerPool, framePoolSize } from '../worker-pool.ts';
import { drawLayer, drawTaps } from './kernel.ts';
import { DECODES_IN_FLIGHT, MAX_TAP_WORKERS, PREFETCH_MEMBERS } from './limits.ts';
import { encodeGpuFrame, fitsLayout, type GpuTapLayout } from './opencl.ts';
import { decodePngRgba } from './png.ts';
import { StreamLayerError } from './run.ts';
import { type TapPicture, type TapStreamPlan, toStreamFrames } from './tap-plan.ts';

/** spec 13 AS-076: a pipelined still came out different from its plan: the export restarts without the pipeline. */
export class BakeChangedError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'BakeChangedError';
	}
}

const WORKER_SOURCE = `
// Functions are inlined by their source text: under tsx (dev engine) esbuild's keepNames wraps them in __name().
var __name = (f) => f;
const { parentPort, workerData } = require('node:worker_threads');
const drawLayer = ${drawLayer.toString()};
const drawTaps = ${drawTaps.toString()};
const dsts = workerData.slots.map((b) => new Uint8Array(b));
let acc = new Float32Array(0);
parentPort.on('message', (m) => {
	const dst = dsts[m.slot];
	const src = new Uint8Array(m.pic);
	const p = m.prog;
	if (!m.rect || p[0] === 0) dst.fill(0);
	else if (p[0] === 1 && p[13] === 0 && p[2] === p[1]) {
		drawLayer(src, m.sw, m.cw, m.ch, [p[9], p[10], p[11], p[12]], dst, m.dw, m.dh,
			[p[3], p[4], p[5], p[6], p[7], p[8]], m.opacity, m.rect);
	} else {
		const need = Math.max(1, (m.rect[2] - m.rect[0]) * (m.rect[3] - m.rect[1]) * 4);
		if (acc.length < need) acc = new Float32Array(need);
		drawTaps(src, m.sw, m.cw, m.ch, dst, m.dw, m.dh, p, m.opacity, m.rect, acc);
	}
	parentPort.postMessage(m.slot);
});
`;

type TaskMsg = {
	slot: number;
	pic: SharedArrayBuffer;
	sw: number;
	cw: number;
	ch: number;
	dw: number;
	dh: number;
	prog: number[];
	opacity: number;
	rect: [number, number, number, number] | null;
};

/** Decodes one picture (one RGBA frame of `w × h`) into shared memory. */
async function decodePicture(
	ff: Ffmpeg,
	pic: TapPicture,
	opts: { signal: AbortSignal; onSpawn?(c: ChildProcess): void },
): Promise<SharedArrayBuffer> {
	const bytes = pic.w * pic.h * 4;
	const buf = new SharedArrayBuffer(bytes);
	const view = new Uint8Array(buf);
	if (pic.png) {
		let px: Uint8Array | null;
		try {
			px = await decodePngRgba(await readFile(pic.png), pic.w, pic.h);
		} catch (e) {
			throw new StreamLayerError('TOOL_FAILED', `picture ${pic.png}: ${(e as Error).message}`);
		}
		if (px) {
			view.set(px);
			return buf;
		}
	}
	let off = 0;
	let stderr = '';
	const child = ff.spawnRaw(decoderArgs(pic.inputs, pic.filter, 1), {
		signal: opts.signal,
		...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
	});
	try {
		await new Promise<void>((resolve, reject) => {
			child.stdout!.on('data', (c: Buffer) => {
				const k = Math.min(c.length, bytes - off);
				if (k > 0) view.set(c.subarray(0, k), off);
				off += k;
			});
			child.stderr!.setEncoding('utf8').on('data', (c: string) => {
				stderr = (stderr + c).slice(-4000);
			});
			child.on('error', (e) => reject(new StreamLayerError('TOOL_FAILED', `picture decoder: ${e.message}`)));
			child.on('close', (code, sig) => {
				if (opts.signal.aborted) return reject(new StreamLayerError('JOB_CANCELLED', 'cancelled'));
				if (code !== 0)
					return reject(
						new StreamLayerError(
							'TOOL_FAILED',
							`picture decoder exited ${code ?? sig}: ${stderr.trim().slice(-1500)}`,
						),
					);
				if (off < bytes)
					return reject(
						new StreamLayerError(
							'TOOL_FAILED',
							`picture decoder gave ${off} of ${bytes} bytes (${pic.w}×${pic.h})`,
						),
					);
				resolve();
			});
		});
	} finally {
		if (child.exitCode === null && child.signalCode === null) await terminateTree(child, 500);
	}
	return buf;
}

/** The pictures of a stream's members, decoded on demand (ahead of time) and released after the member's last frame. */
function memberPictures(
	ff: Ffmpeg,
	plan: TapStreamPlan,
	opts: { signal: AbortSignal; onSpawn?(child: ChildProcess): void },
	/** The OpenCL layout: pictures become its canvases, and a re-planned member must still fit it. */
	gpu: GpuTapLayout | undefined,
) {
	const members = plan.members;
	const pictures = new Map<number, Promise<SharedArrayBuffer[]>>();
	let decoding = 0;
	const waiting: (() => void)[] = [];
	const acquire = async () => {
		if (decoding >= DECODES_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
		decoding++;
	};
	const release = () => {
		decoding--;
		waiting.shift()?.();
	};
	const of = (i: number): Promise<SharedArrayBuffer[]> => {
		let p = pictures.get(i);
		if (!p) {
			const m = members[i]!;
			p = (async () => {
				// spec 13 AS-076: a pipelined still — wait until it is written; a trimmed one re-plans the member.
				if (m.ready) {
					// Raced with the stream's end: a composite that stopped must not wait for a still.
					const r = await new Promise<Awaited<NonNullable<typeof m.ready>>>((resolve, reject) => {
						const stop = () => reject(new StreamLayerError('JOB_CANCELLED', 'cancelled'));
						if (opts.signal.aborted) return stop();
						opts.signal.addEventListener('abort', stop, { once: true });
						m.ready!.then(resolve, reject).finally(() => opts.signal.removeEventListener('abort', stop));
					});
					if (!r.ok) throw new BakeChangedError(r.reason);
					if (r.picture && m.refresh) {
						const next = m.refresh(r.picture);
						const frames = toStreamFrames(next.frames, plan.x, plan.y);
						// The composite's input frame size is fixed: the export restarts without pipelined stills.
						if (gpu && !fitsLayout(gpu, next.pictures, frames))
							throw new BakeChangedError(
								`the re-planned still of ${m.clipId} does not fit its OpenCL stream`,
							);
						m.pictures = next.pictures;
						m.frames = frames;
					}
				}
				const out: SharedArrayBuffer[] = [];
				for (const pic of m.pictures) {
					await acquire();
					try {
						const px = await decodePicture(ff, pic, opts);
						out.push(gpu ? canvasOf(px, pic, gpu) : px);
					} finally {
						release();
					}
				}
				return out;
			})();
			p.catch(() => undefined);
			pictures.set(i, p);
		}
		return p;
	};
	return { of, drop: (i: number) => pictures.delete(i), clear: () => pictures.clear() };
}

/** A `w × h` picture as the picture rows of an OpenCL stream's input frame (`inW × picH`, top-left). */
function canvasOf(px: SharedArrayBuffer, pic: TapPicture, gpu: GpuTapLayout): SharedArrayBuffer {
	if (pic.w === gpu.inW && pic.h === gpu.picH) return px;
	const out = new SharedArrayBuffer(gpu.inW * gpu.picH * 4);
	const dst = new Uint8Array(out);
	const src = new Uint8Array(px);
	for (let y = 0; y < pic.h; y++) dst.set(src.subarray(y * pic.w * 4, (y + 1) * pic.w * 4), y * gpu.inW * 4);
	return out;
}

/**
 * Writes the stream's `g1 − g0` frames to `sink` (the composite's pipe) and ends it. Pictures are decoded ahead of
 * the frames that need them. CPU kernel: frames are drawn in parallel by `workers` threads and written in order.
 * OpenCL (`plan.gpu`): each frame is its program and its picture (opencl.ts), drawn in the composite.
 */
export async function streamTaps(
	ff: Ffmpeg,
	plan: TapStreamPlan,
	sink: Writable,
	opts: { workers: number; signal: AbortSignal; onSpawn?(child: ChildProcess): void },
): Promise<void> {
	const total = plan.g1 - plan.g0;
	if (total <= 0) {
		sink.end();
		return;
	}
	if (plan.gpu) return streamGpuTaps(ff, plan, plan.gpu, sink, opts);
	const frameBytes = plan.outW * plan.outH * 4;
	// A stream is paced by the composite reading it; more threads than this only cost memory (a V8 heap each).
	const threads = Math.max(1, Math.min(opts.workers, MAX_TAP_WORKERS));
	const counts = framePoolSize({ workers: threads, slots: threads + 3 });
	const slots = Array.from({ length: counts.slots }, () => new SharedArrayBuffer(frameBytes));
	const zero = Buffer.alloc(frameBytes);
	const pool = new ExportWorkerPool<TaskMsg, number>(
		'taps',
		counts.workers,
		() => new Worker(WORKER_SOURCE, { eval: true, workerData: { slots } }),
	);
	const members = plan.members;
	const pictures = memberPictures(ff, plan, opts, undefined);
	const picturesOf = pictures.of;
	const free: number[] = slots.map((_, i) => i).reverse();
	const slotWaiters: (() => void)[] = [];
	let failed: Error | null = null;
	const fail = (e: unknown) => {
		failed ??= e instanceof Error ? e : new Error(String(e));
		for (const w of slotWaiters.splice(0)) w();
	};
	const takeSlot = async (): Promise<number> => {
		for (;;) {
			if (failed) throw failed;
			const s = free.pop();
			if (s !== undefined) return s;
			await new Promise<void>((r) => slotWaiters.push(r));
		}
	};
	const giveSlot = (s: number) => {
		free.push(s);
		slotWaiters.shift()?.();
	};
	const write = (buf: Buffer): Promise<void> =>
		new Promise((resolve, reject) => {
			sink.write(buf, (err) =>
				err ? reject(new StreamLayerError('TOOL_FAILED', `layer stream: ${err.message}`)) : resolve(),
			);
		});
	const onAbort = () => fail(new StreamLayerError('JOB_CANCELLED', 'cancelled'));
	opts.signal.addEventListener('abort', onAbort, { once: true });
	sink.on('error', (e) => fail(new StreamLayerError('TOOL_FAILED', `layer stream: ${e.message}`)));
	let writeChain = Promise.resolve();
	try {
		// Frame j's draw (in order of j), written once it is done; at most `slots` frames in flight.
		const inflight: Promise<{ slot: number | null }>[] = [];
		let mi = 0;
		for (let j = 0; j < total; j++) {
			if (failed) throw failed;
			const f = plan.g0 + j;
			while (mi < members.length && members[mi]!.f1 <= f) {
				// The member before is done once its frames are written (`writeChain`): release its pictures then.
				const done = mi;
				writeChain = writeChain.then(() => {
					pictures.drop(done);
				});
				// Every link is handled at once: the loop may await (a picture) before the next link is chained, and a
				// write failing meanwhile must not surface as an unhandled rejection.
				writeChain.catch(fail);
				mi++;
			}
			for (let k = mi; k < Math.min(members.length, mi + 1 + PREFETCH_MEMBERS); k++) void picturesOf(k);
			const m = members[mi];
			const inMember = !!m && f >= m.f0 && f < m.f1;
			// The member's pictures first: a pipelined member's frames are final only once its still is ready.
			if (inMember) await picturesOf(mi);
			const fr = inMember ? m!.frames[f - m!.f0]! : null;
			let job: Promise<{ slot: number | null }>;
			if (!fr?.rect) job = Promise.resolve({ slot: null });
			else {
				const pics = await picturesOf(mi);
				const lv = m!.pictures[fr.level]!;
				const slot = await takeSlot();
				job = pool
					.run({
						slot,
						pic: pics[fr.level]!,
						sw: lv.w,
						cw: lv.w,
						ch: lv.h,
						dw: plan.outW,
						dh: plan.outH,
						prog: fr.prog,
						opacity: fr.opacity,
						rect: fr.rect,
					})
					.then(() => ({ slot }));
			}
			// A stream that fails stops writing: draws still in flight are rejected by the pool's close, and nothing
			// awaits them any more — their rejections must not become unhandled (the engine would exit).
			job.catch(() => undefined);
			inflight.push(job);
			const mine = job;
			writeChain = writeChain.then(async () => {
				const { slot } = await mine;
				if (failed) throw failed;
				if (slot === null) await write(zero);
				else {
					try {
						await write(Buffer.from(slots[slot]!));
					} finally {
						giveSlot(slot);
					}
				}
			});
			writeChain.catch(fail);
			// Keep the number of drawn-but-unwritten frames bounded (the slots bound the drawn ones).
			if (inflight.length > counts.slots * 2) await inflight.shift();
		}
		await writeChain;
		sink.end();
	} catch (e) {
		// Stop the writes still chained (they check `failed`) before the pool's close rejects the draws they await.
		fail(e);
		throw e;
	} finally {
		opts.signal.removeEventListener('abort', onAbort);
		pictures.clear();
		// The chain's last link may have no handler yet (the loop stopped between links): its rejection is this
		// stream's failure, already thrown — never an unhandled rejection (the engine would exit).
		writeChain.catch(() => undefined);
		await pool.close();
	}
}

/**
 * The OpenCL route of `streamTaps`: per frame, the frame's program rows and its member's picture canvas (opencl.ts
 * layout), in order; the composite's `program_opencl` draws them. Frames between members carry an empty program.
 */
async function streamGpuTaps(
	ff: Ffmpeg,
	plan: TapStreamPlan,
	gpu: GpuTapLayout,
	sink: Writable,
	opts: { signal: AbortSignal; onSpawn?(child: ChildProcess): void },
): Promise<void> {
	const total = plan.g1 - plan.g0;
	const progWords = gpu.progRows * gpu.inW;
	const empty = new Float32Array(progWords);
	encodeGpuFrame(gpu, null, 1, 1, plan.outW, plan.outH, empty);
	const emptyProg = Buffer.from(empty.buffer);
	const blank = Buffer.alloc(gpu.inW * gpu.picH * 4);
	const members = plan.members;
	const pictures = memberPictures(ff, plan, opts, gpu);
	let failed: Error | null = null;
	const onAbort = () => {
		failed ??= new StreamLayerError('JOB_CANCELLED', 'cancelled');
	};
	opts.signal.addEventListener('abort', onAbort, { once: true });
	const onError = (e: Error) => {
		failed ??= new StreamLayerError('TOOL_FAILED', `layer stream: ${e.message}`);
	};
	sink.on('error', onError);
	const write = (buf: Buffer): Promise<void> =>
		new Promise((resolve, reject) => {
			sink.write(buf, (err) =>
				err ? reject(new StreamLayerError('TOOL_FAILED', `layer stream: ${err.message}`)) : resolve(),
			);
		});
	try {
		let mi = 0;
		for (let j = 0; j < total; j++) {
			if (failed) throw failed;
			const f = plan.g0 + j;
			while (mi < members.length && members[mi]!.f1 <= f) pictures.drop(mi++);
			for (let k = mi; k < Math.min(members.length, mi + 1 + PREFETCH_MEMBERS); k++) void pictures.of(k);
			const m = members[mi];
			const inMember = !!m && f >= m.f0 && f < m.f1;
			// The member's pictures first: a pipelined member's frames are final only once its still is ready.
			const pics = inMember ? await pictures.of(mi) : null;
			const fr = inMember ? m!.frames[f - m!.f0]! : null;
			if (!pics || !fr?.rect) {
				await write(emptyProg);
				await write(blank);
				continue;
			}
			const lv = m!.pictures[fr.level]!;
			const words = new Float32Array(progWords);
			encodeGpuFrame(gpu, fr, lv.w, lv.h, plan.outW, plan.outH, words);
			await write(Buffer.from(words.buffer));
			await write(Buffer.from(pics[fr.level]!));
		}
		if (failed) throw failed;
		sink.end();
	} finally {
		opts.signal.removeEventListener('abort', onAbort);
		pictures.clear();
	}
}
