// Frame-exact decoding for retimed video layers: reverse playback, time remaps, Frame Blending /
// Optical Flow and variable-frame-rate media in the Program monitor and in Remotion renders. Built on mediabunny (the
// demuxer/decoder @remotion/media itself uses): frames are found by their real timestamps (VFR media show the frame
// whose timestamp is at or before the media time, like the native export), and decoded frames are cached per
// group of pictures, so a reverse or slow-motion playback decodes each GOP once instead of once per output frame.
//
// Media time 0 is the start of the file (the earliest timestamp of any track: ffmpeg's `start_time`, the origin of
// input seeking and of clip content times); a time before the first video frame shows the first frame.
import {
	ALL_FORMATS,
	CanvasSink,
	EncodedPacketSink,
	Input,
	type InputVideoTrack,
	UrlSource,
} from 'mediabunny';

export type DecodedFrame = {
	canvas: HTMLCanvasElement | OffscreenCanvas;
	/** Media time of the frame (seconds from the first frame). */
	time: number;
	/** Until the next frame (seconds). */
	duration: number;
};

/** Seconds of tolerance when matching a media time to a frame timestamp. */
const EPS = 2e-6;
/** Cache budget per decoder (bytes of decoded RGBA). */
const BUDGET_BYTES = 384 * 1024 * 1024;
/** Frames decoded ahead of a forward request. */
const READ_AHEAD = 6;

type Cached = DecodedFrame & { used: number; bytes: number };

/**
 * A decoder of one media at one output size. `frameAt(t)` returns the frame shown at media time t; `nextAfter(f)` the
 * frame after it (Frame Blending / Optical Flow).
 */
export class FrameSource {
	private input: Input | null = null;
	private sink: CanvasSink | null = null;
	private packets: EncodedPacketSink | null = null;
	private origin = 0;
	/** Media time of the first video frame. */
	private first = 0;
	private end = Number.POSITIVE_INFINITY;
	private frames: Cached[] = [];
	private bytes = 0;
	private clock = 0;
	private chain: Promise<unknown> = Promise.resolve();
	private fwd: {
		it: AsyncGenerator<{ canvas: HTMLCanvasElement | OffscreenCanvas; timestamp: number; duration: number }>;
		last: number;
	} | null = null;
	readonly ready: Promise<void>;
	private failed: Error | null = null;

	constructor(
		readonly src: string,
		readonly width: number,
		readonly height: number,
		readonly alpha: boolean,
	) {
		this.ready = this.open().catch((e: unknown) => {
			this.failed = e instanceof Error ? e : new Error(String(e));
		});
	}

	private async open(): Promise<void> {
		this.input = new Input({ source: new UrlSource(this.src), formats: ALL_FORMATS });
		const track: InputVideoTrack | null = await this.input.getPrimaryVideoTrack();
		if (!track) throw new Error(`No video track in ${this.src}`);
		if (!(await track.canDecode())) throw new Error(`The browser cannot decode the video of ${this.src}`);
		// Negative timestamps represent priming/pre-roll hidden by container edit lists. Clamp each track's
		// first timestamp to zero so media time agrees with ffmpeg input seeking.
		const firsts = [await track.getFirstTimestamp()];
		for (const t of await this.input.getTracks()) firsts.push(await t.getFirstTimestamp());
		this.origin = Math.min(
			...firsts.map((x) => (Number.isFinite(x) ? Math.max(0, x) : Number.POSITIVE_INFINITY)),
		);
		if (!Number.isFinite(this.origin)) this.origin = 0;
		this.first = (await track.getFirstTimestamp()) - this.origin;
		this.end = (await track.computeDuration()) - this.origin;
		this.sink = new CanvasSink(track, {
			width: this.width,
			height: this.height,
			fit: 'fill',
			alpha: this.alpha,
		});
		this.packets = new EncodedPacketSink(track);
	}

	/** Duration of the video track (seconds from its first frame). */
	get duration(): number {
		return this.end;
	}

	/** The cached frame shown at media time t, or null. */
	peek(t: number): DecodedFrame | null {
		const f = this.find(t);
		if (f) f.used = ++this.clock;
		return f;
	}

	private find(t: number): Cached | null {
		const fs = this.frames;
		let lo = 0;
		let hi = fs.length - 1;
		let ans = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (fs[mid]!.time <= t + EPS) {
				ans = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		if (ans < 0) return null;
		const f = fs[ans]!;
		// A hit when t falls inside the frame's own duration (the container's timing: exact for VFR media).
		if (f.duration <= 0 || t < f.time + f.duration - EPS) return f;
		return null;
	}

	private insert(c: {
		canvas: HTMLCanvasElement | OffscreenCanvas;
		timestamp: number;
		duration: number;
	}): Cached {
		const time = c.timestamp - this.origin;
		const existing = this.frames.find((x) => Math.abs(x.time - time) < 1e-7);
		if (existing) return existing;
		const bytes = c.canvas.width * c.canvas.height * 4;
		const f: Cached = { canvas: c.canvas, time, duration: c.duration, used: ++this.clock, bytes };
		const i = this.frames.findIndex((x) => x.time > time);
		if (i < 0) this.frames.push(f);
		else this.frames.splice(i, 0, f);
		this.bytes += bytes;
		this.evict();
		return f;
	}

	private evict(): void {
		while (this.bytes > BUDGET_BYTES && this.frames.length > 8) {
			let oldest = 0;
			for (let i = 1; i < this.frames.length; i++)
				if (this.frames[i]!.used < this.frames[oldest]!.used) oldest = i;
			const [f] = this.frames.splice(oldest, 1);
			this.bytes -= f!.bytes;
		}
	}

	/** Serialises decoder work (one mediabunny iteration at a time). */
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn);
		this.chain = run.catch(() => undefined);
		return run;
	}

	/** The frame shown at media time t (clamped to the media), decoding its GOP when needed. */
	async frameAt(t: number): Promise<DecodedFrame | null> {
		await this.ready;
		if (this.failed) throw this.failed;
		const tt = Math.max(this.first, Math.min(t, Math.max(this.first, this.end - 1e-6)));
		const hit = this.peek(tt);
		if (hit) return hit;
		return this.serial(async () => {
			const again = this.peek(tt);
			if (again) return again;
			await this.decodeTo(tt);
			return this.peek(tt) ?? this.nearestBefore(tt);
		});
	}

	/** The frame after `f` (null at the end of the media). */
	async nextAfter(f: DecodedFrame): Promise<DecodedFrame | null> {
		const t = f.time + Math.max(f.duration, 1e-4) + EPS;
		if (t >= this.end - 1e-6) return null;
		const n = await this.frameAt(t);
		return n && n.time > f.time + 1e-7 ? n : null;
	}

	private nearestBefore(t: number): DecodedFrame | null {
		let best: Cached | null = null;
		for (const f of this.frames) if (f.time <= t + EPS && (!best || f.time > best.time)) best = f;
		return best;
	}

	/** Decodes from the GOP containing t (or continues the forward iterator) up to t plus a little read-ahead. */
	private async decodeTo(t: number): Promise<void> {
		const sink = this.sink!;
		const abs = t + this.origin;
		const fwd = this.fwd;
		if (fwd && t > fwd.last - EPS && t - fwd.last < 2) {
			if (await this.pull(fwd, t)) return;
		}
		const key = await this.packets!.getKeyPacket(abs);
		const start = key ? key.timestamp : this.origin + this.first;
		this.fwd = { it: sink.canvases(start), last: start - this.origin - 1 };
		await this.pull(this.fwd, t);
	}

	/** Pulls frames from a forward iterator until one covers t (plus read-ahead). False when it ended first. */
	private async pull(fwd: NonNullable<FrameSource['fwd']>, t: number): Promise<boolean> {
		let ahead = -1;
		for (;;) {
			const r = await fwd.it.next();
			if (r.done) {
				this.fwd = null;
				return ahead >= 0 || !!this.find(t);
			}
			const f = this.insert(r.value);
			fwd.last = f.time;
			if (ahead >= 0) {
				if (++ahead >= READ_AHEAD) return true;
			} else if (f.time + f.duration > t + EPS || f.time > t) ahead = 0;
		}
	}

	dispose(): void {
		void this.fwd?.it.return(undefined);
		this.fwd = null;
		this.frames = [];
		this.bytes = 0;
		this.input?.dispose();
	}
}

const sources = new Map<string, { src: FrameSource; refs: number }>();

/** A shared decoder for (src, size); release it with `releaseFrameSource`. */
export function acquireFrameSource(src: string, width: number, height: number, alpha: boolean): FrameSource {
	const key = `${src}|${width}x${height}|${alpha ? 1 : 0}`;
	const hit = sources.get(key);
	if (hit) {
		hit.refs++;
		return hit.src;
	}
	const s = new FrameSource(src, width, height, alpha);
	sources.set(key, { src: s, refs: 1 });
	return s;
}

export function releaseFrameSource(s: FrameSource): void {
	for (const [key, v] of sources)
		if (v.src === s) {
			if (--v.refs <= 0) {
				sources.delete(key);
				s.dispose();
			}
			return;
		}
}
