// Horizontal viewport math (S02 §3: TL-100…113, Appendix A.2). Pure and DOM-free so it can be tested
// exactly (TL-1053). All values are float64; nothing here rounds stored frame values from pixels.

/** Horizontal state: the sequence frame at the clip area's left edge, zoom, measured clip-area width. */
export type Viewport = { scrollFrame: number; pxPerFrame: number; width: number };

/** TL-104: default maximum zoom (px per frame). */
export const PX_PER_FRAME_MAX = 48;
/** TL-106: discrete zoom step factor. */
export const ZOOM_STEP = 1.5;
/** TL-110: left margin so frame 0 is not glued to the header. */
export const LEFT_PAD_PX = 16;

export const frameToX = (v: Viewport, frame: number): number => (frame - v.scrollFrame) * v.pxPerFrame;
export const xToFrameExact = (v: Viewport, x: number): number => v.scrollFrame + x / v.pxPerFrame;

/** Seeking (ruler click, scrub): the frame whose cell contains x, clamped to [0, end] (TL-101). */
export function seekFrameAt(v: Viewport, x: number, end: number): number {
	return Math.max(0, Math.min(end, Math.floor(xToFrameExact(v, x))));
}

/** Boundary targeting (edges, razor, In/Out drag): the nearest frame boundary (TL-101). */
export function boundaryFrameAt(v: Viewport, x: number): number {
	return Math.round(xToFrameExact(v, x)) + 0;
}

/** Symmetric rounding so that +d and -d pixel drags give opposite frame deltas. */
export function roundHalfAway(x: number): number {
	return (x < 0 ? -Math.round(-x) : Math.round(x)) + 0;
}

/** Gesture delta in frames from a pixel displacement (incl. auto-scroll, TL-101). */
export function deltaFramesFromPx(dxPx: number, pxPerFrame: number): number {
	return roundHalfAway(dxPx / pxPerFrame);
}

/** Device-pixel snapping at draw time only (TL-102). */
export function snapPx(v: number, dpr: number): number {
	return Math.round(v * dpr) / dpr;
}

/** TL-105: minimum zoom — `max(end, 10 s) × 1.1` fits the width, never above the maximum. */
export function minPxPerFrame(end: number, fps: number, width: number, max = PX_PER_FRAME_MAX): number {
	const frames = Math.max(end, Math.ceil(10 * fps)) * 1.1;
	return Math.min(max, Math.max(1e-6, width) / frames);
}

export function clampZoom(p: number, min: number, max = PX_PER_FRAME_MAX): number {
	return Math.min(max, Math.max(min, p));
}

export type ExtentInfo = {
	end: number;
	playhead: number;
	outPoint: number | null;
	lastMarker: number | null;
};

/** TL-110: the frame up to which the view may scroll (half a screen past the last content). */
export function extentEnd(v: Viewport, info: ExtentInfo): number {
	const last = Math.max(info.end, info.playhead, info.outPoint ?? 0, info.lastMarker ?? 0);
	return last + (v.width / v.pxPerFrame) * 0.5;
}

/** TL-110/118: clamps scrollFrame to [-leftPad, max(0, extent - W/p)]. `extendTo` lets auto-scroll grow it. */
export function clampScroll(v: Viewport, extent: number, extendTo = Number.NEGATIVE_INFINITY): number {
	const leftPad = LEFT_PAD_PX / v.pxPerFrame;
	const max = Math.max(0, Math.max(extent, extendTo) - v.width / v.pxPerFrame);
	return Math.min(max, Math.max(-leftPad, v.scrollFrame));
}

/** Appendix A.2: keeps `anchorX` over the same frame while changing zoom. No clamping. */
export function zoomAround(v: Viewport, newPxPerFrame: number, anchorX: number): Viewport {
	const anchorFrame = v.scrollFrame + anchorX / v.pxPerFrame;
	return { ...v, pxPerFrame: newPxPerFrame, scrollFrame: anchorFrame - anchorX / newPxPerFrame };
}

/** TL-107: keys/buttons anchor on the playhead when it is visible, else on the viewport center. */
export function keyZoomAnchorX(v: Viewport, playhead: number): number {
	const x = frameToX(v, playhead);
	return x >= 0 && x <= v.width ? x : v.width / 2;
}

/** TL-106: wheel/pinch zoom factor for a pixel-normalized deltaY. */
export function wheelZoomFactor(deltaY: number): number {
	return Math.exp(-deltaY * 0.0025);
}

/** WheelEvent deltaMode normalization to pixels (0 = px, 1 = lines, 2 = pages). */
export function normalizeWheel(e: { deltaX: number; deltaY: number; deltaMode: number }, pageHeight = 800) {
	const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageHeight : 1;
	return { dx: e.deltaX * k, dy: e.deltaY * k };
}

export type WheelIntent =
	| { kind: 'zoom'; factor: number }
	| { kind: 'hscroll'; px: number }
	| { kind: 'vscroll'; px: number }
	| { kind: 'both'; hpx: number; vpx: number };

/**
 * TL-111 wheel mapping. Win/Linux: wheel = horizontal, Ctrl = vertical, Alt = zoom. macOS: wheel =
 * vertical (+ trackpad horizontal), Shift = horizontal, Alt = zoom. Pinch (ctrlKey without a physical
 * Ctrl, i.e. `pinch`) = zoom everywhere. `preferHorizontal` overrides the platform default.
 */
export function wheelIntent(
	e: { dx: number; dy: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey?: boolean },
	opts: { mac: boolean; preferHorizontal?: boolean; pinch?: boolean },
): WheelIntent {
	if (e.altKey || opts.pinch) return { kind: 'zoom', factor: wheelZoomFactor(e.dy) };
	const horizontalDefault = opts.preferHorizontal ?? !opts.mac;
	if (opts.mac) {
		if (e.shiftKey) return { kind: 'hscroll', px: e.dy || e.dx };
		if (horizontalDefault) return { kind: 'hscroll', px: e.dy + e.dx };
		return { kind: 'both', hpx: e.dx, vpx: e.dy };
	}
	if (e.ctrlKey) return { kind: 'vscroll', px: e.dy };
	if (horizontalDefault) return { kind: 'hscroll', px: e.dy + e.dx };
	return { kind: 'both', hpx: e.dx, vpx: e.dy };
}

/** TL-108: zoom to sequence — minimum zoom, scrolled to show everything from frame 0. */
export function zoomToSequenceViewport(v: Viewport, end: number, fps: number): Viewport {
	const p = minPxPerFrame(end, fps, v.width);
	return { ...v, pxPerFrame: p, scrollFrame: -LEFT_PAD_PX / p };
}

/** TL-119 page-scroll follow: the new scrollFrame, or null when the playhead is still visible. */
export function followPage(v: Viewport, frame: number, direction: 1 | -1): number | null {
	const visible = v.width / v.pxPerFrame;
	const x = frameToX(v, frame);
	if (direction > 0 && x > v.width) return frame - visible * 0.05;
	if (direction < 0 && x < 0) return frame - visible * 0.95;
	return null;
}

/** TL-119 smooth follow: the playhead stays centered once it reaches the center. */
export function followSmooth(v: Viewport, frame: number): number | null {
	const center = v.scrollFrame + v.width / v.pxPerFrame / 2;
	return frame > center ? frame - v.width / v.pxPerFrame / 2 : null;
}

/** TL-120: reveal a sought frame with minimum movement, 25 % from the edge it came from. */
export function revealFrame(v: Viewport, frame: number): number | null {
	const x = frameToX(v, frame);
	if (x >= 0 && x <= v.width) return null;
	const visible = v.width / v.pxPerFrame;
	return x < 0 ? frame - visible * 0.25 : frame - visible * 0.75;
}

/** TL-117 auto-scroll speed (px per animation frame) for a pointer `depth` px into the edge band. */
export function autoScrollSpeed(depth: number, band = 40, maxSpeed = 30): number {
	const t = Math.min(1, Math.max(0, depth / band));
	return maxSpeed * t * t;
}

/** Auto-scroll step for pointer x in a clip area of `width` (negative = scroll left). */
export function autoScrollStep(x: number, width: number, band = 40, maxSpeed = 30): number {
	if (x < band) return -autoScrollSpeed(band - x, band, maxSpeed);
	if (x > width - band) return autoScrollSpeed(x - (width - band), band, maxSpeed);
	return 0;
}
