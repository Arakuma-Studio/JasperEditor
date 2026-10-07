// Layout measurement of the typeset text renderer (workstream text-animators). The text is laid out by the
// browser — the same line breaking, shaping, kerning and justification as any DOM text — in an off-screen,
// untransformed copy of the text block (attached to `document.body`, so layer transforms and the Program
// monitor's zoom never round the measurements), and every grapheme is measured with a Range (sub-pixel rects).
// Baselines come from each font's ascent, measured once per font with a zero-size inline-block on the baseline.
// Optical kerning, manual kerning and tsume become per-character margins computed from the glyphs' side
// bearings (canvas `measureText` ink bounds), as EffectCraft's `space_item` does with the outlines.
import type { TextContent, TextStyle } from '@jasper/project';
import type { CSSProperties } from 'react';
import { charFlowCss, glyphSize, PARAGRAPH_FIELDS, paragraphCss, rise } from './typography.ts';

export type Rect = { left: number; top: number; width: number; height: number };

/** One grapheme of the laid-out text. */
export type TypesetGlyph = {
	/** The grapheme as written (caps are a style: the drawn span applies them like the flow). */
	text: string;
	/** UTF-16 offset in the source text. */
	offset: number;
	charIndex: number;
	charIndexNoSpace: number;
	wordIndex: number;
	lineIndex: number;
	paragraph: number;
	isSpace: boolean;
	/** Index into `TypesetLayout.styles`. */
	style: number;
	/** Range rect in the text box (null: not laid out, e.g. a line break). */
	rect: Rect | null;
	/** Baseline y (text box space; includes baseline shift / script rise). */
	baseline: number;
	/** Ascent of the run's font (rect top = baseline − ascent). */
	ascent: number;
};

export type TypesetLayout = {
	glyphs: TypesetGlyph[];
	counts: { chars: number; charsNoSpace: number; words: number; lines: number };
	/** Per line `[x, baseline, width]` (text box space). */
	lineBoxes: [number, number, number][];
	/** Merged style of every run piece (base ⊕ runs). */
	styles: TextStyle[];
	/** Paragraph style (base ⊕ paragraph overrides). */
	paragraphs: TextStyle[];
};

export type FontResolver = (s: Pick<TextStyle, 'fontId' | 'weight' | 'italic'>) => string;

const UNITLESS = new Set(['fontWeight', 'lineHeight', 'opacity', 'zIndex', 'flex', 'order']);

/** Applies React-style CSS to an element (numbers get `px` except unitless properties). */
export function applyCss(el: HTMLElement, css: CSSProperties): void {
	const st = el.style as unknown as Record<string, string>;
	for (const [k, v] of Object.entries(css)) {
		if (v === undefined || v === null) continue;
		st[k] = typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : String(v);
	}
}

const graphemeSegmenter =
	typeof Intl !== 'undefined' && 'Segmenter' in Intl
		? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
		: null;

/** Graphemes of a string with their UTF-16 offsets. */
export function graphemes(text: string): { text: string; offset: number }[] {
	if (graphemeSegmenter) return [...graphemeSegmenter.segment(text)].map((s) => ({ text: s.segment, offset: s.index }));
	const out: { text: string; offset: number }[] = [];
	let i = 0;
	for (const ch of text) {
		out.push({ text: ch, offset: i });
		i += ch.length;
	}
	return out;
}

const WS = /^\p{White_Space}+$/u;
export const isSpaceGrapheme = (g: string) => WS.test(g);

/** Styled runs of the text: pieces between run boundaries with the merged style (later runs win). */
export function styledPieces(content: TextContent): { from: number; to: number; style: TextStyle }[] {
	const { text, style: base, runs } = content;
	if (!runs?.length) return text ? [{ from: 0, to: text.length, style: base }] : [];
	const clampI = (i: number) => Math.min(text.length, Math.max(0, i));
	const cuts = [...new Set([0, text.length, ...runs.flatMap((r) => [clampI(r.from), clampI(r.to)])])].sort((a, b) => a - b);
	const out: { from: number; to: number; style: TextStyle }[] = [];
	for (let i = 0; i + 1 < cuts.length; i++) {
		const from = cuts[i]!;
		const to = cuts[i + 1]!;
		const covering = runs.filter((r) => r.from <= from && r.to >= to && r.to > r.from);
		out.push({ from, to, style: Object.assign({}, base, ...covering.map((r) => r.style)) as TextStyle });
	}
	return out;
}

/** Paragraph styles: base ⊕ the paragraph override (paragraph fields only). */
export function paragraphStyles(content: TextContent, count: number): TextStyle[] {
	return Array.from({ length: count }, (_, i) => {
		const o = content.paragraphs?.find((p) => p.index === i)?.style;
		if (!o) return content.style;
		const pick = Object.fromEntries(
			PARAGRAPH_FIELDS.filter((f) => (o as Record<string, unknown>)[f] !== undefined).map((f) => [f, (o as Record<string, unknown>)[f]]),
		);
		return { ...content.style, ...pick } as TextStyle;
	});
}

// ---------------------------------------------------------------- font metrics

const ascentCache = new Map<string, number>();

function fontKey(css: CSSProperties): string {
	return [css.fontFamily, css.fontWeight, css.fontStyle, css.fontSize, css.fontVariantCaps, css.fontVariationSettings].join('|');
}

/** Ascent of a font (distance from the content-area top to the baseline), measured in the DOM once per font. */
function ascentOf(css: CSSProperties, host: HTMLElement): number {
	const key = fontKey(css);
	const hit = ascentCache.get(key);
	if (hit !== undefined) return hit;
	const span = document.createElement('span');
	applyCss(span, { ...css, position: 'static', top: 0, lineHeight: 'normal' });
	const text = document.createTextNode('Hx');
	const marker = document.createElement('span');
	applyCss(marker, { display: 'inline-block', width: 0, height: 0, verticalAlign: 'baseline' });
	span.append(text, marker);
	host.append(span);
	const r = document.createRange();
	r.setStart(text, 0);
	r.setEnd(text, 2);
	const top = r.getBoundingClientRect().top;
	const base = marker.getBoundingClientRect().bottom;
	span.remove();
	const ascent = base - top;
	const v = Number.isFinite(ascent) && ascent > 0 ? ascent : (Number(css.fontSize) || 16) * 0.8;
	if (ascentCache.size > 500) ascentCache.clear();
	ascentCache.set(key, v);
	return v;
}

// ---------------------------------------------------------------- side bearings (optical kerning, tsume)

let canvasCtx: CanvasRenderingContext2D | null | undefined;
function ctx2d(): CanvasRenderingContext2D | null {
	if (canvasCtx === undefined) {
		try {
			canvasCtx = document.createElement('canvas').getContext('2d');
		} catch {
			canvasCtx = null;
		}
	}
	return canvasCtx;
}

/** Left and right side bearings of a grapheme in a style (px), or null when there is no ink / no canvas. */
export function sideBearings(g: string, s: TextStyle, family: string): [number, number] | null {
	const c = ctx2d();
	if (!c || isSpaceGrapheme(g)) return null;
	c.font = `${s.italic ? 'italic ' : ''}${s.smallCaps ? 'small-caps ' : ''}${s.weight} ${glyphSize(s)}px ${family}`;
	const m = c.measureText(s.allCaps ? g.toUpperCase() : g);
	const x0 = -m.actualBoundingBoxLeft;
	const x1 = m.actualBoundingBoxRight;
	if (!(x1 > x0)) return null;
	return [x0, m.width - x1];
}

/**
 * Per-grapheme extra space before / after (px) from optical kerning, manual kerning and tsume, in logical order
 * (EffectCraft `space_item`): tsume removes `t ·` side bearings; optical pulls each pair's ink gap halfway to the
 * run's median gap; manual adds `k/1000 em` before every grapheme except a paragraph's first.
 */
export function spacingAdjustments(
	gs: readonly { text: string; style: number; paragraphStart: boolean }[],
	styles: readonly TextStyle[],
	family: (s: TextStyle) => string,
): { before: number; after: number }[] {
	const out = gs.map(() => ({ before: 0, after: 0 }));
	const sides = gs.map((g) => {
		const s = styles[g.style]!;
		const k = s.kerning ?? 'metrics';
		const need = (s.tsume ?? 0) > 0 || k === 'optical';
		return need ? sideBearings(g.text, s, family(s)) : null;
	});
	// Tsume.
	gs.forEach((g, i) => {
		const t = Math.min(1, Math.max(0, (styles[g.style]!.tsume ?? 0) / 100));
		const sb = sides[i];
		if (t > 0 && sb) {
			out[i]!.before -= t * Math.max(0, sb[0]);
			out[i]!.after -= t * Math.max(0, sb[1]);
		}
	});
	// Optical kerning per run of consecutive optical graphemes of one style.
	let i = 0;
	while (i < gs.length) {
		const st = gs[i]!.style;
		let j = i;
		while (j < gs.length && gs[j]!.style === st) j++;
		if (styles[st]!.kerning === 'optical' && j - i > 1) {
			const gaps: (number | null)[] = [];
			for (let k = i + 1; k < j; k++) {
				const a = sides[k - 1];
				const b = sides[k];
				gaps.push(a && b ? a[1] + b[0] : null);
			}
			const sorted = gaps.filter((x): x is number => x !== null).sort((a, b) => a - b);
			const median = sorted[Math.floor(sorted.length / 2)];
			if (median !== undefined)
				gaps.forEach((gap, k) => {
					if (gap !== null) out[i + k + 1]!.before += (median - gap) * 0.5;
				});
		}
		i = j;
	}
	// Manual kerning.
	gs.forEach((g, n) => {
		const s = styles[g.style]!;
		if (typeof s.kerning === 'number' && !g.paragraphStart) out[n]!.before += (s.kerning * s.sizePx) / 1000;
	});
	return out;
}

// ---------------------------------------------------------------- the flow and its measurement

export type FlowInput = {
	content: TextContent;
	/** Text box width; point text (`autoSize: 'width'`) never wraps. */
	width: number;
	pointText: boolean;
	family: FontResolver;
	/** Graphemes replaced by another string (Character Offset / Value with Adjust Kerning), by grapheme index. */
	substitutions?: ReadonlyMap<number, string>;
};

type Piece = { from: number; to: number; style: number };

const PARAGRAPH_BREAK = /\r\n|[\n\r ]/g;

/** Builds the flow DOM of a text (paragraph blocks, run spans, per-grapheme spans where spacing is adjusted). */
function buildFlow(
	input: FlowInput,
	host: HTMLElement,
): { root: HTMLElement; layoutGlyphs: TypesetGlyph[]; nodes: ({ node: Text; start: number; end: number } | null)[]; styles: TextStyle[]; paragraphs: TextStyle[] } {
	const { content } = input;
	const text = content.text;
	const pieces = styledPieces(content);
	const styles = pieces.map((p) => p.style);
	const styleAt = (offset: number) => Math.max(0, pieces.findIndex((p) => offset >= p.from && offset < p.to));
	// Paragraph ranges [start, end) excluding the separator.
	const paras: { start: number; end: number; sepEnd: number }[] = [];
	let from = 0;
	for (const m of text.matchAll(PARAGRAPH_BREAK)) {
		paras.push({ start: from, end: m.index, sepEnd: m.index + m[0].length });
		from = m.index + m[0].length;
	}
	paras.push({ start: from, end: text.length, sepEnd: text.length });
	const paraStyles = paragraphStyles(content, paras.length);
	const gs = graphemes(text);
	// Logical indices.
	let words = 0;
	let inWord = false;
	let nospace = 0;
	const glyphs: TypesetGlyph[] = gs.map((g, ci) => {
		const space = isSpaceGrapheme(g.text);
		if (!space && !inWord) words++;
		inWord = !space;
		const p = Math.max(0, paras.findIndex((x) => g.offset < x.sepEnd));
		const out: TypesetGlyph = {
			text: g.text,
			offset: g.offset,
			charIndex: ci,
			charIndexNoSpace: nospace,
			wordIndex: Math.max(0, words - 1),
			lineIndex: 0,
			paragraph: p,
			isSpace: space,
			style: styleAt(g.offset),
			rect: null,
			baseline: 0,
			ascent: 0,
		};
		if (!space) nospace++;
		return out;
	});
	const adjust = spacingAdjustments(
		glyphs.map((g) => ({ text: g.text, style: g.style, paragraphStart: g.offset === paras[g.paragraph]!.start })),
		styles,
		(s) => input.family(s),
	);
	const root = document.createElement('div');
	applyCss(root, {
		position: 'absolute',
		left: 0,
		top: 0,
		width: input.width,
		margin: 0,
		padding: 0,
		boxSizing: 'border-box',
		fontSize: content.style.sizePx,
		lineHeight: content.style.lineHeight,
	});
	const nodes: ({ node: Text; start: number; end: number } | null)[] = glyphs.map(() => null);
	paras.forEach((pr, pi) => {
		const block = document.createElement('div');
		applyCss(block, { ...paragraphCss(paraStyles[pi]!, input.pointText, pi === 0, pi === paras.length - 1), lineHeight: content.style.lineHeight });
		const inPara = glyphs.filter((g) => g.offset >= pr.start && g.offset < pr.end);
		// Group consecutive graphemes of one style into run spans; graphemes with spacing or substitutions get their own.
		let k = 0;
		while (k < inPara.length) {
			const st = inPara[k]!.style;
			const span = document.createElement('span');
			applyCss(span, charFlowCss(styles[st]!, input.family(styles[st]!)));
			let textNode: Text | null = null;
			let buf = '';
			while (k < inPara.length && inPara[k]!.style === st) {
				const g = inPara[k]!;
				const adj = adjust[g.charIndex]!;
				const sub = input.substitutions?.get(g.charIndex);
				const own = adj.before !== 0 || adj.after !== 0 || sub !== undefined;
				const shown = sub ?? g.text;
				if (own) {
					textNode = null;
					const inner = document.createElement('span');
					applyCss(inner, { marginLeft: adj.before, marginRight: adj.after });
					const t = document.createTextNode(shown);
					inner.append(t);
					span.append(inner);
					nodes[g.charIndex] = { node: t, start: 0, end: shown.length };
				} else {
					if (!textNode) {
						textNode = document.createTextNode('');
						span.append(textNode);
						buf = '';
					}
					const start = buf.length;
					buf += shown;
					textNode.data = buf;
					nodes[g.charIndex] = { node: textNode, start, end: buf.length };
				}
				k++;
			}
			block.append(span);
		}
		if (inPara.length === 0) block.append(document.createElement('br'));
		root.append(block);
	});
	host.append(root);
	return { root, layoutGlyphs: glyphs, nodes, styles, paragraphs: paraStyles };
}

let measureHost: HTMLElement | null = null;
function host(): HTMLElement {
	if (measureHost?.isConnected) return measureHost;
	const h = document.createElement('div');
	h.setAttribute('data-text-measure-host', '');
	h.setAttribute('aria-hidden', 'true');
	applyCss(h, {
		position: 'fixed',
		left: 0,
		top: 0,
		width: 0,
		height: 0,
		overflow: 'hidden',
		visibility: 'hidden',
		pointerEvents: 'none',
		contain: 'strict',
		transform: 'none',
		zoom: 1,
	} as CSSProperties);
	document.body.append(h);
	measureHost = h;
	return h;
}

const layoutCache = new Map<string, TypesetLayout>();

/** Lays out and measures a text (cached by its inputs). */
export function measureTypeset(input: FlowInput, cacheKey: string): TypesetLayout {
	const hit = layoutCache.get(cacheKey);
	if (hit) return hit;
	const h = host();
	const inner = document.createElement('div');
	applyCss(inner, { position: 'absolute', left: 0, top: 0, width: Math.max(1, input.width), contain: 'layout style' } as CSSProperties);
	h.append(inner);
	const { root, layoutGlyphs, nodes, styles, paragraphs } = buildFlow(input, inner);
	const origin = root.getBoundingClientRect();
	const range = document.createRange();
	const fonts = styles.map((s) => charFlowCss(s, input.family(s)));
	for (const g of layoutGlyphs) {
		const n = nodes[g.charIndex];
		g.ascent = ascentOf(fonts[g.style]!, inner);
		if (!n || g.text === '\n' || g.text === '\r\n' || g.text === '\r') continue;
		range.setStart(n.node, n.start);
		range.setEnd(n.node, n.end);
		const r = range.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) continue;
		g.rect = { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height };
		g.baseline = g.rect.top + g.ascent;
	}
	inner.remove();
	// Lines: the unshifted baseline moves down in logical order at every line break.
	let line = -1;
	let current = Number.NEGATIVE_INFINITY;
	let lastPara = -1;
	for (const g of layoutGlyphs) {
		if (!g.rect) {
			g.lineIndex = Math.max(0, line);
			continue;
		}
		const b0 = g.baseline + rise(styles[g.style]!);
		if (line < 0 || b0 > current + 0.5 || g.paragraph !== lastPara) {
			line++;
			current = b0;
		} else current = Math.max(current, b0);
		lastPara = g.paragraph;
		g.lineIndex = line;
	}
	const lines = line + 1;
	const lineBoxes: [number, number, number][] = Array.from({ length: lines }, () => [Infinity, -Infinity, -Infinity]);
	for (const g of layoutGlyphs) {
		if (!g.rect) continue;
		const lb = lineBoxes[g.lineIndex]!;
		lb[0] = Math.min(lb[0], g.rect.left);
		lb[1] = Math.max(lb[1], g.baseline + rise(styles[g.style]!));
		lb[2] = Math.max(lb[2], g.rect.left + g.rect.width);
	}
	for (const lb of lineBoxes) lb[2] = lb[2] - lb[0];
	const last = layoutGlyphs[layoutGlyphs.length - 1];
	const out: TypesetLayout = {
		glyphs: layoutGlyphs,
		counts: {
			chars: layoutGlyphs.length,
			charsNoSpace: layoutGlyphs.filter((g) => !g.isSpace).length,
			words: last ? layoutGlyphs.reduce((m, g) => (g.isSpace ? m : Math.max(m, g.wordIndex + 1)), 0) : 0,
			lines,
		},
		lineBoxes: lineBoxes.map((b) => (Number.isFinite(b[0]) ? b : [0, 0, 0])),
		styles,
		paragraphs,
	};
	if (layoutCache.size > 200) layoutCache.delete(layoutCache.keys().next().value!);
	layoutCache.set(cacheKey, out);
	return out;
}

/** Advance of a grapheme drawn with variable-font axis offsets (px), measured off-screen; cached. */
const advanceCache = new Map<string, number>();
export function measureAdvance(text: string, css: CSSProperties): number {
	const key = `${fontKey(css)}|${css.letterSpacing}|${css.textTransform}|${text}`;
	const hit = advanceCache.get(key);
	if (hit !== undefined) return hit;
	const h = host();
	const span = document.createElement('span');
	applyCss(span, { ...css, position: 'absolute', whiteSpace: 'pre', top: 0, left: 0 });
	span.textContent = text;
	h.append(span);
	const w = span.getBoundingClientRect().width;
	span.remove();
	if (advanceCache.size > 5000) advanceCache.clear();
	advanceCache.set(key, w);
	return w;
}
