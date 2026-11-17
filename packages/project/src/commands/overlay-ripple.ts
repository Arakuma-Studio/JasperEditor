// Generated overlays across ripple edits (docs/wp-notes/edit-ux.md "Overlays across ripple edits"). A ripple on one
// track gives sync-locked tracks the same insert or removal, which used to razor every clip that spans the edit. For
// footage that is right (its frames are tied to the time around them), but a title, shape, solid, adjustment layer or
// motion graphic is one designed piece: split, its pieces lost the keyframes of the other part (a day card that shrinks
// to a corner at its end came apart, with gaps, and lost the shrink).
//
// So on a track the edit does not name, an overlay that spans the edit stays one clip:
// - an insert lengthens it, a removal that overlaps it shortens it, by the frames of the edit inside it;
// - the frames are added to / taken from a stretch where nothing animates (every keyframed property holds still), so
//   the animation before that stretch stays relative to the clip's start and the one after it relative to its end —
//   the cut's own place when it is still, else the longest still stretch (nearest the cut); with no still stretch
//   long enough every key time is scaled with the duration instead;
// - a removal that covers the whole overlay removes it (it showed only removed time), as before;
// - `W_OVERLAY_FITTED` names each overlay kept whole.
// Removals: range.extract, clip.extract, ripple trims, cutRanges, gap.close, ripple speed changes (`removeShiftKeeping`).
// Inserts: ripple trims, insert placement / moves, paste insert, Insert Frame Hold Segment, range.insertTime, ripple
// speed changes (`insertShiftKeeping`).
// Subtitle text clips (a `caption`) and media-backed clips are cut as before: their words / frames belong to the time.

import type { Keyframe } from '../schema/common.ts';
import type { Clip } from '../schema/sequence.ts';
import { flicksPerFrame } from '../time.ts';
import type { DClip, DSeq, HandlerContext } from './context.ts';
import { valuesOf } from './draft-read.ts';
import { end, insertShift, removeShift, type SplitRecord, trackClipIds } from './placement.ts';

/** Kinds drawn by the app itself (no media frames): they are kept whole by ripples on other tracks. */
const OVERLAY_KINDS: ReadonlySet<string> = new Set([
	'text',
	'solid',
	'adjustment',
	'shape',
	'motion-graphic',
	'camera',
	'light',
]);

/** A generated overlay a ripple on another track keeps whole (subtitles are cut with their words). */
export function isRippleOverlay(c: Readonly<Pick<Clip, 'kind'>>): boolean {
	if (!OVERLAY_KINDS.has(c.kind)) return false;
	return !(c.kind === 'text' && (c as { caption?: unknown }).caption !== undefined);
}

/** How one overlay changes: its new range, and the frames added or removed at a clip-local frame. */
export type OverlayFit = {
	clipId: string;
	start: number;
	duration: number;
	kind: 'insert' | 'remove';
	/** Clip-local frame of the edit (insert point, or the first removed frame). */
	at: number;
	frames: number;
};

/**
 * The overlays on `trackIds` a removal of `[r0, r1)` keeps whole, as fits in the coordinates before the shift
 * (an overlay inside the range has none: it goes with the range, as before).
 */
export function overlayRemovalFits(
	seq: DSeq,
	trackIds: Iterable<string>,
	r0: number,
	r1: number,
): OverlayFit[] {
	const out: OverlayFit[] = [];
	if (r1 <= r0) return out;
	for (const t of trackIds)
		for (const id of trackClipIds(seq, t, (c) => isRippleOverlay(c) && c.start < r1 && end(c) > r0)) {
			const fit = removalFit(seq.clips[id]!, r0, r1);
			if (fit) out.push(fit);
		}
	return out;
}

/** The fit of one overlay for a removal of `[r0, r1)`; null when the removal does not touch it or covers it. */
export function removalFit(c: Readonly<Clip>, r0: number, r1: number): OverlayFit | null {
	const s = c.start;
	const e = end(c);
	const a = Math.max(s, r0);
	const b = Math.min(e, r1);
	if (b <= a || b - a >= c.duration) return null;
	return {
		clipId: c.id,
		start: s < r0 ? s : r0,
		duration: c.duration - (b - a),
		kind: 'remove',
		at: a - s,
		frames: b - a,
	};
}

/** The overlays on `trackIds` that straddle an insert of `n` frames at `at` (lengthened in place). */
export function overlayInsertFits(
	seq: DSeq,
	trackIds: Iterable<string>,
	at: number,
	n: number,
): OverlayFit[] {
	const out: OverlayFit[] = [];
	if (n <= 0) return out;
	for (const t of trackIds)
		for (const id of trackClipIds(seq, t, (c) => isRippleOverlay(c) && c.start < at && end(c) > at)) {
			const c = seq.clips[id]!;
			out.push({
				clipId: id,
				start: c.start,
				duration: c.duration + n,
				kind: 'insert',
				at: at - c.start,
				frames: n,
			});
		}
	return out;
}

type Keys = Keyframe<unknown>[];

/** Every keyframe list of a clip (Animatables anywhere in it, motion-graphic param keyframes). */
function keyLists(clip: DClip): Keys[] {
	const lists: Keys[] = [];
	const visit = (v: unknown, depth: number): void => {
		if (depth > 32 || !v || typeof v !== 'object') return;
		if (Array.isArray(v)) {
			for (const x of v) visit(x, depth + 1);
			return;
		}
		const o = v as Record<string, unknown>;
		if ('value' in o && Array.isArray(o.keyframes)) {
			if (o.keyframes.length) lists.push(o.keyframes as Keys);
			return;
		}
		for (const [k, x] of Object.entries(o)) {
			if (k === 'paramKeyframes' && x && typeof x === 'object') {
				for (const list of Object.values(x as Record<string, unknown>))
					if (Array.isArray(list) && list.length) lists.push(list as Keys);
				continue;
			}
			visit(x, depth + 1);
		}
	};
	visit(clip, 0);
	return lists;
}

function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	return JSON.stringify(a) === JSON.stringify(b);
}

const zeroTangents = (s: Keyframe<unknown>['spatial']) =>
	!s || s.mode === 'linear' || (s.inTangent.every((x) => x === 0) && s.outTangent.every((x) => x === 0));

/** True when the segment from `a` to `b` holds one value (equal values on a straight path, no roving run). */
function stillSegment(a: Keyframe<unknown>, b: Keyframe<unknown>): boolean {
	if (a.roving || b.roving) return false;
	if (!sameValue(a.value, b.value)) return a.interpolation === 'hold';
	return zeroTangents(a.spatial) && zeroTangents(b.spatial);
}

/** Maximal still stretches `[g0, g1]` (content flicks, g1 > g0) inside `[lo, hi]`. */
function stillGaps(lists: readonly Keys[], lo: number, hi: number): Array<[number, number]> {
	const busy: Array<[number, number]> = [];
	for (const keys of lists) {
		const sorted = [...keys].sort((x, y) => x.time - y.time);
		for (let i = 0; i + 1 < sorted.length; i++)
			if (!stillSegment(sorted[i]!, sorted[i + 1]!)) busy.push([sorted[i]!.time, sorted[i + 1]!.time]);
	}
	busy.sort((x, y) => x[0] - y[0]);
	const gaps: Array<[number, number]> = [];
	let at = lo;
	for (const [a, b] of busy) {
		if (b <= at) continue;
		if (a >= hi) break;
		if (a > at) gaps.push([at, a]);
		at = Math.max(at, b);
	}
	if (at < hi) gaps.push([at, hi]);
	return gaps;
}

/** Same time after the move: one key, the first's incoming side and the last's outgoing side (values are equal). */
function dedupe(keys: Keys): void {
	keys.sort((x, y) => x.time - y.time);
	for (let i = keys.length - 1; i > 0; i--) {
		const a = keys[i - 1]!;
		const b = keys[i]!;
		if (a.time !== b.time) continue;
		const merged = { ...b, id: a.id, easeIn: a.easeIn } as Keyframe<unknown>;
		if (a.inInterpolation !== undefined) merged.inInterpolation = a.inInterpolation;
		else delete merged.inInterpolation;
		if (a.spatial && b.spatial) merged.spatial = { ...b.spatial, inTangent: a.spatial.inTangent };
		keys.splice(i - 1, 2, merged);
	}
}

/**
 * Moves the clip's key times (and clip markers) for `fit`: the frames go into / out of a still stretch, else every
 * time scales with the duration. Content time runs from `sourceIn` at the clip's speed.
 */
function retime(seq: DSeq, clip: DClip, fit: OverlayFit): void {
	const lists = keyLists(clip);
	const markers = (clip.markers ?? []) as { flicks: number }[];
	if (!lists.length && !markers.length) return;
	const F = flicksPerFrame(seq.settings.frameRate) * Math.max(1e-9, Math.abs(clip.speed.rate));
	const d = clip.duration;
	const lo = clip.sourceIn;
	const hi = lo + d * F;
	const K = fit.frames * F;
	const gaps = stillGaps(lists, lo, hi);
	// the cut's own place, in content time (a reversed clip shows its content backwards)
	const want =
		fit.kind === 'remove'
			? lo + (clip.speed.reverse ? d - fit.at - fit.frames : fit.at) * F
			: lo + (clip.speed.reverse ? d - fit.at : fit.at) * F;
	let move: ((t: number) => number) | null = null;
	if (fit.kind === 'remove') {
		const own = gaps.find(([g0, g1]) => g0 <= want && want + K <= g1);
		const room = own ?? longest(gaps.filter(([g0, g1]) => g1 - g0 >= K));
		if (room) {
			const w0 = Math.min(room[1] - K, Math.max(room[0], want));
			const w1 = w0 + K;
			move = (t) => (t >= w1 ? t - K : t > w0 ? w0 : t);
		}
	} else {
		const own = gaps.find(([g0, g1]) => g0 <= want && want <= g1);
		const room = own ?? longest(gaps);
		if (room) {
			const p = Math.min(room[1], Math.max(room[0], want));
			move = (t) => (t > p || (t === p && p > room[0]) ? t + K : t);
		}
	}
	if (!move) {
		const k = fit.duration / d;
		move = (t) => (t > lo ? lo + (t - lo) * k : t);
	}
	const at = (t: number) => Math.max(0, Math.round(move!(t)));
	for (const keys of lists) {
		for (const key of keys) key.time = at(key.time);
		dedupe(keys);
	}
	for (const m of markers) m.flicks = at(m.flicks);
}

function longest(gaps: Array<[number, number]>): [number, number] | undefined {
	let best: [number, number] | undefined;
	for (const g of gaps) if (!best || g[1] - g[0] > best[1] - best[0]) best = g;
	return best;
}

/** Applies one fit: the clip's new range and its keys moved (`retime`). False when the clip is gone. */
export function fitOverlay(seq: DSeq, fit: OverlayFit): boolean {
	const clip = seq.clips[fit.clipId];
	if (!clip) return false;
	retime(seq, clip, fit);
	clip.start = fit.start;
	clip.duration = fit.duration;
	return true;
}

/**
 * After fits: transitions on the fitted clips no longer than them, and one `W_OVERLAY_FITTED` naming each clip with
 * the frames it gained or lost.
 */
export function finishOverlayFits(seq: DSeq, fits: readonly OverlayFit[], h: HandlerContext): void {
	const net = new Map<string, number>();
	for (const f of fits)
		if (seq.clips[f.clipId])
			net.set(f.clipId, (net.get(f.clipId) ?? 0) + (f.kind === 'remove' ? -f.frames : f.frames));
	if (!net.size) return;
	for (const t of valuesOf(seq.transitions)) {
		if (!net.has(t.incomingClipId ?? '') && !net.has(t.outgoingClipId ?? '')) continue;
		const lengths = [t.outgoingClipId, t.incomingClipId]
			.map((id) => (id ? seq.clips[id]?.duration : undefined))
			.filter((x): x is number => typeof x === 'number');
		const fitsIn = Math.max(1, Math.min(...lengths));
		if (!lengths.length || t.duration <= fitsIn) continue;
		h.warn('W_TRANSITION_SHORTENED', `Transition ${t.id} shortened from ${t.duration} to ${fitsIn} frames`);
		seq.transitions[t.id]!.duration = fitsIn;
	}
	const list = [...net].map(([id, n]) => `${id} (${n > 0 ? '+' : '−'}${Math.abs(n)} frames)`);
	h.warn(
		'W_OVERLAY_FITTED',
		`Generated clips kept whole across the ripple, their keyframes moved with their ends: ${list.slice(0, 20).join(', ')}${list.length > 20 ? ` and ${list.length - 20} more` : ''}`,
	);
}

/** Applies fits computed on the same document (`fitOverlay` each, then `finishOverlayFits`). Returns the ids. */
export function applyOverlayFits(seq: DSeq, fits: readonly OverlayFit[], h: HandlerContext): Set<string> {
	const ids = new Set<string>();
	for (const fit of fits) if (fitOverlay(seq, fit)) ids.add(fit.clipId);
	finishOverlayFits(seq, fits, h);
	return ids;
}

/**
 * `insertShift` of an edit on `edited` tracks whose sync-locked `followers` get the same insert: overlays on the
 * followers that straddle `at` are lengthened whole instead of split. Returns the split records (for `relinkSplits`).
 */
export function insertShiftKeeping(
	seq: DSeq,
	edited: Iterable<string>,
	followers: Iterable<string>,
	at: number,
	n: number,
	h: HandlerContext,
	except: ReadonlySet<string> = new Set(),
): SplitRecord[] {
	const follow = [...followers];
	const fits = overlayInsertFits(seq, follow, at, n).filter((f) => !except.has(f.clipId));
	const keep = new Set([...except, ...fits.map((f) => f.clipId)]);
	const splits = insertShift(seq, [...edited, ...follow], at, n, h, keep);
	applyOverlayFits(seq, fits, h);
	return splits;
}

/**
 * `removeShift` of `[f, f+n)` on `edited` tracks and their sync-locked `followers`: overlays on the followers that
 * overlap the removal are shortened whole instead of blocking (or being cut).
 */
export function removeShiftKeeping(
	seq: DSeq,
	edited: Iterable<string>,
	followers: Iterable<string>,
	f: number,
	n: number,
	h: HandlerContext,
	opts: Parameters<typeof removeShift>[5] = {},
): void {
	const follow = [...followers];
	const fits = overlayRemovalFits(seq, follow, f, f + n);
	for (const fit of fits) fitOverlay(seq, fit);
	removeShift(seq, [...edited, ...follow], f, n, h, {
		...opts,
		except: new Set([...(opts.except ?? []), ...fits.map((x) => x.clipId)]),
	});
	finishOverlayFits(seq, fits, h);
}
