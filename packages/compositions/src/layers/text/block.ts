// The plain text block of a text layer (S03:TXT-001…005): its layout CSS (font, size, leading, tracking, alignment,
// direction, caps, wrapping by box mode) and the styled run pieces. Shared by TextLayer (which adds the paint of
// every pass, `paint.tsx`) and the text box measurer (`box-measure.ts`), so a measured box is the box the block
// draws in. Paint (fill, strokes, shadow) never changes the layout.
import type { TextContent, TextStyle } from '@jasper/project';
import type { CSSProperties } from 'react';
import { FALLBACK_FONT_STACK, fontFaceFor } from '../../fonts.ts';
import type { LayerProps } from '../../types.ts';

type Fonts = LayerProps['fonts'];
export type TextRun = NonNullable<TextContent['runs']>[number];
export type RunStyle = TextRun['style'];

export function textFontFamily(fontId: string, fonts: Fonts, weight?: number, italic?: boolean): string {
	const face = fontFaceFor(fonts, fontId, weight, italic);
	return face ? `"${face.family.replace(/"/g, '')}", ${FALLBACK_FONT_STACK}` : FALLBACK_FONT_STACK;
}

/** Layout CSS of the text block (no paint: `paintCss` adds the colours and strokes of a pass). */
export function textBlockStyle(
	source: { text: Pick<TextContent, 'style'>; box: { autoSize: 'none' | 'width' | 'height' } },
	fonts: Fonts,
): CSSProperties {
	const s = source.text.style;
	const pointText = source.box.autoSize === 'width';
	return {
		position: 'absolute',
		left: 0,
		top: 0,
		width: '100%',
		minHeight: '100%',
		margin: 0,
		boxSizing: 'border-box',
		fontFamily: textFontFamily(s.fontId, fonts, s.weight, s.italic),
		fontWeight: s.weight,
		fontStyle: s.italic ? 'italic' : 'normal',
		fontSize: s.sizePx,
		lineHeight: s.lineHeight,
		letterSpacing: s.trackingEm ? `${s.trackingEm}em` : undefined,
		textAlign: s.align,
		direction: s.direction === 'auto' ? undefined : s.direction,
		unicodeBidi: s.direction === 'auto' ? 'plaintext' : undefined,
		textTransform: s.allCaps ? 'uppercase' : undefined,
		whiteSpace: pointText ? 'pre' : 'pre-wrap',
		overflowWrap: pointText ? undefined : 'break-word',
		fontKerning: 'normal',
	};
}

/** Layout overrides of a styled run over the block style (only the fields the run sets; no paint). */
export function runLayoutCss(run: RunStyle, base: TextStyle, fonts: Fonts): CSSProperties {
	const s = { ...base, ...run } as TextStyle;
	const css: CSSProperties = {};
	if (run.fontId !== undefined || run.weight !== undefined || run.italic !== undefined)
		css.fontFamily = textFontFamily(s.fontId, fonts, s.weight, s.italic);
	if (run.weight !== undefined) css.fontWeight = s.weight;
	if (run.italic !== undefined) css.fontStyle = s.italic ? 'italic' : 'normal';
	if (run.sizePx !== undefined) css.fontSize = s.sizePx;
	if (run.lineHeight !== undefined) css.lineHeight = s.lineHeight;
	if (run.trackingEm !== undefined) css.letterSpacing = `${s.trackingEm}em`;
	if (run.allCaps !== undefined) css.textTransform = s.allCaps ? 'uppercase' : 'none';
	return css;
}

export type StyledSpan = { from: number; to: number; style: RunStyle | null };

/** The text cut at run boundaries; each piece carries the merged style of the runs covering it (later win). */
export function styledSpans(text: string, runs: readonly TextRun[] | undefined): StyledSpan[] {
	if (!runs?.length) return text ? [{ from: 0, to: text.length, style: null }] : [];
	const clampI = (i: number) => Math.min(text.length, Math.max(0, i));
	const cuts = [...new Set([0, text.length, ...runs.flatMap((r) => [clampI(r.from), clampI(r.to)])])].sort(
		(a, b) => a - b,
	);
	const out: StyledSpan[] = [];
	for (let i = 0; i + 1 < cuts.length; i++) {
		const from = cuts[i]!;
		const to = cuts[i + 1]!;
		const covering = runs.filter((r) => r.from <= from && r.to >= to && r.to > r.from);
		out.push({
			from,
			to,
			style: covering.length ? Object.assign({}, ...covering.map((r) => r.style)) : null,
		});
	}
	return out;
}

/** Every style the block draws with: the base style and each run piece's merged style. */
export function blockStyles(content: Pick<TextContent, 'text' | 'style' | 'runs'>): TextStyle[] {
	const out: TextStyle[] = [content.style];
	for (const sp of styledSpans(content.text, content.runs))
		if (sp.style) out.push({ ...content.style, ...sp.style } as TextStyle);
	return out;
}
