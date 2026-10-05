// GPU shader effects (wave-1 fx framework; S03 §15.1 `preview.webgl`, S03:FX-001 "WebGL wrappers", FX-041 effect
// bounds; the GL colour stage of ARCHITECTURE §19.2 is the rendering precedent). `EffectSpec.gpu` describes one or
// more GLSL ES 3.00 fragment passes. This module is pure (no DOM, no GL): it maps params to uniforms, plans the
// passes of one effect instance (sizes, named intermediates, complete program sources), resolves padding, seeds
// and the time hooks, and validates specs. The compositions' GL host (`packages/compositions/src/fx/`) compiles and
// runs the plans inside Remotion's canvas effect chain, in the Player and in renders alike.
// Authoring guide (normative for effect authors): docs/wp-notes/fx-shader-framework.md.
import type { EffectParams, EffectSpec, ParamSpec } from '../effects.ts';

// ---------------------------------------------------------------- types

/** A reusable piece of GLSL (functions/constants) prepended once per program, after its `deps`. */
export type GlslChunk = {
	readonly name: string;
	readonly source: string;
	readonly deps?: readonly GlslChunk[];
};

/**
 * Values of custom uniforms (`GpuEffect.uniforms`, `ShaderPass.uniforms`); the GLSL type is derived from the value:
 * number → `float`, boolean → `bool`, 2/3/4 numbers → `vec2/3/4`, `{int}` → `int`, `{floats}` → `float[n]`,
 * `{mat3}` → `mat3` (9 numbers, column-major as in GLSL).
 */
export type FxUniformValue =
	| number
	| boolean
	| readonly [number, number]
	| readonly [number, number, number]
	| readonly [number, number, number, number]
	| { readonly int: number }
	| { readonly floats: readonly number[] }
	| { readonly mat3: readonly number[] };

export type FxUniformType = 'float' | 'int' | 'bool' | 'vec2' | 'vec3' | 'vec4' | 'mat3' | 'float[]';
/** A uniform as the GL host sets it: flattened numbers (`bool` = 0/1, `float[]` = `length` floats). */
export type FxUniform = { name: string; type: FxUniformType; value: readonly number[] };

/** Extra pixels an effect draws around the layer box, per side, in layer pixels (S03:FX-041). */
export type FxPadding = { left: number; top: number; right: number; bottom: number };

/** What pass planning and padding know: the layer box and the canvas resolution. */
export type FxPlanContext = {
	/** Layer box (the clip's intrinsic size) in layer pixels. */
	width: number;
	height: number;
	/** Canvas pixels per layer pixel (1 = full resolution; < 1 when a huge layer is drawn downscaled). */
	pxScale: number;
	fps: number;
};

/** Per-frame context of `GpuEffect.uniforms` (also the values behind the built-in uniforms). */
export type FxFrameContext = FxPlanContext & {
	/** Clip-local frame (real time, not remapped; negative inside a transition head handle). */
	frame: number;
	/** Clip duration in frames. */
	duration: number;
	/** `u_seed`: deterministic 0..1 per clip + effect instance (+ the `seed` param), see `fxSeed`. */
	seed: number;
	/** `u_progress`: transition progress when a transition drives the layer, else the clip progress (0..1). */
	progress: number;
};

/** Context of the time hooks (time effects: freeze, retime, trails, echo…). */
export type FxTimeContext = {
	/** Clip-local frame being drawn (real time). */
	frame: number;
	fps: number;
	duration: number;
	/** Frames of content before the clip's in-point / after its out-point that may be shown (transitions). */
	headHandle: number;
	tailHandle: number;
	/** Same value as `u_seed` (use `fxRandom(seed, n)` for deterministic per-frame randomness). */
	seed: number;
};

export type ShaderPass = {
	/**
	 * Name of this pass's output texture, readable by later passes as `uniform sampler2D u_<output>` (declared by the
	 * framework). Letters and digits, starting with a letter; unique within the effect. Ignored on the last pass,
	 * whose output is the effect's result.
	 */
	output?: string;
	/**
	 * GLSL ES 3.00 fragment code: helper functions and `void main()`, which writes `fragColor` (premultiplied RGBA).
	 * Do not write `#version`, `precision`, `in`/`out` or built-in/param uniform declarations — the framework
	 * prepends them (see `FX_BUILTIN_UNIFORMS` and the prelude). Use `v_uv` (0..1, (0,0) = top-left), not
	 * `gl_FragCoord`.
	 */
	frag: string;
	/** GLSL library chunks (`registry/fx/glsl`) this pass uses; deduplicated, dependencies first. */
	include?: readonly GlslChunk[];
	/** Output resolution relative to the effect canvas, (0, 1]: 0.5 = half size (blur pyramids). Last pass: 1. */
	scale?: number;
	/** Output format: `rgba16f` for HDR intermediates (glows, bloom); falls back to `rgba8` without float FBOs. */
	format?: 'rgba8' | 'rgba16f';
	/** How later passes sample this output (default `linear`). */
	filter?: 'linear' | 'nearest';
	/** Uniforms of this pass only (e.g. a blur direction), declared by the framework from their values. */
	uniforms?: Readonly<Record<string, FxUniformValue>>;
};

/**
 * The GPU realization of an effect (`EffectSpec.gpu`). The effect sees its input (`u_source`: the layer picture after
 * the effects above it, premultiplied, on a canvas grown by every effect's padding) and its last pass replaces it.
 */
export type GpuEffect = {
	/** The passes, in order; a function when their number or settings depend on params (bloom pyramids). */
	passes: readonly ShaderPass[] | ((p: EffectParams, ctx: FxPlanContext) => readonly ShaderPass[]);
	/**
	 * `filter` (default) transforms its input; `generator` draws its own picture (gradients, noise, clouds,
	 * lightning) and uses `u_source` only to composite over it (or ignores it). Metadata for panels, docs, checks.
	 */
	kind?: 'filter' | 'generator';
	/** Pixels the effect may draw outside its input's bounds (glow, shadow, rays): a number = every side. */
	padding?(p: EffectParams, ctx: FxPlanContext): number | Partial<FxPadding>;
	/** Derived uniforms of every pass (e.g. a direction vector from an angle), declared from their values. */
	uniforms?(p: EffectParams, ctx: FxFrameContext): Readonly<Record<string, FxUniformValue>>;
	/** Source-time hooks (time effects). Deterministic functions of params and the frame: no state, no clocks. */
	time?: {
		/**
		 * Clip-local SOURCE frame shown at `ctx.frame` (freeze, retime, reverse, jitter). The layer's source picture
		 * (before any effect) is taken at that frame; Motion, opacity and effect params stay at the real time.
		 * Rounded down and clamped to the clip's drawn span. Several remapping effects compose in stack order.
		 */
		remap?(p: EffectParams, ctx: FxTimeContext): number;
		/**
		 * Extra source pictures at frame offsets relative to the (remapped) source frame, e.g. `[-1, -2, -3]` for
		 * trails. At most `FX_MAX_TIME_SAMPLES`; read with `u_samples` / `fx_sample(i, uv)`.
		 */
		samples?(p: EffectParams, ctx: FxTimeContext): readonly number[];
	};
	/**
	 * True when the output depends only on the params and the input picture (no `u_frame`/`u_time`/`u_progress`,
	 * no time hooks): a still layer then is not redrawn on every frame. Default false (redraw every frame).
	 */
	timeInvariant?: boolean;
};

/** One pass of a planned effect instance, ready for the GL host. */
export type FxPassPlan = {
	index: number;
	/** Output texture name, or null for the final pass (draws the effect result at the canvas size). */
	output: string | null;
	width: number;
	height: number;
	format: 'rgba8' | 'rgba16f';
	filter: 'linear' | 'nearest';
	/** Complete fragment shader (prelude, declarations, includes, body). Programs are cached by this string. */
	source: string;
	/** Pass-level uniforms. */
	uniforms: FxUniform[];
};

/** A planned effect instance: what the GL host runs for one effect at one frame. */
export type FxEffectPlan = {
	fxId: string;
	effectId: string;
	canvas: { width: number; height: number };
	passes: FxPassPlan[];
	/** Param uniforms + `GpuEffect.uniforms`, for every pass. */
	uniforms: FxUniform[];
	/** `media` params bound as textures: `uniform sampler2D u_<param>` + `uniform vec2 u_<param>_size`. */
	textures: { param: string; uniform: string; mediaId: string }[];
	/** Identity of programs and sizes (not of uniform values): changes force no re-plan, only a re-key. */
	key: string;
};

// ---------------------------------------------------------------- constants

/** Maximum extra source pictures per layer (time samples). */
export const FX_MAX_TIME_SAMPLES = 8;
/** Largest effect canvas side in pixels; bigger layers are drawn downscaled (`pxScale` < 1). */
export const FX_MAX_CANVAS = 8192;
/** Largest padding per side in layer pixels. */
export const FX_MAX_PADDING = 2048;
/** Named pass outputs + media textures per effect (WebGL2 guarantees 16 texture units; 4 are the framework's). */
export const FX_MAX_TEXTURES = 12;

/** Built-in uniforms every pass can use (declared by the prelude). Normative list, see the authoring guide. */
export const FX_BUILTIN_UNIFORMS = {
	u_source: 'sampler2D — the effect input (premultiplied RGBA, canvas size, linear filtering, clamp to edge)',
	u_prev: 'sampler2D — the previous pass output (pass 0: u_source)',
	u_resolution: 'vec2 — size of the current pass output in pixels',
	u_texel: 'vec2 — 1 / u_resolution',
	u_canvasSize: 'vec2 — effect canvas size in pixels (layer box + padding, full resolution)',
	u_box: 'vec4 — the layer box inside the canvas: x, y, width, height in canvas pixels (y down)',
	u_pxScale: 'float — canvas pixels per layer pixel (multiply px params by it)',
	u_frame: 'float — clip-local frame (real time)',
	u_time: 'float — clip-local time in seconds (u_frame / u_fps)',
	u_fps: 'float — sequence frame rate',
	u_duration: 'float — clip duration in frames',
	u_clipProgress: 'float — u_frame / (u_duration - 1), clamped to 0..1',
	u_progress: 'float — transition progress (0..1) when a transition drives the layer, else u_clipProgress',
	u_side: 'int — 0 = no transition, 1 = outgoing clip, 2 = incoming clip',
	u_seed: 'float — deterministic 0..1 per clip and effect instance (mixed with a `seed` param if present)',
	u_layerToComp: 'mat3 — layer pixels → sequence (composition) pixels (Motion, corner pin included)',
	u_compSize: 'vec2 — sequence frame size in pixels',
	u_samples: 'sampler2DArray — time samples (raw layer source at other frames, canvas layout), see fx_sample',
	u_sampleCount: 'int — number of valid layers in u_samples',
	u_sampleOffsets: 'float[8] — frame offset of each sample',
} as const;

const NAME_RE = /^[A-Za-z][A-Za-z0-9]*$/;

/** GLSL type of a parameter's uniform (null = not mapped: strings and curves; media params become textures). */
export function paramUniformType(p: ParamSpec): FxUniformType | 'sampler2D' | null {
	switch (p.type) {
		case 'number':
			return 'float';
		case 'boolean':
			return 'bool';
		case 'enum':
			return 'int';
		case 'vec2':
			return 'vec2';
		case 'color':
			return 'vec4';
		case 'media':
			return 'sampler2D';
		default:
			return null;
	}
}

// ---------------------------------------------------------------- uniforms

const finite = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/**
 * Uniforms derived from params (naming: `u_<paramName>`): number → `float`, boolean → `bool`, enum → `int` (index in
 * `options`; unknown values → the default's index), vec2 → `vec2`, color → `vec4` (straight RGBA 0..1). Media params
 * add `u_<name>_size` (set by the host from the bound texture); strings and curves are not mapped.
 */
/** The Sapphire-style "Seed" param (`seedParam`): numeric and named `seed`, read through `u_seed`. */
const isSeedParam = (p: ParamSpec) => p.name === 'seed' && p.type === 'number';

export function paramUniforms(
	spec: { readonly params: readonly ParamSpec[] },
	params: EffectParams,
): FxUniform[] {
	const out: FxUniform[] = [];
	for (const p of spec.params) {
		// A numeric `seed` param (`seedParam`) is not its own uniform: `fxSeed` mixes it into the built-in `u_seed`.
		if (isSeedParam(p)) continue;
		const v = params[p.name] ?? p.default;
		const name = `u_${p.name}`;
		switch (p.type) {
			case 'number':
				out.push({ name, type: 'float', value: [finite(v, finite(p.default))] });
				break;
			case 'boolean':
				out.push({ name, type: 'bool', value: [(typeof v === 'boolean' ? v : p.default === true) ? 1 : 0] });
				break;
			case 'enum': {
				const opts = p.options ?? [];
				let i = typeof v === 'string' ? opts.indexOf(v) : -1;
				if (i < 0) i = Math.max(0, opts.indexOf(String(p.default)));
				out.push({ name, type: 'int', value: [i] });
				break;
			}
			case 'vec2': {
				const a = Array.isArray(v) && v.length === 2 ? v : Array.isArray(p.default) ? p.default : [0, 0];
				out.push({ name, type: 'vec2', value: [finite(a[0]), finite(a[1])] });
				break;
			}
			case 'color': {
				const a =
					Array.isArray(v) && v.length === 4 ? v : Array.isArray(p.default) ? p.default : [0, 0, 0, 1];
				out.push({ name, type: 'vec4', value: [finite(a[0]), finite(a[1]), finite(a[2]), finite(a[3], 1)] });
				break;
			}
			default:
				break;
		}
	}
	return out;
}

/** A custom uniform value → its GLSL type and flattened numbers. Throws for malformed values. */
export function toUniform(name: string, v: FxUniformValue): FxUniform {
	if (typeof v === 'number') return { name, type: 'float', value: [finite(v)] };
	if (typeof v === 'boolean') return { name, type: 'bool', value: [v ? 1 : 0] };
	if (Array.isArray(v)) {
		const t = v.length === 2 ? 'vec2' : v.length === 3 ? 'vec3' : v.length === 4 ? 'vec4' : null;
		if (!t) throw new Error(`fx uniform ${name}: vectors have 2, 3 or 4 components`);
		return { name, type: t, value: v.map((x) => finite(x)) };
	}
	const o = v as { int?: number; floats?: readonly number[]; mat3?: readonly number[] };
	if (o.int !== undefined) return { name, type: 'int', value: [Math.trunc(finite(o.int))] };
	if (o.floats) {
		if (o.floats.length === 0) throw new Error(`fx uniform ${name}: empty float array`);
		return { name, type: 'float[]', value: o.floats.map((x) => finite(x)) };
	}
	if (o.mat3?.length === 9) return { name, type: 'mat3', value: o.mat3.map((x) => finite(x)) };
	throw new Error(`fx uniform ${name}: unsupported value`);
}

function declaration(u: FxUniform): string {
	return u.type === 'float[]'
		? `uniform float ${u.name}[${u.value.length}];`
		: `uniform ${u.type} ${u.name};`;
}

// ---------------------------------------------------------------- program sources

/** The prelude every pass gets (after `#version`): precision, varyings, built-ins and the coordinate helpers. */
export const FX_PRELUDE = `precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_source;
uniform sampler2D u_prev;
uniform vec2 u_resolution;
uniform vec2 u_texel;
uniform vec2 u_canvasSize;
uniform vec4 u_box;
uniform float u_pxScale;
uniform float u_frame;
uniform float u_time;
uniform float u_fps;
uniform float u_duration;
uniform float u_clipProgress;
uniform float u_progress;
uniform int u_side;
uniform float u_seed;
uniform mat3 u_layerToComp;
uniform vec2 u_compSize;
uniform sampler2DArray u_samples;
uniform int u_sampleCount;
uniform float u_sampleOffsets[8];
// Coordinates: uv 0..1 over the canvas, (0,0) = top-left; canvas px = uv * u_canvasSize (y down);
// layer px = position inside the layer box in layer pixels; layer norm = 0..1 over the layer box.
vec2 fx_canvasPx() { return v_uv * u_canvasSize; }
vec2 fx_layerPx() { return (v_uv * u_canvasSize - u_box.xy) / u_pxScale; }
vec2 fx_layerNorm() { return (v_uv * u_canvasSize - u_box.xy) / u_box.zw; }
vec2 fx_uvOfCanvasPx(vec2 p) { return p / u_canvasSize; }
vec2 fx_uvOfLayerPx(vec2 p) { return (p * u_pxScale + u_box.xy) / u_canvasSize; }
vec2 fx_uvOfLayerNorm(vec2 n) { return (n * u_box.zw + u_box.xy) / u_canvasSize; }
bool fx_inBox(vec2 uv) { vec2 p = uv * u_canvasSize - u_box.xy; return all(greaterThanEqual(p, vec2(0.0))) && all(lessThan(p, u_box.zw)); }
vec4 fx_premultiply(vec4 c) { return vec4(c.rgb * c.a, c.a); }
vec4 fx_unpremultiply(vec4 c) { return c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 fx_sample(int i, vec2 uv) { return i < u_sampleCount ? texture(u_samples, vec3(uv, float(i))) : vec4(0.0); }
`;

function collectChunks(chunks: readonly GlslChunk[] | undefined, out: GlslChunk[], seen: Set<string>): void {
	for (const c of chunks ?? []) {
		if (seen.has(c.name)) continue;
		collectChunks(c.deps, out, seen);
		if (seen.has(c.name)) continue;
		seen.add(c.name);
		out.push(c);
	}
}

/** The include list of a pass, dependencies first, each chunk once. */
export function resolveIncludes(chunks: readonly GlslChunk[] | undefined): GlslChunk[] {
	const out: GlslChunk[] = [];
	collectChunks(chunks, out, new Set());
	return out;
}

/** Number of lines before the author's `frag` in a pass source (to map compile-error line numbers). */
export function fragLineOffset(source: string, frag: string): number {
	const i = source.lastIndexOf(frag);
	return i < 0 ? 0 : source.slice(0, i).split('\n').length - 1;
}

/** The complete fragment shader of a pass. */
export function buildPassSource(
	pass: ShaderPass,
	decls: {
		params: readonly string[];
		textures: readonly string[];
		outputs: readonly string[];
		uniforms: readonly string[];
	},
): string {
	const parts = ['#version 300 es', FX_PRELUDE];
	const d = [
		...decls.outputs.map((o) => `uniform sampler2D u_${o};`),
		...decls.textures.flatMap((t) => [`uniform sampler2D ${t};`, `uniform vec2 ${t}_size;`]),
		...decls.params,
		...decls.uniforms,
	];
	if (d.length) parts.push(`${d.join('\n')}\n`);
	for (const c of resolveIncludes(pass.include)) parts.push(`// ---- ${c.name}\n${c.source.trim()}\n`);
	parts.push(pass.frag.trim(), '');
	return parts.join('\n');
}

// ---------------------------------------------------------------- planning

const nonNeg = (x: unknown) => Math.min(FX_MAX_PADDING, Math.max(0, finite(x)));

/** The padding an effect instance asks for (layer px, clamped to 0..FX_MAX_PADDING). */
export function gpuPadding(spec: Pick<EffectSpec, 'gpu'>, p: EffectParams, ctx: FxPlanContext): FxPadding {
	const r = spec.gpu?.padding?.(p, ctx);
	if (r === undefined) return { left: 0, top: 0, right: 0, bottom: 0 };
	if (typeof r === 'number') {
		const n = nonNeg(r);
		return { left: n, top: n, right: n, bottom: n };
	}
	return { left: nonNeg(r.left), top: nonNeg(r.top), right: nonNeg(r.right), bottom: nonNeg(r.bottom) };
}

/** Sum of paddings (stack order: each effect pads its input's bounds). */
export function addPadding(a: FxPadding, b: FxPadding): FxPadding {
	return { left: a.left + b.left, top: a.top + b.top, right: a.right + b.right, bottom: a.bottom + b.bottom };
}

export const ZERO_PADDING: FxPadding = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });

/** The pass list of an effect instance. */
export function gpuPasses(gpu: GpuEffect, p: EffectParams, ctx: FxPlanContext): readonly ShaderPass[] {
	return typeof gpu.passes === 'function' ? gpu.passes(p, ctx) : gpu.passes;
}

/**
 * Plans one effect instance at one frame: pass sizes (`scale` of the canvas, ≥ 1 px; the last pass at full size),
 * named outputs, declarations and complete sources; uniforms from params + `gpu.uniforms`; media textures.
 * `canvas` is the effect canvas in pixels (layer box + accumulated padding, × pxScale).
 */
export function planGpuEffect(
	spec: EffectSpec,
	fx: { id: string; params: EffectParams },
	ctx: FxFrameContext,
	canvas: { width: number; height: number },
): FxEffectPlan {
	const gpu = spec.gpu;
	if (!gpu) throw new Error(`effect ${spec.id} has no gpu realization`);
	const p = fx.params;
	const passes = gpuPasses(gpu, p, ctx);
	if (passes.length === 0) throw new Error(`effect ${spec.id}: no passes`);
	const uniforms = paramUniforms(spec, p);
	const custom = gpu.uniforms?.(p, ctx) ?? {};
	for (const [k, v] of Object.entries(custom)) uniforms.push(toUniform(k, v));
	const textures = spec.params
		.filter((ps) => ps.type === 'media')
		.map((ps) => {
			const v = p[ps.name] as { mediaId?: unknown } | undefined;
			return {
				param: ps.name,
				uniform: `u_${ps.name}`,
				mediaId: typeof v?.mediaId === 'string' ? v.mediaId : '',
			};
		});
	const paramDecls = uniforms.map(declaration);
	const outputs: string[] = [];
	const planned: FxPassPlan[] = [];
	passes.forEach((pass, index) => {
		const last = index === passes.length - 1;
		const scale = last ? 1 : Math.min(1, Math.max(1e-3, finite(pass.scale, 1)));
		const passUniforms = Object.entries(pass.uniforms ?? {}).map(([k, v]) => toUniform(k, v));
		const source = buildPassSource(pass, {
			params: paramDecls,
			textures: textures.map((t) => t.uniform),
			outputs: [...outputs],
			uniforms: passUniforms.map(declaration),
		});
		planned.push({
			index,
			output: last ? null : (pass.output ?? `pass${index}`),
			width: Math.max(1, Math.ceil(canvas.width * scale)),
			height: Math.max(1, Math.ceil(canvas.height * scale)),
			format: pass.format ?? 'rgba8',
			filter: pass.filter ?? 'linear',
			source,
			uniforms: passUniforms,
		});
		if (!last) outputs.push(pass.output ?? `pass${index}`);
	});
	const key = `${spec.id}@${spec.version}:${canvas.width}x${canvas.height}:${planned
		.map((pp) => `${pp.width}x${pp.height}/${pp.format}/${hashString(pp.source)}`)
		.join(',')}`;
	return { fxId: fx.id, effectId: spec.id, canvas, passes: planned, uniforms, textures, key };
}

// ---------------------------------------------------------------- built-in uniforms

/** What the host knows about a layer at a frame: the values behind the built-in uniforms (except u_seed). */
export type FxBuiltinInput = {
	canvas: { width: number; height: number };
	/** The layer box inside the canvas, canvas pixels. */
	box: { x: number; y: number; w: number; h: number };
	pxScale: number;
	/** Clip-local frame, real time. */
	frame: number;
	fps: number;
	/** Clip duration in frames. */
	duration: number;
	/** Transition driving the layer (absent = none: u_progress = clip progress, u_side = 0). */
	transition?: { progress: number; side: 'out' | 'in' } | null;
	/** Layer px → sequence px, row-major (`layerMapOf`); absent = identity. */
	layerToComp?: readonly number[] | null;
	compSize: { width: number; height: number };
};

/** Clip progress 0..1 at a clip-local frame (`u_clipProgress`). */
export function fxClipProgress(frame: number, duration: number): number {
	return duration > 1 ? Math.min(1, Math.max(0, frame / (duration - 1))) : 0;
}

/** The built-in uniforms of a layer at a frame (every name of FX_BUILTIN_UNIFORMS that is not a texture/u_seed). */
export function fxBuiltinUniforms(b: FxBuiltinInput): FxUniform[] {
	const m = b.layerToComp ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
	const clipProgress = fxClipProgress(b.frame, b.duration);
	return [
		{ name: 'u_canvasSize', type: 'vec2', value: [b.canvas.width, b.canvas.height] },
		{ name: 'u_box', type: 'vec4', value: [b.box.x, b.box.y, b.box.w, b.box.h] },
		{ name: 'u_pxScale', type: 'float', value: [b.pxScale] },
		{ name: 'u_frame', type: 'float', value: [b.frame] },
		{ name: 'u_time', type: 'float', value: [b.frame / b.fps] },
		{ name: 'u_fps', type: 'float', value: [b.fps] },
		{ name: 'u_duration', type: 'float', value: [b.duration] },
		{ name: 'u_clipProgress', type: 'float', value: [clipProgress] },
		{ name: 'u_progress', type: 'float', value: [b.transition?.progress ?? clipProgress] },
		{ name: 'u_side', type: 'int', value: [b.transition ? (b.transition.side === 'out' ? 1 : 2) : 0] },
		// GLSL mat3 is column-major; ours is row-major.
		{
			name: 'u_layerToComp',
			type: 'mat3',
			value: [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!],
		},
		{ name: 'u_compSize', type: 'vec2', value: [b.compSize.width, b.compSize.height] },
	];
}

// ---------------------------------------------------------------- seeds and randomness

/** FNV-1a 32-bit of a string (stable across engines and realms). */
export function hashString(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * `u_seed` of an effect instance: a 0..1 hash of the clip id and the effect instance id, mixed with the value of a
 * numeric `seed` param when the effect has one (Sapphire "Seed"). Deterministic: the same clip and settings draw the
 * same pattern in the Player, in parallel render pages and after a reload (S11 §2 determinism rules: no
 * `Math.random`, no clocks).
 */
export function fxSeed(clipId: string, fxId: string, params?: EffectParams): number {
	const s = params && typeof params.seed === 'number' && Number.isFinite(params.seed) ? params.seed : 0;
	return hashString(`${clipId}\u0000${fxId}\u0000${s}`) / 4294967296;
}

/** A deterministic 0..1 random number for (`seed`, `n`) — e.g. per frame in time hooks: `fxRandom(ctx.seed, frame)`. */
export function fxRandom(seed: number, n: number): number {
	let x = (Math.floor(seed * 4294967296) ^ Math.imul(Math.floor(n) | 0, 0x9e3779b1)) >>> 0;
	x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0;
	x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0;
	return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- time hooks

/**
 * The clip-local source frame for `frame` after the remapping effects of a stack (stack order), or null when no
 * enabled effect remaps time. Rounded down and clamped to the drawn span `[−head, duration + tail − 1]`.
 */
export function fxSourceFrame(
	steps: readonly { spec: EffectSpec; params: EffectParams; seed: number }[],
	ctx: Omit<FxTimeContext, 'seed'>,
): number | null {
	let f: number | null = null;
	for (const s of steps) {
		const remap = s.spec.gpu?.time?.remap;
		if (!remap) continue;
		const at = f ?? ctx.frame;
		const r = remap(s.params, { ...ctx, frame: at, seed: s.seed });
		f = Number.isFinite(r) ? Math.floor(r) : at;
		f = Math.max(-ctx.headHandle, Math.min(ctx.duration + ctx.tailHandle - 1, f));
	}
	return f;
}

/** Time-sample offsets of one effect (integers, at most FX_MAX_TIME_SAMPLES; non-finite entries dropped). */
export function fxTimeSamples(spec: EffectSpec, params: EffectParams, ctx: FxTimeContext): number[] {
	const r = spec.gpu?.time?.samples?.(params, ctx) ?? [];
	return r
		.filter((x) => Number.isFinite(x))
		.map((x) => Math.round(x))
		.slice(0, FX_MAX_TIME_SAMPLES);
}

/** The effect redraws every frame (time-dependent output). */
export function gpuIsTimeDependent(spec: Pick<EffectSpec, 'gpu'>): boolean {
	const g = spec.gpu;
	if (!g) return false;
	return !g.timeInvariant || !!g.time?.remap || !!g.time?.samples;
}

// ---------------------------------------------------------------- validation

const RESERVED = new Set(Object.keys(FX_BUILTIN_UNIFORMS));
const FORBIDDEN_GLSL: [RegExp, string][] = [
	[/#version/, 'must not contain #version (the framework adds it)'],
	[/\bprecision\s+(highp|mediump|lowp)\b/, 'must not declare precision (the prelude does)'],
	[/\bgl_FragColor\b/, 'uses gl_FragColor (GLSL ES 1.00); write fragColor'],
	[/\btexture2D\s*\(/, 'uses texture2D (GLSL ES 1.00); use texture()'],
	[/\bvarying\b/, 'uses varying (GLSL ES 1.00)'],
	[/\bout\s+vec4\s+fragColor\b/, 'declares fragColor (the prelude does)'],
	[/\bMath\.random\b/, 'mentions Math.random'],
];

/**
 * Structural problems of a GPU effect spec (empty = valid). The catalogue test runs this over every registered
 * effect; it cannot compile GLSL (see the GL test in packages/compositions/test for that).
 */
export function validateGpuEffect(spec: EffectSpec): string[] {
	const out: string[] = [];
	const gpu = spec.gpu;
	if (!gpu) return out;
	const at = (m: string) => out.push(`${spec.id}: ${m}`);
	if (spec.capabilities.preview !== 'webgl')
		at(`capabilities.preview must be 'webgl' (is '${spec.capabilities.preview}')`);
	if (!spec.capabilities.export.includes('remotion')) at(`capabilities.export must include 'remotion'`);
	if (spec.color) at('a gpu effect cannot also be a colour op (pick one realization)');
	if (spec.appliesTo !== 'video') at('gpu effects apply to video');
	const names = new Set<string>();
	for (const p of spec.params) {
		if (!NAME_RE.test(p.name)) at(`param "${p.name}": names are letters and digits, starting with a letter`);
		if (RESERVED.has(`u_${p.name}`) && !isSeedParam(p))
			at(`param "${p.name}": u_${p.name} is a built-in uniform`);
		if (names.has(p.name)) at(`param "${p.name}" is declared twice`);
		names.add(p.name);
		if (p.type === 'enum' && !(p.options ?? []).includes(String(p.default)))
			at(`param "${p.name}": default is not one of its options`);
	}
	const ctx: FxFrameContext = {
		width: 1920,
		height: 1080,
		pxScale: 1,
		fps: 30,
		frame: 0,
		duration: 150,
		seed: 0.5,
		progress: 0,
	};
	const defaults: EffectParams = Object.fromEntries(spec.params.map((p) => [p.name, p.default]));
	let passes: readonly ShaderPass[] = [];
	try {
		passes = gpuPasses(gpu, defaults, ctx);
	} catch (e) {
		at(`passes(defaults) threw: ${(e as Error).message}`);
	}
	if (passes.length === 0) at('no passes');
	const outputs = new Set<string>();
	const textures = spec.params.filter((p) => p.type === 'media').length;
	passes.forEach((pass, i) => {
		const last = i === passes.length - 1;
		if (!/\bvoid\s+main\s*\(/.test(pass.frag)) at(`pass ${i}: no void main()`);
		if (!/\bfragColor\b/.test(pass.frag)) at(`pass ${i}: never writes fragColor`);
		for (const [re, msg] of FORBIDDEN_GLSL) if (re.test(pass.frag)) at(`pass ${i}: ${msg}`);
		if (pass.scale !== undefined && !(pass.scale > 0 && pass.scale <= 1))
			at(`pass ${i}: scale must be in (0, 1]`);
		if (!last) {
			const o = pass.output ?? `pass${i}`;
			if (!NAME_RE.test(o)) at(`pass ${i}: output "${o}" must be letters and digits`);
			if (outputs.has(o)) at(`pass ${i}: output "${o}" is used twice`);
			if (RESERVED.has(`u_${o}`) || names.has(o)) at(`pass ${i}: output "${o}" collides with a uniform`);
			outputs.add(o);
		}
		for (const k of Object.keys(pass.uniforms ?? {})) {
			if (!/^u_[A-Za-z][A-Za-z0-9_]*$/.test(k)) at(`pass ${i}: uniform "${k}" must be named u_<name>`);
			if (RESERVED.has(k)) at(`pass ${i}: uniform "${k}" is a built-in`);
		}
		for (const c of resolveIncludes(pass.include))
			if (typeof c.source !== 'string' || !c.name) at(`pass ${i}: malformed include`);
	});
	if (outputs.size + textures > FX_MAX_TEXTURES)
		at(`more than ${FX_MAX_TEXTURES} textures (outputs + media params)`);
	try {
		for (const k of Object.keys(gpu.uniforms?.(defaults, ctx) ?? {})) {
			if (!/^u_[A-Za-z][A-Za-z0-9_]*$/.test(k)) at(`uniform "${k}" must be named u_<name>`);
			if (RESERVED.has(k)) at(`uniform "${k}" is a built-in`);
		}
		const pad = gpu.padding?.(defaults, ctx);
		if (pad !== undefined) {
			const vals = typeof pad === 'number' ? [pad] : Object.values(pad);
			if (vals.some((v) => !(typeof v === 'number' && Number.isFinite(v) && v >= 0)))
				at('padding must be finite and ≥ 0');
		}
		const tctx: FxTimeContext = {
			frame: 10,
			fps: 30,
			duration: 150,
			headHandle: 0,
			tailHandle: 0,
			seed: 0.5,
		};
		const n = gpu.time?.samples?.(defaults, tctx).length ?? 0;
		if (n > FX_MAX_TIME_SAMPLES) at(`more than ${FX_MAX_TIME_SAMPLES} time samples`);
		const r = gpu.time?.remap?.(defaults, tctx);
		if (r !== undefined && !Number.isFinite(r)) at('time.remap returned a non-finite frame');
	} catch (e) {
		at(`hook threw with default params: ${(e as Error).message}`);
	}
	if (spec.bin !== undefined && !spec.bin.trim()) at('bin must not be empty');
	return out;
}
