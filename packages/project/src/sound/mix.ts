// Mixing moves of sound design (spec 12 §2.4 "Stop-before", "Build", "Room glue", P4-R3; wp-note "Phase 4 → WP4.2a"),
// as pure helpers of the commands in `commands/handlers/sound-mix.ts`:
//
// - DIPS: a dip lowers a volume curve by `depthDb` over [start, end] with `fadeMs` linear ramps outside it. It MERGES with
//   the existing curve E by taking the minimum: inside each dip window W = [start − fade, end + fade] the result is
//   min(E(t), D(t)), D(t) = ref + env(t), ref = the larger of E at the window's two edges (the local level, so a static
//   −3 dB clip dips to −27 dB and a ducked one is not ducked twice), env = 0 at the edges, `depthDb` on the floor. At the
//   edges D ≥ E, so the result is continuous and E is untouched outside W: keyframes outside W are never replaced. Exact
//   for linear and hold curves; a Bézier segment crossing an edge widens W to its keyframe (that segment is resampled
//   every 5 ms with linear keys: within the sampling error of its curve).
// - STOP-BEFORE of a hero at T: one dip [T − seconds, T − 10 ms], 30 ms fades (down from T − s − 30 ms, back at
//   T + 20 ms), on the music under it.
// - BUILD of a hero at T: the cutoff of a 2nd-order Butterworth High Pass sweeps 20 Hz → fromHz at T − seconds →
//   toHz at T − 1 frame (exponential in frequency: log-spaced keys) → back to 20 Hz at T.
// - ROOM GLUE: which tracks send to the "SFX Room" bus: tracks of sound effects, not the ones whose sound effects are all
//   interface sounds (ui, click, key, tick: dry by design), not the ones also playing bed (dialogue, music, ambience:
//   sends are per track).
import { readEssentialSound } from '../essential/model.ts';
import { EASE_PRESETS, evaluate } from '../keyframes.ts';
import type { Animatable, Keyframe } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { AudioClip, Clip, Sequence } from '../schema/sequence.ts';
import { readSoundDesignSettings, type SoundDesign } from '../schema/sound.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import { readLibraryProvenance } from './provenance.ts';
import { isSfxClip } from './sfx-clip.ts';

/** A dip in sequence flicks: `depthDb` (≤ 0) over [start, end], linear fades of `fadeMs` before and after. */
export type Dip = { start: number; end: number; depthDb: number; fadeMs: number };

/** Stop-before ramps (ms): down over 30 ms before `T − seconds`, floor until T − 10 ms, back up at T + 20 ms. */
export const STOP_BEFORE_FADE_MS = 30;
export const STOP_BEFORE_END_MS = 10;
/** Stop Before Next's default (WP2.4a's cue menu): 0.25 s at −24 dB. */
export const STOP_BEFORE_DEFAULT = { seconds: 0.25, depthDb: -24 } as const;
/** The build filter: `jasper.audio.scientific-filter`, Butterworth High Pass, order 2. */
export const BUILD_FILTER_EFFECT_ID = 'jasper.audio.scientific-filter';
export const BUILD_FILTER_PARAMS = { type: 'butterworth', mode: 'highPass', order: 2 } as const;
/** The cutoff at rest (the filter's lowest: no audible effect). */
export const BUILD_REST_HZ = 20;
/** The sweep's lead-in from rest to `fromHz` (ms). */
export const BUILD_LEAD_MS = 50;
/** Keys of the exponential sweep fromHz → toHz. */
export const BUILD_SWEEP_KEYS = 8;
/** Build defaults the plan uses (a hero after ≥ 2 s of music). */
export const BUILD_DEFAULT = { seconds: 2, fromHz: 150, toHz: 2000 } as const;
/** Least music before a hero for an automatic build (s). */
export const BUILD_MIN_MUSIC_SEC = 2;
/** Room glue defaults (spec 12 §2.4). */
export const ROOM_GLUE_DEFAULT = { sendDb: -16, decay: 0.6, mix: 100, preDelayMs: 8 } as const;
export const ROOM_BUS_NAME = 'SFX Room';
export const ROOM_REVERB_EFFECT_ID = 'jasper.audio.studio-reverb';
/** Interface sound types: dry (spec 12 §2.4 "Interface types get no send"). */
export const INTERFACE_SOUND_TYPES: readonly string[] = ['ui', 'click', 'key', 'tick'];
/** Spacing of the samples a non-linear curve segment is rebuilt from (flicks: 5 ms). */
const RESAMPLE_FLICKS = FLICKS_PER_SECOND / 200;
const MS = FLICKS_PER_SECOND / 1000;

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Shortest dip fade (ms): a 0 ms fade is a 1 ms ramp (a step would click, and the window's edges must be at rest). */
export const MIN_DIP_FADE_MS = 1;
const fadeOf = (d: Dip) => Math.max(MIN_DIP_FADE_MS, fin(d.fadeMs) ? d.fadeMs : 0) * MS;

/** The dip envelope (dB, ≤ 0) of several dips at `t`: the deepest of them. */
export function dipEnvelopeAt(dips: readonly Dip[], t: number): number {
	let v = 0;
	for (const d of dips) {
		const f = fadeOf(d);
		const depth = Math.min(0, d.depthDb);
		let e = 0;
		if (t >= d.start && t <= d.end) e = depth;
		else if (t < d.start && t > d.start - f) e = (depth * (t - (d.start - f))) / f;
		else if (t > d.end && t < d.end + f) e = (depth * (d.end + f - t)) / f;
		if (e < v) v = e;
	}
	return v;
}

/** The stop-before dip of a hero at frame `frame` (sequence flicks), or null when it has no length. */
export function stopBeforeDip(
	frame: number,
	spec: { seconds: number; depthDb: number },
	rate: Rational,
): Dip | null {
	const T = frame * flicksPerFrame(rate);
	const s = Math.max(0, spec.seconds) * FLICKS_PER_SECOND;
	const end = T - STOP_BEFORE_END_MS * MS;
	const start = T - s;
	if (!(end > start) || !(spec.depthDb < 0)) return null;
	return { start, end, depthDb: spec.depthDb, fadeMs: STOP_BEFORE_FADE_MS };
}

/** How a volume / cutoff lane's time maps to sequence flicks and back (monotone; decreasing for reversed clips). */
export type LaneTime = {
	toLane(seqFlicks: number): number;
	toSeq(laneFlicks: number): number;
	/** Sequence span the lane plays (a clip's span; −∞…∞ for a track). */
	span: [number, number];
};

/** Sequence-time lane (track volume, track inserts). */
export const SEQUENCE_LANE: LaneTime = {
	toLane: (t) => t,
	toSeq: (t) => t,
	span: [0, Number.POSITIVE_INFINITY],
};

/** Content-time lane of an audio clip (its Volume, its effects), like the mixer's `contentAt`. */
export function clipLaneTime(
	clip: Pick<Clip, 'start' | 'duration' | 'sourceIn'> & { speed: { rate: number; reverse: boolean } },
	rate: Rational,
): LaneTime {
	const F = flicksPerFrame(rate);
	const r = clip.speed.rate > 0 ? clip.speed.rate : 1;
	const start = clip.start * F;
	const len = Math.max(0, clip.duration - 1e-9) * F;
	if (clip.speed.reverse) {
		// the mixer's reversed content time: sourceIn + (duration − 1 − local) frames
		const top = (clip.duration - 1) * F;
		return {
			toLane: (t) => clip.sourceIn + (top - Math.min(len, Math.max(0, t - start))) * r,
			toSeq: (k) => start + top - (k - clip.sourceIn) / r,
			span: [start, start + len],
		};
	}
	return {
		toLane: (t) => clip.sourceIn + Math.min(len, Math.max(0, t - start)) * r,
		toSeq: (k) => start + (k - clip.sourceIn) / r,
		span: [start, start + len],
	};
}

/** Whether the segment that starts at key `i` is a straight line or a step (linear / hold), not a curve. */
function straightFrom(kfs: readonly Keyframe<number>[], i: number): boolean {
	const k = kfs[i];
	if (!k) return true;
	if (k.roving || kfs[i + 1]?.roving) return false;
	return k.interpolation === 'linear' || k.interpolation === 'hold';
}

/** Index of the last key at or before lane time `k` (−1 before the first). */
function keyAtOrBefore(kfs: readonly Keyframe<number>[], k: number): number {
	let i = -1;
	for (let j = 0; j < kfs.length; j++) if (kfs[j]!.time <= k) i = j;
	return i;
}

export type CurveWrite = {
	keyframes: Keyframe<number>[];
	/** Ids of the keys added. */
	written: string[];
	/** Keys removed (their range was rewritten). */
	replaced: Keyframe<number>[];
};

const newKey = (id: string, time: number, value: number, hold = false): Keyframe<number> => ({
	id,
	time,
	value,
	interpolation: hold ? 'hold' : 'linear',
	easeIn: { ...EASE_PRESETS.linear },
	easeOut: { ...EASE_PRESETS.linear },
});

/**
 * Rewrites the keys of `anim` (lane time) in the lane range of the sequence span [ws, we] with `points` (sequence
 * flicks, values), keeping every key outside it; the last new key takes the interpolation of the segment it continues
 * (hold stays hold). Returns the new keys, the ids added and the keys replaced. Pure.
 */
export function writeCurve(
	anim: Animatable<number>,
	lane: LaneTime,
	ws: number,
	we: number,
	points: readonly (readonly [number, number])[],
	newId: () => string,
): CurveWrite {
	const a = lane.toLane(ws);
	const b = lane.toLane(we);
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	const kfs = anim.keyframes;
	const gov = keyAtOrBefore(kfs, hi);
	const hold = gov >= 0 && kfs[gov]!.interpolation === 'hold';
	const kept: Keyframe<number>[] = [];
	const replaced: Keyframe<number>[] = [];
	for (const k of kfs) (k.time >= Math.round(lo) && k.time <= Math.round(hi) ? replaced : kept).push(k);
	const byTime = new Map<number, number>();
	for (const [t, v] of points) {
		const k = Math.round(lane.toLane(t));
		const prev = byTime.get(k);
		byTime.set(k, prev === undefined ? v : Math.min(prev, v));
	}
	const times = [...byTime.keys()].sort((x, y) => x - y);
	const written: string[] = [];
	const added = times.map((t, i) => {
		const id = newId();
		written.push(id);
		return newKey(id, t, byTime.get(t)!, hold && i === times.length - 1);
	});
	const keyframes = [...kept.filter((k) => !byTime.has(k.time)), ...added].sort((x, y) => x.time - y.time);
	// a kept key at a written time would be lost: count it as replaced (given back on removal)
	for (const k of kept) if (byTime.has(k.time)) replaced.push(k);
	return { keyframes, written, replaced };
}

/**
 * Merges dips into a volume curve (lane `anim`, its lane time `lane`; dips in sequence flicks) by taking the minimum
 * (see the module docs). `clamp` bounds the values (dB). Returns null when no dip falls in the lane's span. Pure.
 */
export function mergeDips(
	anim: Animatable<number>,
	lane: LaneTime,
	dips: readonly Dip[],
	opts: { newId: () => string; clamp?: [number, number] },
): (CurveWrite & { windows: [number, number][] }) | null {
	const [cmin, cmax] = opts.clamp ?? [-96, 15];
	const clampV = (v: number) => Math.min(cmax, Math.max(cmin, v));
	const valid = dips.filter(
		(d) => fin(d.start) && fin(d.end) && d.end >= d.start && fin(d.depthDb) && fin(d.fadeMs),
	);
	// Windows: each dip with its fades, inside the lane's span, overlapping ones merged.
	const raw = valid
		.map((d) => {
			const f = fadeOf(d);
			return [Math.max(lane.span[0], d.start - f), Math.min(lane.span[1], d.end + f)] as [number, number];
		})
		.filter(([s, e]) => e > s)
		.sort((x, y) => x[0] - y[0]);
	const windows: [number, number][] = [];
	for (const w of raw) {
		const last = windows[windows.length - 1];
		if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
		else windows.push([w[0], w[1]]);
	}
	if (windows.length === 0) return null;
	let cur: Animatable<number> = { ...anim, keyframes: [...anim.keyframes] };
	const written: string[] = [];
	const replaced: Keyframe<number>[] = [];
	const E = (t: number) => evaluate(cur, lane.toLane(t));
	const seqTimes = () => cur.keyframes.map((k) => lane.toSeq(k.time));
	for (const w0 of windows) {
		let [ws, we] = w0;
		// A curved segment across an edge: widen the window to its key (the curve is rebuilt from samples).
		for (let guard = 0; guard < 4; guard++) {
			const kfs = cur.keyframes;
			let moved = false;
			for (const edge of [ws, we]) {
				const k = lane.toLane(edge);
				const i = keyAtOrBefore(kfs, k);
				if (i < 0 || i >= kfs.length - 1 || straightFrom(kfs, i)) continue;
				const ta = lane.toSeq(kfs[i]!.time);
				const tb = lane.toSeq(kfs[i + 1]!.time);
				const nws = Math.max(lane.span[0], Math.min(ws, ta, tb));
				const nwe = Math.min(lane.span[1], Math.max(we, ta, tb));
				if (nws < ws || nwe > we) {
					ws = nws;
					we = nwe;
					moved = true;
				}
			}
			if (!moved) break;
		}
		const ref = Math.max(E(ws), E(we));
		const D = (t: number) => clampV(ref + dipEnvelopeAt(valid, t));
		const pts = new Set<number>([ws, we]);
		for (const d of valid) {
			const f = fadeOf(d);
			for (const t of [d.start - f, d.start, d.end, d.end + f]) if (t > ws && t < we) pts.add(t);
		}
		// Overlapping dips: where one's ramp crosses another's (the deepest wins: a kink of the dip curve).
		if (valid.length > 1) {
			const corners = [...pts].sort((x, y) => x - y);
			for (let c = 0; c + 1 < corners.length; c++) {
				const a = corners[c]!;
				const b = corners[c + 1]!;
				const va = valid.map((d) => dipEnvelopeAt([d], a));
				const vb = valid.map((d) => dipEnvelopeAt([d], b));
				for (let i = 0; i < valid.length; i++)
					for (let j = i + 1; j < valid.length; j++) {
						const da = va[i]! - va[j]!;
						const db = vb[i]! - vb[j]!;
						if ((da > 0 && db < 0) || (da < 0 && db > 0)) pts.add(a + ((b - a) * da) / (da - db));
					}
			}
		}
		const kfs = cur.keyframes;
		const st = seqTimes();
		for (let i = 0; i < kfs.length; i++) {
			const t = st[i]!;
			if (t > ws && t < we) {
				pts.add(t);
				// a step: the value just before it too
				const prevHold = i > 0 && kfs[i - 1]!.interpolation === 'hold';
				if (prevHold) {
					const tb = lane.toSeq(kfs[i]!.time - 1);
					const ta = lane.toSeq(kfs[i]!.time + 1);
					for (const x of [tb, ta]) if (x > ws && x < we) pts.add(x);
				}
			}
		}
		// curved segments inside: samples
		for (let i = 0; i < kfs.length - 1; i++) {
			if (straightFrom(kfs, i)) continue;
			const a = Math.max(ws, Math.min(st[i]!, st[i + 1]!));
			const b = Math.min(we, Math.max(st[i]!, st[i + 1]!));
			for (let t = a + RESAMPLE_FLICKS; t < b; t += RESAMPLE_FLICKS) pts.add(t);
		}
		// Values at the times the keys are stored at (whole lane flicks), so the curve outside stays the same line.
		const snap = (t: number) => lane.toSeq(Math.round(lane.toLane(t)));
		const times = [...new Set([...pts].map(snap))]
			.filter((t) => t >= ws - 1 && t <= we + 1)
			.sort((x, y) => x - y);
		const out: [number, number][] = [];
		for (let i = 0; i < times.length; i++) {
			const t = times[i]!;
			const e = E(t);
			const d = D(t);
			out.push([t, Math.min(e, d)]);
			const tn = times[i + 1];
			if (tn === undefined) break;
			// where the two lines cross between two breakpoints
			const en = E(tn);
			const dn = D(tn);
			const g0 = e - d;
			const g1 = en - dn;
			if ((g0 > 1e-9 && g1 < -1e-9) || (g0 < -1e-9 && g1 > 1e-9)) {
				const tc = snap(t + ((tn - t) * g0) / (g0 - g1));
				if (tc > t && tc < tn) out.push([tc, Math.min(E(tc), D(tc))]);
			}
		}
		const w = writeCurve(cur, lane, ws, we, out, opts.newId);
		cur = { ...cur, keyframes: w.keyframes };
		written.push(...w.written);
		// a key this call added and a later window replaced is not the document's: not given back
		for (const k of w.replaced) {
			const own = written.indexOf(k.id);
			if (own >= 0) written.splice(own, 1);
			else replaced.push(k);
		}
	}
	return { keyframes: cur.keyframes, written, replaced, windows };
}

/**
 * Takes a recorded write back out of a curve: the keys it added go; when all of them are still there (nobody rewrote
 * the range since) the keys it replaced come back. Returns the new keys and whether the removal was exact. Pure.
 */
export function unwriteCurve(
	keyframes: readonly Keyframe<number>[],
	write: { written: readonly string[]; replaced: readonly Keyframe<number>[] },
): { keyframes: Keyframe<number>[]; exact: boolean } {
	const ids = new Set(write.written);
	const present = keyframes.filter((k) => ids.has(k.id)).length;
	const exact = present === ids.size;
	const kept = keyframes.filter((k) => !ids.has(k.id));
	if (exact) {
		const times = new Set(kept.map((k) => k.time));
		for (const k of write.replaced)
			if (!times.has(k.time)) kept.push({ ...k, easeIn: { ...k.easeIn }, easeOut: { ...k.easeOut } });
	}
	return { keyframes: kept.sort((a, b) => a.time - b.time), exact };
}

/**
 * The build's cutoff points (sequence flicks, Hz) for a hero at frame `frame`: rest → fromHz at T − seconds (50 ms
 * lead-in) → toHz at T − 1 frame, exponential in frequency (log-spaced keys) → rest at T. `rest` = the curve's value
 * at the window's edges (20 Hz on a new filter). Null when the window has no length.
 */
export function buildSweepPoints(
	frame: number,
	spec: { seconds: number; fromHz: number; toHz: number },
	rate: Rational,
	restHz: number = BUILD_REST_HZ,
): { ws: number; we: number; points: [number, number][] } | null {
	const F = flicksPerFrame(rate);
	const T = frame * F;
	const top = T - F;
	const start = T - Math.max(0, spec.seconds) * FLICKS_PER_SECOND;
	if (!(top > start) || !(T > 0)) return null;
	const ws = Math.max(0, start - BUILD_LEAD_MS * MS);
	const lo = Math.log2(Math.max(20, spec.fromHz));
	const hi = Math.log2(Math.max(20, spec.toHz));
	const points: [number, number][] = [];
	if (ws < start) points.push([ws, restHz]);
	for (let i = 0; i <= BUILD_SWEEP_KEYS; i++) {
		const u = i / BUILD_SWEEP_KEYS;
		points.push([start + (top - start) * u, Math.round(2 ** (lo + (hi - lo) * u) * 100) / 100]);
	}
	points.push([T, restHz]);
	return { ws, we: T, points };
}

/** An audio clip's Essential Sound type, or null. */
export function essentialTypeOf(c: Clip): string | null {
	if (c.kind !== 'audio') return null;
	return readEssentialSound((c as AudioClip).essential)?.type ?? null;
}

export type MusicTrackUse = {
	trackId: string;
	/** The music (or ambience) clips under the window. */
	clipIds: string[];
	/** Other audio plays on the track in the window (dialogue, sound effects): the track's lane cannot be used. */
	shared: boolean;
	/** The track's automation mode is Off (its lane is not played) or it is locked. */
	automationOff: boolean;
	locked: boolean;
};

/**
 * The audio tracks with music (Essential Sound type in `types`, default music) playing in [a, b] (sequence frames), and
 * whether something else plays there on the same track. Enabled `audio` clips only. Pure.
 */
export function musicTracksUnder(
	seq: Sequence,
	a: number,
	b: number,
	types: readonly string[] = ['music'],
): MusicTrackUse[] {
	const out: MusicTrackUse[] = [];
	for (const t of seq.audioTracks) {
		const clips = Object.values(seq.clips).filter(
			(c) => c.trackId === t.id && c.enabled !== false && c.start < b && c.start + c.duration > a,
		);
		const music = clips.filter((c) => {
			const ty = essentialTypeOf(c);
			return ty !== null && types.includes(ty);
		});
		if (music.length === 0) continue;
		out.push({
			trackId: t.id,
			clipIds: music.map((c) => c.id).sort(),
			shared: clips.some((c) => !music.includes(c)),
			automationOff: (t.mixer?.automation ?? 'read') === 'off',
			locked: !!t.locked,
		});
	}
	return out;
}

/** Whether music (types) plays under the whole of [a, b] (sequence frames) on some track. */
export function musicCovers(
	seq: Sequence,
	a: number,
	b: number,
	types: readonly string[] = ['music'],
): boolean {
	const spans = Object.values(seq.clips)
		.filter((c) => c.enabled !== false && types.includes(essentialTypeOf(c) ?? ''))
		.map((c) => [c.start, c.start + c.duration] as [number, number])
		.sort((x, y) => x[0] - y[0]);
	let at = a;
	for (const [s, e] of spans) {
		if (s > at) break;
		if (e > at) at = e;
		if (at >= b) return true;
	}
	return at >= b;
}

/** Whether a sound's types are all interface types (ui, click, key, tick). */
export function isInterfaceSound(types: readonly unknown[] | null | undefined): boolean {
	return (
		Array.isArray(types) &&
		types.length > 0 &&
		types.every((t) => INTERFACE_SOUND_TYPES.includes(t as string))
	);
}

/** Whether an audio clip is an interface sound (its media's library types). */
export function isInterfaceClip(doc: Pick<ProjectDocument, 'media'>, c: Clip): boolean {
	if (c.kind !== 'audio') return false;
	const media = doc.media?.[(c as AudioClip).mediaId] as { library?: unknown } | undefined;
	return isInterfaceSound(readLibraryProvenance(media?.library)?.types);
}

export type RoomSendDecision = { trackId: string; send: boolean; reason: string };

/**
 * Which tracks send to the room bus (the rule of the module docs): `explicit` tracks (ids) when given — they send unless
 * all their sound effects are interface sounds; else the sequence's SFX tracks (`settings.sfxTrackIds`) and every track
 * holding a sound effect, minus tracks that also hold bed clips (sends are per track) and tracks whose sound effects are
 * all interface sounds. Pure.
 */
export function roomSendPlan(
	doc: Pick<ProjectDocument, 'media'>,
	seq: Sequence,
	explicit?: readonly string[],
): RoomSendDecision[] {
	const settings = readSoundDesignSettings((seq.soundDesign as SoundDesign | undefined)?.settings);
	const candidates = explicit
		? [...new Set(explicit)]
		: seq.audioTracks
				.map((t) => t.id)
				.filter(
					(id) =>
						settings.sfxTrackIds.includes(id) ||
						Object.values(seq.clips).some((c) => c.trackId === id && isSfxClip(c)),
				);
	const out: RoomSendDecision[] = [];
	for (const id of candidates) {
		const label = `A${seq.audioTracks.findIndex((t) => t.id === id) + 1}`;
		const clips = Object.values(seq.clips).filter((c) => c.trackId === id && c.kind === 'audio');
		const sfx = clips.filter((c) => isSfxClip(c));
		const bed = clips.filter((c) => !isSfxClip(c));
		if (sfx.length > 0 && sfx.every((c) => isInterfaceClip(doc, c))) {
			out.push({ trackId: id, send: false, reason: `${label}: only interface sounds (dry)` });
			continue;
		}
		if (!explicit && bed.length > 0) {
			out.push({
				trackId: id,
				send: false,
				reason: `${label} also plays dialogue, music or other bed audio (sends are per track)`,
			});
			continue;
		}
		out.push({ trackId: id, send: true, reason: `${label}: sound effects` });
	}
	return out;
}
