// three-d: the extruded solid of a text / shape layer for Advanced 3D, from its delivered picture (extrude.ts traces
// the picture's alpha). Pictures are frame-sized canvases: only the bounding box of the drawn pixels is traced. The
// last solid of each layer is kept while its picture and Geometry Options do not change.
import {
	evaluate,
	extrudeShapes,
	invertMat3,
	type Layer3D,
	type Mat3,
	type Mesh,
	type RenderVisualClip,
	shapesOfAlpha,
} from '@jasper/project';

const cache = new Map<string, { key: string; mesh: Mesh | null }>();

/** Geometry Options at content time `t`, or null when the layer is not extruded. */
export function geometryAt(
	clip: Pick<RenderVisualClip, 'kind' | 'threeD'>,
	t: number,
): {
	depth: number;
	bevelStyle: NonNullable<Layer3D['geometry']>['bevelStyle'];
	bevelDepth: number;
	holeBevel: number;
} | null {
	const g = clip.threeD?.geometry;
	if (!g || (clip.kind !== 'text' && clip.kind !== 'shape')) return null;
	const num = (a: unknown, d: number) => {
		const v = a ? (evaluate(a as never, t) as number) : d;
		return Number.isFinite(v) ? v : d;
	};
	const depth = Math.max(0, num(g.extrusionDepth, 0));
	if (depth <= 0) return null;
	return {
		depth,
		bevelStyle: g.bevelStyle,
		bevelDepth: Math.max(0, num(g.bevelDepth, 2)),
		holeBevel: Math.max(0, num(g.holeBevelDepth, 100)),
	};
}

/** The extruded solid (layer px) of a layer's picture, or null when nothing is drawn. */
export function extrudedMesh(
	clipId: string,
	picture: { canvas: HTMLCanvasElement; version: number; width: number; height: number },
	layerToPicture: Mat3,
	g: NonNullable<ReturnType<typeof geometryAt>>,
): Mesh | null {
	const key = `${picture.version}|${picture.width}x${picture.height}|${layerToPicture.join(',')}|${g.depth}|${g.bevelStyle}|${g.bevelDepth}|${g.holeBevel}`;
	const hit = cache.get(clipId);
	if (hit && hit.key === key) return hit.mesh;
	const ctx = picture.canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return null;
	const { width, height } = picture;
	const data = ctx.getImageData(0, 0, width, height).data;
	let x0 = width;
	let y0 = height;
	let x1 = -1;
	let y1 = -1;
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++)
			if (data[(y * width + x) * 4 + 3]! > 0) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
			}
	let mesh: Mesh | null = null;
	const inv = invertMat3(layerToPicture);
	if (x1 >= x0 && inv) {
		const w = x1 - x0 + 1;
		const h = y1 - y0 + 1;
		const shapes = shapesOfAlpha(w, h, (x, y) => data[((y + y0) * width + (x + x0)) * 4 + 3]!).map((s) => {
			const toLayer = (p: [number, number]): [number, number] => {
				const px = p[0] + x0;
				const py = p[1] + y0;
				const X = inv[0]! * px + inv[1]! * py + inv[2]!;
				const Y = inv[3]! * px + inv[4]! * py + inv[5]!;
				const W = inv[6]! * px + inv[7]! * py + inv[8]!;
				return [X / W, Y / W];
			};
			return { outer: s.outer.map(toLayer), holes: s.holes.map((hl) => hl.map(toLayer)) };
		});
		// Bevel depth and extrusion are in layer px, as the outline now is.
		mesh = shapes.length ? extrudeShapes(shapes, g) : null;
	}
	cache.set(clipId, { key, mesh });
	if (cache.size > 256) cache.delete(cache.keys().next().value!);
	return mesh;
}
