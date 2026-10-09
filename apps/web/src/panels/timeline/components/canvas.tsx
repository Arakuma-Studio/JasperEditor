// Canvas tiles (S02:TL-158): no canvas is ever wider than 512 CSS px (× DPR), whatever the zoom or
// clip length. Colors come from --pr-* tokens resolved at draw time (no literals, S05:DT-002).
import { memo, useEffect, useRef } from 'react';

export const TILE_MAX_PX = 512;

export type TileDraw = (
	ctx: CanvasRenderingContext2D,
	tile: { x0: number; width: number; height: number },
) => void;

// ui-perf: design tokens are defined on the root element only (packages/ui theme/tokens.css: `:root` and the
// `data-pr-*` attributes `applyPrefs` sets on <html>), so their values are cached per name. Reading them through
// `getComputedStyle` on every canvas redraw forced a style recalculation per tile while scrolling. The cache is
// dropped when the root's attributes change (theme, contrast, density, label colours) or a style sheet is added or
// removed (code-split CSS).
const tokenCache = new Map<string, string>();
let tokenWatch: { sheets: number } | null = null;
let tokenVersion = 0;
const tokenListeners = new Set<() => void>();

function clearTokens(): void {
	tokenCache.clear();
	tokenVersion++;
	for (const l of [...tokenListeners]) l();
}

/** Changes whenever the cached token values may have changed (views drawing with tokens re-render on it). */
export const designTokens = {
	version: () => tokenVersion,
	subscribe(l: () => void): () => void {
		watchTokens();
		tokenListeners.add(l);
		return () => tokenListeners.delete(l);
	},
};

function watchTokens(): void {
	if (tokenWatch || typeof document === 'undefined') return;
	tokenWatch = { sheets: document.styleSheets.length };
	if (typeof MutationObserver === 'undefined') return;
	const clear = clearTokens;
	new MutationObserver(clear).observe(document.documentElement, { attributes: true });
	new MutationObserver(clear).observe(document.head, { childList: true, subtree: true, characterData: true });
}

/** Resolves a design token (CSS custom property such as `--pr-text-secondary`) for canvas drawing. */
export function cssVar(el: Element | null, name: string): string {
	if (!el || typeof getComputedStyle === 'undefined' || typeof document === 'undefined') return '';
	watchTokens();
	if (tokenWatch && document.styleSheets.length !== tokenWatch.sheets) {
		tokenWatch.sheets = document.styleSheets.length;
		clearTokens();
	}
	let v = tokenCache.get(name);
	if (v === undefined) {
		v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		tokenCache.set(name, v);
	}
	return v;
}

export function dpr(): number {
	return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

/** Splits `[x0, x1)` into tiles of at most TILE_MAX_PX, aligned to multiples of TILE_MAX_PX. */
function tileRanges(x0: number, x1: number, max = TILE_MAX_PX): { x0: number; width: number }[] {
	const out: { x0: number; width: number }[] = [];
	if (x1 <= x0) return out;
	let a = Math.floor(x0 / max) * max;
	while (a < x1) {
		const s = Math.max(a, x0);
		const e = Math.min(a + max, x1);
		if (e > s) out.push({ x0: s, width: e - s });
		a += max;
	}
	return out;
}

const Tile = memo(function Tile(props: {
	x0: number;
	width: number;
	height: number;
	left: number;
	draw: TileDraw;
	version: unknown;
}) {
	const ref = useRef<HTMLCanvasElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` forces a redraw when media data arrives
	useEffect(() => {
		const c = ref.current;
		if (!c) return;
		const ratio = dpr();
		const w = Math.max(1, Math.ceil(props.width * ratio));
		const h = Math.max(1, Math.ceil(props.height * ratio));
		if (c.width !== w) c.width = w;
		if (c.height !== h) c.height = h;
		let ctx: CanvasRenderingContext2D | null = null;
		try {
			ctx = c.getContext('2d');
		} catch {
			ctx = null;
		}
		if (!ctx) return;
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.clearRect(0, 0, props.width, props.height);
		// Tile-local drawing: callers draw in clip-area coordinates shifted by x0.
		ctx.translate(-props.x0, 0);
		props.draw(ctx, { x0: props.x0, width: props.width, height: props.height });
	}, [props.x0, props.width, props.height, props.draw, props.version]);
	return (
		<canvas
			ref={ref}
			className="pointer-events-none absolute top-0"
			style={{ left: props.left, width: props.width, height: props.height }}
		/>
	);
});

/**
 * Draws `[x0, x1)` (clip-area px) as ≤ 512 px canvases positioned relative to `originX` (the left of
 * the containing element in clip-area px). `version` forces a redraw when data arrives.
 */
export function CanvasTiles(props: {
	x0: number;
	x1: number;
	height: number;
	originX: number;
	draw: TileDraw;
	version?: unknown;
}) {
	const tiles = tileRanges(props.x0, props.x1);
	return (
		<>
			{tiles.map((t) => (
				<Tile
					key={t.x0 - props.originX}
					x0={t.x0}
					width={t.width}
					height={props.height}
					left={t.x0 - props.originX}
					draw={props.draw}
					version={props.version}
				/>
			))}
		</>
	);
}
