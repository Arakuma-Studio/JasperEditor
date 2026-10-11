// Family-private helpers of the Premiere transition family (premiere-transitions.ts): Premiere's edge selectors as
// enum params (+ their vectors), a few number readers and the family GLSL chunk `premiere/common`.
// Import rule (no cycles): values only from ../define.ts, ../glsl.ts, ../shader.ts and ../../fx/*; types from
// ../../../transitions.ts and ../../effects.ts (`import type`).
import type { ParamValue, Vec2 } from '../../../schema/common.ts';
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { fxParam } from '../../fx/params.ts';
import type { FxUniformValue, GlslChunk } from '../../fx/shader.ts';
import { numberParam as num } from '../../param-values.ts';
import { defineShaderTransition, type ShaderTransitionInit } from '../define.ts';
import { GLSL_TR_WIPE, GLSL_TRANSITION } from '../glsl.ts';
import type { TrFrameContext } from '../shader.ts';

export const count = (v: ParamValue | undefined, d: number, max = 256): number =>
	Math.min(max, Math.max(1, Math.round(num(v, d))));

type Vec = readonly [number, number];
type Selector = { values: readonly string[]; labels: readonly string[]; vectors: Record<string, Vec> };

const D = Math.SQRT1_2;

/** Premiere's four edge selectors (the direction the incoming clip / the wipe travels). */
export const DIR4: Selector = {
	values: ['westToEast', 'eastToWest', 'northToSouth', 'southToNorth'],
	labels: ['West to East', 'East to West', 'North to South', 'South to North'],
	vectors: { westToEast: [1, 0], eastToWest: [-1, 0], northToSouth: [0, 1], southToNorth: [0, -1] },
};

/** The eight edge selectors (4 edges + 4 corners), unit vectors. */
export const DIR8: Selector = {
	values: [
		...DIR4.values,
		'northWestToSouthEast',
		'northEastToSouthWest',
		'southWestToNorthEast',
		'southEastToNorthWest',
	],
	labels: [
		...DIR4.labels,
		'North West to South East',
		'North East to South West',
		'South West to North East',
		'South East to North West',
	],
	vectors: {
		...DIR4.vectors,
		northWestToSouthEast: [D, D],
		northEastToSouthWest: [-D, D],
		southWestToNorthEast: [D, -D],
		southEastToNorthWest: [-D, -D],
	},
};

/** Corner selectors: the corner the transition starts from (vector = the corner in frame uv). */
export const CORNERS: Selector = {
	values: ['northWest', 'northEast', 'southEast', 'southWest'],
	labels: ['From North West', 'From North East', 'From South East', 'From South West'],
	vectors: { northWest: [0, 0], northEast: [1, 0], southEast: [1, 1], southWest: [0, 1] },
};

/** Two orientations (Barn Doors, Split, Flip Over): the axis the motion happens along. */
export const ORIENT: Selector = {
	values: ['horizontal', 'vertical'],
	labels: ['Horizontal', 'Vertical'],
	vectors: { horizontal: [1, 0], vertical: [0, 1] },
};

/** Start positions of the angular wipes (Wedge Wipe): the angle (deg, 0° = right, clockwise) of each. */
export const START4: Selector = {
	values: ['north', 'east', 'south', 'west'],
	labels: ['From North', 'From East', 'From South', 'From West'],
	vectors: { north: [-90, 0], east: [0, 0], south: [90, 0], west: [180, 0] },
};

/** An edge-selector param (`u_<name>` int) with Premiere's labels. */
export function selectorParam(
	sel: Selector,
	def: string,
	name = 'direction',
	label = 'Direction',
): ParamSpec {
	return fxParam.choice(name, label, sel.values, sel.labels, def);
}

/** The vector of a selector param value (falls back to the first option). */
export function selectorVec(sel: Selector, p: EffectParams, name = 'direction'): [number, number] {
	const v = sel.vectors[String(p[name])] ?? sel.vectors[sel.values[0]!]!;
	return [v[0], v[1]];
}

/** Index of a selector param value. */
export function selectorIndex(sel: Selector, p: EffectParams, name = 'direction'): number {
	return Math.max(0, sel.values.indexOf(String(p[name])));
}

/** A whole count param (bands, wedges, slices). */
export function countParam(name: string, label: string, def: number, max = 64): ParamSpec {
	return fxParam.number(name, label, def, { min: 1, max, softMax: Math.min(max, 32), step: 1 });
}

/**
 * `premiere/common`: frame axes along a direction, margins of moving edges and angular sweeps. Every distance is in
 * sequence px; "B side" distances are > 0 where the incoming clip shows (the `tr_wipeMix` convention).
 */
export const GLSL_PR_COMMON: GlslChunk = {
	name: 'premiere/common',
	deps: [GLSL_TRANSITION, GLSL_TR_WIPE],
	source: /* glsl */ `
const float PR_PI = 3.14159265358979;
const float PR_TAU = 6.28318530717959;
// px relative to the frame centre in the axes of dir (unit): x along dir, y across (dir rotated 90° clockwise).
vec2 pr_axes(vec2 px, vec2 dir) { vec2 q = px - 0.5 * u_compSize; return vec2(dot(q, dir), dot(q, vec2(-dir.y, dir.x))); }
// Half extents of the frame along dir and across it.
vec2 pr_extent(vec2 dir) {
  vec2 n = vec2(-dir.y, dir.x);
  return 0.5 * vec2(dot(abs(dir), u_compSize), dot(abs(n), u_compSize));
}
// A size that grows from -margin (nothing, the edge and its border off the frame) at p = 0 to full + margin at p = 1.
float pr_grow(float p, float full, float margin) { return mix(-margin, full + margin, p); }
// Signed distance (px, > 0 inside) of an axis-aligned box of half size hs around c; hs may be negative (= empty box
// shrunk further: the distance keeps decreasing, so p = 0 leaves no anti-aliased dot).
float pr_box(vec2 px, vec2 c, vec2 hs) {
  float neg = min(min(hs.x, hs.y), 0.0);
  return tr_boxDist(px, c, max(hs, vec2(0.0))) + neg;
}
// Angular sweeps (clock, wedge, pinwheel, radial): the arc distance uses a radius of at least 10 % of the cover
// radius so the overshoot that clears the border is a few percent of the transition (not infinite at the centre).
float pr_arcRadius(float r, float coverR) { return max(r, max(1.0, 0.1 * coverR)); }
// Swept angle (radians) of a sweep of span radians at progress p: from -mu (nothing, not even the anti-aliased start
// line) to span + mu (the edge and its border have left), mu = margin px at the minimum arc radius.
float pr_sweep(float p, float span, float margin, float coverR) {
  float mu = margin / max(1.0, 0.1 * coverR);
  return mix(-mu, span + mu, p);
}
`,
};

export type EdgeWipeInit = Omit<ShaderTransitionInit, 'gpu' | 'options'> & {
	/** Premiere's Border Width / Color (default true). */
	border?: boolean;
	/** The Center option (true or its default point). */
	center?: boolean | Vec2;
	/** Derived uniforms (direction vectors, …). */
	uniforms?(p: EffectParams, ctx: TrFrameContext): Readonly<Record<string, FxUniformValue>>;
	include?: readonly GlslChunk[];
	/** GLSL helpers placed before main(). */
	helpers?: string;
	/**
	 * GLSL statements that set `float d` (signed px distance, > 0 = B side) from `vec2 px` (sequence px), `float p`
	 * (progress), `float aa` (edge width) and `float m` (the margin the edge and its border need to leave the frame:
	 * d <= -m everywhere at p = 0 and d >= m at p = 1).
	 */
	body: string;
};

/**
 * A Premiere wipe: B is revealed where a signed distance `d` is positive, through the standard edge (Anti-aliasing
 * Quality) and border (Border Width / Color, drawn on B's side), with Reverse (swap) and optionally Center.
 */
export function defineEdgeWipe(init: EdgeWipeInit): TransitionSpec {
	const border = init.border !== false;
	const { body, helpers, include, uniforms, center, border: _b, ...rest } = init;
	return defineShaderTransition({
		...rest,
		options: { border, antiAliasing: true, ...(center ? { center } : {}) },
		gpu: {
			...(uniforms ? { uniforms } : {}),
			passes: [
				{
					include: [GLSL_PR_COMMON, ...(include ?? [])],
					frag: /* glsl */ `
${helpers ?? ''}
void main() {
  vec2 px = tr_px();
  float p = tr_progress();
  float aa = tr_aaWidth(u_antiAliasing);
  float bw = ${border ? 'max(u_borderWidth, 0.0)' : '0.0'};
  float m = bw + aa + 1.0;
  float d = 0.0;
  ${body.trim()}
  fragColor = tr_wipeMix(tr_from(v_uv), tr_to(v_uv), d, 0.0, aa, bw, ${border ? 'u_borderColor' : 'vec4(0.0)'});
}`,
				},
			],
		},
	});
}

export { num };
