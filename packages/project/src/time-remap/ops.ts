// Time Remapping edits: pure operations on a remap curve in content time, Premiere's rubber-band
// gestures. Every edit keeps the media frames anchored by keyframes (a keyframe is a source frame) and reports how
// content after the edit moved (`shift`), so the command can move the clip's out point with it — Premiere: "Speeding
// up a segment of a clip makes the segment shorter, and slowing down a segment makes it longer" (Premiere Pro CS6
// reference, Time remapping).
import type { RemapKeyframe, TimeRemap } from '../schema/sequence.ts';
import { effectiveRamp, remapEvaluator, remapSegmentIndexAt, remapSlopes } from './model.ts';

/** Result of an edit: the new curve, how a content time after the edit moved, and the keyframes created. */
export type RemapEdit = {
	remap: TimeRemap;
	/** New content time of a point that was at `c` (identity before the edit point). */
	shift(c: number): number;
	created: string[];
};

export class RemapEditError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RemapEditError';
	}
}

/** Content flicks two keyframes must be apart (and the shortest segment an edit may leave). */
export const MIN_KEY_GAP = 1000;

const clone = (r: TimeRemap): TimeRemap => ({
	...r,
	keyframes: r.keyframes.map((k) => ({ ...k })),
});

const identityShift = (c: number) => c;

/** An empty, enabled remap (identity). */
export function newRemap(): TimeRemap {
	return { enabled: true, keyframes: [], speedBefore: 1, speedAfter: 1 };
}

/** Index of a keyframe at content time `c` (± tolerance), or −1. */
export function keyIndexNear(remap: TimeRemap, c: number, tol = MIN_KEY_GAP / 2): number {
	return remap.keyframes.findIndex((k) => Math.abs(k.time - c) <= tol);
}

/** The keyframe whose speed transition contains `c` (strictly inside), or −1. */
export function rampIndexAt(remap: TimeRemap, c: number): number {
	const keys = remap.keyframes;
	for (let i = 0; i < keys.length; i++) {
		const r = effectiveRamp(keys, i);
		if (r > 0 && c > keys[i]!.time - r && c < keys[i]!.time + r) return i;
	}
	return -1;
}

/**
 * Adds a keyframe at content time `c` (Ctrl/Cmd-click on the rubber band). The curve does not change. A keyframe
 * already there is reused; `c` inside a speed transition is refused (it would reshape the transition).
 */
export function addKeyframe(remap: TimeRemap, c: number, newId: () => string): RemapEdit & { keyId: string } {
	const near = keyIndexNear(remap, c);
	if (near >= 0) return { remap, shift: identityShift, created: [], keyId: remap.keyframes[near]!.id };
	if (rampIndexAt(remap, c) >= 0)
		throw new RemapEditError('A speed keyframe cannot be added inside a speed transition');
	const out = clone(remap);
	const m = remapEvaluator(remap)(c).m;
	if (out.keyframes.length === 0) {
		out.speedBefore = 1;
		out.speedAfter = 1;
	}
	const id = newId();
	out.keyframes.push({ id, time: c, source: m });
	out.keyframes.sort((a, b) => a.time - b.time);
	return { remap: out, shift: identityShift, created: [id], keyId: id };
}

/** Moves keyframes from index `from` on by `delta` content flicks. */
function shiftKeys(keys: RemapKeyframe[], from: number, delta: number): void {
	for (let i = from; i < keys.length; i++) keys[i]!.time += delta;
}

/**
 * Sets the speed of the segment containing content time `c` (dragging the rubber band up or down). `slope` is the
 * new magnitude in media flicks per content flick; the segment keeps its direction and its media span (both its
 * keyframes keep their source frames), so its length changes and everything after it moves. Edge segments are
 * anchored at the clip's visible edges `[c0, c1]`: before the first keyframe the clip's first frame keeps its
 * picture; after the last keyframe the clip's out point keeps its picture.
 */
export function setSegmentSpeed(
	remap: TimeRemap,
	c: number,
	slope: number,
	window: { c0: number; c1: number },
	newId: () => string,
): RemapEdit {
	if (!(slope > 0) || !Number.isFinite(slope))
		throw new RemapEditError('A segment speed must be greater than 0 % (use a freeze for 0 %)');
	const ev = remapEvaluator(remap);
	let base = remap;
	const created: string[] = [];
	if (base.keyframes.length === 0) {
		// One segment over the whole clip: anchor its first visible frame.
		const r = addKeyframe(base, window.c0, newId);
		base = r.remap;
		created.push(...r.created);
	}
	const out = clone(base);
	const keys = out.keyframes;
	const s = remapSlopes(base);
	const i = remapSegmentIndexAt(base, c);
	const n = keys.length;
	if (i < 0) {
		// Before the first keyframe: the visible start keeps its frame, the first keyframe moves.
		const k0 = keys[0]!;
		const a = Math.min(window.c0, k0.time);
		const mA = ev(a).m;
		const span = k0.source - mA;
		if (Math.abs(span) < 1e-9) {
			out.speedBefore = Math.sign(s[0]!) * slope || slope;
			return { remap: out, shift: identityShift, created };
		}
		const dir = Math.sign(span);
		const len = Math.abs(span) / slope;
		const delta = a + len - k0.time;
		shiftKeys(keys, 0, delta);
		out.speedBefore = dir * slope;
		return {
			remap: out,
			shift: (x) => (x <= a ? x : x >= k0.time ? x + delta : a + Math.abs(ev(x).m - mA) / slope),
			created,
		};
	}
	if (i >= n - 1) {
		// After the last keyframe: only the clip's out point moves (its picture stays).
		const kl = keys[n - 1]!;
		const dir = Math.sign(s[n]!) || 1;
		if (Math.abs(s[n]!) < 1e-12) throw new RemapEditError('The speed of a freeze frame cannot be changed');
		out.speedAfter = dir * slope;
		return {
			remap: out,
			shift: (x) => (x <= kl.time ? x : kl.time + Math.abs(ev(x).m - kl.source) / slope),
			created,
		};
	}
	const kl = keys[i]!;
	const kr = keys[i + 1]!;
	const span = kr.source - kl.source;
	if (Math.abs(span) < 1e-9) throw new RemapEditError('The speed of a freeze frame cannot be changed');
	const len = Math.abs(span) / slope;
	const oldRight = kr.time;
	const delta = kl.time + len - oldRight;
	shiftKeys(keys, i + 1, delta);
	clampRamps(out);
	return {
		remap: out,
		shift: (x) =>
			x <= kl.time ? x : x >= oldRight ? x + delta : kl.time + Math.abs(ev(x).m - kl.source) / slope,
		created,
	};
}

/**
 * Moves keyframe `id` to content time `c` (Alt-drag): the speed of every segment stays; the source frame at which the
 * speed changes moves along the left segment (dragging the first keyframe of a freeze picks another frame to hold;
 * dragging the second only changes how long the hold lasts). Following segments are re-chained with unchanged speeds:
 * a forward or reverse segment keeps its right keyframe's frame, a freeze keeps its length. A move that would turn a
 * segment around is shortened to the furthest valid position.
 */
export function moveKeyframe(remap: TimeRemap, id: string, c: number): RemapEdit {
	const k = remap.keyframes.findIndex((x) => x.id === id);
	if (k < 0) throw new RemapEditError(`Speed keyframe not found: ${id}`);
	const s = remapSlopes(remap);
	const old = remap.keyframes[k]!.time;
	const lo = k > 0 ? remap.keyframes[k - 1]!.time + MIN_KEY_GAP : Number.NEGATIVE_INFINITY;
	const want = Math.max(lo, c);
	let out = rechainMove(remap, k, want, s);
	if (!out) {
		// Bisection towards the original position for the furthest valid move.
		let good = old;
		let bad = want;
		for (let it = 0; it < 50; it++) {
			const mid = (good + bad) / 2;
			if (rechainMove(remap, k, mid, s)) good = mid;
			else bad = mid;
		}
		out = rechainMove(remap, k, good, s) ?? clone(remap);
	}
	const moved = out;
	const t = moved.keyframes[k]!.time;
	if (t === old) return { remap, shift: identityShift, created: [] };
	const K = remap.keyframes;
	const N = moved.keyframes;
	const evOld = remapEvaluator(remap);
	return {
		remap: moved,
		shift: (x) => {
			if (x <= Math.min(old, t)) return x;
			// Segment of the old curve containing x; points between the old and new key positions follow the new right
			// segment of the moved keyframe.
			let j = -1;
			for (let q = 0; q < K.length; q++) if (K[q]!.time <= x) j = q;
			if (j < k) j = k;
			const slope = s[j + 1]!;
			const n0 = N[j]!;
			if (Math.abs(slope) > 1e-12) {
				const nt = n0.time + (evOld(x).m - n0.source) / slope;
				if (nt >= n0.time) return nt;
			}
			return x + (n0.time - K[j]!.time);
		},
		created: [],
	};
}

/** The remap with keyframe `k` moved to `t` and the following segments re-chained, or null when invalid. */
function rechainMove(remap: TimeRemap, k: number, t: number, s: number[]): TimeRemap | null {
	const out = clone(remap);
	const K = remap.keyframes;
	const N = out.keyframes;
	N[k]!.source = K[k]!.source + (t - K[k]!.time) * s[k]!;
	N[k]!.time = t;
	for (let j = k; j + 1 < N.length; j++) {
		const slope = s[j + 1]!;
		if (Math.abs(slope) < 1e-12) {
			N[j + 1]!.source = N[j]!.source;
			N[j + 1]!.time = N[j]!.time + (K[j + 1]!.time - K[j]!.time);
		} else {
			const len = (N[j + 1]!.source - N[j]!.source) / slope;
			if (!(len >= MIN_KEY_GAP)) return null;
			N[j + 1]!.time = N[j]!.time + len;
		}
	}
	if (N.some((x) => !Number.isFinite(x.time) || !Number.isFinite(x.source) || x.source < 0)) return null;
	clampRamps(out);
	return out;
}

/** Sets the speed transition of keyframe `id` (half-width in content flicks, clamped to half of each side). */
export function setRamp(remap: TimeRemap, id: string, ramp: number, ease?: number): RemapEdit {
	const out = clone(remap);
	const k = out.keyframes.findIndex((x) => x.id === id);
	if (k < 0) throw new RemapEditError(`Speed keyframe not found: ${id}`);
	const kk = out.keyframes[k]!;
	if (ramp > 0) kk.ramp = ramp;
	else delete kk.ramp;
	if (ease !== undefined) kk.ease = Math.min(1, Math.max(0, ease));
	clampRamps(out);
	return { remap: out, shift: identityShift, created: [] };
}

/** Stores every ramp at its effective (non-overlapping) width. */
export function clampRamps(remap: TimeRemap): void {
	const keys = remap.keyframes;
	const eff = keys.map((_, i) => effectiveRamp(keys, i));
	keys.forEach((k, i) => {
		if (eff[i]! > 0) k.ramp = eff[i]!;
		else delete k.ramp;
	});
}

/**
 * Inserts a freeze frame of `length` content flicks at content time `c` (Ctrl+Alt-drag of a keyframe, Insert Frame
 * Hold Segment): the picture at `c` holds, everything after moves later.
 */
export function insertHold(remap: TimeRemap, c: number, length: number, newId: () => string): RemapEdit {
	if (!(length > 0)) throw new RemapEditError('A freeze frame needs a duration');
	const a = addKeyframe(remap, c, newId);
	const out = clone(a.remap);
	const keys = out.keyframes;
	const k = keys.findIndex((x) => x.id === a.keyId);
	const at = keys[k]!;
	// A transition on the hold's keyframe would blend into the frozen picture: the hold starts sharp.
	delete at.ramp;
	const id = newId();
	shiftKeys(keys, k + 1, length);
	keys.splice(k + 1, 0, { id, time: at.time + length, source: at.source });
	clampRamps(out);
	return {
		remap: out,
		shift: (x) => (x <= at.time ? x : x + length),
		created: [...a.created, id],
	};
}

/**
 * Inserts a palindrome reverse at content time `c` (Ctrl/Cmd-drag of a keyframe): the clip plays backward for `length`
 * content flicks at `slope` (media per content), then forward again over the same frames back to `c`, and continues.
 * The backward part never goes before media time 0.
 */
export function insertReverse(
	remap: TimeRemap,
	c: number,
	length: number,
	slope: number,
	newId: () => string,
): RemapEdit {
	if (!(length > 0) || !(slope > 0))
		throw new RemapEditError('A reverse segment needs a duration and a speed');
	const a = addKeyframe(remap, c, newId);
	const out = clone(a.remap);
	const keys = out.keyframes;
	const k = keys.findIndex((x) => x.id === a.keyId);
	const at = keys[k]!;
	delete at.ramp;
	const len = Math.min(length, at.source / slope);
	if (!(len >= MIN_KEY_GAP)) throw new RemapEditError('There is no earlier media to play backward');
	const back = newId();
	const fwd = newId();
	shiftKeys(keys, k + 1, 2 * len);
	keys.splice(
		k + 1,
		0,
		{ id: back, time: at.time + len, source: at.source - len * slope },
		{ id: fwd, time: at.time + 2 * len, source: at.source },
	);
	clampRamps(out);
	return {
		remap: out,
		shift: (x) => (x <= at.time ? x : x + 2 * len),
		created: [...a.created, back, fwd],
	};
}

/** Removes keyframes (the neighbours keep their frames; the merged segment gets the speed between them). */
export function removeKeyframes(remap: TimeRemap, ids: readonly string[]): RemapEdit {
	const out = clone(remap);
	const drop = new Set(ids);
	const ev = remapEvaluator(remap);
	const first = out.keyframes.findIndex((k) => !drop.has(k.id));
	const before = remap.keyframes[0];
	out.keyframes = out.keyframes.filter((k) => !drop.has(k.id));
	if (out.keyframes.length === 0) {
		out.speedBefore = 1;
		out.speedAfter = 1;
	} else if (before && drop.has(before.id) && first > 0) {
		// The first keyframe went: the new first keeps the slope of the segment that now reaches it.
		const k0 = out.keyframes[0]!;
		const left = remap.keyframes[first - 1]!;
		const dc = k0.time - left.time;
		out.speedBefore = dc > 0 ? (k0.source - ev(left.time).m) / dc : (out.speedBefore ?? 1);
	}
	const lastOld = remap.keyframes[remap.keyframes.length - 1];
	if (lastOld && drop.has(lastOld.id) && out.keyframes.length > 0) {
		const kl = out.keyframes[out.keyframes.length - 1]!;
		const dc = lastOld.time - kl.time;
		out.speedAfter = dc > 0 ? (lastOld.source - kl.source) / dc : (out.speedAfter ?? 1);
	}
	clampRamps(out);
	return { remap: out, shift: identityShift, created: [] };
}
