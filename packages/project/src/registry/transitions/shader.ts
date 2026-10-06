// GPU transitions (wave-2 transition framework; authoring guide docs/wp-notes/fx-transition-framework.md). A GPU
// transition is ONE frame-space shader stage per transition that composites the two sides of an edit point: the
// outgoing clip "A" and the incoming clip "B", each the fully drawn layer (effects, crop, Motion, corner pin,
// opacity) placed in sequence space. The stage's first two passes are the framework's placement passes (they write
// `u_from` and `u_to`, sequence-sized and premultiplied); the transition's own passes follow and read either side at
// any position — luma dissolves, page peels showing B under A, cube spins, film burns all have both pictures. The
// output (sequence-sized) replaces both clips on their track for the transition span.
// This module is pure (no DOM, no GL): progress (Start/End %, Reverse), side placement matrices, planning (complete
// program sources, reusing the fx framework's `buildPassSource`) and validation. The compositions run the plans on
// the fx GPU host (packages/compositions/src/fx/transition.tsx), in the Player and in renders alike.

import { invertMat3, type Mat3, multiplyMat3 } from '../../render/homography.ts';
import type { TransitionSpec } from '../../transitions.ts';
import type { EffectParams } from '../effects.ts';
import {
	FX_BUILTIN_UNIFORMS,
	FX_MAX_TEXTURES,
	type FxEffectPlan,
	type FxPassPlan,
	type FxUniform,
	type FxUniformValue,
	fxBuiltinUniforms,
	hashString,
	paramUniforms,
	planPasses,
	planPassesKey,
	resolveIncludes,
	type ShaderPass,
	toUniform,
	uniformCollisions,
	uniformDeclaration,
} from '../fx/shader.ts';
import { GLSL_TRANSITION } from './glsl.ts';

// ---------------------------------------------------------------- types

/** What pass planning knows: the stage canvas (the sequence frame) and the transition length. */
export type TrPlanContext = {
	/** Sequence frame size in pixels (the stage canvas). */
	width: number;
	height: number;
	fps: number;
	/** Transition span length in frames. */
	duration: number;
};

/**
 * One side's tracker geometry at one frame of the span, in SEQUENCE pixels (through the side's layer map at that frame:
 * Motion and corner pin, as the side's picture is placed): a planar track's corners (TL, TR, BR, BL) or a point track's
 * point. `point` is the tracked centre in both cases (the planar quad's diagonal intersection).
 */
export type TrTrackFrame = {
	kind: 'planar' | 'point';
	corners: readonly [number, number][] | null;
	point: [number, number];
	/** Tracker confidence at that frame (0 = lost), 1 for an untracked reference. */
	confidence: number;
	/** From the samples (true) or the tracker's reference geometry (false: not tracked yet). */
	tracked: boolean;
};

/** A side's tracker over the transition span (`RenderTransition.tracks`): one frame per span frame. */
export type TrSideTrack = {
	trackerId: string;
	name: string;
	kind: 'planar' | 'point';
	frames: TrTrackFrame[];
};

/** Per-frame context of `GpuTransition.uniforms` (also the values behind the built-in uniforms). */
export type TrFrameContext = TrPlanContext & {
	/** Frame inside the transition span, 0 … duration − 1. */
	frame: number;
	/** Linear progress of the frame before Start/End % and Reverse (see `transitionLinearProgress`). */
	linear: number;
	/** `u_progress`: Start/End % applied; `1 − p` when Reverse swapped the sides. */
	progress: number;
	/** Deterministic 0..1 per transition instance (+ a `seed` param), `u_seed`. */
	seed: number;
	/** The Reverse option is on (`u_reverse`). With `reverse: 'swap'` the sides were swapped already. */
	reversed: boolean;
	/** `u_hasFrom` / `u_hasTo`: the side exists (false at a single clip edge: that side is transparent). */
	hasFrom: boolean;
	hasTo: boolean;
	/**
	 * The tracker of each side at this frame (after a Reverse swap: `from` is the side shown as u_from), null when the
	 * side's clip has no tracker. Absent outside a composition (catalogue checks, unit tests): treat as none.
	 */
	tracks?: { from: TrTrackFrame | null; to: TrTrackFrame | null };
};

/**
 * The GPU realization of a transition (`TransitionSpec.gpu`). Passes are fx `ShaderPass`es (same fields, same GLSL
 * rules); every pass can read `u_from` (A) and `u_to` (B) — the sides placed in the sequence frame — plus the
 * prelude, the fx built-ins (`u_progress`, `u_frame`, `u_seed`, `u_compSize`…) and `GLSL_TRANSITION`'s `tr_*`
 * helpers (always included). The last pass writes the stage's output (premultiplied, sequence-sized).
 */
export type GpuTransition = {
	passes: readonly ShaderPass[] | ((p: EffectParams, ctx: TrPlanContext) => readonly ShaderPass[]);
	/** Derived uniforms of every pass (e.g. a direction vector from an angle), declared from their values. */
	uniforms?(p: EffectParams, ctx: TrFrameContext): Readonly<Record<string, FxUniformValue>>;
	/**
	 * What the Reverse option does. `swap` (default): the transition plays from B to A backwards — the sides are
	 * swapped and `u_progress` = 1 − p, so an iris that opens on B closes on A, a push to the left pushes to the right
	 * (Premiere's Reverse). `custom`: nothing is swapped; the shader reads `u_reverse` itself.
	 */
	reverse?: 'swap' | 'custom';
};

/** How the two sides exist at an edit point: both (two-sided), or a fade at a clip's head (`in`) / tail (`out`). */
export type TransitionSides = 'both' | 'in' | 'out';

/** One side's picture as the stage receives it from the clip's layer (its fx canvas, see the compositions). */
export type TrSide = {
	/** The picture's size in pixels (the layer's fx canvas: box + padding, × pxScale). */
	width: number;
	height: number;
	/** Sequence px → picture px, row-major 3×3 (projective under a corner pin); see `sideCompToCanvas`. */
	compToCanvas: readonly number[];
	/** Layer opacity 0..1 (applied by the placement pass). */
	opacity: number;
};

/** A planned stage frame: the fx plan plus which side feeds each placement texture. */
export type TrStagePlan = {
	plan: FxEffectPlan;
	ctx: TrFrameContext;
	/** The side shown as `u_from` / `u_to` (after a Reverse swap), null = transparent. */
	fromSide: 'out' | 'in' | null;
	toSide: 'out' | 'in' | null;
	/** The built-in uniforms of the stage at this frame (u_seed included). */
	builtins: FxUniform[];
};

// ---------------------------------------------------------------- constants

/** Uniforms the transition framework declares in addition to the fx built-ins (normative list, see the guide). */
export const TR_BUILTIN_UNIFORMS = {
	u_from:
		'sampler2D — side A (outgoing clip) placed in the sequence frame, premultiplied; transparent when absent',
	u_to: 'sampler2D — side B (incoming clip) placed in the sequence frame, premultiplied; transparent when absent',
	u_hasFrom: 'bool — side A exists (false: a fade at the head of B)',
	u_hasTo: 'bool — side B exists (false: a fade at the tail of A)',
	u_trFrom: 'sampler2D — internal: the raw picture of side A (placement pass)',
	u_trTo: 'sampler2D — internal: the raw picture of side B (placement pass)',
	u_place: 'mat3 — internal: placement matrix of a placement pass',
	u_placeSize: 'vec2 — internal: picture size of a placement pass',
	u_placeOpacity: 'float — internal: layer opacity of a placement pass',
} as const;

/** Pass output names the framework uses (`from`, `to`). */
const RESERVED_OUTPUTS = new Set(['from', 'to', 'trFrom', 'trTo']);

const NAME_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const UNIFORM_RE = /^u_[A-Za-z][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------- progress

const finite = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Linear progress (0..1) of frame `frame` (0-based) of a `duration`-frame transition. Two-sided: `(f + 1) / (d + 1)`
 * — the same ramp as the built-in Cross Dissolve (never fully A or fully B inside the span). A fade at a clip's head
 * (`in`): `f / d` (the first frame is fully "from"); at a tail (`out`): `(f + 1) / d` (the last frame is fully "to").
 */
export function transitionLinearProgress(frame: number, duration: number, sides: TransitionSides): number {
	const d = Math.max(1, duration);
	if (sides === 'both') return clamp01((frame + 1) / (d + 1));
	if (sides === 'in') return clamp01(frame / d);
	return clamp01((frame + 1) / d);
}

/**
 * The timing of the span at a frame: the linear progress, or — with the Completion curve on (`useCompletion`, the
 * standard "Custom Completion" option) — the keyframable Transition Completion (`completion`, 0…100 %) evaluated at
 * that frame, which replaces the linear ramp (Sapphire's Dissolve Percent / a keyframed transition completion).
 */
export function transitionTiming(params: EffectParams, linear: number): number {
	if (params.useCompletion === true) return clamp01(finite(params.completion, 0) / 100);
	return clamp01(linear);
}

/**
 * `u_progress` from the linear progress and the standard options (Premiere's Start / End sliders and Reverse):
 * `p = start + (end − start) · timing` (timing = the linear progress, or the Completion curve when it is on, see
 * `transitionTiming`); with Reverse and `reverse: 'swap'` the sides are swapped and the progress is `1 − p`.
 */
export function transitionProgress(
	gpu: Pick<GpuTransition, 'reverse'> | undefined,
	params: EffectParams,
	linear: number,
): { progress: number; swapped: boolean; reversed: boolean } {
	const s = clamp01(finite(params.startPercent, 0) / 100);
	const e = clamp01(finite(params.endPercent, 100) / 100);
	const p = s + (e - s) * transitionTiming(params, linear);
	const reversed = params.reverse === true;
	if (reversed && (gpu?.reverse ?? 'swap') === 'swap') return { progress: 1 - p, swapped: true, reversed };
	return { progress: p, swapped: false, reversed };
}

/** `u_seed` of a transition instance: a 0..1 hash of its id (+ a numeric `seed` param). */
export function transitionSeed(transitionId: string, params?: EffectParams): number {
	const s = params && typeof params.seed === 'number' && Number.isFinite(params.seed) ? params.seed : 0;
	return hashString(`${transitionId}\u0000transition\u0000${s}`) / 4294967296;
}

// ---------------------------------------------------------------- placement

/**
 * Sequence px → picture px of a side: the inverse of the layer map (layer px → sequence px, row-major, as
 * `layerMapOf`) followed by the fx canvas layout (the picture is the layer box grown by `padding` layer px, at
 * `pxScale` picture px per layer px). Null when the layer map is degenerate (scale 0: the side is invisible).
 */
export function sideCompToCanvas(
	layerToComp: readonly number[],
	layout: { padding: { left: number; top: number }; pxScale: number },
): number[] | null {
	const inv = invertMat3(layerToComp.slice(0, 9) as Mat3);
	if (!inv) return null;
	const s = layout.pxScale;
	const canvas: Mat3 = [s, 0, s * layout.padding.left, 0, s, s * layout.padding.top, 0, 0, 1];
	return multiplyMat3(canvas, inv);
}

/** Placement pass of one side: picture → sequence frame (projective, edge-antialiased, × opacity). */
function placementPass(side: 'From' | 'To', s: TrSide | null): ShaderPass {
	const m = s?.compToCanvas ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
	return {
		output: side === 'From' ? 'from' : 'to',
		frag: /* glsl */ `
void main() {
  // No early returns before the derivatives (fwidth, texture) so they stay in uniform control flow.
  vec3 q = u_place * vec3(v_uv * u_compSize, 1.0);
  float w = abs(q.z) < 1e-6 ? 1e-6 : q.z;
  vec2 c = q.xy / w;
  // Coverage of the picture's edges over this output pixel (antialiased layer edges, as the CSS transform draws them).
  vec2 fw = max(fwidth(c), vec2(1e-4));
  vec2 e = min(c, u_placeSize - c) / fw;
  bool live = q.z > 1e-6 && u_tr${side}_size.x > 0.0 && u_placeSize.x > 0.0;
  float cov = live ? clamp(min(e.x, e.y) + 0.5, 0.0, 1.0) : 0.0;
  vec4 px = texture(u_tr${side}, c / max(u_placeSize, vec2(1.0)));
  fragColor = px * (cov * clamp(u_placeOpacity, 0.0, 1.0));
}`,
		uniforms: {
			// GLSL mat3 is column-major; ours is row-major.
			u_place: { mat3: [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!] },
			u_placeSize: [s?.width ?? 0, s?.height ?? 0],
			u_placeOpacity: s ? clamp01(s.opacity) : 0,
		},
	};
}

// ---------------------------------------------------------------- planning

/** The author passes of a transition. */
export function transitionPasses(
	gpu: GpuTransition,
	p: EffectParams,
	ctx: TrPlanContext,
): readonly ShaderPass[] {
	return typeof gpu.passes === 'function' ? gpu.passes(p, ctx) : gpu.passes;
}

const declaration = uniformDeclaration;

/**
 * Plans one frame of a GPU transition: progress (Start/End %, Reverse), the two placement passes (`from`, `to`) and
 * the transition's passes, complete program sources, uniforms (params + `gpu.uniforms` + `u_hasFrom/u_hasTo`) and
 * the built-ins of the stage (u_progress, u_frame = frame in the span, u_duration = span length, u_side = 0,
 * u_box = the whole frame, u_layerToComp = identity, u_seed).
 */
export function planGpuTransition(
	spec: Pick<TransitionSpec, 'id' | 'version' | 'params' | 'gpu'>,
	inst: {
		id: string;
		params: EffectParams;
		/** Frame inside the span (0-based) and the span length. */
		frame: number;
		duration: number;
		sides: TransitionSides;
		/** The sides' trackers over the span (`RenderTransition.tracks`); absent = none. */
		tracks?: { out?: TrSideTrack | null; in?: TrSideTrack | null } | null;
	},
	comp: { width: number; height: number; fps: number },
	pictures: { out: TrSide | null; in: TrSide | null },
): TrStagePlan {
	const gpu = spec.gpu;
	if (!gpu) throw new Error(`transition ${spec.id} has no gpu realization`);
	const p = inst.params;
	const linear = transitionLinearProgress(inst.frame, inst.duration, inst.sides);
	const { progress, swapped, reversed } = transitionProgress(gpu, p, linear);
	const outSide = inst.sides === 'in' ? null : 'out';
	const inSide = inst.sides === 'out' ? null : 'in';
	const fromSide = swapped ? inSide : outSide;
	const toSide = swapped ? outSide : inSide;
	const pick = (s: 'out' | 'in' | null) => (s ? pictures[s] : null);
	const from = pick(fromSide);
	const to = pick(toSide);
	const seed = transitionSeed(inst.id, p);
	const trackAt = (s: 'out' | 'in' | null): TrTrackFrame | null => {
		const tr = s ? inst.tracks?.[s] : null;
		if (!tr || tr.frames.length === 0) return null;
		return tr.frames[Math.min(tr.frames.length - 1, Math.max(0, Math.round(inst.frame)))] ?? null;
	};
	const ctx: TrFrameContext = {
		width: comp.width,
		height: comp.height,
		fps: comp.fps,
		duration: inst.duration,
		frame: inst.frame,
		linear,
		progress,
		seed,
		reversed,
		hasFrom: !!from,
		hasTo: !!to,
		tracks: { from: from ? trackAt(fromSide) : null, to: to ? trackAt(toSide) : null },
	};
	const uniforms = paramUniforms(spec, p);
	const custom = gpu.uniforms?.(p, ctx) ?? {};
	for (const [k, v] of Object.entries(custom)) uniforms.push(toUniform(k, v));
	uniforms.push(
		{ name: 'u_hasFrom', type: 'bool', value: [from ? 1 : 0] },
		{ name: 'u_hasTo', type: 'bool', value: [to ? 1 : 0] },
	);
	const textures = [
		{ param: 'trFrom', uniform: 'u_trFrom', mediaId: '' },
		{ param: 'trTo', uniform: 'u_trTo', mediaId: '' },
		// Image params (Gradient Wipe's custom gradient…): `uniform sampler2D u_<name>` + `vec2 u_<name>_size`, (0, 0)
		// when no image is bound — the same binding as effects' media params.
		...transitionMediaTextures(spec, p),
	];
	const authored = transitionPasses(gpu, p, ctx);
	if (authored.length === 0) throw new Error(`transition ${spec.id}: no passes`);
	const passes: ShaderPass[] = [
		placementPass('From', from),
		placementPass('To', to),
		...authored.map((pass) => ({ ...pass, include: [GLSL_TRANSITION, ...(pass.include ?? [])] })),
	];
	const canvas = { width: comp.width, height: comp.height };
	// Same pass planning as effects (absolute sizes, ping-pong `update` outputs, mipmaps, unused declarations dropped).
	const planned: FxPassPlan[] = planPasses(passes, {
		paramDecls: uniforms.map(declaration),
		textures: textures.map((t) => t.uniform),
		canvas,
	});
	const key = `${spec.id}@${spec.version}:${canvas.width}x${canvas.height}:${planPassesKey(planned)}`;
	const plan: FxEffectPlan = {
		fxId: inst.id,
		effectId: spec.id,
		canvas,
		passes: planned,
		uniforms,
		textures,
		key,
	};
	const builtins = fxBuiltinUniforms({
		canvas,
		box: { x: 0, y: 0, w: comp.width, h: comp.height },
		pxScale: 1,
		frame: inst.frame,
		fps: comp.fps,
		duration: inst.duration,
		transition: null,
		layerToComp: null,
		compSize: canvas,
	}).map((u) => (u.name === 'u_progress' ? { ...u, value: [progress] } : u));
	builtins.push({ name: 'u_seed', type: 'float', value: [seed] });
	return { plan, ctx, fromSide, toSide, builtins };
}

/**
 * The `media` params of a transition as plan textures (`u_<name>`), with the bound media id ('' = none). Transitions
 * take still images only (`mediaKinds: ['image']`).
 */
export function transitionMediaTextures(
	spec: Pick<TransitionSpec, 'params'>,
	params: EffectParams,
): { param: string; uniform: string; mediaId: string }[] {
	return spec.params
		.filter((ps) => ps.type === 'media')
		.map((ps) => {
			const v = params[ps.name] as { mediaId?: unknown } | undefined;
			return {
				param: ps.name,
				uniform: `u_${ps.name}`,
				mediaId: typeof v?.mediaId === 'string' ? v.mediaId : '',
			};
		});
}

// ---------------------------------------------------------------- validation

const RESERVED = new Set([...Object.keys(FX_BUILTIN_UNIFORMS), ...Object.keys(TR_BUILTIN_UNIFORMS)]);
const FORBIDDEN_GLSL: [RegExp, string][] = [
	[/#version/, 'must not contain #version (the framework adds it)'],
	[/\bprecision\s+(highp|mediump|lowp)\b/, 'must not declare precision (the prelude does)'],
	[/\bgl_FragColor\b/, 'uses gl_FragColor (GLSL ES 1.00); write fragColor'],
	[/\btexture2D\s*\(/, 'uses texture2D (GLSL ES 1.00); use texture()'],
	[/\bvarying\b/, 'uses varying (GLSL ES 1.00)'],
	[/\bout\s+vec4\s+fragColor\b/, 'declares fragColor (the prelude does)'],
	[/\buniform\s+sampler2D\s+u_(from|to)\b/, 'declares u_from/u_to (the framework does)'],
];

/**
 * Structural problems of a GPU transition spec (empty = valid). The transition catalogue test runs this over every
 * registered transition; GLSL is compiled by packages/compositions/test/transition-gl.test.ts.
 */
export function validateGpuTransition(spec: TransitionSpec): string[] {
	const out: string[] = [];
	const gpu = spec.gpu;
	if (!gpu) return out;
	const at = (m: string) => out.push(`${spec.id}: ${m}`);
	if (spec.appliesTo !== 'video') at('gpu transitions apply to video');
	if (spec.capabilities.preview !== 'webgl') at(`capabilities.preview must be 'webgl'`);
	if (!spec.capabilities.export.includes('remotion')) at(`capabilities.export must include 'remotion'`);
	if (spec.capabilities.export.includes('native')) at('gpu transitions have no native (ffmpeg) realization');
	const names = new Set<string>();
	for (const p of spec.params) {
		if (!NAME_RE.test(p.name)) at(`param "${p.name}": names are letters and digits, starting with a letter`);
		// A numeric `seed` param (`seedParam`) feeds the built-in u_seed (transitionSeed), it is no uniform of its own.
		const seed = p.name === 'seed' && p.type === 'number';
		if (RESERVED.has(`u_${p.name}`) && !seed) at(`param "${p.name}": u_${p.name} is a built-in uniform`);
		if (names.has(p.name)) at(`param "${p.name}" is declared twice`);
		names.add(p.name);
		if (p.type === 'enum' && !(p.options ?? []).includes(String(p.default)))
			at(`param "${p.name}": default is not one of its options`);
		if (p.type === 'curve' || p.type === 'string')
			at(`param "${p.name}": ${p.type} params are not supported by transitions`);
		if (p.type === 'media' && !(p.mediaKinds?.length && p.mediaKinds.every((k) => k === 'image')))
			at(`param "${p.name}": media params of transitions take images only (mediaKinds: ['image'])`);
		if (p.type === 'media' && p.animatable) at(`param "${p.name}": media params are hold-only`);
	}
	const ctx: TrFrameContext = {
		width: 1920,
		height: 1080,
		fps: 30,
		duration: 30,
		frame: 10,
		linear: 0.35,
		progress: 0.35,
		seed: 0.5,
		reversed: false,
		hasFrom: true,
		hasTo: true,
	};
	const defaults: EffectParams = Object.fromEntries(spec.params.map((p) => [p.name, p.default]));
	let passes: readonly ShaderPass[] = [];
	try {
		passes = transitionPasses(gpu, defaults, ctx);
	} catch (e) {
		at(`passes(defaults) threw: ${(e as Error).message}`);
	}
	if (passes.length === 0) at('no passes');
	const outputs = new Set<string>();
	passes.forEach((pass, i) => {
		const last = i === passes.length - 1;
		if (!/\bvoid\s+main\s*\(/.test(pass.frag)) at(`pass ${i}: no void main()`);
		if (!/\bfragColor\b/.test(pass.frag)) at(`pass ${i}: never writes fragColor`);
		for (const [re, msg] of FORBIDDEN_GLSL) if (re.test(pass.frag)) at(`pass ${i}: ${msg}`);
		if (pass.scale !== undefined && !(pass.scale > 0 && pass.scale <= 1))
			at(`pass ${i}: scale must be in (0, 1]`);
		if (!last) {
			const o = pass.output ?? `pass${i + 2}`;
			if (!NAME_RE.test(o)) at(`pass ${i}: output "${o}" must be letters and digits`);
			if (RESERVED_OUTPUTS.has(o)) at(`pass ${i}: output "${o}" is reserved by the framework`);
			if (outputs.has(o)) at(`pass ${i}: output "${o}" is used twice`);
			if (RESERVED.has(`u_${o}`) || names.has(o)) at(`pass ${i}: output "${o}" collides with a uniform`);
			outputs.add(o);
		}
		for (const k of Object.keys(pass.uniforms ?? {}))
			if (!UNIFORM_RE.test(k)) at(`pass ${i}: uniform "${k}" must be named u_<name>`);
		for (const c of resolveIncludes(pass.include))
			if (typeof c.source !== 'string' || !c.name) at(`pass ${i}: malformed include`);
	});
	// Two placement outputs + two side pictures are the framework's; image params take a texture unit each.
	const media = spec.params.filter((p) => p.type === 'media').length;
	if (outputs.size + media + 4 > FX_MAX_TEXTURES)
		at(`more than ${FX_MAX_TEXTURES - 4} named outputs + image params`);
	let globals: string[] = [];
	try {
		globals = Object.keys(gpu.uniforms?.(defaults, ctx) ?? {});
		for (const k of globals) if (!UNIFORM_RE.test(k)) at(`uniform "${k}" must be named u_<name>`);
	} catch (e) {
		at(`uniforms threw with default params: ${(e as Error).message}`);
	}
	// Extra uniforms must not redeclare a built-in, a param uniform or a pass output (the framework's placement
	// outputs `from` / `to` included: u_from / u_to are built-ins).
	for (const m of uniformCollisions({
		reserved: RESERVED,
		params: spec.params,
		outputs,
		globals,
		passes: passes.map((pass) => Object.keys(pass.uniforms ?? {})),
	}))
		at(m);
	return out;
}
