// Audio mixdown of an export or analysis (audio-mix): runs the offline mixer (`@jasper/project` OfflineMixer) over
// the export range with ffmpeg clip decoders, measures BS.1770-4 loudness of the result while writing it, and — for
// loudness normalisation — applies `target − measured` and a look-ahead true-peak limiter at the ceiling in a second
// pass (two-pass normalisation on the final mix, S04:RN-032). Output: a float32 WAV (WAVE_FORMAT_EXTENSIBLE) that
// every export path muxes as the deliverable's audio.
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
	defaultChannelWeights,
	type Layout,
	LoudnessMeter,
	type LoudnessSummary,
	type Mixdown,
	TruePeakLimiter,
} from '@jasper/audio-dsp';
import {
	type AudioStream,
	type ClipReader,
	frameToSample,
	OfflineMixer,
	type RenderAudioClip,
	type RenderSnapshot,
} from '@jasper/project';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { clipDecodeArgs, hasSoxr, PcmStreamReader } from './decode.ts';

export type MixSource = { path: string; streams: readonly AudioStream[] };

export type MixdownOptions = {
	ff: Ffmpeg;
	snapshot: RenderSnapshot;
	/** mediaId → online local file (null / missing = offline: silent). */
	media(mediaId: string): MixSource | null;
	/** Sequence frames to render. */
	range: { start: number; end: number };
	/** Exact output length in samples (export duration); default the range length. */
	length?: number;
	outputLayout?: Layout;
	mixdown?: Mixdown;
	/** Two-pass loudness normalisation of the final mix. */
	normalize?: { targetLufs: number; truePeakDb: number } | null;
	scratchDir: string;
	signal?: AbortSignal;
	onSpawn?(child: import('node:child_process').ChildProcess): void;
	onProgress?(fraction: number, stage: string): void;
	/** Analysis scopes: only these tracks / clips play; `source` skips clip gain, volume, fades and pan. */
	onlyTracks?: ReadonlySet<string>;
	onlyClips?: ReadonlySet<string>;
	clipLevels?: 'mix' | 'source';
	/** Don't keep the file (analysis): measure only. */
	measureOnly?: boolean;
};

export type MixdownResult = {
	/** The WAV file (absent with `measureOnly`). */
	path: string | null;
	sampleRate: number;
	channels: number;
	samples: number;
	/** Loudness of the delivered audio (after normalisation). */
	loudness: LoudnessSummary;
	/** Loudness before normalisation and the gain applied (normalised exports). */
	normalized?: { before: LoudnessSummary; gainDb: number; truePeakDb: number };
};

/** Layout of a channel count. */
export function layoutOf(n: number): Layout {
	return n === 1 ? 'mono' : n === 6 ? '5.1' : 'stereo';
}

/** RIFF/WAVE header for float32 PCM (extensible, channel mask for 1/2/6 channels). */
export function wavHeaderF32(channels: number, sampleRate: number, frames: number): Buffer {
	const dataLen = frames * channels * 4;
	const b = Buffer.alloc(68);
	b.write('RIFF', 0, 'ascii');
	b.writeUInt32LE(Math.min(0xffffffff, 60 + dataLen), 4);
	b.write('WAVE', 8, 'ascii');
	b.write('fmt ', 12, 'ascii');
	b.writeUInt32LE(40, 16);
	b.writeUInt16LE(0xfffe, 20); // WAVE_FORMAT_EXTENSIBLE
	b.writeUInt16LE(channels, 22);
	b.writeUInt32LE(sampleRate, 24);
	b.writeUInt32LE(sampleRate * channels * 4, 28);
	b.writeUInt16LE(channels * 4, 32);
	b.writeUInt16LE(32, 34);
	b.writeUInt16LE(22, 36);
	b.writeUInt16LE(32, 38);
	const mask = channels === 1 ? 0x4 : channels === 2 ? 0x3 : channels === 6 ? 0x3f : 0;
	b.writeUInt32LE(mask, 40);
	// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {00000003-0000-0010-8000-00aa00389b71}
	Buffer.from('0300000000001000800000aa00389b71', 'hex').copy(b, 44);
	b.write('data', 60, 'ascii');
	b.writeUInt32LE(Math.min(0xffffffff, dataLen), 64);
	return b;
}
export const WAV_F32_HEADER_BYTES = 68;

function interleave(planar: Float32Array[], n: number): Buffer {
	const ch = planar.length;
	const buf = Buffer.alloc(n * ch * 4);
	for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) buf.writeFloatLE(planar[c]![i]!, (i * ch + c) * 4);
	return buf;
}

const BLOCK = 48_000;

/** Renders the mix of `snapshot` over `range` (see MixdownOptions). */
export async function renderMixdown(o: MixdownOptions): Promise<MixdownResult> {
	const snap = o.snapshot;
	const mix = snap.audioMix;
	if (!mix) throw new Error('render snapshot without audioMix');
	const sr = mix.sampleRate;
	const fps = snap.settings.fps;
	const start = frameToSample(o.range.start, fps, sr);
	const total = o.length ?? frameToSample(o.range.end, fps, sr) - start;
	const soxr = await hasSoxr(o.ff);
	const openClip = (clip: RenderAudioClip, at: { offset: number; length: number; sampleRate: number }) => {
		if (o.onlyClips && !o.onlyClips.has(clip.clipId)) return null;
		const m = o.media(clip.mediaId);
		if (!m) return null;
		const stream =
			m.streams.find((s) => s.index === clip.channels.streamIndex) ?? m.streams.find((s) => s.type === 'audio');
		if (!stream) return null;
		const { args, channels } = clipDecodeArgs({
			clip,
			path: m.path,
			stream,
			fps,
			sampleRate: at.sampleRate,
			offset: at.offset,
			length: at.length,
			soxr,
		});
		const child = o.ff.spawnRaw(args, { ...(o.signal ? { signal: o.signal } : {}), ...(o.onSpawn ? { onSpawn: o.onSpawn } : {}) });
		return new PcmStreamReader(channels, child) as ClipReader;
	};
	const sourceLevels = o.clipLevels === 'source';
	const snapshot = sourceLevels ? withSourceLevels(snap) : snap;
	const mixer = new OfflineMixer({
		snapshot,
		openClip,
		startSample: start,
		...(o.outputLayout ? { outputLayout: o.outputLayout } : {}),
		...(o.mixdown ? { mixdown: o.mixdown } : {}),
		...(o.onlyTracks ? { onlyTracks: o.onlyTracks } : {}),
		...(sourceLevels ? { tap: 'track-inputs' as const } : {}),
	});
	const channels = mixer.outputLayout === 'mono' ? 1 : mixer.outputLayout === '5.1' ? 6 : 2;
	const meter = new LoudnessMeter(sr, channels, { weights: defaultChannelWeights(channels) });
	const keep = !o.measureOnly;
	const pass1 = keep ? join(o.scratchDir, o.normalize ? 'mix-pass1.wav' : 'mix.wav') : null;
	const fh = pass1 ? await open(pass1, 'w') : null;
	try {
		if (fh) await fh.write(wavHeaderF32(channels, sr, total));
		const block = Array.from({ length: channels }, () => new Float32Array(BLOCK));
		for (let done = 0; done < total; ) {
			if (o.signal?.aborted) throw new Error('aborted');
			const n = Math.min(BLOCK, total - done);
			const view = block.map((c) => c.subarray(0, n));
			await mixer.render(view, n);
			meter.process(view, 0, n);
			if (fh) await fh.write(interleave(view, n));
			done += n;
			o.onProgress?.((done / total) * (o.normalize ? 0.6 : 1), 'Mixing audio');
		}
	} finally {
		mixer.close();
		await fh?.close();
	}
	const before = meter.summary();
	if (!o.normalize || !keep || !pass1) {
		return { path: pass1, sampleRate: sr, channels, samples: total, loudness: before };
	}
	// ---- pass 2: gain + true-peak limiter
	const gainDb = Number.isFinite(before.integrated) ? o.normalize.targetLufs - before.integrated : 0;
	const g = 10 ** (gainDb / 20);
	const out = join(o.scratchDir, 'mix.wav');
	const limiter = new TruePeakLimiter(sr, channels, { ceilingDb: o.normalize.truePeakDb, lookaheadMs: 5, releaseMs: 100 });
	const meter2 = new LoudnessMeter(sr, channels, { weights: defaultChannelWeights(channels) });
	const src = await open(pass1, 'r');
	const dst = await open(out, 'w');
	try {
		await dst.write(wavHeaderF32(channels, sr, total));
		let skip = limiter.latency;
		let written = 0;
		const raw = Buffer.alloc(BLOCK * channels * 4);
		const block = Array.from({ length: channels }, () => new Float32Array(BLOCK));
		const emit = async (n: number) => {
			limiter.process(block, 0, n);
			let from = 0;
			if (skip > 0) {
				from = Math.min(n, skip);
				skip -= from;
			}
			const m = Math.min(n - from, total - written);
			if (m <= 0) return;
			const view = block.map((c) => c.subarray(from, from + m));
			meter2.process(view, 0, m);
			await dst.write(interleave(view, m));
			written += m;
		};
		for (let done = 0; done < total; ) {
			if (o.signal?.aborted) throw new Error('aborted');
			const n = Math.min(BLOCK, total - done);
			const { bytesRead } = await src.read(raw, 0, n * channels * 4, WAV_F32_HEADER_BYTES + done * channels * 4);
			const got = Math.floor(bytesRead / (channels * 4));
			for (let i = 0; i < n; i++)
				for (let c = 0; c < channels; c++)
					block[c]![i] = i < got ? raw.readFloatLE((i * channels + c) * 4) * g : 0;
			await emit(n);
			done += n;
			o.onProgress?.(0.6 + (done / total) * 0.4, 'Normalizing loudness');
		}
		// flush the limiter's delay line
		for (let left = limiter.latency; left > 0 && written < total; ) {
			const n = Math.min(BLOCK, left);
			for (const c of block) c.fill(0, 0, n);
			await emit(n);
			left -= n;
		}
	} finally {
		await src.close();
		await dst.close();
		await rm(pass1, { force: true });
	}
	return {
		path: out,
		sampleRate: sr,
		channels,
		samples: total,
		loudness: meter2.summary(),
		normalized: { before, gainDb, truePeakDb: o.normalize.truePeakDb },
	};
}

/** A snapshot whose clips play at their source level (no gain, volume, fades or pan): peak / source analysis. */
function withSourceLevels(s: RenderSnapshot): RenderSnapshot {
	const flat = { value: 0, keyframes: [] };
	return {
		...s,
		audioClips: s.audioClips.map((c) => {
			const { fades: _f, ...rest } = c;
			return { ...rest, gainDb: 0, volumeDb: flat, pan: flat };
		}),
	};
}
