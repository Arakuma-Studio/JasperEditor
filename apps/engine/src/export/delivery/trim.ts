// Spec 19 TL-114 "Export Title": the measured trim, an idea of Pachislop's `measure` (src/io/export.ts): find what the
// title really paints and export that plus a margin. Measured over every frame, so an animated title neither clips
// nor jumps, with the lowest alpha threshold: a glow's last faint pixels count.

export type Bounds = { x0: number; y0: number; x1: number; y1: number };

/** Alpha at or above which a pixel is content: any at all, so the tail of a glow is kept. */
export const TRIM_ALPHA = 1;

/** The half-open box of the pixels with alpha ≥ `threshold` in RGBA `px`, or null when there are none. */
export function alphaBounds(px: Uint8Array, w: number, h: number, threshold = TRIM_ALPHA): Bounds | null {
	const stride = w * 4;
	const rowHas = (y: number) => {
		for (let i = y * stride + 3, end = i + stride; i < end; i += 4) if (px[i]! >= threshold) return true;
		return false;
	};
	let y0 = 0;
	while (y0 < h && !rowHas(y0)) y0++;
	if (y0 === h) return null;
	let y1 = h;
	while (y1 > y0 && !rowHas(y1 - 1)) y1--;
	let x0 = w;
	let x1 = 0;
	for (let y = y0; y < y1; y++) {
		const row = y * stride + 3;
		for (let x = 0; x < x0; x++)
			if (px[row + x * 4]! >= threshold) {
				x0 = x;
				break;
			}
		for (let x = w - 1; x >= x1; x--)
			if (px[row + x * 4]! >= threshold) {
				x1 = x + 1;
				break;
			}
	}
	return { x0, y0, x1, y1 };
}

export function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
	if (!a) return b;
	if (!b) return a;
	return {
		x0: Math.min(a.x0, b.x0),
		y0: Math.min(a.y0, b.y0),
		x1: Math.max(a.x1, b.x1),
		y1: Math.max(a.y1, b.y1),
	};
}

/** Content reaches the edge of a `w × h` canvas: what is past it was cut. */
export function touchesEdge(b: Bounds, w: number, h: number): boolean {
	return b.x0 <= 0 || b.y0 <= 0 || b.x1 >= w || b.y1 >= h;
}

/** `b` grown by `margin` px, inside the `w × h` canvas. */
export function grownBox(b: Bounds, margin: number, w: number, h: number): Bounds {
	return {
		x0: Math.max(0, b.x0 - margin),
		y0: Math.max(0, b.y0 - margin),
		x1: Math.min(w, b.x1 + margin),
		y1: Math.min(h, b.y1 + margin),
	};
}
