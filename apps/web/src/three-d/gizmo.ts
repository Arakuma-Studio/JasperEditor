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

/**
 * How open an arc stays at least, as the cosine between its plane's normal and the line of sight: an arc seen edge-on is a
 * line (a world circle about X, head-on), so it is tilted towards the viewer until it reads as an ellipse this round.
 */
export const GIZMO_MIN_OPEN = 0.35;

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const norm3 = (a: Vec3): Vec3 | null => {
	const l = Math.hypot(a[0], a[1], a[2]);
	return l > 1e-9 && Number.isFinite(l) ? [a[0] / l, a[1] / l, a[2] / l] : null;
};

/**
 * The arc of world axis `axis` as it is drawn: the circle of `worldCircle`, its plane turned towards the viewer just
 * enough that it opens to `GIZMO_MIN_OPEN` (it never collapses edge-on). `sight`: the line of sight at the centre (eye to
 * centre, or the camera's forward for an orthographic view). The turn stays in the plane of the axis and the sight, so
 * the arc keeps the direction of travel of a turn about its axis; a drag along it is read on screen (`tangentAt`).
 */
export function viewFacingCircle(
	centre: Vec3,
	axis: 0 | 1 | 2,
	radius: number,
	sight: Vec3,
	segments = 64,
): Vec3[] {
	const a: Vec3 = [0, 0, 0];
	a[axis] = 1;
	const d = norm3(sight);
	if (!d) return worldCircle(centre, axis, radius, segments);
	const c = dot3(a, d);
	let n = a;
	if (Math.abs(c) < GIZMO_MIN_OPEN) {
		// The part of the sight across the axis, signed so the normal leans to the side the axis already faces.
		const across = norm3([d[0] - c * a[0], d[1] - c * a[1], d[2] - c * a[2]]);
		if (across) {
			const s = c < 0 ? -1 : 1;
			// The sight is `acos|c|` from the axis; turning the normal by the excess over `acos(GIZMO_MIN_OPEN)` leaves
			// exactly that angle (|n·d| = GIZMO_MIN_OPEN), and no turn at all at the threshold, so orbiting never pops.
			const turn = Math.acos(Math.abs(c)) - Math.acos(GIZMO_MIN_OPEN);
			const ca = Math.cos(turn);
			const sa = s * Math.sin(turn);
			n = [ca * a[0] + sa * across[0], ca * a[1] + sa * across[1], ca * a[2] + sa * across[2]];
		}
	}
	// A right-handed basis of the arc's plane, as `worldCircle`'s (u × v = n), so a turn reads the same way.
	const u0: Vec3 = [0, 0, 0];
	u0[(axis + 1) % 3] = 1;
	const u = norm3(cross3(cross3(n, u0), n)) ?? u0;
	const v = cross3(n, u);
	const out: Vec3[] = [];
	for (let i = 0; i <= segments; i++) {
		const t = (i / segments) * Math.PI * 2;
		const cs = Math.cos(t) * radius;
		const sn = Math.sin(t) * radius;
		out.push([
			centre[0] + u[0] * cs + v[0] * sn,
			centre[1] + u[1] * cs + v[1] * sn,
			centre[2] + u[2] * cs + v[2] * sn,
		]);
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
