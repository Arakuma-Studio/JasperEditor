// On-canvas transform math (S03 §9, XF-001…037; S03 §3.2 M(q) = P + R·S·(q − A)). Pure functions in
// sequence space; the overlay converts pointer positions with viewport.ts. The layer matrix and quad
// come from @jasper/project so handles match the rendered layers exactly (AC-XF-1).
import {
	applyMatrix,
	type LayerTransformValues,
	layerMatrix,
	type Rect,
	scaleFactors,
} from '@jasper/project';

export type Vec2 = [number, number];
export type Quad = [Vec2, Vec2, Vec2, Vec2];

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 10000;
export const HANDLE_HIT = 12;
export const ROTATE_ZONE = { inner: 6, outer: 20 } as const;
export const ANCHOR_HIT = 8;
export const SMALL_QUAD = 24;

const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Point in a convex quad of either winding (flipped layers reverse it). */
export function pointInQuad(p: Vec2, q: readonly Vec2[]): boolean {
	let pos = false;
	let neg = false;
	for (let i = 0; i < q.length; i++) {
		const c = cross(q[i]!, q[(i + 1) % q.length]!, p);
		if (c > 1e-9) pos = true;
		else if (c < -1e-9) neg = true;
		if (pos && neg) return false;
	}
	return true;
}

export type HitLayer = { clipId: string; trackId: string; quad: Quad };

/**
 * Topmost layer whose quad contains `p` (XF-001). `layers` are in compositing order (bottom → top);
 * layers on locked tracks are skipped.
 */
export function hitTest(
	layers: readonly HitLayer[],
	p: Vec2,
	locked: ReadonlySet<string> = new Set(),
): string | null {
	for (let i = layers.length - 1; i >= 0; i--) {
		const l = layers[i]!;
		if (locked.has(l.trackId)) continue;
		if (pointInQuad(p, l.quad)) return l.clipId;
	}
	return null;
}

// ------------------------------------------------------------------ handles

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLE_IDS: readonly HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const CORNERS: readonly HandleId[] = ['nw', 'ne', 'se', 'sw'];
const OPPOSITE: Record<HandleId, HandleId> = {
	nw: 'se',
	n: 's',
	ne: 'sw',
	e: 'w',
	se: 'nw',
	s: 'n',
	sw: 'ne',
	w: 'e',
};

export function oppositeHandle(h: HandleId): HandleId {
	return OPPOSITE[h];
}

export function isCorner(h: HandleId): boolean {
	return h.length === 2;
}

/** Layer-space point of a handle on a rect. */
export function handlePoint(rect: Rect, h: HandleId): Vec2 {
	const x0 = rect.x;
	const x1 = rect.x + rect.width;
	const xm = rect.x + rect.width / 2;
	const y0 = rect.y;
	const y1 = rect.y + rect.height;
	const ym = rect.y + rect.height / 2;
	switch (h) {
		case 'nw':
			return [x0, y0];
		case 'n':
			return [xm, y0];
		case 'ne':
			return [x1, y0];
		case 'e':
			return [x1, ym];
		case 'se':
			return [x1, y1];
		case 's':
			return [xm, y1];
		case 'sw':
			return [x0, y1];
		case 'w':
			return [x0, ym];
	}
}

// ------------------------------------------------------------------ rotation helpers

export function rotate(v: Vec2, deg: number): Vec2 {
	const t = (deg * Math.PI) / 180;
	const c = Math.cos(t);
	const s = Math.sin(t);
	return [c * v[0] - s * v[1], s * v[0] + c * v[1]];
}

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];

// ------------------------------------------------------------------ scale (XF-030/031/032)

export type ScaleInput = {
	values: LayerTransformValues;
	rect: Rect;
	handle: HandleId;
	/** Pointer in sequence space, already corrected by the grab offset. */
	pointer: Vec2;
	/** Shift inverts the uniform setting for this drag. */
	invertUniform?: boolean;
	/** Alt: scale about the opposite handle instead of the anchor. */
	aboutOpposite?: boolean;
};

export type ScaleResult = {
	scale: number;
	scaleWidth: number;
	uniformScale: boolean;
	position: Vec2;
};

/**
 * New Motion values for a handle drag. Scale is about the anchor by default; with `aboutOpposite` the
 * opposite handle stays fixed and position is re-solved: P' = p_opp − R·S'·(q_opp − A). Negative
 * scales never happen (dragging through the reference clamps at MIN_SCALE; flips are effects).
 */
export function scaleFromHandle(i: ScaleInput): ScaleResult {
	const v = i.values;
	const uniform = i.invertUniform ? !v.uniformScale : v.uniformScale;
	const { sx: sx0, sy: sy0 } = scaleFactors(v);
	const flipX = v.flipH ? -1 : 1;
	const flipY = v.flipV ? -1 : 1;
	const qh = handlePoint(i.rect, i.handle);
	const qref = i.aboutOpposite ? handlePoint(i.rect, oppositeHandle(i.handle)) : v.anchor;
	const M = layerMatrix(v);
	const pref = applyMatrix(M, qref);
	const d = sub(qh, qref);
	const u = rotate(sub(i.pointer, pref), -v.rotation);
	const corner = isCorner(i.handle);
	const horizontal = i.handle === 'e' || i.handle === 'w';
	const vertical = i.handle === 'n' || i.handle === 's';
	const clampPct = (x: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, x));
	let next: LayerTransformValues;
	if (uniform) {
		// One factor k scales both axes (a vertical edge still scales uniformly, Premiere behavior).
		let k = 1;
		if (corner) {
			const Sd: Vec2 = [sx0 * d[0], sy0 * d[1]];
			const len2 = Sd[0] * Sd[0] + Sd[1] * Sd[1];
			if (len2 > 1e-12) k = (u[0] * Sd[0] + u[1] * Sd[1]) / len2;
		} else if (horizontal && Math.abs(d[0] * sx0) > 1e-12) k = u[0] / (d[0] * sx0);
		else if (vertical && Math.abs(d[1] * sy0) > 1e-12) k = u[1] / (d[1] * sy0);
		const scale = clampPct(v.scale * k);
		const kk = scale / v.scale;
		next = { ...v, scale, scaleWidth: clampPct(v.scaleWidth * kk) };
	} else {
		let sx = sx0;
		let sy = sy0;
		if ((corner || horizontal) && Math.abs(d[0]) > 1e-9) sx = u[0] / d[0];
		if ((corner || vertical) && Math.abs(d[1]) > 1e-9) sy = u[1] / d[1];
		// Magnitudes without the flip signs; dragging through the reference clamps (XF-032).
		const width = clampPct((sx / flipX) * 100);
		const height = clampPct((sy / flipY) * 100);
		next = { ...v, uniformScale: false, scale: height, scaleWidth: width };
	}
	const { scale, scaleWidth } = next;
	let position: Vec2 = v.position;
	if (i.aboutOpposite) {
		const { sx: nsx, sy: nsy } = scaleFactors(next);
		const off = rotate([nsx * (qref[0] - v.anchor[0]), nsy * (qref[1] - v.anchor[1])], v.rotation);
		position = sub(pref, off);
	}
	return { scale, scaleWidth, uniformScale: next.uniformScale, position };
}

// ------------------------------------------------------------------ rotate (XF-035)

/** Smallest signed difference b − a in degrees, in (−180, 180]. */
export function angleDelta(a: number, b: number): number {
	let d = (b - a) % 360;
	if (d > 180) d -= 360;
	if (d <= -180) d += 360;
	return d;
}

export function angleOf(center: Vec2, p: Vec2): number {
	return (Math.atan2(p[1] - center[1], p[0] - center[0]) * 180) / Math.PI;
}

/** Final rotation with Shift (15°) and monitor snapping (90° within ±2°). */
export function snapRotation(theta: number, opts: { shift?: boolean; snap90?: boolean }): number {
	if (opts.shift) return Math.round(theta / 15) * 15;
	if (opts.snap90) {
		const r = Math.round(theta / 90) * 90;
		if (Math.abs(theta - r) <= 2) return r;
	}
	return theta;
}

/** Accumulating rotation tracker: unwrapped so continuous dragging adds turns. */
export class RotationTracker {
	private last: number;
	private total = 0;
	constructor(
		private readonly center: Vec2,
		start: Vec2,
		private readonly theta0: number,
	) {
		this.last = angleOf(center, start);
	}
	update(p: Vec2): number {
		const a = angleOf(this.center, p);
		this.total += angleDelta(this.last, a);
		this.last = a;
		return this.theta0 + this.total;
	}
}

// ------------------------------------------------------------------ anchor (XF-037)

/**
 * Moves the anchor by a sequence-space delta without moving the image:
 * A' = A0 + S⁻¹R(−θ)Δp, P' = P0 + Δp. With `anchorOnly` (Alt) only A changes and the image slides.
 */
export function moveAnchor(
	v: LayerTransformValues,
	delta: Vec2,
	anchorOnly = false,
): { anchor: Vec2; position: Vec2 } {
	const { sx, sy } = scaleFactors(v);
	const local = rotate(delta, -v.rotation);
	const anchor: Vec2 = [
		v.anchor[0] + (Math.abs(sx) > 1e-12 ? local[0] / sx : 0),
		v.anchor[1] + (Math.abs(sy) > 1e-12 ? local[1] / sy : 0),
	];
	return { anchor, position: anchorOnly ? v.position : add(v.position, delta) };
}

/** Snap points for the anchor crosshair: visible-rect corners, edge midpoints and center (layer space). */
export function anchorSnapPoints(rect: Rect): Vec2[] {
	return [
		...HANDLE_IDS.map((h) => handlePoint(rect, h)),
		[rect.x + rect.width / 2, rect.y + rect.height / 2],
	];
}

// ------------------------------------------------------------------ group (XF-011/033/036)

export function unionBounds(rects: readonly Rect[]): Rect | null {
	if (rects.length === 0) return null;
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (const r of rects) {
		x0 = Math.min(x0, r.x);
		y0 = Math.min(y0, r.y);
		x1 = Math.max(x1, r.x + r.width);
		y1 = Math.max(y1, r.y + r.height);
	}
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Uniform group scale factor from a handle drag of the axis-aligned group box about its center. */
export function groupScaleFactor(box: Rect, handle: HandleId, pointer: Vec2): number {
	const center: Vec2 = [box.x + box.width / 2, box.y + box.height / 2];
	const d = sub(handlePoint(box, handle), center);
	const u = sub(pointer, center);
	if (isCorner(handle)) {
		const len2 = d[0] * d[0] + d[1] * d[1];
		return len2 > 1e-12 ? Math.max(1e-3, (u[0] * d[0] + u[1] * d[1]) / len2) : 1;
	}
	if (handle === 'e' || handle === 'w') return Math.abs(d[0]) > 1e-9 ? Math.max(1e-3, u[0] / d[0]) : 1;
	return Math.abs(d[1]) > 1e-9 ? Math.max(1e-3, u[1] / d[1]) : 1;
}

/** P' = G + k(P − G), s' = k·s for each layer of a multi-selection (XF-033). */
export function scaleAboutPoint(v: LayerTransformValues, g: Vec2, k: number): Partial<LayerTransformValues> {
	return {
		position: [g[0] + k * (v.position[0] - g[0]), g[1] + k * (v.position[1] - g[1])],
		scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * k)),
		scaleWidth: Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scaleWidth * k)),
	};
}

/** Positions rotate around G and each layer's rotation gets the same delta (XF-036). */
export function rotateAboutPoint(
	v: LayerTransformValues,
	g: Vec2,
	deltaDeg: number,
): Partial<LayerTransformValues> {
	return { position: add(g, rotate(sub(v.position, g), deltaDeg)), rotation: v.rotation + deltaDeg };
}

// ------------------------------------------------------------------ screen geometry for the overlay

/** Distance from a point to the nearest corner of a quad, and whether it lies outside the quad. */
export function rotationZoneHit(quadScreen: Quad, p: Vec2): boolean {
	if (pointInQuad(p, quadScreen)) return false;
	for (const c of quadScreen) {
		const dist = Math.hypot(p[0] - c[0], p[1] - c[1]);
		if (dist >= ROTATE_ZONE.inner && dist <= ROTATE_ZONE.outer) return true;
	}
	return false;
}
