// Particles (TL-061, TL-062): 7 emitters, 11 shapes, after Pachislop's generators/particles.ts, which places one still
// frame. Here every particle is a closed form of time and seed, evaluated per instance in the vertex shader: nothing is
// stepped, so frame N is the same from any direction:
//   age       wrapped: fract(time / life + phase); the cycle number re-seeds the birth, an envelope hides the wrap;
//   position  ballistic: birth + travel along a drag curve + gravity · age² / 2 + sway, each exact at any age;
//   tumble    phase + rate · age.
// The Layer emitter does not sample a list of the shape's pixels (Pachislop's rejection sampling re-rolls every particle
// when one cell flips). Each particle has a seeded site in the anchor box and emits from the nearest part of the shape,
// read from the shared field (`GLSL_TLG_SITES`): see the note there and "Stable identity" in the wp-note. `jasper.particle-world`,
// `jasper.particle-systems` and `jasper.particle-playground` are stepped simulations with their own physics: this one is
// the closed-form, shape-aware field a look can carry.
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, type LayerParams, lp } from '../contract.ts';
import { GLSL_TLG_QUAD } from './light-streaks.ts';
import { anchorParam, clamp, GLSL_TLG, GLSL_TLG_SITES, hex, num, variationParam } from './shared.ts';

export const MAX_PARTICLES = 5000;

const SHAPES = [
	'dot',
	'glint4',
	'glint6',
	'ember',
	'square',
	'confetti',
	'petal',
	'star',
	'heart',
	'bokeh',
	'rain',
];
const SHAPE_LABELS = [
	'Soft Dot',
	'4-Point Glint',
	'6-Point Glint',
	'Ember',
	'Square',
	'Confetti Strip',
	'Petal',
	'Star',
	'Heart',
	'Bokeh Disc',
	'Rain Streak',
];
/** Opaque shapes: drawn over, far to near. Every other shape is light. */
const SOLID = ['confetti', 'petal', 'heart'];
const EMITTERS = ['point', 'ellipse', 'rect', 'ring', 'line', 'full', 'layer'];
const EMITTER_LABELS = ['Point', 'Ellipse', 'Rectangle', 'Ring', 'Line', 'Full Frame', 'Title'];

const CONFETTI_ASPECT = 2.4;
const PETAL_ASPECT = 1.25;
const GLINT_MIX_SCALE = 3.5;

const solid = (p: LayerParams) => SOLID.includes(String(p.shape));

/** How far one particle draws from its centre, percent of the unit. */
function particleReach(p: LayerParams): number {
	const d = num(p.depth) / 100;
	const shapeK = Math.max(
		p.shape === 'confetti' ? CONFETTI_ASPECT : p.shape === 'petal' ? PETAL_ASPECT : 1,
		num(p.glintMix) > 0 ? GLINT_MIX_SCALE : 1,
	);
	const r = (num(p.size) / 2) * (1 + 1.7 * d) * shapeK;
	const defocus = 1 + 2.4 * d * (p.shape === 'bokeh' ? 0.3 : 1);
	const halo = solid(p) ? 1 : 1 + 2 * (num(p.glow) / 100);
	return r * defocus * halo + (p.shape === 'ember' || p.shape === 'rain' ? num(p.streak) * halo : 0);
}

/** How far particles may fly in a look before they fade: physics can reach any distance, a canvas cannot. */
function reachOf(p: LayerParams): number {
	return Math.min(physicsReach(p), Math.max(1, num(p.extent)));
}

function physicsReach(p: LayerParams): number {
	const life = Math.max(0.05, num(p.lifetime));
	const fall = 0.5 * Math.abs(num(p.gravity)) * life * life;
	const free = Math.max(0, num(p.travel)) * 1.45 + fall + Math.abs(num(p.sway)) + particleReach(p) + 2;
	if (p.emitter === 'full') return particleReach(p) + 2;
	if (p.emitter === 'layer') return free + num(p.capture);
	if (p.emitter === 'point') return free;
	return Math.max(num(p.rx), num(p.ry)) * 1.25 + free;
}

const VERT = /* glsl */ `
flat out vec4 v_c;  // premultiplied linear colour
flat out vec4 v_e;  // defocus, aspect, tumble phase, 1 = a mixed-in glint
flat out float v_halo;
out vec2 v_q;       // -1..1 across the quad
const float TLG_TAU = 6.28318531;
const float TLG_FOCUS = 0.6;
int tlg_i, tlg_cyc;
float tlg_r(int k) { return tlg_h3(tlg_i, tlg_cyc, k); }
vec2 tlg_unit(vec2 v, vec2 f) { float l = length(v); return l > 1.0e-6 ? v / l : f; }
float tlg_axis(float u, float falloff) {
  float v = 2.0 * u - 1.0;
  return sign(v) * pow(abs(v), 1.0 + 2.0 * falloff);
}
vec3 tlg_paletteAt(float x) {
  return x < 1.0 / 3.0 ? tlg_rgb(u_color) : x < 2.0 / 3.0 ? tlg_rgb(u_color2) : tlg_rgb(u_color3);
}
void main() {
  tlg_begin();
  tlg_i = gl_InstanceID;
  float time = u_tlTime;
  float life = max(u_lifetime * (1.0 - u_lifeRandom * 0.01 * tlg_h(tlg_i, 20)), 0.05);
  float age;
  float env;
  if (u_timing == 1) {
    // Once: every particle leaves at its stagger and is gone at the end of its life.
    tlg_cyc = 0;
    age = (time - tlg_h(tlg_i, 21) * u_stagger) / life;
    if (age < 0.0 || age >= 1.0) { fx_cull(); return; }
    env = 1.0 - smoothstep(0.6, 1.0, age);
  } else {
    // Wrapped age: the cycle number re-seeds the birth, the envelope hides the wrap.
    float x = time / life + tlg_h(tlg_i, 21);
    float c = floor(x);
    tlg_cyc = int(c);
    age = x - c;
    env = smoothstep(0.0, 0.1, age) * (1.0 - smoothstep(0.72, 1.0, age));
  }
  float seconds = age * life;
  // The drag curve: travel done at age, exact for any age (exponential slow-down, normalised to 1 at the end of life).
  float k = u_drag * 0.04;
  float done = k > 1.0e-3 ? (1.0 - exp(-k * age)) / (1.0 - exp(-k)) : age;
  float cone = radians(u_cone);
  float travel = max(tl_px(u_travel), 0.0);
  float falloff = u_falloff * 0.01;
  vec2 centre = fx_canvasPxOfLayerNorm(u_center);
  float rx = max(tl_px(u_rx), 0.0), ry = max(tl_px(u_ry), 0.0);
  vec2 pos, dir;
  float bt = 0.0;
  float speed = -1.0;
  float fade = 1.0;
  vec3 sampled = vec3(-1.0);
  float a0 = tlg_r(0) * TLG_TAU;
  vec2 cu = vec2(cos(a0), sin(a0));
  float jitter = (tlg_r(1) - 0.5) * cone;
#if TLG_EMITTER == 6
  // The title: a seeded site, the nearest part of the shape; nothing here depends on the rest of the shape.
  vec2 q = tlg_anchor(vec2(tlg_r(2), tlg_r(3)));
  TlgSite site = tlg_site(q, u_emitFrom == 1, tlg_r(4) * tl_px(u_edgeWidth), max(tl_px(u_capture), 1.0));
  if (site.gate <= 0.0) { fx_cull(); return; }
  vec2 d0 = site.normal;
  if (u_direction == 1) d0 = tlg_unit(site.px - fx_canvasPxOfLayerNorm(u_originPoint), d0);
  if (u_direction == 2) d0 = fx_dir(u_heading);
  float a1 = atan(d0.y, d0.x) + jitter;
  dir = vec2(cos(a1), sin(a1));
  float tf = 1.0 - u_distanceRandom * 0.01 * sqrt(tlg_r(5));
  pos = site.px + dir * travel * tf * done;
  bt = u_distanceRandom > 0.0 ? (tf - 1.0 + u_distanceRandom * 0.01) / (u_distanceRandom * 0.01) : 1.0;
  speed = tf;
  fade = (1.0 - 0.5 * tf * tf * age) * site.gate;
  sampled = tl_sourceLinear(clamp(site.px / u_canvasSize, vec2(0.0), vec2(1.0))).rgb;
#else
  vec2 s0;
  vec2 d0;
  float st;
  float R;
#if TLG_EMITTER == 5
  vec2 half0 = u_canvasSize * 0.5;
  float fx0 = tlg_axis(tlg_r(2), falloff), fy0 = tlg_axis(tlg_r(3), falloff);
  s0 = half0 + vec2(fx0, fy0) * half0;
  d0 = tlg_unit(vec2(fx0, fy0), cu);
  st = max(abs(fx0), abs(fy0));
  R = length(half0);
#elif TLG_EMITTER == 0
  s0 = centre;
  d0 = cu;
  st = 0.0;
  R = 0.0;
#elif TLG_EMITTER == 1
  float rho = pow(tlg_r(2), 0.5 + 1.5 * falloff);
  s0 = centre + vec2(rx, ry) * rho * cu;
  d0 = tlg_unit(vec2(rx, ry) * cu, cu);
  st = rho;
  R = max(rx, ry);
#elif TLG_EMITTER == 2
  float fx0 = tlg_axis(tlg_r(2), falloff), fy0 = tlg_axis(tlg_r(3), falloff);
  s0 = centre + vec2(rx, ry) * vec2(fx0, fy0);
  d0 = tlg_unit(vec2(rx * fx0, ry * fy0), cu);
  st = max(abs(fx0), abs(fy0));
  R = max(rx, ry);
#elif TLG_EMITTER == 3
  float rho = 1.0 + (tlg_r(2) + tlg_r(3) - 1.0) * 0.25 * (1.0 - 0.85 * falloff);
  s0 = centre + vec2(rx, ry) * rho * cu;
  d0 = tlg_unit(vec2(ry, rx) * cu, cu);
  st = min(1.0, rho);
  R = max(rx, ry);
#else
  float fx0 = tlg_axis(tlg_r(2), falloff);
  s0 = centre + vec2(rx * fx0, 0.0);
  d0 = vec2(0.0, cu.y < 0.0 ? -1.0 : 1.0);
  st = abs(fx0);
  R = rx;
#endif
  if (u_distribution == 1) {
    // Burst: out along the emitter's own direction.
    float tf = pow(tlg_r(5), 0.6 + 1.6 * falloff);
    float a1 = atan(d0.y, d0.x) + jitter;
    dir = vec2(cos(a1), sin(a1));
    float go = travel * tf * done;
    pos = s0 + dir * go;
    bt = (st * R + travel * tf) / max(1.0, R + travel);
    speed = tf;
    fade = 1.0 - 0.5 * tf * tf * age;
  } else {
    dir = fx_dir(u_angle + degrees(jitter));
    if (u_distribution == 2) {
      // Stream: one way, each at its own pace.
      pos = s0 + dir * travel * (0.6 + 0.8 * tlg_r(5)) * done;
      bt = age;
      fade = 1.0 - 0.6 * age * age;
    } else {
      // Scatter: where it was born, drifting along the angle through its life and wandering a little.
#if TLG_EMITTER == 0
      s0 = centre + d0 * travel * pow(tlg_r(5), 0.5 + 1.5 * falloff);
#endif
      pos = s0 + dir * travel * (age - 0.5);
      bt = st;
    }
  }
#endif
  // Ballistic: gravity and sway, in the plane, closed forms of the age.
  float g = tl_px(u_gravity);
  pos.y += 0.5 * g * seconds * seconds;
  vec2 side = vec2(-dir.y, dir.x);
  pos += side * tl_px(u_sway) * sin(TLG_TAU * (u_swayRate * seconds + tlg_h(tlg_i, 22)));
#if TLG_SPLIT
  if ((u_split == 1) != (tlg_h(tlg_i, 23) < 0.5)) { fx_cull(); return; }
#endif
  // What stays with the particle through its cycles: its look.
  float z0 = tlg_h(tlg_i, 1);
#if TLG_SOLID
  // Painter's order is instance order: near ones have the higher index.
  z0 = (float(tlg_i) + 0.5) / max(u_count, 1.0);
#endif
  float su = tlg_h(tlg_i, 2), ru = tlg_h(tlg_i, 3), ou = tlg_h(tlg_i, 5), pu = tlg_h(tlg_i, 6), gu = tlg_h(tlg_i, 7);
  float phi = tlg_h(tlg_i, 4) * TLG_TAU + TLG_TAU * u_tumbleRate * (0.5 + tlg_h(tlg_i, 8)) * seconds;
  float d = u_depth * 0.01;
  float z = clamp(mix(pow(z0, 1.7), bt, 0.5 * d), 0.0, 1.0);
  float near = 1.0 + d * (2.4 * z - 0.7);
  float bright = 1.0 + d * (0.8 * z - 0.35);
  bool glint = false;
#if TLG_GLINTMIX
  glint = gu < u_glintMix * 0.01;
#endif
  bool isGlint = glint || TLG_SHAPE == 1 || TLG_SHAPE == 2;
  float blur = d * (z < TLG_FOCUS ? 0.8 * (TLG_FOCUS - z) / TLG_FOCUS : 2.4 * (z - TLG_FOCUS) / (1.0 - TLG_FOCUS));
  if (isGlint) blur = min(blur, 0.5);
  else if (TLG_SHAPE == 9) blur *= 0.3;
  float r = tl_px(u_size) * 0.5 * (1.0 - u_sizeRandom * 0.01 * su) * near * (glint ? ${GLINT_MIX_SCALE.toFixed(1)} : 1.0);
  if (!(r > 0.0)) { fx_cull(); return; }
  float sp = speed >= 0.0 ? speed : z;
  float aspect = 1.0;
  float spinAngle = radians(u_rotation) * (2.0 * ru - 1.0) + TLG_TAU * u_spinRate * (ru - 0.5) * seconds;
#if TLG_SHAPE == 3 || TLG_SHAPE == 10
  float len = tl_px(u_streak) * (TLG_SHAPE == 3 ? 0.35 + 0.65 * sp : 0.5 + 0.5 * sp);
  aspect = 1.0 + len / (2.0 * r);
  // Along the velocity at this age.
  vec2 vel = dir * travel / max(life, 0.01) + vec2(0.0, g * seconds);
  spinAngle = atan(vel.y, vel.x);
#elif TLG_SHAPE == 5
  aspect = ${CONFETTI_ASPECT.toFixed(1)};
#elif TLG_SHAPE == 6
  aspect = ${PETAL_ASPECT.toFixed(2)};
#endif
  bool tumbles = u_tumble > 0.0 && (TLG_SHAPE == 4 || TLG_SHAPE == 5 || TLG_SHAPE == 6 || TLG_SHAPE == 7 || TLG_SHAPE == 8);
  float fs = tumbles ? mix(1.0, max(0.12, abs(cos(phi))), u_tumble * 0.01) : 1.0;
  vec3 col = tlg_rgb(u_color);
  if (u_colorMode == 1) col = tlg_ramp3(clamp(bt, 0.0, 1.0), tlg_rgb(u_color), tlg_rgb(u_color2), tlg_rgb(u_color3));
  else if (u_colorMode == 2) col = tlg_paletteAt(pu);
  else if (u_colorMode == 3 && sampled.r >= 0.0) col = sampled;
  float shade = 1.0;
  if (tumbles && cos(phi) < 0.0) shade = TLG_SHAPE == 5 ? 0.45 : 0.85;
  if (TLG_SHAPE == 5) shade *= 0.65 + 0.35 * abs(cos(phi));
  float alpha = (u_particleOpacity * 0.01) * (1.0 - u_opacityRandom * 0.01 * ou) * fade * env;
  if (!(alpha > 0.0)) { fx_cull(); return; }
  float kk = alpha * shade * (TLG_SOLID == 1 ? 1.0 : bright * u_brightness * 0.01);
  // The glow is the particle's own: Pachislop leaves it to an effect on the layer, a look has none to give it.
  float halo = TLG_SOLID == 1 ? 1.0 : 1.0 + 2.0 * u_glow * 0.01;
  // Sub-pixel particles keep their energy and do not shimmer: at least 1.5 px, colour scaled by the area.
  float w = 2.0 * r * (aspect + blur) * halo, h = 2.0 * r * (1.0 + blur) * fs * halo;
  float gw = max(w, 1.5), gh = max(h, 1.5);
  float area = (w * h) / (gw * gh);
  v_c = vec4(col * kk, alpha) * area;
  v_e = vec4(blur, aspect, phi, glint ? 1.0 : 0.0);
  v_halo = halo;
  vec2 corner = tlg_corner(gl_VertexID);
  v_q = corner;
  vec2 l = corner * vec2(gw, gh) * 0.5;
  float c1 = cos(spinAngle), s1 = sin(spinAngle);
  fx_emit(pos + vec2(c1 * l.x - s1 * l.y, s1 * l.x + c1 * l.y));
}`;

const FRAG = /* glsl */ `
flat in vec4 v_c;
flat in vec4 v_e;
flat in float v_halo;
in vec2 v_q;
float tlg_max3(vec3 c) { return max(c.r, max(c.g, c.b)); }
float tlg_cover(float d, float e) { return 1.0 - smoothstep(-e, e, d); }
float tlg_ray(vec2 v, float ang, float thin) {
  vec2 d = vec2(cos(ang), sin(ang));
  float al = abs(dot(v, d));
  if (al >= 1.0) return 0.0;
  float pe = abs(dot(v, vec2(-d.y, d.x)));
  float w = thin * (1.0 - al) + 0.003;
  return (exp(-pe / w) + 0.35 * exp(-pe / (w * 4.0))) * pow(1.0 - al, 1.2);
}
// Signed distances after Inigo Quilez: a 5-point star pointing up, a heart with its tip at the origin.
float tlg_star5(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
float tlg_dot2(vec2 v) { return dot(v, v); }
float tlg_heart(vec2 p) {
  p.x = abs(p.x);
  if (p.y + p.x > 1.0) return sqrt(tlg_dot2(p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
  return sqrt(min(tlg_dot2(p - vec2(0.0, 1.0)), tlg_dot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}
void tlg_glint(vec2 l, float s, float b, int kind, out float I, out float hot) {
  vec2 v = l / s;
  float rv = length(v);
  float thin = 0.035 * (1.0 + 3.0 * b);
  float rays, haloK;
  if (kind == 1) {
    rays = tlg_ray(v, 0.0, thin) + tlg_ray(v, 1.5708, thin);
    haloK = 0.6;
  } else {
    rays = tlg_ray(v, 1.5708, 0.7 * thin) + tlg_ray(v, 0.5236, 0.7 * thin) + tlg_ray(v, 2.618, 0.7 * thin);
    haloK = 0.35;
  }
  float halo = exp(-rv * 6.0) * haloK * (1.0 - smoothstep(0.7, 1.0, rv));
  I = (rays + halo) / s;
  hot = (2.0 * exp(-rv * rv * 50.0) + 0.6 * rays * exp(-rv * 2.5)) / s;
}
void main() {
  float b = v_e.x, A = v_e.y, phase = v_e.z;
  // Local position in particle radii: x along the length, y across, plus the defocus pad.
  vec2 l = v_q * vec2(A + b, 1.0 + b) * v_halo;
  vec2 fw = fwidth(l);
  float e = max(0.7 * (fw.x + fw.y), 0.5 * b);
  float r = length(l);
  float s = 1.0 + b;
  float I = 0.0, hot = 0.0;
  vec3 tint = vec3(1.0);
#if TLG_GLINTMIX
  if (v_e.w > 0.5) {
    tlg_glint(l, s, b, 1, I, hot);
    vec3 cg = v_c.rgb * I + v_c.a * hot;
    fragColor = vec4(cg, min(1.0, tlg_max3(cg)));
    return;
  }
#endif
#if TLG_SHAPE == 0
  I = exp(-2.6 * r * r / (s * s)) / s;
  hot = 0.5 * exp(-18.0 * r * r) / (1.0 + 4.0 * b);
#elif TLG_SHAPE == 1 || TLG_SHAPE == 2
  tlg_glint(l, s, b, TLG_SHAPE, I, hot);
#elif TLG_SHAPE == 3
  // A dot dragged along its motion: dim tail, hot head.
  float hl = A - 1.0;
  vec2 q = vec2(l.x - clamp(l.x, -hl, hl), l.y);
  float h = clamp((l.x + A) / (2.0 * A), 0.0, 1.0);
  I = exp(-3.0 * dot(q, q) / (s * s)) * mix(0.15, 1.0, h * h) / s;
  vec2 hp = vec2(l.x - hl, l.y);
  hot = 0.7 * exp(-10.0 * dot(hp, hp) / (s * s)) / s;
#elif TLG_SHAPE == 10
  float h = clamp((l.x + A) / (2.0 * A), 0.0, 1.0);
  I = exp(-3.0 * l.y * l.y / (s * s)) * smoothstep(0.0, 0.3, h) * (1.0 - smoothstep(0.92, 1.0, h)) * mix(0.35, 1.0, h) / s;
#elif TLG_SHAPE == 9
  float cov = tlg_cover(r - 0.94, max(e, 0.06 + 0.5 * b));
  I = cov * (mix(0.8, 0.4, u_ring * 0.01) * (1.0 - 0.2 * r * r) + 1.1 * (u_ring * 0.01) * smoothstep(0.6, 0.95, r));
#elif TLG_SHAPE == 7
  I = tlg_cover(tlg_star5(l * vec2(1.0, -1.0), 1.0, 0.45), e) * (0.75 + 0.6 * exp(-6.0 * r * r));
  hot = 0.35 * exp(-20.0 * r * r);
#elif TLG_SHAPE == 4
  I = tlg_cover(max(abs(l.x), abs(l.y)) - 1.0, e);
#elif TLG_SHAPE == 5
  I = tlg_cover(max(abs(l.x) - A, abs(l.y) - 1.0), e);
  // Foil sheen: a diagonal glare band that slides along the strip as it turns.
  float band = (l.x / A) * 0.8 + l.y * 0.35 - 1.6 * sin(phase);
  tint += (u_sheen * 0.01) * 1.6 * exp(-band * band / 0.05);
#elif TLG_SHAPE == 6
  // Base at -x, notched tip at +x, widest near the tip.
  float u = (l.x / A + 1.0) * 0.5;
  float uc = clamp(u, 0.0, 1.0);
  float w = 0.95 * pow(uc, 0.6) * sqrt(max(0.0, 1.0 - pow(uc, 6.0)));
  float d = max(abs(l.y) - w, abs(l.x) - A);
  d = max(d, (u - 0.86) * 2.4 * A - abs(l.y));
  I = tlg_cover(d, e);
  tint *= mix(1.12, 0.94, uc);
#else
  vec2 p = vec2(l.x, -l.y) * 0.55 + vec2(0.0, 0.5);
  I = tlg_cover(tlg_heart(p) / 0.55, e);
  vec2 hl = l - vec2(-0.35, -0.35);
  tint *= 1.0 + 0.25 * exp(-8.0 * dot(hl, hl));
#endif
#if TLG_SOLID
  fragColor = vec4(v_c.rgb * tint, v_c.a) * (I / (1.0 + 0.6 * b));
#else
  vec2 ax = vec2(max(abs(l.x) - (A - 1.0), 0.0), l.y);
  I += (v_halo - 1.0) * 0.16 * pow(max(1.0 - length(ax) / (s * v_halo), 0.0), 2.0) / s;
  vec3 c = v_c.rgb * I + v_c.a * hot;
  fragColor = vec4(c, min(1.0, tlg_max3(c)));
#endif
}`;

export const GENERATOR_PARTICLES = defineGenerator({
	id: 'particles',
	label: 'Particles',
	description:
		'A particle field from the title, a point, an ellipse, a rectangle, a ring, a line or the whole frame: dust, embers, confetti, petals, bokeh, rain, fireworks.',
	keywords: [
		'sparks',
		'embers',
		'confetti',
		'dust',
		'glitter',
		'petals',
		'bokeh',
		'rain',
		'snow',
		'fireworks',
	],
	params: [
		lp.choice('emitter', 'Emitter', EMITTERS, EMITTER_LABELS, 'layer'),
		lp.choice('emitFrom', 'Emit From', ['fill', 'edge'], ['Fill', 'Edge'], 'edge'),
		lp.distance('edgeWidth', 'Edge Width', 2, { softMax: 50 }),
		lp.distance('capture', 'Capture', 14, { min: 0.5, softMax: 60 }),
		anchorParam(),
		lp.choice(
			'direction',
			'Direction',
			['normal', 'point', 'angle'],
			['Normal Out', 'From Point', 'Angle'],
			'normal',
		),
		lp.point('originPoint', 'From Point', [0.5, 0.5]),
		lp.angle('heading', 'Heading', -90),
		lp.point('center', 'Emitter Centre', [0.5, 0.5]),
		lp.distance('rx', 'Radius X', 120, { softMax: 800 }),
		lp.distance('ry', 'Radius Y', 80, { softMax: 800 }),
		lp.choice(
			'distribution',
			'Distribution',
			['scatter', 'burst', 'stream'],
			['Scatter', 'Burst Out', 'Stream'],
			'burst',
		),
		lp.percent('falloff', 'Density Falloff', 60),
		lp.distance('travel', 'Distance', 90, { softMax: 400 }),
		lp.percent('distanceRandom', 'Distance Random', 100),
		lp.angle('angle', 'Stream Angle', -90),
		lp.number('cone', 'Spread Angle', 20, { min: 0, max: 360, step: 0.1 }, { unit: 'deg' }),
		lp.choice('split', 'Particles', ['all', 'front', 'back'], ['All', 'Front Half', 'Back Half'], 'all'),
		lp.choice('timing', 'Timing', ['loop', 'once'], ['Loop', 'Once'], 'loop'),
		lp.number('lifetime', 'Life', 2.2, { min: 0.05, max: 60, softMax: 6, step: 0.01 }, { unit: 's' }),
		lp.percent('lifeRandom', 'Life Random', 40),
		lp.number('stagger', 'Stagger', 0.2, { min: 0, max: 20, softMax: 3, step: 0.01 }, { unit: 's' }),
		lp.percent('drag', 'Drag', 40),
		lp.number(
			'gravity',
			'Gravity',
			0,
			{ min: -2000, max: 2000, softMin: -200, softMax: 200, step: 0.1 },
			{ unit: '%' },
		),
		lp.distance('sway', 'Sway', 0, { min: -300, softMin: 0, softMax: 60 }),
		lp.number('swayRate', 'Sway Rate', 0.6, { min: 0, max: 20, softMax: 4, step: 0.01 }, { unit: 'Hz' }),
		lp.choice('shape', 'Shape', SHAPES, SHAPE_LABELS, 'dot'),
		lp.percent('glintMix', 'Glint Mix', 0),
		lp.number('count', 'Count', 900, { min: 1, max: MAX_PARTICLES, softMax: 2000, step: 1 }),
		lp.distance('size', 'Size', 3, { min: 0.1, softMax: 100 }),
		lp.percent('sizeRandom', 'Size Random', 60),
		lp.percent('depth', 'Depth', 50),
		lp.distance('streak', 'Streak Length', 20, { softMax: 200 }),
		lp.percent('ring', 'Bokeh Ring', 30),
		lp.number('rotation', 'Rotation Random', 20, { min: 0, max: 180, step: 0.1 }, { unit: 'deg' }),
		lp.number(
			'spinRate',
			'Spin',
			0,
			{ min: -20, max: 20, softMin: 0, softMax: 3, step: 0.01 },
			{ unit: 'Hz' },
		),
		lp.percent('tumble', 'Tumble', 0),
		lp.number('tumbleRate', 'Tumble Rate', 0.8, { min: 0, max: 20, softMax: 4, step: 0.01 }, { unit: 'Hz' }),
		lp.percent('sheen', 'Foil Sheen', 50),
		lp.choice(
			'colorMode',
			'Colour',
			['solid', 'radial', 'palette', 'sample'],
			['Solid', 'By Radius', 'Palette', 'Sample Title'],
			'radial',
		),
		lp.color('color', 'Colour', hex('#fff2c2')),
		lp.color('color2', 'Colour 2', hex('#ffc845')),
		lp.color('color3', 'Colour 3', hex('#c77a12')),
		lp.percent('particleOpacity', 'Particle Opacity', 100),
		lp.number('brightness', 'Brightness', 220, { min: 0, max: 800, softMax: 400, step: 1 }, { unit: '%' }),
		lp.percent('glow', 'Glow', 35),
		lp.percent('opacityRandom', 'Opacity Random', 40),
		lp.distance('extent', 'Extent', 150, { min: 5, softMax: 400 }),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG],
	shapeAware: true,
	standIn: 'disc',
	usesBounds: () => true,
	color: { role: 'glow', mode: 'light' },
	defines: (p) => {
		const light = !solid(p);
		return [
			`#define TLG_EMITTER ${Math.max(0, EMITTERS.indexOf(String(p.emitter)))}`,
			`#define TLG_SHAPE ${Math.max(0, SHAPES.indexOf(String(p.shape)))}`,
			`#define TLG_SOLID ${light ? 0 : 1}`,
			`#define TLG_GLINTMIX ${num(p.glintMix) > 0 && (p.shape === 'dot' || p.shape === 'square') ? 1 : 0}`,
			`#define TLG_SPLIT ${p.split === 'all' ? 0 : 1}`,
			'',
		].join('\n');
	},
	presets: [
		{
			id: 'sparks',
			label: 'Edge Sparks',
			params: {
				count: 1400,
				size: 2.5,
				shape: 'ember',
				streak: 14,
				travel: 80,
				gravity: -30,
				brightness: 320,
			},
		},
		{
			id: 'goldDust',
			label: 'Gold Dust',
			params: {
				emitter: 'ellipse',
				rx: 225,
				ry: 150,
				travel: 130,
				cone: 20,
				glintMix: 4,
				count: 2600,
				size: 3,
				sizeRandom: 70,
				depth: 55,
				opacityRandom: 55,
			},
		},
		{
			id: 'embers',
			label: 'Embers',
			params: {
				emitter: 'rect',
				rx: 240,
				ry: 90,
				distribution: 'stream',
				falloff: 45,
				travel: 260,
				angle: -80,
				cone: 36,
				shape: 'ember',
				count: 600,
				size: 2.5,
				sizeRandom: 55,
				streak: 25,
				depth: 65,
				sway: 10,
				color: hex('#ffc45a'),
				color2: hex('#ff8a24'),
				color3: hex('#a81c06'),
				opacityRandom: 45,
			},
		},
		{
			id: 'confetti',
			label: 'Confetti',
			params: {
				emitter: 'full',
				distribution: 'scatter',
				falloff: 0,
				angle: 80,
				cone: 30,
				travel: 300,
				lifetime: 3,
				drag: 0,
				sway: 12,
				shape: 'confetti',
				count: 320,
				size: 8,
				sizeRandom: 45,
				depth: 70,
				rotation: 180,
				tumble: 85,
				tumbleRate: 1.2,
				sheen: 60,
				colorMode: 'palette',
				color: hex('#ffd34d'),
				color2: hex('#fff8e8'),
				color3: hex('#ff3b4e'),
				opacityRandom: 0,
			},
		},
		{
			id: 'petals',
			label: 'Petals',
			params: {
				emitter: 'full',
				distribution: 'scatter',
				falloff: 0,
				angle: 60,
				travel: 240,
				lifetime: 4,
				drag: 0,
				sway: 18,
				swayRate: 0.4,
				shape: 'petal',
				count: 380,
				size: 13,
				sizeRandom: 50,
				depth: 80,
				rotation: 180,
				spinRate: 0.4,
				tumble: 70,
				colorMode: 'palette',
				color: hex('#ffd1e0'),
				color2: hex('#ffb3cb'),
				color3: hex('#fff0f5'),
				opacityRandom: 10,
			},
		},
		{
			id: 'motes',
			label: 'Light Motes',
			params: {
				emitter: 'ellipse',
				rx: 380,
				ry: 220,
				distribution: 'scatter',
				falloff: 40,
				angle: -90,
				travel: 40,
				lifetime: 4,
				sway: 8,
				count: 420,
				size: 4.5,
				sizeRandom: 70,
				depth: 85,
				colorMode: 'palette',
				color: hex('#ffffff'),
				color2: hex('#bfefff'),
				color3: hex('#ffe9a8'),
				opacityRandom: 55,
			},
		},
		{
			id: 'bokeh',
			label: 'Bokeh',
			params: {
				emitter: 'full',
				distribution: 'scatter',
				falloff: 30,
				angle: -90,
				travel: 30,
				lifetime: 5,
				shape: 'bokeh',
				count: 45,
				size: 75,
				sizeRandom: 70,
				depth: 30,
				ring: 40,
				colorMode: 'palette',
				color: hex('#ffcf5a'),
				color2: hex('#ffa63d'),
				color3: hex('#ff7a2e'),
				particleOpacity: 40,
				opacityRandom: 60,
			},
		},
		{
			id: 'rain',
			label: 'Rain',
			params: {
				emitter: 'full',
				distribution: 'scatter',
				falloff: 0,
				angle: 100,
				cone: 4,
				travel: 700,
				lifetime: 0.7,
				drag: 0,
				shape: 'rain',
				count: 900,
				size: 0.75,
				sizeRandom: 40,
				streak: 60,
				depth: 60,
				colorMode: 'solid',
				color: hex('#cfe6ff'),
				particleOpacity: 45,
				opacityRandom: 60,
			},
		},
		{
			id: 'fireworks',
			label: 'Fireworks',
			params: {
				emitter: 'point',
				timing: 'once',
				stagger: 0.05,
				lifetime: 1.6,
				drag: 70,
				gravity: 40,
				falloff: 0,
				travel: 190,
				cone: 6,
				shape: 'ember',
				count: 600,
				size: 1.5,
				sizeRandom: 40,
				streak: 20,
				depth: 30,
				colorMode: 'palette',
				color: hex('#ffffff'),
				color2: hex('#ff6ab0'),
				color3: hex('#7ad8ff'),
				opacityRandom: 30,
			},
		},
	],
	reach: reachOf,
	fieldReach: (p) =>
		p.emitter === 'layer' ? { outside: num(p.capture) + 2, inside: num(p.capture) + 2 } : { outside: 1 },
	timeDependent: () => true,
	summary: (p) => `${String(p.shape)}, ${Math.round(num(p.count))} from ${String(p.emitter)}`,
	prepass: (p, c) => [
		c.pass({
			output: 'tlGenA',
			format: 'rgba16f',
			include: [GLSL_UV, GLSL_TLG_SITES, GLSL_TLG_QUAD],
			draw: {
				vertices: 6,
				instances: Math.round(clamp(num(p.count), 1, MAX_PARTICLES)),
				blend: solid(p) ? 'over' : 'add',
				vert: VERT,
			},
			frag: FRAG,
		}),
	],
	glsl: /* glsl */ `
vec4 tl_generate(TlSurface s) {
  vec4 c = texture(u_tlGenA, s.uv);
#ifndef TLG_STANDALONE
  // In a look the canvas ends at Extent: particles fade out before they reach it.
  vec2 e = min(s.px, u_canvasSize - s.px);
  c *= smoothstep(0.0, tl_px(8.0), min(e.x, e.y));
#endif
  return vec4(c.rgb, clamp(c.a, 0.0, 1.0));
}`,
});
