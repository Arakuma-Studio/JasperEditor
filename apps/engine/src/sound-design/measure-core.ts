// The CPU-heavy part of the sound-design measurements (bed.ts; wp-note WP6.5b item 7): rendering a sound alone or a
// bed cluster through the export's offline mixer (clip decoders, effects, strips, master) and the analyses of the
// result (active window, octave bands, short-term peak, the bed's local peak). Pure apart from its inputs and the
// ffmpeg decoders it spawns, so it runs the same on the engine's main thread (the fallback) and on a worker thread
// (`measure-worker.ts`, managed by `measure-pool.ts`): same code, same float operations, bit-identical results.
// Requests are plain data (structured-cloneable): the render snapshot, the media it plays as files, frame ranges.
// An export's audio uses the same threads (wp-note export-performance §8): its pass-1 mix (`mixPass1`), the delivery's
// passes (`deliveryPass`) and decoded checks (`encodedMeasure`).
import { tmpdir } from 'node:os';
import type { Layout, LoudnessSummary } from '@jasper/audio-dsp';
import {
	bandLevels,
	bedLocalPeakLu,
	energyProfile,
	peakProfile,
	shortTermPeakLu,
	type TimeWindow,
} from '@jasper/audio-fx';
import { frameToSample, type Rational, type RenderSnapshot } from '@jasper/project';
import { type DeliveryPassRequest, type EncodedMeasure, measureEncodedAudio } from '../audio/deliver.ts';
import {
	type MixPass1,
	type MixSource,
	renderMixdown,
	renderPass1,
	runDeliveryPassRequest,
} from '../audio/mixdown.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';

/** The active window: 10 ms frames within this many dB of the loudest frame. */
export const ACTIVE_RANGE_DB = 30;
/** Shortest active window (seconds). */
export const MIN_WINDOW_SEC = 0.05;
/** Longest measured window (seconds from the active start): long beds are measured on their first 20 s. */
export const MAX_WINDOW_SEC = 20;
/** Silence: the loudest 10 ms frame is under this (dBFS). */
const SILENCE_DBFS = -100;

export type Weight = 'hero' | 'support' | 'ambient';
export type Pcm = { startSample: number; channels: Float32Array[] };

/** A render: `range` (frames) of `snapshot` with only `clipIds` audible (master output, no loudness normalisation). */
export type RenderRequest = {
	snapshot: RenderSnapshot;
	/** The media the snapshot's clips play, as local files (absent: offline, silent). */
	media: Record<string, MixSource>;
	range: { start: number; end: number };
	clipIds: string[];
	/** That clip at 0 dB clip gain. */
	zeroGain?: string;
	/** Strips no audible clip reaches are not processed (same output). */
	prune?: boolean;
	/** `false`: no loudness meter (`truePeakDb` null). */
	meter?: boolean;
};

/** What a render needs besides its request: the decoders' ffmpeg, cancellation, child tracking. */
export type RenderEnv = {
	ff: Ffmpeg;
	signal?: AbortSignal;
	onSpawn?(child: import('node:child_process').ChildProcess): void;
};

export type RenderedPcm = { pcm: Pcm; truePeakDb: number | null; sampleRate: number };

/** Renders a request (see RenderRequest). */
export async function renderPcmCore(req: RenderRequest, env: RenderEnv): Promise<RenderedPcm> {
	const snap = req.snapshot;
	const fps = snap.settings.fps as Rational;
	const sr = snap.audioMix?.sampleRate ?? snap.settings.sampleRate;
	const startSample = frameToSample(req.range.start, fps, sr);
	const total = Math.max(0, frameToSample(req.range.end, fps, sr) - startSample);
	const snapshot: RenderSnapshot = req.zeroGain
		? {
				...snap,
				audioClips: snap.audioClips.map((c) => (c.clipId === req.zeroGain ? { ...c, gainDb: 0 } : c)),
			}
		: snap;
	const channels: Float32Array[] = [];
	let at = 0;
	const r = await renderMixdown({
		ff: env.ff,
		snapshot,
		media: (id) => (Object.hasOwn(req.media, id) ? req.media[id]! : null),
		range: req.range,
		length: total,
		scratchDir: tmpdir(),
		measureOnly: true,
		withoutLoudness: true,
		onlyClips: new Set(req.clipIds),
		...(req.prune ? { skipSilentStrips: true } : {}),
		...(req.meter === false ? { meter: false } : {}),
		...(env.signal ? { signal: env.signal } : {}),
		...(env.onSpawn ? { onSpawn: env.onSpawn } : {}),
		onBlock: (planar, n) => {
			if (channels.length === 0)
				for (let c = 0; c < planar.length; c++) channels.push(new Float32Array(total));
			const m = Math.min(n, total - at);
			for (let c = 0; c < channels.length; c++) channels[c]!.set(planar[c]!.subarray(0, m), at);
			at += m;
		},
	});
	const tp = r.loudness.truePeakDb;
	return {
		pcm: { startSample, channels: channels.length ? channels : [new Float32Array(total)] },
		truePeakDb: req.meter !== false && Number.isFinite(tp) ? tp : null,
		sampleRate: r.sampleRate,
	};
}

/** Channel-averaged 10 ms frame levels (dBFS) of `pcm` from sample `from` (relative) to `to`. */
function frameLevels(pcm: Pcm, sr: number, from = 0, to?: number): Float32Array {
	const hop = Math.max(1, Math.round(sr / 100));
	const len = pcm.channels[0]?.length ?? 0;
	const end = Math.min(len, to ?? len);
	const n = Math.max(0, Math.ceil((end - from) / hop));
	const out = new Float32Array(n);
	const nch = Math.max(1, pcm.channels.length);
	for (let f = 0; f < n; f++) {
		const a = from + f * hop;
		const b = Math.min(end, a + hop);
		let e = 0;
		for (const ch of pcm.channels)
			for (let i = a; i < b; i++) {
				const x = ch[i]!;
				if (x - x === 0) e += x * x;
			}
		e /= Math.max(1, (b - a) * nch);
		out[f] = e > 0 ? 10 * Math.log10(e) : -200;
	}
	return out;
}

/** The sound's active span (samples from the start of its solo render, end exclusive), or null when it is silent. */
export function activeSpan(pcm: Pcm, sr: number): [number, number] | null {
	const db = frameLevels(pcm, sr);
	let max = Number.NEGATIVE_INFINITY;
	for (const v of db) if (v > max) max = v;
	if (!(max > SILENCE_DBFS)) return null;
	const floor = max - ACTIVE_RANGE_DB;
	let a = 0;
	while (a < db.length && db[a]! < floor) a++;
	let b = db.length - 1;
	while (b > a && db[b]! < floor) b--;
	const hop = Math.max(1, Math.round(sr / 100));
	const len = pcm.channels[0]?.length ?? 0;
	const s0 = a * hop;
	let s1 = Math.min(len, (b + 1) * hop);
	s1 = Math.max(s1, Math.min(len, s0 + Math.round(MIN_WINDOW_SEC * sr)));
	s1 = Math.min(s1, s0 + Math.round(MAX_WINDOW_SEC * sr));
	return [s0, s1];
}

/**
 * A sound's measurement, relative to the start of its solo render (`t0` = its first sample's time): the same sound
 * played the same way gives the same entry wherever it sits on the timeline.
 */
export type SoundEntry = {
	/** Active window (seconds from `t0`). */
	rel: TimeWindow;
	silent: boolean;
	soundBandsDb: number[];
	soundPeakLu: number | null;
	truePeakDb: number | null;
	/** How its energy is spread over its window (`energyProfile`): it masks other sounds by what it has under them. */
	energyProfile?: number[];
	/** Its peaks along its window (`peakProfile`, dB at 0 dB): overlapping sounds share the ceiling where they meet. */
	peakProfileDb?: number[];
};

/** A sound alone: the render at 0 dB, and its window when it renders silent (seconds from the render's start). */
export type SoloRequest = RenderRequest & { silentRel: TimeWindow };

/** Renders a sound alone and measures it: active window, octave bands, short-term peak, true peak, energy and peak profiles. */
export async function measureSoloCore(req: SoloRequest, env: RenderEnv): Promise<SoundEntry> {
	const r = await renderPcmCore(req, env);
	const sr = r.sampleRate;
	const span = activeSpan(r.pcm, sr);
	const rel = span ? { start: span[0] / sr, end: span[1] / sr } : req.silentRel;
	const peak = shortTermPeakLu(r.pcm.channels, sr, rel, 0);
	const peaks = span && r.truePeakDb !== null ? peakProfile(r.pcm.channels, sr, rel, r.truePeakDb) : null;
	return {
		rel,
		silent: span === null,
		soundBandsDb: bandLevels(r.pcm.channels, sr, rel),
		soundPeakLu: Number.isFinite(peak) ? peak : null,
		truePeakDb: r.truePeakDb,
		...(span ? { energyProfile: energyProfile(r.pcm.channels, sr, rel) } : {}),
		...(peaks ? { peakProfileDb: peaks } : {}),
	};
}

/** The bed under sounds: one rendered bed cluster and, per sound, its window relative to the cluster (null: no bed). */
export type BedBandsRequest = {
	channels: Float32Array[];
	sampleRate: number;
	items: { rel: TimeWindow | null; window: TimeWindow; weight: Weight }[];
};
export type BedBands = { bedBandsDb: number[]; bedLocalPeakLu: number | null };

/** The bed's octave bands and local peak over each sound's window. */
export function bedBandsCore(req: BedBandsRequest): BedBands[] {
	const sr = req.sampleRate;
	return req.items.map(({ rel, window, weight }) => {
		const bedBandsDb = rel ? bandLevels(req.channels, sr, rel) : bandLevels([], sr, window);
		const lp = rel ? bedLocalPeakLu(req.channels, sr, rel, weight) : Number.NEGATIVE_INFINITY;
		return { bedBandsDb, bedLocalPeakLu: Number.isFinite(lp) ? lp : null };
	});
}

/**
 * An export's pass-1 mix (`renderPass1`, wp-note export-performance "Audio delivery"): the snapshot's audio, the
 * media it plays as files, the range and output; the WAV is written into `scratchDir`.
 */
export type MixPass1Request = {
	snapshot: RenderSnapshot;
	media: Record<string, MixSource>;
	range: { start: number; end: number };
	length: number;
	outputLayout?: Layout;
	normalize: { targetLufs: number; truePeakDb: number } | null;
	scratchDir: string;
};

/** The decoded check of an encoded file (deliver.ts `measureEncodedAudio`). */
export type EncodedMeasureRequest = { file: string; channels: number; sampleRate: number };

/** One unit of work for a measurement thread. */
export type MeasureOp =
	| { kind: 'solo'; req: SoloRequest }
	| { kind: 'render'; req: RenderRequest }
	| { kind: 'bedBands'; req: BedBandsRequest }
	| { kind: 'mixPass1'; req: MixPass1Request }
	| { kind: 'deliveryPass'; req: DeliveryPassRequest }
	| { kind: 'encodedMeasure'; req: EncodedMeasureRequest };
export type MeasureOpResult<K extends MeasureOp['kind']> = K extends 'solo'
	? SoundEntry
	: K extends 'render'
		? RenderedPcm
		: K extends 'mixPass1'
			? MixPass1
			: K extends 'deliveryPass'
				? LoudnessSummary
				: K extends 'encodedMeasure'
					? EncodedMeasure
					: BedBands[];

/** Runs one op (in whichever thread calls it). */
export async function runMeasureOp<O extends MeasureOp>(
	op: O,
	env: RenderEnv,
): Promise<MeasureOpResult<O['kind']>> {
	switch (op.kind) {
		case 'solo':
			return (await measureSoloCore(op.req, env)) as MeasureOpResult<O['kind']>;
		case 'render':
			return (await renderPcmCore(op.req, env)) as MeasureOpResult<O['kind']>;
		case 'mixPass1': {
			const req = (op as Extract<MeasureOp, { kind: 'mixPass1' }>).req;
			return (await renderPass1({
				ff: env.ff,
				snapshot: req.snapshot,
				media: (id) => (Object.hasOwn(req.media, id) ? req.media[id]! : null),
				range: req.range,
				length: req.length,
				...(req.outputLayout ? { outputLayout: req.outputLayout } : {}),
				normalize: req.normalize,
				scratchDir: req.scratchDir,
				...(env.signal ? { signal: env.signal } : {}),
				...(env.onSpawn ? { onSpawn: env.onSpawn } : {}),
			})) as MeasureOpResult<O['kind']>;
		}
		case 'deliveryPass':
			return (await runDeliveryPassRequest(
				(op as Extract<MeasureOp, { kind: 'deliveryPass' }>).req,
				env.signal,
			)) as MeasureOpResult<O['kind']>;
		case 'encodedMeasure': {
			const req = (op as Extract<MeasureOp, { kind: 'encodedMeasure' }>).req;
			return (await measureEncodedAudio({
				ff: env.ff,
				file: req.file,
				channels: req.channels,
				sampleRate: req.sampleRate,
				signal: env.signal,
				...(env.onSpawn ? { onSpawn: env.onSpawn } : {}),
			})) as MeasureOpResult<O['kind']>;
		}
		default:
			return bedBandsCore((op as Extract<MeasureOp, { kind: 'bedBands' }>).req) as MeasureOpResult<O['kind']>;
	}
}

/** The typed arrays of a result, to transfer them back from a worker instead of copying. */
export function transferablesOf(result: unknown): ArrayBuffer[] {
	const hops = (result as Partial<EncodedMeasure> | null)?.hopTruePeakDb;
	if (hops?.buffer instanceof ArrayBuffer) return [hops.buffer];
	const r = result as Partial<RenderedPcm> | null;
	if (!r?.pcm) return [];
	const out = new Set<ArrayBuffer>();
	for (const c of r.pcm.channels) if (c.buffer instanceof ArrayBuffer) out.add(c.buffer);
	return [...out];
}
