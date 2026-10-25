// spec 13 AS-072 — kernel streams with many layers: one raw RGBA pipe into the composite for a run of layers of one
// track (or for one lowered layer), instead of one ffmpeg input (decoder, frame queue, overlay filter) per clip.
// Composite memory and the overlay chain then follow what is on screen, not the clip count (textperf: ≈ 40 MB per
// looped caption PNG, ≈ 165 MB per sub-pixel stream, 17 fps at 1 000 overlays).
//
// A member is a layer whose picture does not change over its frames (a baked still, a lowered layer's still, a still
// image or solid with sub-pixel Motion): its pictures (one per mip level it uses) are decoded once, when the stream
// is about to reach the member, by a one-frame ffmpeg decode, and released after its last frame. Members never
// overlap in time (one track, no transition handles), so each output frame draws at most one of them, through the
// sub-pixel kernel (`drawLayer`, one tap) or the multi-tap kernel (`drawTaps`, lowered effects). Frames between
// members are transparent. The stream covers the members' union rectangle over `[g0, g1)`.
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import type { Rational } from '@jasper/project';
import type { Ffmpeg } from '../../tools/ffmpeg.ts';
import { terminateTree } from '../../tools/process.ts';
import { decoderArgs } from '../warp/render.ts';
import { ExportWorkerPool, framePoolSize } from '../worker-pool.ts';
import { drawLayer, drawTaps } from './kernel.ts';
import { shiftProgram, type TapFrame } from './lowered.ts';
import { StreamLayerError } from './run.ts';

/** A picture of a member: `inputs` + `filter` (ending in a `w × h` RGBA stream) decoded for one frame. */
export type TapPicture = { w: number; h: number; inputs: string[][]; filter: string };

export type TapMember = {
	clipId: string;
	/** Sequence frames `[f0, f1)` the member draws. */
	f0: number;
	f1: number;
	pictures: TapPicture[];
	/** One per frame of `[f0, f1)`, in sequence px (`planTapStream` moves them into the stream's frame). */
	frames: TapFrame[];
};

export type TapStreamPlan = {
	kind: 'taps';
	members: TapMember[];
	/** Where the stream's frame sits in the sequence frame (overlay offset). */
	x: number;
	y: number;
	outW: number;
	outH: number;
	/** Sequence frames `[g0, g1)` the stream covers (its frame 0 = `g0`). */
	g0: number;
	g1: number;
	fps: Rational;
};

/** Bytes the engine holds for a stream at most (output slots + pictures in flight), for the memory preflight. */
export function tapStreamBytes(o: { outW: number; outH: number; picture: number; workers: number }): number {
	const slots = o.workers + 3;
	return slots * o.outW * o.outH * 4 + (PREFETCH_MEMBERS + 1) * o.picture * 4;
}

/**
 * The stream of `members` (non-overlapping, any order) in a `W × H` sequence: the union of their drawn rectangles,
 * frame programs moved into it. Throws when two members overlap in time (callers group by track).
 */
export function planTapStream(members: readonly TapMember[], W: number, H: number, fps: Rational): TapStreamPlan {
	const sorted = [...members].sort((a, b) => a.f0 - b.f0);
	for (let i = 1; i < sorted.length; i++)
		if (sorted[i]!.f0 < sorted[i - 1]!.f1)
			throw new Error(`stream members ${sorted[i - 1]!.clipId} and ${sorted[i]!.clipId} overlap in time`);
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (const m of sorted)
		for (const f of m.frames) {
			if (!f.rect) continue;
			x0 = Math.min(x0, f.rect[0]);
			y0 = Math.min(y0, f.rect[1]);
			x1 = Math.max(x1, f.rect[2]);
			y1 = Math.max(y1, f.rect[3]);
		}
	if (!Number.isFinite(x0)) [x0, y0, x1, y1] = [0, 0, 1, 1];
	x0 = Math.max(0, Math.min(W - 1, x0));
	y0 = Math.max(0, Math.min(H - 1, y0));
	x1 = Math.max(x0 + 1, Math.min(W, x1));
	y1 = Math.max(y0 + 1, Math.min(H, y1));
	const out: TapMember[] = sorted.map((m) => ({
		...m,
		frames: m.frames.map((f) =>
			f.rect
				? {
						...f,
						rect: [f.rect[0] - x0, f.rect[1] - y0, f.rect[2] - x0, f.rect[3] - y0],
						prog: shiftProgram(f.prog, x0, y0),
					}
				: f,
		),
	}));
	return {
		kind: 'taps',
		members: out,
		x: x0,
		y: y0,
		outW: x1 - x0,
		outH: y1 - y0,
		g0: sorted[0]?.f0 ?? 0,
		g1: sorted[sorted.length - 1]?.f1 ?? 0,
		fps,
	};
}

/** Members whose pictures are decoded ahead of the one being drawn. */
const PREFETCH_MEMBERS = 3;
/** One-frame picture decodes at the same time. */
const DECODES_IN_FLIGHT = 3;

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
						new StreamLayerError('TOOL_FAILED', `picture decoder gave ${off} of ${bytes} bytes (${pic.w}×${pic.h})`),
					);
				resolve();
			});
		});
	} finally {
		if (child.exitCode === null && child.signalCode === null) await terminateTree(child, 500);
	}
	return buf;
}

/**
 * Writes the stream's `g1 − g0` frames to `sink` (the composite's pipe) and ends it. Pictures are decoded ahead of
 * the frames that need them; frames are drawn in parallel by `workers` threads and written in order.
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
	const frameBytes = plan.outW * plan.outH * 4;
	const counts = framePoolSize({ workers: Math.max(1, opts.workers), slots: Math.max(1, opts.workers) + 3 });
	const slots = Array.from({ length: counts.slots }, () => new SharedArrayBuffer(frameBytes));
	const zero = Buffer.alloc(frameBytes);
	const pool = new ExportWorkerPool<TaskMsg, number>(
		'taps',
		counts.workers,
		() => new Worker(WORKER_SOURCE, { eval: true, workerData: { slots } }),
	);
	const members = plan.members;
	// Pictures per member, decoded on demand (ahead of time) and released after the member's last frame.
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
	const picturesOf = (i: number): Promise<SharedArrayBuffer[]> => {
		let p = pictures.get(i);
		if (!p) {
			const m = members[i]!;
			p = (async () => {
				const out: SharedArrayBuffer[] = [];
				for (const pic of m.pictures) {
					await acquire();
					try {
						out.push(await decodePicture(ff, pic, opts));
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
	try {
		// Frame j's draw (in order of j), written once it is done; at most `slots` frames in flight.
		const inflight: Promise<{ slot: number | null }>[] = [];
		let writeChain = Promise.resolve();
		let mi = 0;
		for (let j = 0; j < total; j++) {
			if (failed) throw failed;
			const f = plan.g0 + j;
			while (mi < members.length && members[mi]!.f1 <= f) {
				// The member before is done once its frames are written (`writeChain`): release its pictures then.
				const done = mi;
				writeChain = writeChain.then(() => {
					pictures.delete(done);
				});
				mi++;
			}
			for (let k = mi; k < Math.min(members.length, mi + 1 + PREFETCH_MEMBERS); k++) void picturesOf(k);
			const m = members[mi];
			const fr = m && f >= m.f0 && f < m.f1 ? m.frames[f - m.f0]! : null;
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
	} finally {
		opts.signal.removeEventListener('abort', onAbort);
		pictures.clear();
		await pool.close();
	}
}
