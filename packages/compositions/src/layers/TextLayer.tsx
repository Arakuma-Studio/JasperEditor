// Text layer (S03:TXT-001…005 subset, KND-050): DOM text inside the clip's text box. Fill, every
// stroke and the shadow (spec 13 SH-004, `text/paint.tsx`), background box, alignment, tracking, leading, caps and
// the box modes of S01
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
import { isVerticalText, sourceTextAt, type TextStyle } from '@jasper/project';
import { type CSSProperties, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fontFaceFor, useFontsReady } from '../fonts.ts';
import { rgbaCss } from '../metadata.ts';
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';
import { useTemplateEditHold } from './template-edit-hold.ts';
import {
	blockStyles,
	contentSpans,
	type RunStyle,
	runLayoutCss,
	textBlockStyle,
	UPRIGHT_TEXT_CSS,
} from './text/block.ts';
import { PaintedText, type PaintMode, paintCss, planTextPaint } from './text/paint.tsx';
import { type TypesetSourceProps, TypesetText } from './text/TypesetText.tsx';
import { needsTypeset } from './text/typography.ts';

type TextSource = Extract<LayerProps['clip']['source'], { text: unknown }>;
type Fonts = LayerProps['fonts'];

/** The family a style renders with (the loaded face's family), or null for the fallback stack. */
function faceFamily(s: Pick<TextStyle, 'fontId' | 'weight' | 'italic'>, fonts: Fonts): string | null {
	return fontFaceFor(fonts, s.fontId, s.weight, s.italic)?.family ?? null;
}

/** Attributes of one painted copy: the fill copy is the text block, the others are decoration. */
function copyAttrs(mode: PaintMode, block: string): Record<string, string | boolean> {
	return mode.kind === 'fill' ? { [block]: '' } : { 'data-text-copy': mode.kind, 'aria-hidden': true };
}

const maxSize = (styles: readonly TextStyle[]) => Math.max(1, ...styles.map((s) => s.sizePx));

function RestText({ source, fonts, hidden }: { source: TextSource; fonts: Fonts; hidden: boolean }) {
	const { text, style, runs } = source.text;
	const block = textBlockStyle(source, fonts);
	const styles = useMemo(() => blockStyles(source.text), [source.text]);
	const plan = useMemo(() => planTextPaint(styles), [styles]);
	const spans = runs?.length || isVerticalText(source.text) ? contentSpans(source.text) : null;
	const render = (mode: PaintMode) => (
		<p
			{...copyAttrs(mode, 'data-text-block')}
			style={{ ...block, ...paintCss(style, mode), ...(hidden ? { visibility: 'hidden' } : {}) }}
		>
			{spans
				? spans.map((s) =>
						s.style || s.upright ? (
							<span
								key={s.from}
								style={{
									...(s.style
										? {
												...runLayoutCss(s.style, style, fonts),
												...paintCss({ ...style, ...s.style } as TextStyle, mode),
											}
										: {}),
									...(s.upright ? UPRIGHT_TEXT_CSS : {}),
								}}
							>
								{text.slice(s.from, s.to)}
							</span>
						) : (
							text.slice(s.from, s.to)
						),
					)
				: text}
		</p>
	);
	// Until the faces are ready the block is laid out hidden (one copy is enough).
	if (hidden) return render({ kind: 'fill' });
	return (
		<PaintedText
			plan={plan}
			render={render}
			width={source.box.width}
			height={source.box.height}
			maxSizePx={maxSize(styles)}
		/>
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
	/** spec 19 TL-111: tate-chu-yoko. */
	upright: boolean;
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

/** spec 19 TL-111: a tate-chu-yoko run is one unit, or it would stop being one upright box. */
function mergeUprightUnits(segments: TextSegment[], ranges: { from: number; to: number }[]): TextSegment[] {
	if (!ranges.length) return segments;
	const out: TextSegment[] = [];
	let pos = 0;
	let units = 0;
	for (const seg of segments) {
		const at = pos;
		pos += seg.text.length;
		const last = out[out.length - 1];
		if (last && ranges.some((r) => at > r.from && at < r.to)) last.text += seg.text;
		else out.push(seg.space ? { ...seg } : { ...seg, unitIndex: units++ });
	}
	return out;
}

/** Segments the caps-applied text into units and cuts them at style boundaries (S11:TXA-010). */
function buildFlow(source: TextSource, impl: TextAnimationImpl, params: Record<string, unknown>): Flow {
	const { text, style: base } = source.text;
	const styles: RunStyle[] = [];
	// Caps are applied before segmentation (ß → SS counts as two characters).
	const parts = contentSpans(source.text).map((s) => {
		const caps = s.style?.allCaps ?? base.allCaps;
		const slice = text.slice(s.from, s.to);
		if (s.style) styles.push(s.style);
		return {
			text: caps ? slice.toUpperCase() : slice,
			style: s.style ? styles.length - 1 : -1,
			upright: !!s.upright,
		};
	});
	const full = parts.map((p) => p.text).join('');
	const paragraphs = base.direction === 'auto' ? paragraphDirections(full) : [];
	const rtlAt = (at: number) =>
		base.direction === 'auto' ? !!paragraphs.find((p) => at < p.end)?.rtl : base.direction === 'rtl';
	const unit = textAnimationUnit(impl, params, full);
	const uprightRanges: { from: number; to: number }[] = [];
	parts.reduce((at, p) => {
		if (p.upright) uprightRanges.push({ from: at, to: at + p.text.length });
		return at + p.text.length;
	}, 0);
	const segments = mergeUprightUnits(segmentText(full, unit === 'line' ? 'word' : unit), uprightRanges);
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
				upright: parts[partIndex]!.upright,
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

/** `groupLines` for columns (spec 19 TL-111): a unit starts a new one when its centre lies left of the current one. */
function groupColumns(container: HTMLElement, selector: string): number[] {
	const out: number[] = [];
	let line = -1;
	let left = Number.POSITIVE_INFINITY;
	for (const el of container.querySelectorAll<HTMLElement>(selector)) {
		const x = el.offsetLeft;
		if (line < 0 || x + el.offsetWidth / 2 < left) {
			line++;
			left = x;
		} else left = Math.min(left, x);
		out.push(line);
	}
	return out;
}

function measureFlow(p: HTMLElement, flow: Flow, key: string, vertical: boolean): Measured {
	const boxes: (Box | null)[] = flow.pieces.map(() => null);
	for (const el of p.querySelectorAll<HTMLElement>('[data-text-piece]')) {
		boxes[Number(el.dataset.textPiece)] = {
			left: el.offsetLeft,
			top: el.offsetTop,
			width: el.offsetWidth,
			height: el.offsetHeight,
		};
	}
	const lineOf = (vertical ? groupColumns : groupLines)(p, '[data-text-unit]');
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
	const vertical = isVerticalText(source.text);
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
			setMeasured(measureFlow(p, flow, layoutKey, vertical));
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

	const cssOf = (pc: FlowPiece) => ({
		...(pc.style < 0 ? {} : runLayoutCss(flow.styles[pc.style]!, source.text.style, fonts)),
		...(pc.upright ? UPRIGHT_TEXT_CSS : {}),
	});
	const flowNodes = flow.pieces.map((pc, i) =>
		pc.unit < 0 ? (
			pc.style < 0 ? (
				pc.text
			) : (
				<span key={pc.at} style={cssOf(pc)}>
					{pc.text}
				</span>
			)
		) : (
			<span key={pc.at} data-text-piece={i} {...(pc.first ? { 'data-text-unit': '' } : {})} style={cssOf(pc)}>
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
	const vertical = isVerticalText(source.text);
	const lineMode = flow.unit === 'line';
	const masks = !!impl.lineMasks;
	const styleOf = (i: number) => (i < 0 ? base : ({ ...base, ...flow.styles[i] } as TextStyle));
	const allStyles = [base, ...flow.styles.map((st) => ({ ...base, ...st }) as TextStyle)];
	const plan = planTextPaint(allStyles);
	const sizeMax = maxSize(allStyles);
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
	const pieceNode = (p: Placed, origin: Box, em: number, mode: PaintMode) => {
		const st = styleOf(p.piece.style);
		return (
			<span
				key={p.piece.at}
				style={{
					...(p.piece.style < 0 ? {} : runLayoutCss(flow.styles[p.piece.style]!, base, fonts)),
					...(p.piece.upright ? UPRIGHT_TEXT_CSS : {}),
					...paintCss(st, mode),
					position: 'absolute',
					left: p.box.left - origin.left,
					top: p.box.top - origin.top,
					lineHeight: `${vertical ? p.box.width : p.box.height}px`,
					whiteSpace: 'pre',
					direction: p.piece.rtl ? 'rtl' : 'ltr',
					...(em !== 0 ? { letterSpacing: `${st.trackingEm + em}em` } : {}),
				}}
			>
				{p.piece.text}
			</span>
		);
	};
	/** A unit's (or line's) pieces with every paint pass (spec 13 SH-004), inside its animated box. */
	const painted = (pieces: Placed[], origin: Box, em: number) => (
		<PaintedText
			plan={plan}
			render={(mode) => <>{pieces.map((p) => pieceNode(p, origin, em, mode))}</>}
			width={origin.width}
			height={origin.height}
			maxSizePx={sizeMax}
		/>
	);
	/** The animated box's shift for a letter-spacing growth: along the line, which runs down a column. */
	const animatedCss = (v: Readonly<UnitValues>, spread: number, lift: number) =>
		vertical ? valuesCss(v, 0, spread + lift, !masks) : valuesCss(v, spread, lift, !masks);
	const strokeW = plan.strokeExtent;
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
						...animatedCss(v, spacingShift(all, v.letterSpacing), rise(v)),
					}}
				>
					{painted(all, lineBox, v.letterSpacing)}
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
							...animatedCss(v, spacingShift(pieces, v.letterSpacing), rise(v)),
						}}
					>
						{painted(pieces, ub, v.letterSpacing)}
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
		const y = after ? anchor.top + anchor.height : anchor.top - width;
		out.push(
			<div
				key="caret"
				data-text-caret=""
				style={{
					position: 'absolute',
					...(vertical
						? { left: anchor.left, top: y, width: anchor.width, height: width }
						: { left: x, top: anchor.top, width, height: anchor.height }),
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

function TextBody({ layer, source: drawn }: { layer: LayerProps; source: TextSource }) {
	// spec 19 TL-085: while text is edited in place it rests, so the caret sits over the settled layout. Previews only.
	const held = useTemplateEditHold(layer.clip.clipId) && layer.options.isPreview;
	const source = useMemo(
		() => (held ? ({ ...drawn, animators: undefined, animation: undefined } as TextSource) : drawn),
		[held, drawn],
	);
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
