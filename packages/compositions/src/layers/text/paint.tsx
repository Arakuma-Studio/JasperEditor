// Text paint (spec 13 SH-004, docs/wp-notes/text-render.md): every stroke of `TextStyle.strokes[]` (outside /
// centre / inside, each with its colour, width and opacity) and the shadow (offset, blur, spread, opacity), drawn
// the same way by every text renderer — the plain block, the In/Out animation overlay, the typeset (animator)
// renderer and caption clips — and so identically in the Program monitor and in every export (all of them draw
// these components in Chromium: the Player, Remotion renders, layer bakes, stills and thumbnails).
//
// Model (bottom to top): background, shadow, fill, then the strokes from the last in the list to the first. A stroke
// paints only its region around the glyph outlines: outside = [0, w] outward, centre = [−w/2, w/2], inside = [−w, 0].
// The browser strokes text only centred on the outline (`-webkit-text-stroke`, miter joins), so a stroke of width w
// at a position is a centred stroke of width 2w (outside, inside) or w (centre) cut to its side of the outline.
// The text is drawn several times with the same layout (one *copy* per pass, `render(mode)`); only colours and text
// strokes differ between copies, which never changes the layout.
//
// Fast path (no filter): when no stroke is inside, every fill is opaque and every centre stroke lies above every
// outside stroke in the list, the outside strokes can be drawn as whole centred strokes *under* the opaque fill
// (which hides their inner half) and the centre strokes over it — exactly the model, with no seams.
//
// Filter path (any inside stroke, a translucent fill with an outside stroke, or a centre stroke below an outside
// one): the copies are laid side by side in one element (tiles: fill, glyph mask, one tile per stroke slot and
// position) and an SVG filter aligns them (`feOffset` by whole tiles) and composites them exactly at the glyph edges:
//   inner = stack of the inside / centre bands, outer = stack of the outside / centre bands (list order),
//   result = (inner ∩ glyph) + fill × (1 − α(inner)) + (outer − glyph)            (premultiplied, additive)
// The glyph coverage splits every edge pixel between the inside and the outside, so no conflation seam appears.
//
// Shadow: the silhouette of the glyphs and their outer strokes, grown by the spread (a centred text stroke of
// 2 × (outer stroke + spread) in the shadow colour), blurred by a Gaussian of σ = blur / 2, offset, at the shadow
// colour's opacity (one layer per distinct shadow of the styled runs). It shows through translucent fills, as the
// CSS text-shadow it replaces did.
import {
	type DrawnStroke,
	drawnStrokes,
	type ResolvedTextShadow,
	resolveTextShadow,
	type TextStrokePosition,
	type TextStyle,
	textStrokeExtent,
} from '@jasper/project';
import {
	type CSSProperties,
	Fragment,
	type ReactNode,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';
import { rgbaCss } from '../../metadata.ts';

/** What one copy of the text paints. */
export type PaintMode =
	/** The fill (real colours). */
	| { kind: 'fill' }
	/** The centred stroke of slot `slot` of the spans whose stroke in that slot has `position`; others draw nothing. */
	| { kind: 'band'; slot: number; position: TextStrokePosition }
	/** Opaque white glyphs (the glyph coverage of the filter path). */
	| { kind: 'mask' }
	/** The grown silhouette in the opaque shadow colour, for the spans whose shadow has key `key`. */
	| { kind: 'shadow'; key: string }
	/** Nothing but backgrounds (caption line boxes): text and strokes transparent. */
	| { kind: 'background' };

const NONE: CSSProperties = { color: 'transparent', WebkitTextStroke: '0px transparent' };
const opaque = (c: readonly number[]) => rgbaCss([c[0]!, c[1]!, c[2]!, 1]);

/** Identity of a resolved shadow (spans with equal keys share a shadow layer). */
function shadowKey(sh: ResolvedTextShadow): string {
	return JSON.stringify([sh.dx, sh.dy, sh.sigma, sh.spreadPx, sh.color]);
}

/** The stroke of `slot` a style draws, if any. */
function strokeAt(s: TextStyle, slot: number): DrawnStroke | undefined {
	return drawnStrokes(s).find((d) => d.slot === slot);
}

/**
 * Paint CSS of a block or span in a mode: colour and text stroke only (layout-neutral). `fauxBoldPx` (typeset faux
 * bold) thickens the glyphs by a stroke in the fill colour; bands and the mask follow the thickened outline.
 */
export function paintCss(s: TextStyle, mode: PaintMode, fauxBoldPx = 0): CSSProperties {
	const fb = fauxBoldPx > 0 ? fauxBoldPx : 0;
	switch (mode.kind) {
		case 'fill':
			return {
				color: rgbaCss(s.fill),
				WebkitTextStroke: fb ? `${fb.toFixed(3)}px ${rgbaCss(s.fill)}` : '0px transparent',
			};
		case 'mask':
			return { color: '#fff', WebkitTextStroke: fb ? `${fb.toFixed(3)}px #fff` : '0px transparent' };
		case 'background':
			return NONE;
		case 'band': {
			const st = strokeAt(s, mode.slot);
			if (!st || st.position !== mode.position) return NONE;
			// Centred stroke widths around the (faux-bold) outline: outside / inside 2w, centre w.
			const w =
				st.position === 'center'
					? st.widthPx + fb
					: st.position === 'outside'
						? 2 * st.widthPx + fb
						: Math.max(0, 2 * st.widthPx - fb);
			if (w <= 0) return NONE;
			return { color: 'transparent', WebkitTextStroke: `${w.toFixed(3)}px ${rgbaCss(st.color)}` };
		}
		case 'shadow': {
			const sh = resolveTextShadow(s.shadow);
			if (!sh || shadowKey(sh) !== mode.key) return NONE;
			const grow = textStrokeExtent(s) + sh.spreadPx;
			const w = 2 * grow + fb;
			return {
				color: opaque(sh.color),
				WebkitTextStroke: w > 0 ? `${w.toFixed(3)}px ${opaque(sh.color)}` : '0px transparent',
			};
		}
	}
}

/** One stroke pass of a plan: a slot and position some span draws. */
export type PaintBand = { slot: number; position: TextStrokePosition };

/** How a set of styles is painted. */
export type TextPaintPlan = {
	/** Distinct shadows (first seen first). */
	shadows: { key: string; shadow: ResolvedTextShadow }[];
	/** Stroke passes, bottom first (the last slot first). */
	bands: PaintBand[];
	/** The exact tile filter is needed (see the header); else the fast path. */
	filter: boolean;
	/** How far strokes reach outside the outlines (max over the styles, faux bold included). */
	strokeExtent: number;
};

/**
 * The paint plan of the styles a text draws with (`styles`: every effective style — the base style, each styled
 * run, highlight colours…). `fauxBoldPx` thickens the outlines (typeset faux bold).
 */
export function planTextPaint(styles: readonly TextStyle[], fauxBoldPx = 0): TextPaintPlan {
	const shadows = new Map<string, ResolvedTextShadow>();
	const bands = new Map<string, PaintBand>();
	let translucentFill = false;
	let strokeExtent = 0;
	for (const s of styles) {
		if (!(s.fill?.[3] !== undefined && s.fill[3] >= 1)) translucentFill = true;
		const sh = resolveTextShadow(s.shadow);
		if (sh) {
			const k = shadowKey(sh);
			if (!shadows.has(k)) shadows.set(k, sh);
		}
		for (const d of drawnStrokes(s))
			bands.set(`${d.slot}:${d.position}`, { slot: d.slot, position: d.position });
		strokeExtent = Math.max(strokeExtent, textStrokeExtent(s));
	}
	const list = [...bands.values()].sort((a, b) => b.slot - a.slot || a.position.localeCompare(b.position));
	const outside = list.filter((b) => b.position === 'outside').map((b) => b.slot);
	const centre = list.filter((b) => b.position === 'center').map((b) => b.slot);
	const filter =
		list.some((b) => b.position === 'inside') ||
		(outside.length > 0 && translucentFill) ||
		(outside.length > 0 && centre.length > 0 && Math.max(...centre) > Math.min(...outside));
	return {
		shadows: [...shadows].map(([key, shadow]) => ({ key, shadow })),
		bands: list,
		filter,
		strokeExtent: strokeExtent + (fauxBoldPx > 0 ? fauxBoldPx / 2 : 0),
	};
}

/** A shadow layer: the silhouette copy, offset, blurred, at the shadow's opacity. */
export function ShadowLayer({ shadow, children }: { shadow: ResolvedTextShadow; children: ReactNode }) {
	const style: CSSProperties = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' };
	if (shadow.dx || shadow.dy) style.transform = `translate(${shadow.dx}px, ${shadow.dy}px)`;
	if (shadow.sigma > 0) style.filter = `blur(${shadow.sigma.toFixed(3)}px)`;
	if (shadow.color[3] < 1) style.opacity = Math.max(0, shadow.color[3]);
	return (
		<div data-text-shadow="" style={style}>
			{children}
		</div>
	);
}

/** Widest row of tiles (px): wider rows wrap (GPU textures and Skia surfaces stay well below 16 384 px). */
const TILE_ROW_PX = 8192;

/** Room around the content box inside a tile: strokes plus ink beyond the line boxes (accents, overhangs). */
export function tilePad(strokeExtent: number, maxSizePx: number): number {
	return Math.ceil(strokeExtent + 0.6 * Math.max(0, maxSizePx) + 2);
}

type TileFilterProps = {
	plan: TextPaintPlan;
	render: (mode: PaintMode) => ReactNode;
	/** Size of the content box the copies are laid out in (px). */
	width: number;
	height: number;
	/** Top-left of the content box in the parent (default 0, 0). */
	left?: number;
	top?: number;
	/** Largest font size of the content (for the ink room of the tiles). */
	maxSizePx: number;
	/** `all` = fill + strokes; `strokes` = the stroke regions only (typeset passes that order fills and strokes). */
	output?: 'all' | 'strokes';
};

/**
 * The filter path: the copies side by side in one element, composited by one SVG filter into the first tile's
 * place. Tiles grow to the content's overflow (a paragraph taller than its box) measured after layout.
 */
export function TileFilter({
	plan,
	render,
	width,
	height,
	left = 0,
	top = 0,
	maxSizePx,
	output = 'all',
}: TileFilterProps) {
	const uid = `tp${useId().replace(/[^\w-]/g, '')}`;
	const first = useRef<HTMLDivElement>(null);
	const [overflow, setOverflow] = useState<{ w: number; h: number } | null>(null);
	const W = Math.ceil(Math.max(1, width, overflow?.w ?? 0));
	const H = Math.ceil(Math.max(1, height, overflow?.h ?? 0));
	const P = tilePad(plan.strokeExtent, maxSizePx);
	const T = W + 2 * P;
	const TH = H + 2 * P;
	useLayoutEffect(() => {
		const el = first.current;
		if (!el) return;
		const w = el.scrollWidth;
		const h = el.scrollHeight;
		if (w > W + 0.5 || h > H + 0.5) setOverflow({ w: Math.max(w, W), h: Math.max(h, H) });
	});
	const tiles: { key: string; mode: PaintMode }[] = [
		{ key: 'fill', mode: { kind: 'fill' } },
		{ key: 'mask', mode: { kind: 'mask' } },
		...plan.bands.map((b) => ({ key: `b${b.slot}${b.position}`, mode: { kind: 'band', ...b } as PaintMode })),
	];
	// Tiles in rows of at most TILE_ROW_PX (large layers, many strokes): tile k sits at column k % cols, row k / cols.
	const cols = Math.max(1, Math.min(tiles.length, Math.floor(TILE_ROW_PX / T)));
	const at = (k: number) => ({ x: (k % cols) * T, y: Math.floor(k / cols) * TH });
	const rows = Math.ceil(tiles.length / cols);
	const inner = plan.bands.map((b, i) => ({ b, i })).filter(({ b }) => b.position !== 'outside');
	const outer = plan.bands.map((b, i) => ({ b, i })).filter(({ b }) => b.position !== 'inside');
	const prim: ReactNode[] = [
		<feOffset key="g" in="SourceGraphic" dx={-at(1).x} dy={-at(1).y} result="g" />,
		...plan.bands.map((_, i) => (
			// biome-ignore lint/suspicious/noArrayIndexKey: one primitive per band, in plan order
			<feOffset key={`o${i}`} in="SourceGraphic" dx={-at(2 + i).x} dy={-at(2 + i).y} result={`b${i}`} />
		)),
	];
	const parts: string[] = [];
	if (inner.length) {
		prim.push(
			<feMerge key="inner" result="inner">
				{inner.map(({ i }) => (
					<feMergeNode key={i} in={`b${i}`} />
				))}
			</feMerge>,
			<feComposite key="A" in="inner" in2="g" operator="in" result="A" />,
		);
		parts.push('A');
		if (output === 'all') {
			prim.push(<feComposite key="Bf" in="SourceGraphic" in2="inner" operator="out" result="Bf" />);
			parts.push('Bf');
		}
	} else if (output === 'all') parts.push('SourceGraphic');
	if (outer.length) {
		prim.push(
			<feMerge key="outer" result="outer">
				{outer.map(({ i }) => (
					<feMergeNode key={i} in={`b${i}`} />
				))}
			</feMerge>,
			<feComposite key="O" in="outer" in2="g" operator="out" result="O" />,
		);
		parts.push('O');
	}
	// Disjoint parts add up (premultiplied): the edge pixels are split by the glyph coverage.
	let acc = parts[0] ?? null;
	for (let k = 1; k < parts.length; k++) {
		const name = `s${k}`;
		prim.push(
			<feComposite
				key={name}
				in={acc!}
				in2={parts[k]}
				operator="arithmetic"
				k1={0}
				k2={1}
				k3={1}
				k4={0}
				result={name}
			/>,
		);
		acc = name;
	}
	if (acc === null) return null;
	// The last primitive is the filter result; make sure it is the sum (or the single part).
	if (parts.length === 1) prim.push(<feOffset key="out" in={acc} dx={0} dy={0} />);
	return (
		<>
			<svg width={0} height={0} aria-hidden="true" style={{ position: 'absolute', width: 0, height: 0 }}>
				<defs>
					<filter
						id={uid}
						x={0}
						y={0}
						width={T}
						height={TH}
						filterUnits="userSpaceOnUse"
						primitiveUnits="userSpaceOnUse"
						colorInterpolationFilters="sRGB"
					>
						{prim}
					</filter>
				</defs>
			</svg>
			<div
				data-text-tiles={tiles.length}
				style={{
					position: 'absolute',
					left: left - P,
					top: top - P,
					width: cols * T,
					height: rows * TH,
					filter: `url(#${uid})`,
					pointerEvents: 'none',
				}}
			>
				{tiles.map((t, k) => (
					<div
						key={t.key}
						ref={k === 0 ? first : undefined}
						data-text-tile={t.key}
						style={{ position: 'absolute', left: at(k).x + P, top: at(k).y + P, width: W, height: H }}
					>
						{render(t.mode)}
					</div>
				))}
			</div>
		</>
	);
}

type PaintedTextProps = {
	plan: TextPaintPlan;
	/** One copy of the text in a mode, laid out in the content box (the same layout for every mode). */
	render: (mode: PaintMode) => ReactNode;
	width: number;
	height: number;
	maxSizePx: number;
	/** Caption line boxes: drawn first (`background` mode). */
	background?: boolean;
};

/** The painted text: background, shadows, then the fast-path copies or the tile filter. */
export function PaintedText({ plan, render, width, height, maxSizePx, background }: PaintedTextProps) {
	const out: ReactNode[] = [];
	if (background) out.push(<Fragment key="bg">{render({ kind: 'background' })}</Fragment>);
	for (const s of plan.shadows)
		out.push(
			<ShadowLayer key={`sh${s.key}`} shadow={s.shadow}>
				{render({ kind: 'shadow', key: s.key })}
			</ShadowLayer>,
		);
	if (plan.filter)
		out.push(
			<TileFilter
				key="tiles"
				plan={plan}
				render={render}
				width={width}
				height={height}
				maxSizePx={maxSizePx}
			/>,
		);
	else {
		for (const b of plan.bands)
			if (b.position === 'outside')
				out.push(<Fragment key={`b${b.slot}${b.position}`}>{render({ kind: 'band', ...b })}</Fragment>);
		out.push(<Fragment key="fill">{render({ kind: 'fill' })}</Fragment>);
		for (const b of plan.bands)
			if (b.position === 'center')
				out.push(<Fragment key={`b${b.slot}${b.position}`}>{render({ kind: 'band', ...b })}</Fragment>);
	}
	return <>{out}</>;
}

/** True when a plan draws more than the plain fill (strokes or shadows). */
export function paintsMoreThanFill(plan: TextPaintPlan): boolean {
	return plan.bands.length > 0 || plan.shadows.length > 0;
}
