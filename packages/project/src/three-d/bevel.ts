// Bevel cross-sections of 3D titles (spec 19 TL-070), ported from Pachislop `src/engine/three/bevel.ts`
// (licenses/ported/pachislop-three-d.md). Pure maths, shared by the extruder and the Properties cross-section.
//
// Unit space: o = 0 inner edge → 1 outer edge; h = drop along the extrusion as a fraction of the band's depth
// (negative = rises towards the viewer). A profile is a list of PIECES joined at facet corners; each piece is a
// polyline whose points carry the unit-space tangent where the surface is smooth (arcs, bent risers), so the extruder
// gives them analytic normals instead of faceted ones.
//
// `curve` bends every piece by an exponent on its drop: h = h0 + (h1 − h0) · s^p with p = 4^curve along the piece
// (arcs: along the arc angle). p > 1 keeps the bevel high longer (fuller), p < 1 drops at the inner edge (pinched).
import { type BevelProfile, MAX_BEVEL_SEGMENTS } from '../schema/three-d.ts';

export type UnitPoint = {
	o: number;
	h: number;
	/** Unit-space tangent (do, dh) where the profile is smooth; absent at facet corners. */
	t?: [number, number];
};

const QUARTER = Math.PI / 2;
/** Parameter step of the finite-difference tangent (pieces are parametrised over 0…1). */
const DT = 1e-3;

type Piece = { f: (s: number) => [number, number]; segments: number; smooth: boolean };

/** One piece sampled; tangents by central differences (one-sided at the ends). */
function samplePiece({ f, segments, smooth }: Piece): UnitPoint[] {
	const out: UnitPoint[] = [];
	for (let k = 0; k <= segments; k++) {
		const s = k / segments;
		const [o, h] = f(s);
		if (!smooth) {
			out.push({ o, h });
			continue;
		}
		const s0 = Math.max(0, s - DT);
		const s1 = Math.min(1, s + DT);
		const a = f(s0);
		const b = f(s1);
		out.push({ o, h, t: [(b[0] - a[0]) / (s1 - s0), (b[1] - a[1]) / (s1 - s0)] });
	}
	return out;
}

/** Clamped integer facet count. */
export function bevelSegments(segments: number): number {
	return Math.max(1, Math.min(MAX_BEVEL_SEGMENTS, Math.round(segments) || 1));
}

/** Pieces of a profile in unit space. `curve` is −1…1; `segments` facets every curved piece. */
export function unitBevel(profile: BevelProfile, segments: number, curve: number): UnitPoint[][] {
	const n = bevelSegments(segments);
	const p = 4 ** Math.max(-1, Math.min(1, Number.isFinite(curve) ? curve : 0));
	const bent = Math.abs(p - 1) > 1e-6;
	const bend = (s: number) => (bent ? Math.max(0, s) ** p : s);
	// A riser (both o and h change) bends into a smooth curve when curve ≠ 0.
	const line = (o0: number, h0: number, o1: number, h1: number): Piece => {
		const riser = bent && o0 !== o1 && h0 !== h1;
		return {
			f: (s) => [o0 + (o1 - o0) * s, h0 + (h1 - h0) * (riser ? bend(s) : s)],
			segments: riser ? n : 1,
			smooth: riser,
		};
	};
	// A quarter arc from h = 0 to 1, parametrised by angle; the bend applies to the drop.
	const arc = (o: (t: number) => number, h: (t: number) => number): Piece => ({
		f: (s) => [o(s * QUARTER), bend(h(s * QUARTER))],
		segments: n,
		smooth: true,
	});
	const pieces: Record<BevelProfile, () => Piece[]> = {
		// A flat ring at the inner height, then a vertical step down at the outer edge.
		flat: () => [line(0, 0, 1, 0), line(1, 0, 1, 1)],
		chamfer: () => [line(0, 0, 1, 1)],
		// Convex quarter round: flat where it meets the inner part, vertical at the outer edge.
		round: () => [arc(Math.sin, (t) => 1 - Math.cos(t))],
		// Concave quarter: drops steeply from the inner edge and runs out flat.
		cove: () => [arc((t) => 1 - Math.cos(t), Math.sin)],
		// Two risers with a front-facing ledge between them, ending on a ledge.
		step: () => [
			line(0, 0, 0.15, 0.5),
			line(0.15, 0.5, 0.5, 0.5),
			line(0.5, 0.5, 0.65, 1),
			line(0.65, 1, 1, 1),
		],
		// A raised rim: rises from the inner edge, flat on top (the inner part sits recessed).
		inset: () => [line(0, 0, 0.4, -1), line(0.4, -1, 1, -1)],
		// A half-round tube: a crest `depth` high at mid-width, back to the inner height at the outer edge.
		tube: () => [
			{
				f: (s) => [(1 - Math.cos(s * Math.PI)) / 2, -(Math.sin(s * Math.PI) ** (1 / p))],
				segments: 2 * n,
				smooth: true,
			},
		],
	};
	return (pieces[profile] ?? pieces.chamfer)().map(samplePiece);
}

/**
 * Effective facet count at an output scale (`outputPxPerUnit` = output px per layer px): a facet's sagitta grows
 * linearly with the scale and shrinks with the square of the count, so the count grows with √scale.
 */
export function effectiveSegments(segments: number, outputPxPerUnit: number): number {
	return Math.min(
		MAX_BEVEL_SEGMENTS,
		Math.ceil(bevelSegments(segments) * Math.sqrt(Math.max(1, outputPxPerUnit))),
	);
}

/** Share of the band stack that lies outside the traced outline. */
export const BEVEL_OUTSIDE_SHARE = { outside: 1, center: 0.5, inside: 0 } as const;
