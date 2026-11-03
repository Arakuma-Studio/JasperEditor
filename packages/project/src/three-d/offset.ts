// Offsets of traced outlines (spec 19 TL-070, TL-073). Pachislop grows opentype outlines with Clipper; ours are traced
// from alpha and carry no boolean operations, so an offset here is an iso-line of a distance field: exact distances to
// the outline's segments on a grid, propagated to every node, then marching squares at the wanted distance. That gives
// the union of touching shapes, round joins, closed counters and no self-intersection, for any input, with no
// dependency. A plate is always a clean outline, however thin or noisy the glyphs under it.
import { nestLoops, type Shape2D, simplifyLoop, traceContours } from './extrude.ts';

type P = [number, number];

/** Most grid nodes of a field; larger shapes get a coarser step. */
const MAX_NODES = 2_000_000;
/** Most grid nodes per axis. */
const MAX_AXIS = 4096;

export type DistanceField = {
	x0: number;
	y0: number;
	step: number;
	nx: number;
	ny: number;
	/** Signed distance per node (layer px, + outside). */
	d: Float32Array;
	/** Nearest outline point per node, interleaved x, y. */
	near: Float32Array;
};

function loopsOf(shapes: readonly Shape2D[]): P[][] {
	return shapes.flatMap((s) => [s.outer, ...s.holes]);
}

function boundsOf(shapes: readonly Shape2D[]): { x0: number; y0: number; x1: number; y1: number } | null {
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (const l of loopsOf(shapes))
		for (const p of l) {
			if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
			if (p[0] < x0) x0 = p[0];
			if (p[0] > x1) x1 = p[0];
			if (p[1] < y0) y0 = p[1];
			if (p[1] > y1) y1 = p[1];
		}
	return x1 >= x0 && y1 >= y0 ? { x0, y0, x1, y1 } : null;
}

/**
 * The signed distance field of `shapes` over their bounds grown by `pad`, at `step` layer px (raised when the grid
 * would pass the node budget). Inside by even-odd parity over all loops, which is what `nestLoops` gives.
 */
export function distanceField(shapes: readonly Shape2D[], pad: number, step: number): DistanceField | null {
	const b = boundsOf(shapes);
	if (!b) return null;
	const w = b.x1 - b.x0 + 2 * pad;
	const h0 = b.y1 - b.y0 + 2 * pad;
	const h = Math.max(step, Math.sqrt((w * h0) / MAX_NODES), w / MAX_AXIS, h0 / MAX_AXIS, 1e-3);
	const x0 = b.x0 - pad - h;
	const y0 = b.y0 - pad - h;
	const nx = Math.ceil(w / h) + 3;
	const ny = Math.ceil(h0 / h) + 3;
	const n = nx * ny;
	const NONE = 1e30;
	const d2 = new Float64Array(n).fill(NONE);
	const near = new Float32Array(n * 2);
	const X = (i: number) => x0 + i * h;
	const Y = (j: number) => y0 + j * h;
	// Seeds: the closest point on each segment for the nodes around it. Row crossings give the inside by parity.
	const rows: number[][] = Array.from({ length: ny }, () => []);
	for (const loop of loopsOf(shapes)) {
		for (let k = 0; k < loop.length; k++) {
			const a = loop[k]!;
			const c = loop[(k + 1) % loop.length]!;
			const ex = c[0] - a[0];
			const ey = c[1] - a[1];
			const l2 = ex * ex + ey * ey;
			const i0 = Math.max(0, Math.floor((Math.min(a[0], c[0]) - x0) / h) - 1);
			const i1 = Math.min(nx - 1, Math.ceil((Math.max(a[0], c[0]) - x0) / h) + 1);
			const j0 = Math.max(0, Math.floor((Math.min(a[1], c[1]) - y0) / h) - 1);
			const j1 = Math.min(ny - 1, Math.ceil((Math.max(a[1], c[1]) - y0) / h) + 1);
			for (let j = j0; j <= j1; j++) {
				const y = Y(j);
				if (a[1] > y !== c[1] > y) rows[j]!.push(a[0] + ((y - a[1]) * ex) / ey);
				// Long diagonal segments: only the nodes within two steps of the line on this row.
				let ia = i0;
				let ib = i1;
				if (Math.abs(ey) > 1e-9) {
					const xa = a[0] + ((y - 2 * h - a[1]) * ex) / ey;
					const xb = a[0] + ((y + 2 * h - a[1]) * ex) / ey;
					ia = Math.max(i0, Math.floor((Math.min(xa, xb) - x0) / h) - 2);
					ib = Math.min(i1, Math.ceil((Math.max(xa, xb) - x0) / h) + 2);
				}
				for (let i = ia; i <= ib; i++) {
					const x = X(i);
					const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * ex + (y - a[1]) * ey) / l2)) : 0;
					const qx = a[0] + t * ex;
					const qy = a[1] + t * ey;
					const dd = (x - qx) ** 2 + (y - qy) ** 2;
					const id = j * nx + i;
					if (dd < d2[id]!) {
						d2[id] = dd;
						near[id * 2] = qx;
						near[id * 2 + 1] = qy;
					}
				}
			}
		}
	}
	// Two sweeps of 8-neighbour vector propagation (Danielsson 1980): each node tries its neighbours' nearest points.
	const relax = (id: number, x: number, y: number, from: number) => {
		const qx = near[from * 2]!;
		const qy = near[from * 2 + 1]!;
		if (d2[from]! >= NONE) return;
		const dd = (x - qx) ** 2 + (y - qy) ** 2;
		if (dd < d2[id]!) {
			d2[id] = dd;
			near[id * 2] = qx;
			near[id * 2 + 1] = qy;
		}
	};
	for (let j = 0; j < ny; j++) {
		const y = Y(j);
		for (let i = 0; i < nx; i++) {
			const id = j * nx + i;
			const x = X(i);
			if (i > 0) relax(id, x, y, id - 1);
			if (j > 0) {
				relax(id, x, y, id - nx);
				if (i > 0) relax(id, x, y, id - nx - 1);
				if (i + 1 < nx) relax(id, x, y, id - nx + 1);
			}
		}
		for (let i = nx - 2; i >= 0; i--) relax(j * nx + i, X(i), y, j * nx + i + 1);
	}
	for (let j = ny - 1; j >= 0; j--) {
		const y = Y(j);
		for (let i = nx - 1; i >= 0; i--) {
			const id = j * nx + i;
			const x = X(i);
			if (i + 1 < nx) relax(id, x, y, id + 1);
			if (j + 1 < ny) {
				relax(id, x, y, id + nx);
				if (i + 1 < nx) relax(id, x, y, id + nx + 1);
				if (i > 0) relax(id, x, y, id + nx - 1);
			}
		}
		for (let i = 1; i < nx; i++) relax(j * nx + i, X(i), y, j * nx + i - 1);
	}
	const d = new Float32Array(n);
	for (let j = 0; j < ny; j++) {
		const r = rows[j]!.sort((p, q) => p - q);
		let c = 0;
		for (let i = 0; i < nx; i++) {
			const x = X(i);
			while (c < r.length && r[c]! < x) c++;
			const dist = Math.sqrt(d2[j * nx + i]!);
			d[j * nx + i] = c & 1 ? -dist : dist;
		}
	}
	return { x0, y0, step: h, nx, ny, d, near };
}

/** The outline `distance` layer px outside the field's shape (negative: inside). */
export function isoShapes(f: DistanceField, distance: number, fillCounters = false): Shape2D[] {
	const K = 1e6;
	// `traceContours` reads 0 outside the grid: the shifted values keep every in-grid node above that.
	const loops = traceContours(f.nx, f.ny, (i, j) => K + distance - f.d[j * f.nx + i]!, K).map((l) =>
		simplifyLoop(
			l.map((p): P => [f.x0 + (p[0] - 0.5) * f.step, f.y0 + (p[1] - 0.5) * f.step]),
			f.step * 0.12,
		),
	);
	const shapes = nestLoops(loops.filter((l) => l.length >= 3));
	return fillCounters ? shapes.map((s) => ({ outer: s.outer, holes: [] })) : shapes;
}

/** The nearest outline point of a layer point, or null outside the grid. */
export function nearestOutline(f: DistanceField, x: number, y: number): P | null {
	const i = Math.round((x - f.x0) / f.step);
	const j = Math.round((y - f.y0) / f.step);
	if (i < 0 || j < 0 || i >= f.nx || j >= f.ny) return null;
	const id = j * f.nx + i;
	return [f.near[id * 2]!, f.near[id * 2 + 1]!];
}

/** Grid step of offsets: about a third of a layer pixel at the output scale, never finer than the node budget. */
export function offsetStep(outputScale: number): number {
	return 0.34 / Math.max(outputScale, 1e-3);
}

/** `shapes` grown by `distance` layer px, round joins, touching shapes merged. */
export function offsetShapes(
	shapes: readonly Shape2D[],
	distance: number,
	outputScale: number,
	fillCounters = false,
): Shape2D[] {
	if (distance === 0 && !fillCounters) return [...shapes];
	const f = distanceField(shapes, Math.max(0, distance) + 2, offsetStep(outputScale));
	return f ? isoShapes(f, distance, fillCounters) : [];
}

/** The convex hull of the shapes' outlines (Andrew's monotone chain), as one shape. */
export function hullShape(shapes: readonly Shape2D[]): Shape2D | null {
	const pts = shapes
		.flatMap((s) => s.outer)
		.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
		.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	if (pts.length < 3) return null;
	const cross = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const half = (list: readonly P[]) => {
		const out: P[] = [];
		for (const p of list) {
			while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
			out.push(p);
		}
		out.pop();
		return out;
	};
	const hull = [...half(pts), ...half([...pts].reverse())];
	return hull.length >= 3 ? { outer: hull, holes: [] } : null;
}

/** The bounds of the shapes grown by `grow`, with rounded corners. */
export function boxShape(shapes: readonly Shape2D[], grow: number, corner: number): Shape2D | null {
	const b = boundsOf(shapes);
	if (!b) return null;
	const x0 = b.x0 - grow;
	const y0 = b.y0 - grow;
	const x1 = b.x1 + grow;
	const y1 = b.y1 + grow;
	if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
	const r = Math.max(0, Math.min(corner, (x1 - x0) / 2, (y1 - y0) / 2));
	if (r <= 1e-6)
		return {
			outer: [
				[x0, y0],
				[x1, y0],
				[x1, y1],
				[x0, y1],
			],
			holes: [],
		};
	const arcs = 12;
	const outer: P[] = [];
	const quarter = (cx: number, cy: number, from: number) => {
		for (let k = 0; k <= arcs; k++) {
			const a = from + ((k / arcs) * Math.PI) / 2;
			outer.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
		}
	};
	quarter(x1 - r, y0 + r, -Math.PI / 2);
	quarter(x1 - r, y1 - r, 0);
	quarter(x0 + r, y1 - r, Math.PI / 2);
	quarter(x0 + r, y0 + r, Math.PI);
	return { outer, holes: [] };
}
