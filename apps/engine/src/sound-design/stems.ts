// Stems in one pass (spec 12 §2.6 "renders the mix and stems through renderMixdown"; wp-note "Phase 5 → WP5.1"): one
// export mixer (`OfflineMixer`, the same graph `renderMixdown` runs: clip effects, strips, sends, submixes, automation,
// the master) per stem — the mix, the sound effects, dialogue, music, ambience and the bed — rendered in lock-step over
// the same range, block by block, so every clip is decoded ONCE: a clip several stems play is read from one ffmpeg
// decoder whose samples are handed to each stem's mixer (`SharedDecoders`). Each stem plays only its clips (like
// `renderMixdown({onlyClips})`); the Mix's loudness normalisation is left out (the caller applies it as the export does).
//
// Every mixer opens a clip at the same block with the same offset and reads it in the same pattern (the same snapshot,
// the same latency), so the shared buffer only ever holds about one block per clip.
import type { ChildProcess } from 'node:child_process';
import type { Layout } from '@jasper/audio-dsp';
import {
	type AudioClip,
	type AudioStream,
	type Clip,
	type ClipReader,
	isSfxClip,
	OfflineMixer,
	type RenderAudioClip,
	type RenderSnapshot,
	readEssentialSound,
	type Sequence,
} from '@jasper/project';
import { clipDecodeArgs, hasSoxr, needsSampleExactDecode, PcmStreamReader } from '../audio/decode.ts';
import type { MixSource } from '../audio/mixdown.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';

const BLOCK = 48_000;

export type StemSpec = {
	name: string;
	/** Clips this stem plays (null: every clip: the mix). An empty set is not rendered (`onBlock` is not called). */
	clipIds: ReadonlySet<string> | null;
};

export type StemsOptions = {
	ff: Ffmpeg;
	snapshot: RenderSnapshot;
	media(mediaId: string): MixSource | null;
	/** Absolute sample (sequence time at the Mix rate) of the first rendered sample, and how many to render. */
	startSample: number;
	samples: number;
	stems: readonly StemSpec[];
	/** Output layout of every stem (default the Mix's own: mono, stereo or 5.1 — `mixLayoutOf`). */
	outputLayout?: Layout;
	signal?: AbortSignal;
	onSpawn?(child: ChildProcess): void;
	/** Each rendered block of stem `stem` (planar, `n` samples), from absolute sample `at` (awaited). */
	onBlock(stem: number, planar: Float32Array[], n: number, at: number): void | Promise<void>;
	onProgress?(fraction: number): void;
};

export type StemsResult = {
	sampleRate: number;
	channels: number;
	/** First absolute sample and the number rendered. */
	startSample: number;
	samples: number;
	/** Stems rendered (an empty clip set is not). */
	rendered: string[];
	/** ffmpeg decoders started (one per clip span, shared by the stems). */
	decoders: number;
};

type Chunk = { at: number; data: Float32Array[]; n: number };

/** Samples a shared decoder keeps behind its newest one, so a mixer opening the clip in the same block still finds it. */
const KEEP = 3 * BLOCK;

/** One decoder shared by the mixers that play the same clip span. */
class SharedClip {
	readonly tees = new Set<TeeReader>();
	private chunks: Chunk[] = [];
	private end = 0;
	private eof = false;
	/** Some samples were dropped: a new reader cannot start at the span's beginning any more. */
	trimmed = false;
	constructor(
		readonly channels: number,
		private readonly reader: ClipReader,
	) {}
	async fillTo(upTo: number): Promise<void> {
		while (this.end < upTo && !this.eof) {
			const k = Math.min(BLOCK, upTo - this.end);
			const data = Array.from({ length: this.channels }, () => new Float32Array(k));
			const got = await this.reader.read(data, k);
			if (got <= 0) {
				this.eof = true;
				break;
			}
			this.chunks.push({ at: this.end, data, n: got });
			this.end += got;
			if (got < k) this.eof = true;
		}
	}
	/** Copies `[pos, pos + frames)` into `out`; returns the samples available. */
	copy(out: Float32Array[], pos: number, frames: number): number {
		const stop = Math.min(this.end, pos + frames);
		for (const c of this.chunks) {
			const a = Math.max(pos, c.at);
			const b = Math.min(stop, c.at + c.n);
			if (b <= a) continue;
			for (let ch = 0; ch < this.channels; ch++)
				out[ch]?.set(c.data[ch]!.subarray(a - c.at, b - c.at), a - pos);
		}
		return Math.max(0, stop - pos);
	}
	/** Drops what every reader has consumed and that is more than {@link KEEP} samples old. */
	trim(): void {
		let min = Number.POSITIVE_INFINITY;
		for (const t of this.tees) min = Math.min(min, t.pos);
		if (!Number.isFinite(min)) min = this.end;
		const cutoff = Math.min(min, this.end - KEEP);
		const kept = this.chunks.filter((c) => c.at + c.n > cutoff);
		if (kept.length !== this.chunks.length) {
			this.trimmed = true;
			this.chunks = kept;
		}
	}
	/** A reader closed. The decoder stays until the end of the outer block (`SharedDecoders.sweep`): another stem's mixer
	 * may still open this clip in the same block (a short clip is read and closed within one mixer's block). */
	release(t: TeeReader): void {
		this.tees.delete(t);
		if (this.tees.size > 0) this.trim();
	}
	/** Closes the decoder (no readers left). */
	close(): void {
		this.reader.close();
		this.chunks = [];
		this.trimmed = true;
	}
}

class TeeReader implements ClipReader {
	pos = 0;
	private closed = false;
	constructor(private readonly shared: SharedClip) {
		shared.tees.add(this);
	}
	get channels(): number {
		return this.shared.channels;
	}
	async read(out: Float32Array[], frames: number): Promise<number> {
		if (this.closed) return 0;
		await this.shared.fillTo(this.pos + frames);
		const got = this.shared.copy(out, this.pos, frames);
		this.pos += got;
		this.shared.trim();
		return got;
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.shared.release(this);
	}
}

/** Decoders by clip span; a span opened again after all its readers closed starts a new decoder. */
class SharedDecoders {
	private readonly open = new Map<string, SharedClip>();
	started = 0;
	constructor(
		private readonly o: Pick<StemsOptions, 'ff' | 'snapshot' | 'media' | 'signal' | 'onSpawn'>,
		private readonly soxr: boolean,
	) {}
	/** After every stem rendered a block: closes the decoders no reader uses any more. */
	sweep(): void {
		for (const [k, v] of this.open)
			if (v.tees.size === 0) {
				v.close();
				this.open.delete(k);
			}
	}
	/** Closes every decoder. */
	closeAll(): void {
		for (const v of this.open.values()) v.close();
		this.open.clear();
	}
	reader(
		clip: RenderAudioClip,
		at: { offset: number; length: number; sampleRate: number },
	): ClipReader | null {
		const key = `${clip.clipId}|${at.offset}|${at.length}|${at.sampleRate}`;
		const live = this.open.get(key);
		// share only while the span's beginning is still buffered (mixers open a clip in the same block)
		if (live && !live.trimmed) return new TeeReader(live);
		const m = this.o.media(clip.mediaId);
		if (!m) return null;
		const stream =
			m.streams.find((s) => s.index === clip.channels.streamIndex) ??
			m.streams.find((s) => s.type === 'audio');
		if (!stream) return null;
		const { args, channels } = clipDecodeArgs({
			clip,
			path: m.path,
			stream: stream as AudioStream,
			fps: this.o.snapshot.settings.fps,
			sampleRate: at.sampleRate,
			offset: at.offset,
			length: at.length,
			soxr: this.soxr,
			sampleExact: needsSampleExactDecode(m, stream),
		});
		const child = this.o.ff.spawnRaw(args, {
			...(this.o.signal ? { signal: this.o.signal } : {}),
			...(this.o.onSpawn ? { onSpawn: this.o.onSpawn } : {}),
		});
		this.started++;
		live?.close();
		const shared = new SharedClip(channels, new PcmStreamReader(channels, child));
		this.open.set(key, shared);
		return new TeeReader(shared);
	}
}

/**
 * The layout Sound Check renders and measures in: the Mix's own (WP6.5b — a mono Mix in mono, not as the stereo upmix
 * the export writes by default: BS.1770 measures a mono programme as one channel), and its channel count.
 */
export function mixLayoutOf(snap: { audioMix?: { masterFormat?: string } | null }): {
	layout: 'mono' | 'stereo' | '5.1';
	channels: 1 | 2 | 6;
} {
	const f = snap.audioMix?.masterFormat;
	return f === '5.1'
		? { layout: '5.1', channels: 6 }
		: f === 'mono'
			? { layout: 'mono', channels: 1 }
			: { layout: 'stereo', channels: 2 };
}

/** Renders every stem over `range` in one pass (see the module docs). Throws on abort. */
export async function renderStems(o: StemsOptions): Promise<StemsResult> {
	const snap = o.snapshot;
	const mix = snap.audioMix;
	if (!mix) throw new Error('render snapshot without audioMix');
	const sr = mix.sampleRate;
	const start = Math.max(0, Math.floor(o.startSample));
	const total = Math.max(0, Math.floor(o.samples));
	const layout = o.outputLayout ?? mixLayoutOf(snap).layout;
	const decoders = new SharedDecoders(o, await hasSoxr(o.ff));
	const mixers: { index: number; mixer: OfflineMixer; block: Float32Array[] }[] = [];
	const rendered: string[] = [];
	o.stems.forEach((stem, index) => {
		if (stem.clipIds && stem.clipIds.size === 0) return;
		const only = stem.clipIds;
		const mixer = new OfflineMixer({
			snapshot: snap,
			openClip: (clip, at) => (only && !only.has(clip.clipId) ? null : decoders.reader(clip, at)),
			startSample: start,
			outputLayout: layout,
		});
		const channels = mixer.outputLayout === 'mono' ? 1 : mixer.outputLayout === '5.1' ? 6 : 2;
		mixers.push({ index, mixer, block: Array.from({ length: channels }, () => new Float32Array(BLOCK)) });
		rendered.push(stem.name);
	});
	const channels = layout === 'mono' ? 1 : layout === '5.1' ? 6 : 2;
	try {
		for (let done = 0; done < total; ) {
			if (o.signal?.aborted) throw new Error('aborted');
			const n = Math.min(BLOCK, total - done);
			for (const m of mixers) {
				const view = m.block.map((c) => c.subarray(0, n));
				await m.mixer.render(view, n);
				await o.onBlock(m.index, view, n, start + done);
			}
			decoders.sweep();
			done += n;
			o.onProgress?.(done / Math.max(1, total));
		}
	} finally {
		for (const m of mixers) m.mixer.close();
		decoders.closeAll();
	}
	return {
		sampleRate: sr,
		channels,
		startSample: start,
		samples: total,
		rendered,
		decoders: decoders.started,
	};
}

/** The stems of a Sound Check (spec 12 §2.6): the mix, sound effects, dialogue, music, ambience and the bed. */
export const STEM_NAMES = ['mix', 'sfx', 'dialogue', 'music', 'ambience', 'bed'] as const;
export type StemName = (typeof STEM_NAMES)[number];

/**
 * The clips of each stem among `playing` (the clips the mix plays): sound effects are `isSfxClip`; everything else is
 * the bed, and dialogue / music / ambience by its Essential Sound type (untyped audio and nests are bed only).
 */
export function classifyStems(seq: Sequence, playing: Iterable<string>): Record<StemName, Set<string>> {
	const out: Record<StemName, Set<string>> = {
		mix: new Set(),
		sfx: new Set(),
		dialogue: new Set(),
		music: new Set(),
		ambience: new Set(),
		bed: new Set(),
	};
	for (const id of playing) {
		out.mix.add(id);
		const c = seq.clips[id] as Clip | undefined;
		if (c && isSfxClip(c)) {
			out.sfx.add(id);
			continue;
		}
		out.bed.add(id);
		const t = c?.kind === 'audio' ? readEssentialSound((c as AudioClip).essential)?.type : undefined;
		if (t === 'dialogue' || t === 'music' || t === 'ambience') out[t].add(id);
	}
	return out;
}
