// Audio mixdown of an export or analysis (audio-mix): runs the offline mixer (`@jasper/project` OfflineMixer) over
// the export range with ffmpeg clip decoders, measures BS.1770-4 loudness of the result while writing it, and — for
// loudness normalisation — applies `target − measured` and a look-ahead true-peak limiter at the ceiling in a second
// pass (two-pass normalisation on the final mix, S04:RN-032), converging on the target and checking a lossy
// deliverable after encoding (`deliver.ts`). Output: a float32 WAV (WAVE_FORMAT_EXTENSIBLE) that every export path
// muxes as the deliverable's audio.

import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { endianness } from 'node:os';
import { join } from 'node:path';
import {
	defaultChannelWeights,
	type Layout,
	LoudnessMeter,
	type LoudnessSummary,
	type Mixdown,
} from '@jasper/audio-dsp';
import { installAudioFxProcessors } from '@jasper/audio-fx';
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
import {
	type DeliveryCodec,
	type DeliveryOutcome,
	type DeliveryParams,
	type Pass1,
	runDeliveryPass,
	solveDelivery,
} from './deliver.ts';

// audio-fx: the audio effect processors (clip effects and track / submix / Mix inserts) for the offline mixer.
installAudioFxProcessors();

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
	/**
	 * The deliverable's audio encoding (exports): with normalisation, a lossy codec gets the limiter headroom of its bit
	 * rate and the encoded audio is decoded and checked against the true-peak target (`deliver.ts`).
	 */
	deliver?: DeliveryCodec | null;
	scratchDir: string;
	signal?: AbortSignal;
	onSpawn?(child: import('node:child_process').ChildProcess): void;
	onProgress?(fraction: number, stage: string): void;
	/** Analysis scopes: only these tracks / clips play; `source` skips clip gain, volume, fades and pan. */
	onlyTracks?: ReadonlySet<string>;
	onlyClips?: ReadonlySet<string>;
	clipLevels?: 'mix' | 'source';
	/** `track-inputs`: the sum of the track inputs (clips as they reach their tracks), no strips or Mix. */
	tap?: 'master' | 'track-inputs';
	/** Ignore the Mix's loudness normalisation (analysis of the mix itself). */
	withoutLoudness?: boolean;
	/**
	 * Don't keep the file (analysis): measure only. With `normalize` the delivery is still solved (the converged gain,
	 * ceiling and passes in `normalized`, nothing written: the stored loudness analysis the preview plays with).
	 */
	measureOnly?: boolean;
	/** Every rendered block (before normalisation), e.g. for activity envelopes. */
	onBlock?(planar: Float32Array[], frames: number): void;
	/**
	 * Opt-in with `onlyClips` (analysis renders of a few clips): strips none of them reaches are not processed
	 * (`OfflineMixer` `audibleClips`; the output is the same).
	 */
	skipSilentStrips?: boolean;
	/**
	 * Measure the loudness of the result (default true). `false` (measure-only renders whose caller does not read
	 * `loudness`): no meter runs and `loudness` is a silent summary.
	 */
	meter?: boolean;
};

export type MixdownResult = {
	/** The WAV file (absent with `measureOnly`). */
	path: string | null;
	sampleRate: number;
	channels: number;
	samples: number;
	/** Loudness of the delivered audio (after normalisation). */
	loudness: LoudnessSummary;
	/**
	 * Loudness before normalisation, the gain applied (after convergence), the delivery target and how the delivery
	 * came to it (limiter ceiling, passes, the decoded check of a lossy codec: `deliver.ts`).
	 */
	normalized?: {
		before: LoudnessSummary;
		gainDb: number;
		truePeakDb: number;
		targetLufs: number;
		delivery: DeliveryOutcome;
		codec?: DeliveryCodec;
	};
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

const LITTLE_ENDIAN = endianness() === 'LE';

function interleave(planar: Float32Array[], n: number): Buffer {
	const ch = planar.length;
	if (LITTLE_ENDIAN) {
		// a typed view in the WAV's byte order (little-endian hosts): the same bytes as writeFloatLE, several times faster
		const f = new Float32Array(n * ch);
		for (let c = 0; c < ch; c++) {
			const p = planar[c]!;
			for (let i = 0; i < n; i++) f[i * ch + c] = p[i]!;
		}
		return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
	}
	const buf = Buffer.alloc(n * ch * 4);
	for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) buf.writeFloatLE(planar[c]![i]!, (i * ch + c) * 4);
	return buf;
}

const BLOCK = 48_000;

/** The `loudness` of a render without a meter (`meter: false`). */
const SILENT_SUMMARY: LoudnessSummary = new LoudnessMeter(48_000, 1).summary();

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
			m.streams.find((s) => s.index === clip.channels.streamIndex) ??
			m.streams.find((s) => s.type === 'audio');
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
		const child = o.ff.spawnRaw(args, {
			...(o.signal ? { signal: o.signal } : {}),
			...(o.onSpawn ? { onSpawn: o.onSpawn } : {}),
		});
		return new PcmStreamReader(channels, child) as ClipReader;
	};
	const sourceLevels = o.clipLevels === 'source';
	let snapshot = sourceLevels ? withSourceLevels(snap) : snap;
	if (o.withoutLoudness && snapshot.audioMix?.loudness)
		snapshot = { ...snapshot, audioMix: { ...snapshot.audioMix, loudness: null } };
	const mixer = new OfflineMixer({
		snapshot,
		openClip,
		startSample: start,
		...(o.outputLayout ? { outputLayout: o.outputLayout } : {}),
		...(o.mixdown ? { mixdown: o.mixdown } : {}),
		...(o.onlyTracks ? { onlyTracks: o.onlyTracks } : {}),
		...(sourceLevels || o.tap === 'track-inputs' ? { tap: 'track-inputs' as const } : {}),
		...(o.skipSilentStrips && o.onlyClips ? { audibleClips: o.onlyClips } : {}),
	});
	const channels = mixer.outputLayout === 'mono' ? 1 : mixer.outputLayout === '5.1' ? 6 : 2;
	const keep = !o.measureOnly;
	// a measure-only render with normalisation keeps its pass 1 while the delivery is solved
	const solveOnly = !keep && !!o.normalize;
	// the meter is needed for normalisation and for every kept file's report
	const meter =
		o.meter === false && !keep && !solveOnly
			? null
			: new LoudnessMeter(sr, channels, { weights: defaultChannelWeights(channels) });
	const pass1 =
		keep || solveOnly ? join(o.scratchDir, o.normalize ? 'mix-pass1.wav' : 'mix.wav') : null;
	const fh = pass1 ? await open(pass1, 'w') : null;
	// the content of the mix (the solved delivery is remembered by it: deliver.ts DELIVERY_CACHE)
	const hash = o.normalize ? createHash('sha256') : null;
	try {
		if (fh) await fh.write(wavHeaderF32(channels, sr, total));
		const block = Array.from({ length: channels }, () => new Float32Array(BLOCK));
		for (let done = 0; done < total; ) {
			if (o.signal?.aborted) throw new Error('aborted');
			const n = Math.min(BLOCK, total - done);
			const view = block.map((c) => c.subarray(0, n));
			await mixer.render(view, n);
			meter?.process(view, 0, n);
			o.onBlock?.(view, n);
			if (fh) {
				const bytes = interleave(view, n);
				hash?.update(bytes);
				await fh.write(bytes);
			}
			done += n;
			o.onProgress?.((done / total) * (o.normalize ? 0.6 : 1), 'Mixing audio');
		}
	} finally {
		mixer.close();
		await fh?.close();
	}
	meter?.flush();
	const before = meter ? meter.summary() : SILENT_SUMMARY;
	if (!o.normalize || !pass1) {
		return { path: pass1, sampleRate: sr, channels, samples: total, loudness: before };
	}
	const norm = o.normalize;
	const contentHash = hash?.digest('hex');
	if (solveOnly) {
		// the delivery as an export of this mix would solve it (PCM: no codec), measured, nothing written
		let outcome: DeliveryOutcome;
		try {
			outcome = await solveDelivery({
				ff: o.ff,
				pass1: { path: pass1, headerBytes: WAV_F32_HEADER_BYTES },
				sampleRate: sr,
				channels,
				total,
				before,
				targetLufs: norm.targetLufs,
				truePeakDb: norm.truePeakDb,
				codec: o.deliver ?? null,
				soxr,
				scratchDir: o.scratchDir,
				contentHash,
				signal: o.signal,
				...(o.onSpawn ? { onSpawn: o.onSpawn } : {}),
				onProgress: (f, stage) => o.onProgress?.(0.6 + f * 0.4, stage),
			});
		} finally {
			await rm(pass1, { force: true });
		}
		return {
			path: null,
			sampleRate: sr,
			channels,
			samples: total,
			loudness: outcome.pcm,
			normalized: {
				before,
				gainDb: outcome.params.gainDb,
				truePeakDb: norm.truePeakDb,
				targetLufs: norm.targetLufs,
				delivery: outcome,
				...(o.deliver ? { codec: o.deliver } : {}),
			},
		};
	}
	const out = join(o.scratchDir, 'mix.wav');
	// one delivery pass written to `out` (the float32 WAV every export path muxes) with its loudness
	const write = (params: DeliveryParams, path = out) =>
		writeDeliveryWav({ path: pass1, headerBytes: WAV_F32_HEADER_BYTES }, path, sr, channels, total, params, {
			blockSize: BLOCK,
			signal: o.signal,
			onProgress: (f) => o.onProgress?.(0.6 + f * 0.3, 'Normalizing loudness'),
		});
	let outcome: DeliveryOutcome;
	try {
		outcome = await solveDelivery({
			ff: o.ff,
			pass1: { path: pass1, headerBytes: WAV_F32_HEADER_BYTES },
			sampleRate: sr,
			channels,
			total,
			before,
			targetLufs: norm.targetLufs,
			truePeakDb: norm.truePeakDb,
			codec: o.deliver ?? null,
			soxr,
			scratchDir: o.scratchDir,
			write,
			outPath: out,
			contentHash,
			signal: o.signal,
			...(o.onSpawn ? { onSpawn: o.onSpawn } : {}),
			onProgress: (f, stage) => o.onProgress?.(0.9 + f * 0.1, stage),
		});
	} finally {
		await rm(pass1, { force: true });
	}
	return {
		path: out,
		sampleRate: sr,
		channels,
		samples: total,
		loudness: outcome.pcm,
		normalized: {
			before,
			gainDb: outcome.params.gainDb,
			truePeakDb: norm.truePeakDb,
			targetLufs: norm.targetLufs,
			delivery: outcome,
			...(o.deliver ? { codec: o.deliver } : {}),
		},
	};
}

/** Writes one delivery pass of `pass1` to `out` as a float32 WAV and returns its loudness (`deliver.ts`). */
export async function writeDeliveryWav(
	pass1: Pass1,
	out: string,
	sr: number,
	channels: number,
	total: number,
	params: DeliveryParams,
	opts: { blockSize?: number; signal?: AbortSignal | undefined; onProgress?(fraction: number): void } = {},
): Promise<LoudnessSummary> {
	const meter = new LoudnessMeter(sr, channels, { weights: defaultChannelWeights(channels) });
	const dst = await open(out, 'w');
	try {
		await dst.write(wavHeaderF32(channels, sr, total));
		await runDeliveryPass({
			pass1,
			sampleRate: sr,
			channels,
			total,
			params,
			blockSize: opts.blockSize ?? BLOCK,
			signal: opts.signal,
			...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
			sink: async (view, m) => {
				meter.process(view, 0, m);
				await dst.write(interleave(view, m));
			},
		});
	} finally {
		await dst.close();
	}
	meter.flush();
	return meter.summary();
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
