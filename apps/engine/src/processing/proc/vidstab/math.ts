// Transform math for the vid.stab step: scaling detection transforms and planning bands for the parallel warp.
import type { VsTransform } from './wasm.ts';

/**
 * The backward map of a vid.stab transform: destination pixel (x, y) → source position.
 *   p_s = z · R(alpha) · (p_d − c) + c − (t.x, t.y),  z = 1 − zoom/100,  c = (⌊w/2⌋, ⌊h/2⌋)
 * (vid.stab transformPlanar: rotation about the frame centre, then translation, zoom in percent).
 */
function sourcePoint(t: VsTransform, width: number, height: number, x: number, y: number): [number, number] {
	const z = 1 - t.zoom / 100;
	const c = z * Math.cos(t.alpha);
	const s = z * Math.sin(t.alpha);
	const cx = Math.floor(width / 2);
	const cy = Math.floor(height / 2);
	const dx = x - cx;
	const dy = y - cy;
	return [c * dx - s * dy + cx - t.x, s * dx + c * dy + cy - t.y];
}

/**
 * Transforms computed on a downscaled detection frame, expressed for the full frame: translations scale
 * with the frame (per axis), rotation and zoom (percent) are scale-free.
 */
export function scaleTransform(t: VsTransform, sx: number, sy: number): VsTransform {
	return { x: t.x * sx, y: t.y * sy, alpha: t.alpha, zoom: t.zoom };
}

/** Detection size: at most `maxWidth` wide (aspect kept, even dimensions, never upscaled). */
export function detectionSize(
	width: number,
	height: number,
	maxWidth: number,
): { width: number; height: number } {
	if (width <= maxWidth) return { width, height };
	const w = Math.max(2, Math.round(maxWidth / 2) * 2);
	const h = Math.max(2, Math.round((height * w) / width / 2) * 2);
	return { width: w, height: h };
}

/**
 * Source rows [row0, row1) that destination rows [y0, y1) can read (bicubic taps included, clamped to the
 * frame): the min/max source y over the band's corners, −1/+2 for the 4×4 kernel.
 */
export function sourceRows(
	t: VsTransform,
	width: number,
	height: number,
	y0: number,
	y1: number,
): [number, number] {
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const y of [y0, y1 - 1]) {
		for (const x of [0, width - 1]) {
			const ys = sourcePoint(t, width, height, x, y)[1];
			lo = Math.min(lo, ys);
			hi = Math.max(hi, ys);
		}
	}
	const row0 = Math.min(height - 1, Math.max(0, Math.floor(lo) - 1));
	const row1 = Math.max(row0 + 1, Math.min(height, Math.floor(hi) + 3));
	return [row0, row1];
}

/** Splits `height` rows into `n` contiguous bands (the first ones one row taller when uneven). */
export function rowBands(height: number, n: number): Array<[number, number]> {
	const k = Math.max(1, Math.min(n, height));
	const bands: Array<[number, number]> = [];
	let y = 0;
	for (let i = 0; i < k; i++) {
		const rows = Math.floor(height / k) + (i < height % k ? 1 : 0);
		bands.push([y, y + rows]);
		y += rows;
	}
	return bands;
}

/** Summary of a set of full-frame transforms (for the sidecar). */
export function correctionStats(ts: VsTransform[]): {
	meanShift: number;
	maxShift: number;
	maxAngle: number;
	zoom: { min: number; max: number };
} {
	let sum = 0;
	let max = 0;
	let maxAngle = 0;
	let zmin = Number.POSITIVE_INFINITY;
	let zmax = Number.NEGATIVE_INFINITY;
	for (const t of ts) {
		const d = Math.hypot(t.x, t.y);
		sum += d;
		max = Math.max(max, d);
		maxAngle = Math.max(maxAngle, Math.abs(t.alpha));
		zmin = Math.min(zmin, t.zoom);
		zmax = Math.max(zmax, t.zoom);
	}
	return {
		meanShift: ts.length ? sum / ts.length : 0,
		maxShift: max,
		maxAngle,
		zoom: { min: ts.length ? zmin : 0, max: ts.length ? zmax : 0 },
	};
}
