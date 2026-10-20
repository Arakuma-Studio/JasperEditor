// Program monitor geometry of masks (wp masks): normalised layer coordinates ↔ layer px ↔ sequence px (the full
// layer map, Motion and corner pin) ↔ screen px (the monitor view). Pure; shared by the overlay and its tests.
import {
	applyMat3,
	type BezierPath,
	flattenPath,
	invertMat3,
	layerMapOf,
	nearestOnPath,
	type PathPoint,
	polygonSignedArea,
	type ResolvedLayer,
} from '@jasper/project';
import { toScreen, toSequence, type View } from '../panels/program/viewport.ts';

export type Pt = [number, number];

export type MaskSpace = {
	box: { width: number; height: number };
	/** Normalised layer point → screen px. */
	toScreen(n: PathPoint): Pt;
	/** Screen px → normalised layer point (null when the layer map is singular). */
	fromScreen(s: Pt): Pt | null;
	/** Normalised → layer px. */
	toPx(n: PathPoint): Pt;
	/** Screen px per layer px (mean), for hit radii and handle offsets. */
	scale: number;
	/** The layer map mirrors (negative determinant). */
	mirrored: boolean;
};

export function maskSpace(layer: Pick<ResolvedLayer, 'props'>, view: View): MaskSpace | null {
	const m = layerMapOf(layer.props);
	const inv = invertMat3(m);
	if (!inv) return null;
	const { box } = layer.props;
	const W = box.width || 1;
	const H = box.height || 1;
	const toPx = (n: PathPoint): Pt => [n[0] * W, n[1] * H];
	const a = applyMat3(m, [0, 0]);
	const b = applyMat3(m, [1, 0]);
	const c = applyMat3(m, [0, 1]);
	const det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
	return {
		box,
		toPx,
		toScreen: (n) => toScreen(view, applyMat3(m, toPx(n)) as Pt) as Pt,
		fromScreen: (s) => {
			const q = applyMat3(inv, toSequence(view, s));
			return Number.isFinite(q[0]) && Number.isFinite(q[1]) ? [q[0] / W, q[1] / H] : null;
		},
		scale: Math.sqrt(Math.abs(det)) * view.scale,
		mirrored: det < 0,
	};
}

/** Screen polyline of a path (closed paths repeat nothing; caller closes). */
export function screenPolyline(path: BezierPath, sp: MaskSpace, tol = 0.25): Pt[] {
	// Flatten in layer px (tolerance in screen px / scale) then map: accurate under projective maps.
	const px = {
		closed: path.closed,
		vertices: path.vertices.map((v) => ({ p: sp.toPx(v.p), in: sp.toPx(v.in), out: sp.toPx(v.out) })),
	};
	const { pts } = flattenPath(px, tol / Math.max(1e-6, sp.scale));
	const { width: W, height: H } = sp.box;
	return pts.map((q) => sp.toScreen([q[0] / (W || 1), q[1] / (H || 1)]));
}

export function svgPathOf(pts: readonly Pt[], closed: boolean): string {
	if (pts.length === 0) return '';
	return `M ${pts.map((p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' L ')}${closed ? ' Z' : ''}`;
}

/** Polyline offset by `d` screen px along the outward normals (the feather / expansion guides; display only). */
export function offsetPolyline(pts: readonly Pt[], d: number): Pt[] {
	const n = pts.length;
	if (n < 3 || Math.abs(d) < 1e-6) return [...pts];
	// Outward = to the right of travel for a clockwise-on-screen (positive area, y down) outline.
	const sgn = polygonSignedArea(pts as PathPoint[]) >= 0 ? 1 : -1;
	return pts.map((p, i) => {
		const a = pts[(i - 1 + n) % n]!;
		const b = pts[(i + 1) % n]!;
		const tx = b[0] - a[0];
		const ty = b[1] - a[1];
		const l = Math.hypot(tx, ty) || 1;
		return [p[0] + ((sgn * ty) / l) * d, p[1] + ((-sgn * tx) / l) * d] as Pt;
	});
}

function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i]!;
		const b = poly[j]!;
		if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0])
			inside = !inside;
	}
	return inside;
}

/** Signed outward distance (layer px) of a normalised point from the path outline (> 0 outside). */
export function outwardDistance(path: BezierPath, sp: MaskSpace, n: Pt): number {
	const px = {
		closed: true,
		vertices: path.vertices.map((v) => ({ p: sp.toPx(v.p), in: sp.toPx(v.in), out: sp.toPx(v.out) })),
	};
	const q = sp.toPx(n);
	const near = nearestOnPath(px, q);
	if (!near) return 0;
	const poly = flattenPath(px, 0.25).pts as Pt[];
	return pointInPolygon(q, poly) ? -near.distance : near.distance;
}

/** The segment (and Bézier parameter) of a path under a screen point, within `radius` screen px. */
export function segmentAt(
	path: BezierPath,
	sp: MaskSpace,
	s: Pt,
	radius: number,
): { segment: number; t: number } | null {
	const n = sp.fromScreen(s);
	if (!n) return null;
	const px = {
		closed: path.closed,
		vertices: path.vertices.map((v) => ({ p: sp.toPx(v.p), in: sp.toPx(v.in), out: sp.toPx(v.out) })),
	};
	const hit = nearestOnPath(px, sp.toPx(n));
	if (!hit || hit.distance * sp.scale > radius) return null;
	if (hit.t <= 0.02 || hit.t >= 0.98) return null; // on a vertex
	return { segment: hit.segment, t: hit.t };
}

/** The top-most point of a screen outline and its outward normal (where the feather / expansion handles sit). */
export function topAnchor(pts: readonly Pt[]): { p: Pt; normal: Pt } | null {
	if (pts.length < 3) return null;
	let k = 0;
	for (let i = 1; i < pts.length; i++) if (pts[i]![1] < pts[k]![1]) k = i;
	return { p: pts[k]!, normal: [0, -1] };
}
