// Monitor viewport math (S03 §6.2, PGM-010…015, §0.3 screen space): fit, zoom about a point, pan clamp,
// and the screen ↔ sequence mapping shared by the Player wrapper and the overlay.
export type Vec2 = [number, number];
export type Size = { width: number; height: number };
/** screen = (x, y) + sequencePoint · scale, in CSS px relative to the viewport's top-left. */
export type View = { scale: number; x: number; y: number };
export type Zoom = 'fit' | number;

const FIT_PAD = 16;
export const ZOOM_PRESETS = [10, 25, 50, 75, 100, 150, 200, 400, 800] as const;
const MIN_ZOOM = 10;
const MAX_ZOOM = 800;
export const WHEEL_ZOOM_STEP = 1.1;

export function fitScale(viewport: Size, frame: Size, pad = FIT_PAD): number {
	if (frame.width <= 0 || frame.height <= 0) return 1;
	const s = Math.min((viewport.width - 2 * pad) / frame.width, (viewport.height - 2 * pad) / frame.height);
	return Math.max(0.001, s);
}

function zoomScale(zoom: Zoom, viewport: Size, frame: Size): number {
	return zoom === 'fit' ? fitScale(viewport, frame) : zoom / 100;
}

/** The frame is centered, then offset by `pan` (screen px). */
export function computeView(viewport: Size, frame: Size, zoom: Zoom, pan: Vec2): View {
	const scale = zoomScale(zoom, viewport, frame);
	return {
		scale,
		x: (viewport.width - frame.width * scale) / 2 + (zoom === 'fit' ? 0 : pan[0]),
		y: (viewport.height - frame.height * scale) / 2 + (zoom === 'fit' ? 0 : pan[1]),
	};
}

/** Clamps pan so at least max(10 % of the frame, 48 px) stays visible on each axis (PGM-014). */
export function clampPan(pan: Vec2, viewport: Size, frame: Size, scale: number): Vec2 {
	const axis = (p: number, v: number, f: number) => {
		const fs = f * scale;
		const keep = Math.min(fs, Math.max(0.1 * fs, 48));
		const center = (v - fs) / 2;
		const min = keep - fs - center;
		const max = v - keep - center;
		return Math.min(max, Math.max(min, p));
	};
	return [axis(pan[0], viewport.width, frame.width), axis(pan[1], viewport.height, frame.height)];
}

function clampZoom(percent: number): number {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, percent));
}

/**
 * Zoom to `percent` keeping the sequence point under `anchor` (screen px) fixed (PGM-011, AC-PGM-3).
 * Returns the new zoom and pan.
 */
export function zoomAround(
	viewport: Size,
	frame: Size,
	current: { zoom: Zoom; pan: Vec2 },
	percent: number,
	anchor: Vec2,
): { zoom: number; pan: Vec2 } {
	const view = computeView(viewport, frame, current.zoom, current.pan);
	const p = toSequence(view, anchor);
	const zoom = clampZoom(percent);
	const scale = zoom / 100;
	const x = anchor[0] - p[0] * scale;
	const y = anchor[1] - p[1] * scale;
	const pan: Vec2 = [
		x - (viewport.width - frame.width * scale) / 2,
		y - (viewport.height - frame.height * scale) / 2,
	];
	return { zoom, pan: clampPan(pan, viewport, frame, scale) };
}

export function toSequence(view: View, p: Vec2): Vec2 {
	return [(p[0] - view.x) / view.scale, (p[1] - view.y) / view.scale];
}

export function toScreen(view: View, p: Vec2): Vec2 {
	return [view.x + p[0] * view.scale, view.y + p[1] * view.scale];
}

/** Current zoom expressed in percent (for the dropdown label while in Fit). */
export function zoomPercent(zoom: Zoom, viewport: Size, frame: Size): number {
	return zoomScale(zoom, viewport, frame) * 100;
}
