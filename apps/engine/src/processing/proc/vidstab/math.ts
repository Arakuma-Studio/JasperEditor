// Pure transform math of the vid.stab step (unit-testable, no WASM): the geometry of vid.stab's
// transformPlanar, scaling of detection-resolution transforms, band planning for the parallel warp, and a
// (slow) TypeScript reference of the 16-bit warp that glue.c's vsx_warp_rgb48 implements with WASM SIMD.
import type { VsTransform } from './wasm.ts';

/**
 * The backward map of a vid.stab transform: destination pixel (x, y) → source position.
 *   p_s = z · R(alpha) · (p_d − c) + c − (t.x, t.y),  z = 1 − zoom/100,  c = (⌊w/2⌋, ⌊h/2⌋)
 * (vid.stab transformPlanar: rotation about the frame centre, then translation, zoom in percent).
 */
export function sourcePoint(
	t: VsTransform,
	width: number,
	height: number,
	x: number,
	y: number,
): [number, number] {
	const z = 1 - t.zoom / 100;
	const c = z * Math.cos(t.alpha);
	const s = z * Math.sin(t.alpha);
	const cx = Math.floor(width / 2);
	const cy = Math.floor(height / 2);
	const dx = x - cx;
	const dy = y - cy;
	return [c * dx - s * dy + cx - t.x, s * dx + c * dy + cy - t.y];
}

/** The same map as a 2×3 affine matrix [a, b, tx, c, d, ty]: x_s = a·x + b·y + tx, y_s = c·x + d·y + ty. */
export function backwardAffine(t: VsTransform, width: number, height: number): number[] {
	const z = 1 - t.zoom / 100;
	const c = z * Math.cos(t.alpha);
	const s = z * Math.sin(t.alpha);
	const cx = Math.floor(width / 2);
	const cy = Math.floor(height / 2);
	return [c, -s, -c * cx + s * cy + cx - t.x, s, c, -s * cx - c * cy + cy - t.y];
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

/** vid.stab's bicubic kernel (interpolateBiCub: Catmull-Rom, a = −0.5) as the 4 weights of offset t ∈ [0, 1). */
export function cubicWeights(t: number): [number, number, number, number] {
	const t2 = t * t;
	const t3 = t2 * t;
	return [
		0.5 * (-t + 2 * t2 - t3),
		0.5 * (2 - 5 * t2 + 3 * t3),
		0.5 * (t + 4 * t2 - 3 * t3),
		0.5 * (-t2 + t3),
	];
}

/**
 * Reference implementation of the 16-bit warp (glue.c vsx_warp_rgb48, used by the tests): interleaved rgb48,
 * bicubic with clamped taps; border 'black' fades the edge pixel to black over 10 px outside the frame (like
 * vid.stab's interpolateBiLinBorder with crop=black), 'replicate' clamps.
 */
export function warpRgb48Reference(
	src: Uint16Array,
	width: number,
	height: number,
	t: VsTransform,
	border: 'black' | 'replicate',
): Uint16Array {
	const out = new Uint16Array(width * height * 3);
	const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [xs, ys] = sourcePoint(t, width, height, x, y);
			const ix = Math.floor(xs);
			const iy = Math.floor(ys);
			let fade = 0;
			if (border === 'black' && (ix < 0 || iy < 0 || ix + 1 >= width || iy + 1 >= height)) {
				const c = clamp(Math.max(-10 - ix, -10 - iy, ix + 1 - 10 - width, iy + 1 - 10 - height), 0, 10);
				if (c === 10) continue;
				fade = c / 10;
			}
			const wx = cubicWeights(xs - ix);
			const wy = cubicWeights(ys - iy);
			for (let ch = 0; ch < 3; ch++) {
				let acc = 0;
				for (let r = 0; r < 4; r++) {
					const row = clamp(iy - 1 + r, 0, height - 1) * width;
					let h = 0;
					for (let k = 0; k < 4; k++) h += wx[k] * src[(row + clamp(ix - 1 + k, 0, width - 1)) * 3 + ch];
					acc += wy[r] * h;
				}
				out[(y * width + x) * 3 + ch] = clamp(Math.floor(acc * (1 - fade) + 0.5), 0, 65535);
			}
		}
	}
	return out;
}
