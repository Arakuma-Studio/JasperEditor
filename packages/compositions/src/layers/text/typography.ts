// Typography of the typeset text renderer (workstream text-animators): the CSS of character and paragraph
// settings, the read-time defaults of the optional style fields, and when a text clip needs the typeset renderer.
//
// Character settings follow After Effects' Character panel (helpx.adobe.com/after-effects/using/
// formatting-characters-character-panel.html) and EffectCraft's layout (`crates/text/src/layout.rs`):
// - kerning: Metrics = the font's `kern`; Optical / manual = `kern` off plus per-character offsets (measure.ts);
// - tracking (`trackingEm`) = CSS letter-spacing (added after every character);
// - baseline shift = a relative offset that does not change the line box (as AE's Baseline Shift);
// - superscript / subscript = 58.3 % of the size, ±33.3 % of the size (AE Type preferences defaults; EffectCraft
//   `SCRIPT_SIZE` / `SCRIPT_OFFSET`), always synthesized so preview and export match whatever the font has;
// - small caps = `font-variant-caps` (Chrome synthesizes them at 70 % when the font has no `smcp`, AE's default
//   Small Caps size is 70 %);
// - faux italic = a 0.21 shear of each glyph about its baseline (EffectCraft `glyph_affine`, ≈ 11.9°), faux bold
//   = an outline stroke in the fill colour of Skia's fake-bold width (size × 1/24 at 9 px … 1/32 from 36 px);
// - ligatures / OpenType features = `font-variant-*` and `font-feature-settings`; variable axes =
//   `font-variation-settings`.
import type { TextContent, TextStyle } from '@jasper/project';
import type { CSSProperties } from 'react';

export const SCRIPT_SIZE = 0.583;
export const SCRIPT_OFFSET = 0.333;
/** Faux italic shear (x += 0.21 · height above the baseline). */
export const FAUX_ITALIC_SLANT = 0.21;

/** Skia's fake-bold outline width for a text size (SkScalerContext kStdFakeBoldInterp keys/values). */
export function fauxBoldWidth(sizePx: number): number {
	const k = sizePx <= 9 ? 1 / 24 : sizePx >= 36 ? 1 / 32 : 1 / 24 + ((sizePx - 9) / 27) * (1 / 32 - 1 / 24);
	return sizePx * k;
}

/** Fields of the base style a paragraph override may change. */
export const PARAGRAPH_FIELDS = [
	'align',
	'justifyLast',
	'direction',
	'indentLeftPx',
	'indentRightPx',
	'indentFirstLinePx',
	'spaceBeforePx',
	'spaceAfterPx',
] as const;

/** Style fields this workstream added (their presence routes a clip to the typeset renderer). */
const TYPOGRAPHY_FIELDS = [
	'kerning',
	'baselineShiftPx',
	'tsume',
	'fauxBold',
	'fauxItalic',
	'smallCaps',
	'script',
	'ligatures',
	'openType',
	'fontVariations',
	'justifyLast',
	'indentLeftPx',
	'indentRightPx',
	'indentFirstLinePx',
	'spaceBeforePx',
	'spaceAfterPx',
] as const;

/** True when a style uses a typography field with a non-default value. */
export function usesTypography(s: Partial<TextStyle> | undefined): boolean {
	if (!s) return false;
	const r = s as Record<string, unknown>;
	return TYPOGRAPHY_FIELDS.some((f) => {
		const v = r[f];
		if (v === undefined) return false;
		switch (f) {
			case 'kerning':
				return v !== 'metrics';
			case 'ligatures':
				return v !== true;
			case 'script':
				return v !== 'normal';
			case 'justifyLast':
				return v !== 'left';
			case 'openType':
			case 'fontVariations':
				return Object.keys(v as object).length > 0;
			case 'fauxBold':
			case 'fauxItalic':
			case 'smallCaps':
				return v === true;
			default:
				return v !== 0;
		}
	});
}

/** The parts of a text layer source the typeset renderer reads. */
export type TypesetSource = {
	text: TextContent;
	animators?: readonly unknown[];
	pathOptions?: unknown;
};

/**
 * True when the clip needs the typeset renderer: it has animators, a text path, paragraph overrides or uses a
 * typography field. Clips without any keep the plain text block (and the In/Out preset renderer) unchanged, so
 * documents from before render byte-identically.
 */
export function needsTypeset(src: TypesetSource): boolean {
	if ((src.animators?.length ?? 0) > 0 || src.pathOptions) return true;
	const c = src.text;
	if (c.paragraphs?.length) return true;
	return usesTypography(c.style) || (c.runs ?? []).some((r) => usesTypography(r.style));
}

const css = (n: number) => Number(n.toFixed(4));

/** `font-feature-settings` of a style (beyond what `font-variant-*` covers). */
export function featureSettings(s: TextStyle): string | undefined {
	const f: string[] = [];
	const kern = s.kerning ?? 'metrics';
	if (kern !== 'metrics') f.push('"kern" 0');
	const o = s.openType ?? {};
	if (o.discretionaryLigatures) f.push('"dlig" 1');
	if (o.contextualAlternates === false) f.push('"calt" 0');
	if (o.stylisticAlternates) f.push('"salt" 1');
	if (o.swash) f.push('"swsh" 1');
	if (o.titling) f.push('"titl" 1');
	if (o.ordinals) f.push('"ordn" 1');
	if (o.fractions) f.push('"frac" 1');
	if (o.figureStyle === 'lining') f.push('"lnum" 1');
	if (o.figureStyle === 'oldStyle') f.push('"onum" 1');
	if (o.figureWidth === 'proportional') f.push('"pnum" 1');
	if (o.figureWidth === 'tabular') f.push('"tnum" 1');
	for (const n of [...new Set(o.stylisticSets ?? [])].sort((a, b) => a - b))
		f.push(`"ss${String(n).padStart(2, '0')}" 1`);
	return f.length ? f.join(', ') : undefined;
}

/** `font-variation-settings` of a style plus animated axis offsets. */
export function variationSettings(
	s: Pick<TextStyle, 'fontVariations'>,
	delta?: Readonly<Record<string, number>>,
): string | undefined {
	const axes: Record<string, number> = { ...(s.fontVariations ?? {}) };
	for (const [tag, d] of Object.entries(delta ?? {}))
		if (d !== 0) axes[tag] = (axes[tag] ?? defaultAxisValue(tag)) + d;
	const tags = Object.keys(axes).sort();
	return tags.length ? tags.map((t) => `"${t}" ${css(axes[t]!)}`).join(', ') : undefined;
}

/** Registered-axis defaults used when an animator offsets an axis the style does not set. */
export function defaultAxisValue(tag: string, style?: Pick<TextStyle, 'weight' | 'italic'>): number {
	switch (tag) {
		case 'wght':
			return style?.weight ?? 400;
		case 'wdth':
			return 100;
		case 'ital':
			return style?.italic ? 1 : 0;
		case 'slnt':
			return 0;
		case 'opsz':
			return 0;
		default:
			return 0;
	}
}

/** Size a run is drawn at (superscript / subscript are smaller). */
export function glyphSize(s: Pick<TextStyle, 'sizePx' | 'script'>): number {
	return s.script && s.script !== 'normal' ? s.sizePx * SCRIPT_SIZE : s.sizePx;
}

/** Upward offset of a run: baseline shift plus the superscript / subscript rise. */
export function rise(s: Pick<TextStyle, 'sizePx' | 'script' | 'baselineShiftPx'>): number {
	const script =
		s.script === 'superscript'
			? s.sizePx * SCRIPT_OFFSET
			: s.script === 'subscript'
				? -s.sizePx * SCRIPT_OFFSET
				: 0;
	return (s.baselineShiftPx ?? 0) + script;
}

/** Character CSS of a run in the (hidden) flow: font, size, spacing, features — no paint. */
export function charFlowCss(s: TextStyle, family: string): CSSProperties {
	const r = rise(s);
	const features = featureSettings(s);
	const variations = variationSettings(s);
	const allSmall = s.openType?.allSmallCaps;
	return {
		fontFamily: family,
		fontWeight: s.weight,
		fontStyle: s.italic ? 'italic' : 'normal',
		fontSize: css(glyphSize(s)),
		lineHeight: s.lineHeight,
		letterSpacing: s.trackingEm ? `${css(s.trackingEm * s.sizePx)}px` : 'normal',
		textTransform: s.allCaps ? 'uppercase' : 'none',
		fontKerning: (s.kerning ?? 'metrics') === 'metrics' ? 'normal' : 'none',
		fontVariantLigatures: s.ligatures === false ? 'no-common-ligatures' : 'normal',
		fontVariantCaps: allSmall ? 'all-small-caps' : s.smallCaps ? 'small-caps' : 'normal',
		...(features ? { fontFeatureSettings: features } : { fontFeatureSettings: 'normal' }),
		...(variations ? { fontVariationSettings: variations } : { fontVariationSettings: 'normal' }),
		...(r !== 0 ? { position: 'relative', top: css(-r) } : {}),
	};
}

/** Paragraph CSS (block of one paragraph). `first` / `last`: space before / after only between paragraphs. */
export function paragraphCss(s: TextStyle, pointText: boolean, first: boolean, last: boolean): CSSProperties {
	const justify = s.align === 'justify';
	let lastAlign = s.justifyLast ?? 'left';
	// Point text has no width to justify to (EffectCraft: Justify All on point text = left).
	if (pointText && justify) lastAlign = lastAlign === 'justify' ? 'left' : lastAlign;
	return {
		margin: 0,
		paddingTop: first ? 0 : css(s.spaceBeforePx ?? 0),
		paddingBottom: last ? 0 : css(s.spaceAfterPx ?? 0),
		paddingInlineStart: css(s.indentLeftPx ?? 0),
		paddingInlineEnd: css(s.indentRightPx ?? 0),
		textIndent: css(s.indentFirstLinePx ?? 0),
		textAlign: justify ? (pointText ? lastAlign : 'justify') : s.align,
		textAlignLast: justify && !pointText ? (lastAlign === 'justify' ? 'justify' : lastAlign) : 'auto',
		direction: s.direction === 'auto' ? undefined : s.direction,
		unicodeBidi: s.direction === 'auto' ? 'plaintext' : 'normal',
		whiteSpace: pointText ? 'pre' : 'pre-wrap',
		overflowWrap: pointText ? 'normal' : 'break-word',
		minHeight: '1lh',
	};
}
