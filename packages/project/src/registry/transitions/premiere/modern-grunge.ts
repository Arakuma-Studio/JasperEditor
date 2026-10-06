// Premiere 26 ▸ Video Transitions ▸ Grunge & Distort (from Film Impact): Chaos, Earthquake, Flicker, Glass, Glitch,
// Grunge, Kaleidoscope, Liquid Distortion, TV Power, VHS Damage. Part of the premiere-transitions family; the folder
// sits in MODERN_BINS.grungeDistort until the framework has a Grunge & Distort bin. Every distortion is scaled by a
// bump that is 0 at both ends (A at progress 0, B at 1) and random choices use u_seed + u_frame (deterministic).
import type { TransitionSpec } from '../../../transitions.ts';
import { GLSL_COLOR } from '../../fx/glsl/color.ts';
import { GLSL_HASH } from '../../fx/glsl/hash.ts';
import { GLSL_NOISE } from '../../fx/glsl/noise.ts';
import { fxParam } from '../../fx/params.ts';
import { defineShaderTransition } from '../define.ts';
import { GLSL_TR_BLOCKS } from '../glsl.ts';
import { countParam } from './common.ts';
import { FOLDER_KEYWORDS, GLSL_PR_MODERN, GLSL_PR_NOISE, MODERN_BINS } from './modern-common.ts';

const bin = MODERN_BINS.grungeDistort;
const kw = (...k: string[]) => [...k, ...FOLDER_KEYWORDS.grungeDistort, 'film impact'];

/** Jittered Voronoi cells of a grid: nearest centre, its cell and the gap to the second nearest (cell units). */
const VORONOI = /* glsl */ `
struct PmCell { vec2 id; vec2 centre; float d1; float d2; };
PmCell pmVoronoi(vec2 g, float seed) {
  PmCell c;
  c.d1 = 1e9; c.d2 = 1e9;
  vec2 b = floor(g);
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 id = b + vec2(float(i), float(j));
      vec2 ctr = id + 0.1 + 0.8 * fx_hash22(ivec2(id), seed);
      float d = length(g - ctr);
      if (d < c.d1) { c.d2 = c.d1; c.d1 = d; c.id = id; c.centre = ctr; }
      else if (d < c.d2) c.d2 = d;
    }
  return c;
}`;

/** Grunge & Distort ▸ Chaos: the frame shatters into shards that fly apart and reassemble as B. */
export const CHAOS = defineShaderTransition({
	id: 'jasper.chaos',
	label: 'Chaos',
	bin,
	description:
		'The outgoing clip shatters into shards that are thrown about and flicker, then reassemble into the incoming clip.',
	keywords: kw('chaos', 'shatter', 'shards', 'break', 'explode'),
	params: [countParam('pieces', 'Pieces', 10, 60), fxParam.percent('amount', 'Amount', 100)],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_TR_BLOCKS],
				frag: /* glsl */ `${VORONOI}
void main() {
  float p = tr_progress();
  vec2 grid = tr_squareGrid(u_pieces);
  vec2 g = v_uv * grid;
  PmCell c = pmVoronoi(g, u_seed);
  vec4 h = vec4(fx_hash22(ivec2(c.id) + ivec2(13, 7), u_seed), fx_hash22(ivec2(c.id) + ivec2(3, 29), u_seed));
  // Each shard switches at its own moment around the middle; its throw grows towards it and dies away after.
  float ts = 0.5 + (h.z - 0.5) * 0.3;
  bool isB = p >= ts;
  float e = isB ? (1.0 - p) / (1.0 - ts) : p / ts;
  e = e * e * clamp(u_amount / 100.0, 0.0, 3.0);
  vec2 asp = vec2(tr_aspect(), 1.0);
  float ang = 6.2831853 * h.x;
  vec2 throwV = vec2(cos(ang), sin(ang)) * (0.08 + 0.2 * h.y) * e;
  float rot = (h.w - 0.5) * 1.4 * e;
  vec2 ctrUv = c.centre / grid;
  vec2 v = (v_uv - ctrUv) * asp - throwV;
  float co = cos(rot), si = sin(rot);
  vec2 src = vec2(co * v.x + si * v.y, -si * v.x + co * v.y) / asp + ctrUv;
  vec4 col = pm_sideClamped(isB ? 1 : 0, src);
  col.rgb *= 1.0 + 0.5 * (h.y - 0.5) * min(e, 1.0);
  // Dark cracks between the shards while they are apart.
  float crack = 1.0 - smoothstep(0.0, 0.06, c.d2 - c.d1);
  col.rgb *= 1.0 - 0.85 * crack * min(e * 4.0, 1.0);
  fragColor = col;
}`,
			},
		],
	},
});

/** Grunge & Distort ▸ Earthquake: the picture shakes violently through the cut. */
export const EARTHQUAKE = defineShaderTransition({
	id: 'jasper.earthquake',
	label: 'Earthquake',
	bin,
	description:
		'The picture shakes violently, with motion blur, building up to the cut and settling on the incoming clip.',
	keywords: kw('earthquake', 'shake', 'camera shake', 'tremor', 'rumble'),
	params: [
		fxParam.pixels('amplitude', 'Amplitude', 40, 400),
		fxParam.number('frequency', 'Frequency', 14, { min: 0.5, max: 60, softMax: 30, step: 0.1 }),
		fxParam.angle('rotation', 'Rotation', 2),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_NOISE],
				frag: /* glsl */ `
// Shake offset (px) and roll (radians) at time t (seconds), full strength.
vec3 eqShake(float t) {
  float f = max(u_frequency, 0.1) * t;
  vec3 n = vec3(fx_valueNoise(vec2(f, 1.3), u_seed), fx_valueNoise(vec2(f, 7.9), u_seed), fx_valueNoise(vec2(f, 4.2), u_seed));
  return n * vec3(u_amplitude, u_amplitude, radians(u_rotation));
}
vec4 eqAt(vec3 s, float k, float zoom) {
  vec2 asp = vec2(tr_aspect(), 1.0);
  vec2 v = ((v_uv - 0.5) * u_compSize - s.xy) / u_compSize.y / zoom;
  float co = cos(s.z), si = sin(s.z);
  vec2 uv = vec2(co * v.x + si * v.y, -si * v.x + co * v.y) / asp + 0.5;
  return mix(pm_sideMirrored(0, uv), pm_sideMirrored(1, uv), k);
}
void main() {
  float p = tr_progress();
  float e = pow(pm_bump(p), 1.5);
  float k = pm_switch(p, 0.04);
  float t = u_time;
  vec3 s0 = eqShake(t) * e;
  vec3 s1 = eqShake(t - 1.0 / max(u_fps, 1.0)) * e;
  // Slight zoom so the shaken frame mostly stays filled (mirrored beyond).
  float zoom = 1.0 + 1.5 * u_amplitude * e / u_compSize.y;
  vec4 c = vec4(0.0);
  for (int i = 0; i < 8; i++) c += eqAt(mix(s1, s0, (float(i) + 0.5) / 8.0), k, zoom);
  fragColor = c / 8.0;
}`,
			},
		],
	},
});

/** Grunge & Distort ▸ Flicker: the picture flickers between the clips (and flashes) before settling on B. */
export const FLICKER_TRANSITION = defineShaderTransition({
	id: 'jasper.flicker-transition',
	label: 'Flicker',
	bin,
	description:
		'The picture flickers erratically between the outgoing and incoming clips, with flashes, before settling on the incoming clip.',
	keywords: kw('flicker', 'strobe', 'flash', 'stutter'),
	params: [fxParam.percent('speed', 'Speed', 100), fxParam.percent('brightness', 'Flash', 50)],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_HASH],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  int stp = int(floor(u_frame * clamp(u_speed / 100.0, 0.05, 1.0)));
  float r = fx_hash1(stp, u_seed);
  // B's share grows over the transition: never at 0, always at 1.
  bool showB = r < smoothstep(0.0, 1.0, p);
  vec4 col = showB ? tr_to(v_uv) : tr_from(v_uv);
  float flash = fx_hash1(stp + 7919, u_seed) > 0.6 ? (u_brightness / 100.0) * pm_bump(p) : 0.0;
  col.rgb = min(col.rgb * (1.0 + 2.0 * flash) + flash * 0.3 * col.a, vec3(col.a));
  fragColor = col;
}`,
			},
		],
	},
});

/** Grunge & Distort ▸ Glass: the picture is seen through a wall of glass blocks while it changes. */
export const GLASS_TRANSITION = defineShaderTransition({
	id: 'jasper.glass-transition',
	label: 'Glass',
	bin,
	description:
		'The clips are seen through a wall of irregular glass cells that refract and split the colors while the picture changes.',
	keywords: kw('glass', 'refraction', 'prism', 'crystal', 'cells'),
	params: [countParam('cells', 'Cells', 10, 60), fxParam.percent('refraction', 'Refraction', 60)],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_TR_BLOCKS],
				frag: /* glsl */ `${VORONOI}
vec4 glAt(vec2 uv, float k) { return mix(pm_sideMirrored(0, uv), pm_sideMirrored(1, uv), k); }
void main() {
  float p = tr_progress();
  float e = pm_bump(p);
  float k = pm_switch(p, 0.2);
  vec2 grid = tr_squareGrid(u_cells);
  PmCell c = pmVoronoi(v_uv * grid, u_seed);
  // Each cell acts as a lens: content is pulled towards (and flipped through) its centre.
  vec2 lens = (v_uv * grid - c.centre) / grid * (u_refraction / 100.0) * 1.5 * e;
  vec4 r = glAt(v_uv - lens, k);
  vec4 g = glAt(v_uv - lens * 1.06, k);
  vec4 b = glAt(v_uv - lens * 1.12, k);
  vec4 col = vec4(r.r, g.g, b.b, g.a);
  // Bright bevels along the cell edges.
  float edge = 1.0 - smoothstep(0.0, 0.08, c.d2 - c.d1);
  fragColor = pm_addLight(col, vec3(0.35 * edge * e));
}`,
			},
		],
	},
});

/** Grunge & Distort ▸ Glitch: digital corruption — torn slices, RGB split, broken blocks — across the cut. */
export const GLITCH_TRANSITION = defineShaderTransition({
	id: 'jasper.glitch-transition',
	label: 'Glitch',
	bin,
	description:
		'Digital corruption across the cut: torn horizontal slices, RGB split and broken blocks swapping between the clips.',
	keywords: kw('glitch', 'digital', 'corrupt', 'datamosh', 'rgb split'),
	params: [
		fxParam.percent('amount', 'Amount', 100),
		fxParam.pixels('rgbSplit', 'RGB Split', 12, 100),
		fxParam.pixels('blockSize', 'Block Size', 32, 400),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_HASH],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float amt = clamp(u_amount / 100.0, 0.0, 2.0);
  // Concentrated around the cut: mild at the ends of the transition, violent in the middle.
  float e = pow(pm_bump(p), 3.0) * amt;
  int f = int(u_frame);
  vec2 px = tr_px();
  // Torn slices: random-height rows shifted sideways.
  float rowH = mix(4.0, 48.0, fx_hash1(f, u_seed));
  int row = int(floor(px.y / rowH));
  float hr = fx_hash2(ivec2(row, f), u_seed);
  float shift = hr > 1.0 - 0.45 * e ? (fx_hash2(ivec2(row, f + 911), u_seed) - 0.5) * 0.35 * e : 0.0;
  // Broken blocks show the other clip.
  float bs = max(u_blockSize, 2.0);
  ivec2 blk = ivec2(floor(px / bs));
  float hb = fx_hash3(ivec3(blk, f), u_seed);
  int side = p < 0.5 ? 0 : 1;
  if (hb < 0.3 * e) side = 1 - side;
  vec2 uv = v_uv + vec2(shift, 0.0);
  vec2 split = vec2(u_rgbSplit * e / u_compSize.x, 0.0);
  vec4 cr = pm_sideMirrored(side, uv + split);
  vec4 cg = pm_sideMirrored(side, uv);
  vec4 cb = pm_sideMirrored(side, uv - split);
  vec4 col = vec4(cr.r, cg.g, cb.b, cg.a);
  // Colour banding on some blocks.
  if (hb > 1.0 - 0.1 * e) col.rgb = floor(col.rgb * 4.0) / 4.0;
  fragColor = col;
}`,
			},
		],
	},
});

/** Grunge & Distort ▸ Grunge: grime eats through A in a dirty, ragged pattern to reveal B. */
export const GRUNGE_TRANSITION = defineShaderTransition({
	id: 'jasper.grunge-transition',
	label: 'Grunge',
	bin,
	description:
		'Grime and stains spread over the outgoing clip and eat through it in a ragged pattern to reveal the incoming clip.',
	keywords: kw('grunge', 'dirt', 'grime', 'stain', 'texture'),
	params: [
		fxParam.number('scale', 'Scale', 3, { min: 0.5, max: 20, softMax: 10, step: 0.1 }),
		fxParam.percent('dirt', 'Dirt', 60),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_PR_NOISE, GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec2 q = v_uv * vec2(tr_aspect(), 1.0) * u_scale;
  float n = clamp(0.75 * pm_fbm(q, u_seed) + 0.25 * (0.5 + 0.5 * fx_valueNoise(q * 14.0, u_seed)), 0.0, 1.0);
  float w = 0.1;
  float T = mix(-w, 1.0 + w, p);
  vec4 col;
  if (n < T) col = tr_to(v_uv);
  else {
    col = tr_from(v_uv);
    float e = clamp((n - T) / w, 0.0, 1.0);
    // A dark, desaturated rim of grime ahead of the hole.
    float grime = 1.0 - smoothstep(0.0, 1.0, e);
    col.rgb = mix(col.rgb, vec3(fx_luma(col.rgb)) * vec3(0.55, 0.45, 0.35), grime * 0.8);
    col.rgb *= 1.0 - 0.7 * grime;
  }
  // Stains over the whole picture while it changes.
  float spots = smoothstep(0.55, 0.8, pm_fbm(q * 2.7 + 11.0, fract(u_seed + 0.37)));
  col.rgb *= 1.0 - (u_dirt / 100.0) * 0.6 * spots * pm_bump(p);
  fragColor = col;
}`,
			},
		],
	},
});

/** Grunge & Distort ▸ Kaleidoscope: the picture folds into a turning kaleidoscope through the cut. */
export const KALEIDOSCOPE_TRANSITION = defineShaderTransition({
	id: 'jasper.kaleidoscope-transition',
	label: 'Kaleidoscope',
	bin,
	description:
		'The picture folds into a turning kaleidoscope of mirrored segments, changes to the incoming clip and unfolds.',
	keywords: kw('kaleidoscope', 'mirror', 'symmetry', 'segments', 'mandala'),
	params: [countParam('segments', 'Segments', 6, 32), fxParam.angle('rotation', 'Rotation', 90)],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float e = pm_bump(p);
  float k = pm_switch(p, 0.1);
  vec2 asp = vec2(tr_aspect(), 1.0);
  vec2 v = (v_uv - 0.5) * asp;
  float r = length(v) * (1.0 - 0.3 * e);
  float seg = 2.0 * PM_PI / max(1.0, floor(u_segments + 0.5));
  float a = atan(v.y, v.x) + radians(u_rotation) * tr_easeInOut(p);
  float m = mod(a, seg);
  m = min(m, seg - m);
  vec2 uvK = r * vec2(cos(m), sin(m)) / asp + 0.5;
  vec4 plain = mix(tr_from(v_uv), tr_to(v_uv), k);
  vec4 kal = mix(pm_sideMirrored(0, uvK), pm_sideMirrored(1, uvK), k);
  fragColor = mix(plain, kal, smoothstep(0.0, 1.0, e));
}`,
			},
		],
	},
});

/** Grunge & Distort ▸ Liquid Distortion: the picture melts into flowing liquid and resolves as B. */
export const LIQUID_DISTORTION = defineShaderTransition({
	id: 'jasper.liquid-distortion',
	label: 'Liquid Distortion',
	bin,
	description: 'The picture melts and flows like liquid, morphs into the incoming clip and settles.',
	keywords: kw('liquid', 'melt', 'flow', 'warp', 'fluid'),
	params: [
		fxParam.pixels('amount', 'Amount', 80, 500),
		fxParam.number('scale', 'Scale', 3, { min: 0.2, max: 20, softMax: 10, step: 0.1 }),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_PR_NOISE],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float e = pm_bump(p);
  vec2 q = v_uv * vec2(tr_aspect(), 1.0) * u_scale;
  float t = u_time * 0.6;
  vec2 w = vec2(pm_fbm(q + vec2(0.0, t), u_seed), pm_fbm(q + vec2(5.2, 1.3 - t), fract(u_seed + 0.5))) - 0.5;
  vec2 uv = v_uv + w * 2.0 * u_amount * e / u_compSize;
  fragColor = mix(pm_sideMirrored(0, uv), pm_sideMirrored(1, uv), pm_switch(p, 0.2));
}`,
			},
		],
	},
});

/** Grunge & Distort ▸ TV Power: A switches off like an old CRT (line, dot), B switches on. */
export const TV_POWER = defineShaderTransition({
	id: 'jasper.tv-power',
	label: 'TV Power',
	bin,
	description:
		'The outgoing clip switches off like an old CRT television — collapsing to a glowing line and a dot — and the incoming clip switches on.',
	keywords: kw('tv', 'crt', 'power', 'switch off', 'retro', 'television'),
	params: [fxParam.color('glowColor', 'Glow Color', [0.85, 0.95, 1, 1])],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  bool isB = p >= 0.5;
  float t = isB ? 2.0 * (1.0 - p) : 2.0 * p;   // 0 = full picture, 1 = off
  float sy = t < 0.6 ? mix(1.0, 0.004, tr_easeIn(t / 0.6)) : 0.004;
  float sx = t < 0.6 ? 1.0 : mix(1.0, 0.0, tr_easeIn((t - 0.6) / 0.4));
  float bright = 1.0 + 1.5 * smoothstep(0.3, 0.6, t);
  vec2 s = max(vec2(sx, sy), vec2(1e-4));
  vec2 uv = (v_uv - 0.5) / s + 0.5;
  vec4 pic = vec4(0.0);
  if (sx > 1e-3 && all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)))) {
    pic = isB ? tr_to(uv) : tr_from(uv);
    pic.rgb = min(pic.rgb * bright, vec3(pic.a));
  }
  // Glow around the collapsing picture (line, then dot): a halo outside it, and the picture itself washes out only
  // once it is nearly a line.
  vec2 d = max(abs(v_uv - 0.5) * u_compSize - 0.5 * s * u_compSize, 0.0);
  float halo = length(d) > 0.0 ? exp(-length(d) / (4.0 + 20.0 * t)) : smoothstep(0.45, 0.6, t);
  float glow = halo * smoothstep(0.2, 0.5, t) * (sx > 1e-3 ? 1.0 : 0.0);
  vec4 col = pm_addLight(pic, u_glowColor.rgb * glow);
  // The screen goes black behind (faded in and out at the ends so the first / last frames are A / B).
  float bg = smoothstep(0.0, 0.08, p) * (1.0 - smoothstep(0.92, 1.0, p));
  fragColor = tr_over(col, vec4(0.0, 0.0, 0.0, bg));
}`,
			},
		],
	},
});

/** Grunge & Distort ▸ VHS Damage: tracking errors, jitter, chroma bleed and noise across the cut. */
export const VHS_DAMAGE = defineShaderTransition({
	id: 'jasper.vhs-damage',
	label: 'VHS Damage',
	bin,
	description:
		'A damaged VHS tape across the cut: line jitter, a rolling tracking band, chroma bleed, static and scanlines.',
	keywords: kw('vhs', 'tape', 'tracking', 'analog', 'retro', 'noise'),
	params: [fxParam.percent('amount', 'Amount', 100), fxParam.percent('noise', 'Noise', 50)],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_HASH, GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float e = pm_bump(p) * clamp(u_amount / 100.0, 0.0, 2.0);
  int f = int(u_frame);
  vec2 px = tr_px();
  int line = int(floor(px.y / 2.0));
  float jitter = (fx_hash2(ivec2(line, f), u_seed) - 0.5) * 0.012 * e;
  // A tracking band rolling up the frame.
  float y0 = fract(u_seed * 7.0 - u_time * 0.8);
  float band = 1.0 - smoothstep(0.0, 0.07, abs(v_uv.y - y0));
  float wave = sin(v_uv.y * 38.0 + u_time * 9.0) * 0.004 * e;
  float shift = jitter + wave + band * 0.05 * e * (fx_hash2(ivec2(line / 4, f), u_seed) - 0.3);
  // The switch happens line by line around the middle.
  float ts = 0.5 + (fx_hash2(ivec2(line / 6, f + 77), u_seed) - 0.5) * 0.25 * min(e, 1.0);
  int side = p < ts ? 0 : 1;
  vec2 uv = vec2(v_uv.x + shift, v_uv.y);
  float bleed = 0.007 * e;
  vec4 c = pm_sideMirrored(side, uv);
  vec3 rgb = vec3(pm_sideMirrored(side, uv + vec2(bleed, 0.0)).r, c.g, pm_sideMirrored(side, uv - vec2(bleed, 0.0)).b);
  rgb = mix(rgb, vec3(fx_luma(rgb)), 0.25 * min(e, 1.0));
  float n = fx_random(px, u_frame, u_seed);
  float noiseAmt = (u_noise / 100.0) * min(e, 1.0) * (0.25 + 0.75 * band);
  rgb = mix(rgb, vec3(n) * c.a, noiseAmt);
  rgb *= 1.0 - 0.18 * min(e, 1.0) * step(1.0, mod(px.y, 2.0));
  fragColor = vec4(rgb, c.a);
}`,
			},
		],
	},
});

export const MODERN_GRUNGE: readonly TransitionSpec[] = [
	CHAOS,
	EARTHQUAKE,
	FLICKER_TRANSITION,
	GLASS_TRANSITION,
	GLITCH_TRANSITION,
	GRUNGE_TRANSITION,
	KALEIDOSCOPE_TRANSITION,
	LIQUID_DISTORTION,
	TV_POWER,
	VHS_DAMAGE,
];
