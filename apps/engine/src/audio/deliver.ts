// Delivery of a loudness-normalised mix (S04:RN-032; wp-note sound-design "Fix: lossy-codec true-peak headroom and
// loudness convergence"). Shared by every export (`renderMixdown`) and Sound Check, so both deliver the same thing.
//
// 1. Loudness converges: the second pass applies a gain and the true-peak limiter; where the limiter pulls a loud mix
//    under the target, the gain is raised again (secant steps on the measured loudness, ≤ 8 passes, ±0.1 LU), as
//    earshot's `master.py` does (≤ 8 passes, ±0.5 LU). When more gain no longer makes the mix louder (the limiter takes
//    it all) or the push would pass +6 dB, it stops and says so (`ceilingLimited`).
// 2. Lossy codecs get headroom: the limiter's ceiling sits under the delivery target by a codec / bit-rate table
//    (`codecHeadroomDb`, sources in the wp-note: EBU Tech 3344 Annex A, AES TD1008 §4 / §7B, Spotify). Then the encoded
//    audio is decoded and measured: where its true peak still passes the target (the codec's overshoot is
//    content-dependent: measured 0.3 … 4 dB on loud material with ffmpeg's AAC), those 10 ms hops (±30 ms) are turned
//    down by 1.5 × the measured overshoot + 0.3 dB and the audio is encoded again (≤ 8 encodes); the encoder's rate
//    control moves its overshoot to other hits when anything changes, so an encode that finds new offenders also
//    lowers the whole ceiling by 0.25 dB. The best encode is delivered (the encoder is deterministic: the mux encodes
//    the same bits), and a miss is reported. The decoded loudness also steers the PCM target (AAC at 128 kb/s
//    measures ≈ 0.3–0.5 LU under its input).
// 3. Speed (wp-note "Fix: preview loudness parity, codec-aware Sound Check, delivery speed"): the PCM aim starts at the
//    codec's typical decoded loudness loss (`codecLoudnessLossLu`), so the first encode usually lands; the best encode
//    is kept (`DeliveryOutcome.encoded`) and the export muxes it by stream copy instead of encoding the WAV again; the
//    solved parameters are remembered by the content of the mix (`DELIVERY_CACHE`, keyed by a hash of the pass-1 samples
//    and the target / codec): a second delivery of the same mix (Sound Check before export, then the export; a
//    re-export) writes and encodes once, still checked on the decoded audio. Measure-only passes skip the true-peak
//    meter (only their integrated loudness is read).
import { open, rename, rm } from 'node:fs/promises';
import { endianness } from 'node:os';
import { join } from 'node:path';
import {
	defaultChannelWeights,
	LoudnessMeter,
	type LoudnessSummary,
	TruePeakDetector,
	TruePeakLimiter,
} from '@jasper/audio-dsp';
import { audioEncodeArgs } from '../tools/encoders.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { PcmStreamReader, resamplerArgs } from './decode.ts';

const LITTLE_ENDIAN = endianness() === 'LE';

/** The deliverable's audio encoding (what the export's mux writes). */
export type DeliveryCodec = {
	/** ffmpeg audio encoder: `aac`, `libopus`, `pcm_s16le`, `pcm_s24le`, `flac`. */
	codec: string;
	bitrateKbps: number;
	/** FLAC bits per sample (spec 18 AF-EXP-002; default 24). */
	bits?: 16 | 24;
	/** Delivered sample rate (the mix is resampled with the export's resampler when it differs). */
	sampleRate: number;
	channels: number;
};

export const DELIVERY_LIMITS = {
	/** The loudness passes aim at ±0.1 LU of the target… */
	loudnessTolLu: 0.1,
	/** …and the decoded file at ±0.2 LU (the requirement is ±0.5). */
	decodedTolLu: 0.2,
	maxLoudnessPasses: 8,
	maxEncodePasses: 8,
	/** Most extra gain pushed into the limiter over the plain normalisation gain (dB). */
	maxPushDb: 6,
	/** Under this many LU per dB of gain the limiter takes the push: the ceiling prevents the target. */
	minSlope: 0.1,
	/** The decoded true peak must be this far under the target (our meter vs ffmpeg's ebur128, 4× at 48 kHz). */
	truePeakMarginDb: 0.1,
	/** A local correction aims this far under the target. */
	correctionMarginDb: 0.3,
	/** Correction hops (seconds) and how many hops either side a correction covers (codec frames, pre-echo). */
	hopSec: 0.01,
	holdHops: 3,
	/** A correction never turns a hop down by more than this (dB). */
	maxCorrectionDb: 12,
	/** The PCM loudness target moves at most this far from the delivery target to land the decoded one. */
	maxLoudnessOffsetLu: 1.5,
	/** A correction turns an overshooting hop down by this times its overshoot (+ the margin). */
	overCorrection: 2,
	/** Each encode that finds new offenders lowers the whole ceiling by this much (dB)… */
	ceilingStepDb: 0.25,
	/** …to at most this far under the target. */
	maxCodecHeadroomDb: 4,
} as const;

/**
 * Lower limiter ceilings (dB under the round's own) encoded alongside each encode of the decoded check, each at its own
 * converged gain, on other cores (`parallel`): the codec's overshoot moves with every change, so how much headroom
 * suffices is not known in advance; with these the round usually ends with an encode that meets the target instead of
 * starting another one (measured on the loud fixture: ≈ 2× less wall time, wp-note). The gentlest that meets is
 * delivered (the round's own first, then 0.5 dB, then 1 dB lower). Skipped where the limiter is idle at that ceiling
 * (the audio would be the same).
 */
export const DELIVERY_CEILING_STEPS_DB: readonly number[] = [0.5, 1];

/**
 * Headroom (dB) between the delivery true-peak target and the limiter ceiling in front of the encoder, by codec and
 * bit rate per channel pair (the wp-note's table, with its sources). Lossless delivery: 0.
 */
const CODEC_HEADROOM_TABLE: readonly {
	codec: 'aac' | 'libopus';
	/** Bit rate per two channels at or above which the row applies (kb/s). */
	minKbps: number;
	headroomDb: number;
}[] = [
	{ codec: 'aac', minKbps: 256, headroomDb: 0.5 },
	{ codec: 'aac', minKbps: 160, headroomDb: 1 },
	{ codec: 'aac', minKbps: 96, headroomDb: 1.5 },
	{ codec: 'aac', minKbps: 0, headroomDb: 2 },
	{ codec: 'libopus', minKbps: 160, headroomDb: 0.5 },
	{ codec: 'libopus', minKbps: 96, headroomDb: 1 },
	{ codec: 'libopus', minKbps: 0, headroomDb: 2 },
];

/**
 * Typical loudness the decoded audio loses against the encoder's input (LU, measured with ffmpeg 7.1 on the loud and
 * typical fixtures: AAC 128 kb/s 0.35–0.47, 192 ≈ 0.2, 256–320 0.05–0.1, Opus 0.15–0.25; the wp-note). The PCM aim
 * starts this much over the target so the first encode usually lands within the decoded tolerance; the decoded
 * measurement corrects it either way.
 */
export function codecLoudnessLossLu(c: Pick<DeliveryCodec, 'codec' | 'bitrateKbps' | 'channels'>): number {
	if (!isLossyCodec(c.codec)) return 0;
	const k = kbpsPerPair(c);
	if (c.codec === 'libopus') return 0.2;
	return k >= 256 ? 0.1 : k >= 160 ? 0.2 : k >= 96 ? 0.4 : 0.5;
}

export function isLossyCodec(codec: string): boolean {
	return !codec.startsWith('pcm_') && codec !== 'flac';
}

/** The muxer and file extension of an encode of `codec` (the decoded check's encodes, as the deliverable holds it). */
export function deliveryContainerOf(codec: string): { format: string; ext: string } {
	if (codec === 'libopus') return { format: 'webm', ext: 'webm' };
	if (codec === 'flac') return { format: 'flac', ext: 'flac' };
	if (isLossyCodec(codec)) return { format: 'mp4', ext: 'm4a' };
	return { format: 'wav', ext: 'wav' };
}

/** Bit rate per channel pair (kb/s): the table's unit (5.1 at 384 kb/s ≈ stereo at 128). */
function kbpsPerPair(c: Pick<DeliveryCodec, 'bitrateKbps' | 'channels'>): number {
	return c.channels > 2 ? (c.bitrateKbps * 2) / c.channels : c.bitrateKbps;
}

/** The limiter's headroom under the delivery true-peak target for a codec (0 for PCM). */
export function codecHeadroomDb(c: Pick<DeliveryCodec, 'codec' | 'bitrateKbps' | 'channels'>): number {
	if (!isLossyCodec(c.codec)) return 0;
	const family = c.codec === 'libopus' ? 'libopus' : 'aac';
	const k = kbpsPerPair(c);
	const row = CODEC_HEADROOM_TABLE.find((r) => r.codec === family && k >= r.minKbps);
	return row?.headroomDb ?? 2;
}

/** Whether the delivered audio differs from the PCM mix (lossy codec or another sample rate): it is then verified. */
export function needsDecodedCheck(c: DeliveryCodec | null, mixRate: number): boolean {
	return !!c && (isLossyCodec(c.codec) || c.sampleRate !== mixRate);
}

/** Gain, limiter ceiling and local corrections of the delivery pass. */
export type DeliveryParams = {
	gainDb: number;
	ceilingDb: number;
	/** Per hop (`DELIVERY_LIMITS.hopSec`, from the first sample): extra attenuation in dB (≥ 0), or null. */
	correction: Float32Array | null;
};

/** The pass-1 mix as interleaved float32 (a WAV with its header, or raw). */
export type Pass1 = { path: string; headerBytes: number };

/** What a delivery pass gives its sink per block: the output (planar view), its length, the limiter's reduction. */
export type DeliverySink = (
	view: Float32Array[],
	frames: number,
	gainReductionDb: number,
) => void | Promise<void>;

/**
 * Streams the pass-1 mix through the delivery chain: gain, the true-peak limiter (5 ms look-ahead, 100 ms release),
 * then the local corrections. Output is aligned with the input (the limiter's latency removed), `total` samples.
 */
export async function runDeliveryPass(o: {
	pass1: Pass1;
	sampleRate: number;
	channels: number;
	total: number;
	params: DeliveryParams;
	sink: DeliverySink;
	blockSize?: number;
	signal?: AbortSignal | undefined;
	onProgress?(fraction: number): void;
}): Promise<void> {
	const { sampleRate: sr, channels, total } = o;
	const BLOCK = o.blockSize ?? 48_000;
	const g = 10 ** (o.params.gainDb / 20);
	const limiter = new TruePeakLimiter(sr, channels, {
		ceilingDb: o.params.ceilingDb,
		lookaheadMs: 5,
		releaseMs: 100,
	});
	const corr = o.params.correction ? correctionGains(o.params.correction, sr) : null;
	const src = await open(o.pass1.path, 'r');
	try {
		let skip = limiter.latency;
		let written = 0;
		const raw = Buffer.alloc(BLOCK * channels * 4);
		// little-endian hosts read the float32 samples through a typed view (the WAV's byte order), else per sample
		const f32 =
			LITTLE_ENDIAN && raw.byteOffset % 4 === 0
				? new Float32Array(raw.buffer, raw.byteOffset, BLOCK * channels)
				: null;
		const block = Array.from({ length: channels }, () => new Float32Array(BLOCK));
		const emit = async (n: number) => {
			limiter.process(block, 0, n);
			const gr = -limiter.gainReductionDb();
			let from = 0;
			if (skip > 0) {
				from = Math.min(n, skip);
				skip -= from;
			}
			const m = Math.min(n - from, total - written);
			if (m <= 0) return;
			const view = block.map((c) => c.subarray(from, from + m));
			if (corr)
				for (let i = 0; i < m; i++) {
					const k = corr(written + i);
					if (k !== 1) for (const c of view) c[i] = c[i]! * k;
				}
			await o.sink(view, m, gr);
			written += m;
		};
		for (let done = 0; done < total; ) {
			if (o.signal?.aborted) throw new Error('aborted');
			const n = Math.min(BLOCK, total - done);
			const { bytesRead } = await src.read(
				raw,
				0,
				n * channels * 4,
				o.pass1.headerBytes + done * channels * 4,
			);
			const got = Math.min(n, Math.floor(bytesRead / (channels * 4)));
			for (let c = 0; c < channels; c++) {
				const b = block[c]!;
				if (f32) for (let i = 0; i < got; i++) b[i] = f32[i * channels + c]! * g;
				else for (let i = 0; i < got; i++) b[i] = raw.readFloatLE((i * channels + c) * 4) * g;
				b.fill(0, got, n);
			}
			await emit(n);
			done += n;
			o.onProgress?.(done / total);
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
	}
}

/**
 * The per-sample gain of a correction: each hop's attenuation held over ±`holdHops`, interpolated linearly between hop
 * starts (10 ms ramps: no click; the hold keeps the corrected hop itself fully down), as `sample → linear gain ≤ 1`.
 */
function correctionGains(correctionDb: Float32Array, sampleRate: number): (sample: number) => number {
	const held = holdMax(correctionDb, DELIVERY_LIMITS.holdHops);
	const lin = Float32Array.from(held, (d) => 10 ** (-d / 20));
	const hop = sampleRate * DELIVERY_LIMITS.hopSec;
	return (s) => {
		const x = s / hop;
		const h = Math.floor(x);
		if (h >= lin.length - 1) return lin.length ? lin[lin.length - 1]! : 1;
		if (h < 0) return lin[0] ?? 1;
		const a = lin[h]!;
		return a + (lin[h + 1]! - a) * (x - h);
	};
}

function holdMax(x: Float32Array, r: number): Float32Array {
	const out = new Float32Array(x.length);
	for (let i = 0; i < x.length; i++) {
		if (x[i]! <= 0) continue;
		const a = Math.max(0, i - r);
		const b = Math.min(x.length - 1, i + r);
		for (let j = a; j <= b; j++) if (x[i]! > out[j]!) out[j] = x[i]!;
	}
	return out;
}

/** The loudness and per-hop true peak of an encoded file's first audio stream, decoded by ffmpeg. */
export async function measureEncodedAudio(o: {
	ff: Ffmpeg;
	file: string;
	channels: number;
	sampleRate: number;
	signal?: AbortSignal | undefined;
	onSpawn?(child: import('node:child_process').ChildProcess): void;
}): Promise<{ loudness: LoudnessSummary; hopTruePeakDb: Float32Array; samples: number }> {
	const ch = o.channels;
	const sr = o.sampleRate;
	const child = o.ff.spawnRaw(
		['-i', o.file, '-map', '0:a:0', '-f', 'f32le', '-ac', String(ch), '-ar', String(sr), 'pipe:1'],
		{ ...(o.signal ? { signal: o.signal } : {}), ...(o.onSpawn ? { onSpawn: o.onSpawn } : {}) },
	);
	const reader = new PcmStreamReader(ch, child);
	// the loudness meter without its own true peak: the per-hop detector below measures it (once, not twice)
	const meter = new LoudnessMeter(sr, ch, { weights: defaultChannelWeights(ch), truePeak: false });
	const tp = new TruePeakDetector(sr, ch);
	const hop = Math.max(1, Math.round(sr * DELIVERY_LIMITS.hopSec));
	const hops: number[] = [];
	// read 100 hops at a time; the hops are cut out of each block
	const blockLen = hop * 100;
	const block = Array.from({ length: ch }, () => new Float32Array(blockLen));
	let samples = 0;
	let max = 0;
	const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
	try {
		for (;;) {
			const n = await reader.read(block, blockLen);
			if (n <= 0) break;
			meter.process(block, 0, n);
			for (let at = 0; at < n; at += hop) {
				tp.process(block, at, Math.min(hop, n - at));
				const pk = tp.takePeak();
				if (pk > max) max = pk;
				hops.push(20 * Math.log10(pk));
			}
			samples += n;
			if (n < blockLen) break;
		}
	} finally {
		reader.close();
	}
	const code = await exited;
	if (code !== 0 && code !== null && samples === 0)
		throw new Error(`decoding the encoded audio failed: ${reader.errors.trim().slice(-500)}`);
	tp.flush();
	const tail = tp.takePeak();
	if (tail > max) max = tail;
	if (hops.length && tail > 0)
		hops[hops.length - 1] = Math.max(hops[hops.length - 1]!, 20 * Math.log10(tail));
	meter.flush();
	return {
		loudness: { ...meter.summary(), truePeakDb: 20 * Math.log10(max) },
		hopTruePeakDb: Float32Array.from(hops),
		samples,
	};
}

/** ffmpeg arguments that encode a mix WAV exactly as the export's mux does (codec, rate, channels, resampler). */
export function verifyEncodeArgs(o: {
	input: string;
	output: string;
	codec: DeliveryCodec;
	mixRate: number;
	soxr: boolean;
}): string[] {
	const c = o.codec;
	const layout = c.channels === 1 ? 'mono' : c.channels === 6 ? '5.1' : 'stereo';
	const af = [
		...(c.sampleRate !== o.mixRate ? [`aresample=${c.sampleRate}:${resamplerArgs(o.soxr)}`] : []),
		`aformat=sample_fmts=fltp:channel_layouts=${layout}`,
	];
	return [
		'-i',
		o.input,
		'-map',
		'0:a:0',
		'-af',
		af.join(','),
		...audioEncodeArgs(c.codec, c.bitrateKbps, c.channels, c.bits),
		'-ar',
		String(c.sampleRate),
		'-ac',
		String(c.channels),
		'-f',
		deliveryContainerOf(c.codec).format,
		o.output,
	];
}

/** What the delivery came to (the export result and Sound Check report it). */
export type DeliveryOutcome = {
	params: DeliveryParams;
	/** Loudness of the PCM out of the delivery chain with `params` (with `write`, of the written file). */
	pcm: LoudnessSummary;
	/** The plain normalisation gain (target − measured) before convergence. */
	initialGainDb: number;
	/** The table's headroom for the codec (the limiter starts at target − this). */
	codecHeadroomDb: number;
	/** Delivery passes run (each a limiter pass over the mix) and encodes for the decoded check. */
	passes: number;
	encodePasses: number;
	/** The limiter took the push: the target cannot be reached under the ceiling (loudness ±0.5 LU not met). */
	ceilingLimited: boolean;
	/** The decoded deliverable (lossy / resampled): its loudness, and whether its true peak meets the target. */
	decoded: LoudnessSummary | null;
	truePeakMet: boolean;
	corrections: { hops: number; maxDb: number };
	/** `outPath` holds the pass with `params`. */
	written: boolean;
	/**
	 * The encode of `outPath` the decoded check measured (`decoded`), a file in `scratchDir`: the export muxes it by
	 * stream copy (the delivered bits are the checked bits). Null without a decoded check.
	 */
	encoded: string | null;
	/** The parameters came from `DELIVERY_CACHE` (an earlier delivery of the same mix to the same target and codec). */
	cached: boolean;
	/** Wall time of this delivery's limiter passes, encodes and decodes (ms; for logs and benchmarks). */
	timings: { passesMs: number; encodeMs: number; decodeMs: number };
};

/** A loudness convergence: the parameters, the PCM loudness, whether the ceiling took the push, its passes. */
type Converged = {
	params: DeliveryParams;
	pcm: LoudnessSummary;
	limited: boolean;
	/** Gain and integrated loudness of each pass at these parameters' ceiling and correction. */
	points: { g: number; i: number }[];
};

/** A solved delivery remembered by `DELIVERY_CACHE`. */
type CachedDelivery = { params: DeliveryParams; aim: number; limited: boolean };

/**
 * Solved delivery parameters by mix content (a hash of the pass-1 samples), length, target, ceiling and codec: least
 * recently used first out, at most `DELIVERY_CACHE_SIZE` entries in this engine process. A hit still writes and (lossy)
 * encodes and checks the decoded audio; only the search is skipped.
 */
const DELIVERY_CACHE = new Map<string, CachedDelivery>();
const DELIVERY_CACHE_SIZE = 32;

function deliveryCacheKey(o: {
	contentHash: string;
	sampleRate: number;
	channels: number;
	total: number;
	targetLufs: number;
	truePeakDb: number;
	codec: DeliveryCodec | null;
	soxr: boolean;
}): string {
	const c = o.codec;
	return [
		o.contentHash,
		o.sampleRate,
		o.channels,
		o.total,
		o.targetLufs,
		o.truePeakDb,
		c ? `${c.codec}/${c.bitrateKbps}/${c.sampleRate}/${c.channels}${c.bits ? `/${c.bits}` : ''}` : 'none',
		o.soxr ? 'soxr' : 'swr',
	].join('|');
}

function cacheGet(key: string): CachedDelivery | undefined {
	const v = DELIVERY_CACHE.get(key);
	if (v) {
		DELIVERY_CACHE.delete(key);
		DELIVERY_CACHE.set(key, v);
	}
	return v;
}

function cacheSet(key: string, v: CachedDelivery): void {
	DELIVERY_CACHE.delete(key);
	DELIVERY_CACHE.set(key, v);
	while (DELIVERY_CACHE.size > DELIVERY_CACHE_SIZE) {
		const first = DELIVERY_CACHE.keys().next().value;
		if (first === undefined) break;
		DELIVERY_CACHE.delete(first);
	}
}

const copyParams = (p: DeliveryParams): DeliveryParams => ({
	gainDb: p.gainDb,
	ceilingDb: p.ceilingDb,
	correction: p.correction ? Float32Array.from(p.correction) : null,
});

/**
 * Finds the delivery parameters of a normalised mix and (with `outPath`) writes the delivered PCM there as a float32
 * WAV. `write(params)` writes one pass to `outPath` (the caller's WAV writer, so the bytes are its own); passes in
 * between only measure. With `codec` lossy (or another rate) the written file is encoded and decoded to check it.
 * `contentHash` (a hash of the pass-1 samples) lets a later delivery of the same mix start from these parameters.
 */
export async function solveDelivery(o: {
	ff: Ffmpeg;
	pass1: Pass1;
	sampleRate: number;
	channels: number;
	total: number;
	before: LoudnessSummary;
	targetLufs: number;
	truePeakDb: number;
	codec: DeliveryCodec | null;
	soxr: boolean;
	scratchDir: string;
	/**
	 * Writes one delivery pass with `params` to `path` (default `outPath`; other paths: candidates the decoded check
	 * encodes alongside) and returns its loudness. Absent: measure only.
	 */
	write?: ((params: DeliveryParams, path?: string) => Promise<LoudnessSummary>) | undefined;
	outPath?: string | undefined;
	/** A hash of the pass-1 samples: the solved parameters are remembered (`DELIVERY_CACHE`) under it. */
	contentHash?: string | undefined;
	/** Encodes of the decoded check run at once (the round's own + lower-ceiling alternatives; default 3, min 1). */
	parallel?: number | undefined;
	signal?: AbortSignal | undefined;
	onSpawn?(child: import('node:child_process').ChildProcess): void;
	onProgress?(fraction: number, stage: string): void;
}): Promise<DeliveryOutcome> {
	const L = DELIVERY_LIMITS;
	const sr = o.sampleRate;
	const target = o.targetLufs;
	const tpTarget = o.truePeakDb;
	const verify = needsDecodedCheck(o.codec, sr);
	const headroom = o.codec ? codecHeadroomDb(o.codec) : 0;
	const initialGainDb = Number.isFinite(o.before.integrated) ? target - o.before.integrated : 0;
	const hops = Math.ceil(o.total / (sr * L.hopSec)) + 1;
	const timings = { passesMs: 0, encodeMs: 0, decodeMs: 0 };
	const parallel = Math.max(1, Math.floor(o.parallel ?? 3));
	const key = o.contentHash
		? deliveryCacheKey({
				contentHash: o.contentHash,
				sampleRate: sr,
				channels: o.channels,
				total: o.total,
				targetLufs: target,
				truePeakDb: tpTarget,
				codec: o.codec,
				soxr: o.soxr,
			})
		: null;
	const hit = key ? cacheGet(key) : undefined;
	let params: DeliveryParams = { gainDb: initialGainDb, ceilingDb: tpTarget - headroom, correction: null };
	let passes = 0;
	let encodePasses = 0;
	/** The parameters `outPath` was last written with (identity). */
	let writtenWith: DeliveryParams | null = null;

	const measure = async (p: DeliveryParams, write: boolean, path?: string): Promise<LoudnessSummary> => {
		passes++;
		if (o.signal?.aborted) throw new Error('aborted');
		const t0 = performance.now();
		try {
			if (write && o.write) {
				const s = await o.write(p, path ?? o.outPath);
				if (!path || path === o.outPath) writtenWith = p;
				return s;
			}
			// with a writer only the integrated loudness of a measuring pass is read (the written pass reports the true
			// peak): no true-peak meter; measure-only deliveries report the true peak of their passes
			const meter = new LoudnessMeter(sr, o.channels, {
				weights: defaultChannelWeights(o.channels),
				truePeak: !o.write,
			});
			await runDeliveryPass({
				pass1: o.pass1,
				sampleRate: sr,
				channels: o.channels,
				total: o.total,
				params: p,
				signal: o.signal,
				sink: (view, m) => meter.process(view, 0, m),
			});
			meter.flush();
			return meter.summary();
		} finally {
			timings.passesMs += performance.now() - t0;
		}
	};

	/** Loudness convergence at a ceiling / correction: the gain that lands `aim` (PCM), ≤ maxLoudnessPasses. */
	const converge = async (start: DeliveryParams, aim: number, writeFirst: boolean): Promise<Converged> => {
		let p = start;
		let s = await measure(p, writeFirst);
		const points: { g: number; i: number }[] = [];
		if (!Number.isFinite(s.integrated) || !Number.isFinite(o.before.integrated))
			return { params: p, pcm: s, limited: false, points };
		points.push({ g: p.gainDb, i: s.integrated });
		let best = { params: p, pcm: s };
		let prev: { g: number; i: number } | null = null;
		let limited = false;
		for (let k = 1; k < L.maxLoudnessPasses; k++) {
			const err = aim - s.integrated;
			if (Math.abs(err) <= L.loudnessTolLu) break;
			let step: number;
			if (err < 0) step = err;
			else {
				let slope = 1;
				if (prev && Math.abs(p.gainDb - prev.g) > 1e-6) slope = (s.integrated - prev.i) / (p.gainDb - prev.g);
				if (prev && slope < L.minSlope) {
					limited = true;
					break;
				}
				slope = Math.min(1, Math.max(L.minSlope, slope));
				step = err / slope;
				const room = initialGainDb + L.maxPushDb - p.gainDb;
				if (step > room) step = room;
				if (step <= 0.01) {
					limited = true;
					break;
				}
			}
			prev = { g: p.gainDb, i: s.integrated };
			p = { ...p, gainDb: p.gainDb + step };
			o.onProgress?.(
				Math.min(0.95, k / L.maxLoudnessPasses),
				'Matching loudness under the true-peak ceiling',
			);
			// with a writer every pass is written: the pass that lands is then already the delivered file (no pass again)
			s = await measure(p, writeFirst);
			if (Number.isFinite(s.integrated)) points.push({ g: p.gainDb, i: s.integrated });
			if (Math.abs(aim - s.integrated) < Math.abs(aim - best.pcm.integrated)) best = { params: p, pcm: s };
		}
		if (!limited && Math.abs(aim - best.pcm.integrated) > 0.5) limited = aim > best.pcm.integrated;
		return { params: best.params, pcm: best.pcm, limited, points };
	};

	/**
	 * The gain that lands `aim` at a lower ceiling `ceil`, from the loudness measured at the base ceiling (`points`): the
	 * limiter is scale-invariant (limiting `g·x` at `c` is `c` × limiting `(g − c)·x` at 0 dBFS, corrections included),
	 * so every pass is a point on one curve F(push = g − c) = I − c, and the gain at `ceil` follows from F by secant
	 * inter/extrapolation (slope 1 with one point).
	 */
	const gainAtCeiling = (pts: readonly { p: number; f: number }[], ceil: number, aimAt: number): number => {
		const want = aimAt - ceil;
		const sorted = [...pts].sort((a, b) => Math.abs(a.f - want) - Math.abs(b.f - want));
		const a = sorted[0]!;
		const b = sorted.find((x) => Math.abs(x.p - a.p) > 1e-6);
		let slope = b ? (a.f - b.f) / (a.p - b.p) : 1;
		if (!Number.isFinite(slope)) slope = 1;
		slope = Math.min(1, Math.max(L.minSlope, slope));
		const push = Math.min(initialGainDb + L.maxPushDb - ceil, a.p + (want - a.f) / slope);
		return push + ceil;
	};

	const clampAim = (a: number) =>
		Math.max(target - L.maxLoudnessOffsetLu, Math.min(target + L.maxLoudnessOffsetLu, a));
	// a lossy codec decodes a little quieter than its input: the PCM aim starts over the target by its typical loss
	let aim = clampAim(target + (verify && o.codec ? codecLoudnessLossLu(o.codec) : 0));
	let r: Converged;
	if (hit) {
		// the same mix delivered before to this target and codec: start from its parameters (one pass)
		params = copyParams(hit.params);
		aim = hit.aim;
		r = { params, pcm: await measure(params, true), limited: hit.limited, points: [] };
	} else {
		r = await converge(params, aim, true);
		params = r.params;
	}
	let decoded: LoudnessSummary | null = null;
	let truePeakMet = true;
	let encoded: string | null = null;
	let solvedAim = aim;
	if (verify && o.codec && o.outPath && o.write) {
		const codec = o.codec;
		const outPath = o.outPath;
		const ext = deliveryContainerOf(codec.codec).ext;
		/** One encode of the decoded check: its parameters, the WAV it encodes and the encoded file. */
		type Cand = {
			params: DeliveryParams;
			r: typeof r;
			raw: Float32Array;
			ceiling: number;
			aim: number;
			wav: string;
			file: string;
			ac: AbortController;
			done: Promise<boolean>;
			/** The decoded check of this encode (once measured). */
			decoded?: LoudnessSummary;
			score?: [number, number];
		};
		/** The best encode so far: true peak met first, then the smallest overshoot, then the loudness error. */
		let best: Cand | null = null;
		const keep = new Set<string>();
		const made: string[] = [];
		const start = (c: Omit<Cand, 'ac' | 'done' | 'file'>, tag: string): Cand => {
			const file = join(o.scratchDir, `verify-${tag}.${ext}`);
			made.push(file);
			const ac = new AbortController();
			const stop = () => ac.abort();
			o.signal?.addEventListener('abort', stop, { once: true });
			const t0 = performance.now();
			encodePasses++;
			const done = o.ff
				.run(['-y', ...verifyEncodeArgs({ input: c.wav, output: file, codec, mixRate: sr, soxr: o.soxr })], {
					signal: ac.signal,
					...(o.onSpawn ? { onSpawn: o.onSpawn } : {}),
				})
				.then(
					() => {
						timings.encodeMs += performance.now() - t0;
						return true;
					},
					(e) => {
						if (ac.signal.aborted && !o.signal?.aborted) return false;
						throw e;
					},
				)
				.finally(() => o.signal?.removeEventListener('abort', stop));
			// a failed encode is reported where it is awaited; until then it must not count as unhandled (the next
			// candidates are converged while it runs)
			done.catch(() => {});
			return { ...c, file, ac, done };
		};
		/** Corrections of `raw` from a decoded hop map at a margin and over-correction (a copy). */
		const corrected = (
			raw: Float32Array,
			hopDb: Float32Array,
			margin: number,
			over: number,
		): { raw: Float32Array; fresh: boolean } => {
			const out = Float32Array.from(raw);
			const aimTp = tpTarget - margin;
			let fresh = false;
			for (let h = 0; h < Math.min(out.length, hopDb.length); h++) {
				const v = hopDb[h]!;
				if (!(v > aimTp)) continue;
				if (out[h] === 0 && v > tpTarget) fresh = true;
				out[h] = Math.min(L.maxCorrectionDb, out[h]! + over * (v - aimTp));
			}
			return { raw: out, fresh };
		};
		const withCorrection = (p: DeliveryParams, raw: Float32Array, ceiling: number): DeliveryParams => ({
			...p,
			ceilingDb: ceiling,
			correction: raw.some((v) => v > 0) ? Float32Array.from(raw) : null,
		});
		const raw0 = new Float32Array(hops);
		if (params.correction) raw0.set(params.correction.subarray(0, raw0.length));
		if (writtenWith !== params) r = { ...r, pcm: await measure(params, true) };
		o.onProgress?.(0.96, 'Checking the encoded audio');
		/**
		 * The round's lower-ceiling alternatives (`DELIVERY_CEILING_STEPS_DB`, at most `parallel` − 1), converged and
		 * written while the round's first encode runs. None where the limiter is idle at the lower ceiling.
		 */
		const alternatives = async (
			base: typeof r,
			raw: Float32Array,
			ceiling: number,
			aimAt: number,
			tag: string,
		): Promise<Cand[]> => {
			const out: Cand[] = [];
			// the base's passes as points on the scale-free loudness curve (see gainAtCeiling)
			const pts = base.points.map((x) => ({ p: x.g - ceiling, f: x.i - ceiling }));
			if (Number.isFinite(base.pcm.integrated))
				pts.push({ p: base.params.gainDb - ceiling, f: base.pcm.integrated - ceiling });
			if (!pts.length) return out;
			for (const [n, step] of DELIVERY_CEILING_STEPS_DB.entries()) {
				if (out.length + 1 >= parallel || encodePasses >= L.maxEncodePasses) break;
				const ceil = Math.max(tpTarget - L.maxCodecHeadroomDb, ceiling - step);
				if (!(ceil < ceiling) || !(base.pcm.truePeakDb > ceil + 0.01)) continue;
				const wav = `${outPath}.alt-${tag}-${n}.wav`;
				made.push(wav);
				// one written pass at the predicted gain; a second (secant on the curve) when it misses the aim
				let p = withCorrection({ ...base.params, gainDb: gainAtCeiling(pts, ceil, aimAt) }, raw, ceil);
				let pcm = await measure(p, true, wav);
				if (Number.isFinite(pcm.integrated)) {
					pts.push({ p: p.gainDb - ceil, f: pcm.integrated - ceil });
					if (Math.abs(aimAt - pcm.integrated) > L.loudnessTolLu) {
						p = { ...p, gainDb: gainAtCeiling(pts, ceil, aimAt) };
						pcm = await measure(p, true, wav);
						if (Number.isFinite(pcm.integrated)) pts.push({ p: p.gainDb - ceil, f: pcm.integrated - ceil });
					}
				}
				out.push(
					start(
						{
							params: p,
							r: { params: p, pcm, limited: base.limited, points: [] },
							raw,
							ceiling: ceil,
							aim: aimAt,
							wav,
						},
						`${tag}${'bcd'[n]}`,
					),
				);
			}
			return out;
		};
		let round: Cand[] = [start({ params, r, raw: raw0, ceiling: params.ceilingDb, aim, wav: outPath }, '0')];
		// a cached delivery met the target before: no alternatives
		if (!hit) for (const c of await alternatives(r, raw0, params.ceilingDb, aim, '0')) round.push(c);
		let met: Cand | null = null;
		try {
			for (let k = 0; ; k++) {
				// the candidates in order of preference (the gentlest correction first): the first that meets the target is
				// delivered and the others stop
				let roundBest: { c: Cand; hopDb: Float32Array; loudErr: number; score: [number, number] } | null =
					null;
				for (const [i, c] of round.entries()) {
					if (!(await c.done)) continue;
					const t0 = performance.now();
					const m = await measureEncodedAudio({
						ff: o.ff,
						file: c.file,
						channels: codec.channels,
						sampleRate: codec.sampleRate,
						signal: o.signal,
						...(o.onSpawn ? { onSpawn: o.onSpawn } : {}),
					});
					timings.decodeMs += performance.now() - t0;
					const excess = Math.max(0, m.loudness.truePeakDb - (tpTarget - L.truePeakMarginDb));
					const loudErr = Number.isFinite(m.loudness.integrated) ? target - m.loudness.integrated : 0;
					const score: [number, number] = [excess, Math.abs(loudErr)];
					c.decoded = m.loudness;
					c.score = score;
					const better = (a: [number, number], b: [number, number] | undefined) =>
						!b || a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
					if (better(score, (best as Cand | null)?.score)) best = c;
					if (better(score, roundBest?.score)) roundBest = { c, hopDb: m.hopTruePeakDb, loudErr, score };
					if (excess === 0 && (Math.abs(loudErr) <= L.decodedTolLu || c.r.limited)) {
						met = c;
						for (const later of round.slice(i + 1)) later.ac.abort();
						await Promise.allSettled(round.slice(i + 1).map((x) => x.done));
						break;
					}
				}
				if (met || !roundBest || encodePasses >= L.maxEncodePasses) break;
				// the next round from the best encode of this one: its decoded hops over the target (10 ms of time at either
				// rate: the same index in the mix) turned down by their overshoot + the margin, over-corrected (the encoder's
				// rate control moves with every change, so a hit corrected exactly tends to come back a little over)
				const from = roundBest.c;
				const excess = roundBest.score[0];
				let ceiling = from.ceiling;
				let raw = from.raw;
				if (excess > 0) {
					const c1 = corrected(from.raw, roundBest.hopDb, L.correctionMarginDb, L.overCorrection);
					raw = c1.raw;
					// offenders the last corrections did not know: the codec moves its overshoot around (bit reservoir, rate
					// control), so the whole mix also gets a little more headroom
					if (c1.fresh && k > 0)
						ceiling = Math.max(tpTarget - L.maxCodecHeadroomDb, ceiling - L.ceilingStepDb);
				}
				let nextAim = from.aim;
				if (!from.r.limited) nextAim = clampAim(from.aim + roundBest.loudErr);
				let rc = await converge(withCorrection(from.params, raw, ceiling), nextAim, true);
				// `outPath` holds the converged pass (the encode reads it)
				if (writtenWith !== rc.params) rc = { ...rc, pcm: await measure(rc.params, true) };
				const next: Cand[] = [
					start({ params: rc.params, r: rc, raw, ceiling, aim: nextAim, wav: outPath }, `${k + 1}a`),
				];
				for (const c of await alternatives(rc, raw, ceiling, nextAim, `${k + 1}`)) next.push(c);
				round = next;
			}
		} finally {
			for (const c of round) c.ac.abort();
			await Promise.allSettled(round.map((c) => c.done));
		}
		// deliver the encode that met the target, else the best one, as it is (the export copies it); its WAV becomes
		// `outPath` (written again only when a later pass overwrote it)
		const pick = (met as Cand | null) ?? (best as Cand | null);
		if (pick?.decoded && pick.score) {
			params = pick.params;
			r = pick.r;
			decoded = pick.decoded;
			truePeakMet = pick.score[0] === 0;
			encoded = pick.file;
			solvedAim = pick.aim;
			keep.add(pick.file);
			if (pick.wav !== outPath) {
				await rename(pick.wav, outPath);
				writtenWith = params;
			} else if (writtenWith !== params) await measure(params, true);
		}
		for (const f of made) if (!keep.has(f)) await rm(f, { force: true });
	} else if (o.write && writtenWith !== params) {
		r = { ...r, pcm: await measure(params, true) };
	}
	if (key) cacheSet(key, { params: copyParams(params), aim: solvedAim, limited: r.limited });
	let corrHops = 0;
	let corrMax = 0;
	for (const v of params.correction ?? []) {
		if (v > 0) corrHops++;
		if (v > corrMax) corrMax = v;
	}
	return {
		params,
		pcm: r.pcm,
		initialGainDb,
		codecHeadroomDb: headroom,
		passes,
		encodePasses,
		ceilingLimited: r.limited,
		decoded,
		truePeakMet,
		corrections: { hops: corrHops, maxDb: corrMax },
		written: !!o.write && writtenWith === params,
		encoded,
		cached: !!hit,
		timings,
	};
}
