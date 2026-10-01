// Frame decoding for tracking (S09:TRK-011): ffmpeg decodes a span of source frames to 8-bit gray rawvideo at the
// tracking resolution (display orientation: ffmpeg's autorotate stays on) and pipes it to the engine.
//
// Exact frame selection: frame n of a constant-rate file has pts = start_time + n/fps, and an input `-ss` is relative
// to start_time with accurate seeking (frames before the seek point are decoded and dropped). Seeking half a frame
// before frame n therefore makes n the first output frame; `-frames:v` bounds the span and `-fps_mode passthrough`
// keeps ffmpeg from duplicating or dropping frames. Works with FFmpeg 6.1 and 7.1; only LGPL filters (scale, format).
import type { ChildProcess } from 'node:child_process';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { type SpawnOptions, ToolError, terminateTree } from '../tools/process.ts';

export type DecodeSpec = {
	file: string;
	/** First source frame. */
	start: number;
	/** Number of frames. */
	count: number;
	fps: { num: number; den: number };
	/** Output (tracking) size; the display size when no scaling is needed. */
	width: number;
	height: number;
	scale: boolean;
};

function decodeArgs(s: DecodeSpec): string[] {
	const seek = s.start > 0 ? ['-ss', (((s.start - 0.5) * s.fps.den) / s.fps.num).toFixed(6)] : [];
	const vf = s.scale ? `scale=${s.width}:${s.height}:flags=area,format=gray` : 'format=gray';
	return [
		...seek,
		'-i',
		s.file,
		...['-map', '0:v:0', '-an', '-sn', '-dn'],
		...['-vf', vf, '-fps_mode', 'passthrough'],
		...['-frames:v', String(s.count), '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
	];
}

/** Starts ffmpeg for `spec`; the child is killed when `opts.signal` aborts. */
export function spawnDecoder(ff: Ffmpeg, spec: DecodeSpec, opts: SpawnOptions = {}): ChildProcess {
	const { signal, ...spawnOpts } = opts;
	const child = ff.spawnRaw(decodeArgs(spec), spawnOpts);
	if (signal) {
		// Decoders only produce disposable pipe output. Waiting for FFmpeg's graceful teardown can
		// exceed the tracking cancellation deadline, especially with buffered frames and decoder threads.
		const cancel = () => void terminateTree(child, 0);
		if (signal.aborted) cancel();
		else {
			signal.addEventListener('abort', cancel, { once: true });
			child.once('exit', () => signal.removeEventListener('abort', cancel));
		}
	}
	return child;
}

/**
 * Yields whole frames (`width·height` bytes, each in its own ArrayBuffer so it can be transferred to a worker) from a
 * decoder's stdout, with backpressure. Ends early when the file has fewer frames; throws a ToolError when ffmpeg
 * fails. Stopping the iteration kills the decoder.
 */
export async function* readFrames(
	child: ChildProcess,
	frameBytes: number,
	signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
	let stderr = '';
	child.stderr?.setEncoding('utf8').on('data', (c: string) => {
		stderr = (stderr + c).slice(-4000);
	});
	let exit: { code: number | null; sig: NodeJS.Signals | null } | null = null;
	const closed = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolve) => {
		child.on('close', (code, sig) => {
			exit = { code, sig };
			resolve(exit);
		});
	});
	const spawnError = new Promise<Error | null>((resolve) => {
		child.once('error', (e) => resolve(e));
		child.once('close', () => resolve(null));
	});
	let cur = new Uint8Array(frameBytes);
	let filled = 0;
	try {
		for await (const chunk of child.stdout! as AsyncIterable<Buffer>) {
			let off = 0;
			while (off < chunk.length) {
				const n = Math.min(frameBytes - filled, chunk.length - off);
				cur.set(chunk.subarray(off, off + n), filled);
				filled += n;
				off += n;
				if (filled === frameBytes) {
					yield cur;
					cur = new Uint8Array(frameBytes);
					filled = 0;
				}
			}
		}
		const { code, sig } = await closed;
		if (signal?.aborted) throw new ToolError('JOB_CANCELLED', 'Tracking cancelled');
		const err = await spawnError;
		if (err) throw new ToolError('BINARY_MISSING', `Cannot run ffmpeg: ${err.message}`);
		if (code !== 0)
			throw new ToolError('TOOL_FAILED', `ffmpeg exited ${code ?? sig}: ${stderr.trim().slice(-1500)}`, {
				stderr,
			});
	} finally {
		if (!exit) await terminateTree(child, 500);
	}
}

/** Decodes a whole (short) span into memory. */
export async function decodeSpan(
	ff: Ffmpeg,
	spec: DecodeSpec,
	opts: SpawnOptions = {},
): Promise<Uint8Array[]> {
	const child = spawnDecoder(ff, spec, opts);
	const out: Uint8Array[] = [];
	for await (const f of readFrames(child, spec.width * spec.height, opts.signal)) out.push(f);
	return out;
}
