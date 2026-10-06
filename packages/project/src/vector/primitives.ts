// Parametric shape paths (wp shapes) with After Effects' vertex order, so Trim Paths, Zig Zag, Wiggle… start where
// they start in After Effects. Vertex layouts follow the Lottie/bodymovin reference player (lottie-web, MIT), which
// mirrors After Effects: rectangles start at the top-right corner (top end of the right edge when rounded) and run
// clockwise on screen; ellipses start at the top; polystars start at the top (rotation 0) with handles of length
// 2πR/(4·points)·roundness along the travel direction. "Reversed" path direction reverses each path.
import { type BezPath, type Cubic, KAPPA, lineCubic, type P, reversePath } from './geom.ts';

export type PathDirection = 'normal' | 'reversed';

const dir = (p: BezPath, d: PathDirection | undefined): BezPath => (d === 'reversed' ? reversePath(p) : p);

/** Rectangle centred at `pos` with corner `roundness` (clamped to half the shorter side). */
export function rectPath(size: P, pos: P, roundness: number, direction?: PathDirection): BezPath {
	const w = Math.abs(size[0]) / 2;
	const h = Math.abs(size[1]) / 2;
	const [x, y] = pos;
	const r = Math.max(0, Math.min(w, h, Number.isFinite(roundness) ? roundness : 0));
	const segs: Cubic[] = [];
	if (r <= 0) {
		const tr: P = [x + w, y - h];
		const br: P = [x + w, y + h];
		const bl: P = [x - w, y + h];
		const tl: P = [x - w, y - h];
		segs.push(lineCubic(tr, br), lineCubic(br, bl), lineCubic(bl, tl), lineCubic(tl, tr));
	} else {
		const k = r * (1 - KAPPA);
		// Right edge down, bottom-right corner, bottom edge left, … (8 vertices).
		const pts: P[] = [
			[x + w, y - h + r],
			[x + w, y + h - r],
			[x + w - r, y + h],
			[x - w + r, y + h],
			[x - w, y + h - r],
			[x - w, y - h + r],
			[x - w + r, y - h],
			[x + w - r, y - h],
		];
		const corner = (a: P, b: P, ha: P, hb: P): Cubic => [a, ha, hb, b];
		segs.push(lineCubic(pts[0]!, pts[1]!));
		segs.push(corner(pts[1]!, pts[2]!, [x + w, y + h - k], [x + w - k, y + h]));
		segs.push(lineCubic(pts[2]!, pts[3]!));
		segs.push(corner(pts[3]!, pts[4]!, [x - w + k, y + h], [x - w, y + h - k]));
		segs.push(lineCubic(pts[4]!, pts[5]!));
		segs.push(corner(pts[5]!, pts[6]!, [x - w, y - h + k], [x - w + k, y - h]));
		segs.push(lineCubic(pts[6]!, pts[7]!));
		segs.push(corner(pts[7]!, pts[0]!, [x + w - k, y - h], [x + w, y - h + k]));
	}
	return dir([{ segs, closed: true }], direction);
}

/** Ellipse centred at `pos` (four vertices: top, right, bottom, left). */
export function ellipsePath(size: P, pos: P, direction?: PathDirection): BezPath {
	const rx = Math.abs(size[0]) / 2;
	const ry = Math.abs(size[1]) / 2;
	const [x, y] = pos;
	const kx = rx * KAPPA;
	const ky = ry * KAPPA;
	const top: P = [x, y - ry];
	const right: P = [x + rx, y];
	const bottom: P = [x, y + ry];
	const left: P = [x - rx, y];
	const segs: Cubic[] = [
		[top, [x + kx, y - ry], [x + rx, y - ky], right],
		[right, [x + rx, y + ky], [x + kx, y + ry], bottom],
		[bottom, [x - kx, y + ry], [x - rx, y + ky], left],
		[left, [x - rx, y - ky], [x - kx, y - ry], top],
	];
	return dir([{ segs, closed: true }], direction);
}

export type PolystarParams = {
	star: boolean;
	points: number;
	position: P;
	/** Degrees, clockwise. */
	rotation: number;
	innerRadius: number;
	outerRadius: number;
	/** Percent (−100…100 accepted; After Effects allows negative roundness for inward loops). */
	innerRoundness: number;
	outerRoundness: number;
	direction?: PathDirection;
};

/** Polystar: a star (inner and outer vertices alternate) or a regular polygon. */
export function polystarPath(s: PolystarParams): BezPath {
	const n = Math.max(3, Math.min(100, Math.floor(Number.isFinite(s.points) ? s.points : 5)));
	const count = s.star ? n * 2 : n;
	const step = (2 * Math.PI) / count;
	const start = -Math.PI / 2 + (s.rotation * Math.PI) / 180;
	const verts: { p: P; t: P; h: number }[] = [];
	for (let i = 0; i < count; i++) {
		const inner = s.star && i % 2 === 1;
		const r = Math.max(0, inner ? s.innerRadius : s.outerRadius);
		const round = (inner ? s.innerRoundness : s.outerRoundness) / 100;
		const a = start + step * i;
		const p: P = [s.position[0] + r * Math.cos(a), s.position[1] + r * Math.sin(a)];
		// Travel direction (increasing angle = clockwise on screen) and handle length (lottie-web convention).
		const t: P = [-Math.sin(a), Math.cos(a)];
		verts.push({ p, t, h: ((2 * Math.PI * r) / (n * 4)) * round });
	}
	const segs: Cubic[] = [];
	for (let i = 0; i < count; i++) {
		const a = verts[i]!;
		const b = verts[(i + 1) % count]!;
		if (a.h === 0 && b.h === 0) segs.push(lineCubic(a.p, b.p));
		else
			segs.push([
				a.p,
				[a.p[0] + a.t[0] * a.h, a.p[1] + a.t[1] * a.h],
				[b.p[0] - b.t[0] * b.h, b.p[1] - b.t[1] * b.h],
				b.p,
			]);
	}
	return dir([{ segs, closed: true }], s.direction);
}
