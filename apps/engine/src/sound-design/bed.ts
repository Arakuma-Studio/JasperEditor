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
// SPEECH: transcript words of the sequence (`sequenceWords`), plus voice activity (10 ms levels over the threshold of
// `vadThreshold`, at least −50 dBFS) of Essential Sound dialogue clips without a transcript, rendered alone over the
// cluster. An event overlaps speech when a word or a voiced frame falls in its window.
//
// Caches (per engine, bounded): bed PCM per cluster by the bed's mix fingerprint (`mixFingerprint` of the document
// without its SFX clips) and the cluster's frames; sound measurements by the clip's render inputs (the clip at 0 dB,
// the mixer topology, the media fingerprint and the span). A rebalance after a gain change re-renders nothing.
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { bandLevels, bedLocalPeakLu, shortTermPeakLu, type TimeWindow } from '@jasper/audio-fx';
import {
	type AudioStream,
	buildRenderSnapshot,
	type Clip,
	FLICKS_PER_SECOND,
	frameToSample,
	isSfxClip,
	type MediaAsset,
	type MediaHandle,
	mixFingerprint,
	type ProjectDocument,
	type Rational,
	type RenderAudioClip,
	type RenderSnapshot,
	type Sequence,
	sequenceWords,
} from '@jasper/project';
import { type MixSource, renderMixdown } from '../audio/mixdown.ts';
import { localHandle, mediaKeyOf } from '../export/planner.ts';
import type { MediaRegistry } from '../media/registry.ts';
import { vadThreshold } from '../speech/core/vad.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';

/** Seconds of bed rendered before a window beyond its margin: K-weighting warm-up (0.5 s) + half a momentary window. */
export const BED_PREROLL_SEC = 0.7;
/** Seconds after a window beyond its margin: half a momentary window. */
export const BED_TAIL_SEC = 0.2;
/** Local-peak margin by weight (seconds each side; spec 12 §2.4 / WP4.1a `BED_PEAK_MARGIN_SEC`). */
export const CLUSTER_MARGIN_SEC = { hero: 1, support: 0.15, ambient: 0.15 } as const;
/** The active window: 10 ms frames within this many dB of the loudest frame. */
export const ACTIVE_RANGE_DB = 30;
/** Shortest active window (seconds). */
export const MIN_WINDOW_SEC = 0.05;
/** Longest measured window (seconds from the active start): long beds are measured on their first 20 s. */
export const MAX_WINDOW_SEC = 20;
/** Seconds rendered after a sound's clip (effect tails on its track). */
export const SOLO_TAIL_SEC = 0.5;
/** Voiced frames are at least this loud (dBFS) besides being over the clip's adaptive threshold. */
export const VAD_FLOOR_DBFS = -50;
/** Silence: the loudest 10 ms frame is under this (dBFS). */
const SILENCE_DBFS = -100;
/** Renders running at once. */
const DEFAULT_CONCURRENCY = 3;

export type Weight = 'hero' | 'support' | 'ambient';

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
};

type Pcm = { startSample: number; channels: Float32Array[] };
type SoundMeasure = Omit<
	MeasuredSound,
	'clipId' | 'weight' | 'bedBandsDb' | 'bedLocalPeakLu' | 'speechOverlap' | 'speechTracks' | 'bedTracks'
> & { pcm: Pcm | null };

/** Per-engine caches (bounded): bed PCM per cluster by bytes, sound measurements by count. */
export class MeasureCache {
	private readonly beds = new Map<string, Pcm>();
	private bedBytes = 0;
	private readonly sounds = new Map<string, Omit<SoundMeasure, 'pcm'>>();
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
	getSound(key: string): Omit<SoundMeasure, 'pcm'> | undefined {
		return this.sounds.get(key);
	}
	putSound(key: string, v: Omit<SoundMeasure, 'pcm'>): void {
		this.sounds.delete(key);
		this.sounds.set(key, v);
		while (this.sounds.size > this.maxSounds) this.sounds.delete(this.sounds.keys().next().value!);
	}
	clear(): void {
		this.beds.clear();
		this.sounds.clear();
		this.bedBytes = 0;
	}
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
	fingerprint(id: string): string | null;
	/** Hash of the mixer topology (strips, routes, sends, automation; loudness left out). */
	mixHash: string;
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
			handle: localHandle(asset, { path, record }),
			fingerprint: asset.fingerprint,
		});
	}
	const snapshot = buildRenderSnapshot(doc, sequenceId, {
		captions: 'none',
		resolveMedia: (asset) => local.get(asset.id)?.handle ?? null,
		resolveFont: () => null,
	});
	const mix = snapshot.audioMix;
	const { loudness: _l, ...topology } = (mix ?? {}) as { loudness?: unknown };
	return {
		snapshot,
		media: (id) => {
			const m = local.get(id);
			return m ? { path: m.path, streams: m.streams } : null;
		},
		fingerprint: (id) => local.get(id)?.fingerprint ?? null,
		mixHash: sha(topology),
	};
}

/** Reverb-like effects whose tail outlasts the dry sound: `decay` (s) + `preDelay` (ms). */
const TAIL_EFFECTS: ReadonlySet<string> = new Set([
	'jasper.audio.studio-reverb',
	'jasper.audio.surround-reverb',
]);
/** Longest tail a solo render waits for (s). */
export const MAX_TAIL_SEC = 6;

/**
 * Seconds a sound plays on after its clip through reverbs on its way to the Mix — its clip effects, its track's inserts,
 * the submixes its track sends or outputs to (the "SFX Room" return is part of the sound's contribution, Phase 4
 * WP4.2a) — at least `SOLO_TAIL_SEC`. Pure; never throws.
 */
export function soloTailSec(seq: Sequence, clip: Clip): number {
	const num = (v: unknown) => {
		const a = v as { value?: unknown; keyframes?: { value?: unknown }[] } | undefined;
		const xs = [a?.value, ...(a?.keyframes ?? []).map((k) => k.value)].filter(
			(x): x is number => typeof x === 'number' && Number.isFinite(x),
		);
		return xs.length ? Math.max(...xs) : 0;
	};
	const tailOf = (effects: unknown) => {
		let t = 0;
		for (const fx of (Array.isArray(effects) ? effects : []) as {
			effectId?: string;
			enabled?: boolean;
			params?: Record<string, unknown>;
		}[])
			if (fx.enabled !== false && fx.effectId && TAIL_EFFECTS.has(fx.effectId))
				t = Math.max(t, num(fx.params?.decay) + num(fx.params?.preDelay) / 1000);
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
	return Math.min(MAX_TAIL_SEC, Math.max(SOLO_TAIL_SEC, tail));
}

/** Frame span `[start, end)` a clip plays in the snapshot (crossfade handles included). */
function clipSpan(c: RenderAudioClip): [number, number] {
	return [c.start - (c.headHandle ?? 0), c.start + c.duration + (c.tailHandle ?? 0)];
}

/** Renders `range` (frames) of `world` with only `clipIds` audible (master output, no loudness normalisation). */
async function renderPcm(
	world: AudioWorld,
	range: { start: number; end: number },
	clipIds: ReadonlySet<string>,
	deps: MeasureDeps,
	opts: { zeroGain?: string } = {},
): Promise<{ pcm: Pcm; truePeakDb: number | null; sampleRate: number }> {
	const snap = world.snapshot;
	const fps = snap.settings.fps as Rational;
	const sr = snap.audioMix?.sampleRate ?? snap.settings.sampleRate;
	const startSample = frameToSample(range.start, fps, sr);
	const total = Math.max(0, frameToSample(range.end, fps, sr) - startSample);
	const snapshot: RenderSnapshot = opts.zeroGain
		? {
				...snap,
				audioClips: snap.audioClips.map((c) => (c.clipId === opts.zeroGain ? { ...c, gainDb: 0 } : c)),
			}
		: snap;
	const channels: Float32Array[] = [];
	let at = 0;
	const r = await renderMixdown({
		ff: deps.ff,
		snapshot,
		media: world.media,
		range,
		length: total,
		scratchDir: tmpdir(),
		measureOnly: true,
		withoutLoudness: true,
		onlyClips: clipIds,
		...(deps.signal ? { signal: deps.signal } : {}),
		...(deps.onSpawn ? { onSpawn: deps.onSpawn } : {}),
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
		truePeakDb: Number.isFinite(tp) ? tp : null,
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

/** The sound's active window (absolute seconds) from its solo render, or null when it is silent. */
export function activeWindow(pcm: Pcm, sr: number): TimeWindow | null {
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
	const s0 = pcm.startSample + a * hop;
	let s1 = pcm.startSample + Math.min(len, (b + 1) * hop);
	s1 = Math.max(s1, Math.min(pcm.startSample + len, s0 + Math.round(MIN_WINDOW_SEC * sr)));
	s1 = Math.min(s1, s0 + Math.round(MAX_WINDOW_SEC * sr));
	return { start: s0 / sr, end: s1 / sr };
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
	let done = 0;
	const steps = () => input.targets.length + 2;
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
		const key = sha({ v: 1, clip: { ...rc, gainDb: 0 }, mix: world.mixHash, fp, range, sr });
		const hit = cache.getSound(key);
		if (hit) {
			renders.cached++;
			deps.onProgress?.(++done / steps(), 'Measuring sounds');
			return { target: t, m: { ...hit, pcm: null } as SoundMeasure };
		}
		const r = await renderPcm(world, range, new Set([t.clipId]), deps, { zeroGain: t.clipId });
		renders.sound++;
		const win = activeWindow(r.pcm, sr);
		const window = win ?? {
			start: r.pcm.startSample / sr + (rc.start - range.start) / fpsNum,
			end: Math.min(
				r.pcm.startSample / sr + (rc.start + rc.duration - range.start) / fpsNum,
				r.pcm.startSample / sr + (rc.start - range.start) / fpsNum + MAX_WINDOW_SEC,
			),
		};
		const rel = relative(window, r.pcm, sr);
		const peak = shortTermPeakLu(r.pcm.channels, sr, rel, 0);
		const m: SoundMeasure = {
			window,
			silent: win === null,
			soundBandsDb: bandLevels(r.pcm.channels, sr, rel),
			soundPeakLu: Number.isFinite(peak) ? peak : null,
			truePeakDb: r.truePeakDb,
			pcm: r.pcm,
		};
		const { pcm: _p, ...keep } = m;
		cache.putSound(key, keep);
		deps.onProgress?.(++done / steps(), 'Measuring sounds');
		return { target: t, m };
	});
	const ok = measured.filter((x): x is NonNullable<typeof x> => x !== null);

	// 2. Cue clusters and the bed over them.
	const clusters = mergeSpans(ok.map(({ target, m }) => bedSpanOf(m.window, target.weight)));
	const sfxIds = new Set(
		Object.values(bedSeq.clips)
			.filter((c) => isSfxClip(c))
			.map((c) => c.id),
	);
	const bedClips = bedWorld.snapshot.audioClips.filter((c) => !sfxIds.has(c.clipId));
	const bedOnly: ProjectDocument = {
		...input.bedDoc,
		sequences: {
			...input.bedDoc.sequences,
			[seqId]: {
				...bedSeq,
				clips: Object.fromEntries(Object.entries(bedSeq.clips).filter(([id]) => !sfxIds.has(id))),
			},
		},
	};
	const bedFp = mixFingerprint(bedOnly, seqId);
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
		const key = sha({ v: 1, bed: bedFp, range, sr });
		const hit = cache.getBed(key);
		if (hit) {
			renders.cached++;
			return { range, pcm: hit };
		}
		const r = await renderPcm(bedWorld, range, new Set(playing.map((c) => c.clipId)), deps);
		renders.bed++;
		cache.putBed(key, r.pcm);
		return { range, pcm: r.pcm };
	});
	deps.onProgress?.((input.targets.length + 1) / steps(), 'Rendering the bed');

	// 3. Speech: transcript words, and voice activity of untranscribed dialogue clips per cluster.
	const words = (() => {
		try {
			return sequenceWords(input.bedDoc, bedSeq);
		} catch {
			return [];
		}
	})();
	const wordSpans = words
		.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
		.map((w) => ({
			start: w.start / FLICKS_PER_SECOND,
			end: Math.max(w.start, w.end) / FLICKS_PER_SECOND,
			track: `A${w.track + 1}`,
		}));
	const transcribed = new Set(words.map((w) => w.clipId));
	const dialogueIds = new Set(
		Object.values(bedSeq.clips)
			.filter(
				(c) =>
					c.kind === 'audio' &&
					!sfxIds.has(c.id) &&
					!transcribed.has(c.id) &&
					(c as { essential?: { type?: unknown } }).essential?.type === 'dialogue',
			)
			.map((c) => c.id),
	);
	const dialogueClips = bedClips.filter((c) => dialogueIds.has(c.clipId));
	const voiced: { start: number; end: number; tracks: string[] }[] = [];
	await pool(beds, concurrency, async (b) => {
		const playing = overlapping(dialogueClips, b.range);
		if (playing.length === 0) return;
		const r = await renderPcm(bedWorld, b.range, new Set(playing.map((c) => c.clipId)), deps);
		renders.voice++;
		const db = frameLevels(r.pcm, sr);
		const th = Math.max(vadThreshold(db), VAD_FLOOR_DBFS);
		const tracks = [...new Set(playing.map((c) => trackLabel(bedSeq, c.trackId)))];
		const hop = Math.max(1, Math.round(sr / 100)) / sr;
		const t0 = r.pcm.startSample / sr;
		for (let f = 0; f < db.length; f++)
			if (db[f]! >= th) voiced.push({ start: t0 + f * hop, end: t0 + (f + 1) * hop, tracks });
	});

	// 4. Per sound: the bed over its window, its speech, the bed tracks under it.
	const sounds = new Map<string, MeasuredSound>();
	for (const { target, m } of ok) {
		const span = bedSpanOf(m.window, target.weight);
		const b = beds.find((x) => {
			const s0 = x.pcm.startSample / sr;
			const s1 = s0 + (x.pcm.channels[0]?.length ?? 0) / sr;
			return s0 <= span.start + 1e-6 && s1 >= Math.min(span.end, m.window.end) - 1e-6;
		});
		const rel = b ? relative(m.window, b.pcm, sr) : null;
		const bedBandsDb = b && rel ? bandLevels(b.pcm.channels, sr, rel) : bandLevels([], sr, m.window);
		const lp = b && rel ? bedLocalPeakLu(b.pcm.channels, sr, rel, target.weight) : Number.NEGATIVE_INFINITY;
		const overlaps = (s: { start: number; end: number }) => s.start < m.window.end && s.end > m.window.start;
		const speechTracks = new Set<string>();
		for (const w of wordSpans) if (overlaps(w)) speechTracks.add(w.track);
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
			bedBandsDb,
			bedLocalPeakLu: Number.isFinite(lp) ? lp : null,
			speechOverlap: speechTracks.size > 0,
			speechTracks: [...speechTracks].sort(),
			bedTracks,
		});
	}
	deps.onProgress?.(1, 'Measured');
	return { sampleRate: sr, sounds, missing, clusters, renders };
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
	const r = await renderPcm(world, range, ids, deps);
	return {
		sampleRate: r.sampleRate,
		startSample: r.pcm.startSample,
		channels: r.pcm.channels,
		truePeakDb: r.truePeakDb,
	};
}
