// Waveform peaks (S04:WF-001/002, ARCHITECTURE D-10): ffmpeg decodes one audio stream to interleaved
// float32 PCM at 8 kHz; a worker thread reduces it to max-abs peaks at 100/s per channel (planar output).
import type { ChildProcess } from 'node:child_process';
import { Worker } from 'node:worker_threads';

export const PEAKS_PER_SECOND = 100;
export const PEAKS_SAMPLE_RATE = 8000;

type PeakReducer = {
	push(chunk: Uint8Array): void;
	finish(): { channels: Float32Array[]; frames: number };
};

/**
 * Streaming max-abs reducer over interleaved little-endian float32 PCM. Self-contained (no imports or
 * closures over module scope) because its source text also runs inside the worker thread.
 */
export function createPeakReducer(channels: number, samplesPerPeak: number): PeakReducer {
	const peaks: number[][] = [];
	for (let c = 0; c < channels; c++) peaks.push([]);
	const cur = new Array<number>(channels).fill(0);
	let inPeak = 0;
	let frames = 0;
	let ch = 0;
	let carry = new Uint8Array(0);
	return {
		push(chunk) {
			let data = chunk;
			if (carry.length > 0) {
				const joined = new Uint8Array(carry.length + chunk.length);
				joined.set(carry, 0);
				joined.set(chunk, carry.length);
				data = joined;
			}
			const usable = data.length - (data.length % 4);
			const view = new DataView(data.buffer, data.byteOffset, usable);
			for (let off = 0; off < usable; off += 4) {
				const a = Math.abs(view.getFloat32(off, true));
				if (a > cur[ch]! && Number.isFinite(a)) cur[ch] = a;
				ch++;
				if (ch === channels) {
					ch = 0;
					frames++;
					inPeak++;
					if (inPeak === samplesPerPeak) {
						for (let c = 0; c < channels; c++) {
							peaks[c]!.push(Math.min(1, cur[c]!));
							cur[c] = 0;
						}
						inPeak = 0;
					}
				}
			}
			carry = data.slice(usable);
		},
		finish() {
			if (inPeak > 0) {
				for (let c = 0; c < channels; c++) {
					peaks[c]!.push(Math.min(1, cur[c]!));
					cur[c] = 0;
				}
				inPeak = 0;
			}
			return { channels: peaks.map((p) => Float32Array.from(p)), frames };
		},
	};
}

// The worker evaluates the reducer's own source text, so preview (TS tests) and production share it.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const createPeakReducer = ${createPeakReducer.toString()};
const reducer = createPeakReducer(workerData.channels, workerData.samplesPerPeak);
parentPort.on('message', (m) => {
	if (m.type === 'chunk') reducer.push(new Uint8Array(m.buf));
	else if (m.type === 'end') {
		const r = reducer.finish();
		const bufs = r.channels.map((c) => c.buffer);
		parentPort.postMessage({ type: 'done', frames: r.frames, channels: bufs }, bufs);
	}
});
`;

/** Pipes a child's stdout (f32le PCM) through a worker-thread reducer. Rejects when the child fails. */
export function reducePeaksFromChild(
	child: ChildProcess,
	channels: number,
	samplesPerPeak = PEAKS_SAMPLE_RATE / PEAKS_PER_SECOND,
	signal?: AbortSignal,
): Promise<{ channels: Float32Array[]; frames: number }> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { channels, samplesPerPeak } });
		let stderr = '';
		let failed = false;
		const fail = (e: Error) => {
			if (failed) return;
			failed = true;
			void worker.terminate();
			reject(e);
		};
		worker.on('message', (m: { type: string; frames: number; channels: ArrayBuffer[] }) => {
			if (m.type === 'done') {
				void worker.terminate();
				resolve({ frames: m.frames, channels: m.channels.map((b) => new Float32Array(b)) });
			}
		});
		worker.on('error', (e) => fail(e));
		child.stdout!.on('data', (c: Buffer) => {
			// Copy into a standalone ArrayBuffer so it can be transferred.
			const ab = c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength);
			worker.postMessage({ type: 'chunk', buf: ab }, [ab as ArrayBuffer]);
		});
		child.stderr!.setEncoding('utf8').on('data', (c: string) => {
			stderr = (stderr + c).slice(-8000);
		});
		child.on('error', (e) => fail(e));
		child.on('close', (code) => {
			if (signal?.aborted) fail(Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }));
			else if (code !== 0)
				fail(Object.assign(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`), { code: 'TOOL_FAILED' }));
			else worker.postMessage({ type: 'end' });
		});
	});
}

/** Planar little-endian float32: channel 0 peaks, then channel 1 peaks, … */
export function planarBytes(channels: Float32Array[]): Buffer {
	const total = channels.reduce((n, c) => n + c.length, 0);
	const out = Buffer.alloc(total * 4);
	let off = 0;
	for (const c of channels) {
		for (let i = 0; i < c.length; i++, off += 4) out.writeFloatLE(c[i]!, off);
	}
	return out;
}
