// Caption layer (wp captions, S03 §19): draws the page of a caption clip showing at the current frame, laid out
// with the resolved caption style inside the title-safe area of a frame-sized layer box (Motion and Opacity of the
// clip apply on top through LayerBox). Lines come pre-wrapped from the model (`captionPages`); the box width
// (`boxWidthPct`) wraps lines that are still too wide. `<i>`, `<b>`, `<u>` markup is drawn; other tags are hidden.
// Active-word highlight (`highlight.mode`): `word` colours the word being spoken, `karaoke` every word spoken so
// far. The same component draws the preview, the Remotion export and the layer-bake intermediates of the native
// and hybrid paths (S01:KND-008: preview, export and sidecar agree).
import type { CaptionPage, CaptionPageWord, RenderCaptionSource } from '@jasper/project';
import type { CSSProperties, ReactNode } from 'react';
import { FALLBACK_FONT_STACK, fontFaceFor, useFontsReady } from '../fonts.ts';
import { rgbaCss } from '../metadata.ts';
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';

/** Title-safe margin: 10 % of the frame on each side (Premiere's default safe margins). */
export const CAPTION_TITLE_SAFE = 0.1;
const MONO_STACK = '"Source Code Pro", "DejaVu Sans Mono", Menlo, Consolas, monospace';

type Style = RenderCaptionSource['style'];

/** The page on screen at clip frame `f` (pages are sorted and do not overlap). */
export function captionPageAt(pages: readonly CaptionPage[], f: number): CaptionPage | null {
	for (const p of pages) if (p.start <= f && f < p.end) return p;
	return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

type Fmt = { i: boolean; b: boolean; u: boolean };
/** Pieces of a word with markup state (state carries across words). */
function markupPieces(text: string, st: Fmt): Array<{ text: string; fmt: Fmt }> {
	const out: Array<{ text: string; fmt: Fmt }> = [];
	let buf = '';
	const flush = () => {
		if (buf) out.push({ text: buf, fmt: { ...st } });
		buf = '';
	};
	let i = 0;
	while (i < text.length) {
		const c = text[i]!;
		if (c === '<') {
			const end = text.indexOf('>', i);
			if (end > i) {
				const tag = text
					.slice(i + 1, end)
					.trim()
					.toLowerCase();
				const close = tag.startsWith('/');
				const name = (close ? tag.slice(1) : tag).split(/[\s.]/)[0] ?? '';
				if (name === 'i' || name === 'b' || name === 'u') {
					flush();
					st[name] = !close;
				}
				i = end + 1;
				continue;
			}
		}
		if (c === '{' && text[i + 1] === '\\') {
			const end = text.indexOf('}', i);
			if (end > i) {
				i = end + 1;
				continue;
			}
		}
		if (c === '&') {
			const m = /^&([a-z]+);/.exec(text.slice(i, i + 8));
			if (m && ENTITIES[m[1]!] !== undefined) {
				buf += ENTITIES[m[1]!];
				i += m[0].length;
				continue;
			}
		}
		buf += c;
		i++;
	}
	flush();
	return out;
}

function fontFamily(layer: LayerProps, style: Style, mono: boolean): string {
	const face = fontFaceFor(layer.fonts, style.fontId, style.weight, style.italic);
	if (face) return `"${face.family.replace(/"/g, '')}", ${FALLBACK_FONT_STACK}`;
	return mono ? MONO_STACK : FALLBACK_FONT_STACK;
}

function strokeCss(style: Style): CSSProperties {
	const s = style.strokes[0];
	if (!s || s.widthPx <= 0) return {};
	const outside = s.position === 'outside';
	return {
		WebkitTextStroke: `${outside ? s.widthPx * 2 : s.widthPx}px ${rgbaCss(s.color)}`,
		...(outside ? { paintOrder: 'stroke fill' } : {}),
	};
}

function shadowCss(style: Style): string | undefined {
	const sh = style.shadow;
	if (!sh) return undefined;
	const rad = (sh.angleDeg * Math.PI) / 180;
	return `${Math.cos(rad) * sh.distancePx}px ${Math.sin(rad) * sh.distancePx}px ${sh.blurPx}px ${rgbaCss(sh.color)}`;
}

/** Placement of the caption block inside the frame (title-safe, VTT overrides). */
export function captionBlockPlacement(
	style: Pick<Style, 'placement' | 'marginPct' | 'linePct' | 'positionPct' | 'boxWidthPct' | 'align'>,
	frame: { width: number; height: number },
): CSSProperties {
	const W = frame.width;
	const H = frame.height;
	const safe = CAPTION_TITLE_SAFE;
	const width = (Math.min(100, Math.max(1, style.boxWidthPct)) / 100) * W;
	const margin = (Math.min(45, Math.max(0, style.marginPct ?? 0)) / 100) * H;
	const css: CSSProperties = { position: 'absolute', width, display: 'flex', flexDirection: 'column' };
	// horizontal: centred, or anchored at positionPct (VTT position: the anchor follows the alignment)
	if (style.positionPct !== null && style.positionPct !== undefined) {
		const x = (style.positionPct / 100) * W;
		const left = style.align === 'left' ? x : style.align === 'right' ? x - width : x - width / 2;
		css.left = Math.min(W - width, Math.max(0, left));
	} else css.left = (W - width) / 2;
	if (style.linePct !== null && style.linePct !== undefined) {
		css.top = (style.linePct / 100) * H;
		css.maxHeight = H - (css.top as number);
	} else if (style.placement === 'top') css.top = safe * H + margin;
	else if (style.placement === 'middle') {
		css.top = 0;
		css.height = H;
		css.justifyContent = 'center';
	} else css.bottom = safe * H + margin;
	css.alignItems = style.align === 'left' ? 'flex-start' : style.align === 'right' ? 'flex-end' : 'center';
	return css;
}

function lineNodes(
	line: readonly CaptionPageWord[],
	frame: number,
	style: Style,
	fmt: Fmt,
	keyBase: string,
): ReactNode[] {
	const hl = style.highlight;
	const out: ReactNode[] = [];
	line.forEach((w, k) => {
		const active =
			hl.mode === 'word'
				? w.start <= frame && frame < w.end
				: hl.mode === 'karaoke'
					? w.start <= frame
					: false;
		const pieces = markupPieces(w.text, fmt);
		if (w.space) out.push(' ');
		pieces.forEach((p, j) => {
			const css: CSSProperties = {};
			if (p.fmt.i) css.fontStyle = style.italic ? 'normal' : 'italic';
			if (p.fmt.b) css.fontWeight = Math.max(style.weight, 700);
			if (p.fmt.u) css.textDecoration = 'underline';
			if (active) css.color = rgbaCss(hl.color);
			out.push(
				// biome-ignore lint/suspicious/noArrayIndexKey: words of a page are identified by their position
				<span key={`${keyBase}-${k}-${j}`} data-caption-word={active ? 'active' : ''} style={css}>
					{p.text}
				</span>,
			);
		});
	});
	return out;
}

export function CaptionsLayer(layer: LayerProps) {
	const src = layer.clip.source;
	const cap = 'captions' in src ? src.captions : null;
	const face = cap
		? fontFaceFor(layer.fonts, cap.style.fontId, cap.style.weight, cap.style.italic)
		: undefined;
	const ready = useFontsReady(face ? [{ family: face.family, weight: face.weight, style: face.style }] : []);
	if (!cap) return null;
	const { style, pages, standard } = cap;
	// pages are in clip-relative frames
	const frame = layer.realFrame ?? layer.localFrame;
	const page = captionPageAt(pages, frame);
	if (!page) return <LayerBox layer={layer} />;
	const box = layer.props.box;
	const bg = style.background;
	const fmt: Fmt = { i: false, b: false, u: false };
	const textCss: CSSProperties = {
		fontFamily: fontFamily(layer, style, standard === 'cea-608' && !face),
		fontWeight: style.weight,
		fontStyle: style.italic ? 'italic' : 'normal',
		fontSize: style.sizePx,
		lineHeight: style.lineHeight,
		letterSpacing: style.trackingEm ? `${style.trackingEm}em` : undefined,
		textAlign: style.align === 'justify' ? 'center' : style.align,
		direction: style.direction === 'auto' ? undefined : style.direction,
		unicodeBidi: style.direction === 'auto' ? 'plaintext' : undefined,
		textTransform: style.allCaps ? 'uppercase' : undefined,
		color: rgbaCss(style.fill),
		whiteSpace: 'pre-wrap',
		overflowWrap: 'break-word',
		fontKerning: 'normal',
		textShadow: shadowCss(style),
		...strokeCss(style),
	};
	const lineBox: CSSProperties = bg
		? {
				background: rgbaCss(bg.color),
				padding: `${bg.paddingPx * 0.35}px ${bg.paddingPx}px`,
				borderRadius: bg.radiusPx,
				boxDecorationBreak: 'clone',
				WebkitBoxDecorationBreak: 'clone',
			}
		: {};
	return (
		<LayerBox layer={layer}>
			<div
				data-caption-page={`${page.start}-${page.end}`}
				style={{ ...captionBlockPlacement(style, box), visibility: ready ? 'visible' : 'hidden' }}
			>
				{page.lines.map((line, li) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: lines of one page have no identity beyond their order
						key={li}
						data-caption-line={li}
						style={{ ...textCss, maxWidth: '100%' }}
					>
						<span style={lineBox}>{lineNodes(line, frame, style, fmt, `l${li}`)}</span>
					</div>
				))}
			</div>
		</LayerBox>
	);
}
