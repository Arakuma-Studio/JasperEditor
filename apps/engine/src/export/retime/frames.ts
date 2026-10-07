// Frame timestamps and frame-exact decoding for the native retime stage (workstream `time`).
//
// Timestamps: the presentation times of every video packet (ffprobe, no decode), relative to the file's start time —
// the origin of `-ss` input seeking and of clip content times, so a variable-frame-rate phone clip is mapped by its
// real timestamps (Premiere's VFR "Preserve Audio Sync") instead of being conformed. Cached per media fingerprint.
//
// Decoding: frames are decoded in chunks of consecutive indices (one ffmpeg per chunk: accurate input seek to the
// chunk's first timestamp, scaled to the layer box with the builder's colour conversion, raw RGBA), kept in a small
// LRU so reverse and slow segments decode each frame once.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FrameTimes } from '@jasper/project';
import type { Ffmpeg } from '../../tools/ffmpeg.ts';
import { terminateTree } from '../../tools/process.ts';

/** Presentation timestamps (seconds from the file start) of the first video stream's frames, ascending. */
export async function probeFrameTimes(
	ff: Ffmpeg,
	file: string,
	opts: { signal?: AbortSignal } = {},
): Promise<number[]> {
	const j = await ff.probeJson(
		['-select_streams', 'v:0', '-show_entries', 'packet=pts_time:format=start_time', file],
		opts.signal ? { signal: opts.signal } : {},
	);
	const start = Number((j.format as { start_time?: string } | undefined)?.start_time ?? 0) || 0;
	const pts = ((j.packets as { pts_time?: string }[] | undefined) ?? [])
		.map((p) => Number(p.pts_time))
		.filter((t) => Number.isFinite(t))
		.map((t) => t - start)
		.sort((a, b) => a - b);
	// Duplicate timestamps (rare muxer glitches) would make zero-length frames: keep the first.
	const out: number[] = [];
	for (const t of pts) if (out.length === 0 || t > out[out.length - 1]! + 1e-7) out.push(t);
	return out;
}

/** Frame times of a media, cached as JSON under `cacheDir` by `key` (media fingerprint). */
export async function cachedFrameTimes(
	ff: Ffmpeg,
	file: string,
	cacheDir: string,
	key: string,
	opts: { signal?: AbortSignal } = {},
): Promise<FrameTimes> {
	const path = join(cacheDir, `frametimes-${key.replace(/[^\w.-]/g, '_')}.json`);
	try {
		const times = JSON.parse(await readFile(path, 'utf8')) as number[];
		if (Array.isArray(times) && times.length > 0) return { kind: 'list', times };
	} catch {
		// not cached
	}
	const times = await probeFrameTimes(ff, file, opts);
	if (times.length === 0) throw new Error(`No video frames found in ${file}`);
	await mkdir(cacheDir, { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(times));
	await rename(tmp, path);
	return { kind: 'list', times };
}

export type DecodeSource = {
	file: string;
	/** Frame times of the media. */
	times: readonly number[];
	/** Output (layer box) size. */
	width: number;
	height: number;
	/** Scale options after `scale=W:H` (colour matrix, swscale flags), as the builder's source chain. */
	scaleOptions: string;
	/** Decoder for WebM alpha (`libvpx`/`libvpx-vp9`): decoded from the file start (see native.ts). */
	decoder: string | null;
	/**
	 * imports (Interpret Footage): decoder options before `-i` (EXR transfer) and filters before the scale (decode
	 * transfer, deinterlace, alpha interpretation) — the native builder's source chain.
	 */
	pre?: string[];
	filters?: string[];
};

/** Raw RGBA frames of a media by index, decoded in chunks with an LRU. */
export class ChunkedFrames {
	private readonly chunks = new Map<number, Uint8Array[]>();
	private readonly order: number[] = [];
	readonly chunkSize: number;
	readonly frameBytes: number;
	decodedFrames = 0;

	constructor(
		private readonly ff: Ffmpeg,
		private readonly src: DecodeSource,
		private readonly signal: AbortSignal,
		opts: { budgetBytes?: number; maxChunks?: number } = {},
	) {
		this.frameBytes = src.width * src.height * 4;
		const budget = opts.budgetBytes ?? 96 * 1024 * 1024;
		this.chunkSize = Math.max(4, Math.min(48, Math.floor(budget / this.frameBytes)));
		this.maxChunks = opts.maxChunks ?? 4;
	}

	private readonly maxChunks: number;

	get count(): number {
		return this.src.times.length;
	}

	/** Frame `i` (clamped to the media). */
	async get(i: number): Promise<Uint8Array> {
		const idx = Math.max(0, Math.min(this.count - 1, i));
		const c = Math.floor(idx / this.chunkSize);
		let chunk = this.chunks.get(c);
		if (!chunk) {
			chunk = await this.decodeChunk(c);
			this.chunks.set(c, chunk);
			this.order.push(c);
			while (this.order.length > this.maxChunks) this.chunks.delete(this.order.shift()!);
		} else {
			this.order.splice(this.order.indexOf(c), 1);
			this.order.push(c);
		}
		const f = chunk[idx - c * this.chunkSize];
		if (f) return f;
		// The decoder delivered fewer frames than the timestamps promise (truncated file): repeat the last one.
		if (chunk.length > 0) return chunk[chunk.length - 1]!;
		throw new Error(`Could not decode frame ${idx} of ${this.src.file}`);
	}

	private args(first: number, count: number): string[] {
		const s = this.src;
		const t = s.times[first]!;
		const prev = first > 0 ? s.times[first - 1]! : 0;
		const seek = first > 0 ? t - Math.min(0.5 * (t - prev), 0.01) : 0;
		const vf = [...(s.filters ?? []), `scale=${s.width}:${s.height}${s.scaleOptions},setsar=1,format=rgba`].join(',');
		const head = [...(s.decoder ? ['-c:v', s.decoder] : []), ...(s.pre ?? [])];
		if (s.decoder) {
			// WebM alpha: decode from the start, pick frames by index.
			return [
				...head,
				'-i',
				s.file,
				'-map',
				'0:v:0',
				'-an',
				'-sn',
				'-dn',
				'-vf',
				`select='between(n\\,${first}\\,${first + count - 1})',${vf}`,
				'-fps_mode',
				'passthrough',
				'-frames:v',
				String(count),
				'-f',
				'rawvideo',
				'-pix_fmt',
				'rgba',
				'pipe:1',
			];
		}
		return [
			...(seek > 0 ? ['-ss', seek.toFixed(6)] : []),
			...head,
			'-i',
			s.file,
			'-map',
			'0:v:0',
			'-an',
			'-sn',
			'-dn',
			'-vf',
			vf,
			'-fps_mode',
			'passthrough',
			'-frames:v',
			String(count),
			'-f',
			'rawvideo',
			'-pix_fmt',
			'rgba',
			'pipe:1',
		];
	}

	private decodeChunk(c: number): Promise<Uint8Array[]> {
		const first = c * this.chunkSize;
		const count = Math.min(this.chunkSize, this.count - first);
		const child = this.ff.spawnRaw(this.args(first, count), { signal: this.signal });
		const bytes = this.frameBytes;
		return new Promise<Uint8Array[]>((resolve, reject) => {
			const frames: Uint8Array[] = [];
			let cur = new Uint8Array(bytes);
			let filled = 0;
			let stderr = '';
			child.stderr?.setEncoding('utf8').on('data', (d: string) => {
				stderr = (stderr + d).slice(-4000);
			});
			child.stdout!.on('data', (chunk: Buffer) => {
				let off = 0;
				while (off < chunk.length) {
					const n = Math.min(bytes - filled, chunk.length - off);
					cur.set(chunk.subarray(off, off + n), filled);
					filled += n;
					off += n;
					if (filled === bytes) {
						if (frames.length < count) frames.push(cur);
						cur = new Uint8Array(bytes);
						filled = 0;
					}
				}
			});
			child.on('error', (e) => reject(e));
			child.on('close', (code, sig) => {
				if (this.signal.aborted) return reject(new Error('cancelled'));
				if (code !== 0)
					return reject(new Error(`retime decoder exited ${code ?? sig}: ${stderr.trim().slice(-1500)}`));
				this.decodedFrames += frames.length;
				resolve(frames);
			});
		}).catch(async (e) => {
			if (child.exitCode === null && child.signalCode === null) await terminateTree(child, 0);
			throw e;
		});
	}

	dispose(): void {
		this.chunks.clear();
		this.order.length = 0;
	}
}
