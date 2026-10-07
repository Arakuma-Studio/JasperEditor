// GPU shader effects (wave-1 fx framework; S03 §15.1 `preview.webgl`, S03:FX-001 "WebGL wrappers", FX-041 effect
// bounds; the GL colour stage of ARCHITECTURE §19.2 is the rendering precedent). `EffectSpec.gpu` describes one or
// more GLSL ES 3.00 fragment passes. This module is pure (no DOM, no GL): it maps params to uniforms, plans the
// passes of one effect instance (sizes, named intermediates, complete program sources), resolves padding, seeds
// and the time hooks, and validates specs. The compositions' GL host (`packages/compositions/src/fx/`) compiles and
// runs the plans inside Remotion's canvas effect chain, in the Player and in renders alike.
// Authoring guide (normative for effect authors): docs/wp-notes/fx-shader-framework.md.
import { evaluate } from '../../keyframes.ts';
import type { Animatable, ParamValue } from '../../schema/common.ts';
import { FLICKS_PER_SECOND } from '../../time.ts';
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
	| { readonly mat3: readonly number[] }
	/** `ivec2` / `ivec3` / `ivec4` (components truncated to integers). */
	| { readonly ivec2: readonly [number, number] }
	| { readonly ivec3: readonly [number, number, number] }
	| { readonly ivec4: readonly [number, number, number, number] }
	/** `vec4 u_x[n]`: 4·n numbers (packed point lists: 2 points or 1 point + 2 attributes per element). */
	| { readonly vec4s: readonly number[] };

export type FxUniformType =
	| 'float'
	| 'int'
	| 'bool'
	| 'vec2'
	| 'vec3'
	| 'vec4'
	| 'mat3'
	| 'float[]'
	| 'ivec2'
	| 'ivec3'
	| 'ivec4'
	| 'vec4[]';
/**
 * A uniform as the GL host sets it: flattened numbers (`bool` = 0/1, `float[]` = `length` floats, `vec4[]` =
 * 4 × `length / 4` floats).
 */
export type FxUniform = { name: string; type: FxUniformType; value: readonly number[] };

/** Extra pixels an effect draws around the layer box, per side, in layer pixels (S03:FX-041). */
export type FxPadding = { left: number; top: number; right: number; bottom: number };

/**
 * The clip an effect instance sits on (Premiere's Clip Name / Timecode burn-ins, source-time effects). Absent outside
 * a composition (unit tests, the catalogue checks): hooks must fall back to their own params.
 */
export type FxClipInfo = {
	/** Sequence clip name (Premiere "Sequence Clip Name"). */
	clipName: string;
	/** Name of the clip's project item ("Project Item Name"); '' for clips without media (text, solids…). */
	itemName: string;
	/** File name of the clip's media ("File Name", e.g. `A001_C003.mov`); '' without media. */
	fileName: string;
	/** Source in-point: seconds into the media at the clip's first frame (S01:CLP-004). */
	sourceInSeconds: number;
	/** Embedded start timecode of the media (`HH:MM:SS:FF`, from the probe), or null when it has none. */
	sourceStartTimecode: string | null;
	/** Clip speed (S01 `speed`): media seconds per clip second, and reverse playback. */
	speed: number;
	reverse: boolean;
	/** Clip duration in frames. */
	duration: number;
};

/**
 * Params of the same effect instance at another CLIP-LOCAL frame of the real time (fractional frames allowed: sub-frame
 * shutter samples), evaluated from the clip's keyframes by the shared `evaluate()` — exactly the values the effect
 * gets at that frame (same object for the current frame). Absent when the host cannot provide them (tests, the
 * catalogue checks): treat as "the params do not change" (`ctx.paramsAt?.(f) ?? p`).
 */
export type FxParamsAt = (frame: number) => EffectParams;

/** What pass planning and padding know: the layer box and the canvas resolution. */
export type FxPlanContext = {
	/** Layer box (the clip's intrinsic size) in layer pixels. */
	width: number;
	height: number;
	/** Canvas pixels per layer pixel (1 = full resolution; < 1 when a huge layer is drawn downscaled). */
	pxScale: number;
	fps: number;
	/** Clip-local frame (real time) being planned, when known. */
	frame?: number;
	/** Params of this instance at other frames (see `FxParamsAt`). */
	paramsAt?: FxParamsAt;
	/** The clip (names, source in-point, source timecode); see `FxClipInfo`. */
	clip?: FxClipInfo;
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
	/** Params of this instance at other frames (see `FxParamsAt`). */
	paramsAt?: FxParamsAt;
	clip?: FxClipInfo;
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
	/**
	 * Absolute output size in pixels (e.g. `{width: 64, height: 1}` for a lookup/statistics pass), instead of `scale`.
	 * Integers 1…8192. Ignored on the last pass (always the canvas size).
	 */
	size?: { width: number; height: number };
	/**
	 * Ping-pong: this pass writes an output NAME already written by an earlier pass (`output` required). It may read
	 * the previous contents as `u_<output>` (the host alternates two textures); later passes see the new contents.
	 * Iterative algorithms (sorting networks, flood fills, jump floods, accumulations) thereby use one name for any
	 * number of steps — the ≤ 12 limit counts distinct names. Without `update`, reusing a name is an error.
	 */
	update?: boolean;
	/**
	 * Build a mip chain of this pass's output (trilinear minification) so later passes can sample it with
	 * `textureLod` / `textureGrad` / implicit-LOD `texture()` for strongly shrinking warps and cheap wide averages.
	 */
	mipmaps?: boolean;
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
	/**
	 * `u_source` gets a mip chain in every pass of this effect (trilinear minification): `textureLod(u_source, uv,
	 * lod)` / `textureGrad` / implicit LOD in strongly shrinking warps (no aliasing). Off by default: with it,
	 * plain `texture(u_source, uv)` in minifying mappings returns filtered (different) values.
	 */
	sourceMipmaps?: boolean;
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
		/**
		 * Samples outside the clip's drawn span `[−headHandle, duration + tailHandle − 1]`:
		 * - `'drop'` (default, the wave-1 behaviour): when any sample is outside, the effect gets none
		 *   (`u_sampleCount == 0`) for that frame;
		 * - `'transparent'`: every sample is bound in request order, outside ones transparent;
		 * - `'clamp'`: outside samples show the nearest frame of the span.
		 * In every mode bit i of `u_sampleValid` is set when sample i shows its own frame.
		 */
		sampleEdge?: 'drop' | 'transparent' | 'clamp';
	};
	/**
	 * True when the output depends only on the params and the input picture (no `u_frame`/`u_time`/`u_progress`,
	 * no time hooks): a still layer then is not redrawn on every frame. Default false (redraw every frame).
	 */
	timeInvariant?: boolean;
	/**
	 * parity (roto): object mattes of the clip's roto objects as inputs. Each entry binds `uniform sampler2D
	 * u_<name>` to the 8-bit matte (in the red channel, 1 = object) of the roto named by the string param `param`
	 * (a `roto-object` param) at the layer's media frame + `offset` (neighbouring frames for temporal filters),
	 * with `vec2 u_<name>_size` (matte px, (0, 0) without a picture) and `float u_<name>_state`: 0 = no object / not
	 * computed (pass the input through), 1 = inside the computed span (the matte is bound), 2 = outside it (After
	 * Effects: transparent). The matte covers the layer box: sample it with `fx_layerNorm()` / layer-normalised uv.
	 */
	mattes?: readonly FxMatteInput[];
};

/** One object-matte input of a GPU effect (`GpuEffect.mattes`). */
export type FxMatteInput = { name: string; param: string; offset?: number };

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
	/**
	 * Physical texture of the output inside the plan: the pass index, or for ping-pong (`update`) passes the pair
	 * `<first index>` / `<first index>~`. Absent = the pass index.
	 */
	target?: string;
	/** Generate mipmaps of the output after drawing. */
	mipmaps?: boolean;
};

/** A planned effect instance: what the GL host runs for one effect at one frame. */
export type FxEffectPlan = {
	fxId: string;
	effectId: string;
	canvas: { width: number; height: number };
	passes: FxPassPlan[];
	/** Param uniforms + `GpuEffect.uniforms`, for every pass. */
	uniforms: FxUniform[];
	/**
	 * `media` params bound as textures: `uniform sampler2D u_<param>` + `uniform vec2 u_<param>_size` (pictures), or
	 * for `lut`-only params `uniform highp sampler3D u_<param>` + `vec2 u_<param>_size` = (N, 1) for an N³ LUT.
	 */
	textures: {
		param: string;
		uniform: string;
		mediaId: string;
		kind?: '2d' | 'lut';
		/** parity (roto): an object matte (`GpuEffect.mattes`); the host resolves `mediaId` and `u_<name>_state`. */
		matte?: { object: string; offset: number };
	}[];
	/** `u_source` has mipmaps in every pass (`GpuEffect.sourceMipmaps`). */
	sourceMipmaps?: boolean;
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
	u_sampleValid:
		'int — bit i set: sample i shows its own frame (not outside the clip span: transparent/clamped)',
} as const;

const NAME_RE = /^[A-Za-z][A-Za-z0-9]*$/;

/** A `media` param that takes `.cube` LUT assets only: bound as a 3D texture (`sampler3D`). */
export function isLutMediaParam(p: Pick<ParamSpec, 'type' | 'mediaKinds'>): boolean {
	return p.type === 'media' && !!p.mediaKinds?.length && p.mediaKinds.every((k) => k === 'lut');
}

/** GLSL type of a parameter's uniform (null = not mapped: strings and curves; media params become textures). */
export function paramUniformType(p: ParamSpec): FxUniformType | 'sampler2D' | 'sampler3D' | null {
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
			return isLutMediaParam(p) ? 'sampler3D' : 'sampler2D';
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
	const o = v as {
		int?: number;
		floats?: readonly number[];
		mat3?: readonly number[];
		ivec2?: readonly number[];
		ivec3?: readonly number[];
		ivec4?: readonly number[];
		vec4s?: readonly number[];
	};
	if (o.int !== undefined) return { name, type: 'int', value: [Math.trunc(finite(o.int))] };
	for (const [k, n] of [
		['ivec2', 2],
		['ivec3', 3],
		['ivec4', 4],
	] as const) {
		const a = o[k];
		if (a === undefined) continue;
		if (a.length !== n) throw new Error(`fx uniform ${name}: ${k} has ${n} components`);
		return { name, type: k, value: a.map((x) => Math.trunc(finite(x))) };
	}
	if (o.vec4s) {
		if (o.vec4s.length === 0 || o.vec4s.length % 4 !== 0)
			throw new Error(`fx uniform ${name}: vec4s needs a non-empty multiple of 4 numbers`);
		return { name, type: 'vec4[]', value: o.vec4s.map((x) => finite(x)) };
	}
	if (o.floats) {
		if (o.floats.length === 0) throw new Error(`fx uniform ${name}: empty float array`);
		return { name, type: 'float[]', value: o.floats.map((x) => finite(x)) };
	}
	if (o.mat3?.length === 9) return { name, type: 'mat3', value: o.mat3.map((x) => finite(x)) };
	throw new Error(`fx uniform ${name}: unsupported value`);
}

/** The GLSL declaration of a custom/param uniform. */
export function uniformDeclaration(u: FxUniform): string {
	if (u.type === 'float[]') return `uniform float ${u.name}[${u.value.length}];`;
	if (u.type === 'vec4[]') return `uniform vec4 ${u.name}[${u.value.length / 4}];`;
	return `uniform ${u.type} ${u.name};`;
}
const declaration = uniformDeclaration;

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
uniform int u_sampleValid;
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

const declaredName = (decl: string) => /\b(u_[A-Za-z0-9_]+)\s*(?:\[\d+\])?\s*;\s*$/.exec(decl)?.[1] ?? '';

/**
 * The complete fragment shader of a pass. Declarations of outputs, media textures and uniforms the pass never
 * mentions (in its body or its includes) are left out, so identical pass bodies of different effects (or of
 * different positions in one effect) compile to ONE program. Textures are `sampler2D` unless listed in `lut`
 * (`highp sampler3D`).
 */
export function buildPassSource(
	pass: ShaderPass,
	decls: {
		params: readonly string[];
		textures: readonly string[];
		outputs: readonly string[];
		uniforms: readonly string[];
		/** Texture uniforms bound as 3D LUTs. */
		lut?: readonly string[];
	},
): string {
	const includes = resolveIncludes(pass.include);
	const text = `${includes.map((c) => c.source).join('\n')}\n${pass.frag}`;
	const mentions = new Set(text.match(/\bu_[A-Za-z0-9_]+/g) ?? []);
	const lut = new Set(decls.lut ?? []);
	const d = [
		...[...new Set(decls.outputs)]
			.filter((o) => mentions.has(`u_${o}`))
			.map((o) => `uniform sampler2D u_${o};`),
		...decls.textures
			.filter((t) => mentions.has(t) || mentions.has(`${t}_size`))
			.flatMap((t) => [
				lut.has(t) ? `uniform highp sampler3D ${t};` : `uniform sampler2D ${t};`,
				`uniform vec2 ${t}_size;`,
			]),
		...decls.params.filter((x) => mentions.has(declaredName(x))),
		...decls.uniforms.filter((x) => mentions.has(declaredName(x))),
	];
	const parts = ['#version 300 es', FX_PRELUDE];
	if (d.length) parts.push(`${d.join('\n')}\n`);
	for (const c of includes) parts.push(`// ---- ${c.name}\n${c.source.trim()}\n`);
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
	const textures: FxEffectPlan['textures'] = spec.params
		.filter((ps) => ps.type === 'media')
		.map((ps) => {
			const v = p[ps.name] as { mediaId?: unknown } | undefined;
			return {
				param: ps.name,
				uniform: `u_${ps.name}`,
				mediaId: typeof v?.mediaId === 'string' ? v.mediaId : '',
				...(isLutMediaParam(ps) ? { kind: 'lut' as const } : {}),
			};
		});
	// parity (roto): object mattes (state 0 until the host resolves them).
	for (const m of gpu.mattes ?? []) {
		const v = p[m.param];
		textures.push({
			param: m.param,
			uniform: `u_${m.name}`,
			mediaId: '',
			matte: { object: typeof v === 'string' ? v : '', offset: Math.round(m.offset ?? 0) },
		});
		uniforms.push({ name: `u_${m.name}_state`, type: 'float', value: [0] });
	}
	const planned = planPasses(passes, {
		paramDecls: uniforms.map(declaration),
		textures: textures.map((t) => t.uniform),
		lut: textures.filter((t) => t.kind === 'lut').map((t) => t.uniform),
		canvas,
	});
	const key = `${spec.id}@${spec.version}:${canvas.width}x${canvas.height}:${planPassesKey(planned)}${gpu.sourceMipmaps ? ':srcmip' : ''}`;
	return {
		fxId: fx.id,
		effectId: spec.id,
		canvas,
		passes: planned,
		uniforms,
		textures,
		key,
		...(gpu.sourceMipmaps ? { sourceMipmaps: true } : {}),
	};
}

/** Identity of planned passes (sizes, formats, programs, targets) for plan keys. */
export function planPassesKey(planned: readonly FxPassPlan[]): string {
	return planned
		.map(
			(pp) =>
				`${pp.width}x${pp.height}/${pp.format}/${hashString(pp.source)}${pp.target !== undefined ? `@${pp.target}` : ''}${pp.mipmaps ? '/mip' : ''}`,
		)
		.join(',');
}

/** Largest absolute pass size (`ShaderPass.size`) per side. */
const MAX_PASS_SIDE = 8192;

/**
 * Sizes, physical targets and sources of a pass list (shared by effects and transitions): `scale` or absolute
 * `size`, named outputs (ping-pong `update` passes alternate two targets per name), mipmaps; the last pass is the
 * canvas.
 */
export function planPasses(
	passes: readonly ShaderPass[],
	opts: {
		paramDecls: readonly string[];
		textures: readonly string[];
		lut?: readonly string[];
		canvas: { width: number; height: number };
	},
): FxPassPlan[] {
	const outputs: string[] = [];
	/** Output name → [first pass index, writes so far]. */
	const writes = new Map<string, [number, number]>();
	const planned: FxPassPlan[] = [];
	const { canvas } = opts;
	passes.forEach((pass, index) => {
		const last = index === passes.length - 1;
		const scale = last ? 1 : Math.min(1, Math.max(1e-3, finite(pass.scale, 1)));
		const passUniforms = Object.entries(pass.uniforms ?? {}).map(([k, v]) => toUniform(k, v));
		const source = buildPassSource(pass, {
			params: opts.paramDecls,
			textures: opts.textures,
			lut: opts.lut,
			outputs: [...outputs],
			uniforms: passUniforms.map(declaration),
		});
		const name = last ? null : (pass.output ?? `pass${index}`);
		let target: string | undefined;
		if (name !== null) {
			const w = writes.get(name);
			if (w && pass.update) {
				w[1]++;
				target = w[1] % 2 === 1 ? `${w[0]}~` : String(w[0]);
			} else writes.set(name, [index, 0]);
		}
		const abs = !last && pass.size;
		const side = (v: number) => Math.min(MAX_PASS_SIDE, Math.max(1, Math.round(finite(v, 1))));
		planned.push({
			index,
			output: name,
			width: abs ? side(abs.width) : Math.max(1, Math.ceil(canvas.width * scale)),
			height: abs ? side(abs.height) : Math.max(1, Math.ceil(canvas.height * scale)),
			format: pass.format ?? 'rgba8',
			filter: pass.filter ?? 'linear',
			source,
			uniforms: passUniforms,
			...(target !== undefined ? { target } : {}),
			...(!last && pass.mipmaps ? { mipmaps: true } : {}),
		});
		if (name !== null && !outputs.includes(name)) outputs.push(name);
	});
	return planned;
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

/** A time-hook effect of a stack (stack order) with what its hooks get. */
export type FxTimeStep = {
	spec: EffectSpec;
	params: EffectParams;
	seed: number;
	paramsAt?: FxParamsAt;
	clip?: FxClipInfo;
};

type SpanCtx = Omit<FxTimeContext, 'seed' | 'paramsAt' | 'clip'>;

const clampToSpan = (f: number, ctx: SpanCtx) =>
	Math.max(0 - ctx.headHandle, Math.min(ctx.duration + ctx.tailHandle - 1, f)) + 0;

/** One remap: floored and clamped to the drawn span. */
function applyRemap(s: FxTimeStep, at: number, ctx: SpanCtx): number {
	const r = s.spec.gpu!.time!.remap!(s.params, {
		...ctx,
		frame: at,
		seed: s.seed,
		...(s.paramsAt ? { paramsAt: s.paramsAt } : {}),
		...(s.clip ? { clip: s.clip } : {}),
	});
	return clampToSpan(Number.isFinite(r) ? Math.floor(r) : at, ctx);
}

const remaps = (s: FxTimeStep) => !!s.spec.gpu?.time?.remap;

/**
 * The clip-local source frame for `frame` after the remapping effects of a stack, or null when no enabled effect
 * remaps time. Remaps NEST like image effects (After Effects' model): the last effect of the stack is asked for the
 * real frame and asks its input (the effects above it) for its remapped frame, and so on up to the source — so
 * [Freeze, Speed ×2] shows the frozen picture and [Speed ×2, Freeze at 10] shows source frame 20. Each remap is
 * rounded down and clamped to the drawn span `[−head, duration + tail − 1]`.
 */
export function fxSourceFrame(steps: readonly FxTimeStep[], ctx: SpanCtx): number | null {
	let f = ctx.frame;
	let any = false;
	for (let k = steps.length - 1; k >= 0; k--)
		if (remaps(steps[k]!)) {
			f = applyRemap(steps[k]!, f, ctx);
			any = true;
		}
	return any ? f : null;
}

/** The time samples of one step of a stack, resolved to source frames (`fxStackTime`). */
export type FxStepTime = {
	/** Frame the step's output is requested at (= the real frame unless a later effect remaps). */
	frame: number;
	/** Frame of the step's input picture (its own remap applied): sample offsets are relative to it. */
	input: number;
	/** Requested offsets (integers, ≤ FX_MAX_TIME_SAMPLES) — `u_sampleOffsets`. Empty when dropped. */
	offsets: number[];
	/**
	 * Source frame (clip-local, in the drawn span) each sample shows, in request order; null = transparent.
	 * Earlier effects' remaps are applied (a sample of an effect below a freeze is the frozen picture).
	 */
	frames: (number | null)[];
	/** `u_sampleValid`: bit i set when sample i shows its own frame. */
	valid: number;
};

/**
 * Time of every effect of a stack (stack order; pass the enabled effects with time hooks — the relative order is
 * what matters): the layer's source frame and each effect's time samples composed with the other effects' remaps
 * (nested model of `fxSourceFrame`). Samples outside the drawn span follow `time.sampleEdge`.
 */
export function fxStackTime(
	steps: readonly FxTimeStep[],
	ctx: SpanCtx,
): { source: number | null; steps: FxStepTime[] } {
	const n = steps.length;
	const outT: number[] = new Array(n);
	const inT: number[] = new Array(n);
	let tau = ctx.frame;
	let any = false;
	for (let k = n - 1; k >= 0; k--) {
		outT[k] = tau;
		if (remaps(steps[k]!)) {
			tau = applyRemap(steps[k]!, tau, ctx);
			any = true;
		}
		inT[k] = tau;
	}
	const span = (f: number) => f >= -ctx.headHandle && f <= ctx.duration + ctx.tailHandle - 1;
	const out = steps.map((s, k): FxStepTime => {
		const offsets = fxTimeSamples(s.spec, s.params, {
			...ctx,
			frame: outT[k]!,
			seed: s.seed,
			...(s.paramsAt ? { paramsAt: s.paramsAt } : {}),
			...(s.clip ? { clip: s.clip } : {}),
		});
		const earlier = steps.slice(0, k).some(remaps);
		const edge = s.spec.gpu?.time?.sampleEdge ?? 'drop';
		const frames: (number | null)[] = [];
		let valid = 0;
		offsets.forEach((o, i) => {
			let f = inT[k]! + o;
			if (earlier) {
				for (let j = k - 1; j >= 0; j--) if (remaps(steps[j]!)) f = applyRemap(steps[j]!, f, ctx);
				valid |= 1 << i;
				frames.push(f);
			} else if (span(f)) {
				valid |= 1 << i;
				frames.push(f);
			} else frames.push(edge === 'clamp' ? clampToSpan(f, ctx) : null);
		});
		if (edge === 'drop' && frames.some((f) => f === null))
			return { frame: outT[k]!, input: inT[k]!, offsets: [], frames: [], valid: 0 };
		return { frame: outT[k]!, input: inT[k]!, offsets, frames, valid };
	});
	return { source: any ? tau : null, steps: out };
}

/** Time-sample offsets of one effect (integers, at most FX_MAX_TIME_SAMPLES; non-finite entries dropped). */
export function fxTimeSamples(spec: EffectSpec, params: EffectParams, ctx: FxTimeContext): number[] {
	const r = spec.gpu?.time?.samples?.(params, ctx) ?? [];
	return r
		.filter((x) => Number.isFinite(x))
		.map((x) => Math.round(x))
		.slice(0, FX_MAX_TIME_SAMPLES);
}

/**
 * The effect redraws every frame (time-dependent output). With `params`, a `media` param bound to a VIDEO is time
 * dependent too (the picture plays): `mediaKind(id)` resolves the bound media; without a resolver a bound media
 * param that accepts videos counts as time dependent (conservative).
 */
export function gpuIsTimeDependent(
	spec: Pick<EffectSpec, 'gpu' | 'params'> | Pick<EffectSpec, 'gpu'>,
	params?: EffectParams,
	mediaKind?: (mediaId: string) => string | null | undefined,
): boolean {
	const g = spec.gpu;
	if (!g) return false;
	if (!g.timeInvariant || g.time?.remap || g.time?.samples) return true;
	if (!params || !('params' in spec)) return false;
	for (const ps of spec.params) {
		if (ps.type !== 'media' || isLutMediaParam(ps)) continue;
		const id = (params[ps.name] as { mediaId?: unknown } | undefined)?.mediaId;
		if (typeof id !== 'string' || !id) continue;
		const kind = mediaKind ? mediaKind(id) : undefined;
		if (kind === 'video') return true;
		if (!mediaKind && (ps.mediaKinds ?? ['image', 'video']).includes('video')) return true;
	}
	return false;
}

// ---------------------------------------------------------------- params at other times, clip context

/** Content time (flicks) of a fractional clip-local frame (`contentTimeAt` of derive/, with a numeric fps). */
export function fxClipContentTime(
	clip: { duration: number; sourceIn: number; speed: { rate: number; reverse?: boolean } },
	frame: number,
	fps: number,
): number {
	const F = FLICKS_PER_SECOND / (fps > 0 ? fps : 30);
	const i = clip.speed.reverse ? clip.duration - 1 - frame : frame;
	return clip.sourceIn + i * F * clip.speed.rate;
}

/**
 * `FxParamsAt` of an effect instance: its animatable params evaluated (shared `evaluate()`, keyframes in content time)
 * at a fractional clip-local frame. `current` (the frame being drawn and its already-evaluated params) is returned
 * as is for that frame, so `paramsAt(ctx.frame)` is exactly `p`. Results are cached per frame.
 */
export function fxParamsAtFn(
	instance: { readonly params: Readonly<Record<string, Animatable<ParamValue>>> },
	clip: { duration: number; sourceIn: number; speed: { rate: number; reverse?: boolean } },
	fps: number,
	current?: { frame: number; params: EffectParams },
): FxParamsAt {
	const cache = new Map<number, EffectParams>();
	return (frame: number) => {
		if (current && frame === current.frame) return current.params;
		const f = Number.isFinite(frame) ? frame : 0;
		const hit = cache.get(f);
		if (hit) return hit;
		const t = fxClipContentTime(clip, f, fps);
		const out: Record<string, ParamValue> = {};
		for (const [k, a] of Object.entries(instance.params)) out[k] = evaluate(a, t);
		if (cache.size > 256) cache.clear();
		cache.set(f, out);
		return out;
	};
}

/** Seconds into the clip's media shown at a clip-local frame (speed and reverse applied). */
export function fxSourceSeconds(clip: FxClipInfo, frame: number, fps: number): number {
	const i = clip.reverse ? clip.duration - 1 - frame : frame;
	return clip.sourceInSeconds + (i / (fps > 0 ? fps : 30)) * clip.speed;
}

// ---------------------------------------------------------------- validation

/**
 * Uniform names a spec's params declare (`u_<name>`; media params also `u_<name>_size`; a numeric `seed` param feeds
 * the built-in u_seed and declares nothing), with the param each one comes from.
 */
export function paramUniformNames(params: readonly ParamSpec[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const p of params) {
		if (isSeedParam(p) || paramUniformType(p) === null) continue;
		out.set(`u_${p.name}`, p.name);
		if (p.type === 'media') out.set(`u_${p.name}_size`, p.name);
	}
	return out;
}

/**
 * Extra uniforms (`GpuEffect.uniforms` / `GpuTransition.uniforms` keys and `ShaderPass.uniforms` keys) that collide
 * with a name the framework already declares: a built-in (`reserved`), a param uniform (`u_<param>`,
 * `u_<media>_size`), a pass output (`u_<output>`), or — for a pass uniform — one of the extra uniforms of every pass
 * (both would be declared). Without this check such a spec only fails when a shader mentioning the name compiles.
 */
export function uniformCollisions(input: {
	reserved: ReadonlySet<string>;
	params: readonly ParamSpec[];
	outputs: Iterable<string>;
	/** Keys of the spec's `uniforms()` (every pass). */
	globals: readonly string[];
	/** Keys of each pass's own `uniforms`. */
	passes: readonly (readonly string[])[];
}): string[] {
	const out: string[] = [];
	const params = paramUniformNames(input.params);
	const outputs = new Set([...input.outputs].map((o) => `u_${o}`));
	const check = (k: string, where: string) => {
		if (input.reserved.has(k)) out.push(`${where}uniform "${k}" is a built-in`);
		else if (params.has(k))
			out.push(`${where}uniform "${k}" collides with the uniform of param "${params.get(k)}"`);
		else if (outputs.has(k)) out.push(`${where}uniform "${k}" collides with the pass output "${k.slice(2)}"`);
	};
	const globals = new Set(input.globals);
	for (const k of input.globals) check(k, '');
	input.passes.forEach((keys, i) => {
		for (const k of keys) {
			check(k, `pass ${i}: `);
			if (globals.has(k)) out.push(`pass ${i}: uniform "${k}" is also returned by uniforms()`);
		}
	});
	return out;
}

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
	const textures = spec.params.filter((p) => p.type === 'media').length + (gpu.mattes?.length ?? 0);
	for (const m of gpu.mattes ?? []) {
		if (!NAME_RE.test(m.name)) at(`matte "${m.name}": names are letters and digits, starting with a letter`);
		if (names.has(m.name) || RESERVED.has(`u_${m.name}`))
			at(`matte "${m.name}" collides with a param or built-in`);
		const src = spec.params.find((p) => p.name === m.param);
		if (src?.type !== 'string') at(`matte "${m.name}": param "${m.param}" must be a string param`);
		if (m.offset !== undefined && !(Number.isInteger(m.offset) && Math.abs(m.offset) <= 8))
			at(`matte "${m.name}": offset must be an integer in −8…8`);
	}
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
			if (pass.update && !outputs.has(o)) at(`pass ${i}: update writes "${o}", which no earlier pass wrote`);
			if (!pass.update && outputs.has(o)) at(`pass ${i}: output "${o}" is used twice (ping-pong: update)`);
			if (RESERVED.has(`u_${o}`) || names.has(o)) at(`pass ${i}: output "${o}" collides with a uniform`);
			outputs.add(o);
			if (pass.size) {
				const ok = (v: number) => Number.isInteger(v) && v >= 1 && v <= 8192;
				if (!ok(pass.size.width) || !ok(pass.size.height)) at(`pass ${i}: size must be integers 1…8192`);
			}
		} else if (pass.update) at(`pass ${i}: the last pass cannot update an output`);
		for (const k of Object.keys(pass.uniforms ?? {}))
			if (!/^u_[A-Za-z][A-Za-z0-9_]*$/.test(k)) at(`pass ${i}: uniform "${k}" must be named u_<name>`);
		for (const c of resolveIncludes(pass.include))
			if (typeof c.source !== 'string' || !c.name) at(`pass ${i}: malformed include`);
	});
	if (outputs.size + textures > FX_MAX_TEXTURES)
		at(`more than ${FX_MAX_TEXTURES} textures (outputs + media params)`);
	try {
		const globals = Object.keys(gpu.uniforms?.(defaults, ctx) ?? {});
		for (const k of globals)
			if (!/^u_[A-Za-z][A-Za-z0-9_]*$/.test(k)) at(`uniform "${k}" must be named u_<name>`);
		for (const m of uniformCollisions({
			reserved: RESERVED,
			params: spec.params,
			outputs,
			globals,
			passes: passes.map((pass) => Object.keys(pass.uniforms ?? {})),
		}))
			at(m);
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
