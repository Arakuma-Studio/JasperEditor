// Canvas tiles (S02:TL-158): no canvas is ever wider than 512 CSS px (× DPR), whatever the zoom or
// clip length. Colors come from --pr-* tokens resolved at draw time (no literals, S05:DT-002).
import { memo, useEffect, useRef } from 'react';

export const TILE_MAX_PX = 512;

export type TileDraw = (
	ctx: CanvasRenderingContext2D,
	tile: { x0: number; width: number; height: number },
) => void;

/** Resolves a CSS custom property (e.g. `--pr-text-secondary`) on an element. */
export function cssVar(el: Element | null, name: string): string {
	if (!el || typeof getComputedStyle === 'undefined') return '';
	return getComputedStyle(el).getPropertyValue(name).trim();
}

export function dpr(): number {
	return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

/** Splits `[x0, x1)` into tiles of at most TILE_MAX_PX, aligned to multiples of TILE_MAX_PX. */
export function tileRanges(x0: number, x1: number, max = TILE_MAX_PX): { x0: number; width: number }[] {
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
