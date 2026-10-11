import type { Draft } from 'immer';
import { anim } from '../../factories.ts';
import { DEFAULT_SHAPE_STROKE, type PropertySpec, SHAPE_LIMITS } from '../../registry/properties.ts';
import type { Animatable, RGBA, Vec2 } from '../../schema/common.ts';
import type { ShapeClip, ShapeData, ShapeStroke } from '../../schema/sequence.ts';
import type { DClip, HandlerContext } from '../context.ts';
import type { ShapePatch } from '../schemas/clip.ts';

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function checkColor(v: unknown, field: string, h: HandlerContext): RGBA {
	if (!Array.isArray(v) || v.length !== 4 || !v.every((x) => finite(x) && x >= 0 && x <= 1))
		h.fail('E_INVALID_PARAM', `${field} must be an RGBA colour with components in 0..1`, { path: [field] });
	return [v[0], v[1], v[2], v[3]] as RGBA;
}
function checkLength(max: number) {
	return (v: unknown, field: string, h: HandlerContext): number => {
		if (!finite(v) || v < 0 || v > max)
			h.fail('E_INVALID_PARAM', `${field} must be a number in 0..${max} (px)`, { path: [field] });
		return v as number;
	};
}
export function checkSize(v: unknown, field: string, h: HandlerContext): Vec2 {
	const ok = (x: unknown) => finite(x) && x >= 0 && x <= SHAPE_LIMITS.size;
	if (!Array.isArray(v) || v.length !== 2 || !v.every(ok))
		h.fail('E_INVALID_PARAM', `${field} must be [width, height] in 0..${SHAPE_LIMITS.size} (px)`, {
			path: [field],
		});
	return [v[0], v[1]] as Vec2;
}
export const checkStrokeWidth = checkLength(SHAPE_LIMITS.strokeWidth);
export const checkRadius = checkLength(SHAPE_LIMITS.cornerRadius);

/** A static value becomes a static Animatable (keys dropped, like TransformPatch); an Animatable is checked whole. */
function animOf<T>(
	v: T | Animatable<T>,
	isStatic: boolean,
	check: (x: unknown, field: string, h: HandlerContext) => T,
	field: string,
	h: HandlerContext,
): Animatable<T> {
	if (isStatic) return anim(check(v, field, h));
	const a = v as Animatable<T>;
	return {
		...a,
		value: check(a.value, field, h),
		keyframes: a.keyframes.map((k) => ({ ...k, value: check(k.value, field, h) })),
	};
}

function newStroke(): ShapeStroke {
	return {
		color: anim<RGBA>([...DEFAULT_SHAPE_STROKE.color] as RGBA),
		width: anim(DEFAULT_SHAPE_STROKE.width),
		position: DEFAULT_SHAPE_STROKE.position,
	};
}

/**
 * Storage of a `shape.fill` / `shape.stroke.*` target whose fill or stroke may be "None". With `create` (an explicit
 * write: `param.set`, `keyframe.add` with a value) the fill (white) or a default stroke is created first and the
 * write proceeds as usual (S11:SHP-003/005). Returns false when it stays "None" (the caller refuses the command).
 */
export function ensureShapeStorage(clip: DClip, spec: PropertySpec, create: boolean): boolean {
	if (clip.kind !== 'shape') return true;
	const s = (clip as Draft<ShapeClip>).shape;
	if (s.type === 'vector') return true;
	const part = spec.storagePath[1];
	if ((part !== 'fill' && part !== 'stroke') || s[part] !== null) return true;
	if (!create) return false;
	if (part === 'fill') s.fill = anim<RGBA>([1, 1, 1, 1]);
	else s.stroke = newStroke();
	return true;
}

/** Merges a clip.update shape patch into the current shape; the type is fixed (vector shapes refuse it). */
export function applyShapePatch(shape: Draft<ShapeData>, p: ShapePatch, h: HandlerContext): void {
	if (shape.type === 'vector')
		h.fail(
			'E_INVALID_PARAM',
			'This is a vector shape: edit its items with shape.updateItem / shape.addItems (or param.set on shape.items.<id>.<field>)',
		);
	const s = shape;
	if (p.size !== undefined) s.size = animOf<Vec2>(p.size, Array.isArray(p.size), checkSize, 'size', h);
	if (p.cornerRadius !== undefined) {
		if (s.type !== 'rect') h.fail('E_INVALID_PARAM', 'cornerRadius applies to rectangles only');
		s.cornerRadius = animOf(
			p.cornerRadius,
			typeof p.cornerRadius === 'number',
			checkRadius,
			'cornerRadius',
			h,
		);
	}
	if (p.fill !== undefined)
		s.fill = p.fill === null ? null : animOf<RGBA>(p.fill, Array.isArray(p.fill), checkColor, 'fill', h);
	if (p.stroke === null) s.stroke = null;
	else if (p.stroke !== undefined) {
		const st = s.stroke ?? newStroke();
		const { color, width, position } = p.stroke;
		if (color !== undefined)
			st.color = animOf<RGBA>(color, Array.isArray(color), checkColor, 'stroke.color', h);
		if (width !== undefined)
			st.width = animOf(width, typeof width === 'number', checkStrokeWidth, 'stroke.width', h);
		if (position !== undefined) st.position = position;
		s.stroke = st;
	}
}
