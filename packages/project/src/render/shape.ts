// Shape geometry at a content time (S11:SHP-001/004, wp-m2-shapes): the one evaluation of a shape's keyframed
// size, paint and radius, shared by the composition layer (inline SVG), the Program monitor (hit-testing,
// resize handles) and tests. The geometry is centred in the layer box (`shapeIntrinsicBox`).
import { evaluate } from '../keyframes.ts';
import type { RGBA, Vec2 } from '../schema/common.ts';
import type { ShapeData, ShapeStroke } from '../schema/sequence.ts';

export type ShapeGeometry = {
	type: ShapeData['type'];
	/** Width and height (≥ 0). */
	size: Vec2;
	/** Top-left of the geometry inside the layer box. */
	origin: Vec2;
	fill: RGBA | null;
	/** `null` when there is no stroke or its width is 0. */
	stroke: { color: RGBA; width: number; position: ShapeStroke['position'] } | null;
	/** Rectangles: clamped to half the shorter side; ellipses: 0. */
	cornerRadius: number;
};

const NON_NEGATIVE = { min: 0 };
const UNIT = { min: 0, max: 1 };

/** Evaluates a shape at content time `t` (flicks) inside a layer box of `box` pixels. */
export function evaluateShape(
	shape: ShapeData,
	t: number,
	box: { width: number; height: number },
): ShapeGeometry {
	const size = evaluate(shape.size, t, { clamp: NON_NEGATIVE });
	const stroke = shape.stroke;
	const width = stroke ? evaluate(stroke.width, t, { clamp: NON_NEGATIVE }) : 0;
	const radius =
		shape.type === 'rect'
			? Math.min(evaluate(shape.cornerRadius, t, { clamp: NON_NEGATIVE }), size[0] / 2, size[1] / 2)
			: 0;
	return {
		type: shape.type,
		size: [size[0], size[1]],
		origin: [(box.width - size[0]) / 2, (box.height - size[1]) / 2],
		fill: shape.fill ? evaluate(shape.fill, t, { clamp: UNIT }) : null,
		stroke:
			stroke && width > 0
				? { color: evaluate(stroke.color, t, { clamp: UNIT }), width, position: stroke.position }
				: null,
		cornerRadius: radius,
	};
}

/**
 * True when a layer-space point lies on the drawn shape (fill area or stroke band), for Program monitor
 * hit-testing (S03:XF-001: shapes hit-test their geometry, point-in-path for ellipses).
 */
export function shapeContainsPoint(g: ShapeGeometry, p: Vec2): boolean {
	const [w, h] = g.size;
	const half = g.stroke
		? g.stroke.position === 'outside'
			? g.stroke.width
			: g.stroke.position === 'center'
				? g.stroke.width / 2
				: 0
		: 0;
	// Point relative to the geometry centre, tested against the outline grown by the outer stroke part.
	const x = p[0] - (g.origin[0] + w / 2);
	const y = p[1] - (g.origin[1] + h / 2);
	const rx = w / 2 + half;
	const ry = h / 2 + half;
	if (rx <= 0 || ry <= 0) return false;
	if (g.type === 'ellipse') return (x / rx) ** 2 + (y / ry) ** 2 <= 1;
	if (Math.abs(x) > rx || Math.abs(y) > ry) return false;
	const r = g.cornerRadius > 0 ? g.cornerRadius + half : 0;
	const cx = Math.abs(x) - (rx - r);
	const cy = Math.abs(y) - (ry - r);
	return cx <= 0 || cy <= 0 || cx * cx + cy * cy <= r * r;
}
