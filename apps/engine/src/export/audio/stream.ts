// Runs one AudioDspPlan (plan.ts): decoder ffmpeg (f32le stereo on stdout) → ClipChain (the same code as the
// preview's AudioWorklet) → `sink`, the composite ffmpeg's `pipe:N` input. Backpressure: the decoder's stdout is
// paused while the sink is full. Reversed clips are decoded whole and played backwards.
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { ClipChain } from '@jasper/audio-fx';
import type { Ffmpeg } from '../../tools/ffmpeg.ts';
import { terminateTree } from '../../tools/process.ts';
import type { AudioDspPlan } from './plan.ts';

/** Samples per DSP block. */
const BLOCK = 8192;

export class AudioStreamError extends Error {
	constructor(
		readonly code: 'JOB_CANCELLED' | 'TOOL_FAILED',
		message: string,
	) {
		super(message);
		this.name = 'AudioStreamError';
	}
}

/**
 * Feeds the chain input positions `[inStart, inEnd)` and writes output positions `[outStart, outStart + outCount)`.
 * Pure (no IO): `source(pos, l, r, n)` fills the input of positions `pos … pos+n−1`; `emit` receives interleaved
 * f32 blocks. Exported for tests (the export and the preview parity check run the same function).
 */
export class ClipRenderer {
	readonly chain: ClipChain;
	private pos: number;
	private readonly l = new Float32Array(BLOCK);
	private readonly r = new Float32Array(BLOCK);
	private readonly latency: number;
	written = 0;

	constructor(readonly plan: AudioDspPlan) {
		this.chain = new ClipChain(plan.config);
		this.latency = this.chain.latency();
		this.pos = plan.inStart;
	}

	/** Positions still to feed. */
	remaining(): number {
		return this.plan.inEnd - this.pos;
	}

	/**
	 * Processes the next `n` (≤ BLOCK) positions whose input is already in `l`/`r` (`fill` writes it), returning the
	 * interleaved output slice to write (may be empty during pre-roll).
	 */
	step(n: number, fill: (pos: number, l: Float32Array, r: Float32Array, n: number) => void): Float32Array {
		const l = this.l;
		const r = this.r;
		fill(this.pos, l, r, n);
		this.chain.process([l, r], 0, n, this.pos);
		const firstOut = this.pos - this.latency; // output position of l[0]
		this.pos += n;
		const from = Math.max(0, this.plan.outStart - firstOut);
		const to = Math.min(n, this.plan.outStart + this.plan.outCount - firstOut);
		if (to <= from) return new Float32Array(0);
		const out = new Float32Array((to - from) * 2);
		for (let i = from, k = 0; i < to; i++, k += 2) {
			out[k] = l[i]!;
			out[k + 1] = r[i]!;
		}
		this.written += to - from;
		return out;
	}
}

export type AudioStreamOptions = { signal: AbortSignal; onSpawn?(child: ChildProcess): void };

/** Streams the clip's chain output into `sink` and ends it. */
export async function streamAudioClip(
	ff: Ffmpeg,
	plan: AudioDspPlan,
	sink: Writable,
	opts: AudioStreamOptions,
): Promise<void> {
	const renderer = new ClipRenderer(plan);
	let dec: ChildProcess | null = null;
	try {
		await new Promise<void>((resolve, reject) => {
			let failed = false;
			let stderr = '';
			const fail = (e: Error) => {
				if (failed) return;
				failed = true;
				opts.signal.removeEventListener('abort', onAbort);
				reject(opts.signal.aborted ? new AudioStreamError('JOB_CANCELLED', 'cancelled') : e);
			};
			const onAbort = () => fail(new Error('cancelled'));
			if (opts.signal.aborted) return fail(new Error('cancelled'));
			opts.signal.addEventListener('abort', onAbort, { once: true });
			sink.on('error', (e) => fail(new AudioStreamError('TOOL_FAILED', `audio stream: ${e.message}`)));

			// Decoded source (interleaved stereo f32), consumed position by position.
			let pending = new Float32Array(0);
			let pendingOff = 0;
			let decoded = 0; // samples taken from the decoder so far
			let carry = Buffer.alloc(0);
			let decoderDone = plan.decodeCount === 0;
			let all: Float32Array | null = plan.reverse ? new Float32Array(plan.decodeCount * 2) : null;
			let allLen = 0;

			const fill = (pos: number, l: Float32Array, r: Float32Array, n: number) => {
				for (let i = 0; i < n; i++) {
					const p = pos + i;
					const k = p - plan.decodeStart; // index into the decoded (or reversed) source
					if (k < 0 || k >= plan.decodeCount) {
						l[i] = 0;
						r[i] = 0;
						continue;
					}
					if (all) {
						// Reversed: position k plays decoded sample decodeCount − 1 − k.
						const j = plan.decodeCount - 1 - k;
						const ok = j < allLen;
						l[i] = ok ? all[2 * j]! : 0;
						r[i] = ok ? all[2 * j + 1]! : 0;
						continue;
					}
					if (pendingOff < pending.length) {
						l[i] = pending[pendingOff]!;
						r[i] = pending[pendingOff + 1]!;
						pendingOff += 2;
					} else {
						l[i] = 0;
						r[i] = 0;
					}
				}
			};
			/** Positions that can be processed now (their input is decoded, or known to be silence). */
			const available = (): number => {
				const rem = renderer.remaining();
				if (rem <= 0) return 0;
				if (decoderDone) return rem;
				if (all) return 0; // reversed: wait for the whole source
				const pos = plan.inEnd - rem;
				const k = pos - plan.decodeStart;
				if (k < 0) return Math.min(rem, -k); // silence before the decoded range
				const have = (pending.length - pendingOff) / 2;
				return Math.min(rem, have);
			};
			let writing = false;
			const pump = () => {
				if (failed || writing) return;
				for (;;) {
					const n = Math.min(4096 * 2, available());
					if (n <= 0) break;
					const out = renderer.step(Math.min(n, 8192), fill);
					if (out.length > 0) {
						const ok = sink.write(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
						if (!ok) {
							writing = true;
							d?.stdout?.pause();
							sink.once('drain', () => {
								writing = false;
								if (!decoderDone) d?.stdout?.resume();
								pump();
							});
							return;
						}
					}
				}
				if (renderer.remaining() <= 0) {
					opts.signal.removeEventListener('abort', onAbort);
					sink.end(() => resolve());
				}
			};

			let d: ChildProcess | null = null;
			if (plan.decodeCount > 0) {
				dec = ff.spawnRaw(plan.decodeArgs, {
					signal: opts.signal,
					...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
				});
				d = dec;
				d.stderr!.setEncoding('utf8').on('data', (c: string) => {
					stderr = (stderr + c).slice(-8000);
				});
				d.on('error', (e) => fail(new AudioStreamError('TOOL_FAILED', `audio decoder: ${e.message}`)));
				d.stdout!.on('data', (chunk: Buffer) => {
					if (failed) return;
					const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
					const usable = bytes.length - (bytes.length % 8);
					carry = Buffer.from(bytes.subarray(usable));
					const frames = usable / 8;
					const take = Math.min(frames, plan.decodeCount - decoded);
					if (take <= 0) return;
					const f = new Float32Array(take * 2);
					Buffer.from(f.buffer).set(bytes.subarray(0, take * 8));
					decoded += take;
					if (all) {
						all.set(f, allLen * 2);
						allLen += take;
						return;
					}
					// Keep the unconsumed rest of the previous chunk.
					const rest = pending.subarray(pendingOff);
					const merged = new Float32Array(rest.length + f.length);
					merged.set(rest);
					merged.set(f, rest.length);
					pending = merged;
					pendingOff = 0;
					pump();
				});
				d.on('close', (code, sig) => {
					if (failed) return;
					if (code !== 0)
						return fail(
							new AudioStreamError('TOOL_FAILED', `audio decoder exited ${code ?? sig}: ${stderr.trim().slice(-1500)}`),
						);
					decoderDone = true;
					if (all) all = all.subarray(0, Math.max(allLen, 0) * 2) as Float32Array;
					pump();
				});
			} else pump();
		});
	} finally {
		if (dec) {
			const c = dec as ChildProcess;
			if (c.exitCode === null && c.signalCode === null) await terminateTree(c, 500);
		}
	}
}
