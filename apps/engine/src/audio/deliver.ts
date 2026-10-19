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
//    down by the measured overshoot + 0.3 dB and the audio is encoded again (≤ 6 encodes). The decoded loudness also
//    steers the PCM target (AAC at 128 kb/s measures ≈ 0.3–0.5 LU under its input).
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
	defaultChannelWeights,
	LoudnessMeter,
	type LoudnessSummary,
	TruePeakDetector,
	TruePeakLimiter,
} from '@jasper/audio-dsp';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { audioEncodeArgs } from '../tools/encoders.ts';
import { PcmStreamReader, resamplerArgs } from './decode.ts';

/** The deliverable's audio encoding (what the export's mux writes). */
export type DeliveryCodec = {
	/** ffmpeg audio encoder: `aac`, `libopus`, `pcm_s16le`, `pcm_s24le`. */
	codec: string;
	bitrateKbps: number;
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
	maxEncodePasses: 6,
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
} as const;

/**
 * Headroom (dB) between the delivery true-peak target and the limiter ceiling in front of the encoder, by codec and
 * bit rate per channel pair (the wp-note's table, with its sources). Lossless delivery: 0.
 */
export const CODEC_HEADROOM_TABLE: readonly {
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

export function isLossyCodec(codec: string): boolean {
	return !codec.startsWith('pcm_');
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
export type DeliverySink = (view: Float32Array[], frames: number, gainReductionDb: number) => void | Promise<void>;

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
			if (corr) for (const c of view) for (let i = 0; i < m; i++) c[i] = c[i]! * corr(written + i);
			await o.sink(view, m, gr);
			written += m;
		};
		for (let done = 0; done < total; ) {
			if (o.signal?.aborted) throw new Error('aborted');
			const n = Math.min(BLOCK, total - done);
			const { bytesRead } = await src.read(raw, 0, n * channels * 4, o.pass1.headerBytes + done * channels * 4);
			const got = Math.floor(bytesRead / (channels * 4));
			for (let i = 0; i < n; i++)
				for (let c = 0; c < channels; c++)
					block[c]![i] = i < got ? raw.readFloatLE((i * channels + c) * 4) * g : 0;
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
export function correctionGains(correctionDb: Float32Array, sampleRate: number): (sample: number) => number {
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
	const meter = new LoudnessMeter(sr, ch, { weights: defaultChannelWeights(ch) });
	const tp = new TruePeakDetector(sr, ch);
	const hop = Math.max(1, Math.round(sr * DELIVERY_LIMITS.hopSec));
	const hops: number[] = [];
	const block = Array.from({ length: ch }, () => new Float32Array(hop));
	let samples = 0;
	const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
	try {
		for (;;) {
			const n = await reader.read(block, hop);
			if (n <= 0) break;
			meter.process(block, 0, n);
			tp.process(block, 0, n);
			hops.push(20 * Math.log10(tp.takePeak()));
			samples += n;
			if (n < hop) break;
		}
	} finally {
		reader.close();
	}
	const code = await exited;
	if (code !== 0 && code !== null && samples === 0)
		throw new Error(`decoding the encoded audio failed: ${reader.errors.trim().slice(-500)}`);
	tp.flush();
	const tail = tp.takePeak();
	if (hops.length && tail > 0) hops[hops.length - 1] = Math.max(hops[hops.length - 1]!, 20 * Math.log10(tail));
	meter.flush();
	return { loudness: meter.summary(), hopTruePeakDb: Float32Array.from(hops), samples };
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
	const lossy = isLossyCodec(c.codec);
	return [
		'-i',
		o.input,
		'-map',
		'0:a:0',
		'-af',
		af.join(','),
		...audioEncodeArgs(c.codec, c.bitrateKbps, c.channels),
		'-ar',
		String(c.sampleRate),
		'-ac',
		String(c.channels),
		'-f',
		!lossy ? 'wav' : c.codec === 'libopus' ? 'webm' : 'mp4',
		o.output,
	];
}

/** What the delivery came to (the export result and Sound Check report it). */
export type DeliveryOutcome = {
	params: DeliveryParams;
	/** Loudness of the PCM out of the delivery chain with `params`. */
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
};

/**
 * Finds the delivery parameters of a normalised mix and (with `outPath`) writes the delivered PCM there as a float32
 * WAV. `write(params)` writes one pass to `outPath` (the caller's WAV writer, so the bytes are its own); passes in
 * between only measure. With `codec` lossy (or another rate) the written file is encoded and decoded to check it.
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
	/** Writes one delivery pass with `params` to `outPath` and returns its loudness. Absent: measure only. */
	write?: ((params: DeliveryParams) => Promise<LoudnessSummary>) | undefined;
	outPath?: string | undefined;
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
	let params: DeliveryParams = { gainDb: initialGainDb, ceilingDb: tpTarget - headroom, correction: null };
	let passes = 0;
	let encodePasses = 0;
	/** The parameters `outPath` was last written with (identity). */
	let writtenWith: DeliveryParams | null = null;

	const measure = async (p: DeliveryParams, write: boolean): Promise<LoudnessSummary> => {
		passes++;
		if (o.signal?.aborted) throw new Error('aborted');
		if (write && o.write) {
			const s = await o.write(p);
			writtenWith = p;
			return s;
		}
		const meter = new LoudnessMeter(sr, o.channels, { weights: defaultChannelWeights(o.channels) });
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
	};

	/** Loudness convergence at a ceiling / correction: the gain that lands `aim` (PCM), ≤ maxLoudnessPasses. */
	const converge = async (
		start: DeliveryParams,
		aim: number,
		writeFirst: boolean,
	): Promise<{ params: DeliveryParams; pcm: LoudnessSummary; limited: boolean }> => {
		let p = start;
		let s = await measure(p, writeFirst);
		if (!Number.isFinite(s.integrated) || !Number.isFinite(o.before.integrated))
			return { params: p, pcm: s, limited: false };
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
			o.onProgress?.(Math.min(0.95, k / L.maxLoudnessPasses), 'Matching loudness under the true-peak ceiling');
			s = await measure(p, false);
			if (Math.abs(aim - s.integrated) < Math.abs(aim - best.pcm.integrated)) best = { params: p, pcm: s };
		}
		if (!limited && Math.abs(aim - best.pcm.integrated) > 0.5) limited = aim > best.pcm.integrated;
		return { params: best.params, pcm: best.pcm, limited };
	};

	let aim = target;
	let r = await converge(params, aim, true);
	params = r.params;
	let decoded: LoudnessSummary | null = null;
	let truePeakMet = true;
	const raw = new Float32Array(hops);
	if (verify && o.codec && o.outPath && o.write) {
		const enc = join(o.scratchDir, `verify.${isLossyCodec(o.codec.codec) ? (o.codec.codec === 'libopus' ? 'webm' : 'm4a') : 'wav'}`);
		for (let e = 0; e < L.maxEncodePasses; e++) {
			if (writtenWith !== params) r = { ...r, pcm: await measure(params, true) };
			o.onProgress?.(0.96, 'Checking the encoded audio');
			await o.ff.run(
				['-y', ...verifyEncodeArgs({ input: o.outPath, output: enc, codec: o.codec, mixRate: sr, soxr: o.soxr })],
				{ ...(o.signal ? { signal: o.signal } : {}), ...(o.onSpawn ? { onSpawn: o.onSpawn } : {}) },
			);
			encodePasses++;
			const m = await measureEncodedAudio({
				ff: o.ff,
				file: enc,
				channels: o.codec.channels,
				sampleRate: o.codec.sampleRate,
				signal: o.signal,
				...(o.onSpawn ? { onSpawn: o.onSpawn } : {}),
			});
			decoded = m.loudness;
			const over = m.loudness.truePeakDb > tpTarget - L.truePeakMarginDb;
			const loudErr = Number.isFinite(m.loudness.integrated) ? target - m.loudness.integrated : 0;
			truePeakMet = !over;
			if (!over && (Math.abs(loudErr) <= L.decodedTolLu || r.limited)) break;
			if (e === L.maxEncodePasses - 1) break;
			if (over) {
				// the decoded hops over the target, mapped to the mix's hops by time
				// the decoded hops over the target (hops are 10 ms of time at either rate: same index in the mix)
				const aimTp = tpTarget - L.correctionMarginDb;
				for (let h = 0; h < Math.min(raw.length, m.hopTruePeakDb.length); h++) {
					const v = m.hopTruePeakDb[h]!;
					if (v > aimTp) raw[h] = Math.min(L.maxCorrectionDb, raw[h]! + (v - aimTp));
				}
			}
			if (Number.isFinite(m.loudness.integrated) && !r.limited)
				aim = Math.max(target - L.maxLoudnessOffsetLu, Math.min(target + L.maxLoudnessOffsetLu, aim + loudErr));
			const next: DeliveryParams = {
				...params,
				correction: raw.some((v) => v > 0) ? Float32Array.from(raw) : null,
			};
			r = await converge(next, aim, true);
			params = r.params;
		}
	} else if (o.write && writtenWith !== params) {
		r = { ...r, pcm: await measure(params, true) };
	}
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
	};
}
