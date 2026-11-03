// Spec 19 §5: the pass plan of a look at one frame (TL-030). From the appearance resolved at the frame:
//   1. alpha bounds (when something reads them): a reduction of the input to one texel;
//   2. the shape field (TL-031): sub-pixel edge seeds → jump flood → signed distance, `rgba16f`, one per instance;
//   3. the composite: one pass per layer into `tlComp` (`rgba16f`, linear light, premultiplied, TL-032), with a blur
//      and any prepass before it; every layer pass is the same program for the same type, paint kind and finish;
//   4. the last pass encodes the composite back to the framework's signal.
// Padding (TL-033) is computed from the enabled layers across all frames of the clip by `appearanceClipReach`.
import { FLICKS_PER_SECOND } from '../../../time.ts';
import type { Appearance, LayerParamValue, Paint } from '../../../title-looks/model.ts';
import {
	appearanceAnimatables,
	appearanceAnimated,
	type ResolvedAppearance,
	resolveAppearance,
} from '../../../title-looks/resolve.ts';
import { mediaParamId } from '../../param-values.ts';
import type {
	FxFrameContext,
	FxPadding,
	FxPlanContext,
	FxUniformValue,
	GlslChunk,
	ShaderPass,
} from '../shader.ts';
import { FX_MAX_PADDING, resolveIncludes } from '../shader.ts';
import {
	FILLED_DEPTH,
	isPaintParam,
	type LayerFieldReach,
	type LayerParams,
	type LayerReach,
	type PrepassContext,
	type TitleLayerType,
	type TitleParamSpec,
} from './contract.ts';
import {
	FRAG_TL_BLUR_H,
	FRAG_TL_BLUR_V,
	FRAG_TL_BOUNDS_FIRST,
	FRAG_TL_BOUNDS_NEXT,
	FRAG_TL_CLEAR,
	FRAG_TL_FIELD,
	FRAG_TL_FLOOD,
	FRAG_TL_OUTPUT,
	FRAG_TL_SEED,
	GLSL_TL_ALPHA,
	GLSL_TL_BOUNDS,
	GLSL_TL_FIELD,
	GLSL_TL_SURFACE,
	GLSL_TL_UNIT_BOUNDS,
	GLSL_TL_UNIT_KNOWN,
} from './glsl.ts';
import { paintOf, paintParts } from './paint.ts';
import { activeParamSpecs, titleFinish, titleLayerType, withDefaults } from './registry.ts';
import { type FxTextSpans, GLSL_TL_SPAN_FINISH, textSpanPass, textSpanUniforms } from './spans.ts';

/** `FxStructures.titleLook`: what a look instance needs at a frame. */
export type FxTitleLook = {
	/** The appearance at this frame. */
	appearance: ResolvedAppearance;
	/** The stored appearance (padding across the clip). */
	source?: Appearance;
	/** TL-012: the text size in layer px; null = the shorter side of the alpha bounds, read by the shaders. */
	unitPx: number | null;
	/** Content seconds at this frame: continuous across razor cuts, unlike `u_frame` (TL-035). */
	contentSeconds: number;
	/** The clip's content time span, for padding across every frame (flicks, inclusive; absent = keys only). */
	span?: { from: number; to: number; frames: number };
	/** TL-036: the text layer's glyph and line boxes at this frame; absent on other clips (spans act as `block`). */
	textSpans?: FxTextSpans | null;
	/**
	 * The look's stage: the layer's x and y axes on screen at this frame, unit vectors `[xx, xy, yx, yy]`
	 * (`lookOrientation`). Lights, environments and shadow directions stay fixed on screen. Absent = upright.
	 */
	orient?: LookOrientation | null;
	/** The layer turns or mirrors at some frame of the clip: padding is the same on every side (`clipLookTurns`). */
	turns?: boolean;
};

/** The layer's x and y axes on screen, unit vectors: `[xx, xy, yx, yy]`. */
export type LookOrientation = readonly [number, number, number, number];

/**
 * The rotation and mirroring of a layer map (`x' = a·x + c·y + e`, `y' = b·x + d·y + f`): the orthogonal part of its
 * linear part (polar decomposition), so scale and skew do not tilt the light. Null = upright, or no orientation at all.
 */
export function lookOrientation(
	m: { a: number; b: number; c: number; d: number } | null | undefined,
): LookOrientation | null {
	if (!m || ![m.a, m.b, m.c, m.d].every(Number.isFinite)) return null;
	const mirrored = m.a * m.d - m.b * m.c < 0;
	// Mirrored: the rotation of the map with its y axis flipped, then the flip.
	const y = mirrored ? m.b + m.c : m.b - m.c;
	const x = mirrored ? m.a - m.d : m.a + m.d;
	if (x === 0 && y === 0) return null;
	if (y === 0 && x > 0 && !mirrored) return null;
	const t = Math.atan2(y, x);
	const cos = Math.cos(t);
	const sin = Math.sin(t);
	return mirrored ? [cos, sin, sin, -cos] : [cos, sin, -sin, cos];
}

/**
 * The layer may turn or mirror somewhere in the clip (rotation keyed, driven, not upright, or a flip): its look's directions
 * then move in the layer from frame to frame, so its canvas is padded alike on every side and keeps its size.
 */
export function clipLookTurns(clip: { transform?: unknown }): boolean {
	const t = clip.transform as
		| {
				rotation?: { value?: unknown; keyframes?: unknown[]; expression?: { enabled?: boolean } };
				flipH?: boolean;
				flipV?: boolean;
		  }
		| null
		| undefined;
	if (!t) return false;
	const r = t.rotation;
	return (
		t.flipH === true ||
		t.flipV === true ||
		(r?.keyframes?.length ?? 0) > 0 ||
		r?.expression?.enabled === true ||
		num(r?.value) % 360 !== 0
	);
}

const DEG = Math.PI / 180;
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const PASS_THROUGH: readonly ShaderPass[] = [
	{ frag: /* glsl */ `void main() { fragColor = texture(u_source, v_uv); }` },
];

/** Padding around the reach (an antialiased edge and a sampled blur tail), layer px. */
const PADDING_GUARD = 4;
/**
 * Sigma in texels a blur runs at. Blurs run at the lowest power-of-two resolution that keeps this much: about 12 taps per
 * side for any radius at any size, and because the level follows the sigma, 200 % draws what 100 % drew. Measured
 * (docs/performance.md §7): a full-resolution blur was two thirds of a 1080p frame.
 */
const BLUR_TARGET_SIGMA = 2;

type PlannedLayer = {
	def: TitleLayerType;
	id: string;
	params: LayerParams;
	/** Silhouette growth of the layers above, percent of the unit. */
	base: number;
	/** TL-051: colourways leave this layer alone. */
	fixedColor: boolean;
};

/** TL-093: a layer drawn again with a finish runs give some letters, for the letters of span slot `slot`. */
type LetterFinish = { slot: number; layer: PlannedLayer };

/**
 * The finishes runs give letters of a `letterFinish` layer (the face), other than its own: each one draws the layer with
 * that finish where the owner pass says the pixel is one of those letters. Unknown ids are repaired away on load.
 */
function letterFinishes(l: PlannedLayer, spans: FxTextSpans | null | undefined): LetterFinish[] {
	if (!l.def.letterFinish || !l.def.finish || !spans?.finishes.length) return [];
	const own = String(l.params.finish ?? 'flat');
	const out: LetterFinish[] = [];
	spans.finishes.forEach((id, k) => {
		if (id !== own && titleFinish(id))
			out.push({ slot: k + 1, layer: { ...l, params: { ...l.params, finish: id } } });
	});
	return out;
}

/** The enabled layers of known types, bottom-first, with the growth above each. */
function plannedLayers(look: ResolvedAppearance): PlannedLayer[] {
	const out: PlannedLayer[] = [];
	let base = 0;
	for (let i = look.layers.length - 1; i >= 0; i--) {
		const l = look.layers[i]!;
		const def = titleLayerType(l.type);
		if (!def) continue; // INV-APPEARANCE: repair removes unknown types when a project loads.
		const params = withDefaults(def, l.params);
		out.unshift({ def, id: l.id, params, base, fixedColor: l.fixedColor === true });
		base += Math.max(0, num(def.grows?.(params)));
	}
	for (const l of out) if (l.def.outermost) l.base = base;
	return out;
}

const sides = (r: LayerReach | undefined) =>
	typeof r === 'number' || r === undefined
		? { left: r ?? 0, top: r ?? 0, right: r ?? 0, bottom: r ?? 0, boxHeight: 0 }
		: r;

/** Padding in percent of the unit, and the fraction of the layer box's height left and right (`LayerReach`). */
export type LookPadding = FxPadding & { boxHeight: number };

/** Everything a resolved look reaches, percent of the unit: per side, and how far the field must be right. */
export function lookReach(look: ResolvedAppearance): LookPadding & LayerFieldReach {
	const r = { left: 0, top: 0, right: 0, bottom: 0, boxHeight: 0, outside: 0, inside: 0 };
	for (const { def, params, base } of plannedLayers(look)) {
		const s = sides(def.reach?.(params));
		r.left = Math.max(r.left, base + num(s.left));
		r.top = Math.max(r.top, base + num(s.top));
		r.right = Math.max(r.right, base + num(s.right));
		r.bottom = Math.max(r.bottom, base + num(s.bottom));
		r.boxHeight = Math.max(r.boxHeight, num(s.boxHeight));
		const fr = def.fieldReach?.(params) ?? {};
		const widest = Math.max(num(s.left), num(s.top), num(s.right), num(s.bottom));
		r.outside = Math.max(r.outside, base + (fr.outside ?? widest));
		r.inside = Math.max(r.inside, num(fr.inside));
		const fin = def.finish ? titleFinish(String(params.finish)) : undefined;
		const fi = fin?.fieldReach?.(params) ?? {};
		r.outside = Math.max(r.outside, base + num(fi.outside));
		r.inside = Math.max(r.inside, num(fi.inside));
	}
	return r;
}

/** Most frames sampled for padding per clip (key times always count): bounds the work on hour-long clips. */
const MAX_REACH_SAMPLES = 4096;
const reachCache = new WeakMap<object, { key: string; reach: LookPadding }>();

/**
 * TL-033: the reach of a look across every frame of its clip (percent of the unit per side), so glows and shadows never
 * clip and the canvas does not change size from frame to frame. Cached per stored appearance.
 */
export function appearanceClipReach(a: Appearance, span?: FxTitleLook['span']): LookPadding {
	const key = span ? `${span.from}:${span.to}:${span.frames}` : '';
	const hit = reachCache.get(a);
	if (hit?.key === key) return hit.reach;
	const times = new Set<number>();
	for (const anim of appearanceAnimatables(a)) for (const k of anim.keyframes) times.add(k.time);
	if (span) {
		const n = Math.min(Math.max(1, span.frames), MAX_REACH_SAMPLES);
		for (let i = 0; i < n; i++) times.add(span.from + ((span.to - span.from) * i) / Math.max(1, n - 1));
	}
	if (times.size === 0 || !appearanceAnimated(a)) times.add(span?.from ?? 0);
	else if (!span) {
		// Keys alone: an ease overshoots between keys, sample each segment.
		const sorted = [...times].sort((x, y) => x - y);
		for (let i = 0; i + 1 < sorted.length; i++)
			for (let k = 1; k < 16; k++) times.add(sorted[i]! + ((sorted[i + 1]! - sorted[i]!) * k) / 16);
	}
	const r: LookPadding = { left: 0, top: 0, right: 0, bottom: 0, boxHeight: 0 };
	for (const t of times) {
		const x = lookReach(resolveAppearance(a, t));
		r.left = Math.max(r.left, x.left);
		r.top = Math.max(r.top, x.top);
		r.right = Math.max(r.right, x.right);
		r.bottom = Math.max(r.bottom, x.bottom);
		r.boxHeight = Math.max(r.boxHeight, x.boxHeight);
	}
	reachCache.set(a, { key, reach: r });
	return r;
}

/** Layer px per percent of the unit: exact for text, an upper bound otherwise (the alpha bounds lie in the box). */
function layerPxPerPercent(tl: FxTitleLook, ctx: Pick<FxPlanContext, 'width' | 'height'>): number {
	return (tl.unitPx ?? Math.min(ctx.width, ctx.height)) * 0.01;
}

/** `gpu.padding`: the reach across the clip in layer px, whole pixels (the DOM picture sits at the padding). */
export function titleLookPadding(ctx: FxPlanContext): Partial<FxPadding> {
	const tl = ctx.structures?.titleLook;
	if (!tl) return {};
	let r = tl.source ? appearanceClipReach(tl.source, tl.span) : lookReach(tl.appearance);
	if (tl.turns || tl.orient) {
		// Directions fixed on screen turn in the layer: every side as far as the farthest.
		const m = Math.max(r.left, r.top, r.right, r.bottom);
		r = { ...r, left: m, top: m, right: m, bottom: m };
	}
	const k = layerPxPerPercent(tl, ctx);
	const px = (v: number) => (v > 0 ? Math.ceil(v * k) + PADDING_GUARD : 0);
	const lean = Math.ceil(r.boxHeight * ctx.height);
	return { left: px(r.left) + lean, top: px(r.top), right: px(r.right) + lean, bottom: px(r.bottom) };
}

/**
 * A look layer (a generator's `extent`, Shockwave's radius…) that reaches past the effect canvas's limit at this unit:
 * its own reach, layer px, and the limit (`FX_MAX_PADDING` per side), or null when it fits. Past the limit the drawing
 * fades out at the canvas edge, the same in Program and in every export (docs/gaps.md); the generator's inspector says so.
 */
export function lookLayerReachCut(
	type: string,
	params: Record<string, unknown>,
	unitPx: number,
): { reachPx: number; limitPx: number } | null {
	const def = titleLayerType(type);
	if (!def?.reach || !(unitPx > 0) || !Number.isFinite(unitPx)) return null;
	const s = sides(def.reach(withDefaults(def, params as LayerParams)));
	const widest = Math.max(num(s.left), num(s.top), num(s.right), num(s.bottom));
	const reachPx = Math.ceil(widest * unitPx * 0.01) + PADDING_GUARD;
	return Number.isFinite(reachPx) && reachPx > FX_MAX_PADDING ? { reachPx, limitPx: FX_MAX_PADDING } : null;
}

/**
 * TL-033: how far a look draws outside the layer box across the clip (largest side, layer px), for the layer bake's
 * crop. Null = not known ahead (an expression drives something, so the bake keeps the full frame).
 */
export function titleLookBleed(
	a: Appearance | undefined,
	clip: { source?: unknown; intrinsicBox: { width: number; height: number } },
): number | null {
	if (!a) return 0;
	for (const anim of appearanceAnimatables(a)) if (anim.expression?.enabled) return null;
	const r = appearanceClipReach(a);
	const k = (clipLookUnit(clip) ?? Math.min(clip.intrinsicBox.width, clip.intrinsicBox.height)) * 0.01;
	const lean = Math.ceil(r.boxHeight * clip.intrinsicBox.height);
	return Math.ceil(Math.max(r.left, r.top, r.right, r.bottom) * k) + PADDING_GUARD + lean;
}

/** The input's alpha bounds as one texel `u_tlBounds`, canvas px. Fixed steps: 8⁵ covers the largest canvas. */
function boundsPasses(): ShaderPass[] {
	const fmt = { format: 'rgba32f', filter: 'nearest' } as const;
	return [
		{ output: 'tlBounds', frag: FRAG_TL_BOUNDS_FIRST, scale: 1 / 8, ...fmt },
		{ output: 'tlBounds', update: true, frag: FRAG_TL_BOUNDS_NEXT, scale: 1 / 64, ...fmt },
		{ output: 'tlBounds', update: true, frag: FRAG_TL_BOUNDS_NEXT, scale: 1 / 512, ...fmt },
		{ output: 'tlBounds', update: true, frag: FRAG_TL_BOUNDS_NEXT, scale: 1 / 4096, ...fmt },
		{ output: 'tlBounds', update: true, frag: FRAG_TL_BOUNDS_NEXT, size: { width: 1, height: 1 }, ...fmt },
	];
}

/**
 * The shape field (TL-031). `reachPx`: canvas px the field must be right to; flood steps start at the power of two
 * that covers it (steps sum to at least the reach), then one extra step of 1 (JFA+1) mends the residual errors.
 */
function fieldPasses(reachPx: number): ShaderPass[] {
	const fmt = { format: 'rgba32f', filter: 'nearest' } as const;
	const out: ShaderPass[] = [{ output: 'tlFlood', frag: FRAG_TL_SEED, include: [GLSL_TL_ALPHA], ...fmt }];
	const top = 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(2, reachPx + 1))) - 1);
	for (let s = top; s >= 1; s /= 2)
		out.push({
			output: 'tlFlood',
			update: true,
			frag: FRAG_TL_FLOOD,
			uniforms: { u_tlStep: s },
			...fmt,
		});
	out.push({ output: 'tlFlood', update: true, frag: FRAG_TL_FLOOD, uniforms: { u_tlStep: 1 }, ...fmt });
	out.push({
		output: 'tlField',
		frag: FRAG_TL_FIELD,
		include: [GLSL_TL_ALPHA],
		format: 'rgba16f',
		uniforms: { u_tlReach: reachPx + 2 },
	});
	return out;
}

/** A hold-only or numeric param as a pass uniform (`u_<name>`), like effect params (`paramUniforms`). */
function paramUniform(p: TitleParamSpec, v: LayerParamValue): FxUniformValue | null {
	if (p.type === 'number') return num(v, num(p.default));
	if (p.type === 'boolean') return v === true;
	if (p.type === 'enum') return { int: Math.max(0, (p.options ?? []).indexOf(String(v))) };
	if ((p.type === 'vec2' || p.type === 'color') && Array.isArray(v))
		return v as unknown as readonly [number, number];
	return null;
}

type LayerPieces = {
	/** Media params: `#define`s from `u_<name>` to this layer's own sampler (two layers may use one param name). */
	defines: string;
	textures: { uniform: string; mediaId: string }[];
	glsl: string;
	uniforms: Record<string, FxUniformValue>;
	include: GlslChunk[];
	usesBounds: boolean;
	/** A paint reads the owner of each pixel (`line` and `glyph` spans). */
	usesSpans: boolean;
	fieldInside: number;
};

/** Uniforms and GLSL of one layer's params, paints and finish. */
function layerPieces(
	l: PlannedLayer,
	look: ResolvedAppearance,
	index: number | string,
	spans?: FxTextSpans | null,
): LayerPieces {
	const finishId = String(l.params.finish ?? 'flat');
	const uniforms: Record<string, FxUniformValue> = { u_tlBase: l.base };
	let glsl = '';
	let defines = '';
	const textures: LayerPieces['textures'] = [];
	const include: GlslChunk[] = [];
	let usesBounds = false;
	let usesSpans = false;
	let fieldInside = 0;
	for (const p of activeParamSpecs(l.def, finishId)) {
		const v = l.params[p.name];
		if (isPaintParam(p)) {
			const parts = paintParts(
				p.name,
				paintOf(v as LayerParamValue, p.default as Paint),
				num(l.params[`${p.name}Angle`]),
				look.palette,
				spans,
			);
			glsl += parts.glsl;
			Object.assign(uniforms, parts.uniforms);
			include.push(...parts.include);
			usesBounds ||= parts.usesBounds;
			usesSpans ||= parts.usesSpans;
			fieldInside = Math.max(fieldInside, parts.fieldInside);
			continue;
		}
		if (p.type === 'media') {
			const uniform = `u_tlm${index}_${p.name}`;
			defines += `#define u_${p.name} ${uniform}\n#define u_${p.name}_size ${uniform}_size\n`;
			textures.push({ uniform, mediaId: mediaParamId(v as never) });
			continue;
		}
		const u = v === undefined ? null : paramUniform(p, v);
		if (u !== null) uniforms[`u_${p.name}`] = u;
	}
	const finish = l.def.finish ? titleFinish(finishId) : undefined;
	if (finish) {
		defines += finish.defines?.(l.params) ?? '';
		glsl += `${finish.glsl}\n`;
		include.push(...(finish.include ?? []));
		Object.assign(uniforms, finish.uniforms?.(l.params));
	}
	// TL-051: a generator recolours through its own paint (`registry.ts`) unless the look fixes the layer's colour.
	if (l.def.recolors) uniforms.u_tlRecolor = !l.fixedColor;
	Object.assign(uniforms, l.def.uniforms?.(l.params));
	return { defines, textures, glsl, uniforms, include, usesBounds, usesSpans, fieldInside };
}

/** Passes of a look instance at a frame. */
export function planTitleLook(ctx: FxPlanContext): readonly ShaderPass[] {
	const tl = ctx.structures?.titleLook;
	if (!tl) return PASS_THROUGH;
	const look = tl.appearance;
	const layers = plannedLayers(look);
	if (layers.length === 0) return PASS_THROUGH;
	const pxPerPercent = layerPxPerPercent(tl, ctx) * ctx.pxScale;
	const unit: GlslChunk = tl.unitPx !== null ? GLSL_TL_UNIT_KNOWN : GLSL_TL_UNIT_BOUNDS;
	const reach = lookReach(look);
	const pieces = layers.map((l, i) => layerPieces(l, look, i, tl.textSpans));
	const letters = layers.map((l) => letterFinishes(l, tl.textSpans));
	const letterPieces = letters.map((ls, i) =>
		ls.map((x) => layerPieces(x.layer, look, `${i}r${x.slot}`, tl.textSpans)),
	);
	let fieldOutside = reach.outside;
	let fieldInside = Math.max(reach.inside, ...pieces.map((p) => p.fieldInside));
	for (const x of letters.flat()) {
		const fi = titleFinish(String(x.layer.params.finish))?.fieldReach?.(x.layer.params) ?? {};
		fieldOutside = Math.max(fieldOutside, x.layer.base + num(fi.outside));
		fieldInside = Math.max(fieldInside, num(fi.inside));
	}
	for (const p of letterPieces.flat()) fieldInside = Math.max(fieldInside, p.fieldInside);
	const reachPx = Math.min(
		(ctx.width + ctx.height) * ctx.pxScale,
		Math.max(4, Math.max(fieldOutside, fieldInside) * pxPerPercent + 2),
	);
	const blurred = layers.map((l) => l.def.blur?.(l.params, { look, pxPerPercent, base: l.base }) ?? null);
	const shaders = layers.map((l) => l.def.shader(l.params, { look, pxPerPercent, base: l.base }));
	const readsBounds = (s: string) => /\btl_bounds\s*\(/.test(s);
	const allPieces = [...pieces, ...letterPieces.flat()];
	const usesBounds =
		tl.unitPx === null ||
		layers.some((l) => l.def.prepassReadsBounds?.(l.params)) ||
		allPieces.some((p) => p.usesBounds || readsBounds(p.glsl)) ||
		allPieces.some((p) => resolveIncludes(p.include).some((c) => readsBounds(c.source))) ||
		shaders.some((s) => s.usesBounds === true || readsBounds(s.glsl)) ||
		blurred.some((b) => !!b && readsBounds(b.mask));
	const passes: ShaderPass[] = [];
	if (usesBounds) passes.push(...boundsPasses());
	passes.push(...fieldPasses(reachPx));
	if (tl.textSpans && (allPieces.some((p) => p.usesSpans) || letters.some((ls) => ls.length > 0)))
		passes.push(textSpanPass());
	passes.push({
		output: 'tlComp',
		frag: FRAG_TL_CLEAR,
		format: 'rgba16f',
		size: { width: 1, height: 1 },
	});
	const baseInclude = [unit, GLSL_TL_FIELD, ...(usesBounds ? [GLSL_TL_BOUNDS] : [])];
	let blurDone = false;
	const outer = (layers[0]?.base ?? 0) + Math.max(0, num(layers[0]?.def.grows?.(layers[0]!.params)));
	const written = new Set<string>();
	const write = (name: string): { update?: true } => {
		if (written.has(name)) return { update: true };
		written.add(name);
		return {};
	};
	const prepassContext = (l: PlannedLayer, piece: LayerPieces): PrepassContext => {
		const include = [...baseInclude, ...piece.include];
		return {
			look,
			pxPerPercent,
			base: l.base,
			include: baseInclude,
			uniforms: piece.uniforms,
			defines: piece.defines,
			depth: l.def.depth ?? FILLED_DEPTH,
			outer,
			unitKnown: tl.unitPx !== null,
			unit,
			surfacePass: (pass) => ({
				...pass,
				include: [...include, ...(pass.include ?? [])],
				uniforms: { ...piece.uniforms, ...pass.uniforms },
				frag: `${piece.defines}${piece.glsl}${pass.frag}`,
			}),
			write,
		};
	};
	layers.forEach((l, i) => {
		const piece = pieces[i]!;
		const include = [...baseInclude, ...piece.include];
		const c = prepassContext(l, piece);
		const blur = blurred[i];
		const finish = l.def.finish ? titleFinish(String(l.params.finish ?? 'flat')) : undefined;
		// A layer's own prepass first: a plate's distance must exist before a bevel on it.
		passes.push(...(l.def.prepass?.(l.params, c) ?? []));
		// TL-093: the letters runs give another finish, each drawn with it and summed into `tlRunFin` by their share of
		// each pixel, before the layer's own finish prepass (they may share its intermediates).
		const ls = letters[i]!;
		let runMask = 0;
		if (ls.length > 0) {
			passes.push({
				output: 'tlRunFin',
				frag: FRAG_TL_CLEAR,
				format: 'rgba16f',
				size: { width: 1, height: 1 },
				...write('tlRunFin'),
			});
			ls.forEach((x, k) => {
				const lp = letterPieces[i]![k]!;
				const fin = titleFinish(String(x.layer.params.finish));
				passes.push(...(fin?.prepass?.(x.layer.params, prepassContext(x.layer, lp)) ?? []));
				const sh = l.def.shader(x.layer.params, { look, pxPerPercent, base: l.base });
				passes.push({
					output: 'tlRunFin',
					update: true,
					format: 'rgba16f',
					include: [...baseInclude, ...lp.include, ...(sh.include ?? []), GLSL_TL_SPAN_FINISH],
					uniforms: { ...lp.uniforms, u_tlRunMask: { int: 1 << x.slot } },
					frag: `${lp.defines}${lp.glsl}${sh.glsl}
void main() { TlSurface s = tl_surface(); fragColor = texture(u_tlRunFin, v_uv) + tl_layer(s) * tl_runShare(s, u_tlRunMask); }`,
				});
				runMask |= 1 << x.slot;
			});
		}
		passes.push(...(finish?.prepass?.(l.params, c) ?? []));
		if (blur && blur.sigma > 0) {
			const again = blurDone ? { update: true } : {};
			const sigmaPx = blur.sigma * pxPerPercent;
			const level = Math.max(0, Math.floor(Math.log2(Math.max(1, sigmaPx / BLUR_TARGET_SIGMA))));
			// Without a known unit `sigmaPx` is an upper bound: three levels finer keep small alpha bounds sharp.
			const scale = 1 / 2 ** (tl.unitPx !== null ? level : Math.max(0, level - 3));
			passes.push({
				output: 'tlMask',
				format: 'rgba16f',
				scale,
				include: [...include, ...(blur.include ?? [])],
				uniforms: { ...piece.uniforms, u_tlMaskAA: 1 / scale },
				frag: `${piece.defines}${piece.glsl}${blur.mask}
void main() { tl_aa = u_tlMaskAA; fragColor = tl_mask(tl_surface()); }`,
				...again,
			});
			for (const [output, frag, dir] of [
				['tlBlurH', FRAG_TL_BLUR_H, [1, 0]],
				['tlBlur', FRAG_TL_BLUR_V, [0, 1]],
			] as const)
				passes.push({
					output,
					format: 'rgba16f',
					scale,
					include: [unit],
					uniforms: { u_tlBlurSigma: blur.sigma, u_tlBlurDir: dir },
					frag,
					...again,
				});
			blurDone = true;
		}
		const shader = shaders[i]!;
		passes.push({
			output: 'tlComp',
			update: true,
			format: 'rgba16f',
			...(runMask
				? {
						include: [...include, ...(shader.include ?? []), GLSL_TL_SPAN_FINISH],
						uniforms: { ...piece.uniforms, u_tlRunMask: { int: runMask } },
						frag: `${piece.defines}${piece.glsl}${shader.glsl}
void main() {
  TlSurface s = tl_surface();
  vec4 own = tl_layer(s) * (1.0 - tl_runShare(s, u_tlRunMask));
  fragColor = tl_over(texture(u_tlComp, v_uv), own + texture(u_tlRunFin, v_uv));
}`,
					}
				: {
						include: [...include, ...(shader.include ?? [])],
						uniforms: piece.uniforms,
						frag: `${piece.defines}${piece.glsl}${shader.glsl}
void main() { fragColor = tl_over(texture(u_tlComp, v_uv), tl_layer(tl_surface())); }`,
					}),
		});
	});
	passes.push({ include: [GLSL_TL_SURFACE], frag: FRAG_TL_OUTPUT });
	return passes;
}

/** Media pictures of a look's layers (`gpu.textures`, TL-021). */
export function titleLookTextures(ctx: FxPlanContext): readonly { uniform: string; mediaId: string }[] {
	const tl = ctx.structures?.titleLook;
	if (!tl) return [];
	return plannedLayers(tl.appearance).flatMap((l, i) => [
		...layerPieces(l, tl.appearance, i, tl.textSpans).textures,
		...letterFinishes(l, tl.textSpans).flatMap(
			(x) => layerPieces(x.layer, tl.appearance, `${i}r${x.slot}`, tl.textSpans).textures,
		),
	]);
}

/** Instance-wide uniforms of a look (`gpu.uniforms`). */
export function titleLookUniforms(ctx: FxFrameContext): Record<string, FxUniformValue> {
	const tl = ctx.structures?.titleLook;
	if (!tl) return {};
	const { angle, altitude } = tl.appearance.light;
	const az = angle * DEG;
	const el = altitude * DEG;
	// The light is on screen; the look shades in the layer: turn it back by the layer's rotation (and mirror).
	const [xx, xy, yx, yy] = tl.orient ?? [1, 0, 0, 1];
	const sx = Math.cos(az);
	const sy = Math.sin(az);
	const dir = [xx * sx + xy * sy, yx * sx + yy * sy];
	return {
		...(tl.unitPx !== null ? { u_tlUnit: tl.unitPx * ctx.pxScale } : {}),
		u_tlSeed: (tl.appearance.seed >>> 0) / 4294967296,
		// Only what moves on its own reads the time: a still look keeps one key and is not redrawn (TL-037).
		u_tlTime: appearanceTimeInvariant(tl.appearance) ? 0 : tl.contentSeconds,
		u_tlLight: [dir[0]! * Math.cos(el), dir[1]! * Math.cos(el), Math.sin(el)],
		u_tlLightDir: dir as unknown as readonly [number, number],
		u_tlStage: [xx, xy, yx, yy],
		...textSpanUniforms(tl.textSpans),
	};
}

/** Any enabled layer changes with time on its own (`gpu.timeInvariant`). */
export function appearanceTimeInvariant(a: unknown): boolean {
	const layers = (a as { layers?: { type: string; enabled?: boolean; params: unknown }[] } | undefined)
		?.layers;
	for (const l of layers ?? []) {
		if (l.enabled === false) continue;
		const def = titleLayerType(l.type);
		if (!def?.timeDependent) continue;
		if (def.timeDependent(withDefaults(def, heldParams(l.params)))) return false;
	}
	return true;
}

/** Evaluated params or stored Animatables, as plain values at their first state. */
function heldParams(params: unknown): Record<string, LayerParamValue> {
	const out: Record<string, LayerParamValue> = {};
	for (const [k, v] of Object.entries((params ?? {}) as Record<string, unknown>)) {
		const anim = v as { value?: LayerParamValue; keyframes?: unknown[] } | null;
		out[k] =
			anim && typeof anim === 'object' && 'keyframes' in anim
				? (anim.value as LayerParamValue)
				: (v as LayerParamValue);
	}
	return out;
}

/** The content time span of a clip's frames in flicks, for padding across the clip. */
export function clipLookSpan(
	clip: { duration: number; sourceIn: number; speed: { rate: number } },
	fps: number,
): { from: number; to: number; frames: number } {
	const F = FLICKS_PER_SECOND / (fps > 0 ? fps : 30);
	return {
		from: clip.sourceIn,
		to: clip.sourceIn + (clip.duration - 1) * F * clip.speed.rate,
		frames: clip.duration,
	};
}

/** TL-012: a clip's unit in layer px when the model knows it: the text size. Null = the alpha bounds (shaders). */
export function clipLookUnit(clip: { source?: unknown }): number | null {
	const text = (clip.source as { text?: { style?: { sizePx?: unknown } } } | undefined)?.text;
	const size = text?.style?.sizePx;
	return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : null;
}

/**
 * What a look's hooks read at a frame (`FxStructures.titleLook`). `contentTime`: flicks at this frame; `layerMap`: the
 * layer's map at this frame (`ResolvedLayerProps.matrix`), whose rotation the look's lights undo.
 */
export function titleLookStructure(
	appearance: ResolvedAppearance,
	source: unknown,
	clip: { source?: unknown; duration: number; sourceIn: number; speed: { rate: number } },
	fps: number,
	contentTime: number,
	textSpans?: FxTextSpans | null,
	layerMap?: { a: number; b: number; c: number; d: number } | null,
): FxTitleLook {
	const orient = lookOrientation(layerMap);
	const turns = clipLookTurns(clip as { transform?: unknown }) || orient !== null;
	return {
		appearance,
		...(source ? { source: source as Appearance } : {}),
		unitPx: clipLookUnit(clip),
		contentSeconds: contentTime / FLICKS_PER_SECOND,
		span: clipLookSpan(clip, fps),
		...(textSpans ? { textSpans } : {}),
		...(orient ? { orient } : {}),
		...(turns ? { turns } : {}),
	};
}
