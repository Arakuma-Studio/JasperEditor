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
	evaluateVectorShape,
	vectorShapeBounds,
	vectorShapeContainsPoint,
	visibleRect,
} from '@jasper/project';
import type { HandleId } from '../panels/program/transform-math.ts';

/** Evaluated size of a shape layer at its frame, or null for other layers. */
export function shapeLayerSize(l: ResolvedLayer): Vec2 | null {
	const src = l.clip.source;
	return 'shape' in src && src.shape.type !== 'vector'
		? evaluateShape(src.shape, l.contentTime, l.props.box).size
		: null;
}

/**
 * Program monitor hit-test (S03:XF-001): shapes are hit by their drawn geometry (ellipse interior, rounded
 * corners, stroke band), other layers by their quad. Corner-pinned shapes keep the quad test.
 */
export function hitsLayerGeometry(l: ResolvedLayer, p: Vec2): boolean {
	const src = l.clip.source;
	if (!('shape' in src) || l.props.projective) return true;
	const inv = invertMatrix(l.props.matrix);
	if (!inv) return true;
	const q = applyMatrix(inv, p);
	// wp shapes: vector shapes are hit by their painted fills and strokes (content origin = box centre).
	if (src.shape.type === 'vector')
		return vectorShapeContainsPoint(
			evaluateVectorShape(src.shape.contents, l.contentTime),
			[q[0] - l.props.box.width / 2, q[1] - l.props.box.height / 2],
			3,
		);
	return shapeContainsPoint(evaluateShape(src.shape, l.contentTime, l.props.box), q);
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

// ---------------------------------------------------------------- vector shapes (wp shapes)

const rectCache = new WeakMap<object, Map<number, { x: number; y: number; width: number; height: number } | null>>();

/**
 * The rectangle (layer px) the Program monitor frames for a layer: a vector shape's painted contents at its
 * frame (its layer is frame-sized, so the box would frame the whole picture); other layers their visible box.
 */
export function layerEditRect(l: ResolvedLayer): { x: number; y: number; width: number; height: number } {
	const src = l.clip.source;
	if ('shape' in src && src.shape.type === 'vector') {
		const contents = src.shape.contents;
		let m = rectCache.get(contents);
		if (!m) rectCache.set(contents, (m = new Map()));
		let r = m.get(l.contentTime);
		if (r === undefined) {
			const b = vectorShapeBounds(evaluateVectorShape(contents, l.contentTime));
			const W = l.props.box.width / 2;
			const H = l.props.box.height / 2;
			r = b ? { x: b.x0 + W, y: b.y0 + H, width: b.x1 - b.x0, height: b.y1 - b.y0 } : null;
			if (m.size > 64) m.clear();
			m.set(l.contentTime, r);
		}
		if (r && r.width > 0 && r.height > 0) return r;
	}
	return visibleRect(l.props.box, l.props.crop ?? undefined);
}

/** The sequence-px quad of `layerEditRect` (TL, TR, BR, BL); the layer's quad for other layers. */
export function layerEditQuad(l: ResolvedLayer): [Vec2, Vec2, Vec2, Vec2] {
	const src = l.clip.source;
	if (!('shape' in src) || src.shape.type !== 'vector' || l.props.projective) return l.props.quad as [Vec2, Vec2, Vec2, Vec2];
	const r = layerEditRect(l);
	const m = l.props.matrix;
	return [
		applyMatrix(m, [r.x, r.y]),
		applyMatrix(m, [r.x + r.width, r.y]),
		applyMatrix(m, [r.x + r.width, r.y + r.height]),
		applyMatrix(m, [r.x, r.y + r.height]),
	] as [Vec2, Vec2, Vec2, Vec2];
}
