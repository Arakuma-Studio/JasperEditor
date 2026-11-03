// Spec 19 TL-051: how a colourway reaches a generator. A generator draws its own picture, so its colours cannot be roles:
// each pixel is gradient-mapped by its luma onto a light ramp built from the palette, so brightness stays and hue and
// saturation take the colourway's. Near-white pixels are left alone, which keeps hot cores white. A layer marked
// `fixedColor` skips this (fire keeps its own colours). Rule ported from Pachislop's presets/colourways.ts (`LIGHT`,
// `onRamp`, `isWhiteCore`), which applied it once to stored colours; here it runs per pixel, so a generator's params and
// a keyed palette need no rewriting (licenses/ported/pachislop-looks.md).
import type { RGBA } from '../../../schema/common.ts';
import type { Role } from '../../../title-looks/model.ts';
import type { GlslChunk } from '../shader.ts';
import { GLSL_TL_PAINT, GLSL_TL_SURFACE } from './glsl.ts';
import { gradientRamp } from './paint.ts';

/** Every channel at least this: a white core, left as it is (Pachislop's `WHITE_CORE`). */
export const RECOLOR_WHITE_CORE = 0.92;

/** Rec. 601 luma of a signal colour: what the ramp is positioned by (design tools' gradient map). */
export const recolorLuma = (c: readonly number[]): number => 0.299 * c[0]! + 0.587 * c[1]! + 0.114 * c[2]!;

const BLACK: RGBA = [0, 0, 0, 1];
const WHITE: RGBA = [1, 1, 1, 1];

/**
 * The light ramp of a palette: black, `shadow`, `glow`, `accent3`, white, each at its own luma. A colour's position is its
 * luma, so a mapped pixel keeps its luma; a role out of order (a highlight darker than the glow) is left out.
 */
export function recolorStops(palette: Record<Role, RGBA>): { at: number; color: RGBA }[] {
	const out: { at: number; color: RGBA }[] = [{ at: 0, color: BLACK }];
	for (const role of ['shadow', 'glow', 'accent3'] as const) {
		const c = palette[role];
		const at = recolorLuma(c);
		if (at > out.at(-1)!.at + 0.01 && at < 0.995) out.push({ at, color: [c[0], c[1], c[2], 1] });
	}
	out.push({ at: 1, color: WHITE });
	return out;
}

/** The ramp as the planner binds it (`u_tlRecolorRamp`): premultiplied linear entries. */
export function recolorRamp(palette: Record<Role, RGBA>): Float32Array {
	return gradientRamp(
		{
			type: 'linear',
			span: 'block',
			angle: 0,
			stops: recolorStops(palette).map((s) => ({ at: s.at, paint: { color: s.color } })),
		},
		palette,
	);
}

/** `tl_recolor(c)`: premultiplied linear in and out; alpha never changes. `u_tlRecolor` off = a fixed layer. */
export const GLSL_TL_RECOLOR: GlslChunk = {
	name: 'title-look/recolor',
	deps: [GLSL_TL_SURFACE, GLSL_TL_PAINT],
	source: /* glsl */ `
vec4 tl_recolor(vec4 c) {
  if (!u_tlRecolor || c.a <= 0.0) return c;
  vec3 straight = fx_linearToSrgb(clamp(c.rgb / c.a, 0.0, 1.0));
  float luma = dot(straight, vec3(0.299, 0.587, 0.114));
  vec3 mapped = tl_ramp(u_tlRecolorRamp, luma).rgb;
  float core = smoothstep(${(RECOLOR_WHITE_CORE - 0.04).toFixed(2)}, ${RECOLOR_WHITE_CORE.toFixed(2)}, min(straight.r, min(straight.g, straight.b)));
  return vec4(mix(mapped, c.rgb / c.a, core) * c.a, c.a);
}
`,
};
