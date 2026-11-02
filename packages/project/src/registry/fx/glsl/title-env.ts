// Spec 19 TL-038: the procedural reflection environments of look finishes and of Title Material. Each preset is a closed
// form of the mirrored direction: no bundled image, no project depends on a file. `w` is the blur in radians: every edge of
// a preset widens by it, so a rough surface sees the same room with softer lights at no extra cost. Values are linear light
// and may exceed 1 (lights are brighter than white). Layout of the map as in Pachislop's reflection panoramas: elevation
// from the horizon, azimuth 0 straight behind the viewer, where a flat face mirrors the view ray.
import type { GlslChunk } from '../shader.ts';
import { GLSL_COLOR } from './color.ts';
import { GLSL_HASH } from './hash.ts';
import { GLSL_UV } from './sample.ts';

/** Option values of an environment param, in the order of `tl_env`'s `preset`. */
export const TL_ENV_PRESETS = ['studio', 'sky', 'city', 'sunset', 'chromeBands', 'neon'] as const;
export const TL_ENV_LABELS = ['Studio', 'Sky', 'City', 'Sunset', 'Chrome Bands', 'Neon'] as const;

export const GLSL_TL_ENV: GlslChunk = {
	name: 'title-look/env',
	deps: [GLSL_HASH, GLSL_UV, GLSL_COLOR],
	source: /* glsl */ `
float tl_envS(float e, float w, float x) { return smoothstep(e - w, e + w, x); }
float tl_envB(float a, float b, float w, float x) { return tl_envS(a, w, x) - tl_envS(b, w, x); }
// A photographer's room: dark floor, grey sweep, a softbox overhead and two strip lights.
vec3 tl_envStudio(float el, float az, float w) {
  vec3 c = mix(vec3(0.012), vec3(0.17, 0.18, 0.2), tl_envS(-0.1, 0.3 + w, el));
  c += vec3(3.4, 3.3, 3.15) * tl_envB(0.5, 1.2, 0.05 + w, el);
  float strip = tl_envB(0.7, 1.1, 0.03 + w, abs(az)) * tl_envB(-0.4, 0.55, 0.08 + w, el);
  return c + vec3(2.3, 2.4, 2.6) * strip;
}
// Open sky: pale horizon, deep zenith, a sun high on the left, sunlit ground.
vec3 tl_envSky(float el, float az, float w) {
  vec3 sky = mix(vec3(0.82, 0.9, 1.0), vec3(0.05, 0.17, 0.5), tl_envS(0.42, 0.42 + w, el));
  vec3 ground = mix(vec3(0.3, 0.25, 0.18), vec3(0.04, 0.05, 0.03), tl_envS(0.3, 0.3 + w, -el));
  vec3 c = mix(ground, sky, tl_envS(0.0, 0.015 + w, el));
  vec2 q = vec2(az + 0.7, el - 0.75);
  float r = 0.03 + w * w * 2.0;
  return c + vec3(6.0, 5.6, 4.8) * exp(-dot(q, q) / (2.0 * r)) * (0.03 / r);
}
// A skyline at dusk: towers with lit windows against a violet sky, a wet road below.
vec3 tl_envCity(float el, float az, float w) {
  vec3 sky = mix(vec3(0.34, 0.15, 0.3), vec3(0.012, 0.016, 0.06), tl_envS(0.3, 0.3 + w, el));
  float x = (az / FX_TAU + 0.5) * 40.0;
  int id = int(floor(x));
  float top = 0.06 + 0.5 * fx_hash1(id, 0.37) * fx_hash1(id + 40, 0.73);
  vec2 g = vec2(x * 4.0, el * 42.0);
  ivec2 cell = ivec2(floor(g));
  vec2 f = abs(fract(g) - 0.5);
  float lit = step(0.6, fx_hash2(cell, 0.11)) * (1.0 - smoothstep(0.26, 0.34, max(f.x, f.y)));
  vec3 lights = mix(vec3(2.4, 1.5, 0.6), vec3(0.6, 1.1, 2.2), step(0.8, fx_hash2(cell + 9, 0.21)));
  // Past a blur of a window or two the lights melt into the glow they average to.
  vec3 tower = mix(vec3(0.01, 0.012, 0.02) + lights * lit, vec3(0.22, 0.17, 0.14), min(w * 7.0, 1.0));
  vec3 c = mix(sky, tower, 1.0 - tl_envS(top, 0.006 + w, el));
  vec3 road = mix(vec3(0.3, 0.2, 0.17), vec3(0.008, 0.01, 0.016), tl_envS(0.22, 0.2 + w, -el));
  return mix(road, c, tl_envS(0.0, 0.008 + w, el));
}
// The sun on the horizon: gold into rose into violet overhead, a dark sea with a path of light.
vec3 tl_envSunset(float el, float az, float w) {
  vec3 low = mix(vec3(2.1, 0.9, 0.2), vec3(1.0, 0.22, 0.26), tl_envS(0.22, 0.2 + w, el));
  vec3 sky = mix(low, vec3(0.07, 0.04, 0.2), tl_envS(0.72, 0.42 + w, el));
  float sea = tl_envS(0.0, 0.01 + w, -el);
  float path = exp(-az * az / (0.04 + w)) * (0.2 + 1.6 * exp(el * 4.0));
  vec3 water = vec3(0.03, 0.02, 0.07) + vec3(2.2, 1.0, 0.3) * path * 0.6;
  float r = 0.018 + w * w;
  vec2 q = vec2(az, el - 0.09);
  vec3 c = mix(sky, water, sea);
  return c + vec3(7.0, 4.4, 1.7) * exp(-dot(q, q) / (2.0 * r)) * (0.018 / r) * (1.0 - sea);
}
// The airbrushed chrome of title cards: white-hot horizon falling into blue sky, black line, warm ground coming up to it.
vec3 tl_envChromeBands(float el, float az, float w) {
  vec3 sky = mix(vec3(3.2, 3.3, 3.5), vec3(0.32, 0.46, 0.78), tl_envS(0.2, 0.2 + w, el));
  sky = mix(sky, vec3(0.03, 0.06, 0.17), tl_envS(0.85, 0.38 + w, el));
  sky += vec3(2.0, 2.05, 2.2) * tl_envB(1.02, 1.12, 0.02 + w, el);
  vec3 ground = mix(vec3(0.015, 0.012, 0.012), vec3(1.0, 0.72, 0.46), tl_envS(0.32, 0.26 + w, -el));
  ground = mix(ground, vec3(0.1, 0.06, 0.04), tl_envS(0.95, 0.3 + w, -el));
  return mix(ground, sky, tl_envS(0.0, 0.006 + w, el));
}
// A dark room of tubes: magenta and cyan lines, a green rail, their glow on the walls.
vec3 tl_envNeon(float el, float az, float w) {
  float t = 0.012 + w;
  vec3 c = vec3(0.012, 0.01, 0.03);
  float g = 0.08 + w;
  c += vec3(5.0, 0.3, 2.6) * tl_envB(0.28, 0.36, t, el);
  c += vec3(0.4, 0.2, 0.7) * exp(-(el - 0.32) * (el - 0.32) / (g * g));
  c += vec3(0.25, 3.5, 5.0) * tl_envB(-0.3, -0.22, t, el);
  c += vec3(0.1, 0.5, 0.8) * exp(-(el + 0.26) * (el + 0.26) / (g * g));
  c += vec3(0.6, 5.0, 1.0) * tl_envB(0.86, 0.92, t, el);
  float bars = tl_envB(-0.03, 0.03, t, abs(mod(az + 0.45, 0.9) - 0.45) - 0.2);
  return c + vec3(4.0, 1.0, 5.0) * bars * tl_envB(-0.2, 0.26, 0.02 + w, el);
}
// The environment seen along r (x right, y down, z to the viewer). rotation: radians around the vertical; blur: radians.
vec3 tl_env(int preset, vec3 r, float rotation, float blur) {
  float el = asin(clamp(-r.y, -1.0, 1.0));
  float az = mod(atan(r.x, r.z) + rotation + FX_PI, FX_TAU) - FX_PI;
  if (preset == 0) return tl_envStudio(el, az, blur);
  if (preset == 1) return tl_envSky(el, az, blur);
  if (preset == 2) return tl_envCity(el, az, blur);
  if (preset == 3) return tl_envSunset(el, az, blur);
  if (preset == 4) return tl_envChromeBands(el, az, blur);
  return tl_envNeon(el, az, blur);
}
// An equirectangular picture (row 0 the zenith) in place of a preset: taps over a cone of half-angle blur.
vec3 tl_envImage(sampler2D t, vec3 r, float rotation, float blur) {
  vec3 sum = vec3(0.0);
  vec3 u = normalize(cross(abs(r.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0), r));
  vec3 v = cross(r, u);
  int taps = blur > 0.0 ? 12 : 1;
  for (int i = 0; i < taps; i++) {
    // Golden-angle spiral: the same taps in the same order on every frame.
    float k = float(i);
    float a = k * 2.39996323;
    float m = blur * sqrt((k + 0.5) / float(taps));
    vec3 d = normalize(r + (u * cos(a) + v * sin(a)) * m);
    vec2 uv = vec2(fract(atan(d.x, d.z) / FX_TAU + 0.5 + rotation / FX_TAU), 0.5 + asin(clamp(d.y, -1.0, 1.0)) / FX_PI);
    vec4 c = texture(t, uv);
    sum += c.a > 0.0 ? fx_srgbToLinear(clamp(c.rgb / c.a, 0.0, 1.0)) : vec3(0.0);
  }
  return sum / float(taps);
}
`,
};
