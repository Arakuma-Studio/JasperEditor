// One warp-stage layer render (S09:TRK-032/033): ffmpeg decodes the layer's source chain to box-sized RGBA on a
// pipe → worker threads warp every frame into the W×H sequence frame (in parallel, written in order) → a second
// ffmpeg encodes straight-alpha ProRes 4444 into a temp file that is renamed into the cache when complete.
// Backpressure: a fixed set of shared frame slots; the decoder's stdout is paused while none is free.
import type { ChildProcess } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import type { Rational } from '@jasper/project';
import type { Ffmpeg } from '../../tools/ffmpeg.ts';
import { randomId } from '../../tools/fs.ts';
import { terminateTree } from '../../tools/process.ts';
import { capDecoderThreads } from '../memory.ts';
import { BT709_FRAME_TAGS } from '../native.ts';
import type { PixelRect } from './kernel.ts';
import { type PinBlurFrame, WarpPool, type WarpSlot } from './pool.ts';

export type WarpFrameSpec = {
	/** Destination px → source px; null = the layer is invisible on this frame. */
	inv: readonly number[] | null;
	rect: PixelRect | null;
	/** 0…1. */
	opacity: number;
	/** Corner Pin motion blur of this frame (`inv` / `rect` then warp its canvas), absent = none. */
	blur?: PinBlurFrame | null;
};

type WarpRenderJob = {
	/** ffmpeg arguments (inputs, filtergraph, `-map`) of the source chain, without the output part. */
	decodeArgs: string[];
	/** Source frame (box) size and sequence frame size. */
	sw: number;
	sh: number;
	width: number;
	height: number;
	fps: Rational;
	/** One entry per output frame. */
	frames: readonly WarpFrameSpec[];
	/** Final intermediate path (written atomically). */
	output: string;
	workers: number;
	/** ffmpeg threads of the encoder. */
	threads: number;
	signal: AbortSignal;
	onSpawn?(child: ChildProcess): void;
	onProgress?(done: number, total: number): void;
};

/** Bytes all workers' Corner Pin blur canvases may take together (one canvas per worker, at least one worker). */
const BLUR_CANVAS_BUDGET = 1 << 30;

export class WarpRenderError extends Error {
	constructor(
		readonly code: 'JOB_CANCELLED' | 'TOOL_FAILED',
		message: string,
	) {
		super(message);
		this.name = 'WarpRenderError';
	}
}

/** ffmpeg arguments of the decoder: the source chain as raw box-sized RGBA frames on stdout. */
export function decoderArgs(inputs: string[][], filter: string, frames: number): string[] {
	return [
		// (several of these run beside the composite: two decoder threads each, not one per CPU — memory.ts)
		...capDecoderThreads(inputs, 2).flat(),
		'-filter_complex',
		`${filter}[warpsrc]`,
		'-map',
		'[warpsrc]',
		'-frames:v',
		String(frames),
		'-fps_mode',
		'passthrough',
		'-f',
		'rawvideo',
		'-pix_fmt',
		'rgba',
		'pipe:1',
	];
}

/**
 * ffmpeg arguments of the encoder: raw W×H `yuva444p10le` frames (BT.709 TV range, converted by the warp
 * workers) on stdin → ProRes 4444 with a 16-bit alpha plane, tagged BT.709.
 */
function encoderArgs(
	o: { width: number; height: number; fps: Rational; threads: number },
	output: string,
): string[] {
	return [
		'-y',
		'-f',
		'rawvideo',
		'-pix_fmt',
		'yuva444p10le',
		'-s',
		`${o.width}x${o.height}`,
		'-r',
		`${o.fps.num}/${o.fps.den}`,
		'-color_range',
		'tv',
		'-colorspace',
		'bt709',
		'-color_primaries',
		'bt709',
		'-color_trc',
		'bt709',
		'-i',
		'pipe:0',
		'-map',
		'0:v',
		'-vf',
		BT709_FRAME_TAGS,
		'-c:v',
		'prores_ks',
		'-profile:v',
		'4444',
		'-pix_fmt',
		'yuva444p10le',
		// A fixed quantiser skips prores_ks' per-slice rate search (4–5× faster at 1080p); q 2 keeps the
		// round trip far below one 8-bit code value (PSNR ≈ 65 dB on camera footage).
		'-q:v',
		'2',
		'-alpha_bits',
		'16',
		'-vendor',
		'apl0',
		'-colorspace',
		'bt709',
		'-color_primaries',
		'bt709',
		'-color_trc',
		'bt709',
		'-color_range',
		'tv',
		'-threads',
		String(Math.max(1, o.threads)),
		'-f',
		'mov',
		output,
	];
}

/** Renders the warped layer into `job.output`. */
export async function renderWarpLayer(ff: Ffmpeg, job: WarpRenderJob): Promise<void> {
	const total = job.frames.length;
	if (total === 0) throw new WarpRenderError('TOOL_FAILED', 'warp: no frames to render');
	const frameBytes = job.sw * job.sh * 4;
	// Corner Pin motion blur: every worker keeps one blur canvas; together they stay within the budget.
	const canvasBytes = job.frames.reduce((m, f) => (f.blur ? Math.max(m, f.blur.lw * f.blur.lh * 4) : m), 0);
	const byMemory = canvasBytes > 0 ? Math.max(1, Math.floor(BLUR_CANVAS_BUDGET / canvasBytes)) : total;
	const workers = Math.max(1, Math.min(job.workers, total, byMemory));
	const pool = new WarpPool(
		{ sw: job.sw, sh: job.sh, dw: job.width, dh: job.height, format: 'yuva444p10' },
		{ workers, slots: Math.min(total, workers + 3) },
	);
	const tmp = `${job.output}.${randomId('part', 6)}.tmp`;
	const children: ChildProcess[] = [];
	const track = (c: ChildProcess) => {
		children.push(c);
		job.onSpawn?.(c);
	};
	try {
		await new Promise<void>((resolve, reject) => {
			let failed = false;
			let encStderr = '';
			let decStderr = '';
			const fail = (e: Error) => {
				if (failed) return;
				failed = true;
				reject(job.signal.aborted ? new WarpRenderError('JOB_CANCELLED', 'warp cancelled') : e);
			};
			if (job.signal.aborted) return fail(new Error('cancelled'));
			const onAbort = () => fail(new Error('cancelled'));
			job.signal.addEventListener('abort', onAbort, { once: true });

			const enc = ff.spawnRaw(encoderArgs(job, tmp), {
				stdin: 'pipe',
				signal: job.signal,
				onSpawn: track,
			});
			const dec = ff.spawnRaw(job.decodeArgs, { signal: job.signal, onSpawn: track });
			enc.stdout!.resume();
			enc.stderr!.setEncoding('utf8').on('data', (c: string) => {
				encStderr = (encStderr + c).slice(-8000);
			});
			dec.stderr!.setEncoding('utf8').on('data', (c: string) => {
				decStderr = (decStderr + c).slice(-8000);
			});
			enc.on('error', (e) => fail(new WarpRenderError('TOOL_FAILED', `warp encoder: ${e.message}`)));
			dec.on('error', (e) => fail(new WarpRenderError('TOOL_FAILED', `warp decoder: ${e.message}`)));
			enc.stdin!.on('error', (e) =>
				fail(new WarpRenderError('TOOL_FAILED', `warp encoder input: ${e.message}`)),
			);

			const free: WarpSlot[] = [...pool.slots].reverse();
			const ready = new Map<number, WarpSlot>();
			let dispatched = 0; // frames handed to the pool (decoded or padding)
			let nextWrite = 0;
			let cur: WarpSlot | null = null;
			let curOff = 0;
			let stash: Buffer | null = null;
			let decodeDone = false;
			let decClosed = false;

			const dispatch = (slot: WarpSlot, pad: boolean) => {
				const i = dispatched++;
				const spec = job.frames[i]!;
				pool
					.run({
						slot,
						inv: pad ? null : spec.inv,
						rect: pad ? null : spec.rect,
						opacity: spec.opacity,
						blur: pad ? null : (spec.blur ?? null),
					})
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
					const view = Buffer.from(slot.dst.buffer, slot.dst.byteOffset, slot.dst.byteLength);
					enc.stdin!.write(view, (err) => {
						if (err) return fail(new WarpRenderError('TOOL_FAILED', `warp encoder input: ${err.message}`));
						free.push(slot);
						slotFreed();
					});
					job.onProgress?.(nextWrite, total);
					if (nextWrite === total) enc.stdin!.end();
				}
			};

			/** Copies decoder output into slots; returns false (and keeps the rest) when no slot is free. */
			const consume = (chunk: Buffer): boolean => {
				let pos = 0;
				while (pos < chunk.length) {
					if (dispatched >= total) return true; // more frames than asked for: ignore
					if (!cur) {
						const s = free.pop();
						if (!s) {
							stash = chunk.subarray(pos);
							return false;
						}
						cur = s;
						curOff = 0;
					}
					const n = Math.min(frameBytes - curOff, chunk.length - pos);
					cur.src.set(chunk.subarray(pos, pos + n), curOff);
					curOff += n;
					pos += n;
					if (curOff === frameBytes) {
						const s = cur;
						cur = null;
						dispatch(s, false);
					}
				}
				return true;
			};

			/** A source shorter than the layer: the missing frames are transparent. */
			const pad = () => {
				while (decodeDone && dispatched < total) {
					const s = free.pop();
					if (!s) return;
					dispatch(s, true);
				}
			};

			/** After the decoder closed and its last bytes found a slot: pad the missing frames. */
			const tryFinish = () => {
				if (!decClosed || stash || decodeDone) return;
				if (cur) {
					// A truncated last frame: dropped (padded as transparent).
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
					if (consume(c) && !decClosed) dec.stdout!.resume();
				}
				tryFinish();
				pad();
			};

			dec.stdout!.on('data', (c: Buffer) => {
				if (failed) return;
				if (stash) {
					stash = Buffer.concat([stash, c]);
					return;
				}
				if (!consume(c)) dec.stdout!.pause();
			});
			dec.on('close', (code, sig) => {
				if (failed) return;
				if (code !== 0) {
					return fail(
						new WarpRenderError(
							'TOOL_FAILED',
							`warp decoder exited ${code ?? sig}: ${decStderr.trim().slice(-1500)}`,
						),
					);
				}
				decClosed = true;
				tryFinish();
			});
			enc.on('close', (code, sig) => {
				job.signal.removeEventListener('abort', onAbort);
				if (failed) return;
				if (code !== 0 || nextWrite !== total) {
					return fail(
						new WarpRenderError(
							'TOOL_FAILED',
							`warp encoder exited ${code ?? sig} after ${nextWrite}/${total} frames: ${encStderr.trim().slice(-1500)}`,
						),
					);
				}
				resolve();
			});
		});
		// The decoder normally ended already; never leave it behind.
		await Promise.all(
			children.filter((c) => c.exitCode === null && c.signalCode === null).map((c) => terminateTree(c, 500)),
		);
		await rename(tmp, job.output);
	} catch (e) {
		await Promise.all(children.map((c) => terminateTree(c, 500)));
		await rm(tmp, { force: true }).catch(() => {});
		throw e;
	} finally {
		await pool.close();
	}
}
