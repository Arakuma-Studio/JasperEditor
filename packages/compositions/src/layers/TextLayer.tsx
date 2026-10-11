// Text layer (S03:TXT-001…005 subset, KND-050): DOM text inside the clip's text box. Fill, one
// stroke, background box, shadow, alignment, tracking, leading, caps and the box modes of S01
// (`autoSize: 'width'` = point text that never wraps; `'height'`/`'none'` = paragraph text that wraps
// at the box width). Fonts are loaded by the composition (fonts.ts) before the frame renders; until the
// layer's faces are ready it renders hidden (S11:FIX-003). Styled `runs` are inline spans.
//
// M2 text animators (S11 §4.2, wp-m2-text-anim). At rest (outside every window, unknown presets) the layer is
// exactly the plain text block (ANM-009). Inside a window:
// 1. the text (caps applied) is segmented into units (`@jasper/motion` segmentText; `char` → `word` for RTL and
//    complex scripts) and laid out as inline spans in the same text block — the same line breaks, kerning and
//    shaping as the plain block — and measured once per layout key in a layout effect (offsetLeft/Top/Width/
//    Height: layout boxes, unaffected by ancestor transforms; line units grouped with `groupLines`) (TXA-011);
// 2. that flow is hidden and an overlay draws every unit at its measured place as its own box, styled from the
//    values of the preset's value-engine build (`useAnimeValues`, canonical seek at the window's frame) —
//    transforms, opacity, blur, letter spacing, reveal (TXA-010). Units may leave the box (no clipping, TXA-012)
//    except inside mask-reveal's per-line masks. Measured boxes are whole pixels, so the glyph shift at the
//    window boundary stays below 1 px (TXA-013).
import { groupLines, hash32, segmentText, type TextSegment, useAnimeValues } from '@jasper/motion';
import {
	type ActiveTextAnimation,
	activeTextAnimation,
	REST_UNIT_VALUES,
	type TextAnimationImpl,
	textAnimationImpl,
	textAnimationUnit,
	type UnitValues,
} from '@jasper/motion/text';
import { sourceTextAt, type TextContent, type TextStyle } from '@jasper/project';
import { type CSSProperties, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FALLBACK_FONT_STACK, fontFaceFor, useFontsReady } from '../fonts.ts';
import { rgbaCss } from '../metadata.ts';
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';
import { type TypesetSourceProps, TypesetText } from './text/TypesetText.tsx';
import { needsTypeset } from './text/typography.ts';

type TextSource = Extract<LayerProps['clip']['source'], { text: unknown }>;
type Fonts = LayerProps['fonts'];
type TextRun = NonNullable<TextContent['runs']>[number];
type RunStyle = TextRun['style'];

function textFontFamily(fontId: string, fonts: Fonts, weight?: number, italic?: boolean): string {
	const face = fontFaceFor(fonts, fontId, weight, italic);
	return face ? `"${face.family.replace(/"/g, '')}", ${FALLBACK_FONT_STACK}` : FALLBACK_FONT_STACK;
}

/** The family a style renders with (the loaded face's family), or null for the fallback stack. */
function faceFamily(s: Pick<TextStyle, 'fontId' | 'weight' | 'italic'>, fonts: Fonts): string | null {
	return fontFaceFor(fonts, s.fontId, s.weight, s.italic)?.family ?? null;
}

function strokeCss(s: Pick<TextStyle, 'strokes'>): CSSProperties {
	const stroke = s.strokes[0];
	if (!stroke || stroke.widthPx <= 0) return {};
	// S03:TXT-003: outside strokes are drawn at double width under the fill (paint-order), so they
	// never eat into glyphs; centered strokes straddle the outline; inside strokes fall back to
	// centered in M1 (SVG text path is P1).
	const outside = stroke.position === 'outside';
	return {
		WebkitTextStroke: `${outside ? stroke.widthPx * 2 : stroke.widthPx}px ${rgbaCss(stroke.color)}`,
		...(outside ? { paintOrder: 'stroke fill' } : {}),
	};
}

function shadowCss(shadow: TextStyle['shadow']): string | undefined {
	if (!shadow) return undefined;
	const rad = (shadow.angleDeg * Math.PI) / 180;
	const dx = Math.cos(rad) * shadow.distancePx;
	const dy = Math.sin(rad) * shadow.distancePx;
	return `${dx}px ${dy}px ${shadow.blurPx}px ${rgbaCss(shadow.color)}`;
}

/** Inline style of the text block. */
function textBlockStyle(source: TextSource, fonts: Fonts): CSSProperties {
	const s = source.text.style;
	const pointText = source.box.autoSize === 'width';
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
		...strokeCss(s),
	};
	const shadow = shadowCss(s.shadow);
	if (shadow) style.textShadow = shadow;
	return style;
}

/** Inline overrides of a styled run over the block style (only the fields the run sets). */
function runStyleCss(run: RunStyle, base: TextStyle, fonts: Fonts): CSSProperties {
	const s = { ...base, ...run } as TextStyle;
	const css: CSSProperties = {};
	if (run.fontId !== undefined || run.weight !== undefined || run.italic !== undefined)
		css.fontFamily = textFontFamily(s.fontId, fonts, s.weight, s.italic);
	if (run.weight !== undefined) css.fontWeight = s.weight;
	if (run.italic !== undefined) css.fontStyle = s.italic ? 'italic' : 'normal';
	if (run.sizePx !== undefined) css.fontSize = s.sizePx;
	if (run.lineHeight !== undefined) css.lineHeight = s.lineHeight;
	if (run.trackingEm !== undefined) css.letterSpacing = `${s.trackingEm}em`;
	if (run.fill !== undefined) css.color = rgbaCss(s.fill);
	if (run.allCaps !== undefined) css.textTransform = s.allCaps ? 'uppercase' : 'none';
	if (run.strokes !== undefined) Object.assign(css, { WebkitTextStroke: '0px transparent' }, strokeCss(s));
	if (run.shadow !== undefined) css.textShadow = shadowCss(s.shadow) ?? 'none';
	return css;
}

type StyledSpan = { from: number; to: number; style: RunStyle | null };

/** The text cut at run boundaries; each piece carries the merged style of the runs covering it (later win). */
function styledSpans(text: string, runs: readonly TextRun[] | undefined): StyledSpan[] {
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

function RestText({ source, fonts, hidden }: { source: TextSource; fonts: Fonts; hidden: boolean }) {
	const { text, style, runs } = source.text;
	const block = textBlockStyle(source, fonts);
	let content: ReactNode = text;
	if (runs?.length)
		content = styledSpans(text, runs).map((s) =>
			s.style ? (
				<span key={s.from} style={runStyleCss(s.style, style, fonts)}>
					{text.slice(s.from, s.to)}
				</span>
			) : (
				text.slice(s.from, s.to)
			),
		);
	return (
		<p data-text-block="" style={hidden ? { ...block, visibility: 'hidden' } : block}>
			{content}
		</p>
	);
}

/** One piece of the flow: a whitespace run or (part of) a unit, in one style. */
type FlowPiece = {
	text: string;
	/** Offset in the caps-applied text (stable React key). */
	at: number;
	/** Index into `Flow.styles` (-1 = block style). */
	style: number;
	/** Segment unit (char/word index) or -1 for whitespace. */
	unit: number;
	/** First piece of its unit (the one `groupLines` measures). */
	first: boolean;
	/** Base direction of its bidi paragraph: the overlay draws every piece as its own box, so it is explicit. */
	rtl: boolean;
};

type Flow = {
	unit: ReturnType<typeof textAnimationUnit>;
	pieces: FlowPiece[];
	styles: RunStyle[];
	/** Number of segment units (chars or words). */
	units: number;
};

const PARAGRAPH_SEPARATOR = /\r\n|[\n\r\u0085\u2029]/g;
/** First strong character (UAX #9 P2): group 1 = right-to-left (RLM, ALM, letters of the RTL blocks), else LTR. */
const FIRST_STRONG =
	/(\u200F|\u061C|(?=\p{L})[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}])|\u200E|\p{L}/u;

/**
 * Right-to-left of every bidi paragraph of `text` (by its end offset) for `direction: 'auto'`: the block is
 * `unicode-bidi: plaintext` (each paragraph takes the direction of its first strong character, none = LTR), but
 * `unicode-bidi` is not inherited, so the absolutely positioned overlay pieces would each start an LTR paragraph
 * and reorder neutrals ("שלום!" would draw "!" on the right while animating).
 */
function paragraphDirections(text: string): { end: number; rtl: boolean }[] {
	const out: { end: number; rtl: boolean }[] = [];
	let from = 0;
	const push = (to: number, end: number) => {
		const m = FIRST_STRONG.exec(text.slice(from, to));
		out.push({ end, rtl: !!m?.[1] });
	};
	for (const sep of text.matchAll(PARAGRAPH_SEPARATOR)) {
		const end = sep.index + sep[0].length;
		push(sep.index, end);
		from = end;
	}
	push(text.length, Number.POSITIVE_INFINITY);
	return out;
}

/** Segments the caps-applied text into units and cuts them at style boundaries (S11:TXA-010). */
function buildFlow(source: TextSource, impl: TextAnimationImpl, params: Record<string, unknown>): Flow {
	const { text, style: base, runs } = source.text;
	const styles: RunStyle[] = [];
	// Caps are applied before segmentation (ß → SS counts as two characters).
	const parts = styledSpans(text, runs).map((s) => {
		const caps = s.style?.allCaps ?? base.allCaps;
		const slice = text.slice(s.from, s.to);
		if (s.style) styles.push(s.style);
		return { text: caps ? slice.toUpperCase() : slice, style: s.style ? styles.length - 1 : -1 };
	});
	const full = parts.map((p) => p.text).join('');
	const paragraphs = base.direction === 'auto' ? paragraphDirections(full) : [];
	const rtlAt = (at: number) =>
		base.direction === 'auto' ? !!paragraphs.find((p) => at < p.end)?.rtl : base.direction === 'rtl';
	const unit = textAnimationUnit(impl, params, full);
	const segments: TextSegment[] = segmentText(full, unit === 'line' ? 'word' : unit);
	const pieces: FlowPiece[] = [];
	let partIndex = 0;
	let partEnd = parts[0]?.text.length ?? 0;
	let pos = 0;
	let units = 0;
	for (const seg of segments) {
		let rest = seg.text;
		let first = true;
		units = Math.max(units, seg.unitIndex + 1);
		while (rest.length) {
			while (pos >= partEnd && partIndex + 1 < parts.length) partEnd += parts[++partIndex]!.text.length;
			const take = Math.min(rest.length, partEnd - pos);
			pieces.push({
				text: rest.slice(0, take),
				at: pos,
				style: parts[partIndex]!.style,
				unit: seg.unitIndex,
				first,
				rtl: rtlAt(pos),
			});
			first = false;
			rest = rest.slice(take);
			pos += take;
		}
	}
	return { unit, pieces, styles, units };
}

type Box = { left: number; top: number; width: number; height: number };
/** A unit piece with its measured box. */
type Placed = { piece: FlowPiece; index: number; box: Box };

type Measured = {
	key: string;
	/** Layout box of every unit piece (by piece index; whitespace pieces: null). */
	boxes: (Box | null)[];
	/** Line of every segment unit. */
	lineOf: number[];
	lines: number;
};

function measureFlow(p: HTMLElement, flow: Flow, key: string): Measured {
	const boxes: (Box | null)[] = flow.pieces.map(() => null);
	for (const el of p.querySelectorAll<HTMLElement>('[data-text-piece]')) {
		boxes[Number(el.dataset.textPiece)] = {
			left: el.offsetLeft,
			top: el.offsetTop,
			width: el.offsetWidth,
			height: el.offsetHeight,
		};
	}
	const lineOf = groupLines(p, '[data-text-unit]');
	return { key, boxes, lineOf, lines: lineOf.length ? Math.max(...lineOf) + 1 : 0 };
}

const union = (boxes: Box[]): Box => {
	const left = Math.min(...boxes.map((b) => b.left));
	const top = Math.min(...boxes.map((b) => b.top));
	const right = Math.max(...boxes.map((b) => b.left + b.width));
	const bottom = Math.max(...boxes.map((b) => b.top + b.height));
	return { left, top, width: right - left, height: bottom - top };
};

/** Style of an animated box from its values (identity values add nothing). */
function valuesCss(
	v: Readonly<UnitValues>,
	shiftX: number,
	shiftY: number,
	plainReveal: boolean,
): CSSProperties {
	const x = v.x + shiftX;
	const y = v.y + shiftY;
	const parts: string[] = [];
	if (x !== 0 || y !== 0) parts.push(`translate(${x}px, ${y}px)`);
	if (v.scale !== 1) parts.push(`scale(${v.scale})`);
	if (v.rotate !== 0) parts.push(`rotate(${v.rotate}deg)`);
	return {
		...(parts.length ? { transform: parts.join(' ') } : {}),
		...(v.opacity !== 1 ? { opacity: Math.min(1, Math.max(0, v.opacity)) } : {}),
		...(v.blur > 0 ? { filter: `blur(${v.blur}px)` } : {}),
		...(plainReveal && v.reveal < 1 ? { visibility: 'hidden' as const } : {}),
	};
}

function AnimatedText({
	source,
	fonts,
	active,
	impl,
	seed,
	fps,
}: {
	source: TextSource;
	fonts: Fonts;
	active: ActiveTextAnimation;
	impl: TextAnimationImpl;
	seed: number;
	fps: number;
}) {
	const pRef = useRef<HTMLParagraphElement>(null);
	const params = active.animator.params;
	const flow = useMemo(() => buildFlow(source, impl, params), [source, impl, params]);
	const block = textBlockStyle(source, fonts);
	const layoutKey = JSON.stringify([source.text, source.box, flow.unit, fonts]);
	const [measured, setMeasured] = useState<Measured | null>(null);
	const m = measured?.key === layoutKey ? measured : null;
	// review fix (unmeasured while display:none) — begin
	const [, relayout] = useState(0);
	// Measure once per layout key before paint. A display:none layer (e.g. the editor hidden during Export) has no
	// layout yet: observe the block and render again as soon as it gets one (no playhead move needed).
	useLayoutEffect(() => {
		const p = pRef.current;
		if (m || !p) return;
		if (p.offsetParent !== null) {
			setMeasured(measureFlow(p, flow, layoutKey));
			return;
		}
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => {
			if (p.offsetParent !== null) relayout((n) => n + 1);
		});
		ro.observe(p);
		return () => ro.disconnect();
	});
	// review fix (unmeasured while display:none) — end
	const lineMode = flow.unit === 'line';
	const units = m ? (lineMode ? m.lines : flow.units) : 0;
	const box = source.box;
	const buildKey = JSON.stringify([
		impl.key,
		active.side,
		units,
		active.durationMs,
		params,
		seed,
		box.width,
		box.height,
	]);
	const values = useAnimeValues(
		buildKey,
		() =>
			impl.build({
				units,
				...(m ? { lineOf: m.lineOf } : {}),
				side: active.side,
				durationMs: active.durationMs,
				params,
				seed,
				box: { width: box.width, height: box.height },
			}),
		active.ms,
	);

	const cssOf = (i: number) => (i < 0 ? undefined : runStyleCss(flow.styles[i]!, source.text.style, fonts));
	const flowNodes = flow.pieces.map((pc, i) =>
		pc.unit < 0 ? (
			pc.style < 0 ? (
				pc.text
			) : (
				<span key={pc.at} style={cssOf(pc.style)}>
					{pc.text}
				</span>
			)
		) : (
			<span
				key={pc.at}
				data-text-piece={i}
				{...(pc.first ? { 'data-text-unit': '' } : {})}
				style={cssOf(pc.style)}
			>
				{pc.text}
			</span>
		),
	);
	// Unmeasured: hidden, never the rest state inside a window (review fix).
	if (!m)
		return (
			<p
				ref={pRef}
				data-text-block=""
				data-text-animating="measure"
				style={{ ...block, visibility: 'hidden' }}
			>
				{flowNodes}
			</p>
		);
	return (
		<p
			ref={pRef}
			data-text-block=""
			data-text-animating={active.side}
			style={{ ...block, visibility: 'hidden' }}
		>
			{flowNodes}
			<TextOverlay
				source={source}
				fonts={fonts}
				flow={flow}
				m={m}
				values={values}
				impl={impl}
				params={params}
				caretLit={(shown) =>
					impl.caretVisible?.({
						params,
						side: active.side,
						ms: active.ms,
						durationMs: active.durationMs,
						fps,
						units,
						shown,
					}) ?? true
				}
			/>
		</p>
	);
}

/** Grapheme count of a string (letter-spacing is added after every grapheme). */
const graphemes = (s: string) => segmentText(s, 'char').length;

function TextOverlay({
	source,
	fonts,
	flow,
	m,
	values,
	impl,
	params,
	caretLit,
}: {
	source: TextSource;
	fonts: Fonts;
	flow: Flow;
	m: Measured;
	values: readonly Readonly<UnitValues>[];
	impl: TextAnimationImpl;
	params: Record<string, unknown>;
	/** Whether the caret is lit with `shown` units fully shown (blink; a pure function of the frame). */
	caretLit: (shown: number) => boolean;
}) {
	const base = source.text.style;
	const lineMode = flow.unit === 'line';
	const masks = !!impl.lineMasks;
	const styleOf = (i: number) => (i < 0 ? base : ({ ...base, ...flow.styles[i] } as TextStyle));
	// Pieces of every segment unit with their boxes (by unit index), and the units of every line.
	const unitPieces: Placed[][] = Array.from({ length: flow.units }, () => []);
	flow.pieces.forEach((piece, index) => {
		const box = m.boxes[index];
		if (piece.unit >= 0 && box) unitPieces[piece.unit]!.push({ piece, index, box });
	});
	const placedUnits = unitPieces.flatMap((list, unit) => (list.length ? [unit] : []));
	const lines: number[][] = Array.from({ length: m.lines }, () => []);
	for (const unit of placedUnits) lines[m.lineOf[unit] ?? 0]?.push(unit);
	const unitValues = (unit: number) => values[lineMode ? (m.lineOf[unit] ?? 0) : unit] ?? REST_UNIT_VALUES;
	/** Letter-spacing growth of a set of pieces at `em` extra (shifted back by half to grow from the centre). */
	const spacingShift = (pieces: { piece: FlowPiece }[], em: number) =>
		em === 0
			? 0
			: -pieces.reduce((s, p) => s + em * styleOf(p.piece.style).sizePx * graphemes(p.piece.text), 0) / 2;
	const pieceNode = (p: Placed, origin: Box, em: number) => {
		const st = styleOf(p.piece.style);
		return (
			<span
				key={p.piece.at}
				style={{
					...(p.piece.style < 0 ? {} : runStyleCss(flow.styles[p.piece.style]!, base, fonts)),
					position: 'absolute',
					left: p.box.left - origin.left,
					top: p.box.top - origin.top,
					lineHeight: `${p.box.height}px`,
					whiteSpace: 'pre',
					direction: p.piece.rtl ? 'rtl' : 'ltr',
					...(em !== 0 ? { letterSpacing: `${st.trackingEm + em}em` } : {}),
				}}
			>
				{p.piece.text}
			</span>
		);
	};
	const strokeW = Math.max(0, ...[base, ...flow.styles].map((s) => s.strokes?.[0]?.widthPx ?? 0));
	const out: ReactNode[] = [];
	lines.forEach((units, line) => {
		if (!units.length) return;
		const all = units.flatMap((u) => unitPieces[u]!);
		const lineBox = union(all.map((p) => p.box));
		const size = Math.max(...all.map((p) => styleOf(p.piece.style).sizePx));
		// mask-reveal: a clip box around the line with room for accents, strokes and the horizontal motion.
		const bleedY = Math.ceil(size * 0.2 + strokeW);
		const bleedX = Math.ceil(size + strokeW);
		const mask: Box = masks
			? {
					left: lineBox.left - bleedX,
					top: lineBox.top - bleedY,
					width: lineBox.width + 2 * bleedX,
					height: lineBox.height + 2 * bleedY,
				}
			: { left: 0, top: 0, width: 0, height: 0 };
		const rise = (v: Readonly<UnitValues>) => (masks ? (1 - v.reveal) * mask.height : 0);
		const origin = masks ? mask : { left: 0, top: 0, width: 0, height: 0 };
		let content: ReactNode[];
		if (lineMode) {
			const v = unitValues(units[0]!);
			content = [
				<div
					key="line"
					style={{
						position: 'absolute',
						left: lineBox.left - origin.left,
						top: lineBox.top - origin.top,
						width: lineBox.width,
						height: lineBox.height,
						...valuesCss(v, spacingShift(all, v.letterSpacing), rise(v), !masks),
					}}
				>
					{all.map((p) => pieceNode(p, lineBox, v.letterSpacing))}
				</div>,
			];
		} else {
			content = units.map((unit) => {
				const pieces = unitPieces[unit]!;
				const ub = union(pieces.map((p) => p.box));
				const v = unitValues(unit);
				return (
					<div
						key={unit}
						data-text-unit-index={unit}
						style={{
							position: 'absolute',
							left: ub.left - origin.left,
							top: ub.top - origin.top,
							width: ub.width,
							height: ub.height,
							...valuesCss(v, spacingShift(pieces, v.letterSpacing), rise(v), !masks),
						}}
					>
						{pieces.map((p) => pieceNode(p, ub, v.letterSpacing))}
					</div>
				);
			});
		}
		out.push(
			masks ? (
				<div
					key={units[0]}
					data-text-mask={line}
					style={{
						position: 'absolute',
						left: mask.left,
						top: mask.top,
						width: mask.width,
						height: mask.height,
						overflow: 'hidden',
					}}
				>
					{content}
				</div>
			) : (
				<div key={units[0]} data-text-line={line} style={{ position: 'absolute', left: 0, top: 0 }}>
					{content}
				</div>
			),
		);
	});
	const caretShown = impl.caret?.(params) && placedUnits.length > 0 && !lineMode;
	if (caretShown && caretLit(values.filter((v) => v.reveal >= 1).length)) {
		const shown = placedUnits.filter((u) => unitValues(u).reveal >= 1);
		const anchorPieces = unitPieces[shown.at(-1) ?? placedUnits[0]!]!;
		const rtl = anchorPieces[0]!.piece.rtl;
		const anchor = union(anchorPieces.map((p) => p.box));
		const after = shown.length > 0;
		const width = Math.max(2, Math.round(base.sizePx * 0.06));
		const x = after !== rtl ? anchor.left + anchor.width : anchor.left - width;
		out.push(
			<div
				key="caret"
				data-text-caret=""
				style={{
					position: 'absolute',
					left: x,
					top: anchor.top,
					width,
					height: anchor.height,
					background: rgbaCss(base.fill),
				}}
			/>,
		);
	}
	return (
		<div data-text-overlay="" style={{ position: 'absolute', left: 0, top: 0, visibility: 'visible' }}>
			{out}
		</div>
	);
}

export function TextLayer(layer: LayerProps) {
	const raw = layer.clip.source;
	// Wave expressions: a Source Text expression replaces the text at this frame. When it changes the text the
	// styled runs no longer line up with it, so the base style applies to all of it (as AE applies the first
	// character's style).
	const text = 'text' in raw ? sourceTextAt(raw.text, layer.contentTime) : '';
	const source = useMemo(
		() =>
			!('text' in raw) || text === raw.text.text
				? raw
				: { ...raw, text: { ...raw.text, text, runs: undefined } },
		[raw, text],
	);
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
			<TextBody layer={layer} source={source} />
		</LayerBox>
	);
}

function TextBody({ layer, source }: { layer: LayerProps; source: TextSource }) {
	const keyed = (source as TypesetSourceProps).sourceTextKeyframes;
	const families = useMemo(
		() =>
			[
				...new Set(
					[source.text, ...(keyed ?? []).map((k) => k.value)]
						.flatMap((c) => [c.style, ...(c.runs ?? []).map((r) => ({ ...c.style, ...r.style }))])
						.map((s) => faceFamily(s, layer.fonts))
						.filter((f): f is string => !!f),
				),
			].sort(),
		[source.text, keyed, layer.fonts],
	);
	const fontsReady = useFontsReady(families);
	// text-animators workstream: animators, Path Options, Source Text keys or extended typography → typeset renderer.
	if (needsTypeset(source as TypesetSourceProps) || keyed?.length)
		return fontsReady ? (
			<TypesetText layer={layer} source={source as TypesetSourceProps} hidden={false} />
		) : (
			<RestText source={source} fonts={layer.fonts} hidden />
		);
	const active = activeTextAnimation(source.animation, layer.localFrame, layer.clip.duration, layer.fps);
	const impl = active ? textAnimationImpl(active.animator) : undefined;
	if (!fontsReady || !active || !impl)
		return <RestText source={source} fonts={layer.fonts} hidden={!fontsReady} />;
	return (
		<AnimatedText
			source={source}
			fonts={layer.fonts}
			active={active}
			impl={impl}
			seed={hash32(layer.clip.clipId, 'text-anim', active.side)}
			fps={layer.fps}
		/>
	);
}
