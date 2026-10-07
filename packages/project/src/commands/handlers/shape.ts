// Shape clips (M2, S11:SHP-001…003, ARCHITECTURE §20.1): clip.addShape, the `shape` patch of clip.update,
// the "None" fill/stroke materialisation behind `param.set shape.*`, and the rule that keeps a shape centred on
// its anchor when an edit changes its layer box. Owner: wp-m2-shapes.
//
// The layer box of a shape is `shapeIntrinsicBox` (largest size over the keyframes, or the static value when there
// are none, plus the stroke drawn outside) and the geometry is centred in it. When an edit changes that box, the
// anchor (value and keys) moves by half the change, so the geometry stays where it was on screen
// (M(c) = P + R·S·(c − A) is unchanged).
import { type Draft, isDraft } from 'immer';
import {
	anim,
	type Box,
	DEFAULT_SHAPE_SECONDS,
	defaultShape,
	defaultTransform,
	shapeIntrinsicBox,
} from '../../factories.ts';
import { kindCapabilities } from '../../registry/kinds.ts';
import { DEFAULT_SHAPE_STROKE, type PropertySpec, SHAPE_LIMITS } from '../../registry/properties.ts';
import type { Animatable, RGBA, Vec2 } from '../../schema/common.ts';
import type { Clip, Sequence, ShapeClip, ShapeData, ShapeStroke } from '../../schema/sequence.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { cleanupSequence } from '../placement.ts';
import type { ClipPatch, ShapePatch } from '../schemas/clip.ts';
import type { CommandType } from '../schemas/index.ts';
import { applyTransformPatch, commonFields, frameBox, newGeneratorClip, visualFields } from './clip-core.ts';
import { type Handler, type HandlerMap, memoPlain, peek, peekKeys } from './util.ts';

export const SHAPE_OWNER = 'wp-m2-shapes';

const SHAPE_NAMES = { rect: 'Rectangle', ellipse: 'Ellipse' } as const;
type DShape = Draft<ShapeData>;

// ---------------------------------------------------------------- validation

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function checkColor(v: unknown, field: string, h: HandlerContext): RGBA {
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
function checkSize(v: unknown, field: string, h: HandlerContext): Vec2 {
	const ok = (x: unknown) => finite(x) && x >= 0 && x <= SHAPE_LIMITS.size;
	if (!Array.isArray(v) || v.length !== 2 || !v.every(ok))
		h.fail('E_INVALID_PARAM', `${field} must be [width, height] in 0..${SHAPE_LIMITS.size} (px)`, {
			path: [field],
		});
	return [v[0], v[1]] as Vec2;
}
const checkStrokeWidth = checkLength(SHAPE_LIMITS.strokeWidth);
const checkRadius = checkLength(SHAPE_LIMITS.cornerRadius);

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

// ---------------------------------------------------------------- centring

function shiftVec(a: Draft<Animatable<Vec2>>, dx: number, dy: number): void {
	a.value = [a.value[0] + dx, a.value[1] + dy];
	for (const k of a.keyframes) k.value = [k.value[0] + dx, k.value[1] + dy];
}

/** Moves the anchor by half the box change so the geometry keeps its place (module comment). */
function recenterShape(clip: Draft<ShapeClip>, before: Box): void {
	const after = shapeIntrinsicBox(clip.shape as ShapeData);
	const dx = (after.width - before.width) / 2;
	const dy = (after.height - before.height) / 2;
	if (dx !== 0 || dy !== 0) shiftVec(clip.transform.anchor, dx, dy);
}

/**
 * Wraps a handler of a command that can change shape boxes (clip.update, param.set, keyframe edits): every
 * shape whose box changed during the command is re-centred on its anchor.
 */
/** Boxes of the shape clips of a clips record (memoized per untouched record). */
const shapeBoxCache = new WeakMap<object, [string, Box][]>();
function shapeBoxes(clips: Record<string, Clip>): [string, Box][] {
	return memoPlain(shapeBoxCache, clips, () => {
		const out: [string, Box][] = [];
		for (const cid of peekKeys(clips)) {
			const c = peek<Clip>(clips, cid);
			if (c?.kind === 'shape') out.push([cid, shapeIntrinsicBox(c.shape as ShapeData)]);
		}
		return out;
	});
}

export function keepShapesCentred<T extends CommandType>(handler: Handler<T>): Handler<T> {
	return (doc, cmd, h) => {
		// This wraps every parameter and keyframe command. Reading every clip of a large document through the draft
		// cost more than the command itself, so the document is read with `peek` (no drafts) and per-record box lists
		// are memoized; after the command only records the command touched (drafts) can hold a changed box, and only
		// a shape whose box changed is written through the draft.
		const sequences = peek<Record<string, Sequence>>(doc, 'sequences')!;
		const before = new Map<string, Map<string, Box>>();
		for (const sid of peekKeys(sequences)) {
			const boxes = shapeBoxes(peek<Record<string, Clip>>(peek<Sequence>(sequences, sid)!, 'clips')!);
			if (boxes.length) before.set(sid, new Map(boxes));
		}
		const result = handler(doc, cmd, h);
		const after = peek<Record<string, Sequence>>(doc, 'sequences')!;
		for (const [sid, boxes] of before) {
			const clips = peek<Record<string, Clip>>(peek<Sequence>(after, sid) ?? {}, 'clips');
			if (!clips || !isDraft(clips)) continue;
			for (const [cid, box] of shapeBoxes(clips)) {
				const was = boxes.get(cid);
				if (was && (was.width !== box.width || was.height !== box.height))
					recenterShape(doc.sequences[sid]!.clips[cid] as Draft<ShapeClip>, was);
			}
		}
		return result;
	};
}

/**
 * Commands whose handlers run inside `keepShapesCentred` (wired in catalog.ts): every command that can change the
 * keys or values of `shape.size` / `shape.stroke.*` — `clip.update {shape}`, the stopwatch, and every keyframe
 * command (moving a key onto another one deletes it; interpolation is listed so the set covers the whole family).
 * The clipboard's attribute and keyframe pastes are listed too; undo/redo restore whole snapshots (anchor included).
 */
export const SHAPE_BOX_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>([
	'clip.update',
	'param.set',
	'param.setAnimated',
	'keyframe.add',
	'keyframe.update',
	'keyframe.remove',
	'keyframe.move',
	'keyframe.setInterpolation',
	'keyframes.prune',
	// wp-m3-trackui: keyframe simplification (S09:TRK-023)
	'keyframes.simplify',
	// wp-clipboard: pasted shape styles and keyframes
	'clip.pasteAttributes',
	'clip.removeAttributes',
	'keyframe.paste',
]);

// ---------------------------------------------------------------- fill / stroke materialisation

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
	const part = spec.storagePath[1];
	if ((part !== 'fill' && part !== 'stroke') || s[part] !== null) return true;
	if (!create) return false;
	if (part === 'fill') s.fill = anim<RGBA>([1, 1, 1, 1]);
	else s.stroke = newStroke();
	return true;
}

// ---------------------------------------------------------------- clip.update {shape}

function patchShape(s: DShape, p: ShapePatch, h: HandlerContext): void {
	if (p.size !== undefined)
		s.size = animOf<Vec2>(p.size as never, Array.isArray(p.size), checkSize, 'size', h);
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
		s.fill =
			p.fill === null ? null : animOf<RGBA>(p.fill as never, Array.isArray(p.fill), checkColor, 'fill', h);
	if (p.stroke === null) s.stroke = null;
	else if (p.stroke !== undefined) {
		const st = (s.stroke ?? newStroke()) as Draft<ShapeStroke>;
		const { color, width, position } = p.stroke;
		if (color !== undefined)
			st.color = animOf<RGBA>(color as never, Array.isArray(color), checkColor, 'stroke.color', h);
		if (width !== undefined)
			st.width = animOf(width, typeof width === 'number', checkStrokeWidth, 'stroke.width', h);
		if (position !== undefined) st.position = position;
		s.stroke = st;
	}
}

/** clip.update `{shape}` (merged into the current shape; the type is fixed). Returns true when it handled it. */
export function applyShapePatch(
	_doc: DDoc,
	_seq: DSeq,
	clip: DClip,
	p: Pick<ClipPatch, 'shape'>,
	h: HandlerContext,
): boolean {
	if (p.shape === undefined) return false;
	patchShape((clip as Draft<ShapeClip>).shape, p.shape, h);
	return true;
}

// ---------------------------------------------------------------- clip.addShape

export const shapeHandlers: HandlerMap = {
	'clip.addShape': (doc, cmd, h: HandlerContext) => {
		const input = cmd.shape;
		const shape = defaultShape(input.type, {
			...(input.size ? { size: checkSize(input.size, 'shape.size', h) } : {}),
			...(input.fill !== undefined
				? { fill: input.fill === null ? null : checkColor(input.fill, 'shape.fill', h) }
				: {}),
			...(input.stroke !== undefined
				? {
						stroke: input.stroke && {
							color: checkColor(input.stroke.color, 'shape.stroke.color', h),
							width: checkStrokeWidth(input.stroke.width, 'shape.stroke.width', h),
							position: input.stroke.position ?? DEFAULT_SHAPE_STROKE.position,
						},
					}
				: {}),
			...(input.cornerRadius !== undefined
				? { cornerRadius: checkRadius(input.cornerRadius, 'shape.cornerRadius', h) }
				: {}),
		});
		if (input.type === 'ellipse' && shape.cornerRadius.value !== 0)
			h.fail('E_INVALID_PARAM', 'cornerRadius applies to rectangles only', {
				path: ['shape', 'cornerRadius'],
			});
		const { seq, track, at, duration, id } = newGeneratorClip(
			doc,
			{ ...cmd, duration: cmd.duration ?? { seconds: DEFAULT_SHAPE_SECONDS } },
			h,
			'shape',
		);
		const transform = applyTransformPatch(
			defaultTransform(shapeIntrinsicBox(shape), frameBox(seq), 'none'),
			cmd.transform,
		);
		seq.clips[id] = {
			...commonFields(
				id,
				track.id,
				at,
				duration,
				0,
				cmd.name ?? SHAPE_NAMES[input.type],
				kindCapabilities('shape')!.defaultLabel,
			),
			kind: 'shape',
			shape,
			...visualFields(transform),
		} as DClip;
		cleanupSequence(seq, h);
		h.defineRef(cmd.ref, id);
		return { clipId: id };
	},
};
