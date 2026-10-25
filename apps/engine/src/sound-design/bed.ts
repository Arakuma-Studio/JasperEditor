// Bed render and sound measurements for the masking solver (spec 12 §2.4, P4-R2; wp-note "Phase 4 → WP4.1b").
//
// SFX clips are the sequence's audio clips `isSfxClip` names (Essential Sound type SFX, or placed sounds with `sfx`
// metadata and no other Essential Sound type). The BED is everything else the mix plays (dialogue, music, ambience,
// untyped audio, nested sequences), rendered by the export's offline mixer (`renderMixdown`, master output, the Mix's
// loudness normalisation left out) with every SFX clip silent — never over the whole sequence, only over CUE CLUSTERS:
// each measured sound's active window widened by its local-peak margin (±1 s hero, ±0.15 s support / ambient), the
// 400 ms momentary window and the K-weighting warm-up, overlapping spans merged.
//
// Each SOUND is rendered alone by the same mixer at 0 dB clip gain (the snapshot's clip gain overridden; In point,
// speed, channels, clip effects, volume keyframes, fades, pan, its track's strip, sends and the master all as in the
// mix), over its clip span plus a tail. Its ACTIVE WINDOW is from the first to the last 10 ms frame within 30 dB of its
// loudest (≤ 20 s). The sound's octave bands and peak loudness, and the bed's bands and local peak, are measured over
// that same window (same length: `bandLevels`' Welch normalisation then cancels in the lift, WP4.1a).
//
// SPEECH: the one dialogue definition of the project (`dialogueSpans`, spec 12 P6-R3): transcript words, else the voice
// activity of Essential Sound dialogue clips (`VoiceActivityService`: the speech module's energy VAD over each clip's
// media, ≥ −50 dBFS, cached per file and range), else their whole spans; padded 0.25 s, pauses < 0.75 s bridged. An
// event overlaps speech when its window meets a dialogue span; the span's tracks are named in the why-line.
//
// Caches (per engine, bounded), keyed by what a render plays and never by entity ids (`soundKey`, `mixKey`): bed PCM
// per cluster by the bed clips under it, their media (fingerprint, or offline) and the mixer graph;
// sound measurements by the clip at 0 dB, its media and the strips its signal goes through (relative to the render's
// start when nothing on its way is automated, so a sound placed the same way elsewhere is measured once). A rebalance
// after a gain change, a plan run again, or a rebalance right after accepting a plan re-renders nothing. Renders
// skip the strips no audible clip reaches (`OfflineMixer` `audibleClips`; the same output).
//
// THREADS (WP6.5b): the renders and their band analysis (measure-core.ts) run on the measurement worker threads
// (measure-pool.ts) when the engine has them, else in-thread; the same code either way (bit-identical results).
import { createHash } from 'node:crypto';
import type { LoudnessSummary } from '@jasper/audio-dsp';
import type { TimeWindow } from '@jasper/audio-fx';
import {
	type AudioStream,
	buildRenderSnapshot,
	type Clip,
	dialogueSpans,
	frameToSample,
	isSfxClip,
	looksLikeId,
	type MediaAsset,
	type MediaHandle,
	type ProjectDocument,
	type Rational,
	type RenderAudioClip,
	type RenderSnapshot,
	type Sequence,
} from '@jasper/project';
import type { MixSource } from '../audio/mixdown.ts';
import { localHandle, mediaKeyOf } from '../export/planner.ts';
import type { MediaRegistry } from '../media/registry.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import {
	ACTIVE_RANGE_DB,
	activeSpan,
	type BedBands,
	MAX_WINDOW_SEC,
	MIN_WINDOW_SEC,
	type Pcm,
	type RenderEnv,
	type RenderRequest,
	renderPcmCore,
	type SoundEntry,
	type Weight,
} from './measure-core.ts';
import { type SoundDesignMeasurer, soundDesignMeasurer } from './measure-pool.ts';
import { type VoiceActivityService, type VoiceEntry, voiceServiceFor } from './voice.ts';

export { ACTIVE_RANGE_DB, activeSpan, MAX_WINDOW_SEC, MIN_WINDOW_SEC, type Weight };

/** Seconds of bed rendered before a window beyond its margin: K-weighting warm-up (0.5 s) + half a momentary window. */
export const BED_PREROLL_SEC = 0.7;
/** Seconds after a window beyond its margin: half a momentary window. */
export const BED_TAIL_SEC = 0.2;
/** Local-peak margin by weight (seconds each side; spec 12 §2.4 / WP4.1a `BED_PEAK_MARGIN_SEC`). */
export const CLUSTER_MARGIN_SEC = { hero: 1, support: 0.15, ambient: 0.15 } as const;
/** Seconds rendered after a sound's clip (effect tails on its track). */
export const SOLO_TAIL_SEC = 0.5;
/** Voiced frames are at least this loud (dBFS) besides being over the clip's adaptive threshold. */
export const VAD_FLOOR_DBFS = -50;
/** Renders running at once. */
const DEFAULT_CONCURRENCY = 3;

/** A sound to measure: a clip of `doc` (the bed document, or a preview with another sound in its place). */
export type SoundTarget = { doc: ProjectDocument; clipId: string; weight: Weight };

/** What the solver needs about one sound, measured. */
export type MeasuredSound = {
	clipId: string;
	weight: Weight;
	/** Active window on the timeline (seconds). */
	window: TimeWindow;
	/** The sound renders silent (no 10 ms frame over −100 dBFS): its window is its clip span. */
	silent: boolean;
	soundBandsDb: number[];
	soundPeakLu: number | null;
	truePeakDb: number | null;
	/** How its energy is spread over its window (`energyProfile`): it masks other sounds by what it has under them. */
	energyProfile?: number[];
	/** Its peaks along its window (`peakProfile`, dB at 0 dB): overlapping sounds share the ceiling where they meet. */
	peakProfileDb?: number[];
	bedBandsDb: number[];
	bedLocalPeakLu: number | null;
	speechOverlap: boolean;
	/** Labels of the tracks whose speech overlaps the window ("A1"). */
	speechTracks: string[];
	/** Labels of the bed tracks with clips under the window. */
	bedTracks: string[];
};

export type BedMeasurement = {
	sampleRate: number;
	sounds: Map<string, MeasuredSound>;
	/** Sounds that could not be measured (not in the mix: disabled, a muted track, media offline), with why. */
	missing: { clipId: string; reason: string }[];
	/** Rendered bed spans (seconds), merged. */
	clusters: TimeWindow[];
	/** Renders run, and served from the caches. */
	renders: { bed: number; sound: number; voice: number; cached: number };
	/** Wall time of each stage (ms): the sounds alone, the bed, the voices. */
	ms: { sound: number; bed: number; voice: number };
};

type SoundMeasure = Pick<
	MeasuredSound,
	'window' | 'silent' | 'soundBandsDb' | 'soundPeakLu' | 'truePeakDb' | 'energyProfile' | 'peakProfileDb'
>;
/** Per-engine caches (bounded): bed PCM per cluster by bytes, sound measurements and voice activity by count. */
export class MeasureCache {
	private readonly beds = new Map<string, Pcm>();
	private bedBytes = 0;
	private readonly sounds = new Map<string, SoundEntry>();
	private readonly voices = new Map<string, VoiceEntry>();
	private readonly loudness = new Map<string, number | null>();
	private readonly mixes = new Map<string, LoudnessSummary>();
	private readonly deliveries = new Map<string, Record<string, unknown> | null>();
	constructor(
		readonly maxBedBytes = 96 * 1024 * 1024,
		readonly maxSounds = 4000,
	) {}
	getBed(key: string): Pcm | undefined {
		const v = this.beds.get(key);
		if (v) {
			this.beds.delete(key);
			this.beds.set(key, v);
		}
		return v;
	}
	putBed(key: string, v: Pcm): void {
		const bytes = v.channels.reduce((n, c) => n + c.byteLength, 0);
		if (bytes > this.maxBedBytes) return;
		const old = this.beds.get(key);
		if (old) {
			this.beds.delete(key);
			this.bedBytes -= old.channels.reduce((n, c) => n + c.byteLength, 0);
		}
		this.beds.set(key, v);
		this.bedBytes += bytes;
		for (const [k, x] of this.beds) {
			if (this.bedBytes <= this.maxBedBytes) break;
			this.beds.delete(k);
			this.bedBytes -= x.channels.reduce((n, c) => n + c.byteLength, 0);
		}
	}
	getSound(key: string): SoundEntry | undefined {
		return lru(this.sounds, key);
	}
	putSound(key: string, v: SoundEntry): void {
		bounded(this.sounds, key, v, this.maxSounds);
	}
	/** Voice activity of a dialogue range (`VoiceActivityService` entries by its request key). */
	readonly voice = {
		get: (key: string): VoiceEntry | undefined => lru(this.voices, key),
		put: (key: string, v: VoiceEntry): void => bounded(this.voices, key, v, this.maxSounds),
	};
	/** A clip's own integrated loudness (delivery Auto-Match), null for silence. */
	getLoudness(key: string): number | null | undefined {
		return this.loudness.has(key) ? lru(this.loudness, key) : undefined;
	}
	putLoudness(key: string, v: number | null): void {
		bounded(this.loudness, key, v, this.maxSounds);
	}
	/** A whole mix's loudness summary (the plan's delivery analysis). */
	getMix(key: string): LoudnessSummary | undefined {
		return lru(this.mixes, key);
	}
	putMix(key: string, v: LoudnessSummary): void {
		bounded(this.mixes, key, v, 64);
	}
	/** A whole mix's converged delivery for a target (the stored analysis's `delivery`), by mix key and target. */
	getMixDelivery(key: string): Record<string, unknown> | null | undefined {
		return this.deliveries.has(key) ? lru(this.deliveries, key) : undefined;
	}
	putMixDelivery(key: string, v: Record<string, unknown> | null): void {
		bounded(this.deliveries, key, v, 64);
	}
	clear(): void {
		this.beds.clear();
		this.sounds.clear();
		this.voices.clear();
		this.loudness.clear();
		this.mixes.clear();
		this.deliveries.clear();
		this.bedBytes = 0;
	}
}

function lru<T>(m: Map<string, T>, key: string): T | undefined {
	if (!m.has(key)) return undefined;
	const v = m.get(key) as T;
	m.delete(key);
	m.set(key, v);
	return v;
}
function bounded<T>(m: Map<string, T>, key: string, v: T, max: number): void {
	m.delete(key);
	m.set(key, v);
	while (m.size > max) m.delete(m.keys().next().value!);
}

/** The engine's shared measurement cache. */
export const measureCache = new MeasureCache();

export type MeasureDeps = {
	ff: Ffmpeg;
	registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
	signal?: AbortSignal;
	onSpawn?(child: import('node:child_process').ChildProcess): void;
	cache?: MeasureCache;
	concurrency?: number;
	onProgress?(fraction: number, stage: string): void;
	/** Voice activity of dialogue clips (default: the engine's service for `ff`). */
	voice?: VoiceActivityService;
	/** Where renders and band analysis run (default: the engine's measurement workers, in-thread without them). */
	measurer?: SoundDesignMeasurer;
};

const sha = (v: unknown) =>
	createHash('sha256')
		.update(typeof v === 'string' ? v : JSON.stringify(v))
		.digest('hex')
		.slice(0, 32);

/** Runs `fn` over `items` with at most `n` at once; results in input order. */
async function pool<T, R>(items: readonly T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]!, i);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
	return out;
}

/** The snapshot of a document's sequence for audio (media resolved to engine-local files) and the mixer's media. */
export type AudioWorld = {
	snapshot: RenderSnapshot;
	media(id: string): MixSource | null;
	/** The online media the snapshot's clips play, as files (a render request carries them to a worker). */
	mediaFiles: Record<string, MixSource>;
	/** The media's fingerprint when it is online here (null: offline, it renders as silence). */
	fingerprint(id: string): string | null;
};

export async function audioWorld(
	doc: ProjectDocument,
	sequenceId: string,
	registry: MeasureDeps['registry'],
): Promise<AudioWorld> {
	const local = new Map<string, MixSource & { handle: MediaHandle; fingerprint: string }>();
	for (const asset of Object.values(doc.media ?? {}) as MediaAsset[]) {
		if (asset.kind !== 'audio' && asset.kind !== 'video') continue;
		const key = mediaKeyOf(asset);
		const record = key ? registry.get(key) : null;
		const path = record ? await registry.resolvePath(record.mediaKey) : null;
		if (!record || !path) continue;
		local.set(asset.id, {
			path,
			streams: record.probe.streams.filter((s) => s.type === 'audio') as AudioStream[],
			container: record.container,
			handle: localHandle(asset, { path, record }),
			fingerprint: asset.fingerprint,
		});
	}
	const snapshot = buildRenderSnapshot(doc, sequenceId, {
		captions: 'none',
		resolveMedia: (asset) => local.get(asset.id)?.handle ?? null,
		resolveFont: () => null,
	});
	const mediaFiles: Record<string, MixSource> = {};
	for (const c of snapshot.audioClips) {
		const m = local.get(c.mediaId);
		if (m && !Object.hasOwn(mediaFiles, c.mediaId))
			mediaFiles[c.mediaId] = { path: m.path, streams: m.streams, container: m.container };
	}
	return {
		snapshot,
		mediaFiles,
		media: (id) => {
			const m = local.get(id);
			return m ? { path: m.path, streams: m.streams, container: m.container } : null;
		},
		fingerprint: (id) => local.get(id)?.fingerprint ?? null,
	};
}

// ── cache keys ────────────────────────────────────────────────────────────────────────────────────────────────────
// Keys describe what a render plays, not which entities play it: entity ids (clips, tracks, submixes, effects, sends,
// keyframes, media) are replaced by their order of first appearance, so a preview of a plan (seeded ids) and the
// document after accepting it (fresh ids) share their measurements. Media are named by their fingerprint when online
// and null when offline (an offline clip renders as silence: relinking it changes the key).

/** A JSON value with object keys sorted and entity ids replaced by `#<order of first appearance>`. */
function canonicalIds(v: unknown, map: Map<string, string>, depth = 0): unknown {
	if (depth > 64) return null;
	if (typeof v === 'string') {
		if (!looksLikeId(v)) return v;
		let c = map.get(v);
		if (c === undefined) {
			c = `#${map.size}`;
			map.set(v, c);
		}
		return c;
	}
	if (Array.isArray(v)) return v.map((x) => canonicalIds(x, map, depth + 1));
	if (v && typeof v === 'object') {
		const o: Record<string, unknown> = {};
		for (const k of Object.keys(v).sort())
			o[k] = canonicalIds((v as Record<string, unknown>)[k], map, depth + 1);
		return o;
	}
	return typeof v === 'number' && !Number.isFinite(v) ? String(v) : v;
}

const isAnimatable = (v: unknown): v is { value: unknown; keyframes: unknown[] } =>
	!!v && typeof v === 'object' && 'value' in v && Array.isArray((v as { keyframes?: unknown }).keyframes);

/** Whether anything in `v` is keyframed (an animatable with keyframes). */
function hasKeyframes(v: unknown, depth = 0): boolean {
	if (depth > 64 || !v || typeof v !== 'object') return false;
	if (isAnimatable(v) && v.keyframes.length > 0) return true;
	for (const x of Array.isArray(v) ? v : Object.values(v)) if (hasKeyframes(x, depth + 1)) return true;
	return false;
}

/** `v` with every animatable reduced to its static value (what processor latencies depend on). */
function staticOnly(v: unknown, depth = 0): unknown {
	if (depth > 64 || !v || typeof v !== 'object') return v;
	if (Array.isArray(v)) return v.map((x) => staticOnly(x, depth + 1));
	if (isAnimatable(v)) return { value: v.value, keyframes: [] };
	return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, staticOnly(x, depth + 1)]));
}

type MixStrip = NonNullable<RenderSnapshot['audioMix']>['strips'][number];

/** Ids of the strips a track's signal goes through: the track, what it outputs and sends to, recursively. */
function stripPath(strips: readonly MixStrip[], trackId: string): Set<string> {
	const byId = new Map(strips.map((s) => [s.id, s]));
	const out = new Set<string>();
	const walk = (id: string) => {
		if (out.has(id) || out.size > 256) return;
		const s = byId.get(id);
		if (!s) return;
		out.add(id);
		if (s.output) walk(s.output);
		for (const x of s.sends) walk(x.target);
	};
	walk(trackId);
	return out;
}

/** The mixer graph for a key: strip names left out (they do not sound). */
const keyStrips = (strips: readonly MixStrip[], full: (s: MixStrip) => boolean) =>
	strips.map((s) => {
		const { label: _l, name: _n, ...rest } = s;
		return full(s) ? rest : staticOnly(rest);
	});

/** Key of the whole mix of a world over `range` (every clip it plays). */
export function wholeMixKey(world: AudioWorld, range: { start: number; end: number }): string {
	return mixKey('mix', world, world.snapshot.audioClips, range);
}

/**
 * Key of a clip's own signal at source level (delivery Auto-Match: no gain, volume, fades or pan, no strips; the
 * track's and the Mix's channel formats convert it): relative to the clip's start unless nest levels place it.
 */
export function clipLoudnessKey(
	world: AudioWorld,
	rc: RenderAudioClip,
	range: { start: number; end: number },
): string {
	const snap = world.snapshot;
	const mix = snap.audioMix;
	const fps = snap.settings.fps as Rational;
	const sr = mix?.sampleRate ?? snap.settings.sampleRate;
	const absolute = (rc.nestGain?.length ?? 0) > 0;
	const { clipId: _c, gainDb: _g, volumeDb: _v, pan: _p, fades: _f, track: _t, trackId: _tr, ...own } = rc;
	const track = mix?.strips.find((s) => s.id === rc.trackId);
	const map = new Map<string, string>();
	return sha({
		v: 1,
		kind: 'clip-source',
		clip: canonicalIds({ ...own, start: rc.start - range.start }, map),
		trackFormat: track?.format ?? null,
		master: mix?.masterFormat ?? null,
		fp: world.fingerprint(rc.mediaId),
		len: range.end - range.start,
		sr,
		fps,
		phase: (((range.start * sr * fps.den) % fps.num) + fps.num) % fps.num,
		at: absolute ? range.start : null,
	});
}

/**
 * Key of a sound's solo render (the clip at 0 dB over `range`, every other clip silent). It holds the clip as it
 * plays (media fingerprint, In point, speed, channels, clip effects, volume, pan…), the strips its signal goes
 * through in full (inserts, fader, pan, sends, automation), and the rest of the graph without automation (only their
 * static settings set the latencies the routes are aligned by; they carry no signal — the mixer skips them). When
 * nothing on its way is automated (and the clip has no fades or nest levels in sequence time), the key is relative to
 * the render's start: the same sound placed the same way elsewhere on the timeline is measured once.
 */
function soundKey(
	world: AudioWorld,
	rc: RenderAudioClip,
	range: { start: number; end: number },
	fp: string,
): { key: string; relative: boolean } {
	const snap = world.snapshot;
	const mix = snap.audioMix;
	const strips = mix?.strips ?? [];
	const path = stripPath(strips, rc.trackId);
	const fps = snap.settings.fps as Rational;
	const sr = mix?.sampleRate ?? snap.settings.sampleRate;
	const absolute =
		strips.some((s) => path.has(s.id) && hasKeyframes(s)) ||
		(rc.fades?.length ?? 0) > 0 ||
		(rc.nestGain?.length ?? 0) > 0 ||
		hasKeyframes(rc.track);
	const map = new Map<string, string>();
	const graph = canonicalIds(
		{ master: mix?.masterFormat ?? null, strips: keyStrips(strips, (s) => path.has(s.id)) },
		map,
	);
	const clip = canonicalIds({ ...rc, clipId: null, gainDb: 0, start: rc.start - range.start }, map);
	// where the render starts inside a frame's samples (frames are not whole samples at 29.97 fps)
	const phase = (((range.start * sr * fps.den) % fps.num) + fps.num) % fps.num;
	return {
		key: sha({
			v: 2,
			graph,
			clip,
			fp,
			len: range.end - range.start,
			sr,
			fps,
			phase,
			at: absolute ? range.start : null,
		}),
		relative: !absolute,
	};
}

/** Key of the mix of `clips` over `range` (the bed, the voices, a whole mix): the graph, the clips, their media. */
function mixKey(
	kind: 'bed' | 'voice' | 'mix',
	world: AudioWorld,
	clips: readonly RenderAudioClip[],
	range: { start: number; end: number },
): string {
	const snap = world.snapshot;
	const mix = snap.audioMix;
	const map = new Map<string, string>();
	const graph = canonicalIds(
		{ master: mix?.masterFormat ?? null, strips: keyStrips(mix?.strips ?? [], () => true) },
		map,
	);
	const played = canonicalIds(
		clips.map((c) => ({ ...c, clipId: null, fp: world.fingerprint(c.mediaId) })),
		map,
	);
	return sha({
		v: 2,
		kind,
		graph,
		clips: played,
		range,
		sr: mix?.sampleRate ?? snap.settings.sampleRate,
		fps: snap.settings.fps,
	});
}

/** Longest tail a solo render waits for (s). */
export const MAX_TAIL_SEC = 6;

/** Seconds of the Convolution Reverb's generated impulses (`irLength` of audio-fx `IR_SPECS`: 1.1 · RT60 + ER). */
const CONVOLUTION_TAIL_SEC: Record<string, number> = {
	smallRoom: 0.45 * 1.1 + 0.025,
	mediumRoom: 0.8 * 1.1 + 0.045,
	largeHall: 1.9 * 1.1 + 0.08,
	cathedral: 3.2 * 1.1 + 0.12,
	plate: 1.6 * 1.1,
	ambience: 0.3 * 1.1 + 0.015,
	vocalBooth: 0.2 * 1.1 + 0.008,
};
/** Quarter notes per tempo-synced Delay division (audio-fx `DIVISION_QUARTERS`, by division id). */
const DIVISION_QUARTERS: Record<string, number> = {
	'1/1': 4,
	'1/2': 2,
	'1/4': 1,
	'1/8': 0.5,
	'1/16': 0.25,
	'1/4d': 1.5,
	'1/8d': 0.75,
	'1/4t': 2 / 3,
	'1/8t': 1 / 3,
};

type FxLike = { effectId?: string; enabled?: boolean; params?: Record<string, unknown> };

/** The largest value an animatable parameter takes (static value and keyframes); 0 when unreadable. */
function paramMax(v: unknown, abs = false): number {
	const a = v as { value?: unknown; keyframes?: { value?: unknown }[] } | undefined;
	const xs = [a?.value, ...(Array.isArray(a?.keyframes) ? a.keyframes : []).map((k) => k?.value)].filter(
		(x): x is number => typeof x === 'number' && Number.isFinite(x),
	);
	return xs.length ? Math.max(...xs.map((x) => (abs ? Math.abs(x) : x))) : 0;
}
const paramStr = (v: unknown): string | null => {
	const x = (v as { value?: unknown } | undefined)?.value;
	return typeof x === 'string' ? x : null;
};

/** Echo repeats until a feedback loop of gain `fb` decays by 60 dB (∞ at unity or more). */
const repeatsTo60Db = (fb: number): number =>
	!(fb > 0) ? 0 : fb >= 0.999 ? Number.POSITIVE_INFINITY : Math.ceil(Math.log(1e-3) / Math.log(fb));

/**
 * Seconds an effect keeps sounding after its input stops (its tail to −60 dB): reverbs their decay (RT60) plus
 * pre-delay, the Convolution Reverb its impulse, delays and echoes their delay times the repeats their feedback takes
 * to fall 60 dB, the Flanger its delay line ringing with its feedback. Other effects (filters, dynamics, chorus,
 * phaser…) ring for less than `SOLO_TAIL_SEC`. Pure; never throws.
 */
export function effectTailSec(fx: FxLike): number {
	if (fx.enabled === false || !fx.effectId) return 0;
	const p = fx.params ?? {};
	const ms = (k: string) => paramMax(p[k]) / 1000;
	const pct = (k: string) => paramMax(p[k]) / 100;
	switch (fx.effectId) {
		case 'jasper.audio.studio-reverb':
		case 'jasper.audio.surround-reverb':
			return paramMax(p.decay) + ms('preDelay');
		case 'jasper.audio.convolution-reverb':
			return (
				(CONVOLUTION_TAIL_SEC[paramStr(p.impulse) ?? 'mediumRoom'] ?? CONVOLUTION_TAIL_SEC.cathedral!) +
				ms('preDelay')
			);
		case 'jasper.audio.delay': {
			const tempo = paramStr(p.mode) === 'tempo';
			const d = tempo
				? (60 / Math.max(1, paramMax(p.bpm) || 120)) * (DIVISION_QUARTERS[paramStr(p.division) ?? '1/8'] ?? 4)
				: ms('time');
			return d * (repeatsTo60Db(Math.min(0.95, pct('feedback'))) + 1);
		}
		case 'jasper.audio.analog-delay':
			// feedback up to 200 % saturates instead of decaying: at 100 % or more it rings for the longest tail
			return ms('delay') * (repeatsTo60Db(pct('feedback')) + 1);
		case 'jasper.audio.multitap-delay': {
			let t = 0;
			for (let n = 1; n <= 4; n++)
				if (paramMax(p[`level${n}`]) > -96)
					t = Math.max(t, ms(`delay${n}`) * (repeatsTo60Db(Math.min(0.95, pct(`feedback${n}`))) + 1));
			return t;
		}
		case 'jasper.audio.flanger': {
			const fb = (0.95 * paramMax(p.feedback, true)) / 100;
			return Math.max(ms('initialDelay'), ms('finalDelay')) * (repeatsTo60Db(fb) + 1);
		}
		default:
			return 0;
	}
}

/**
 * Seconds a sound plays on after its clip through effects with a tail on its way to the Mix — its clip effects, its
 * track's inserts, the submixes its track sends or outputs to (the "SFX Room" return is part of the sound's
 * contribution, Phase 4 WP4.2a) and the Mix's own inserts — at least `SOLO_TAIL_SEC`, at most `MAX_TAIL_SEC`. Pure;
 * never throws.
 */
export function soloTailSec(seq: Sequence, clip: Clip): number {
	const tailOf = (effects: unknown) => {
		let t = 0;
		for (const fx of (Array.isArray(effects) ? effects : []) as FxLike[]) {
			const x = effectTailSec(fx ?? {});
			if (x > t) t = x;
		}
		return t;
	};
	let tail = tailOf((clip as { effects?: unknown }).effects);
	const strips = new Map<
		string,
		{ effects?: unknown; mixer?: { output?: unknown; sends?: { target?: unknown }[] } }
	>();
	for (const t of [...seq.audioTracks, ...(seq.submixTracks ?? [])]) strips.set(t.id, t as never);
	const seen = new Set<string>();
	const walk = (id: string) => {
		if (seen.has(id) || seen.size > 64) return;
		seen.add(id);
		const s = strips.get(id);
		if (!s) return;
		tail = Math.max(tail, tailOf(s.effects));
		if (typeof s.mixer?.output === 'string') walk(s.mixer.output);
		for (const x of s.mixer?.sends ?? []) if (typeof x.target === 'string') walk(x.target);
	};
	walk(clip.trackId);
	// every path ends at the Mix
	tail = Math.max(tail, tailOf((seq.master as { effects?: unknown } | undefined)?.effects));
	return Math.min(MAX_TAIL_SEC, Math.max(SOLO_TAIL_SEC, Number.isFinite(tail) ? tail : MAX_TAIL_SEC));
}

/** Frame span `[start, end)` a clip plays in the snapshot (crossfade handles included). */
function clipSpan(c: RenderAudioClip): [number, number] {
	return [c.start - (c.headHandle ?? 0), c.start + c.duration + (c.tailHandle ?? 0)];
}

/** The render request of `range` (frames) of `world` with only `clipIds` audible (see `RenderRequest`). */
function renderRequest(
	world: AudioWorld,
	range: { start: number; end: number },
	clipIds: ReadonlySet<string>,
	opts: { zeroGain?: string; prune?: boolean; meter?: boolean } = {},
): RenderRequest {
	return {
		snapshot: world.snapshot,
		media: world.mediaFiles,
		range,
		clipIds: [...clipIds],
		...(opts.zeroGain ? { zeroGain: opts.zeroGain } : {}),
		...(opts.prune ? { prune: true } : {}),
		...(opts.meter === false ? { meter: false } : {}),
	};
}

const renderEnv = (deps: MeasureDeps): RenderEnv => ({
	ff: deps.ff,
	...(deps.signal ? { signal: deps.signal } : {}),
	...(deps.onSpawn ? { onSpawn: deps.onSpawn } : {}),
});

/** The sound's active window (absolute seconds) from its solo render, or null when it is silent. */
export function activeWindow(pcm: Pcm, sr: number): TimeWindow | null {
	const span = activeSpan(pcm, sr);
	return span ? { start: (pcm.startSample + span[0]) / sr, end: (pcm.startSample + span[1]) / sr } : null;
}

const relative = (w: TimeWindow, pcm: Pcm, sr: number): TimeWindow => ({
	start: w.start - pcm.startSample / sr,
	end: w.end - pcm.startSample / sr,
});

/** `A1`-style label of an audio track. */
function trackLabel(seq: Sequence, trackId: string): string {
	const i = seq.audioTracks.findIndex((t) => t.id === trackId);
	return i >= 0 ? `A${i + 1}` : trackId;
}

/** Merges spans (seconds) that overlap or touch. */
export function mergeSpans(spans: TimeWindow[]): TimeWindow[] {
	const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
	const out: TimeWindow[] = [];
	for (const s of sorted) {
		const last = out[out.length - 1];
		if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
		else out.push({ ...s });
	}
	return out;
}

/** The bed span an event needs: its window, its margin, the momentary window and the K-weighting warm-up. */
export function bedSpanOf(w: TimeWindow, weight: Weight): TimeWindow {
	const m = CLUSTER_MARGIN_SEC[weight];
	return { start: Math.max(0, w.start - m - BED_PREROLL_SEC), end: w.end + m + BED_TAIL_SEC };
}

/**
 * Measures `targets` (each a clip of its own document) against the bed of `bedDoc`'s sequence (every SFX clip silent).
 * Never renders the whole sequence: sounds over their clip spans, the bed and voices over the merged cue clusters.
 * Throws on abort; a sound that is not in the mix is reported in `missing`.
 */
export async function measureSfxEvents(
	input: { bedDoc: ProjectDocument; sequenceId: string; targets: readonly SoundTarget[] },
	deps: MeasureDeps,
): Promise<BedMeasurement> {
	const cache = deps.cache ?? measureCache;
	const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
	const measurer = deps.measurer ?? soundDesignMeasurer();
	const env = renderEnv(deps);
	const renders = { bed: 0, sound: 0, voice: 0, cached: 0 };
	const seqId = input.sequenceId;
	const bedSeq = input.bedDoc.sequences[seqId] as Sequence | undefined;
	if (!bedSeq) throw new Error(`Sequence not found: ${seqId}`);
	const worlds = new Map<ProjectDocument, Promise<AudioWorld>>();
	const worldOf = (doc: ProjectDocument) => {
		let w = worlds.get(doc);
		if (!w) {
			w = audioWorld(doc, seqId, deps.registry);
			worlds.set(doc, w);
		}
		return w;
	};
	const bedWorld = await worldOf(input.bedDoc);
	const fps = bedWorld.snapshot.settings.fps as Rational;
	const fpsNum = fps.num / fps.den;
	const sr = bedWorld.snapshot.audioMix?.sampleRate ?? bedWorld.snapshot.settings.sampleRate;
	const missing: BedMeasurement['missing'] = [];

	// 1. Each sound alone, at 0 dB clip gain.
	const ms = { sound: 0, bed: 0, voice: 0 };
	let tStage = Date.now();
	let done = 0;
	const steps = () => input.targets.length + 2;
	const inflight = new Map<string, Promise<SoundEntry>>();
	const measured = await pool(input.targets, concurrency, async (t) => {
		const world = await worldOf(t.doc);
		const seq = t.doc.sequences[seqId] as Sequence | undefined;
		const docClip = seq?.clips[t.clipId] as Clip | undefined;
		const rc = world.snapshot.audioClips.find((c) => c.clipId === t.clipId);
		if (docClip?.kind !== 'audio') {
			missing.push({ clipId: t.clipId, reason: 'not an audio clip of the sequence' });
			return null;
		}
		if (!rc) {
			missing.push({
				clipId: t.clipId,
				reason: 'not in the mix (the clip is disabled, outside the sequence or its track is silent)',
			});
			return null;
		}
		const fp = world.fingerprint(rc.mediaId);
		if (!fp) {
			missing.push({ clipId: t.clipId, reason: 'its media is offline' });
			return null;
		}
		const [s, e] = clipSpan(rc);
		// the clip's reverb tails (its room send) are part of its contribution: render until they die out
		const range = { start: Math.max(0, s), end: e + Math.ceil(soloTailSec(seq!, docClip) * fpsNum) };
		const { key } = soundKey(world, rc, range, fp);
		const t0 = frameToSample(range.start, fps, sr) / sr;
		const materialize = (x: SoundEntry): SoundMeasure => ({
			window: { start: t0 + x.rel.start, end: t0 + x.rel.end },
			silent: x.silent,
			soundBandsDb: x.soundBandsDb,
			soundPeakLu: x.soundPeakLu,
			truePeakDb: x.truePeakDb,
			...(x.energyProfile ? { energyProfile: x.energyProfile } : {}),
			...(x.peakProfileDb ? { peakProfileDb: x.peakProfileDb } : {}),
		});
		// the same render asked twice in this call (the same sound played the same way) is measured once
		let entry = cache.getSound(key) ?? null;
		let pending = entry ? null : inflight.get(key);
		if (entry || pending) renders.cached++;
		if (!entry && !pending) {
			pending = (async (): Promise<SoundEntry> => {
				// silent: its clip span (≤ 20 s), in seconds from the render's start
				const head = (rc.start - range.start) / fpsNum;
				const silentRel = {
					start: head,
					end: Math.min((rc.start + rc.duration - range.start) / fpsNum, head + MAX_WINDOW_SEC),
				};
				const req = renderRequest(world, range, new Set([t.clipId]), { zeroGain: t.clipId, prune: true });
				const x = await measurer.run({ kind: 'solo', req: { ...req, silentRel } }, env);
				renders.sound++;
				cache.putSound(key, x);
				return x;
			})();
			inflight.set(key, pending);
		}
		entry ??= await pending!;
		deps.onProgress?.(++done / steps(), 'Measuring sounds');
		return { target: t, m: materialize(entry) };
	});
	const ok = measured.filter((x): x is NonNullable<typeof x> => x !== null);
	ms.sound = Date.now() - tStage;
	tStage = Date.now();

	// 2. Cue clusters and the bed over them.
	const clusters = mergeSpans(ok.map(({ target, m }) => bedSpanOf(m.window, target.weight)));
	const sfxIds = new Set(
		Object.values(bedSeq.clips)
			.filter((c) => isSfxClip(c))
			.map((c) => c.id),
	);
	const bedClips = bedWorld.snapshot.audioClips.filter((c) => !sfxIds.has(c.clipId));
	const toFrames = (w: TimeWindow) => ({
		start: Math.max(0, Math.floor(w.start * fpsNum)),
		end: Math.max(Math.floor(w.start * fpsNum) + 1, Math.ceil(w.end * fpsNum)),
	});
	const overlapping = (clips: readonly RenderAudioClip[], range: { start: number; end: number }) =>
		clips.filter((c) => {
			const [s, e] = clipSpan(c);
			return s < range.end && e > range.start;
		});
	const beds = await pool(clusters, concurrency, async (w) => {
		const range = toFrames(w);
		const startSample = frameToSample(range.start, fps, sr);
		const total = Math.max(0, frameToSample(range.end, fps, sr) - startSample);
		const playing = overlapping(bedClips, range);
		if (playing.length === 0) return { range, pcm: { startSample, channels: [new Float32Array(total)] } };
		// the bed's own clips over the cluster, their media (offline = silent) and the graph, without ids
		const key = mixKey('bed', bedWorld, playing, range);
		const hit = cache.getBed(key);
		if (hit) {
			renders.cached++;
			return { range, pcm: hit };
		}
		const r = await measurer.run(
			{
				kind: 'render',
				req: renderRequest(bedWorld, range, new Set(playing.map((c) => c.clipId)), {
					prune: true,
					meter: false,
				}),
			},
			env,
		);
		renders.bed++;
		cache.putBed(key, r.pcm);
		return { range, pcm: r.pcm };
	});
	deps.onProgress?.((input.targets.length + 1) / steps(), 'Rendering the bed');
	ms.bed = Date.now() - tStage;
	tStage = Date.now();

	// 3. Speech: the one dialogue definition (`dialogueSpans`: transcript words, else the voice activity of Essential
	//    Sound dialogue clips measured on their media, else their spans), so the solver's dialogue guard, the cue
	//    derivation and Sound Check agree (spec 12 P6-R3).
	const voiceSvc = deps.voice ?? voiceServiceFor(deps.ff, deps.registry);
	const voice = await voiceSvc.forSequence(input.bedDoc, bedSeq, {
		memo: cache.voice,
		...(deps.signal ? { signal: deps.signal } : {}),
	});
	renders.voice += voice.decoded;
	renders.cached += voice.fromCache;
	const voiced = dialogueSpans(input.bedDoc, bedSeq, { voice: voice.voice }).map((sp) => ({
		start: sp.start / fpsNum,
		end: sp.end / fpsNum,
		tracks: sp.trackIds.map((t) => trackLabel(bedSeq, t)),
	}));
	ms.voice = Date.now() - tStage;
	// 4. Per sound: the bed over its window (bands and local peak, one op per bed cluster), its speech, the bed tracks
	//    under it.
	const bedOf = ok.map(({ target, m }) => {
		const span = bedSpanOf(m.window, target.weight);
		return beds.findIndex((x) => {
			const s0 = x.pcm.startSample / sr;
			const s1 = s0 + (x.pcm.channels[0]?.length ?? 0) / sr;
			return s0 <= span.start + 1e-6 && s1 >= Math.min(span.end, m.window.end) - 1e-6;
		});
	});
	const bands = new Array<BedBands>(ok.length);
	await pool([-1, ...beds.keys()], concurrency, async (bi) => {
		const idx = ok.map((_, i) => i).filter((i) => bedOf[i] === bi);
		if (idx.length === 0) return;
		const b = bi >= 0 ? beds[bi]! : null;
		const out = await measurer.run(
			{
				kind: 'bedBands',
				req: {
					channels: b ? b.pcm.channels : [],
					sampleRate: sr,
					items: idx.map((i) => ({
						rel: b ? relative(ok[i]!.m.window, b.pcm, sr) : null,
						window: ok[i]!.m.window,
						weight: ok[i]!.target.weight,
					})),
				},
			},
			env,
		);
		idx.forEach((i, k) => {
			bands[i] = out[k]!;
		});
	});
	const sounds = new Map<string, MeasuredSound>();
	for (const [i, { target, m }] of ok.entries()) {
		const { bedBandsDb, bedLocalPeakLu } = bands[i]!;
		const overlaps = (s: { start: number; end: number }) => s.start < m.window.end && s.end > m.window.start;
		const speechTracks = new Set<string>();
		for (const v of voiced) if (overlaps(v)) for (const t of v.tracks) speechTracks.add(t);
		const winFrames = { start: Math.floor(m.window.start * fpsNum), end: Math.ceil(m.window.end * fpsNum) };
		const bedTracks = [
			...new Set(
				overlapping(bedClips, winFrames)
					.filter((c) => bedSeq.audioTracks.some((t) => t.id === c.trackId))
					.map((c) => trackLabel(bedSeq, c.trackId)),
			),
		].sort();
		sounds.set(target.clipId, {
			clipId: target.clipId,
			weight: target.weight,
			window: m.window,
			silent: m.silent,
			soundBandsDb: m.soundBandsDb,
			soundPeakLu: m.soundPeakLu,
			truePeakDb: m.truePeakDb,
			...(m.energyProfile ? { energyProfile: m.energyProfile } : {}),
			...(m.peakProfileDb ? { peakProfileDb: m.peakProfileDb } : {}),
			bedBandsDb,
			bedLocalPeakLu,
			speechOverlap: speechTracks.size > 0,
			speechTracks: [...speechTracks].sort(),
			bedTracks,
		});
	}
	deps.onProgress?.(1, 'Measured');
	return { sampleRate: sr, sounds, missing, clusters, renders, ms };
}

/**
 * Renders frames `range` of a document's sequence through the export mixer (master, no loudness normalisation) with
 * only `clipIds` audible (null: every clip): the oracle the tests and the real-run checks compare measurements with.
 */
export async function renderSequencePcm(
	doc: ProjectDocument,
	sequenceId: string,
	range: { start: number; end: number },
	clipIds: ReadonlySet<string> | null,
	deps: MeasureDeps,
): Promise<{ sampleRate: number; startSample: number; channels: Float32Array[]; truePeakDb: number | null }> {
	const world = await audioWorld(doc, sequenceId, deps.registry);
	const ids = clipIds ?? new Set(world.snapshot.audioClips.map((c) => c.clipId));
	const r = await renderPcmCore(renderRequest(world, range, ids), renderEnv(deps));
	return {
		sampleRate: r.sampleRate,
		startSample: r.pcm.startSample,
		channels: r.pcm.channels,
		truePeakDb: r.truePeakDb,
	};
}
