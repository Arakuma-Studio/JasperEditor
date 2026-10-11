// Time maps: a clip's Time Remapping as the (clip time → media time) points interchange formats
// carry — FCPXML `timeMap`/`timept`, FCP7 Time Remap `graphdict` — and back. Constant-speed segments are linear
// pieces; a speed transition is one `smooth` piece from its start to its end (both on the polyline). Reading a smooth
// piece rebuilds the keyframe at the intersection of its neighbours' lines with a symmetric transition (exact for maps
// written here; foreign asymmetric eases become the nearest symmetric transition).
import type { RemapKeyframe, TimeRemap } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import { activeRemap, clipMediaTimeAt, effectiveRamp, frameAtContent, type TimedClip } from './model.ts';

export type TimeMapPoint = { time: number; value: number; interp?: 'linear' | 'smooth' };

/**
 * The time map of a remapped clip: clip time (flicks from its first frame) → media time (flicks), from the first to
 * one past the last frame. Null for clips without an active remap.
 */
export function remapToTimeMap(clip: TimedClip, rate: Rational): TimeMapPoint[] | null {
	const remap = activeRemap(clip);
	if (!remap || clip.frameHold) return null;
	const F = flicksPerFrame(rate);
	const end = clip.duration;
	const at = (localFrame: number) => clipMediaTimeAt(clip, clip.start + localFrame, rate);
	const marks: { f: number; smooth: boolean }[] = [{ f: 0, smooth: false }];
	remap.keyframes.forEach((k, i) => {
		const r = effectiveRamp(remap.keyframes, i);
		const f = frameAtContent(clip, k.time, rate) - clip.start;
		const step = F * clip.speed.rate;
		const rf = r / step;
		if (rf > 0) {
			marks.push({ f: f - rf, smooth: true }, { f: f + rf, smooth: false });
		} else marks.push({ f, smooth: false });
	});
	marks.push({ f: end, smooth: false });
	const pts: TimeMapPoint[] = [];
	const sorted = marks.filter((m) => m.f >= 0 && m.f <= end).sort((a, b) => a.f - b.f);
	for (const m of sorted) {
		const last = pts[pts.length - 1];
		const time = Math.round(m.f * F);
		if (last && Math.abs(last.time - time) < 1) {
			if (m.smooth) last.interp = 'smooth';
			continue;
		}
		pts.push({ time, value: Math.round(at(m.f)), interp: m.smooth ? 'smooth' : 'linear' });
	}
	// A transition cut by the clip edge: the piece that reaches it is linear (its exact values are kept).
	if (pts.length > 0) pts[pts.length - 1]!.interp = 'linear';
	return pts;
}

/**
 * A remap for a time map (clip time → media time, flicks) on a clip whose content axis starts at `sourceIn` and
 * advances `axisRate` content flicks per clip flick (its Speed/Duration rate; content = sourceIn + clip time·rate).
 * Returns the remap and whether a foreign ease was approximated.
 */
export function timeMapToRemap(
	points: readonly TimeMapPoint[],
	sourceIn: number,
	newId: () => string,
	axisRate = 1,
): { remap: TimeRemap; approximated: boolean } {
	const pts = [...points]
		.sort((a, b) => a.time - b.time)
		.filter((p, i, a) => i === 0 || p.time > a[i - 1]!.time);
	const keys: RemapKeyframe[] = [];
	let approximated = false;
	const slope = (a: TimeMapPoint, b: TimeMapPoint) => (b.value - a.value) / Math.max(1e-9, b.time - a.time);
	const ct = (t: number) => sourceIn + t * axisRate;
	for (let i = 0; i < pts.length; i++) {
		const p = pts[i]!;
		const prev = pts[i - 1];
		if (prev?.interp === 'smooth') continue; // the end of a transition (folded into its keyframe)
		if (p.interp === 'smooth' && i + 1 < pts.length) {
			const q = pts[i + 1]!;
			const v1 = prev ? slope(prev, p) : slope(p, q);
			const r = pts[i + 2];
			const v2 = r ? slope(q, r) : slope(p, q);
			if (Math.abs(v1 - v2) < 1e-12) {
				keys.push({ id: newId(), time: ct(p.time), source: p.value });
				continue;
			}
			// Corner: p + v1·(t − p.t) = q + v2·(t − q.t).
			const t = (q.value - p.value + v1 * p.time - v2 * q.time) / (v1 - v2);
			const tc = Math.min(q.time, Math.max(p.time, t));
			const half = Math.min(tc - p.time, q.time - tc);
			if (Math.abs(tc - p.time - (q.time - tc)) > Math.max(1, 0.01 * (q.time - p.time))) approximated = true;
			keys.push({
				id: newId(),
				time: ct(tc),
				source: p.value + v1 * (tc - p.time),
				...(half > 0 ? { ramp: half * axisRate } : {}),
			});
			continue;
		}
		keys.push({ id: newId(), time: ct(p.time), source: p.value });
	}
	const first = pts[0];
	const second = pts[1];
	const last = pts[pts.length - 1];
	const before = pts[pts.length - 2];
	return {
		remap: {
			enabled: true,
			keyframes: keys,
			speedBefore: (first && second ? slope(first, second) : 1) / axisRate,
			speedAfter: (last && before ? slope(before, last) : 1) / axisRate,
		},
		approximated,
	};
}
