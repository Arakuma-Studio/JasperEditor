// Path queries (path-trace): the geometry behind the expression Path methods (After Effects' `points()`,
// `inTangents()`, `outTangents()`, `isClosed()`, `pointOnPath()`, `tangentOnPath()`, `normalOnPath()`) and the
// trim tracer (`shape.addTrimTracer`). Percentages run along arc length, measured exactly like Trim Paths measures
// (`ops.ts` `Measured`: walked segments, closing line included, adaptive Gauss–Legendre to 1e-4 px), so a point at
// a trim's tip fraction lies on the trimmed stroke's end. Coordinates are those of the space the path lives in
// (the item's group; After Effects: "relative to the anchor point of the path's shape group").
import type { ShapeItem, ShapeItemOf } from '../schema/shapes.ts';
import { findItem } from './defaults.ts';
import { pathItemOutline, type TrimInput, trimInputPaths } from './evaluate.ts';
import { type BezPath, cEval, tangentAt, walkSegments } from './geom.ts';
import { Measured } from './ops.ts';
import { bezToBezierPaths } from './values.ts';

/** Segments a path query measures at most (a Repeater of a dense path can multiply them; bounded cost). */
export const PATH_QUERY_MAX_SEGMENTS = 50_000;

export type ShapeOutlineItem = ShapeItemOf<'rect' | 'ellipse' | 'polystar' | 'path'>;

export const isShapeOutlineItem = (it: ShapeItem): it is ShapeOutlineItem =>
	it.type === 'rect' || it.type === 'ellipse' || it.type === 'polystar' || it.type === 'path';

/** A query failure with an After Effects-style message (expressions report it as their error). */
export class PathQueryError extends Error {}

type V2 = [number, number];

/** Vertices in After Effects' path model: points, tangents relative to their vertex, closed flag. */
export type PathVertices = { closed: boolean; points: V2[]; inTangents: V2[]; outTangents: V2[] };

/** A measured path (one per item outline or trim input and time; cached by the caller). */
export class PathQuery {
	readonly path: BezPath;
	private measured: Measured | null = null;
	constructor(path: BezPath) {
		let n = 0;
		for (const sp of path) n += walkSegments(sp).length;
		if (n > PATH_QUERY_MAX_SEGMENTS)
			throw new PathQueryError(
				`the path has ${n} segments; path methods measure at most ${PATH_QUERY_MAX_SEGMENTS}`,
			);
		this.path = path;
	}

	/** Vertices of every subpath in order; closed when every subpath is closed (a single path: its flag). */
	vertices(): PathVertices {
		const out: PathVertices = { closed: false, points: [], inTangents: [], outTangents: [] };
		const subs = bezToBezierPaths(this.path);
		for (const sp of subs)
			for (const v of sp.vertices) {
				out.points.push([v.p[0], v.p[1]]);
				out.inTangents.push([v.in[0], v.in[1]]);
				out.outTangents.push([v.out[0], v.out[1]]);
			}
		out.closed = subs.length > 0 && subs.every((sp) => sp.closed);
		return out;
	}

	/** Total arc length (pixels of the path's space). */
	get length(): number {
		this.measured ??= new Measured(this.path);
		return this.measured.total;
	}

	/**
	 * Point and unit tangent at fraction `u` of the arc length (clamped to 0…1, as After Effects clamps). A path
	 * without length gives its first point (or [0, 0]) and a zero tangent.
	 */
	at(u: number): { point: V2; tangent: V2 } {
		if (!Number.isFinite(u)) throw new PathQueryError('percentage must be a finite number');
		this.measured ??= new Measured(this.path);
		const m = this.measured;
		const hit = m.locate(Math.min(1, Math.max(0, u)) * m.total);
		if (!hit) {
			const first = this.path.find((sp) => sp.segs.length)?.segs[0]?.[0];
			return { point: first ? [first[0], first[1]] : [0, 0], tangent: [0, 0] };
		}
		return { point: cEval(hit.seg, hit.t), tangent: tangentAt(hit.seg, hit.t) };
	}
}

/** The outline of path item `itemId` at content time `t` (its group's space, direction applied). */
export function shapeItemPath(contents: readonly ShapeItem[], itemId: string, t: number): BezPath {
	const found = findItem(contents as ShapeItem[], itemId);
	if (!found) throw new PathQueryError('Shape item no longer exists');
	if (!isShapeOutlineItem(found.item))
		throw new PathQueryError(`"${found.item.name}" is not a path (rectangle, ellipse, polystar or path)`);
	return pathItemOutline(found.item, t);
}

/**
 * What Trim Paths `trimId` measures at `t`, in its group's space: the path `pathItem` (an item id or name among the
 * paths it trims; the first copy when a Repeater repeats it) for Simultaneously, or with `pathItem` null every path
 * it trims laid end to end in stacking order — what Individually measures.
 */
export function trimPathAt(
	contents: readonly ShapeItem[],
	trimId: string,
	pathItem: string | null,
	t: number,
): { path: BezPath; input: TrimInput } {
	const found = findItem(contents as ShapeItem[], trimId);
	if (!found) throw new PathQueryError('Shape item no longer exists');
	if (found.item.type !== 'trim') throw new PathQueryError(`"${found.item.name}" is not a Trim Paths`);
	const input = trimInputPaths(contents, trimId, t);
	if (!input) throw new PathQueryError(`"${found.item.name}" is in a disabled group: it trims nothing`);
	if (pathItem === null) return { path: input.paths.flatMap((p) => p.path), input };
	let id = pathItem;
	if (!input.paths.some((p) => p.itemId === id)) {
		const byName = findByName(contents, pathItem);
		if (byName) id = byName;
	}
	const slot = input.paths.find((p) => p.itemId === id);
	if (!slot) throw new PathQueryError(`"${pathItem}" is not one of the paths "${found.item.name}" trims`);
	return { path: slot.path, input };
}

function findByName(contents: readonly ShapeItem[], name: string): string | null {
	for (const it of contents) {
		if (it.name === name) return it.id;
		if (it.type === 'group') {
			const r = findByName(it.contents, name);
			if (r) return r;
		}
	}
	return null;
}
