// WebGL2 colour stage core (S06:CG-040/045/046, ARCHITECTURE D-21): draws a source picture through ONE baked
// colour-run LUT with the same tetrahedral interpolation as `applyLut` (and FFmpeg `lut3d`): the four lattice
// corners are read with `texelFetch` from a float 3D texture — no hardware trilinear filtering — so the preview
// agrees with the TypeScript reference to the 8-bit rounding of the output. Straight alpha: the source is uploaded
// unpremultiplied, the LUT maps RGB only, the output is premultiplied for the (premultiplied) canvas.
import type { Lut } from '@jasper/project';

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/**
 * Fragment shader. `u_src` is sampled with `texelFetch` at the output pixel (scaled when the source size differs),
 * `u_lut` is the `size³` table in `.cube` order (x = red fastest, y = green, z = blue).
 */
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
uniform sampler2D u_src;
uniform sampler3D u_lut;
uniform int u_size;
uniform vec3 u_dmin;
uniform vec3 u_dmax;
uniform vec2 u_scale;
out vec4 o_color;

vec3 lutAt(ivec3 p) { return texelFetch(u_lut, p, 0).rgb; }

void main() {
  ivec2 srcSize = textureSize(u_src, 0);
  ivec2 p = ivec2(floor(gl_FragCoord.xy * u_scale));
  p = clamp(p, ivec2(0), srcSize - 1);
  vec4 s = texelFetch(u_src, p, 0);
  int n1 = u_size - 1;
  float sf = float(n1);
  vec3 x = clamp((s.rgb - u_dmin) / (u_dmax - u_dmin), 0.0, 1.0) * sf;
  ivec3 i0 = min(ivec3(floor(x)), ivec3(n1 - 1));
  vec3 f = x - vec3(i0);
  float fr = f.r; float fg = f.g; float fb = f.b;
  vec3 c000 = lutAt(i0);
  vec3 c111 = lutAt(i0 + ivec3(1, 1, 1));
  vec3 a; vec3 b; float w0; float w1; float w2; float w3;
  if (fr > fg) {
    if (fg > fb) {
      a = lutAt(i0 + ivec3(1, 0, 0)); b = lutAt(i0 + ivec3(1, 1, 0));
      w0 = 1.0 - fr; w1 = fr - fg; w2 = fg - fb; w3 = fb;
    } else if (fr > fb) {
      a = lutAt(i0 + ivec3(1, 0, 0)); b = lutAt(i0 + ivec3(1, 0, 1));
      w0 = 1.0 - fr; w1 = fr - fb; w2 = fb - fg; w3 = fg;
    } else {
      a = lutAt(i0 + ivec3(0, 0, 1)); b = lutAt(i0 + ivec3(1, 0, 1));
      w0 = 1.0 - fb; w1 = fb - fr; w2 = fr - fg; w3 = fg;
    }
  } else if (fb > fg) {
    a = lutAt(i0 + ivec3(0, 0, 1)); b = lutAt(i0 + ivec3(0, 1, 1));
    w0 = 1.0 - fb; w1 = fb - fg; w2 = fg - fr; w3 = fr;
  } else if (fb > fr) {
    a = lutAt(i0 + ivec3(0, 1, 0)); b = lutAt(i0 + ivec3(0, 1, 1));
    w0 = 1.0 - fg; w1 = fg - fb; w2 = fb - fr; w3 = fr;
  } else {
    a = lutAt(i0 + ivec3(0, 1, 0)); b = lutAt(i0 + ivec3(1, 1, 0));
    w0 = 1.0 - fg; w1 = fg - fr; w2 = fr - fb; w3 = fb;
  }
  vec3 rgb = clamp(w0 * c000 + w1 * a + w2 * b + w3 * c111, 0.0, 1.0);
  o_color = vec4(rgb * s.a, s.a);
}
`;

/** GL resources of one WebGL2 context (one per target canvas). */
export type ColorGl = {
	gl: WebGL2RenderingContext;
	program: WebGLProgram;
	vao: WebGLVertexArrayObject;
	srcTex: WebGLTexture;
	u: {
		src: WebGLUniformLocation | null;
		lut: WebGLUniformLocation | null;
		size: WebGLUniformLocation | null;
		dmin: WebGLUniformLocation | null;
		dmax: WebGLUniformLocation | null;
		scale: WebGLUniformLocation | null;
	};
	/** LUT textures by run key (LRU, `maxLuts`). */
	luts: Map<string, WebGLTexture>;
	maxLuts: number;
};

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
	const sh = gl.createShader(type);
	if (!sh) throw new Error('WEBGL_UNAVAILABLE: cannot create a shader');
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost())
		throw new Error(`colour stage shader: ${gl.getShaderInfoLog(sh)}`);
	return sh;
}

/** Compiles the program and allocates the per-context resources. */
export function createColorGl(gl: WebGL2RenderingContext, maxLuts = 64): ColorGl {
	const program = gl.createProgram();
	if (!program) throw new Error('WEBGL_UNAVAILABLE: cannot create a program');
	gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
	gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
	gl.bindAttribLocation(program, 0, 'a_pos');
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost())
		throw new Error(`colour stage program: ${gl.getProgramInfoLog(program)}`);
	const vao = gl.createVertexArray()!;
	gl.bindVertexArray(vao);
	const buf = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buf);
	// One oversized triangle covering the viewport.
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
	gl.bindVertexArray(null);
	const srcTex = gl.createTexture()!;
	gl.bindTexture(gl.TEXTURE_2D, srcTex);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return {
		gl,
		program,
		vao,
		srcTex,
		u: {
			src: gl.getUniformLocation(program, 'u_src'),
			lut: gl.getUniformLocation(program, 'u_lut'),
			size: gl.getUniformLocation(program, 'u_size'),
			dmin: gl.getUniformLocation(program, 'u_dmin'),
			dmax: gl.getUniformLocation(program, 'u_dmax'),
			scale: gl.getUniformLocation(program, 'u_scale'),
		},
		luts: new Map(),
		maxLuts,
	};
}

/** Frees the per-context resources (the context itself belongs to its canvas). */
export function destroyColorGl(s: ColorGl): void {
	const { gl } = s;
	if (gl.isContextLost()) return;
	for (const t of s.luts.values()) gl.deleteTexture(t);
	s.luts.clear();
	gl.deleteTexture(s.srcTex);
	gl.deleteProgram(s.program);
	gl.deleteVertexArray(s.vao);
}

/** The 3D texture of a baked 3D LUT (cached per context by run key, LRU). */
export function lutTexture(s: ColorGl, key: string, lut: Lut): WebGLTexture {
	const hit = s.luts.get(key);
	if (hit) {
		s.luts.delete(key);
		s.luts.set(key, hit);
		return hit;
	}
	const { gl } = s;
	const tex = gl.createTexture()!;
	gl.bindTexture(gl.TEXTURE_3D, tex);
	gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
	const n = lut.size;
	gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, n, n, n, 0, gl.RGB, gl.FLOAT, lut.data);
	s.luts.set(key, tex);
	while (s.luts.size > s.maxLuts) {
		const [oldKey, old] = s.luts.entries().next().value!;
		s.luts.delete(oldKey);
		gl.deleteTexture(old);
	}
	return tex;
}

/**
 * Draws `source` into the context's canvas (`width`×`height`, the canvas' drawing-buffer size) through `lut`.
 * `flipY`: DOM-oriented sources (canvases, images) are flipped at upload so rows match `gl_FragCoord`.
 */
export function drawThroughLut(
	s: ColorGl,
	source: TexImageSource,
	sourceSize: { width: number; height: number },
	lut: Lut,
	key: string,
	width: number,
	height: number,
	flipY: boolean,
): void {
	const { gl } = s;
	if (lut.dimensions !== 3) throw new Error('colour stage: only 3D LUTs are drawn (runs are baked to 3D)');
	gl.viewport(0, 0, width, height);
	gl.disable(gl.BLEND);
	// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
	gl.useProgram(s.program);
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, s.srcTex);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
	// Straight RGB in the texture (for opaque sources this is exact); no colour-space conversion of images.
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
	gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
	gl.activeTexture(gl.TEXTURE1);
	gl.bindTexture(gl.TEXTURE_3D, lutTexture(s, key, lut));
	gl.uniform1i(s.u.src, 0);
	gl.uniform1i(s.u.lut, 1);
	gl.uniform1i(s.u.size, lut.size);
	gl.uniform3f(s.u.dmin, lut.domainMin[0], lut.domainMin[1], lut.domainMin[2]);
	gl.uniform3f(s.u.dmax, lut.domainMax[0], lut.domainMax[1], lut.domainMax[2]);
	gl.uniform2f(s.u.scale, sourceSize.width / width, sourceSize.height / height);
	gl.bindVertexArray(s.vao);
	gl.drawArrays(gl.TRIANGLES, 0, 3);
	gl.bindVertexArray(null);
	gl.activeTexture(gl.TEXTURE0);
}

/** Size of a CanvasImageSource (video frames, images, canvases, bitmaps). */
export function sourceSize(src: CanvasImageSource): { width: number; height: number } {
	if ('videoWidth' in src && src.videoWidth) return { width: src.videoWidth, height: src.videoHeight };
	if ('naturalWidth' in src && src.naturalWidth)
		return { width: src.naturalWidth, height: src.naturalHeight };
	if ('displayWidth' in src) return { width: src.displayWidth, height: src.displayHeight };
	return {
		width: typeof src.width === 'number' ? src.width : (src.width?.baseVal.value ?? 0),
		height: typeof src.height === 'number' ? src.height : (src.height?.baseVal.value ?? 0),
	};
}

let webgl2Support: boolean | null = null;
let webgl2Renderer: string | null = null;
/** True when this browser can create a WebGL2 context (cached; false outside the DOM). */
export function canUseWebGl2(): boolean {
	if (webgl2Support !== null) return webgl2Support;
	try {
		if (typeof document === 'undefined') return (webgl2Support = false);
		const c = document.createElement('canvas');
		const gl = c.getContext('webgl2');
		webgl2Support = !!gl;
		if (gl) {
			const dbg = gl.getExtension('WEBGL_debug_renderer_info');
			webgl2Renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
		}
		(gl?.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
	} catch {
		webgl2Support = false;
	}
	return webgl2Support;
}

/** The WebGL2 renderer string (e.g. "ANGLE (…SwiftShader…)"), or null. */
export function webGl2Renderer(): string | null {
	canUseWebGl2();
	return webgl2Renderer;
}

export type ColorStageBackend = 'webgl' | 'cpu';
/**
 * Backend of the colour passes (S06:CG-043): WebGL2 on a hardware GPU; the CPU pass (identical maths) when the
 * WebGL2 implementation is a software rasterizer, where it is 2–3× faster (see cpu.ts).
 */
export function colorStageBackend(): ColorStageBackend {
	try {
		const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('jasper:color-stage') : null;
		if (ls === 'webgl' || ls === 'cpu') return ls;
	} catch {
		// no storage (render pages, workers)
	}
	const r = webGl2Renderer() ?? '';
	return /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(r) ? 'cpu' : 'webgl';
}
