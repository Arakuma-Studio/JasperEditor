// Text paint geometry (spec 13 SH-004, docs/wp-notes/text-render.md): the strokes a text style draws, its shadow
// (offset, blur, spread) and how far that paint reaches beyond the glyph outlines. Shared by the renderers
// (`@jasper/compositions` text paint), the layer-bake crop rect (apps/engine) and the invariants / repair of every
// stored text style (text clips, their runs, paragraphs and Source Text keys, caption clips, caption track defaults,
// caption style presets).
import type { RGBA } from './schema/common.ts';
import type { ProjectDocument } from './schema/document.ts';
import type { Clip, TextStyle } from './schema/sequence.ts';

/** Strokes drawn per style at most (each is one extra text copy in every renderer); longer lists are invalid. */
export const MAX_TEXT_STROKES = 16;
/** Largest valid shadow spread (px). */
export const MAX_SHADOW_SPREAD_PX = 10_000;

export type TextStrokePosition = 'outside' | 'center' | 'inside';

/** A stroke as drawn: its list slot (0 = top), colour, width (> 0) and position. */
export type DrawnStroke = { slot: number; color: RGBA; widthPx: number; position: TextStrokePosition };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const POSITIONS: ReadonlySet<string> = new Set(['outside', 'center', 'inside']);

function rgbaOf(v: unknown): RGBA | null {
	if (!Array.isArray(v) || v.length !== 4 || !v.every(finite)) return null;
	return v as RGBA;
}

/**
 * The strokes a style draws, in list order (the first is drawn on top): entries with a finite width > 0, a readable
 * colour and position, among the first `MAX_TEXT_STROKES` of the list. `slot` is the entry's index in the list.
 */
export function drawnStrokes(s: Partial<Pick<TextStyle, 'strokes'>> | undefined): DrawnStroke[] {
	const list = Array.isArray(s?.strokes) ? s.strokes : [];
	const out: DrawnStroke[] = [];
	for (let slot = 0; slot < Math.min(list.length, MAX_TEXT_STROKES); slot++) {
		const st = list[slot] as { color?: unknown; widthPx?: unknown; position?: unknown } | undefined;
		const color = rgbaOf(st?.color);
		const w = st?.widthPx;
		if (!color || !finite(w) || w <= 0 || typeof st?.position !== 'string' || !POSITIONS.has(st.position))
			continue;
		out.push({ slot, color, widthPx: w, position: st.position as TextStrokePosition });
	}
	return out;
}

/** How far one stroke paints outside the glyph outline. */
export function strokeOuterPx(s: Pick<DrawnStroke, 'widthPx' | 'position'>): number {
	return s.position === 'outside' ? s.widthPx : s.position === 'center' ? s.widthPx / 2 : 0;
}

/** How far the strokes of a style reach outside the glyph outlines (0 without strokes). */
export function textStrokeExtent(s: Partial<Pick<TextStyle, 'strokes'>> | undefined): number {
	return Math.max(0, ...drawnStrokes(s).map(strokeOuterPx));
}

/** A shadow as drawn: offset (px, y down), Gaussian σ, spread and colour. */
export type ResolvedTextShadow = { dx: number; dy: number; sigma: number; spreadPx: number; color: RGBA };

/**
 * The shadow of a style as the renderers draw it (null = none): the silhouette of the glyphs and their strokes grown
 * by `spreadPx`, blurred by a Gaussian of σ = `blurPx` / 2 (the CSS text-shadow blur radius the shadow always used),
 * offset by `distancePx` at `angleDeg` (0° = right, 90° = down, as since S03), in `color` (its alpha = opacity).
 * Unreadable numbers count as 0, the spread is clamped to 0…MAX_SHADOW_SPREAD_PX.
 */
export function resolveTextShadow(shadow: TextStyle['shadow'] | undefined): ResolvedTextShadow | null {
	if (!shadow) return null;
	const color = rgbaOf(shadow.color);
	if (!color || color[3] <= 0) return null;
	const angle = finite(shadow.angleDeg) ? (shadow.angleDeg * Math.PI) / 180 : 0;
	const d = finite(shadow.distancePx) ? shadow.distancePx : 0;
	const blur = finite(shadow.blurPx) ? Math.max(0, shadow.blurPx) : 0;
	const spread = finite(shadow.spreadPx) ? Math.min(MAX_SHADOW_SPREAD_PX, Math.max(0, shadow.spreadPx)) : 0;
	const round = (v: number) => Math.round(v * 1e6) / 1e6;
	return { dx: round(Math.cos(angle) * d), dy: round(Math.sin(angle) * d), sigma: blur / 2, spreadPx: spread, color };
}

/** Gaussian tails count up to 3 σ (beyond it a blurred edge is below 0.14 % of the shadow's alpha). */
const SHADOW_SIGMAS = 3;

/**
 * How far the paint of a style can reach beyond its glyph outlines on any side (px): its outer strokes, and its
 * shadow's offset + spread + 3 σ around the stroked silhouette.
 */
export function textPaintExtent(s: Partial<Pick<TextStyle, 'strokes' | 'shadow'>> | undefined): number {
	const stroke = textStrokeExtent(s);
	const sh = resolveTextShadow(s?.shadow ?? null);
	if (!sh) return stroke;
	return Math.max(stroke, Math.hypot(sh.dx, sh.dy) + stroke + sh.spreadPx + SHADOW_SIGMAS * sh.sigma);
}

/** Problems of the stroke list and shadow of a stored (possibly partial) text style. */
export function textStyleIssues(style: unknown): string[] {
	if (!style || typeof style !== 'object') return [];
	const s = style as { strokes?: unknown; shadow?: unknown };
	const out: string[] = [];
	if (Array.isArray(s.strokes) && s.strokes.length > MAX_TEXT_STROKES)
		out.push(`has ${s.strokes.length} strokes (at most ${MAX_TEXT_STROKES})`);
	const sh = s.shadow as { spreadPx?: unknown } | null | undefined;
	if (sh && typeof sh === 'object' && sh.spreadPx !== undefined) {
		const v = sh.spreadPx;
		if (!finite(v) || v < 0 || v > MAX_SHADOW_SPREAD_PX)
			out.push(`shadow spread must be a number in 0…${MAX_SHADOW_SPREAD_PX} px`);
	}
	return out;
}

/** Repairs a stored text style in place (strokes beyond the limit dropped, spread clamped); returns what changed. */
export function repairTextStyle(style: unknown): string[] {
	if (!style || typeof style !== 'object') return [];
	const s = style as { strokes?: unknown[]; shadow?: { spreadPx?: unknown } | null };
	const out: string[] = [];
	if (Array.isArray(s.strokes) && s.strokes.length > MAX_TEXT_STROKES) {
		out.push(`strokes beyond the first ${MAX_TEXT_STROKES} removed (${s.strokes.length - MAX_TEXT_STROKES})`);
		s.strokes = s.strokes.slice(0, MAX_TEXT_STROKES);
	}
	const sh = s.shadow;
	if (sh && typeof sh === 'object' && sh.spreadPx !== undefined) {
		const v = sh.spreadPx;
		if (!finite(v)) {
			delete sh.spreadPx;
			out.push('unreadable shadow spread removed (0)');
		} else if (v < 0 || v > MAX_SHADOW_SPREAD_PX) {
			sh.spreadPx = Math.min(MAX_SHADOW_SPREAD_PX, Math.max(0, v));
			out.push(`shadow spread ${v} clamped to ${sh.spreadPx}`);
		}
	}
	return out;
}

/** A stored text style and where it lives (`path` from the document root, `entity` = the owning id). */
export type StoredTextStyle = { style: unknown; entity: string; path: string[] };

/** The stored text styles of one clip (text: content, runs, paragraphs, Source Text keys; captions: its style). */
export function clipTextStyles(c: Clip, cw: string[]): StoredTextStyle[] {
	const out: StoredTextStyle[] = [];
	const content = (ct: unknown, path: string[]) => {
		if (!ct || typeof ct !== 'object') return;
		const x = ct as { style?: unknown; runs?: unknown; paragraphs?: unknown };
		out.push({ style: x.style, entity: c.id, path: [...path, 'style'] });
		for (const list of ['runs', 'paragraphs'] as const) {
			const v = x[list];
			if (Array.isArray(v))
				v.forEach((r, i) =>
					out.push({ style: (r as { style?: unknown })?.style, entity: c.id, path: [...path, list, String(i), 'style'] }),
				);
		}
	};
	if (c.kind === 'text') {
		content(c.content, [...cw, 'content']);
		(c.sourceTextKeyframes ?? []).forEach((k, i) =>
			content(k.value, [...cw, 'sourceTextKeyframes', String(i), 'value']),
		);
	} else if (c.kind === 'captions') out.push({ style: c.style, entity: c.id, path: [...cw, 'style'] });
	return out;
}

/**
 * Every stored text style of a document: text clips (content, runs, paragraphs, Source Text keys), caption clips,
 * caption track defaults and the project's caption style presets.
 */
export function storedTextStyles(doc: ProjectDocument): StoredTextStyle[] {
	const out: StoredTextStyle[] = [];
	for (const seq of Object.values(doc.sequences ?? {})) {
		const base = ['sequences', seq.id];
		for (const c of Object.values(seq.clips ?? {})) out.push(...clipTextStyles(c, [...base, 'clips', c.id]));
		for (const t of [...(seq.videoTracks ?? []), ...(seq.audioTracks ?? []), ...(seq.captionTracks ?? [])])
			if (t.styleDefaults)
				out.push({ style: t.styleDefaults, entity: t.id, path: [...base, 'tracks', t.id, 'styleDefaults'] });
	}
	(doc.settings?.captionStylePresets ?? []).forEach((p, i) =>
		out.push({ style: p.style, entity: p.id, path: ['settings', 'captionStylePresets', String(i), 'style'] }),
	);
	return out;
}
