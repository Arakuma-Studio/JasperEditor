// Pure Program-monitor geometry for shapes (wp-m2-shapes): the box a Rectangle/Ellipse tool drag draws
// (S03:XF-061: Shift = square/circle, Alt = from the centre) and the "Resize shapes by size" handle edit
// (S11:SHP-007, S03:TXT-020): handles change `shape.size` instead of Motion scale, so the stroke keeps its
// width. All values in sequence pixels unless noted.
import {
	applyMatrix,
	type Command,
	evaluateShape,
	invertMatrix,
	type LayerTransformValues,
	layerMatrix,
	type ResolvedLayer,
	SHAPE_LIMITS,
	shapeContainsPoint,
	type Vec2,
} from '@jasper/project';
import type { HandleId } from '../panels/program/transform-math.ts';

/** Evaluated size of a shape layer at its frame, or null for other layers. */
export function shapeLayerSize(l: ResolvedLayer): Vec2 | null {
	const src = l.clip.source;
	return 'shape' in src ? evaluateShape(src.shape, l.contentTime, l.props.box).size : null;
}

/**
 * Program monitor hit-test (S03:XF-001): shapes are hit by their drawn geometry (ellipse interior, rounded
 * corners, stroke band), other layers by their quad. Corner-pinned shapes keep the quad test.
 */
export function hitsLayerGeometry(l: ResolvedLayer, p: Vec2): boolean {
	const src = l.clip.source;
	if (!('shape' in src) || l.props.projective) return true;
	const inv = invertMatrix(l.props.matrix);
	return (
		!inv || shapeContainsPoint(evaluateShape(src.shape, l.contentTime, l.props.box), applyMatrix(inv, p))
	);
}

/** `param.set shape.size` at the playhead (a keyframe when the size is animated, PRP-020). */
export function shapeSizeCommand(clipId: string, size: Vec2, frame: number, sequenceId?: string): Command {
	return {
		type: 'param.set',
		target: ['clip', clipId, 'shape', 'size'],
		value: size,
		at: { sequenceFrame: frame },
		...(sequenceId ? { sequenceId } : {}),
	} as Command;
}

export type DrawnBox = { center: Vec2; size: Vec2 };

/** The shape box of a tool drag from `p0` to `p1` (whole pixels). */
export function dragShapeBox(p0: Vec2, p1: Vec2, mods: { shift: boolean; alt: boolean }): DrawnBox {
	let dx = p1[0] - p0[0];
	let dy = p1[1] - p0[1];
	if (mods.shift) {
		const side = Math.max(Math.abs(dx), Math.abs(dy));
		dx = dx < 0 ? -side : side;
		dy = dy < 0 ? -side : side;
	}
	if (mods.alt) {
		const center: Vec2 = [Math.round(p0[0]), Math.round(p0[1])];
		return { center, size: [2 * Math.round(Math.abs(dx)), 2 * Math.round(Math.abs(dy))] };
	}
	const w = Math.round(Math.abs(dx));
	const h = Math.round(Math.abs(dy));
	const left = Math.round(Math.min(p0[0], p0[0] + dx));
	const top = Math.round(Math.min(p0[1], p0[1] + dy));
	return { center: [left + w / 2, top + h / 2], size: [w, h] };
}

/** Outward direction of a handle on each axis (+1 right/down, −1 left/up, 0 = that side does not move). */
const DIRECTION: Record<HandleId, Vec2> = {
	nw: [-1, -1],
	n: [0, -1],
	ne: [1, -1],
	e: [1, 0],
	se: [1, 1],
	s: [0, 1],
	sw: [-1, 1],
	w: [-1, 0],
};

export type SizeResizeInput = {
	/** Motion values at the gesture start (frame of the edit). */
	values: LayerTransformValues;
	/** Evaluated shape size at the gesture start. */
	size0: Vec2;
	handle: HandleId;
	/** Pointer at the gesture start and now. */
	start: Vec2;
	pointer: Vec2;
	/** Shift keeps the aspect ratio; Alt keeps the opposite handle in place (else the shape grows about its centre). */
	shift: boolean;
	alt: boolean;
};

/**
 * New `shape.size` (and, with Alt, `transform.position`) for a handle drag. The shape stays centred on its anchor
 * when its box changes (the model re-centres the anchor), so growing about the centre needs no position change;
 * keeping the opposite side fixed moves the centre by half the growth, written as a position change.
 */
export function resizeShapeBySize(i: SizeResizeInput): { size: Vec2; position?: Vec2 } {
	const M = layerMatrix(i.values);
	const inv = invertMatrix(M);
	if (!inv) return { size: i.size0 };
	const a = applyMatrix(inv, i.start);
	const b = applyMatrix(inv, i.pointer);
	const dir = DIRECTION[i.handle];
	const grow = i.alt ? 1 : 2;
	const clampSide = (v: number) => Math.min(SHAPE_LIMITS.size, Math.max(0, v));
	let size: Vec2 = [
		clampSide(i.size0[0] + grow * dir[0] * (b[0] - a[0])),
		clampSide(i.size0[1] + grow * dir[1] * (b[1] - a[1])),
	];
	if (i.shift && i.size0[0] > 0 && i.size0[1] > 0) {
		const kx = size[0] / i.size0[0];
		const ky = size[1] / i.size0[1];
		// The moving axis drives the factor; for corners the one that moved further.
		const k = dir[1] === 0 ? kx : dir[0] === 0 ? ky : Math.abs(kx - 1) >= Math.abs(ky - 1) ? kx : ky;
		size = [clampSide(i.size0[0] * k), clampSide(i.size0[1] * k)];
	}
	size = [Math.round(size[0] * 10) / 10, Math.round(size[1] * 10) / 10];
	if (!i.alt) return { size };
	// Opposite side fixed: the centre moves by half the growth along the moving directions.
	const shift: Vec2 = [(dir[0] * (size[0] - i.size0[0])) / 2, (dir[1] * (size[1] - i.size0[1])) / 2];
	const o = applyMatrix(M, [0, 0]);
	const s = applyMatrix(M, shift);
	return { size, position: [i.values.position[0] + s[0] - o[0], i.values.position[1] + s[1] - o[1]] };
}
