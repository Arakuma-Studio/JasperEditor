// Layer bake (M2, S11 §6): what a DOM layer is, when it is static, and the one-clip render documents its masters
// are rendered from. Pure functions over the render snapshot (no I/O), shared by the native extension, the
// preview route and the tests.
import {
	applyMat3,
	contentTimeAt,
	defaultEffectRegistry,
	type EffectRegistry,
	layerMapOf,
	type RenderSnapshot,
	type RenderVisualClip,
	resolveLayerProps,
	type Transform,
} from '@jasper/project';

/** Clip kinds whose pixels come from React/DOM in the composition (S11 §0 "DOM layer"). */
const DOM_KINDS: ReadonlySet<string> = new Set(['text', 'shape', 'motion-graphic']);

/**
 * S11:LBK-001: a DOM layer — every text clip, every shape and motion-graphic clips rendered by Remotion
 * (`renderer: 'anime'`; the snapshot's `engine` comes from `clipEngines`, so fframes templates stay with the
 * fframes masters). Generic over the kinds' implementations: text animators, anime templates and shapes need no
 * change here.
 */
export function isDomLayer(c: Pick<RenderVisualClip, 'kind' | 'engine'>): boolean {
	return DOM_KINDS.has(c.kind) && c.engine === 'remotion';
}

/** True when the effect has a colour op (D-21): applied natively to DOM layers (S11:LBK-010). */
export function isColorEffect(
	fx: { effectId: string; effectVersion: number },
	registry: EffectRegistry = defaultEffectRegistry,
): boolean {
	return !!registry.get(fx.effectId, fx.effectVersion)?.color;
}

/** The clip has enabled colour-op effects (FIX-002: they are applied by ffmpeg, not baked by Remotion). */
export function hasColorEffects(c: Pick<RenderVisualClip, 'effects'>, registry?: EffectRegistry): boolean {
	return c.effects.some((fx) => fx.enabled && isColorEffect(fx, registry));
}

/** Geometric effects: they commute with pointwise colour ops (crop, flips, corner pin). */
const GEOMETRIC_EFFECTS: ReadonlySet<string> = new Set([
	'jasper.crop',
	'jasper.flip-horizontal',
	'jasper.flip-vertical',
	'jasper.corner-pin',
]);

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

/** True when any Animatable inside `v` has keyframes (deep: Motion, opacity, effects, shape props, params…). */
export function hasKeyframesDeep(v: unknown): boolean {
	if (!v || typeof v !== 'object') return false;
	if (Array.isArray(v)) return v.some(hasKeyframesDeep);
	const o = v as Record<string, unknown>;
	if (Array.isArray(o.keyframes) && o.keyframes.length > 0 && 'value' in o) return true;
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
	c: Pick<RenderVisualClip, 'kind' | 'source' | 'transform' | 'opacity' | 'effects'>,
	registry: EffectRegistry = defaultEffectRegistry,
): boolean {
	if (c.kind === 'motion-graphic') return false;
	const src = c.source as { animation?: { in?: unknown; out?: unknown } };
	if (src.animation && (src.animation.in || src.animation.out)) return false;
	if (hasKeyframesDeep(c.transform) || hasKeyframesDeep(c.opacity)) return false;
	for (const fx of c.effects) {
		if (!fx.enabled) continue;
		if (!registry.get(fx.effectId, fx.effectVersion)) return false;
		if (hasKeyframesDeep(fx.params)) return false;
	}
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
	| { recipe: 'frame'; frame: number };

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
	const effects = c.effects.filter((fx) => fx.enabled && !(o.stripColor && isColorEffect(fx, o.registry)));
	const { headHandle, tailHandle, fades, ...rest } = c;
	let out: RenderVisualClip;
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
	if (o.shift && (o.shift.x || o.shift.y) && out.transform)
		out = { ...out, transform: shifted(out.transform, o.shift) };
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
	snapshot: Pick<RenderSnapshot, 'sequenceId' | 'settings' | 'master'>,
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
		range: { start, end: start + (o.variant.recipe === 'master' ? frames : 1) },
		durationFrames: o.variant.recipe === 'master' ? frames : 1,
		videoTracks: [{ trackId: clip.trackId, clips: [clip] }],
		audioClips: [],
		media: o.media,
		fonts: o.fonts,
		master: { volumeDb: { value: 0, keyframes: [] } },
		warnings: [],
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

/** Share of the frame below which a crop rect is used (a rect covering more renders the full frame). */
export const RECT_MAX_AREA_SHARE = 0.85;
/** Bleed around the layer's per-frame bounds, as a share of the sequence height (S11:LBK-005). */
export const RECT_BLEED_SHARE = 0.1;
/** Effects whose drawing stays inside the layer box (or are applied by ffmpeg): no extra bleed. */
const BOX_BOUND_EFFECTS: ReadonlySet<string> = new Set([
	'jasper.crop',
	'jasper.flip-horizontal',
	'jasper.flip-vertical',
	'jasper.corner-pin',
]);

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
	const src = c.source as {
		text?: {
			style?: {
				strokes?: { widthPx?: number; position?: string }[];
				shadow?: { distancePx?: number; blurPx?: number } | null;
				background?: { paddingPx?: number } | null;
			};
		};
		animation?: { in?: { params?: Record<string, unknown> }; out?: { params?: Record<string, unknown> } };
	};
	const st = src.text?.style;
	if (st) {
		for (const s of st.strokes ?? [])
			px = Math.max(px, (s.widthPx ?? 0) * (s.position === 'outside' ? 2 : 1));
		if (st.shadow) px += (st.shadow.distancePx ?? 0) + 3 * (st.shadow.blurPx ?? 0);
		if (st.background) px += st.background.paddingPx ?? 0;
	}
	const maxDim = Math.max(c.intrinsicBox.width, c.intrinsicBox.height);
	for (const side of [src.animation?.in, src.animation?.out]) {
		const p = side?.params ?? {};
		const num = (k: string) =>
			typeof p[k] === 'number' && Number.isFinite(p[k]) ? Math.abs(p[k] as number) : 0;
		px += num('distance') + 3 * num('blur') + Math.max(0, num('scale') - 1) * maxDim;
	}
	for (const fx of c.effects) {
		if (!fx.enabled || BOX_BOUND_EFFECTS.has(fx.effectId) || isColorEffect(fx, registry)) continue;
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
	const bleed = RECT_BLEED_SHARE * seq.height;
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
