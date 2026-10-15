// Time Interpolation on the GPU: Frame Blending and Optical Flow between two decoded frames in
// WebGL2, the same algorithm as the CPU reference `@jasper/project` time-remap/flow.ts (used by the native export):
// analysis luma (k×k box), 2×2 pyramids, hierarchical block matching (SAD ±4 at the coarsest level, ±1 around the
// sorted, de-duplicated seeds of the tile and its 4 neighbours below), sub-pixel parabola, 3×3 component-wise
// median, both directions, then the per-pixel multi-hypothesis interpolation with forward/backward agreement and
// occlusion-aware weights. Loops, seed order, comparisons and clamping follow the CPU code statement by statement so
// both produce the same vectors (float32 vs float64 sums can only break exact ties differently).
//
// Pictures are straight RGBA 0…1 (canvases uploaded without premultiplication); the output canvas holds straight RGBA.
import {
	FLOW_BLOCK,
	FLOW_CHOICE_SHARPNESS,
	FLOW_CONSISTENCY_BASE,
	FLOW_CONSISTENCY_SLOPE,
	FLOW_DELTA,
	FLOW_PHOTO_WEIGHT,
	FLOW_RADIUS,
	FLOW_SLOW_BIAS,
	pyramidLevels,
} from '@jasper/project';

type Src = TexImageSource;

const VERT = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

const LUMA = `${HEAD}
uniform sampler2D uA;
uniform sampler2D uB;
uniform ivec2 uSrc;
uniform int uK;
out vec4 o;
float L(vec4 p) { return 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b + 0.25 * p.a; }
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  float sa = 0.0, sb = 0.0;
  for (int j = 0; j < 16; j++) {
    if (j >= uK) break;
    int yy = min(uSrc.y - 1, q.y * uK + j);
    for (int i = 0; i < 16; i++) {
      if (i >= uK) break;
      int xx = min(uSrc.x - 1, q.x * uK + i);
      sa += L(texelFetch(uA, ivec2(xx, yy), 0));
      sb += L(texelFetch(uB, ivec2(xx, yy), 0));
    }
  }
  float inv = 1.0 / float(uK * uK);
  o = vec4(sa * inv, sb * inv, 0.0, 1.0);
}`;

const HALF = `${HEAD}
uniform sampler2D uP;
uniform ivec2 uSize;
out vec4 o;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  int x0 = min(uSize.x - 1, q.x * 2), x1 = min(uSize.x - 1, q.x * 2 + 1);
  int y0 = min(uSize.y - 1, q.y * 2), y1 = min(uSize.y - 1, q.y * 2 + 1);
  o = (texelFetch(uP, ivec2(x0, y0), 0) + texelFetch(uP, ivec2(x1, y0), 0)
     + texelFetch(uP, ivec2(x0, y1), 0) + texelFetch(uP, ivec2(x1, y1), 0)) * 0.25;
}`;

/** SAD of a block; `dir` 0 = A→B (r = A, g = B), 1 = B→A. */
const SAD = /* glsl */ `
uniform sampler2D uLevel;
uniform ivec2 uLevelSize;
float sad(int dir, int bx, int by, int bs, int dx, int dy) {
  float s = 0.0;
  for (int y = 0; y < 16; y++) {
    if (y >= bs) break;
    int ya = clamp(by + y, 0, uLevelSize.y - 1);
    int yb = clamp(by + y + dy, 0, uLevelSize.y - 1);
    for (int x = 0; x < 16; x++) {
      if (x >= bs) break;
      int xa = clamp(bx + x, 0, uLevelSize.x - 1);
      int xb = clamp(bx + x + dx, 0, uLevelSize.x - 1);
      vec2 pa = texelFetch(uLevel, ivec2(xa, ya), 0).rg;
      vec2 pb = texelFetch(uLevel, ivec2(xb, yb), 0).rg;
      float a = dir == 0 ? pa.r : pa.g;
      float b = dir == 0 ? pb.g : pb.r;
      s += abs(a - b);
    }
  }
  return s;
}`;

const MATCH = `${HEAD}
${SAD}
uniform sampler2D uPrev;
uniform ivec2 uGrid;
uniform int uK;
uniform int uLbs;
uniform int uR;
uniform int uTop;
uniform int uBs;
out vec4 o;
ivec2 search(int dir, int c, int rr) {
  int bx = (c * uBs) / uK;
  int by = (rr * uBs) / uK;
  ivec2 seeds[6];
  int n = 0;
  seeds[n++] = ivec2(0);
  if (uTop == 0) {
    ivec2 nb[5] = ivec2[5](ivec2(0, 0), ivec2(-1, 0), ivec2(1, 0), ivec2(0, -1), ivec2(0, 1));
    for (int i = 0; i < 5; i++) {
      ivec2 g = ivec2(c, rr) + nb[i];
      if (g.x < 0 || g.y < 0 || g.x >= uGrid.x || g.y >= uGrid.y) continue;
      vec4 pv = texelFetch(uPrev, g, 0);
      vec2 v = dir == 0 ? pv.xy : pv.zw;
      seeds[n++] = ivec2(round(v)) * 2;
    }
  }
  // insertion sort (x, then y), like the CPU's lexicographic sort
  for (int i = 1; i < 6; i++) {
    if (i >= n) break;
    ivec2 key = seeds[i];
    int j = i - 1;
    while (j >= 0 && (seeds[j].x > key.x || (seeds[j].x == key.x && seeds[j].y > key.y))) {
      seeds[j + 1] = seeds[j];
      j--;
    }
    seeds[j + 1] = key;
  }
  ivec2 best = ivec2(0);
  float bestE = 3.0e38;
  for (int s = 0; s < 6; s++) {
    if (s >= n) break;
    if (s > 0 && seeds[s] == seeds[s - 1]) continue;
    for (int dy = -4; dy <= 4; dy++) {
      if (dy < -uR || dy > uR) continue;
      for (int dx = -4; dx <= 4; dx++) {
        if (dx < -uR || dx > uR) continue;
        ivec2 d = seeds[s] + ivec2(dx, dy);
        float e = sad(dir, bx, by, uLbs, d.x, d.y) + 1.0e-4 * float(abs(d.x) + abs(d.y));
        if (e < bestE) { bestE = e; best = d; }
      }
    }
  }
  return best;
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  o = vec4(vec2(search(0, q.x, q.y)), vec2(search(1, q.x, q.y)));
}`;

const FINE = `${HEAD}
${SAD}
uniform sampler2D uVec;
uniform int uBs;
out vec4 o;
float fit(float em, float e0, float ep) {
  float den = em - 2.0 * e0 + ep;
  return den > 1.0e-6 ? clamp((0.5 * (em - ep)) / den, -0.5, 0.5) : 0.0;
}
vec2 refine(int dir, ivec2 t, vec2 dv) {
  int bx = t.x * uBs, by = t.y * uBs;
  int dx = int(round(dv.x)), dy = int(round(dv.y));
  float e0 = sad(dir, bx, by, uBs, dx, dy);
  float sx = fit(sad(dir, bx, by, uBs, dx - 1, dy), e0, sad(dir, bx, by, uBs, dx + 1, dy));
  float sy = fit(sad(dir, bx, by, uBs, dx, dy - 1), e0, sad(dir, bx, by, uBs, dx, dy + 1));
  return vec2(float(dx) + sx, float(dy) + sy);
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec4 v = texelFetch(uVec, q, 0);
  o = vec4(refine(0, q, v.xy), refine(1, q, v.zw));
}`;

const MEDIAN = `${HEAD}
uniform sampler2D uFine;
uniform ivec2 uGrid;
out vec4 o;
float med(float v[9], int n) {
  for (int i = 1; i < 9; i++) {
    if (i >= n) break;
    float key = v[i];
    int j = i - 1;
    while (j >= 0 && v[j] > key) { v[j + 1] = v[j]; j--; }
    v[j + 1] = key;
  }
  return v[n >> 1];
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  float a[9]; float b[9]; float c[9]; float d[9];
  int n = 0;
  for (int dr = -1; dr <= 1; dr++)
    for (int dc = -1; dc <= 1; dc++) {
      ivec2 g = q + ivec2(dc, dr);
      if (g.x < 0 || g.y < 0 || g.x >= uGrid.x || g.y >= uGrid.y) continue;
      vec4 v = texelFetch(uFine, g, 0);
      a[n] = v.x; b[n] = v.y; c[n] = v.z; d[n] = v.w;
      n++;
    }
  o = vec4(med(a, n), med(b, n), med(c, n), med(d, n));
}`;

const INTERP = `${HEAD}
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uFlow;
uniform ivec2 uSize;
uniform ivec2 uGrid;
uniform float uK;
uniform float uBlock;
uniform float uW;
out vec4 o;
vec4 smp(sampler2D t, vec2 p) {
  vec2 f = clamp(p - 0.5, vec2(0.0), vec2(uSize - 1));
  ivec2 i0 = ivec2(floor(f));
  ivec2 i1 = min(i0 + 1, uSize - 1);
  vec2 w = f - vec2(i0);
  vec4 top = mix(texelFetch(t, i0, 0), texelFetch(t, ivec2(i1.x, i0.y), 0), w.x);
  vec4 bot = mix(texelFetch(t, ivec2(i0.x, i1.y), 0), texelFetch(t, i1, 0), w.x);
  return mix(top, bot, w.y);
}
// Bilinear between tile centres; dir 0 = A→B (xy), 1 = B→A (zw). Analysis px in, full px out.
vec2 flowAt(int dir, vec2 p) {
  vec2 a = p / uK;
  vec2 f = clamp(a / uBlock - 0.5, vec2(0.0), vec2(uGrid - 1));
  ivec2 i0 = ivec2(floor(f));
  ivec2 i1 = min(i0 + 1, uGrid - 1);
  vec2 w = f - vec2(i0);
  vec4 v00 = texelFetch(uFlow, i0, 0), v10 = texelFetch(uFlow, ivec2(i1.x, i0.y), 0);
  vec4 v01 = texelFetch(uFlow, ivec2(i0.x, i1.y), 0), v11 = texelFetch(uFlow, i1, 0);
  vec4 top = v00 + (v10 - v00) * w.x;
  vec4 bot = v01 + (v11 - v01) * w.x;
  vec4 v = top + (bot - top) * w.y;
  return (dir == 0 ? v.xy : v.zw) * uK;
}
vec2 tileVec(int dir, ivec2 g) {
  vec4 v = texelFetch(uFlow, clamp(g, ivec2(0), uGrid - 1), 0);
  return (dir == 0 ? v.xy : v.zw) * uK;
}
float match(vec2 u, vec2 v) {
  float err = length(u - v);
  float t0 = ${FLOW_CONSISTENCY_BASE.toFixed(6)} + ${FLOW_CONSISTENCY_SLOPE.toFixed(6)} * length(v);
  return clamp(2.0 - err / t0, 0.0, 1.0);
}
void main() {
  vec2 p = gl_FragCoord.xy;
  // flip: texture row 0 is the picture's top (uploaded with UNPACK_FLIP_Y false)
  p.y = float(uSize.y) - p.y;
  vec2 cand[10];
  cand[0] = flowAt(0, p);
  cand[1] = -flowAt(1, p);
  vec2 a = p / uK;
  vec2 f = clamp(a / uBlock - 0.5, vec2(0.0), vec2(uGrid - 1));
  ivec2 g0 = ivec2(floor(f));
  cand[2] = tileVec(0, g0); cand[3] = tileVec(0, g0 + ivec2(1, 0));
  cand[4] = tileVec(0, g0 + ivec2(0, 1)); cand[5] = tileVec(0, g0 + ivec2(1, 1));
  cand[6] = -tileVec(1, g0); cand[7] = -tileVec(1, g0 + ivec2(1, 0));
  cand[8] = -tileVec(1, g0 + ivec2(0, 1)); cand[9] = -tileVec(1, g0 + ivec2(1, 1));
  vec4 cols[10];
  float scores[10];
  float best = -3.0e38;
  for (int h = 0; h < 10; h++) {
    vec2 v = cand[h];
    vec2 qa = p - uW * v;
    vec2 qb = p + (1.0 - uW) * v;
    float ca = match(flowAt(0, qa), v);
    float cb = match(-flowAt(1, qb), v);
    vec4 sa = smp(uA, qa);
    vec4 sb = smp(uB, qb);
    float wa = (1.0 - uW) * (ca + ${FLOW_DELTA.toFixed(6)});
    float wb = uW * (cb + ${FLOW_DELTA.toFixed(6)});
    cols[h] = (sa * wa + sb * wb) / (wa + wb);
    vec3 dd = abs(sa.rgb - sb.rgb);
    float photo = dd.r + dd.g + dd.b;
    float s = ca + cb - ${FLOW_PHOTO_WEIGHT.toFixed(6)} * photo * ca * cb - ${FLOW_SLOW_BIAS.toFixed(6)} * length(v);
    scores[h] = s;
    best = max(best, s);
  }
  vec4 acc = vec4(0.0);
  float sum = 0.0;
  for (int h = 0; h < 10; h++) {
    float e = exp(${FLOW_CHOICE_SHARPNESS.toFixed(6)} * (scores[h] - best));
    sum += e;
    acc += cols[h] * e;
  }
  o = acc / sum;
}`;

const BLEND = `${HEAD}
uniform sampler2D uA;
uniform sampler2D uB;
uniform ivec2 uSize;
uniform float uW;
uniform int uOne;
out vec4 o;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  q.y = uSize.y - 1 - q.y;
  vec4 a = texelFetch(uA, q, 0);
  o = uOne == 1 ? a : a + (texelFetch(uB, q, 0) - a) * uW;
}`;

type Target = { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number };

export class RetimeGLError extends Error {}

/** Whether this WebGL2 context can render the float targets optical flow needs. */
export function canRunFlow(gl: WebGL2RenderingContext): boolean {
	return !!gl.getExtension('EXT_color_buffer_float');
}

/**
 * GPU compositor of retimed frames. One per output canvas; keeps the last pair's flow so the in-between frames of a
 * slow motion (same two source frames, other fractions) only run the final pass.
 */
export class RetimeCompositor {
	readonly canvas: HTMLCanvasElement | OffscreenCanvas;
	private readonly gl: WebGL2RenderingContext;
	private readonly progs = new Map<string, WebGLProgram>();
	private readonly texA: WebGLTexture;
	private readonly texB: WebGLTexture;
	private targets = new Map<string, Target>();
	private flowKey: string | null = null;
	private flowTex: Target | null = null;
	readonly floatTargets: boolean;

	constructor(canvas?: HTMLCanvasElement | OffscreenCanvas) {
		this.canvas = canvas ?? document.createElement('canvas');
		const gl = this.canvas.getContext('webgl2', {
			premultipliedAlpha: false,
			preserveDrawingBuffer: true,
			antialias: false,
			alpha: true,
		}) as WebGL2RenderingContext | null;
		if (!gl) throw new RetimeGLError('WebGL2 is not available');
		this.gl = gl;
		this.floatTargets = canRunFlow(gl);
		this.texA = this.newTex();
		this.texB = this.newTex();
	}

	private newTex(): WebGLTexture {
		const gl = this.gl;
		const t = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, t);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		return t;
	}

	private prog(name: string, frag: string): WebGLProgram {
		const hit = this.progs.get(name);
		if (hit) return hit;
		const gl = this.gl;
		const sh = (type: number, src: string) => {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
				throw new RetimeGLError(`${name}: ${gl.getShaderInfoLog(s) ?? 'compile error'}`);
			return s;
		};
		const p = gl.createProgram()!;
		gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
		gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS))
			throw new RetimeGLError(`${name}: ${gl.getProgramInfoLog(p) ?? 'link error'}`);
		this.progs.set(name, p);
		return p;
	}

	private target(key: string, w: number, h: number, format: 'rg32f' | 'rgba32f'): Target {
		const hit = this.targets.get(key);
		if (hit && hit.w === w && hit.h === h) return hit;
		const gl = this.gl;
		if (hit) {
			gl.deleteTexture(hit.tex);
			gl.deleteFramebuffer(hit.fb);
		}
		const tex = this.newTex();
		if (format === 'rg32f') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, w, h, 0, gl.RG, gl.FLOAT, null);
		else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
		const fb = gl.createFramebuffer()!;
		gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		const t = { tex, fb, w, h };
		this.targets.set(key, t);
		return t;
	}

	private upload(tex: WebGLTexture, src: Src): void {
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
	}

	private activate(p: WebGLProgram): void {
		// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
		this.gl.useProgram(p);
	}

	private bindTex(p: WebGLProgram, name: string, unit: number, tex: WebGLTexture): void {
		const gl = this.gl;
		gl.activeTexture(gl.TEXTURE0 + unit);
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.uniform1i(gl.getUniformLocation(p, name), unit);
	}

	private draw(fb: WebGLFramebuffer | null, w: number, h: number): void {
		const gl = this.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
		gl.viewport(0, 0, w, h);
		gl.disable(gl.BLEND);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	private sizeCanvas(w: number, h: number): void {
		if (this.canvas.width !== w) this.canvas.width = w;
		if (this.canvas.height !== h) this.canvas.height = h;
	}

	/** Frame Sampling (`b` null) or Frame Blending: a·(1 − w) + b·w. */
	blend(
		a: Src,
		b: Src | null,
		w: number,
		width: number,
		height: number,
	): HTMLCanvasElement | OffscreenCanvas {
		const gl = this.gl;
		this.sizeCanvas(width, height);
		this.upload(this.texA, a);
		if (b) this.upload(this.texB, b);
		const p = this.prog('blend', BLEND);
		this.activate(p);
		this.bindTex(p, 'uA', 0, this.texA);
		this.bindTex(p, 'uB', 1, b ? this.texB : this.texA);
		gl.uniform2i(gl.getUniformLocation(p, 'uSize'), width, height);
		gl.uniform1f(gl.getUniformLocation(p, 'uW'), w);
		gl.uniform1i(gl.getUniformLocation(p, 'uOne'), b && w > 0 ? 0 : 1);
		this.draw(null, width, height);
		return this.canvas;
	}

	/**
	 * Optical Flow: the motion-compensated picture at `w` between `a` and `b` (`width`×`height`). `analysis` is the
	 * analysis size (`analysisSize(mediaW, mediaH, analysisFactor(...))`) — the decoded frames must be an integer
	 * multiple `kd` of it. `pairKey` identifies the two frames (their flow is reused while it stays the same).
	 */
	flow(
		a: Src,
		b: Src,
		w: number,
		width: number,
		height: number,
		analysis: { w: number; h: number },
		pairKey: string,
	): HTMLCanvasElement | OffscreenCanvas {
		if (!this.floatTargets) return this.blend(a, b, w, width, height);
		const gl = this.gl;
		this.sizeCanvas(width, height);
		const kd = Math.max(1, Math.round(width / analysis.w));
		const key = `${pairKey}|${width}x${height}|${analysis.w}x${analysis.h}`;
		this.upload(this.texA, a);
		this.upload(this.texB, b);
		if (this.flowKey !== key || !this.flowTex) {
			this.flowTex = this.computeFlow(width, height, analysis, kd);
			this.flowKey = key;
		}
		const grid = this.grid(analysis);
		const p = this.prog('interp', INTERP);
		this.activate(p);
		this.bindTex(p, 'uA', 0, this.texA);
		this.bindTex(p, 'uB', 1, this.texB);
		this.bindTex(p, 'uFlow', 2, this.flowTex.tex);
		gl.uniform2i(gl.getUniformLocation(p, 'uSize'), width, height);
		gl.uniform2i(gl.getUniformLocation(p, 'uGrid'), grid.cols, grid.rows);
		gl.uniform1f(gl.getUniformLocation(p, 'uK'), kd);
		gl.uniform1f(gl.getUniformLocation(p, 'uBlock'), FLOW_BLOCK);
		gl.uniform1f(gl.getUniformLocation(p, 'uW'), w);
		this.draw(null, width, height);
		return this.canvas;
	}

	private grid(analysis: { w: number; h: number }): { cols: number; rows: number } {
		return {
			cols: Math.max(1, Math.ceil(analysis.w / FLOW_BLOCK)),
			rows: Math.max(1, Math.ceil(analysis.h / FLOW_BLOCK)),
		};
	}

	private computeFlow(width: number, height: number, analysis: { w: number; h: number }, kd: number): Target {
		const gl = this.gl;
		const { cols, rows } = this.grid(analysis);
		// Analysis luma (both frames).
		const l0 = this.target('lum0', analysis.w, analysis.h, 'rg32f');
		let p = this.prog('luma', LUMA);
		this.activate(p);
		this.bindTex(p, 'uA', 0, this.texA);
		this.bindTex(p, 'uB', 1, this.texB);
		gl.uniform2i(gl.getUniformLocation(p, 'uSrc'), width, height);
		gl.uniform1i(gl.getUniformLocation(p, 'uK'), kd);
		this.draw(l0.fb, l0.w, l0.h);
		const levels: Target[] = [l0];
		const nLevels = pyramidLevels(analysis.w, analysis.h);
		p = this.prog('half', HALF);
		for (let i = 1; i < nLevels; i++) {
			const prev = levels[i - 1]!;
			const t = this.target(
				`lum${i}`,
				Math.max(1, Math.floor(prev.w / 2)),
				Math.max(1, Math.floor(prev.h / 2)),
				'rg32f',
			);
			this.activate(p);
			this.bindTex(p, 'uP', 0, prev.tex);
			gl.uniform2i(gl.getUniformLocation(p, 'uSize'), prev.w, prev.h);
			this.draw(t.fb, t.w, t.h);
			levels.push(t);
		}
		// Block matching, coarsest level first.
		const vecA = this.target('vecA', cols, rows, 'rgba32f');
		const vecB = this.target('vecB', cols, rows, 'rgba32f');
		let cur = vecA;
		let prev = vecB;
		const pm = this.prog('match', MATCH);
		const top = nLevels - 1;
		const ok = analysis.w >= FLOW_BLOCK && analysis.h >= FLOW_BLOCK;
		for (let level = top; level >= 0; level--) {
			const lv = levels[level]!;
			const k = 2 ** level;
			this.activate(pm);
			this.bindTex(pm, 'uLevel', 0, lv.tex);
			this.bindTex(pm, 'uPrev', 1, prev.tex);
			gl.uniform2i(gl.getUniformLocation(pm, 'uLevelSize'), lv.w, lv.h);
			gl.uniform2i(gl.getUniformLocation(pm, 'uGrid'), cols, rows);
			gl.uniform1i(gl.getUniformLocation(pm, 'uK'), k);
			gl.uniform1i(gl.getUniformLocation(pm, 'uLbs'), Math.max(Math.floor(FLOW_BLOCK / k), 4));
			gl.uniform1i(gl.getUniformLocation(pm, 'uR'), level === top ? FLOW_RADIUS : 1);
			gl.uniform1i(gl.getUniformLocation(pm, 'uTop'), level === top ? 1 : 0);
			gl.uniform1i(gl.getUniformLocation(pm, 'uBs'), FLOW_BLOCK);
			this.draw(cur.fb, cols, rows);
			[cur, prev] = [prev, cur];
		}
		const ints = prev;
		// Sub-pixel parabola at level 0, then the 3×3 median.
		const fine = this.target('fine', cols, rows, 'rgba32f');
		const pf = this.prog('fine', FINE);
		this.activate(pf);
		this.bindTex(pf, 'uLevel', 0, l0.tex);
		this.bindTex(pf, 'uVec', 1, ints.tex);
		gl.uniform2i(gl.getUniformLocation(pf, 'uLevelSize'), l0.w, l0.h);
		gl.uniform1i(gl.getUniformLocation(pf, 'uBs'), FLOW_BLOCK);
		this.draw(fine.fb, cols, rows);
		const flow = this.target('flow', cols, rows, 'rgba32f');
		const pmed = this.prog('median', MEDIAN);
		this.activate(pmed);
		this.bindTex(pmed, 'uFine', 0, fine.tex);
		gl.uniform2i(gl.getUniformLocation(pmed, 'uGrid'), cols, rows);
		this.draw(flow.fb, cols, rows);
		if (!ok) {
			// Too small to match (the CPU returns a zero field): clear.
			gl.bindFramebuffer(gl.FRAMEBUFFER, flow.fb);
			gl.clearColor(0, 0, 0, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
		}
		return flow;
	}

	dispose(): void {
		const gl = this.gl;
		for (const t of this.targets.values()) {
			gl.deleteTexture(t.tex);
			gl.deleteFramebuffer(t.fb);
		}
		this.targets.clear();
		gl.deleteTexture(this.texA);
		gl.deleteTexture(this.texB);
		for (const p of this.progs.values()) gl.deleteProgram(p);
		this.progs.clear();
		this.flowTex = null;
		this.flowKey = null;
	}
}
