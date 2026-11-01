// Frame decoding of the roto worker: ffmpeg decodes source frames to 8-bit RGB at the matte size (display
// orientation: ffmpeg autorotates). Exact frame selection as the tracker's decoder (tracking/decode.ts): an input
// seek half a frame before frame n makes n the first output frame; `-frames:v` bounds the span and `-fps_mode
// passthrough` keeps ffmpeg from duplicating or dropping frames. LGPL filters only (scale, format).
import { type ChildProcess, spawn } from 'node:child_process';
import { restrictInputs } from '../../tools/protocols.ts';

export type FrameSource = {
	ffmpeg: string;
	file: string;
	rate: { num: number; den: number };
	width: number;
	height: number;
	/** Display size of the media (scaling is skipped when equal to width × height). */
	display: { width: number; height: number };
	/** A still image (one frame, no seeking). */
	still: boolean;
};

export class CancelledError extends Error {
	constructor() {
		super('Cancelled');
	}
}

function args(s: FrameSource, start: number, count: number): string[] {
	const seek = !s.still && start > 0 ? ['-ss', (((start - 0.5) * s.rate.den) / s.rate.num).toFixed(6)] : [];
	const scale = s.width !== s.display.width || s.height !== s.display.height;
	const vf = scale ? `scale=${s.width}:${s.height}:flags=area,format=rgb24` : 'format=rgb24';
	return [
		'-v',
		'error',
		'-nostdin',
		...seek,
		'-i',
		s.file,
		...['-map', '0:v:0', '-an', '-sn', '-dn'],
		...['-vf', vf, '-fps_mode', 'passthrough'],
		...['-frames:v', String(s.still ? 1 : count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
	];
}

/** Yields `count` frames from `start` (fewer when the file ends). Stopping the iteration kills ffmpeg. */
export async function* decodeFrames(
	s: FrameSource,
	start: number,
	count: number,
	signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
	const bytes = s.width * s.height * 3;
	const child: ChildProcess = spawn(s.ffmpeg, restrictInputs(args(s, start, count)), {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let err = '';
	child.stderr?.on('data', (c: Buffer) => {
		if (err.length < 4000) err += c.toString();
	});
	const closed = new Promise<number | null>((resolve) => {
		child.on('close', (code) => resolve(code));
		child.on('error', () => resolve(-1));
	});
	const kill = () => child.kill('SIGKILL');
	signal?.addEventListener('abort', kill, { once: true });
	let cur = new Uint8Array(bytes);
	let filled = 0;
	let done = false;
	try {
		for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
			let off = 0;
			while (off < chunk.length) {
				const n = Math.min(bytes - filled, chunk.length - off);
				cur.set(chunk.subarray(off, off + n), filled);
				filled += n;
				off += n;
				if (filled === bytes) {
					yield cur;
					cur = new Uint8Array(bytes);
					filled = 0;
				}
			}
		}
		const code = await closed;
		done = true;
		if (signal?.aborted) throw new CancelledError();
		if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${err.trim().slice(-800)}`);
	} finally {
		signal?.removeEventListener('abort', kill);
		if (!done) kill();
	}
}

/**
 * Frames in the order of `frames` (ascending or descending runs of consecutive frames): ascending runs stream from one
 * decoder; descending runs decode chunks backwards (memory bound).
 */
export async function* framesInOrder(
	s: FrameSource,
	frames: readonly number[],
	signal?: AbortSignal,
): AsyncGenerator<{ frame: number; rgb: Uint8Array }> {
	if (frames.length === 0) return;
	if (s.still) {
		for await (const rgb of decodeFrames(s, 0, 1, signal)) {
			for (const f of frames) yield { frame: f, rgb };
			return;
		}
		throw new Error('The still could not be decoded');
	}
	const asc = frames.length === 1 || frames[1]! > frames[0]!;
	if (asc) {
		let k = 0;
		for await (const rgb of decodeFrames(s, frames[0]!, frames.length, signal)) {
			yield { frame: frames[k]!, rgb };
			if (++k >= frames.length) return;
		}
		return;
	}
	const K = Math.max(4, Math.min(60, Math.floor((256 * 1024 * 1024) / (s.width * s.height * 3))));
	let hi = frames[0]!;
	const lo = frames[frames.length - 1]!;
	while (hi >= lo) {
		const a = Math.max(lo, hi - K + 1);
		const chunk: Uint8Array[] = [];
		for await (const rgb of decodeFrames(s, a, hi - a + 1, signal)) chunk.push(rgb);
		for (let i = chunk.length - 1; i >= 0; i--) yield { frame: a + i, rgb: chunk[i]! };
		if (chunk.length === 0) return;
		hi = a - 1;
	}
}
