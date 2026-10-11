// Tracking overlay geometry (S09:TRU-002/003). Pure functions shared by the Program overlays, the Tracking
// section and the tests: media px ↔ sequence px through a plate's layer map, sequence px ↔ screen px through
// the monitor view, corner/edge/body drags of a quad, confidence tones, trails and corner-pin normalisation.
import {
	applyMat3,
	type ClipTracker,
	CORNER_PIN_PARAMS,
	invertMat3,
	isConvexQuad,
	type Mat3,
	type Quad,
	quadCentre,
	type ResolvedLayer,
	sampleCount,
	trackerGeometryAt,
	type Vec2,
} from '@jasper/project';
import { toScreen, toSequence, type View } from '../panels/program/viewport.ts';

export type { Quad, Vec2 };

/** Media px → screen px: `layerMap` (media → sequence) then the monitor view. */
export function mediaToScreen(layerMap: Mat3, view: View, p: Vec2): Vec2 {
	return toScreen(view, applyMat3(layerMap, p));
}

/** Screen px → media px through the inverse layer map (null when the map is singular). */
export function screenToMedia(layerMap: Mat3, view: View, p: Vec2): Vec2 | null {
	const inv = invertMat3(layerMap);
	return inv ? applyMat3(inv, toSequence(view, p)) : null;
}

export function quadToScreen(layerMap: Mat3, view: View, q: readonly Vec2[]): Quad {
	return q.map((p) => mediaToScreen(layerMap, view, p)) as Quad;
}

/** What a pointer grabbed on a tracker quad: a corner (0..3 = TL, TR, BR, BL), an edge (i → i+1) or the body. */
export type QuadPart = { kind: 'corner'; index: number } | { kind: 'edge'; index: number } | { kind: 'body' };

/** New corners after dragging `part` by `delta` (same space as the corners): corner = one, edge = two, body = all. */
function dragQuad(start: Quad, part: QuadPart, delta: Vec2): Quad {
	return start.map((p, i) =>
		partMoves(part, i) ? [p[0] + delta[0], p[1] + delta[1]] : [p[0], p[1]],
	) as Quad;
}

/**
 * Corners in media px after a screen-space drag: every grabbed corner follows the pointer through the inverse
 * layer map (projective maps are not translation-invariant, so each corner is mapped on its own).
 */
export function dragQuadInMedia(
	startMedia: Quad,
	part: QuadPart,
	layerMap: Mat3,
	view: View,
	startScreen: Vec2,
	nowScreen: Vec2,
): Quad | null {
	const inv = invertMat3(layerMap);
	if (!inv) return null;
	const d: Vec2 = [nowScreen[0] - startScreen[0], nowScreen[1] - startScreen[1]];
	const screen0 = startMedia.map((p) => mediaToScreen(layerMap, view, p)) as Quad;
	const movedScreen = dragQuad(screen0, part, d);
	return movedScreen.map((p, i) =>
		partMoves(part, i)
			? applyMat3(inv, toSequence(view, p))
			: ([startMedia[i]![0], startMedia[i]![1]] as Vec2),
	) as Quad;
}

/** Whether corner `i` follows a drag of `part`. */
function partMoves(part: QuadPart, i: number): boolean {
	return (
		part.kind === 'body' ||
		(part.kind === 'corner' && part.index === i) ||
		(part.kind === 'edge' && (part.index === i || (part.index + 1) % 4 === i))
	);
}

/** Axis-aligned square of side `size` centred on `p` (media px) as a quad. */
export function squareAround(p: Vec2, size: number): Quad {
	const h = size / 2;
	return [
		[p[0] - h, p[1] - h],
		[p[0] + h, p[1] - h],
		[p[0] + h, p[1] + h],
		[p[0] - h, p[1] + h],
	];
}

/** Side of the square centred on `centre` whose corner is at `corner` (media px), at least `min`. */
export function sizeFromCorner(centre: Vec2, corner: Vec2, min = 4): number {
	return Math.max(
		min,
		Math.round(2 * Math.max(Math.abs(corner[0] - centre[0]), Math.abs(corner[1] - centre[1]))),
	);
}

type ConfidenceTone = 'good' | 'fair' | 'poor';

/** Green ≥ 0.8, amber ≥ 0.5, red below (TRU-002). */
export function confidenceTone(c: number): ConfidenceTone {
	return c >= 0.8 ? 'good' : c >= 0.5 ? 'fair' : 'poor';
}

export const TONE_VAR: Record<ConfidenceTone, string> = {
	good: 'var(--pr-success)',
	fair: 'var(--pr-warning)',
	poor: 'var(--pr-danger)',
};

/** Centre of a tracker's geometry (quad diagonal intersection or the point). */
export function geometryCentre(g: { corners: Quad | null; point: Vec2 | null }): Vec2 | null {
	if (g.corners) return quadCentre(g.corners);
	return g.point ? [g.point[0], g.point[1]] : null;
}

export const TRAIL_LENGTH = 30;

/**
 * The last `n` tracked centre positions up to content time `t` (media px, oldest first), one per source frame
 * of the samples. Empty before tracking.
 */
export function trailAt(
	tracker: Pick<ClipTracker, 'kind' | 'reference' | 'samples'>,
	t: number,
	n = TRAIL_LENGTH,
): Vec2[] {
	const s = tracker.samples;
	if (!s || sampleCount(s) === 0) return [];
	const count = sampleCount(s);
	const cur = Math.round((t - s.start) / s.step);
	const last = Math.min(count - 1, cur);
	if (last < 0) return [];
	const first = Math.max(0, last - n + 1);
	const out: Vec2[] = [];
	for (let i = first; i <= last; i++) {
		const g = trackerGeometryAt(tracker, s.start + i * s.step, { smoothing: 0 });
		const c = geometryCentre(g);
		if (c) out.push(c);
	}
	return out;
}

/** Geometry of a `tracking.progress` payload (planar: 8 numbers, point: 2). */
export function progressGeometry(data: readonly number[]): { corners: Quad | null; point: Vec2 | null } {
	if (data.length >= 8)
		return {
			corners: [
				[data[0]!, data[1]!],
				[data[2]!, data[3]!],
				[data[4]!, data[5]!],
				[data[6]!, data[7]!],
			],
			point: null,
		};
	if (data.length >= 2) return { corners: null, point: [data[0]!, data[1]!] };
	return { corners: null, point: null };
}

export const CORNER_PIN_DEFAULTS: Quad = [
	[0, 0],
	[1, 0],
	[1, 1],
	[0, 1],
];

/** Normalised corner-pin params (TL, TR, BR, BL) of a resolved effect (defaults for missing values). */
export function pinParams(params: Record<string, unknown>): Quad {
	return CORNER_PIN_PARAMS.map((name, i) => {
		const v = params[name];
		return Array.isArray(v) && v.length === 2 ? [Number(v[0]), Number(v[1])] : CORNER_PIN_DEFAULTS[i]!;
	}) as Quad;
}

/** Normalised → layer px. */
function denormalise(q: readonly Vec2[], box: { width: number; height: number }): Quad {
	return q.map((p) => [p[0] * box.width, p[1] * box.height]) as Quad;
}

/** Layer px → normalised. */
function normalise(p: Vec2, box: { width: number; height: number }): Vec2 {
	return [box.width ? p[0] / box.width : 0, box.height ? p[1] / box.height : 0];
}

/** Pinned corners of a layer in sequence px: normalised params → layer px → the layer's Motion (no pin). */
export function pinnedCornersSeq(motion: Mat3, params: Quad, box: { width: number; height: number }): Quad {
	return denormalise(params, box).map((p) => applyMat3(motion, p)) as Quad;
}

/** A sequence-px position of a corner-pin handle → normalised param value through the inverse Motion. */
export function seqToPinParam(
	motion: Mat3,
	seqPoint: Vec2,
	box: { width: number; height: number },
): Vec2 | null {
	const inv = invertMat3(motion);
	if (!inv) return null;
	const n = normalise(applyMat3(inv, seqPoint), box);
	return [round6(n[0]), round6(n[1])];
}

function round6(v: number): number {
	const r = Math.round(v * 1e6) / 1e6;
	return Object.is(r, -0) ? 0 : r;
}

/** True when the normalised pin quad is convex (else the layer draws unpinned, TRK-030). */
export function pinIsConvex(params: Quad, box: { width: number; height: number }): boolean {
	return isConvexQuad(denormalise(params, box));
}

/**
 * The part of a plate's media that is visible in the sequence frame at a layer map (media px rect), or the whole
 * media when the map is singular. Used to centre a new tracker on what the user sees.
 */
export function visibleMediaRect(
	layerMap: Mat3,
	media: { width: number; height: number },
	frame: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
	const inv = invertMat3(layerMap);
	const whole = { x: 0, y: 0, width: media.width, height: media.height };
	if (!inv) return whole;
	const corners: Vec2[] = [
		[0, 0],
		[frame.width, 0],
		[frame.width, frame.height],
		[0, frame.height],
	].map((p) => applyMat3(inv, p as Vec2));
	if (!corners.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) return whole;
	const x0 = Math.max(0, Math.min(...corners.map((p) => p[0])));
	const y0 = Math.max(0, Math.min(...corners.map((p) => p[1])));
	const x1 = Math.min(media.width, Math.max(...corners.map((p) => p[0])));
	const y1 = Math.min(media.height, Math.max(...corners.map((p) => p[1])));
	return x1 - x0 > 1 && y1 - y0 > 1 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : whole;
}

/** A default planar quad: 40 % of the visible rect, centred. */
export function defaultQuadIn(rect: { x: number; y: number; width: number; height: number }): Quad {
	const cx = rect.x + rect.width / 2;
	const cy = rect.y + rect.height / 2;
	const hw = rect.width * 0.2;
	const hh = rect.height * 0.2;
	const r = (v: number) => Math.round(v * 100) / 100;
	return [
		[r(cx - hw), r(cy - hh)],
		[r(cx + hw), r(cy - hh)],
		[r(cx + hw), r(cy + hh)],
		[r(cx - hw), r(cy + hh)],
	];
}

/** Resolved layer of `clipId` in a scene (null when the clip is not visible at that frame). */
export function layerOf(scene: readonly ResolvedLayer[], clipId: string): ResolvedLayer | null {
	return scene.find((l) => l.clip.clipId === clipId) ?? null;
}
