// three-d: the solid of a text / shape layer for Advanced 3D, from its delivered picture (extrude.ts traces the
// picture's alpha). Pictures are frame-sized canvases: only the bounding box of the drawn pixels is traced. Pictures
// arrive every frame, new versions of the same pixels when nothing moved, so a solid is keyed by what shapes it: a hash
// of the alpha and the Geometry Options. A frame that animates only the camera, lights or materials reuses the mesh,
// and the renderer its GPU buffers (spec 19 TL-070: geometry rebuilds are cached).
import {
	buildTitleSolid,
	invertMat3,
	type Mat3,
	type Mesh,
	type RenderVisualClip,
	type SolidGeometry,
	shapesOfAlpha,
	solidGeometryAt,
} from '@jasper/project';

type Entry = { key: string; mesh: Mesh | null };
/** Solids per clip: an animated title may come back to an earlier state, a scrub back and forth surely does. */
const PER_CLIP = 4;
const cache = new Map<string, Entry[]>();
let builds = 0;

/** How many solids were built (tests: a moving camera builds none). */
export const solidBuilds = (): number => builds;

/** Geometry Options at content time `t`, or null when the layer is not a solid. */
export function geometryAt(clip: Pick<RenderVisualClip, 'kind' | 'threeD'>, t: number): SolidGeometry | null {
	return solidGeometryAt(clip, t);
}

/** FNV-1a of the alpha bytes, with the bounds of the drawn pixels. */
function alphaHash(data: Uint8ClampedArray, width: number, height: number) {
	const words = new Uint32Array(data.buffer, data.byteOffset, width * height);
	let h = 0x811c9dc5;
	let x0 = width;
	let y0 = height;
	let x1 = -1;
	let y1 = -1;
	let i = 0;
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const a = words[i++]! >>> 24;
			if (a === 0) continue;
			h = Math.imul(h ^ a ^ (x * 31 + y), 0x01000193);
			if (x < x0) x0 = x;
			if (x > x1) x1 = x;
			if (y < y0) y0 = y;
			if (y > y1) y1 = y;
		}
	return { hash: h >>> 0, x0, y0, x1, y1 };
}

/** The solid (layer px) of a layer's picture, or null when nothing is drawn. */
export function extrudedMesh(
	clipId: string,
	picture: { canvas: HTMLCanvasElement; version: number; width: number; height: number },
	layerToPicture: Mat3,
	g: SolidGeometry,
	outputScale = 1,
): Mesh | null {
	const ctx = picture.canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return null;
	const { width, height } = picture;
	const data = ctx.getImageData(0, 0, width, height).data;
	const { hash, x0, y0, x1, y1 } = alphaHash(data, width, height);
	const key = `${hash}|${width}x${height}|${layerToPicture.join(',')}|${outputScale}|${JSON.stringify(g)}`;
	const list = cache.get(clipId) ?? [];
	const hit = list.find((e) => e.key === key);
	if (hit) return hit.mesh;
	builds++;
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
		// Bevels, plates and extrusion are in layer px, as the outline now is.
		mesh = shapes.length ? buildTitleSolid(shapes, g, outputScale) : null;
	}
	list.push({ key, mesh });
	if (list.length > PER_CLIP) list.shift();
	cache.delete(clipId);
	cache.set(clipId, list);
	if (cache.size > 256) cache.delete(cache.keys().next().value!);
	return mesh;
}
