// The GPU host of the fx framework (wave 1; docs/wp-notes/fx-shader-framework.md): ONE WebGL2 context per page runs
// every shader effect (and the colour LUT passes of layers that have shader effects). The effects are Remotion
// canvas effects of the `2d` backend (fx/effects.ts): each `apply` uploads its input to this context, runs the
// planned passes (FBOs for the named intermediates, the last pass into the default framebuffer) and copies the
// result into the chain's 2D target with `drawImage`. Sharing one context — instead of a context per pool canvas
// per layer — keeps a timeline with many effect layers under Chrome's context limit and compiles every program once
// per page (cache by source). Orientation: uploads are top-row first (no UNPACK_FLIP_Y) so `v_uv` (0,0) is the
// picture's top-left in every texture; only the final pass flips into the bottom-up default framebuffer.
// Alpha: inputs are uploaded premultiplied, intermediates and output are premultiplied (the canvas contract).
import {
	FX_DATA_ROW,
	type FxEffectPlan,
	type FxPassPlan,
	type FxUniform,
	flattenLut,
	type Lut,
} from '@jasper/project';
import { type ColorGl, createColorGl, drawThroughLut, sourceSize } from '../color/gl.ts';
import { fxStatus } from './status.ts';

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
uniform float u_flipY;
out vec2 v_uv;
void main() {
  vec2 uv = a_pos * 0.5 + 0.5;
  v_uv = vec2(uv.x, mix(uv.y, 1.0 - uv.y, u_flipY));
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const SAMPLER_2D = 0x8b5e;
const SAMPLER_3D = 0x8b5f;
const SAMPLER_2D_ARRAY = 0x8dc1;

/** A shader that failed to compile or link: effect id, pass and the driver log mapped to the author's lines. */
export class FxShaderError extends Error {
	constructor(
		readonly effectId: string,
		readonly pass: number,
		readonly log: string,
	) {
		super(`FX_SHADER_ERROR: ${effectId} pass ${pass}: ${log}`);
	}
}

type Program = {
	program: WebGLProgram;
	locs: Map<string, WebGLUniformLocation | null>;
	samplers: { name: string; type: number }[];
};

type Target = {
	tex: WebGLTexture;
	fbo: WebGLFramebuffer;
	width: number;
	height: number;
	format: 'rgba8' | 'rgba16f' | 'rgba32f';
};

export type FxHost = {
	gl: WebGL2RenderingContext;
	canvas: HTMLCanvasElement;
	lost: boolean;
	vao: WebGLVertexArrayObject;
	vs: WebGLShader;
	programs: Map<string, Program | FxShaderError>;
	targets: Map<string, Target>;
	srcTex: WebGLTexture;
	dummy2d: WebGLTexture;
	dummyArray: WebGLTexture;
	dummy3d: WebGLTexture;
	samplesTex: WebGLTexture;
	samplesSize: string;
	/** Identity of the pictures last uploaded into `samplesTex` (`FxRunInputs.samples.key`). */
	samplesKey: string | null;
	media: WeakMap<object, { tex: WebGLTexture; version: string }>;
	/** 3D LUT textures of `lut` media params, by LUT object. */
	luts: WeakMap<Lut, { tex: WebGLTexture; size: number }>;
	floatTargets: boolean;
	floatBlend: boolean;
	color: ColorGl | null;
	/** sim-warp: an empty vertex array for draw passes (their vertex shaders read data textures). */
	emptyVao: WebGLVertexArrayObject;
	/** sim-warp: data textures (`texels` uniforms) by key (LRU), so identical data is uploaded once. */
	data: Map<string, { tex: WebGLTexture; w: number; h: number }>;
};

let host: FxHost | null | undefined;

export function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | string {
	const sh = gl.createShader(type);
	if (!sh) return 'cannot create a shader';
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
		const log = gl.getShaderInfoLog(sh) ?? 'compile error';
		gl.deleteShader(sh);
		return log;
	}
	return sh;
}

export function texture2d(gl: WebGL2RenderingContext, filter: number): WebGLTexture {
	const t = gl.createTexture()!;
	gl.bindTexture(gl.TEXTURE_2D, t);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return t;
}

function createResources(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement): FxHost {
	const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
	if (typeof vs === 'string') throw new Error(`WEBGL_UNAVAILABLE: fx vertex shader: ${vs}`);
	const vao = gl.createVertexArray()!;
	gl.bindVertexArray(vao);
	const buf = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buf);
	// One oversized triangle covering the viewport.
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
	gl.bindVertexArray(null);
	const dummy2d = texture2d(gl, gl.NEAREST);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
	const dummyArray = gl.createTexture()!;
	gl.bindTexture(gl.TEXTURE_2D_ARRAY, dummyArray);
	gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
	const dummy3d = gl.createTexture()!;
	gl.bindTexture(gl.TEXTURE_3D, dummy3d);
	gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
	const samplesTex = gl.createTexture()!;
	gl.bindTexture(gl.TEXTURE_2D_ARRAY, samplesTex);
	for (const [k, v] of [
		[gl.TEXTURE_MIN_FILTER, gl.LINEAR],
		[gl.TEXTURE_MAG_FILTER, gl.LINEAR],
		[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
		[gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
	] as const)
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, k, v);
	return {
		gl,
		canvas,
		lost: false,
		vao,
		vs,
		programs: new Map(),
		targets: new Map(),
		srcTex: texture2d(gl, gl.LINEAR),
		dummy2d,
		dummyArray,
		dummy3d,
		samplesTex,
		samplesSize: '',
		samplesKey: null,
		media: new WeakMap(),
		luts: new WeakMap(),
		floatTargets: !!gl.getExtension('EXT_color_buffer_float'),
		// sim-warp: additive draws into float targets (rgba32f needs it; rgba16f blends without).
		floatBlend: !!gl.getExtension('EXT_float_blend'),
		color: null,
		emptyVao: gl.createVertexArray()!,
		data: new Map(),
	};
}

/**
 * The page's fx GPU host, created on first use; null when this browser has no WebGL2 (or outside the DOM). A lost
 * context keeps the host (`lost: true`) until the browser restores it; the status store tells the layers.
 */
export function fxHost(): FxHost | null {
	if (host !== undefined) return host;
	if (typeof document === 'undefined') return (host = null);
	const canvas = document.createElement('canvas');
	canvas.width = 256;
	canvas.height = 256;
	const gl = canvas.getContext('webgl2', {
		alpha: true,
		premultipliedAlpha: true,
		preserveDrawingBuffer: true,
		antialias: false,
		depth: false,
		stencil: false,
	});
	if (!gl) return (host = null);
	const h = createResources(gl, canvas);
	canvas.addEventListener('webglcontextlost', (e) => {
		e.preventDefault();
		if (!host || host.lost) return;
		host.lost = true;
		fxStatus.contextLost();
	});
	canvas.addEventListener('webglcontextrestored', () => {
		if (!host) return;
		host = createResources(gl, canvas);
		fxStatus.contextRestored();
	});
	host = h;
	return host;
}

function program(h: FxHost, effectId: string, pass: FxPassPlan): Program {
	const cacheKey = pass.vertex ? `${pass.source}\n//--vertex--\n${pass.vertex.source}` : pass.source;
	const hit = h.programs.get(cacheKey);
	if (hit instanceof FxShaderError) throw hit;
	if (hit) return hit;
	const { gl } = h;
	const fail = (log: string, source = pass.source) => {
		const err = new FxShaderError(effectId, pass.index, mapLog(log, source));
		h.programs.set(cacheKey, err);
		throw err;
	};
	const fs = compileShader(gl, gl.FRAGMENT_SHADER, pass.source);
	if (typeof fs === 'string') return fail(fs);
	// sim-warp: draw passes bring their own vertex shader.
	let vs: WebGLShader = h.vs;
	if (pass.vertex) {
		const v = compileShader(gl, gl.VERTEX_SHADER, pass.vertex.source);
		if (typeof v === 'string') {
			gl.deleteShader(fs);
			return fail(`vertex shader: ${v}`, pass.vertex.source);
		}
		vs = v;
	}
	const p = gl.createProgram()!;
	gl.attachShader(p, vs);
	gl.attachShader(p, fs);
	if (!pass.vertex) gl.bindAttribLocation(p, 0, 'a_pos');
	gl.linkProgram(p);
	gl.deleteShader(fs);
	if (pass.vertex) gl.deleteShader(vs);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost())
		return fail(gl.getProgramInfoLog(p) ?? 'link error');
	const samplers: Program['samplers'] = [];
	const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
	for (let i = 0; i < n; i++) {
		const info = gl.getActiveUniform(p, i);
		if (info && (info.type === SAMPLER_2D || info.type === SAMPLER_2D_ARRAY || info.type === SAMPLER_3D))
			samplers.push({ name: info.name, type: info.type });
	}
	const prog: Program = { program: p, locs: new Map(), samplers };
	h.programs.set(cacheKey, prog);
	// Bounded cache: programs are small, but generated passes (pyramids by radius) can multiply.
	if (h.programs.size > 512) {
		const oldest = h.programs.keys().next().value!;
		const o = h.programs.get(oldest);
		if (o && !(o instanceof FxShaderError)) gl.deleteProgram(o.program);
		h.programs.delete(oldest);
	}
	return prog;
}

/** Driver log with the offending source lines quoted (line numbers of the full pass source). */
function mapLog(log: string, source: string): string {
	const lines = source.split('\n');
	const quoted = new Set<number>();
	for (const m of log.matchAll(/ERROR:\s*\d+:(\d+)/g)) quoted.add(Number(m[1]));
	const ctx = [...quoted]
		.slice(0, 3)
		.map((l) => `  ${l}: ${lines[l - 1]?.trim() ?? ''}`)
		.join('\n');
	return ctx ? `${log.trim()}\n${ctx}` : log.trim();
}

function loc(h: FxHost, p: Program, name: string): WebGLUniformLocation | null {
	if (p.locs.has(name)) return p.locs.get(name)!;
	const l = h.gl.getUniformLocation(p.program, name);
	p.locs.set(name, l);
	return l;
}

function setUniform(h: FxHost, p: Program, u: FxUniform): void {
	const l = loc(h, p, u.name);
	if (!l) return;
	const { gl } = h;
	const v = u.value as number[];
	switch (u.type) {
		case 'float':
			gl.uniform1f(l, v[0]!);
			break;
		case 'int':
		case 'bool':
			gl.uniform1i(l, v[0]!);
			break;
		case 'vec2':
			gl.uniform2f(l, v[0]!, v[1]!);
			break;
		case 'vec3':
			gl.uniform3f(l, v[0]!, v[1]!, v[2]!);
			break;
		case 'vec4':
			gl.uniform4f(l, v[0]!, v[1]!, v[2]!, v[3]!);
			break;
		case 'mat3':
			gl.uniformMatrix3fv(l, false, v);
			break;
		case 'float[]':
			gl.uniform1fv(l, v);
			break;
		case 'ivec2':
			gl.uniform2i(l, v[0]!, v[1]!);
			break;
		case 'ivec3':
			gl.uniform3i(l, v[0]!, v[1]!, v[2]!);
			break;
		case 'ivec4':
			gl.uniform4i(l, v[0]!, v[1]!, v[2]!, v[3]!);
			break;
		case 'vec4[]':
			gl.uniform4fv(l, v);
			break;
		case 'texels':
			// A sampler: bound with the other textures (dataTexture).
			break;
	}
}

/** Most data textures kept (LRU by key). */
const MAX_DATA_TEXTURES = 32;

/**
 * sim-warp: the RGBA32F texture of a `texels` uniform (FX_DATA_ROW texels per row), uploaded once per key. Nearest
 * filtering (read with texelFetch).
 */
function dataTexture(h: FxHost, u: FxUniform): WebGLTexture {
	const key = `${u.key ?? ''}|${u.data?.length ?? 0}`;
	const hit = h.data.get(key);
	if (hit) {
		h.data.delete(key);
		h.data.set(key, hit);
		return hit.tex;
	}
	const { gl } = h;
	while (h.data.size >= MAX_DATA_TEXTURES) {
		const [k, old] = h.data.entries().next().value!;
		h.data.delete(k);
		gl.deleteTexture(old.tex);
	}
	const src = u.data ?? new Float32Array(4);
	const n = Math.max(1, Math.ceil(src.length / 4));
	const w = Math.min(n, FX_DATA_ROW);
	const hh = Math.ceil(n / FX_DATA_ROW);
	const full = new Float32Array(w * hh * 4);
	full.set(src.subarray(0, Math.min(src.length, full.length)));
	const tex = texture2d(gl, gl.NEAREST);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, hh, 0, gl.RGBA, gl.FLOAT, full);
	h.data.set(key, { tex, w, h: hh });
	return tex;
}

/** sim-warp: blending of a draw pass (premultiplied colours). */
function setDrawBlend(gl: WebGL2RenderingContext, blend: NonNullable<FxPassPlan['vertex']>['blend']): void {
	if (blend === 'replace') {
		gl.disable(gl.BLEND);
		return;
	}
	gl.enable(gl.BLEND);
	if (blend === 'add') {
		gl.blendEquation(gl.FUNC_ADD);
		gl.blendFunc(gl.ONE, gl.ONE);
	} else if (blend === 'max' || blend === 'min') {
		gl.blendEquation(blend === 'max' ? gl.MAX : gl.MIN);
		gl.blendFunc(gl.ONE, gl.ONE);
	} else {
		gl.blendEquation(gl.FUNC_ADD);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	}
}

/** Most intermediate textures kept for reuse across frames and layers (LRU). */
const MAX_TARGETS = 48;

/**
 * The FBO texture of pass `index` (or of its ping-pong slot, `pass.target`) at its size and format. Keyed by all
 * three, so layers of different sizes do not reallocate each other's intermediates every frame; within one plan
 * every live output has its own texture (no aliasing; an `update` pass writes the other texture of its pair).
 */
function target(h: FxHost, pass: FxPassPlan): Target {
	const { gl } = h;
	const format =
		(pass.format === 'rgba16f' || pass.format === 'rgba32f') && h.floatTargets ? pass.format : 'rgba8';
	const key = `${pass.target ?? pass.index}:${pass.width}x${pass.height}:${format}`;
	const hit = h.targets.get(key);
	if (hit) {
		h.targets.delete(key);
		h.targets.set(key, hit);
		const f = pass.filter === 'nearest' || format === 'rgba32f' ? gl.NEAREST : gl.LINEAR;
		gl.bindTexture(gl.TEXTURE_2D, hit.tex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
		return hit;
	}
	while (h.targets.size >= MAX_TARGETS) {
		const [oldKey, old] = h.targets.entries().next().value!;
		h.targets.delete(oldKey);
		gl.deleteTexture(old.tex);
		gl.deleteFramebuffer(old.fbo);
	}
	const tex = texture2d(gl, pass.filter === 'nearest' || format === 'rgba32f' ? gl.NEAREST : gl.LINEAR);
	if (format === 'rgba32f')
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, pass.width, pass.height, 0, gl.RGBA, gl.FLOAT, null);
	else if (format === 'rgba16f')
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, pass.width, pass.height, 0, gl.RGBA, gl.HALF_FLOAT, null);
	else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, pass.width, pass.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
	const fbo = gl.createFramebuffer()!;
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
	const t: Target = { tex, fbo, width: pass.width, height: pass.height, format };
	h.targets.set(key, t);
	return t;
}

/** Grows the shared canvas (never shrinks; 256-px steps) so a `w`×`h` result fits its bottom-left corner. */
export function ensureCanvas(h: FxHost, w: number, h2: number): void {
	const c = h.canvas;
	const W = Math.max(c.width, Math.ceil(w / 256) * 256);
	const H = Math.max(c.height, Math.ceil(h2 / 256) * 256);
	if (W !== c.width) c.width = W;
	if (H !== c.height) c.height = H;
}

export function upload(h: FxHost, tex: WebGLTexture, source: TexImageSource): void {
	const { gl } = h;
	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
	gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

/** A media param's picture: uploaded once per (source object, version). */
function mediaTexture(h: FxHost, source: TexImageSource, version: string): WebGLTexture {
	const key = source;
	const hit = h.media.get(key);
	if (hit && hit.version === version) return hit.tex;
	const tex = hit?.tex ?? texture2d(h.gl, h.gl.LINEAR);
	upload(h, tex, source);
	h.media.set(key, { tex, version });
	return tex;
}

/** A media param's picture (2D) or, for `lut` params, the LUT (bound as a 3D texture). */
export type FxTextureInput =
	| { source: TexImageSource; width: number; height: number; version: string }
	| { lut: Lut; version: string };

export type FxRunInputs = {
	/** Built-in uniforms of this layer and frame (u_canvasSize, u_box, u_frame…; not u_resolution/u_texel). */
	builtins: readonly FxUniform[];
	/** Media textures by sampler name (`u_<param>`): the picture and a version that changes when it changes. */
	textures: Readonly<Record<string, FxTextureInput | null>>;
	/**
	 * Time samples (canvas-sized pictures in the canvas layout) and their frame offsets. `key`: identity of the
	 * pictures (e.g. the frames and slot versions) — the host uploads them once and skips identical re-uploads
	 * (several effects or passes of one layer and frame); without it they are uploaded once per effect.
	 * `valid`: `u_sampleValid` (bit i = sample i shows its own frame; default: all).
	 */
	samples: { sources: readonly TexImageSource[]; offsets: readonly number[]; key?: string; valid?: number };
};

/**
 * 3D texture of a LUT: N³ RGB (half float; `fx_lut3d` reads it with `texelFetch`, tetrahedral). 1D LUTs, shapers and
 * custom domains are baked to 33³ first (`flattenLut`).
 */
function lutTexture(h: FxHost, lut: Lut): { tex: WebGLTexture; size: number } {
	const hit = h.luts.get(lut);
	if (hit) return hit;
	const { gl } = h;
	const l3 = flattenLut(lut, 33);
	const tex = gl.createTexture()!;
	gl.bindTexture(gl.TEXTURE_3D, tex);
	for (const [k, v] of [
		[gl.TEXTURE_MIN_FILTER, gl.LINEAR],
		[gl.TEXTURE_MAG_FILTER, gl.LINEAR],
		[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
		[gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
		[gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE],
	] as const)
		gl.texParameteri(gl.TEXTURE_3D, k, v);
	// Typed-array uploads of 3D textures must not flip/premultiply (INVALID_OPERATION otherwise).
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
	gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, l3.size, l3.size, l3.size, 0, gl.RGB, gl.FLOAT, l3.data);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
	const out = { tex, size: l3.size };
	h.luts.set(lut, out);
	return out;
}

function uploadSamples(h: FxHost, s: FxRunInputs['samples'], w: number, hgt: number): void {
	const { gl } = h;
	gl.bindTexture(gl.TEXTURE_2D_ARRAY, h.samplesTex);
	const size = `${w}x${hgt}x${s.sources.length}`;
	if (h.samplesSize !== size) {
		gl.texImage3D(
			gl.TEXTURE_2D_ARRAY,
			0,
			gl.RGBA8,
			w,
			hgt,
			s.sources.length,
			0,
			gl.RGBA,
			gl.UNSIGNED_BYTE,
			null,
		);
		h.samplesSize = size;
	}
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
	s.sources.forEach((src, i) => {
		gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, w, hgt, 1, gl.RGBA, gl.UNSIGNED_BYTE, src);
	});
}

/** Uploads the time samples of a plan once (skipped when `key` matches the last upload of the same size). */
function prepareSamples(h: FxHost, s: FxRunInputs['samples'], w: number, hgt: number): number {
	if (s.sources.length === 0) return 0;
	const id = s.key !== undefined ? `${s.key}|${w}x${hgt}x${s.sources.length}` : null;
	if (id === null || id !== h.samplesKey) {
		uploadSamples(h, s, w, hgt);
		h.samplesKey = id;
	}
	return s.sources.length;
}

const setMinFilter = (gl: WebGL2RenderingContext, tex: WebGLTexture, mip: boolean, nearest = false) => {
	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.texParameteri(
		gl.TEXTURE_2D,
		gl.TEXTURE_MIN_FILTER,
		mip ? gl.LINEAR_MIPMAP_LINEAR : nearest ? gl.NEAREST : gl.LINEAR,
	);
};

/**
 * Runs one planned effect instance on `input` (canvas-sized picture) and writes the result into `out` (a 2D context
 * of the same size). Throws `FxShaderError` for programs that do not compile (cached: it throws again without
 * recompiling) and `WEBGL_UNAVAILABLE` errors for a lost context.
 */
export function runShaderPlan(
	h: FxHost,
	plan: FxEffectPlan,
	input: TexImageSource,
	inputs: FxRunInputs,
	out: CanvasRenderingContext2D,
): void {
	const { gl } = h;
	if (h.lost || gl.isContextLost()) throw new Error('WEBGL_UNAVAILABLE: the fx GPU context is lost');
	// TL-123: never the silent 8-bit fallback of `target()` for an effect that declared it needs float targets.
	if (plan.requiresFloat && !h.floatTargets)
		throw new Error(
			`${plan.requiresFloat}: effect ${plan.effectId} needs float render targets (EXT_color_buffer_float)`,
		);
	const W = plan.canvas.width;
	const H = plan.canvas.height;
	ensureCanvas(h, W, H);
	gl.disable(gl.BLEND);
	gl.disable(gl.DEPTH_TEST);
	gl.disable(gl.SCISSOR_TEST);
	upload(h, h.srcTex, input);
	if (plan.sourceMipmaps) gl.generateMipmap(gl.TEXTURE_2D);
	setMinFilter(gl, h.srcTex, !!plan.sourceMipmaps);
	// Time samples: uploaded at most once per plan (and not at all when the same pictures are already there).
	const sampleCount = prepareSamples(h, inputs.samples, W, H);
	const sampleOffsets = new Float32Array(8);
	inputs.samples.offsets.slice(0, 8).forEach((o, i) => {
		sampleOffsets[i] = o;
	});
	const sampleValid = sampleCount === 0 ? 0 : (inputs.samples.valid ?? (1 << sampleCount) - 1);
	const outputs = new Map<string, WebGLTexture>();
	let prev: WebGLTexture = h.srcTex;
	for (const pass of plan.passes) {
		const prog = program(h, plan.effectId, pass);
		const last = pass.output === null;
		let t: Target | null = null;
		if (last) {
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, W, H);
		} else {
			t = target(h, pass);
			gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
			gl.viewport(0, 0, t.width, t.height);
		}
		// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
		gl.useProgram(prog.program);
		const pw = last ? W : t!.width;
		const ph = last ? H : t!.height;
		const fl = loc(h, prog, 'u_flipY');
		if (fl) gl.uniform1f(fl, last ? 1 : 0);
		const res = loc(h, prog, 'u_resolution');
		if (res) gl.uniform2f(res, pw, ph);
		const tx = loc(h, prog, 'u_texel');
		if (tx) gl.uniform2f(tx, 1 / pw, 1 / ph);
		for (const u of inputs.builtins) setUniform(h, prog, u);
		for (const u of plan.uniforms) setUniform(h, prog, u);
		for (const u of pass.uniforms) setUniform(h, prog, u);
		// Sample count/offsets/validity and media sizes in EVERY pass (also passes that do not sample the textures).
		const cnt = loc(h, prog, 'u_sampleCount');
		if (cnt) gl.uniform1i(cnt, sampleCount);
		const offs = loc(h, prog, 'u_sampleOffsets');
		if (offs) gl.uniform1fv(offs, sampleOffsets);
		const valid = loc(h, prog, 'u_sampleValid');
		if (valid) gl.uniform1i(valid, sampleValid);
		const media3d = new Map<string, WebGLTexture>();
		for (const [name, m] of Object.entries(inputs.textures)) {
			const size = loc(h, prog, `${name}_size`);
			if (m && 'lut' in m) {
				const t = lutTexture(h, m.lut);
				media3d.set(name, t.tex);
				if (size) gl.uniform2f(size, t.size, 1);
			} else if (size) gl.uniform2f(size, m ? m.width : 0, m ? m.height : 0);
		}
		// sim-warp: data textures of this pass (plan-wide and pass uniforms).
		const dataTex = new Map<string, WebGLTexture>();
		for (const u of plan.uniforms) if (u.type === 'texels') dataTex.set(u.name, dataTexture(h, u));
		for (const u of pass.uniforms) if (u.type === 'texels') dataTex.set(u.name, dataTexture(h, u));
		let unit = 0;
		for (const s of prog.samplers) {
			const l = loc(h, prog, s.name);
			gl.activeTexture(gl.TEXTURE0 + unit);
			if (s.type === SAMPLER_2D_ARRAY) {
				gl.bindTexture(gl.TEXTURE_2D_ARRAY, sampleCount > 0 ? h.samplesTex : h.dummyArray);
			} else if (s.type === SAMPLER_3D) {
				gl.bindTexture(gl.TEXTURE_3D, media3d.get(s.name) ?? h.dummy3d);
			} else {
				let tex: WebGLTexture = h.dummy2d;
				if (dataTex.has(s.name)) tex = dataTex.get(s.name)!;
				else if (s.name === 'u_source') tex = h.srcTex;
				else if (s.name === 'u_prev') tex = prev;
				else if (outputs.has(s.name)) tex = outputs.get(s.name)!;
				else if (s.name in inputs.textures) {
					const m = inputs.textures[s.name];
					if (m && !('lut' in m)) tex = mediaTexture(h, m.source, m.version);
				}
				gl.bindTexture(gl.TEXTURE_2D, tex);
			}
			if (l) gl.uniform1i(l, unit);
			unit++;
		}
		if (pass.vertex) {
			// sim-warp: instanced geometry over a transparent target.
			gl.clearColor(0, 0, 0, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
			const n = pass.vertex.vertices * pass.vertex.instances;
			if (n > 0) {
				setDrawBlend(gl, pass.vertex.blend);
				gl.bindVertexArray(h.emptyVao);
				gl.drawArraysInstanced(gl.TRIANGLES, 0, pass.vertex.vertices, pass.vertex.instances);
				gl.bindVertexArray(null);
				gl.disable(gl.BLEND);
				gl.blendEquation(gl.FUNC_ADD);
			}
		} else {
			gl.bindVertexArray(h.vao);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
			gl.bindVertexArray(null);
		}
		// Unbind this pass's own output before the next pass may sample it (no feedback loop).
		if (t) {
			if (pass.mipmaps) {
				gl.bindTexture(gl.TEXTURE_2D, t.tex);
				gl.generateMipmap(gl.TEXTURE_2D);
				setMinFilter(gl, t.tex, true);
			}
			outputs.set(`u_${pass.output}`, t.tex);
			prev = t.tex;
		}
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.activeTexture(gl.TEXTURE0);
	if (gl.isContextLost()) throw new Error('WEBGL_UNAVAILABLE: the fx GPU context was lost while drawing');
	blit(h, out, W, H);
}

/** Copies the bottom-left `w`×`h` of the shared canvas (the last draw) into a 2D context. */
export function blit(h: FxHost, out: CanvasRenderingContext2D, w: number, hgt: number): void {
	const prevOp = out.globalCompositeOperation;
	out.globalCompositeOperation = 'copy';
	out.drawImage(h.canvas, 0, h.canvas.height - hgt, w, hgt, 0, 0, w, hgt);
	out.globalCompositeOperation = prevOp;
}

/**
 * A colour run (baked 3D LUT, S06) on the shared context with the colour stage's own shader (`drawThroughLut`:
 * tetrahedral `texelFetch`, the same maths as `applyLut` and FFmpeg `lut3d`), written into `out`.
 */
export function runLutPass(
	h: FxHost,
	lut: Lut,
	key: string,
	input: TexImageSource,
	out: CanvasRenderingContext2D,
	width: number,
	height: number,
): void {
	const { gl } = h;
	if (h.lost || gl.isContextLost()) throw new Error('WEBGL_UNAVAILABLE: the fx GPU context is lost');
	ensureCanvas(h, width, height);
	h.color ??= createColorGl(gl);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	const size = sourceSize(input as CanvasImageSource);
	drawThroughLut(
		h.color,
		input,
		size.width && size.height ? size : { width, height },
		lut,
		key,
		width,
		height,
		true,
	);
	blit(h, out, width, height);
}
