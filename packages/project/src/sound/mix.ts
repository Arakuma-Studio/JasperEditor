// Mixing moves of sound design (spec 12 §2.4 "Stop-before", "Build", "Room glue", P4-R3; wp-note "Phase 4 → WP4.2a"),
// as pure helpers of the commands in `commands/handlers/sound-mix.ts`:
//
// - DIPS: a dip lowers a volume curve by `depthDb` over [start, end] with `fadeMs` linear ramps outside it. It MERGES with
//   the existing curve E by taking the minimum: inside each dip window W = [start − fade, end + fade] the result is
//   min(E(t), D(t)), D(t) = ref + env(t), ref = the larger of E at the window's two edges (the local level, so a static
//   −3 dB clip dips to −27 dB and a ducked one is not ducked twice), env = 0 at the edges, `depthDb` on the floor. At the
//   edges D ≥ E, so the result is continuous and E is untouched outside W: keyframes outside W are never replaced. Exact
//   for linear and hold curves. A curved segment (Bézier, auto-Bézier, roving) crossing an edge widens the rewritten
//   range to its keys: there D = +∞ where no dip is (the curve is kept), the segment is rebuilt from adaptive samples
//   (within 0.001 dB of the curve, ≥ 1 ms apart) and the edge keys keep the eases of the curve outside.
// - STOP-BEFORE of a hero at T: one dip [T − seconds, T − 10 ms], 30 ms fades (down from T − s − 30 ms, back at
//   T + 20 ms), on the music under it.
// - BUILD of a hero at T: the cutoff of a 2nd-order Butterworth High Pass sweeps 20 Hz → fromHz at T − seconds →
//   toHz at T − 1 frame (exponential in frequency: log-spaced keys) → back to 20 Hz at T.
// - ROOM GLUE: which tracks send to the "SFX Room" bus: tracks of sound effects, not the ones whose sound effects are all
//   interface sounds (ui, click, key, tick: dry by design), not the ones also playing bed (dialogue, music, ambience:
//   sends are per track).
import { readEssentialSound } from '../essential/model.ts';
import { EASE_PRESETS, evaluate, incomingEase, outgoingEase } from '../keyframes.ts';
import type { Animatable, Ease, Keyframe } from '../schema/common.ts';
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

/** How a written key interpolates (an edge key keeps the ease of the curve outside the range it rewrites). */
export type KeyShape = Pick<Keyframe<number>, 'interpolation' | 'easeIn' | 'easeOut'>;
/** A point to write: sequence flicks, value, and optionally the key's shape (default: linear). */
export type CurvePoint = readonly [number, number] | readonly [number, number, KeyShape];

const LINEAR: Ease = EASE_PRESETS.linear;

const newKey = (id: string, time: number, value: number, hold = false): Keyframe<number> => ({
	id,
	time,
	value,
	interpolation: hold ? 'hold' : 'linear',
	easeIn: { ...LINEAR },
	easeOut: { ...LINEAR },
});

/**
 * Rewrites the keys of `anim` (lane time) in the lane range of the sequence span [ws, we] with `points` (sequence
 * flicks, values, optional key shapes), keeping every key outside it; the last new key takes the interpolation of the
 * segment it continues (hold stays hold) unless its point gives a shape. Returns the new keys, the ids added and the
 * keys replaced. Pure.
 */
export function writeCurve(
	anim: Animatable<number>,
	lane: LaneTime,
	ws: number,
	we: number,
	points: readonly CurvePoint[],
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
	const shapes = new Map<number, KeyShape>();
	for (const p of points) {
		const k = Math.round(lane.toLane(p[0]));
		const prev = byTime.get(k);
		byTime.set(k, prev === undefined ? p[1] : Math.min(prev, p[1]));
		if (p[2] && !shapes.has(k)) shapes.set(k, p[2]);
	}
	const times = [...byTime.keys()].sort((x, y) => x - y);
	const written: string[] = [];
	const added = times.map((t, i) => {
		const id = newId();
		written.push(id);
		const key = newKey(id, t, byTime.get(t)!, hold && i === times.length - 1);
		const sh = shapes.get(t);
		if (sh)
			Object.assign(key, {
				interpolation: sh.interpolation,
				easeIn: { ...sh.easeIn },
				easeOut: { ...sh.easeOut },
			});
		return key;
	});
	const keyframes = [...kept.filter((k) => !byTime.has(k.time)), ...added].sort((x, y) => x.time - y.time);
	// a kept key at a written time would be lost: count it as replaced (given back on removal)
	for (const k of kept) if (byTime.has(k.time)) replaced.push(k);
	return { keyframes, written, replaced };
}

/** Least spacing of the samples a curved segment is rebuilt from (lane flicks: 1 ms; only steep eases get that close). */
const MIN_SAMPLE = FLICKS_PER_SECOND / 1000;
/** Largest deviation (dB) of the rebuilt line from a curved segment between two samples. */
const SAMPLE_TOLERANCE_DB = 1e-3;

/**
 * Sample times (lane flicks) of `f` over (a, b) so that the polyline through them stays within `SAMPLE_TOLERANCE_DB`
 * of `f` (checked at eighths), never closer than `MIN_SAMPLE`: a smooth Bézier gets a few dozen keys instead of
 * one every 5 ms as before. Pure.
 */
function adaptiveSamples(f: (k: number) => number, a: number, b: number, out: number[]): void {
	const go = (x0: number, v0: number, x1: number, v1: number, depth: number) => {
		if (x1 - x0 <= 2 * MIN_SAMPLE || depth > 30) return;
		const lin = (x: number) => v0 + ((v1 - v0) * (x - x0)) / (x1 - x0);
		const m = (x0 + x1) / 2;
		const vm = f(m);
		let ok = Math.abs(vm - lin(m)) <= SAMPLE_TOLERANCE_DB;
		for (let q = 1; ok && q < 8; q++) {
			if (q === 4) continue;
			const x = x0 + ((x1 - x0) * q) / 8;
			ok = Math.abs(f(x) - lin(x)) <= SAMPLE_TOLERANCE_DB;
		}
		if (ok) return;
		out.push(m);
		go(x0, v0, m, vm, depth + 1);
		go(m, vm, x1, v1, depth + 1);
	};
	if (b > a) go(a, f(a), b, f(b), 0);
}

/**
 * The lane range [lo, hi] (lane flicks) a write over [lo0, hi0] must cover so that the curve OUTSIDE it stays the same:
 * a curved segment (Bézier, auto-Bézier, roving) crossing an edge is rebuilt whole (to its keys; a roving run to its
 * fixed keys), and so is the segment into an auto-Bézier key just past an edge (its tangent follows its neighbours).
 * Only the segments that cross the edges widen it (never a cascade). Pure.
 */
function widenedRange(kfs: readonly Keyframe<number>[], lo0: number, hi0: number): [number, number] {
	let lo = lo0;
	let hi = hi0;
	const i = keyAtOrBefore(kfs, lo0);
	if (i >= 0 && kfs[i]!.time < lo0) {
		// lo0 inside the segment leaving key i (or past the last key: a key after an auto-Bézier last key bends it)
		const curved =
			i < kfs.length - 1
				? !straightFrom(kfs, i)
				: kfs[i]!.interpolation === 'auto-bezier' || !!kfs[i]!.roving;
		if (curved) {
			let a = i;
			while (a > 0 && kfs[a]!.roving) a--;
			lo = kfs[a]!.time;
		}
	}
	const j = keyAtOrBefore(kfs, hi0);
	const next = kfs[j + 1];
	if (next && (j < 0 || kfs[j]!.time < hi0)) {
		const curved = (j >= 0 && !straightFrom(kfs, j)) || next.interpolation === 'auto-bezier' || !!next.roving;
		if (curved) {
			let b = j + 1;
			while (b < kfs.length - 1 && kfs[b]!.roving) b++;
			hi = kfs[b]!.time;
		}
	}
	return [Math.min(lo, lo0), Math.max(hi, hi0)];
}

/**
 * Merges dips into a volume curve (lane `anim`, its lane time `lane`; dips in sequence flicks) by taking the minimum
 * (see the module docs). `clamp` bounds the values (dB). Returns null when no dip falls in the lane's span. `windows`
 * are the ranges actually rewritten (sequence flicks, widened over curved segments crossing an edge). Pure.
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
	const rewritten: [number, number][] = [];
	// Everything is measured on the curve as it was (the rewritten ranges below are disjoint).
	const E0 = (t: number) => evaluate(anim, lane.toLane(t));
	const E = E0;
	// The lane span in lane time (a clip's content range; the whole lane for a track).
	const spanA = lane.toLane(lane.span[0]);
	const spanB = Number.isFinite(lane.span[1]) ? lane.toLane(lane.span[1]) : Number.POSITIVE_INFINITY;
	const laneMin = Math.min(spanA, spanB);
	const laneMax = Math.max(spanA, spanB);
	// Each dip window's local level (E at its own edges, not the widened ones) and the dip curve: only where a dip is
	// (where the envelope is 0 the curve is left as it is: D = +∞); its continuous version (= ref at the window's
	// edges) finds the crossings. Times are snapped to whole lane flicks: up to one lane flick off a window's edges.
	const tol = Math.abs(lane.toSeq(1) - lane.toSeq(0)) + 1;
	const refs = windows.map(([s0, e0]) => ({ s0, e0, ref: Math.max(E0(s0), E0(e0)) }));
	const refAt = (t: number) => refs.find((w) => t >= w.s0 - tol && t <= w.e0 + tol)?.ref;
	const env = (t: number) => dipEnvelopeAt(valid, t);
	const D = (t: number) => {
		const e = env(t);
		const ref = e < 0 ? refAt(t) : undefined;
		return ref === undefined ? Number.POSITIVE_INFINITY : clampV(ref + e);
	};
	const Dc = (t: number) => {
		const ref = refAt(t);
		return ref === undefined ? Number.POSITIVE_INFINITY : clampV(ref + env(t));
	};
	// The ranges to rewrite (lane time): each window widened over the curved segments crossing its edges; windows
	// whose widened ranges overlap are rewritten together (and widened again at the joint range's edges).
	const kfs0 = anim.keyframes;
	const groups: { lo: number; hi: number; ws0: number[] }[] = [];
	for (const w of refs) {
		const la = lane.toLane(w.s0);
		const lb = lane.toLane(w.e0);
		let [lo, hi] = widenedRange(kfs0, Math.min(la, lb), Math.max(la, lb));
		lo = Math.max(lo, laneMin);
		hi = Math.min(hi, laneMax);
		groups.push({ lo, hi, ws0: [w.s0, w.e0] });
	}
	groups.sort((a, b) => a.lo - b.lo);
	for (let merged = true; merged; ) {
		merged = false;
		for (let g = 0; g + 1 < groups.length; g++) {
			const a = groups[g]!;
			const b = groups[g + 1]!;
			if (b.lo > a.hi) continue;
			let [lo, hi] = widenedRange(kfs0, Math.min(a.lo, b.lo), Math.max(a.hi, b.hi));
			lo = Math.max(lo, laneMin);
			hi = Math.min(hi, laneMax);
			groups.splice(g, 2, { lo, hi, ws0: [...a.ws0, ...b.ws0] });
			merged = true;
			break;
		}
	}
	for (const { lo, hi, ws0 } of groups) {
		// the original keys (inside this range `cur` still has them: the ranges are disjoint)
		const kfs = kfs0;
		const ta = lane.toSeq(lo);
		const tb = lane.toSeq(hi);
		const ws = Math.min(ta, tb);
		const we = Math.max(ta, tb);
		const pts = new Set<number>([ws, we, ...ws0]);
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
		// Where the dip curve meets the clamp (a kink of the clamped dip): a breakpoint too.
		{
			const corners = [...pts].sort((x, y) => x - y);
			for (let c = 0; c + 1 < corners.length; c++) {
				const a = corners[c]!;
				const b = corners[c + 1]!;
				const ra = refAt(a);
				const rb = refAt(b);
				if (ra === undefined || rb === undefined || ra !== rb) continue;
				const va = ra + env(a);
				const vb = rb + env(b);
				for (const lim of [cmin, cmax])
					if ((va - lim) * (vb - lim) < 0) pts.add(a + ((b - a) * (va - lim)) / (va - vb));
			}
		}
		for (let i = 0; i < kfs.length; i++) {
			const k = kfs[i]!.time;
			if (k > lo && k <= hi) {
				if (k < hi) pts.add(lane.toSeq(k));
				// a step (also one at the range's edge): the value just before it too
				if (i > 0 && kfs[i - 1]!.interpolation === 'hold')
					for (const x of [k - 1, k + 1]) if (x > lo && x < hi) pts.add(lane.toSeq(x));
			}
		}
		// curved segments inside: adaptive samples (within SAMPLE_TOLERANCE_DB of the curve)
		const fl = (k: number) => evaluate(anim, k);
		for (let i = 0; i < kfs.length - 1; i++) {
			if (straightFrom(kfs, i)) continue;
			const a = Math.max(lo, kfs[i]!.time);
			const b = Math.min(hi, kfs[i + 1]!.time);
			if (!(b > a)) continue;
			const xs: number[] = [];
			adaptiveSamples(fl, a, b, xs);
			for (const x of xs) pts.add(lane.toSeq(x));
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
			out.push([t, Math.min(e, D(t))]);
			const tn = times[i + 1];
			if (tn === undefined) break;
			// where the two lines cross between two breakpoints (the dip's continuous curve; both ends inside it)
			const d0 = Dc(t);
			const d1 = Dc(tn);
			if (!Number.isFinite(d0) || !Number.isFinite(d1)) continue;
			const g0 = e - d0;
			const g1 = E(tn) - d1;
			if ((g0 > 1e-9 && g1 < -1e-9) || (g0 < -1e-9 && g1 > 1e-9)) {
				const tc = snap(t + ((tn - t) * g0) / (g0 - g1));
				if (tc > t && tc < tn) out.push([tc, Math.min(E(tc), D(tc))]);
			}
		}
		// Edge keys of the rewritten range keep the curve outside it: the key at `lo` keeps how the segment before
		// arrives (its incoming ease), the key at `hi` how the segment after leaves (interpolation, outgoing ease).
		const shaped: CurvePoint[] = out.map(([t, v]) => {
			const k = Math.round(lane.toLane(t));
			const at = k === Math.round(lo) ? 'lo' : k === Math.round(hi) ? 'hi' : null;
			const idx = at ? kfs.findIndex((x) => x.time === k) : -1;
			if (idx < 0) return [t, v] as const;
			const orig = kfs[idx]!;
			if (at === 'lo') {
				const prev = kfs[idx - 1];
				if (!prev || prev.interpolation === 'linear' || prev.interpolation === 'hold') return [t, v] as const;
				return [
					t,
					v,
					{ interpolation: 'bezier', easeIn: { ...incomingEase(kfs, idx) }, easeOut: { ...LINEAR } },
				] as const;
			}
			if (orig.interpolation === 'linear' || orig.interpolation === 'hold')
				return [
					t,
					v,
					{ interpolation: orig.interpolation, easeIn: { ...LINEAR }, easeOut: { ...orig.easeOut } },
				] as const;
			return [
				t,
				v,
				{ interpolation: 'bezier', easeIn: { ...LINEAR }, easeOut: { ...outgoingEase(kfs, idx) } },
			] as const;
		});
		const w = writeCurve(cur, lane, ws, we, shaped, opts.newId);
		cur = { ...cur, keyframes: w.keyframes };
		written.push(...w.written);
		rewritten.push([ws, we]);
		// a key this call added and a later window replaced is not the document's: not given back
		for (const k of w.replaced) {
			const own = written.indexOf(k.id);
			if (own >= 0) written.splice(own, 1);
			else replaced.push(k);
		}
	}
	return { keyframes: cur.keyframes, written, replaced, windows: rewritten };
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

/** A build sweep: its range and points (sequence flicks, Hz); `rest[i]` marks the points that are at rest. */
export type BuildSweep = { ws: number; we: number; points: [number, number][]; rest: boolean[] };

/**
 * The build's cutoff points (sequence flicks, Hz) for a hero at frame `frame`: rest → fromHz at T − seconds (50 ms
 * lead-in) → toHz at T − 1 frame, exponential in frequency (log-spaced keys) → rest at T. `rest` = the curve's value
 * at the window's edges (20 Hz on a new filter). A sweep that would start before the sequence starts is cut at 0 (no
 * key at a negative time). Null when the window has no length.
 */
export function buildSweepPoints(
	frame: number,
	spec: { seconds: number; fromHz: number; toHz: number },
	rate: Rational,
	restHz: number = BUILD_REST_HZ,
): BuildSweep | null {
	const F = flicksPerFrame(rate);
	const T = frame * F;
	const top = T - F;
	const start = T - Math.max(0, spec.seconds) * FLICKS_PER_SECOND;
	if (!(top > start) || !(T > 0)) return null;
	const ws = start - BUILD_LEAD_MS * MS;
	const lo = Math.log2(Math.max(20, spec.fromHz));
	const hi = Math.log2(Math.max(20, spec.toHz));
	const sweep: BuildSweep = { ws, we: T, points: [[ws, restHz]], rest: [true] };
	for (let i = 0; i <= BUILD_SWEEP_KEYS; i++) {
		const u = i / BUILD_SWEEP_KEYS;
		sweep.points.push([start + (top - start) * u, Math.round(2 ** (lo + (hi - lo) * u) * 100) / 100]);
		sweep.rest.push(false);
	}
	sweep.points.push([T, restHz]);
	sweep.rest.push(true);
	return ws >= 0 ? sweep : clipSweep(sweep, 0, Number.POSITIVE_INFINITY);
}

/**
 * A sweep cut to [s0, s1] (sequence flicks) with interpolated end points; an end point the cut made is not at rest
 * (only the sweep's own rest points are). Null when nothing is left.
 */
export function clipSweep(sweep: BuildSweep, s0: number, s1: number): BuildSweep | null {
	const p = sweep.points;
	if (p.length === 0) return null;
	const at = (t: number) => {
		if (t <= p[0]![0]) return p[0]![1];
		for (let i = 1; i < p.length; i++) {
			const [ta, va] = p[i - 1]!;
			const [tb, vb] = p[i]!;
			if (t <= tb) return tb === ta ? vb : va + ((vb - va) * (t - ta)) / (tb - ta);
		}
		return p[p.length - 1]![1];
	};
	const a = Math.max(s0, p[0]![0]);
	const b = Math.min(s1, p[p.length - 1]![0]);
	if (!(b > a)) return null;
	const restAt = (t: number) => {
		const i = p.findIndex(([x]) => x === t);
		return i >= 0 && sweep.rest[i] === true;
	};
	const out: BuildSweep = { ws: a, we: b, points: [[a, at(a)]], rest: [restAt(a)] };
	for (let i = 0; i < p.length; i++)
		if (p[i]![0] > a && p[i]![0] < b) {
			out.points.push([p[i]![0], p[i]![1]]);
			out.rest.push(sweep.rest[i] === true);
		}
	out.points.push([b, at(b)]);
	out.rest.push(restAt(b));
	return out;
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
