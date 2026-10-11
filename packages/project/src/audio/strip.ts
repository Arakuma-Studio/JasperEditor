// Audio Track Mixer model helpers (audio-mix): strips (audio tracks, submixes, the Mix), read-time defaults of the
// optional mixer fields, strip addressing (`A1`, `S1`, `Mix`), automation lanes and automation writing.
//
// Lanes (keyframes in sequence time, flicks):
//
// | lane | value | stored in |
// |---|---|---|
// | `volume` | fader, dB (−96 = −∞ … +15) | `Track.volumeDb` / `master.volumeDb` |
// | `pan` | pan / balance −100 … 100 | `Track.pan` |
// | `mute` | 0 / 1 (hold) | `Track.mixer.lanes.mute` (static: `Track.mute`) |
// | `pan51.x`, `pan51.y` | 5.1 panner puck −100 … 100 (left/rear … right/front) | `Track.mixer.lanes` |
// | `pan51.center` | 5.1 Center % 0 … 100 | `Track.mixer.lanes` |
// | `pan51.lfe` | 5.1 LFE level dB | `Track.mixer.lanes` |
// | `send.<sendId>.level` | send level dB | `TrackSend.levelDb` |

import { EASE_PRESETS, evaluate } from '../keyframes.ts';
import type {
	AudioChannelFormat,
	AutomationMode,
	InputMap,
	LoudnessNormalize,
	TrackSend,
} from '../schema/audio.ts';
import { LANE_MUTE, LANE_PAN51_CENTER, LANE_PAN51_LFE, LANE_PAN51_X, LANE_PAN51_Y } from '../schema/audio.ts';
import type { Animatable, Keyframe } from '../schema/common.ts';
import type { EffectInstance, Sequence, Track } from '../schema/sequence.ts';

export const LANE_VOLUME = 'volume';
export const LANE_PAN = 'pan';
/** Strip id of the Mix (master) track. */
export const MASTER_STRIP_ID = 'master';
/** Fader range (dB): −∞ (≤ −96) … +15 dB, like Premiere's Audio Track Mixer. */
export const FADER_MIN_DB = -96;
export const FADER_MAX_DB = 15;
/** Premiere: 5 effect slots and 5 send slots per strip. */
export const MAX_INSERTS = 5;
export const MAX_SENDS = 5;

export type StripKind = 'track' | 'submix' | 'master';

/** A read-only view of one mixer strip. The Mix is presented as a Track-like object. */
export type StripView = {
	id: string;
	kind: StripKind;
	/** `A1`…, `S1`…, `Mix`. */
	label: string;
	/** Display name: the track name, else the label (`Mix` for the master). */
	name: string;
	format: AudioChannelFormat;
	automation: AutomationMode;
	volumeDb: Animatable<number>;
	pan: Animatable<number>;
	mute: boolean;
	solo: boolean;
	soloSafe: boolean;
	recordArm: boolean;
	inputMap: InputMap;
	/** Destination strip id (`master` or a submix id); null for the Mix. */
	output: string | null;
	sends: TrackSend[];
	lanes: Record<string, Animatable<number>>;
	effects: EffectInstance[];
	locked: boolean;
};

const ZERO: Animatable<number> = { value: 0, keyframes: [] };

export function formatWidth(f: AudioChannelFormat): 1 | 2 | 6 {
	return f === 'mono' ? 1 : f === '5.1' ? 6 : 2;
}

export function trackFormat(t: Pick<Track, 'channelFormat'>): AudioChannelFormat {
	return t.channelFormat ?? 'stereo';
}

export function masterFormat(seq: Pick<Sequence, 'settings'>): AudioChannelFormat {
	return (seq.settings.masterLayout as AudioChannelFormat | undefined) ?? 'stereo';
}

export function sequenceSampleRate(seq: Pick<Sequence, 'settings'>): number {
	return (seq.settings.audioSampleRate as number | undefined) ?? 48000;
}

export function submixTracksOf(seq: Pick<Sequence, 'submixTracks'>): Track[] {
	return (seq.submixTracks as Track[] | undefined) ?? [];
}

function trackView(seq: Sequence, t: Track, kind: 'track' | 'submix', index: number): StripView {
	const label = `${kind === 'track' ? 'A' : 'S'}${index + 1}`;
	const out = t.mixer?.output ?? null;
	const outputOk = out !== null && submixTracksOf(seq).some((s) => s.id === out);
	return {
		id: t.id,
		kind,
		label,
		name: t.name ?? (kind === 'track' ? `Audio ${index + 1}` : `Submix ${index + 1}`),
		format: trackFormat(t),
		automation: t.mixer?.automation ?? 'read',
		volumeDb: t.volumeDb ?? ZERO,
		pan: t.pan ?? ZERO,
		mute: !!t.mute,
		solo: !!t.solo,
		soloSafe: !!t.mixer?.soloSafe,
		recordArm: !!t.mixer?.recordArm,
		inputMap: t.mixer?.inputMap ?? 'stereo',
		output: outputOk ? out : MASTER_STRIP_ID,
		sends: (t.mixer?.sends ?? []) as TrackSend[],
		lanes: (t.mixer?.lanes ?? {}) as Record<string, Animatable<number>>,
		effects: (t.effects ?? []) as EffectInstance[],
		locked: t.locked,
	};
}

export function masterView(seq: Sequence): StripView {
	return {
		id: MASTER_STRIP_ID,
		kind: 'master',
		label: 'Mix',
		name: 'Mix',
		format: masterFormat(seq),
		automation: seq.master.mixer?.automation ?? 'read',
		volumeDb: seq.master.volumeDb,
		pan: ZERO,
		mute: false,
		solo: false,
		soloSafe: true,
		recordArm: false,
		inputMap: 'stereo',
		output: null,
		sends: [],
		lanes: {},
		effects: seq.master.effects as EffectInstance[],
		locked: false,
	};
}

/** All strips in mixer order: audio tracks, submixes, the Mix. */
export function listStrips(seq: Sequence): StripView[] {
	return [
		...seq.audioTracks.map((t, i) => trackView(seq, t, 'track', i)),
		...submixTracksOf(seq).map((t, i) => trackView(seq, t, 'submix', i)),
		masterView(seq),
	];
}

export function stripView(seq: Sequence, id: string): StripView | null {
	if (id === MASTER_STRIP_ID) return masterView(seq);
	const a = seq.audioTracks.findIndex((t) => t.id === id);
	if (a >= 0) return trackView(seq, seq.audioTracks[a]!, 'track', a);
	const subs = submixTracksOf(seq);
	const s = subs.findIndex((t) => t.id === id);
	if (s >= 0) return trackView(seq, subs[s]!, 'submix', s);
	return null;
}

/**
 * Strip id for a reference: `Mix` / `master` / `M`, `A1`…, `S1`…, a track id, or a track name (case-insensitive).
 */
export function resolveStripRef(seq: Sequence, ref: string): string | null {
	const r = ref.trim();
	if (/^(mix|master|m)$/i.test(r) || r === MASTER_STRIP_ID) return MASTER_STRIP_ID;
	const m = /^([AS])(\d+)$/i.exec(r);
	if (m) {
		const list = m[1]!.toUpperCase() === 'A' ? seq.audioTracks : submixTracksOf(seq);
		return list[Number(m[2]) - 1]?.id ?? null;
	}
	for (const t of [...seq.audioTracks, ...submixTracksOf(seq)]) if (t.id === r) return t.id;
	const lower = r.toLowerCase();
	for (const s of listStrips(seq)) if (s.name.toLowerCase() === lower) return s.id;
	return null;
}

/** The Track object behind a strip (audio or submix track); null for the Mix. */
export function stripTrack<T extends Pick<Sequence, 'audioTracks' | 'submixTracks'>>(
	seq: T,
	id: string,
): T['audioTracks'][number] | null {
	return (
		seq.audioTracks.find((t) => t.id === id) ??
		((seq.submixTracks ?? []) as T['audioTracks']).find((t) => t.id === id) ??
		null
	);
}

/** Channel format of the bus strip `id` feeds (its output submix, or the Mix). */
export function outputFormatOf(seq: Sequence, id: string): AudioChannelFormat {
	if (id === MASTER_STRIP_ID) return masterFormat(seq);
	const v = stripView(seq, id);
	if (!v || v.output === MASTER_STRIP_ID || v.output === null) return masterFormat(seq);
	const s = submixTracksOf(seq).find((t) => t.id === v.output);
	return s ? trackFormat(s) : masterFormat(seq);
}

/** Whether strip `id` pans with the 5.1 panner (it feeds a 5.1 bus). */
export function pans51(seq: Sequence, id: string): boolean {
	return id !== MASTER_STRIP_ID && outputFormatOf(seq, id) === '5.1';
}

export type LaneInfo = { min: number; max: number; hold: boolean; unit: 'dB' | '' | '%' };

export function sendLane(sendId: string): string {
	return `send.${sendId}.level`;
}

export function parseSendLane(lane: string): string | null {
	const m = /^send\.(.+)\.level$/.exec(lane);
	return m ? m[1]! : null;
}

export function laneInfo(lane: string): LaneInfo | null {
	switch (lane) {
		case LANE_VOLUME:
		case LANE_PAN51_LFE:
			return { min: FADER_MIN_DB, max: FADER_MAX_DB, hold: false, unit: 'dB' };
		case LANE_PAN:
		case LANE_PAN51_X:
		case LANE_PAN51_Y:
			return { min: -100, max: 100, hold: false, unit: '' };
		case LANE_PAN51_CENTER:
			return { min: 0, max: 100, hold: false, unit: '%' };
		case LANE_MUTE:
			return { min: 0, max: 1, hold: true, unit: '' };
		default:
			return parseSendLane(lane) ? { min: FADER_MIN_DB, max: FADER_MAX_DB, hold: false, unit: 'dB' } : null;
	}
}

/** Default (static) value of a 5.1 panner lane: puck front centre, Center 100 %, LFE 0 dB for 5.1 strips else −∞. */
export function pan51Default(lane: string, format: AudioChannelFormat): number | null {
	switch (lane) {
		case LANE_PAN51_X:
			return 0;
		case LANE_PAN51_Y:
			return 100;
		case LANE_PAN51_CENTER:
			return 100;
		case LANE_PAN51_LFE:
			return format === '5.1' ? 0 : FADER_MIN_DB;
		default:
			return null;
	}
}

/** The animatable behind a lane, or null when the lane does not exist on the strip. */
export function laneAnimatable(s: StripView, lane: string): Animatable<number> | null {
	if (lane === LANE_VOLUME) return s.volumeDb;
	if (lane === LANE_PAN) return s.kind === 'master' ? null : s.pan;
	const send = parseSendLane(lane);
	if (send) return s.sends.find((x) => x.id === send)?.levelDb ?? null;
	if (s.kind === 'master') return null;
	const stored = s.lanes[lane];
	if (stored) return stored;
	if (lane === LANE_MUTE) return { value: s.mute ? 1 : 0, keyframes: [] };
	const d = pan51Default(lane, s.format);
	return d === null ? null : { value: d, keyframes: [] };
}

/** Value of a lane at sequence time `t` (flicks) as playback hears it: automation unless the mode is Off. */
export function laneValueAt(s: StripView, lane: string, t: number): number {
	const a = laneAnimatable(s, lane);
	if (!a) return 0;
	if (s.automation === 'off' || a.keyframes.length === 0)
		return lane === LANE_MUTE ? (s.mute ? 1 : 0) : a.value;
	if (laneInfo(lane)?.hold) return holdValueAt(a, t);
	return evaluate(a, t);
}

/** Value of a hold lane (mute) at `t`: the last keyframe at or before `t` (the first one before it). */
export function holdValueAt(a: Animatable<number>, t: number): number {
	const k = a.keyframes;
	if (k.length === 0) return a.value;
	let v = k[0]!.value;
	for (const x of k) {
		if (x.time <= t) v = x.value;
		else break;
	}
	return v;
}

export function clampLane(lane: string, v: number): number {
	const i = laneInfo(lane);
	if (!i) return v;
	const c = Math.min(i.max, Math.max(i.min, v)) + 0; // + 0: no −0 in documents
	return i.hold ? (c >= 0.5 ? 1 : 0) : c;
}

/** Automated lanes of a strip (keyframed). */
export function automatedLanes(s: StripView): string[] {
	const out: string[] = [];
	if (s.volumeDb.keyframes.length) out.push(LANE_VOLUME);
	if (s.kind !== 'master' && s.pan.keyframes.length) out.push(LANE_PAN);
	for (const [k, a] of Object.entries(s.lanes)) if (a.keyframes.length) out.push(k);
	for (const x of s.sends) if (x.levelDb.keyframes.length) out.push(sendLane(x.id));
	return out;
}

/** Lanes a Write pass records on a strip (the 5.1 puck instead of pan when it feeds a 5.1 bus). */
export function writeLanes(seq: Sequence, id: string): string[] {
	if (id === MASTER_STRIP_ID) return [LANE_VOLUME];
	return pans51(seq, id)
		? [LANE_VOLUME, LANE_PAN51_X, LANE_PAN51_Y, LANE_MUTE]
		: [LANE_VOLUME, LANE_PAN, LANE_MUTE];
}

/**
 * Thins a recorded gesture `(t, value)` into keyframes: Ramer–Douglas–Peucker on the value axis (every dropped point
 * lies within `tolerance` of the line between its kept neighbours), then points closer than `minInterval` to the
 * previous kept one are dropped (except the last). Hold lanes keep only the points where the value changes.
 */
export function thinPoints(
	points: readonly (readonly [number, number])[],
	tolerance: number,
	minInterval: number,
	hold: boolean,
): [number, number][] {
	const pts: [number, number][] = [];
	for (const [t, v] of points) {
		const last = pts[pts.length - 1];
		if (last && last[0] === t) last[1] = v;
		else if (last && last[0] > t) continue;
		else pts.push([t, v]);
	}
	if (pts.length <= 2) return pts;
	if (hold) {
		const out: [number, number][] = [pts[0]!];
		for (let i = 1; i < pts.length; i++)
			if (Math.abs(pts[i]![1] - pts[i - 1]![1]) > Math.max(tolerance, 1e-9)) out.push(pts[i]!);
		return out;
	}
	const keep = new Uint8Array(pts.length);
	keep[0] = 1;
	keep[pts.length - 1] = 1;
	const stack: [number, number][] = [[0, pts.length - 1]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		if (b <= a + 1) continue;
		const [ta, va] = pts[a]!;
		const [tb, vb] = pts[b]!;
		let worst = 0;
		let wi = -1;
		for (let i = a + 1; i < b; i++) {
			const u = (pts[i]![0] - ta) / (tb - ta);
			const d = Math.abs(pts[i]![1] - (va + (vb - va) * u));
			if (d > worst) {
				worst = d;
				wi = i;
			}
		}
		if (wi >= 0 && worst > tolerance) {
			keep[wi] = 1;
			stack.push([a, wi], [wi, b]);
		}
	}
	const out: [number, number][] = [];
	for (let i = 0; i < pts.length; i++) {
		if (!keep[i]) continue;
		const last = out[out.length - 1];
		if (i + 1 < pts.length && minInterval > 0 && last && pts[i]![0] - last[0] < minInterval) continue;
		out.push(pts[i]!);
	}
	return out;
}

/**
 * Replaces the keyframes of `anim` within `[t0, t1]` by `points` (already thinned). `before` / `after` are the lane
 * values just outside the written range: when given, a keyframe is placed `eps` outside the range so the automation
 * outside `[t0, t1]` is unchanged. Returns the new keyframe list (sorted).
 */
export function writeLaneKeyframes(
	anim: Animatable<number>,
	t0: number,
	t1: number,
	points: readonly (readonly [number, number])[],
	opts: { before?: number | null; after?: number | null; eps: number; hold: boolean; newId: () => string },
): Keyframe<number>[] {
	const kept = anim.keyframes.filter((k) => k.time < t0 || k.time > t1);
	const map = new Map<number, Keyframe<number>>();
	for (const k of kept) map.set(k.time, k);
	const add = (t: number, v: number) => {
		if (t < 0) return;
		map.set(t, {
			id: opts.newId(),
			time: t,
			value: v,
			interpolation: opts.hold ? 'hold' : 'linear',
			easeIn: { ...EASE_PRESETS.linear },
			easeOut: { ...EASE_PRESETS.linear },
		});
	};
	if (opts.before !== undefined && opts.before !== null) add(t0 - opts.eps, opts.before);
	for (const [t, v] of points) if (t >= t0 && t <= t1) add(t, v);
	if (opts.after !== undefined && opts.after !== null) add(t1 + opts.eps, opts.after);
	return [...map.values()].sort((a, b) => a.time - b.time);
}

/** The loudness normalisation gain of the Mix (dB) and ceiling, when enabled and analysed. */
export function loudnessGainOf(
	l: LoudnessNormalize | undefined,
): { gainDb: number; truePeakDb: number; stale?: boolean } | null {
	if (!l?.enabled) return null;
	const i = l.analysis?.integratedLufs;
	if (i === null || i === undefined || !Number.isFinite(i)) return null;
	return { gainDb: l.targetLufs - i, truePeakDb: l.truePeakDb };
}
