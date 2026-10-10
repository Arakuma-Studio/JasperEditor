// Speed rubber band geometry (workstream `time`): Premiere's "Show Clip Keyframes ▸ Time Remapping ▸ Speed" band
// on a timeline clip. Pure functions of the clip and the timeline view, unit-tested in apps/web/test/time.test.ts.
//
// Height: log₂ of the speed, 100 % in the middle of the band, ×8 (800 %) at the top and ÷8 (12.5 %) at the bottom
// (a linear scale would squeeze every slow motion into the bottom pixels); 0 % (freeze) on the bottom edge. Reverse
// segments draw at their magnitude with "<" marks, freezes with "|" marks (Premiere's tick marks).
import {
	type Clip,
	clipSpeedAt,
	type Rational,
	type RemapKeyView,
	type RemapSegmentView,
	remapKeyViews,
	remapSegmentViews,
	type TimedClip,
} from '@jasper/project';

/** Octaves above / below 100 % the band shows. */
export const BAND_OCTAVES = 3;
/** Name strip height of the clip view (ClipView `NAME_STRIP_PX`). */
export const BAND_TOP = 14;

export type BandArea = { top: number; bottom: number };

export function bandArea(height: number): BandArea {
	return { top: BAND_TOP + 6, bottom: Math.max(BAND_TOP + 10, height - 4) };
}

/** y of a speed magnitude (1 = 100 %). */
export function speedToY(speed: number, a: BandArea): number {
	const s = Math.abs(speed);
	if (!(s > 0)) return a.bottom;
	const f = Math.min(1, Math.max(0, (Math.log2(s) + BAND_OCTAVES) / (2 * BAND_OCTAVES)));
	return a.bottom - f * (a.bottom - a.top);
}

/** Speed magnitude (1 = 100 %) of a y (inverse of `speedToY`), optionally snapped to `snapPercent` steps. */
export function yToSpeed(y: number, a: BandArea, snapPercent?: number): number {
	const f = Math.min(1, Math.max(0, (a.bottom - y) / Math.max(1, a.bottom - a.top)));
	let s = 2 ** (f * 2 * BAND_OCTAVES - BAND_OCTAVES);
	if (snapPercent && snapPercent > 0)
		s = Math.max(snapPercent, Math.round((s * 100) / snapPercent) * snapPercent) / 100;
	return Math.min(200, Math.max(0.0001, s));
}

export type BandPoint = { x: number; y: number };

/**
 * The band as a polyline in body-local px over clip-local px [x0, x1) (the visible part), sampled every `step` px,
 * plus the segment breaks (keyframes) so corners stay sharp.
 */
export function bandPath(
	clip: TimedClip,
	rate: Rational,
	pxPerFrame: number,
	a: BandArea,
	x0: number,
	x1: number,
	step = 2,
): BandPoint[] {
	const pts: BandPoint[] = [];
	const at = (x: number) =>
		clipSpeedAt(clip, clip.start + Math.min(clip.duration - 1e-6, Math.max(0, x / pxPerFrame)), rate);
	const keys = remapKeyViews(clip, rate)
		.flatMap((k) => (k.rampFrames > 0 ? [k.frame - k.rampFrames, k.frame + k.rampFrames] : [k.frame]))
		.map((f) => (f - clip.start) * pxPerFrame)
		.filter((x) => x > x0 && x < x1);
	const xs = new Set<number>();
	for (let x = x0; x < x1; x += step) xs.add(x);
	xs.add(x1);
	for (const k of keys) {
		xs.add(k - 0.01);
		xs.add(k + 0.01);
	}
	for (const x of [...xs].sort((p, q) => p - q)) pts.push({ x, y: speedToY(at(x), a) });
	return pts;
}

export type BandSegment = RemapSegmentView & { x0: number; x1: number; y: number };

/** Constant-speed segments in body-local px (a non-remapped clip is one segment at its Speed/Duration speed). */
export function bandSegments(
	clip: TimedClip,
	rate: Rational,
	pxPerFrame: number,
	a: BandArea,
): BandSegment[] {
	const views = remapSegmentViews(clip, rate);
	if (views.length === 0) {
		const speed = clipSpeedAt(clip, clip.start, rate);
		return [
			{
				index: -1,
				fromFrame: clip.start,
				toFrame: clip.start + clip.duration,
				speed,
				kind: speed === 0 ? 'hold' : speed < 0 ? 'reverse' : 'forward',
				mediaFrom: 0,
				mediaTo: 0,
				leftKeyId: null,
				rightKeyId: null,
				x0: 0,
				x1: clip.duration * pxPerFrame,
				y: speedToY(speed, a),
			},
		];
	}
	return views.map((v) => ({
		...v,
		x0: (v.fromFrame - clip.start) * pxPerFrame,
		x1: (v.toFrame - clip.start) * pxPerFrame,
		y: speedToY(v.speed, a),
	}));
}

export type BandKey = RemapKeyView & { x: number; xIn: number; xOut: number };

/** Speed keyframes in body-local px (`xIn`/`xOut` = the halves of a split keyframe). */
export function bandKeys(clip: TimedClip, rate: Rational, pxPerFrame: number): BandKey[] {
	return remapKeyViews(clip, rate).map((k) => {
		const x = (k.frame - clip.start) * pxPerFrame;
		return { ...k, x, xIn: x - k.rampFrames * pxPerFrame, xOut: x + k.rampFrames * pxPerFrame };
	});
}

/** The keyframe within `tol` px of x (halves count), or null. */
export function keyAt(keys: readonly BandKey[], x: number, tol = 5): BandKey | null {
	let best: BandKey | null = null;
	let d = tol;
	for (const k of keys)
		for (const kx of [k.x, k.xIn, k.xOut]) {
			const dd = Math.abs(kx - x);
			if (dd <= d) {
				d = dd;
				best = k;
			}
		}
	return best;
}

/** Display text of a speed (Premiere's tooltip): "50.00%", "-100.00%", "0.00%". */
export function speedLabel(speed: number): string {
	return `${(Math.round(speed * 10000) / 100).toFixed(2)}%`;
}

/** Clips that can show the band. */
export function bandEligible(c: Clip): boolean {
	return c.kind === 'video' || c.kind === 'nest-video';
}
