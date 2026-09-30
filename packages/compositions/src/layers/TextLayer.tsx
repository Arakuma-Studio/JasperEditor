// Text layer (S03:TXT-001…005 subset, KND-050): DOM text inside the clip's text box. Fill, one
// stroke, background box, shadow, alignment, tracking, leading, caps and the box modes of S01
// (`autoSize: 'width'` = point text that never wraps; `'height'`/`'none'` = paragraph text that wraps
// at the box width). Fonts are loaded by the composition (fonts.ts) before the frame renders.
import type { CSSProperties } from 'react';
import { FALLBACK_FONT_STACK } from '../fonts.ts';
import { rgbaCss } from '../metadata.ts';
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';

type TextSource = Extract<LayerProps['clip']['source'], { text: unknown }>;

export function textFontFamily(
	fontId: string,
	fonts: LayerProps['fonts'],
	weight?: number,
	italic?: boolean,
): string {
	const all = fonts ?? [];
	const face =
		all.find(
			(f) =>
				f.fontId === fontId &&
				(weight === undefined || f.weight === weight) &&
				(italic === undefined || (f.style === 'italic') === italic),
		) ?? all.find((f) => f.fontId === fontId);
	return face ? `"${face.family.replace(/"/g, '')}", ${FALLBACK_FONT_STACK}` : FALLBACK_FONT_STACK;
}

/** Inline style of the text block (pure; unit-tested). */
export function textBlockStyle(source: TextSource, fonts: LayerProps['fonts']): CSSProperties {
	const s = source.text.style;
	const pointText = source.box.autoSize === 'width';
	const stroke = s.strokes[0];
	const style: CSSProperties = {
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
		color: rgbaCss(s.fill),
		whiteSpace: pointText ? 'pre' : 'pre-wrap',
		overflowWrap: pointText ? undefined : 'break-word',
		fontKerning: 'normal',
	};
	if (stroke && stroke.widthPx > 0) {
		// S03:TXT-003: outside strokes are drawn at double width under the fill (paint-order), so they
		// never eat into glyphs; centered strokes straddle the outline; inside strokes fall back to
		// centered in M1 (SVG text path is P1).
		const outside = stroke.position === 'outside';
		style.WebkitTextStroke = `${outside ? stroke.widthPx * 2 : stroke.widthPx}px ${rgbaCss(stroke.color)}`;
		if (outside) style.paintOrder = 'stroke fill';
	}
	if (s.shadow) {
		const rad = (s.shadow.angleDeg * Math.PI) / 180;
		const dx = Math.cos(rad) * s.shadow.distancePx;
		const dy = Math.sin(rad) * s.shadow.distancePx;
		style.textShadow = `${dx}px ${dy}px ${s.shadow.blurPx}px ${rgbaCss(s.shadow.color)}`;
	}
	return style;
}

export function TextLayer(layer: LayerProps) {
	const source = layer.clip.source;
	if (!('text' in source)) return null;
	const bg = source.text.style.background;
	return (
		<LayerBox layer={layer}>
			{bg ? (
				<div
					data-text-background=""
					style={{
						position: 'absolute',
						left: -bg.paddingPx,
						top: -bg.paddingPx,
						right: -bg.paddingPx,
						bottom: -bg.paddingPx,
						background: rgbaCss(bg.color),
						borderRadius: bg.radiusPx,
					}}
				/>
			) : null}
			<p data-text-block="" style={textBlockStyle(source, layer.fonts)}>
				{source.text.text}
			</p>
		</LayerBox>
	);
}
