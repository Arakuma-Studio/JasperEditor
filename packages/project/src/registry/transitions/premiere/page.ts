// Premiere ▸ Video Transitions ▸ Page Peel (part of the premiere-transitions family): Page Peel (the outgoing clip
// curls off from a corner around a cylinder, showing the shaded back of the page) and Page Turn (the page folds
// flat over itself). Seen from above in orthographic projection: the page lies in the frame, the fold line moves from
// the chosen corner along the frame diagonal; material behind it wraps around a cylinder of radius R lying on the
// page and, past half a turn, lies flat on top, upside down (its back up). Layers, top to bottom: the flap / upper
// half of the curl (back of the page), the lower half of the curl (front), the flat rest of A, then B — shadowed
// near the curl.
import type { TransitionSpec } from '../../../transitions.ts';
import { fxParam } from '../../fx/params.ts';
import { defineShaderTransition, TRANSITION_BINS } from '../define.ts';
import { GLSL_TR_WIPE } from '../glsl.ts';
import { CORNERS, selectorParam, selectorVec } from './common.ts';

const bin = TRANSITION_BINS.pagePeel;

const BACKS = ['outgoingClip', 'color'] as const;
const BACK_LABELS = ['Outgoing Clip (Mirrored)', 'Color'] as const;

/** The page curl shader; `curl` = the GLSL expression of the cylinder radius in px. */
function peelFrag(curl: string, turn: boolean): string {
	return /* glsl */ `
const float PP_PI = 3.14159265358979;
// A at the page position (s along the peel direction, w across it) of the unpeeled page, with the coverage of the
// page's edge there (anti-aliased).
vec4 ppPage(vec2 K, vec2 n, float s, float w, float aa, out float cov) {
  vec2 X = K + s * n + w * vec2(-n.y, n.x);
  float e = min(min(X.x, u_compSize.x - X.x), min(X.y, u_compSize.y - X.y));
  cov = aa > 0.0 ? clamp(e / aa + 0.5, 0.0, 1.0) : step(0.0, e);
  return tr_from(tr_uvOfPx(clamp(X, vec2(0.0), u_compSize)));
}
// The back of the page at a page position, lit by shade (+ a highlight).
vec4 ppBack(vec4 a, float cov, float shade, float spec) {
  vec4 c = u_back == 1 ? tr_premul(u_backColor) : vec4(mix(a.rgb, vec3(a.a), 0.25), a.a);
  if (u_back == 1 && !u_hasFrom) c = vec4(0.0);
  c.rgb = c.rgb * shade + vec3(spec) * c.a;
  return c * cov;
}
void main() {
  float p = tr_progress();
  float aa = tr_aaWidth(u_antiAliasing);
  vec2 px = tr_px();
  vec2 K = u_corner * u_compSize;
  vec2 n = normalize((1.0 - 2.0 * u_corner) * u_compSize);
  vec2 rel = px - K;
  float s = dot(rel, n);
  float w = dot(rel, vec2(-n.y, n.x));
  float S = dot(abs(n), u_compSize);
  float R = max(${curl}, 0.5);
  // The contact line of the curl: from the corner to past the far corner (curl and its shadow gone).
  float c = mix(0.0, S + R + aa + 2.0, p);
  float sh = u_shadow / 100.0;
  // B, darkened near the curl that hovers over it.
  vec4 col = tr_to(v_uv);
  float gap = c - R - s;
  if (s < c) col.rgb *= 1.0 - sh * 0.6 * exp(-max(gap, 0.0) / (0.5 * R + 10.0)) * smoothstep(0.0, 0.05, p) * (1.0 - smoothstep(0.9, 1.0, p));
  // The flat, unpeeled part of A.
  float cov;
  if (s >= c) col = tr_over(tr_from(v_uv), col);
  // Lower half of the curl (front of the page): s in [c − R, c].
  float silhouette = aa > 0.0 ? clamp((s - (c - R)) / aa + 0.5, 0.0, 1.0) : step(c - R, s);
  if (s > c - R - aa && s < c) {
    float th = asin(clamp((c - s) / R, 0.0, 1.0));
    vec4 a = ppPage(K, n, c - R * th, w, aa, cov);
    float shade = ${turn ? '1.0' : '0.55 + 0.45 * cos(th)'};
    col = tr_over(vec4(a.rgb * shade, a.a) * cov * silhouette, col);
  }
  // Upper half of the curl and the flat flap on top (back of the page).
  if (s > c - R - aa) {
    float th, sOrig;
    if (s < c) { th = PP_PI - asin(clamp((c - s) / R, 0.0, 1.0)); sOrig = c - R * th; }
    else { th = PP_PI; sOrig = 2.0 * c - PP_PI * R - s; }
    vec4 a = ppPage(K, n, sOrig, w, aa, cov);
    // Lighting of the back: brightest where it faces up, a soft highlight on the curl.
    float up = -cos(th);
    float shade = ${turn ? '0.9' : '0.62 + 0.38 * up'};
    float spec = ${turn ? '0.0' : '0.22 * exp(-pow((th - 0.72 * PP_PI) / 0.16, 2.0))'};
    vec4 back = ppBack(a, cov, shade, spec) * (s < c ? silhouette : 1.0);
    col = tr_over(back, col);
  }
  fragColor = col;
}`;
}

const PEEL_PARAMS = [
	selectorParam(CORNERS, 'northWest'),
	fxParam.choice('back', 'Back of Page', BACKS, BACK_LABELS, 'outgoingClip'),
	fxParam.color('backColor', 'Back Color', [0.92, 0.92, 0.9, 1]),
	fxParam.percent('shadow', 'Shadow', 50),
];

/** Page Peel ▸ Page Peel: the page curls off from a corner, the curl showing its shaded back. */
export const PAGE_PEEL = defineShaderTransition({
	id: 'jasper.page-peel',
	label: 'Page Peel',
	bin,
	description:
		'The outgoing clip curls off from a corner like a peeled page, showing its shaded back and revealing the incoming clip underneath.',
	keywords: ['page', 'peel', 'curl', 'paper', 'corner'],
	params: [
		...PEEL_PARAMS,
		fxParam.number('curl', 'Curl Radius', 12, { min: 1, max: 50, step: 0.1 }, { unit: '%' }),
	],
	options: { antiAliasing: true },
	gpu: {
		uniforms: (p) => ({ u_corner: selectorVec(CORNERS, p) }),
		passes: [{ include: [GLSL_TR_WIPE], frag: peelFrag('u_curl / 100.0 * u_compSize.y', false) }],
	},
});

/** Page Peel ▸ Page Turn: the page folds over flat from a corner. */
export const PAGE_TURN = defineShaderTransition({
	id: 'jasper.page-turn',
	label: 'Page Turn',
	bin,
	description:
		'The outgoing clip folds over from a corner like a turned page, its back showing, revealing the incoming clip underneath.',
	keywords: ['page', 'turn', 'fold', 'paper', 'corner'],
	params: PEEL_PARAMS,
	options: { antiAliasing: true },
	gpu: {
		uniforms: (p) => ({ u_corner: selectorVec(CORNERS, p) }),
		passes: [{ include: [GLSL_TR_WIPE], frag: peelFrag('0.75', true) }],
	},
});

export const PREMIERE_PAGE_PEELS: readonly TransitionSpec[] = [PAGE_PEEL, PAGE_TURN];
