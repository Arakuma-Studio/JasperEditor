// Layer bake (M2, S11 §6): what a DOM layer is, when it is static, and the one-clip render documents its masters
// are rendered from. Pure functions over the render snapshot (no I/O), shared by the native extension, the
// preview route and the tests.
import {
	applyMat3,
	contentTimeAt,
	defaultEffectRegistry,
	type EffectRegistry,
	evaluateVectorShape,
	gpuIsTimeDependent,
	hasActiveExpression,
	hasEffectMasks,
	layerMapOf,
	maskExportRoute,
	type RenderSnapshot,
	type RenderVisualClip,
	resolveLayerProps,
	type Transform,
	textAnimatorsTimeVarying,
	textContentPad,
	textInkPad,
	vectorShapeBounds,
	vectorShapeIsTimeDependent,
} from '@jasper/project';
import { isLoweredLayer } from '../export/stream/lowered.ts';

/** Clip kinds whose pixels come from React/DOM in the composition (S11 §0 "DOM layer"). */
const DOM_KINDS: ReadonlySet<string> = new Set(['text', 'shape', 'motion-graphic', 'captions']);

/**
 * S11:LBK-001: a DOM layer — every text clip, every shape and motion-graphic clips rendered by Remotion
 * (`renderer: 'anime'`; the snapshot's `engine` comes from `clipEngines`, so fframes templates stay with the
 * fframes masters). Generic over the kinds' implementations: text animators, anime templates and shapes need no
 * change here.
 */
export function isDomLayer(c: Pick<RenderVisualClip, 'kind' | 'engine'>): boolean {
	// imports: Lottie animations and vector stills (SVG, PDF) are drawn by the composition (snapshot engine `remotion`).
	if ((c.kind === 'still' || c.kind === 'animated-image') && c.engine === 'remotion') return true;
	return DOM_KINDS.has(c.kind) && c.engine === 'remotion';
}

/** Native geometric effects: they commute with colour ops and need no extra crop bleed. */
const GEOMETRIC_EFFECTS: ReadonlySet<string> = new Set([
	'jasper.crop',
	'jasper.flip-horizontal',
	'jasper.flip-vertical',
	'jasper.corner-pin',
]);

/** Media kinds whose layers the bake renders like DOM layers when they carry browser-only effects (wave1c). */
const MEDIA_BAKE_KINDS: ReadonlySet<string> = new Set(['video', 'still', 'solid', 'animated-image']);

/**
 * wave1c: an enabled effect only the composition can draw (GPU shader effects, SVG/CSS-only effects such as the
 * Gaussian blur): not a colour op (ffmpeg LUTs), not crop/flips/corner pin; unknown effects do not count (they are
 * bypassed by every renderer, S01:FX-022).
 */
export function hasBrowserEffect(
	c: Pick<RenderVisualClip, 'effects'>,
	registry: EffectRegistry = defaultEffectRegistry,
): boolean {
	return c.effects.some((fx) => {
		if (!fx.enabled || GEOMETRIC_EFFECTS.has(fx.effectId)) return false;
		const spec = registry.get(fx.effectId, fx.effectVersion);
		return !!spec && spec.appliesTo === 'video' && !spec.color;
	});
}

/**
 * The layers the bake renders (S11:LBK-001, wave1c): every DOM layer, and media layers (video, still, solid, animated
 * image) with a browser-only effect — their whole layer (source, effects, Motion, opacity) becomes a straight-alpha
 * master overlaid natively, so a GPU effect no longer sends the whole export to Remotion.
 */
export function needsBake(
	c: Pick<RenderVisualClip, 'kind' | 'engine' | 'effects' | 'masks' | 'threeD'>,
	registry?: EffectRegistry,
): boolean {
	// A 3D layer is never baked alone (the planner routes 3D runs to the Remotion path).
	if (c.threeD) return false;
	return (
		isDomLayer(c) ||
		(MEDIA_BAKE_KINDS.has(c.kind) && (hasBrowserEffect(c, registry) || maskExportRoute(c) === 'bake'))
	);
}

/** True when the effect has a colour op (D-21): applied natively to DOM layers (S11:LBK-010). */
export function isColorEffect(
	fx: { effectId: string; effectVersion: number },
	registry: EffectRegistry = defaultEffectRegistry,
): boolean {
	return !!registry.get(fx.effectId, fx.effectVersion)?.color;
}

/**
 * The clip has enabled colour-op effects that ffmpeg applies (FIX-002: not baked by Remotion). wp masks: a clip with
 * effect masks keeps its whole stack in the bake (a masked colour effect mixes with its input, and ffmpeg could
 * only apply runs to the finished layer), so its colour effects are rendered by the composition.
 */
export function hasColorEffects(c: Pick<RenderVisualClip, 'effects'>, registry?: EffectRegistry): boolean {
	return !hasEffectMasks(c) && c.effects.some((fx) => fx.enabled && isColorEffect(fx, registry));
}

/**
 * LBK-010 applies a DOM layer's colour runs to the finished layer (after all its other effects). That equals the
 * stack order unless a colour effect sits *before* an effect that mixes pixels (e.g. a blur): then the plan warns.
 */
export function effectRunsOrderWarning(
	c: Pick<RenderVisualClip, 'effects' | 'name'>,
	registry?: EffectRegistry,
): string | null {
	let sawColor = false;
	for (const fx of c.effects) {
		if (!fx.enabled) continue;
		if (isColorEffect(fx, registry)) sawColor = true;
		else if (sawColor && !GEOMETRIC_EFFECTS.has(fx.effectId))
			return `"${c.name}": colour effects are applied after ${fx.effectId} on graphics layers`;
	}
	return null;
}

/**
 * True when any Animatable inside `v` has keyframes or an active expression (deep: Motion, opacity, effects, shape
 * props, params, a Source Text expression…): an expression is a function of time.
 */
function hasKeyframesDeep(v: unknown): boolean {
	if (!v || typeof v !== 'object') return false;
	if (Array.isArray(v)) return v.some(hasKeyframesDeep);
	const o = v as Record<string, unknown>;
	if (Array.isArray(o.keyframes) && o.keyframes.length > 0 && 'value' in o) return true;
	if (hasActiveExpression(o as { expression?: { text: string; enabled: boolean } })) return true;
	for (const x of Object.values(o)) if (hasKeyframesDeep(x)) return true;
	return false;
}

/**
 * S11:LBK-004 — a DOM layer is *static* (one PNG for its whole span) when nothing it draws depends on the frame:
 * - not an anime template (`motion-graphic`: always time-driven);
 * - no text animator (`source.animation`);
 * - no keyframes on any of its properties: Motion, opacity, effect params (incl. corner pin), shape props, any
 *   Animatable in the source (deep scan, so new animatable fields are covered without a change here);
 * - no time-varying effect: an enabled effect the registry does not know counts as time-varying (it may be).
 * Transition fades do not count: the builder applies them to the looped still. Call it on the clip *as baked*
 * (colour effects removed when ffmpeg applies them, LBK-010).
 */
export function isStaticLayer(
	c: Pick<RenderVisualClip, 'kind' | 'source' | 'transform' | 'opacity' | 'effects' | 'masks'>,
	registry: EffectRegistry = defaultEffectRegistry,
): boolean {
	if (c.kind === 'motion-graphic') return false;
	// A caption is one picture unless it pages or highlights the active word.
	if (c.kind === 'captions') {
		const cap = 'captions' in c.source ? c.source.captions : undefined;
		if (cap?.pages.length !== 1 || (cap.style.highlight?.mode ?? 'none') !== 'none') return false;
	}
	// Moving pictures are never one frame.
	if (c.kind === 'video' || c.kind === 'animated-image') return false;
	const animation = 'animation' in c.source ? c.source.animation : undefined;
	if (animation?.in || animation?.out) return false;
	// Wiggly / Expression selectors vary with time without keyframes.
	if ('text' in c.source && textAnimatorsTimeVarying(c.source)) return false;
	if (hasKeyframesDeep(c.transform) || hasKeyframesDeep(c.opacity)) return false;
	if (hasKeyframesDeep(c.masks) || c.effects.some((fx) => fx.enabled && hasKeyframesDeep(fx.masks)))
		return false;
	for (const fx of c.effects) {
		if (!fx.enabled) continue;
		const spec = registry.get(fx.effectId, fx.effectVersion);
		if (!spec) return false;
		if (hasKeyframesDeep(fx.params)) return false;
		if (hasKeyframesDeep(fx.puppet)) return false;
		// A GPU shader effect that draws differently every frame (noise, flicker, time hooks,
		// a media param bound to a video — conservative here: any bound media param that accepts videos).
		const held = Object.fromEntries(Object.entries(fx.params).map(([k, a]) => [k, a.value]));
		if (gpuIsTimeDependent(spec, held)) return false;
	}
	// A vector shape with a self-animating Wiggle Paths (or keys / expressions in its contents).
	const shape = 'shape' in c.source ? c.source.shape : undefined;
	if (shape?.type === 'vector' && vectorShapeIsTimeDependent(shape.contents ?? [])) return false;
	return !hasKeyframesDeep(c.source);
}

/** First drawn and one-past-last sequence frame of a clip (transition handles included, S01:TRN-003). */
export function drawnSpan(c: Pick<RenderVisualClip, 'start' | 'duration' | 'headHandle' | 'tailHandle'>): {
	start: number;
	end: number;
} {
	return { start: c.start - (c.headHandle ?? 0), end: c.start + c.duration + (c.tailHandle ?? 0) };
}

export type Rect = { x: number; y: number; w: number; h: number };

export type BakeVariant =
	/** The whole drawn span, frame 0 = `start − headHandle`; transition fades baked in. */
	| { recipe: 'master' }
	/** Static layer: one frame for the whole span; no fades (the builder applies them). */
	| { recipe: 'still' }
	/** One frame of a non-static layer (stills, LBK-025): `frame` counted from the span start; fades baked. */
	| { recipe: 'frame'; frame: number }
	/**
	 * spec 13 AS-070: a lowered layer (`layerStill`): one frame of its layer region without Motion, Opacity and the
	 * lowered effects (the native kernel draws them per frame); no fades. `grow`: the region grown on every side (the
	 * layer drew past its content bleed, e.g. text overflowing an estimated box, see `layerStill`).
	 */
	| { recipe: 'layer-still'; grow?: true };

/**
 * The clip as the bake renders it: only enabled effects, colour effects removed when ffmpeg applies them
 * (LBK-010), times shifted so the drawn span starts at frame 0 (moving the clip in time keeps the render), and
 * for a static still a one-frame clip without handles or fades. `shift` moves the layer by whole pixels (crop to
 * `rect`, LBK-005): the Motion position (value and keyframes) is translated, which translates the whole layer map.
 */
export function bakeClip(
	c: RenderVisualClip,
	o: {
		variant: BakeVariant;
		stripColor: boolean;
		shift?: { x: number; y: number } | null;
		registry?: EffectRegistry;
	},
): RenderVisualClip {
	const span = drawnSpan(c);
	// wp masks: with effect masks nothing is stripped (see `hasColorEffects`).
	const strip = o.stripColor && !hasEffectMasks(c);
	const effects = c.effects.filter((fx) => fx.enabled && !(strip && isColorEffect(fx, o.registry)));
	const { headHandle, tailHandle, fades, ...rest } = c;
	let out: RenderVisualClip;
	if (o.variant.recipe === 'layer-still') return layerStillClip(c, o.registry, !!o.variant.grow);
	if (o.variant.recipe === 'still') out = { ...rest, effects, start: 0, duration: 1 };
	else
		out = {
			...rest,
			effects,
			start: c.start - span.start,
			...(headHandle ? { headHandle } : {}),
			...(tailHandle ? { tailHandle } : {}),
			...(fades?.length ? { fades: fades.map((f) => ({ ...f, start: f.start - span.start })) } : {}),
		};
	if (o.shift && (o.shift.x || o.shift.y) && out.transform) {
		out = { ...out, transform: shifted(out.transform, o.shift) };
		// Wave expressions: a Position expression's result is shifted by the binding (bindSnapshotExpressions).
		if (hasActiveExpression(out.transform!.position)) {
			const prev = c.expressionPositionShift ?? [0, 0];
			out = { ...out, expressionPositionShift: [prev[0] - o.shift.x, prev[1] - o.shift.y] };
		}
	}
	return out;
}

function shifted(t: Transform, s: { x: number; y: number }): Transform {
	const mv = (v: readonly number[]) => [v[0]! - s.x, v[1]! - s.y] as [number, number];
	return {
		...t,
		position: {
			...t.position,
			value: mv(t.position.value),
			keyframes: t.position.keyframes.map((k) => ({ ...k, value: mv(k.value) })),
		},
	};
}

const constant = <T>(value: T) => ({ value, keyframes: [] });

/**
 * spec 13 AS-070: the clip as a `layer-still` bake draws it — one frame, its layer region at 1 px per layer px with
 * the region's origin at (0, 0) of the bake frame: Motion is a translation by the bleed (no scale, rotation or flips),
 * Opacity 100 %, no lowered effects, no keyframes on what is left, no handles or fades.
 */
export function layerStillClip(
	c: RenderVisualClip,
	registry?: EffectRegistry,
	grow = false,
): RenderVisualClip {
	const pic = layerStill(c, registry, grow);
	const e = pic ? -pic.x : 0;
	const { headHandle: _h, tailHandle: _t, fades: _f, expressionPositionShift: _s, ...rest } = c;
	return {
		...rest,
		start: 0,
		duration: 1,
		effects: [],
		opacity: constant(100),
		transform: {
			position: constant([e, e] as [number, number]),
			anchor: constant([0, 0] as [number, number]),
			scale: constant(100),
			scaleWidth: constant(100),
			uniformScale: true,
			rotation: constant(0),
			flipH: false,
			flipV: false,
		},
	};
}

/**
 * spec 13 AS-070 — the layer region a text layer is baked as when its content is static but its picture moves
 * (keyframed Motion / Opacity, the Transform effect, S_Shake without motion blur or RGB split, `loweredRefusal`):
 * its box grown by the content bleed (strokes, shadow, ink) on every side, whole pixels, in layer px. Null = not a
 * lowered layer (static layers keep the `still` recipe, the rest a master).
 */
export function layerStill(
	c: RenderVisualClip,
	registry: EffectRegistry = defaultEffectRegistry,
	grow = false,
): { x: number; y: number; w: number; h: number } | null {
	if (!isDomLayer(c) || c.threeD || !isLoweredLayer(c)) return null;
	const bare: RenderVisualClip = {
		...c,
		effects: [],
		opacity: constant(100),
		...(c.transform
			? {
					transform: {
						...c.transform,
						position: constant(c.transform.position.value),
						anchor: constant(c.transform.anchor.value),
						scale: constant(c.transform.scale.value),
						scaleWidth: constant(c.transform.scaleWidth.value),
						rotation: constant(c.transform.rotation.value),
					},
				}
			: {}),
	};
	if (!isStaticLayer(bare, registry)) return null;
	const bleed = contentBleed(bare, registry);
	if (bleed === null || !Number.isFinite(bleed)) return null;
	// Grown: a quarter of the box and two font sizes more (an estimated box the glyphs overflow, a line that wraps) —
	// asked for after a clipped bake, and up front while the box is an estimate (`layoutPending`: made without a text
	// measurer), so a pipelined export does not restart for it.
	const size = 'text' in c.source ? Math.max(0, c.source.text.style.sizePx ?? 0) : 0;
	const pending = 'text' in c.source && !!c.source.layoutPending;
	const e =
		Math.ceil(Math.max(0, bleed)) +
		2 +
		(grow || pending ? Math.ceil(0.25 * Math.max(c.intrinsicBox.width, c.intrinsicBox.height) + 2 * size) : 0);
	const w = Math.ceil(c.intrinsicBox.width) + 2 * e;
	const h = Math.ceil(c.intrinsicBox.height) + 2 * e;
	if (!(w > 0 && h > 0) || w > MAX_LAYER_STILL_SIDE || h > MAX_LAYER_STILL_SIDE) return null;
	return { x: -e, y: -e, w, h };
}

/** Largest side of a lowered layer's still (larger layers keep the master recipe). */
const MAX_LAYER_STILL_SIDE = 4096;

/** Frames of the render document of a variant: the drawn span, or one frame. */
export function variantFrames(c: RenderVisualClip, v: BakeVariant): number {
	if (v.recipe === 'master') {
		const s = drawnSpan(c);
		return s.end - s.start;
	}
	return 1;
}

/**
 * The one-clip render document of a bake (S11:LBK-003): the clip as baked on an otherwise empty sequence of the
 * same frame rate, size `rect` (or the sequence size), range = the variant's frames. `media` / `fonts` are the
 * handles the consumer resolved (signed URLs for Remotion; URLs never enter the render key).
 */
export function bakeDoc(
	snapshot: Pick<RenderSnapshot, 'sequenceId' | 'settings' | 'expressions'>,
	clip: RenderVisualClip,
	o: {
		variant: BakeVariant;
		rect: Rect | null;
		media: RenderSnapshot['media'];
		fonts: RenderSnapshot['fonts'];
	},
): RenderSnapshot {
	const frames = variantFrames(clip, o.variant);
	const start = o.variant.recipe === 'frame' ? o.variant.frame : 0;
	return {
		version: 1,
		sequenceId: snapshot.sequenceId,
		settings: {
			...snapshot.settings,
			...(o.rect ? { width: o.rect.w, height: o.rect.h } : {}),
			backgroundColor: [0, 0, 0, 0],
		},
		range: { start, end: start + frames },
		durationFrames: frames,
		videoTracks: [{ trackId: clip.trackId, clips: [clip] }],
		audioClips: [],
		media: o.media,
		fonts: o.fonts,
		master: { volumeDb: { value: 0, keyframes: [] } },
		warnings: [],
		// Wave expressions: the renderer binds the clip's expressions against the whole project.
		...(snapshot.expressions ? { expressions: snapshot.expressions } : {}),
	};
}

/** Every `{mediaId: string}` referenced inside a value (effect params, template params, sources…). */
export function referencedMediaIds(v: unknown, out: Set<string> = new Set()): Set<string> {
	if (!v || typeof v !== 'object') return out;
	if (Array.isArray(v)) {
		for (const x of v) referencedMediaIds(x, out);
		return out;
	}
	const o = v as Record<string, unknown>;
	if (typeof o.mediaId === 'string' && o.mediaId) out.add(o.mediaId);
	for (const x of Object.values(o)) referencedMediaIds(x, out);
	return out;
}

type FaceOf = { fontId: string; family: string; weight: number; style: string };

/** The face a text style draws with: the exact weight/style, else the font's first face (as TextLayer resolves it). */
function faceFor<F extends FaceOf>(
	fonts: readonly F[],
	fontId: string,
	weight: number,
	italic: boolean,
): F | undefined {
	return (
		fonts.find((f) => f.fontId === fontId && f.weight === weight && (f.style === 'italic') === italic) ??
		fonts.find((f) => f.fontId === fontId)
	);
}

function stringsIn(v: unknown, out: Set<string>): Set<string> {
	if (typeof v === 'string') out.add(v);
	else if (Array.isArray(v)) for (const x of v) stringsIn(x, out);
	else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, out);
	return out;
}

/**
 * Font faces of `fonts` the clip draws with (the bake document's fonts and the key's). Text: the face of its style
 * and of every styled run (exact font/weight/style, else the font's first face — what TextLayer picks), so other
 * weights of the same font used elsewhere in the sequence (or missing from a sub-range export) do not change the
 * key. Other sources (anime template params): every face of a font they name by id or family.
 */
export function clipFonts<F extends FaceOf>(clip: RenderVisualClip, fonts: readonly F[]): F[] {
	const src = clip.source as {
		text?: {
			style?: { fontId?: string; weight?: number; italic?: boolean };
			runs?: { style?: { fontId?: string; weight?: number; italic?: boolean } }[];
		};
	};
	const used = new Set<F>();
	const cap = (clip.source as { captions?: { style: { fontId: string; weight: number; italic: boolean } } })
		.captions;
	if (cap) {
		// wp captions: the style's face and the bold / italic faces markup uses
		const st = cap.style;
		for (const [w, it] of [
			[st.weight, st.italic],
			[Math.max(st.weight, 700), st.italic],
			[st.weight, true],
		] as const) {
			const f = fonts.find((x) => x.fontId === st.fontId && x.weight === w && (x.style === 'italic') === it);
			if (f) used.add(f);
		}
		const f = faceFor(fonts, st.fontId, st.weight, st.italic);
		if (f) used.add(f);
		return fonts.filter((x) => used.has(x));
	}
	if (src.text) {
		const base = src.text.style ?? {};
		for (const st of [base, ...(src.text.runs ?? []).map((r) => ({ ...base, ...r.style }))]) {
			if (!st.fontId) continue;
			const f = faceFor(fonts, st.fontId, st.weight ?? 400, st.italic ?? false);
			if (f) used.add(f);
		}
	} else {
		const named = stringsIn(clip.source, new Set());
		for (const f of fonts) if (named.has(f.fontId) || named.has(f.family)) used.add(f);
	}
	return fonts.filter((f) => used.has(f));
}

export { textInkPad };

/**
 * spec 13 SH-004 (textperf: a 130 px caption baked 1080×760): a text layer whose box is measured (not pending,
 * auto-size) and whose glyphs stay in place (no In/Out animation, animators, text path or per-character 3D) is
 * cropped to its box grown by `contentBleed` (glyph ink, strokes, shadow) — without the 10 % frame bleed.
 */
export function tightTextCrop(c: Pick<RenderVisualClip, 'kind' | 'source'>): boolean {
	if (c.kind !== 'text' || !('text' in c.source)) return false;
	const s = c.source;
	return (
		!s.layoutPending &&
		s.box.autoSize !== 'none' &&
		!s.animation?.in &&
		!s.animation?.out &&
		!s.animators?.length &&
		!s.pathOptions &&
		!s.perCharacter3d
	);
}

/** Share of the frame below which a crop rect is used (a rect covering more renders the full frame). */
const RECT_MAX_AREA_SHARE = 0.85;
/** Bleed around the layer's per-frame bounds, as a share of the sequence height (S11:LBK-005). */
const RECT_BLEED_SHARE = 0.1;
/**
 * Extra margin (layer px) around the layer box for what may draw outside it: text stroke, shadow and background
 * padding, text-animator travel (`distance`, `blur`, `scale` params), blur effects. Null = unknown (do not crop).
 * Motion graphics add none: both renderers clip to their canvas, which is the layer box (the fframes SVG, the anime
 * templates' `DesignStage`), so the Player shows exactly what the cropped bake renders.
 */
export function contentBleed(
	c: RenderVisualClip,
	registry: EffectRegistry = defaultEffectRegistry,
): number | null {
	let px = 0;
	// spec 13 SH-004: the paint of every style (strokes, shadow offset + spread + 3 σ), glyph ink beyond the line
	// boxes, and the background padding (shared with the compositions' effect canvas).
	const src = 'text' in c.source ? c.source : undefined;
	if (src) px = textContentPad(src.text);
	// A vector shape draws around its (frame-sized) box centre and may paint outside the box; a static one
	// bleeds by how far its painted bounds leave the box, an animated one is not cropped (bounds change per frame).
	const vshape = 'shape' in c.source ? c.source.shape : undefined;
	if (vshape?.type === 'vector') {
		const contents = vshape.contents ?? [];
		if (vectorShapeIsTimeDependent(contents)) return null;
		const b = vectorShapeBounds(evaluateVectorShape(contents, 0));
		if (b) {
			const W = c.intrinsicBox.width / 2;
			const H = c.intrinsicBox.height / 2;
			px = Math.max(px, Math.ceil(Math.max(0, -W - b.x0, b.x1 - W, -H - b.y0, b.y1 - H)) + 2);
		}
	}
	const maxDim = Math.max(c.intrinsicBox.width, c.intrinsicBox.height);
	for (const side of [src?.animation?.in, src?.animation?.out]) {
		const p = side?.params ?? {};
		const num = (k: string) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? Math.abs(p[k]) : 0);
		px += num('distance') + 3 * num('blur') + Math.max(0, num('scale') - 1) * maxDim;
	}
	for (const fx of c.effects) {
		if (!fx.enabled || GEOMETRIC_EFFECTS.has(fx.effectId) || isColorEffect(fx, registry)) continue;
		if (fx.effectId === 'jasper.gaussian-blur') {
			let r = 0;
			for (const a of [fx.params.radius?.value, ...(fx.params.radius?.keyframes ?? []).map((k) => k.value)])
				if (typeof a === 'number') r = Math.max(r, a);
			px += 3 * r;
			continue;
		}
		return null;
	}
	return px;
}

/**
 * S11:LBK-005 — the crop rect of a bake: the union over the clip's frames `[f0, f1)` of its layer box (grown by
 * `contentBleed`) mapped through the layer map, plus a bleed of 10 % of the sequence height, clamped to the frame,
 * even-aligned. Null = render the full frame (no Motion, unknown effects, or the rect would cover most of it).
 */
export function cropRect(
	c: RenderVisualClip,
	frames: { f0: number; f1: number },
	seq: { width: number; height: number; fps: RenderSnapshot['settings']['fps'] },
	registry: EffectRegistry = defaultEffectRegistry,
): Rect | null {
	if (!c.transform) return null;
	const extra = contentBleed(c, registry);
	if (extra === null) return null;
	const b = c.intrinsicBox;
	const corners: [number, number][] = [
		[-extra, -extra],
		[b.width + extra, -extra],
		[b.width + extra, b.height + extra],
		[-extra, b.height + extra],
	];
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	const animated =
		hasKeyframesDeep(c.transform) || c.effects.some((fx) => fx.enabled && hasKeyframesDeep(fx.params));
	const last = animated ? frames.f1 : Math.min(frames.f1, frames.f0 + 1);
	for (let f = frames.f0; f < last; f++) {
		const props = resolveLayerProps(c, contentTimeAt(c, f, seq.fps));
		const m = layerMapOf(props);
		for (const p of corners) {
			const [x, y] = applyMat3(m, p);
			if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
			x0 = Math.min(x0, x);
			y0 = Math.min(y0, y);
			x1 = Math.max(x1, x);
			y1 = Math.max(y1, y);
		}
	}
	// Measured, unanimated text: 2 px for anti-aliasing and rounding; else the 10 % frame bleed.
	const bleed = tightTextCrop(c) ? 2 : RECT_BLEED_SHARE * seq.height;
	const W = seq.width;
	const H = seq.height;
	let left = Math.max(0, Math.floor((x0 - bleed) / 2) * 2);
	let top = Math.max(0, Math.floor((y0 - bleed) / 2) * 2);
	const right = Math.min(W, Math.ceil((x1 + bleed) / 2) * 2);
	const bottom = Math.min(H, Math.ceil((y1 + bleed) / 2) * 2);
	// Entirely outside the frame: a minimal transparent rect.
	if (right <= left || bottom <= top) {
		left = Math.min(Math.max(0, left), Math.max(0, W - 2));
		top = Math.min(Math.max(0, top), Math.max(0, H - 2));
		return { x: left, y: top, w: 2, h: 2 };
	}
	const w = Math.max(2, right - left);
	const h = Math.max(2, bottom - top);
	if (w * h >= RECT_MAX_AREA_SHARE * W * H) return null;
	return { x: left, y: top, w, h };
}
