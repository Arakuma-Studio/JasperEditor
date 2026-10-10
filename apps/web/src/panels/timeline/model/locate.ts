// Aiming at things drawn on the timeline (mcp-cli ui_click / ui_locate, wp fixups): a clip that runs off the
// visible range is aimed at the middle of its visible part, and a target with no visible part is scrolled into
// view first (horizontally by scrollFrame, vertically by the video / audio region scroll).
import type { RegionLayout, TrackRow } from './layout.ts';
import type { Viewport } from './viewport.ts';

export type Span = readonly [number, number];

/** The frames on screen: [scrollFrame, scrollFrame + width / pxPerFrame). */
export function visibleFrames(v: Viewport): Span {
	return [v.scrollFrame, v.scrollFrame + v.width / Math.max(1e-9, v.pxPerFrame)];
}

/** The on-screen part of the frame span [a, b), or null when less than a pixel of it shows. */
export function visiblePart(v: Viewport, a: number, b: number): Span | null {
	const [v0, v1] = visibleFrames(v);
	const lo = Math.max(a, v0);
	const hi = Math.min(b, v1);
	return (hi - lo) * v.pxPerFrame >= 1 ? [lo, hi] : null;
}

/**
 * The scrollFrame that brings [a, b) into view, or null when part of it already shows: centred when it fits,
 * else starting a tenth of the width in.
 */
export function revealScroll(v: Viewport, a: number, b: number): number | null {
	if (visiblePart(v, a, b)) return null;
	const span = v.width / Math.max(1e-9, v.pxPerFrame);
	return b - a <= span * 0.8 ? (a + b) / 2 - span / 2 : a - span * 0.1;
}

/** The on-screen band [top, bottom) of a track row inside its region (track-area px), or null. */
export function visibleRowBand(region: RegionLayout, row: TrackRow): Span | null {
	const top = Math.max(row.y, region.top);
	const bottom = Math.min(row.y + row.height, region.top + region.height);
	return bottom - top >= 1 ? [top, bottom] : null;
}

/**
 * The region scroll (scrollYVideo / scrollYAudio) that shows the whole row (its top when taller than the
 * region), or null when it already shows completely. Video rows move down as scrollYVideo grows (it counts
 * pixels scrolled up from the bottom); audio rows move up as scrollYAudio grows.
 */
export function revealRowScroll(region: RegionLayout, row: TrackRow, scrollY: number): number | null {
	const top = region.top;
	const bottom = region.top + region.height;
	let dy = 0; // how far the row has to move down (+) or up (−)
	if (row.y < top || row.height > region.height) dy = top - row.y;
	else if (row.y + row.height > bottom) dy = bottom - (row.y + row.height);
	if (Math.abs(dy) < 0.5) return null;
	const next = region.kind === 'video' ? scrollY + dy : scrollY - dy;
	const clamped = Math.min(region.maxScroll, Math.max(0, next));
	return Math.abs(clamped - scrollY) < 0.5 ? null : clamped;
}
