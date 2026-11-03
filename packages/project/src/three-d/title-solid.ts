// The solid of a 3D title (spec 19 TL-070, TL-072, TL-073), from outlines traced from the layer's picture: extruded with
// bevel bands, or inflated, with backplates behind. Ported from Pachislop `src/engine/three/title.ts`
// (licenses/ported/pachislop-three-d.md); its outlines come from opentype with Clipper offsets, ours from `offset.ts`.
//
// z runs from the front face (z 0) away from the viewer. Every number here is an evaluated value: `solidGeometryAt`
// produces them, and a change of any of them rebuilds the mesh, while materials, lights and cameras never do.
import { anim } from '../factories.ts';
import { evaluate } from '../keyframes.ts';
import type { Animatable } from '../schema/common.ts';
import type {
	Backplate,
	BevelBand,
	BevelPosition,
	BevelProfile,
	BevelStyle,
	InflateCurvePoint,
	InflateOptions,
	Layer3D,
	PlateShape,
} from '../schema/three-d.ts';
import { MAX_BACKPLATES, MAX_BEVEL_BANDS } from '../schema/three-d.ts';
import { BEVEL_OUTSIDE_SHARE, effectiveSegments } from './bevel.ts';
import { extrudeShapes, type Mesh, type Shape2D, simplifyLoop } from './extrude.ts';
import {
	emitInflate,
	inflateCurveFn,
	inflateField,
	inflateScale,
	inflateStep,
	inflateWallTop,
} from './inflate.ts';
import { finiteOr } from './math.ts';
import {
	boxShape,
	distanceField,
	hullShape,
	isoShapes,
	nearestOutline,
	offsetShapes,
	offsetStep,
} from './offset.ts';
import { bandSpans, extrudeSolid, MeshBuilder, type ProfileSpan } from './solid.ts';
import { plateFaceSlot, plateSideSlot, SLOT_BACK, SLOT_BAND0, SLOT_FACE, SLOT_SIDE } from './surfaces.ts';

export type SolidBand = {
	width: number;
	depth: number;
	profile: BevelProfile;
	curve: number;
	segments: number;
};
export type SolidPlate = {
	enabled: boolean;
	shape: PlateShape;
	grow: number;
	depth: number;
	gap: number;
	corner: number;
	fillCounters: boolean;
	bevelWidth: number;
	bevelDepth: number;
	bevelProfile: BevelProfile;
};

/** Evaluated Geometry Options: all a solid depends on. */
export type SolidGeometry = {
	mode: 'extrude' | 'inflate';
	depth: number;
	bevelStyle: BevelStyle;
	bevelDepth: number;
	holeBevel: number;
	position: BevelPosition;
	bands: SolidBand[];
	inflate: { height: number; curve: readonly InflateCurvePoint[]; smoothness: number; detail: number } | null;
	plates: SolidPlate[];
};

/** Default inflate height curve: a rounded dome. */
export const DEFAULT_INFLATE_CURVE: readonly InflateCurvePoint[] = [
	{ x: 0, y: 0 },
	{ x: 0.35, y: 0.72 },
	{ x: 1, y: 1 },
];

/** Inflate options at their defaults. */
export function newInflate(): InflateOptions {
	return {
		height: anim(30),
		curve: DEFAULT_INFLATE_CURVE.map((p) => ({ ...p })),
		smoothness: anim(60),
		detail: 1,
	};
}

/** Most ring vertices × profile stations of one solid: keeps a hostile trace from allocating gigabytes. */
export const MAX_SOLID_QUADS = 1_500_000;

/** Geometry Options at content time `t`, or null when the layer is not a solid. */
export function solidGeometryAt(clip: { kind: string; threeD?: Layer3D }, t: number): SolidGeometry | null {
	const g = clip.threeD?.geometry;
	if (!g || (clip.kind !== 'text' && clip.kind !== 'shape')) return null;
	const num = (a: Animatable<number> | undefined, d: number) => (a ? finiteOr(evaluate(a, t), d) : d);
	const pos = (a: Animatable<number> | undefined, d: number) => Math.max(0, num(a, d));
	const depth = pos(g.extrusionDepth, 0);
	const bands: SolidBand[] = ((g.bands ?? []) as BevelBand[]).slice(0, MAX_BEVEL_BANDS).map((b) => ({
		width: pos(b.width, 0),
		depth: pos(b.depth, 0),
		profile: b.profile,
		curve: Math.min(1, Math.max(-1, num(b.curve, 0) / 100)),
		segments: finiteOr(b.segments, 6),
	}));
	const plates: SolidPlate[] = ((g.backplates ?? []) as Backplate[]).slice(0, MAX_BACKPLATES).map((p) => ({
		enabled: p.enabled !== false,
		shape: p.shape,
		grow: pos(p.grow, 0),
		depth: pos(p.depth, 0),
		gap: num(p.gap, 0),
		corner: pos(p.corner, 0),
		fillCounters: !!p.fillCounters,
		bevelWidth: pos(p.bevelWidth, 0),
		bevelDepth: pos(p.bevelDepth, 0),
		bevelProfile: p.bevelProfile,
	}));
	const inf = g.mode === 'inflate' ? (g.inflate as InflateOptions | undefined) : undefined;
	const inflate =
		g.mode === 'inflate'
			? {
					height: pos(inf?.height, 30),
					curve: inf?.curve ?? DEFAULT_INFLATE_CURVE,
					smoothness: Math.min(100, pos(inf?.smoothness, 60)),
					detail: Math.min(4, Math.max(1, finiteOr(inf?.detail, 1))),
				}
			: null;
	if (depth <= 0 && !inflate && !bands.length && !plates.some((p) => p.enabled)) return null;
	return {
		mode: inflate ? 'inflate' : 'extrude',
		depth,
		bevelStyle: g.bevelStyle,
		bevelDepth: pos(g.bevelDepth, 2),
		holeBevel: pos(g.holeBevelDepth, 100),
		position: g.bevelPosition ?? 'inside',
		bands,
		inflate,
		plates,
	};
}

const pointsOf = (shapes: readonly Shape2D[]) =>
	shapes.reduce((n, s) => n + s.outer.length + s.holes.reduce((m, h) => m + h.length, 0), 0);

/** Outlines coarsened until `stations` rings of them stay under the quad budget. */
function bounded(shapes: readonly Shape2D[], stations: number): readonly Shape2D[] {
	let out = shapes;
	let tolerance = 0.5;
	for (let k = 0; k < 8 && pointsOf(out) * stations > MAX_SOLID_QUADS; k++) {
		const t = tolerance;
		out = out.map((s) => ({
			outer: simplifyLoop(s.outer, t),
			holes: s.holes.map((h) => simplifyLoop(h, t)).filter((h) => h.length >= 3),
		}));
		tolerance *= 2;
	}
	return out;
}

/** Appends one mesh to a builder (the classic solid under plates). */
function appendMesh(b: MeshBuilder, m: Mesh): void {
	const v = m.vertices;
	const base = b.vertexCount;
	for (let i = 0; i + 8 < v.length; i += 9)
		b.vertex(v[i]!, v[i + 1]!, v[i + 2]!, v[i + 3]!, v[i + 4]!, v[i + 5]!, v[i + 6]!, v[i + 7]!, v[i + 8]!);
	for (let i = 0; i + 2 < m.indices.length; i += 3)
		b.tri(base + m.indices[i]!, base + m.indices[i + 1]!, base + m.indices[i + 2]!);
}

/**
 * The solid of `shapes` (layer px). `outputScale` = output px per layer px: curved bands take more facets and grids
 * get finer on larger exports, in powers of two so preview zooms rarely rebuild.
 */
export function buildTitleSolid(shapes: readonly Shape2D[], g: SolidGeometry, outputScale = 1): Mesh {
	const scale = inflateScale(outputScale);
	const b = new MeshBuilder();
	const holeScale = g.holeBevel / 100;
	const bandsWidth = g.bands.reduce((s, x) => s + x.width, 0);
	const outW = g.mode === 'extrude' ? bandsWidth * BEVEL_OUTSIDE_SHARE[g.position] : 0;
	const grown = g.plates.filter((p) => p.enabled).reduce((s, p) => s + p.grow, 0);
	const field =
		outW > 0 || g.plates.some((p) => p.enabled)
			? distanceField(shapes, outW + grown + 2, offsetStep(scale))
			: null;
	// A point outside the traced outline shows the picture just inside its nearest outline point.
	const colourAt = field
		? (x: number, y: number, nx: number, ny: number): [number, number] => {
				const q = nearestOutline(field, x, y);
				if (!q) return [x, y];
				const dx = q[0] - x;
				const dy = q[1] - y;
				const l = Math.hypot(dx, dy);
				if (l < 1e-6) return [x - nx * 1.5, y - ny * 1.5];
				return [q[0] + (dx / l) * 1.5, q[1] + (dy / l) * 1.5];
			}
		: undefined;
	let top = 0;
	let back = g.depth;
	if (g.mode === 'inflate' && g.inflate) {
		const inflate = g.inflate;
		const profile = inflateCurveFn(inflate.curve);
		const height = inflate.height;
		const list = bounded(shapes, 4);
		const step = inflateStep(list, scale, inflate.detail);
		const fields = list.map((s) => inflateField(s, step));
		const maxDist = Math.max(0, ...fields.map((f) => f.maxDist));
		top = inflateWallTop(height, profile);
		back = top + g.depth;
		for (const f of fields)
			emitInflate(b, f, {
				faceSlot: SLOT_FACE,
				wallSlot: SLOT_SIDE,
				backSlot: SLOT_BACK,
				height,
				profile,
				maxDist,
				zBack: back,
				smoothness: inflate.smoothness,
			});
	} else if (g.bands.length) {
		const spans: ProfileSpan[] = [];
		let cur = { off: -bandsWidth, z: 0 };
		g.bands.forEach((band, i) => {
			cur = bandSpans(
				spans,
				SLOT_BAND0 + i,
				cur.off,
				cur.z,
				band.width,
				band.depth,
				band,
				effectiveSegments(band.segments, scale),
			);
		});
		top = cur.z;
		back = top + g.depth;
		const base = outW > 0 && field ? isoShapes(field, outW) : shapes;
		extrudeSolid(b, bounded(base, spans.length + 3), {
			cap: { off: -bandsWidth, z: 0, slot: SLOT_FACE },
			spans,
			wallSlot: SLOT_SIDE,
			backSlot: SLOT_BACK,
			zBack: back,
			holeScale,
			...(outW > 0 && colourAt ? { colourAt } : {}),
		});
	} else if (g.depth > 0) {
		appendMesh(
			b,
			extrudeShapes(bounded(shapes, 16), {
				depth: g.depth,
				bevelStyle: g.bevelStyle,
				bevelDepth: g.bevelDepth,
				holeBevel: g.holeBevel,
			}),
		);
	}
	// Backplates: a base outline grown by the cumulative grow, stacked behind. A negative gap sinks a plate into the
	// previous solid, but never past that solid's wall top, so a plate cannot cover the letters in front of it.
	let grow = outW;
	g.plates.forEach((p, k) => {
		if (!p.enabled) return;
		grow += p.grow;
		const zFront = Math.max(back + p.gap, top);
		const spans: ProfileSpan[] = [];
		const faceSlot = plateFaceSlot(k);
		const sideSlot = plateSideSlot(k);
		const end = bandSpans(
			spans,
			faceSlot,
			-p.bevelWidth,
			zFront,
			p.bevelWidth,
			p.bevelDepth,
			{ profile: p.bevelProfile, curve: 0 },
			effectiveSegments(6, scale),
		);
		top = end.z;
		back = top + p.depth;
		let list: readonly Shape2D[] = [];
		if (p.shape === 'contour') list = field ? isoShapes(field, grow, p.fillCounters) : [];
		else if (p.shape === 'hull') {
			const hull = hullShape(shapes);
			list = hull ? offsetShapes([hull], grow, scale) : [];
		} else {
			const box = boxShape(shapes, grow, p.corner);
			list = box ? [box] : [];
		}
		extrudeSolid(b, bounded(list, spans.length + 3), {
			cap: { off: -p.bevelWidth, z: zFront, slot: faceSlot },
			spans,
			wallSlot: sideSlot,
			backSlot: sideSlot,
			zBack: back,
			...(colourAt ? { colourAt, capColour: true } : {}),
		});
	});
	return b.build();
}
