// Layer transform math (S03:DM-010…012, S01:FX-001): M(q) = P + R·S·(q − A), y-down, clockwise degrees.
import type { Vec2 } from '../schema/common.ts';

/** 2D affine matrix in DOMMatrix order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Mat2D = { a: number; b: number; c: number; d: number; e: number; f: number };

export type LayerTransformValues = {
	position: Vec2;
	anchor: Vec2;
	scale: number;
	scaleWidth: number;
	uniformScale: boolean;
	rotation: number;
	flipH: boolean;
	flipV: boolean;
};

export const IDENTITY: Mat2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Scale factors (fractions); "Scale" is vertical, "Scale Width" horizontal when not uniform; flips negate. */
export function scaleFactors(v: Pick<LayerTransformValues, 'scale' | 'scaleWidth' | 'uniformScale' | 'flipH' | 'flipV'>): { sx: number; sy: number } {
	const sx = ((v.uniformScale ? v.scale : v.scaleWidth) / 100) * (v.flipH ? -1 : 1);
	const sy = (v.scale / 100) * (v.flipV ? -1 : 1);
	return { sx, sy };
}

export function layerMatrix(v: LayerTransformValues): Mat2D {
	const { sx, sy } = scaleFactors(v);
	const th = (v.rotation * Math.PI) / 180;
	const cos = Math.cos(th);
	const sin = Math.sin(th);
	const a = cos * sx;
	const b = sin * sx;
	const c = -sin * sy;
	const d = cos * sy;
	const [ax, ay] = v.anchor;
	return { a, b, c, d, e: v.position[0] - (a * ax + c * ay), f: v.position[1] - (b * ax + d * ay) };
}

export function applyMatrix(m: Mat2D, p: Vec2): Vec2 {
	return [m.a * p[0] + m.c * p[1] + m.e, m.b * p[0] + m.d * p[1] + m.f];
}

export function multiplyMatrix(m: Mat2D, n: Mat2D): Mat2D {
	return {
		a: m.a * n.a + m.c * n.b,
		b: m.b * n.a + m.d * n.b,
		c: m.a * n.c + m.c * n.d,
		d: m.b * n.c + m.d * n.d,
		e: m.a * n.e + m.c * n.f + m.e,
		f: m.b * n.e + m.d * n.f + m.f,
	};
}

/** Inverse matrix, or null when singular (scale 0). */
export function invertMatrix(m: Mat2D): Mat2D | null {
	const det = m.a * m.d - m.b * m.c;
	if (Math.abs(det) < 1e-12) return null;
	return {
		a: m.d / det,
		b: -m.b / det,
		c: -m.c / det,
		d: m.a / det,
		e: (m.c * m.f - m.d * m.e) / det,
		f: (m.b * m.e - m.a * m.f) / det,
	};
}

export type Rect = { x: number; y: number; width: number; height: number };
export type Crop = { left: number; top: number; right: number; bottom: number };

/** Visible rect in layer space: intrinsic box minus crop insets given in percent (S03:DM-010). */
export function visibleRect(box: { width: number; height: number }, crop?: Crop): Rect {
	const l = (crop?.left ?? 0) / 100;
	const t = (crop?.top ?? 0) / 100;
	const r = (crop?.right ?? 0) / 100;
	const b = (crop?.bottom ?? 0) / 100;
	return { x: l * box.width, y: t * box.height, width: (1 - l - r) * box.width, height: (1 - t - b) * box.height };
}

/** Layer quad in sequence space (top-left, top-right, bottom-right, bottom-left) (S03:DM-011). */
export function layerQuad(m: Mat2D, rect: Rect): [Vec2, Vec2, Vec2, Vec2] {
	return [
		applyMatrix(m, [rect.x, rect.y]),
		applyMatrix(m, [rect.x + rect.width, rect.y]),
		applyMatrix(m, [rect.x + rect.width, rect.y + rect.height]),
		applyMatrix(m, [rect.x, rect.y + rect.height]),
	];
}

export function quadBounds(q: readonly Vec2[]): Rect {
	const xs = q.map((p) => p[0]);
	const ys = q.map((p) => p[1]);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** CSS transform realizing the layer matrix with `transform-origin: 0 0` (S03:DM-012). */
export function cssTransform(v: LayerTransformValues): string {
	const { sx, sy } = scaleFactors(v);
	return `translate(${v.position[0]}px, ${v.position[1]}px) rotate(${v.rotation}deg) scale(${sx}, ${sy}) translate(${-v.anchor[0]}px, ${-v.anchor[1]}px)`;
}

export function matrixToCss(m: Mat2D): string {
	return `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;
}
