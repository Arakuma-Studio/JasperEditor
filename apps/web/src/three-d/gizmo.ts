// Spec 19 TL-079: the rotation gizmo of a selected 3D layer. One arc per axis around the anchor and a free-rotate ring
// outside them, sized to the layer as it is seen, so a small title gets a small gizmo and a full-frame one a large one.
// Pure maths: the overlay draws what this returns.
import type { Vec2, Vec3 } from '@jasper/project';

/** Radius of the arcs on screen, at most and at least. */
export const GIZMO_MIN_PX = 44;
export const GIZMO_MAX_PX = 260;
/** The free-rotate ring, as a multiple of the arcs' radius. */
export const FREE_RING = 1.22;
/** Degrees per screen pixel of a free rotation. */
export const FREE_DEG_PER_PX = 0.5;

/**
 * Screen radius of the arcs: 60 % of the larger side of the layer's screen bounds, within limits, and small enough that
 * the free ring stays inside a monitor of `viewport` (a ring past the edge cannot be grabbed).
 */
export function gizmoRadius(corners: readonly Vec2[], viewport?: { width: number; height: number }): number {
	const fit = viewport
		? Math.max(GIZMO_MIN_PX, (Math.min(viewport.width, viewport.height) / 2 - 6) / FREE_RING)
		: Number.POSITIVE_INFINITY;
	if (corners.length === 0) return Math.min(GIZMO_MIN_PX, fit);
	const xs = corners.map((c) => c[0]);
	const ys = corners.map((c) => c[1]);
	const side = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
	if (!Number.isFinite(side)) return Math.min(GIZMO_MIN_PX, fit);
	return Math.min(GIZMO_MAX_PX, fit, Math.max(GIZMO_MIN_PX, side * 0.6));
}

/** A circle of `radius` world units around `centre`, in the plane normal to world axis `axis`. */
export function worldCircle(centre: Vec3, axis: 0 | 1 | 2, radius: number, segments = 64): Vec3[] {
	const u = (axis + 1) % 3;
	const v = (axis + 2) % 3;
	const out: Vec3[] = [];
	for (let i = 0; i <= segments; i++) {
		const a = (i / segments) * Math.PI * 2;
		const p: Vec3 = [centre[0], centre[1], centre[2]];
		p[u] = p[u]! + Math.cos(a) * radius;
		p[v] = p[v]! + Math.sin(a) * radius;
		out.push(p);
	}
	return out;
}

/** SVG path of a screen polyline, broken where a point could not be projected. */
export function polylinePath(pts: readonly (Vec2 | null)[]): string {
	let d = '';
	let pen = false;
	for (const p of pts) {
		if (!p) {
			pen = false;
			continue;
		}
		d += `${pen ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`;
		pen = true;
	}
	return d;
}

/** The unit tangent of a polyline at the point nearest to `at`, with the circle's screen radius there. */
export function tangentAt(pts: readonly (Vec2 | null)[], at: Vec2): { tangent: Vec2; radius: number } | null {
	let best = Number.POSITIVE_INFINITY;
	let k = -1;
	for (let i = 0; i + 1 < pts.length; i++) {
		const a = pts[i];
		const b = pts[i + 1];
		if (!a || !b) continue;
		const d = (a[0] - at[0]) ** 2 + (a[1] - at[1]) ** 2;
		if (d < best) {
			best = d;
			k = i;
		}
	}
	if (k < 0) return null;
	const a = pts[k]!;
	const b = pts[k + 1]!;
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const seg = Math.hypot(dx, dy);
	if (seg < 1e-6) return null;
	// One step of the polyline turns by 2π / steps: the local screen radius is its length over that angle.
	const radius = (seg * (pts.length - 1)) / (Math.PI * 2);
	return { tangent: [dx / seg, dy / seg], radius: Math.max(radius, 1) };
}

/** Degrees of a drag along an arc: the distance moved along its tangent, over its radius. */
export function arcDelta(start: Vec2, now: Vec2, tangent: Vec2, radius: number): number {
	const along = (now[0] - start[0]) * tangent[0] + (now[1] - start[1]) * tangent[1];
	return (along / Math.max(radius, 1)) * (180 / Math.PI);
}

/** Degrees of a free rotation: horizontal drags turn about Y, vertical ones about X. */
export function freeDelta(start: Vec2, now: Vec2): { x: number; y: number } {
	return { x: -(now[1] - start[1]) * FREE_DEG_PER_PX, y: (now[0] - start[0]) * FREE_DEG_PER_PX };
}
