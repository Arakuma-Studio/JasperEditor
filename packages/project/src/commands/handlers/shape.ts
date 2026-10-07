// Shape clips (M2, S11:SHP-001…003, ARCHITECTURE §20.1): clip.addShape, the `shape` patch of clip.update,
// the "None" fill/stroke materialisation behind `param.set shape.*`, and the rule that keeps a shape centred on
// its anchor when an edit changes its layer box. Owner: wp-m2-shapes.
//
// The layer box of a shape is `shapeIntrinsicBox` (largest size over the keyframes, or the static value when there
// are none, plus the stroke drawn outside) and the geometry is centred in it. When an edit changes that box, the
// anchor (value and keys) moves by half the change, so the geometry stays where it was on screen
// (M(c) = P + R·S·(c − A) is unchanged).
import type { Draft } from 'immer';
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
import type { LegacyShapeData, ShapeClip, ShapeData, ShapeStroke } from '../../schema/sequence.ts';
import type { ShapeItem } from '../../schema/shapes.ts';
import { findItem, newShapeItem, nextItemName, reidItems, walkItems } from '../../vector/defaults.ts';
import { buildShapeItems, type IdGen, patchShapeItem, ShapeInputError } from '../../vector/input.ts';
import { getShapePreset } from '../../vector/presets.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, cleanupSequence, findTrackIn } from '../placement.ts';
import type { ClipPatch, ShapePatch } from '../schemas/clip.ts';
import type { CommandOf, CommandType } from '../schemas/index.ts';
import { applyTransformPatch, commonFields, frameBox, newGeneratorClip, visualFields } from './clip-core.ts';
import type { Handler, HandlerMap } from './util.ts';

export const SHAPE_OWNER = 'wp-m2-shapes';

const SHAPE_NAMES = { rect: 'Rectangle', ellipse: 'Ellipse', vector: 'Shape' } as const;
type DShape = Draft<LegacyShapeData>;

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
	// wp shapes: a vector shape's box is the frame whatever its contents; nothing to re-centre.
	if (clip.shape.type === 'vector') return;
	const after = shapeIntrinsicBox(clip.shape as ShapeData);
	const dx = (after.width - before.width) / 2;
	const dy = (after.height - before.height) / 2;
	if (dx !== 0 || dy !== 0) shiftVec(clip.transform.anchor, dx, dy);
}

/**
 * Wraps a handler of a command that can change shape boxes (clip.update, param.set, keyframe edits): every
 * shape whose box changed during the command is re-centred on its anchor.
 */
export function keepShapesCentred<T extends CommandType>(handler: Handler<T>): Handler<T> {
	return (doc, cmd, h) => {
		const before: [Draft<ShapeClip>, Box][] = [];
		for (const seq of Object.values(doc.sequences))
			for (const c of Object.values(seq.clips))
				if (c.kind === 'shape') before.push([c as Draft<ShapeClip>, shapeIntrinsicBox(c.shape as ShapeData)]);
		const result = handler(doc, cmd, h);
		for (const [clip, box] of before) recenterShape(clip, box);
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
	if (s.type === 'vector') return true;
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
	const shape = (clip as Draft<ShapeClip>).shape;
	if (shape.type === 'vector')
		h.fail(
			'E_INVALID_PARAM',
			'This is a vector shape: edit its items with shape.updateItem / shape.addItems (or param.set on shape.items.<id>.<field>)',
		);
	patchShape(shape as DShape, p.shape, h);
	return true;
}

// ---------------------------------------------------------------- vector shapes (wp shapes)

/** Item and keyframe ids for a command. */
function idGen(h: HandlerContext): IdGen {
	return { item: () => h.ids.next('shp'), keyframe: () => h.ids.next('kf') };
}

/** Runs a builder and turns input errors into E_INVALID_PARAM. */
function build<T>(h: HandlerContext, f: () => T, at: string[] = []): T {
	try {
		return f();
	} catch (e) {
		if (e instanceof ShapeInputError) return h.fail('E_INVALID_PARAM', e.message, { path: [...at, ...e.path] });
		throw e;
	}
}

/** The items a preset or an item list stands for. */
function inputItems(h: HandlerContext, items: readonly unknown[] | undefined, preset: string | undefined): unknown[] {
	if (preset !== undefined) {
		if (items) h.fail('E_INVALID_PARAM', 'Give either items or a preset, not both');
		const p = getShapePreset(preset);
		if (!p) return h.fail('E_INVALID_PARAM', `Unknown shape preset "${preset}"`, { path: ['preset'] });
		return p.items();
	}
	return [...(items ?? [])];
}

type DVector = Draft<{ type: 'vector'; contents: ShapeItem[] }>;

/** The vector shape of a clip (locked tracks refused). */
function vectorOf(doc: DDoc, clipId: string, h: HandlerContext): { seq: DSeq; clip: DClip; shape: DVector } {
	const { seq, clip } = h.clip(doc, clipId);
	assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
	if (clip.kind !== 'shape') return h.fail('E_INVALID_PARAM', `Clip ${clipId} is not a shape`);
	const shape = (clip as Draft<ShapeClip>).shape;
	if (shape.type !== 'vector')
		return h.fail(
			'E_INVALID_PARAM',
			`Clip ${clipId} is a ${shape.type === 'rect' ? 'rectangle' : 'ellipse'}: run shape.convertToVector first`,
		);
	return { seq, clip, shape: shape as DVector };
}

/** The list an item goes into: the top level or a group's contents. */
function targetList(shape: DVector, parentId: string | null | undefined, h: HandlerContext): ShapeItem[] {
	if (parentId === null || parentId === undefined) return shape.contents as ShapeItem[];
	const found = findItem(shape.contents as ShapeItem[], parentId);
	if (!found) return h.fail('E_NOT_FOUND', `Shape item not found: ${parentId}`, { path: ['parentId'] });
	if (found.item.type !== 'group') return h.fail('E_INVALID_PARAM', `${found.item.name} is not a group`);
	return found.item.contents;
}

function locateItem(shape: DVector, itemId: string, h: HandlerContext) {
	const found = findItem(shape.contents as ShapeItem[], itemId);
	if (!found) return h.fail('E_NOT_FOUND', `Shape item not found: ${itemId}`, { path: ['itemId'] });
	return found;
}

const clampIndex = (i: number | undefined, len: number) => Math.min(len, Math.max(0, i ?? len));

/** Rectangle / ellipse clip → vector contents with the same picture (values and keyframes carried over). */
export function legacyToVectorItems(s: LegacyShapeData, ids: IdGen): ShapeItem[] {
	const items: ShapeItem[] = [];
	const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
	if (s.type === 'rect') {
		const r = newShapeItem('rect', { id: ids.item(), name: 'Rectangle Path 1' });
		r.size = json(s.size);
		r.roundness = json(s.cornerRadius);
		items.push(r);
	} else {
		const e = newShapeItem('ellipse', { id: ids.item(), name: 'Ellipse Path 1' });
		e.size = json(s.size);
		items.push(e);
	}
	if (s.stroke) {
		const st = newShapeItem('stroke', { id: ids.item(), name: 'Stroke 1' });
		st.color = json(s.stroke.color);
		st.width = json(s.stroke.width);
		st.position = s.stroke.position;
		// The legacy renderer draws mitred corners with limit 4 (the SVG default).
		items.push(st);
	}
	if (s.fill) {
		const f = newShapeItem('fill', { id: ids.item(), name: 'Fill 1' });
		f.color = json(s.fill);
		items.push(f);
	}
	return items;
}

function shiftAnchor(clip: Draft<ShapeClip>, dx: number, dy: number): void {
	const a = clip.transform.anchor;
	a.value = [a.value[0] + dx, a.value[1] + dy];
	for (const k of a.keyframes) k.value = [k.value[0] + dx, k.value[1] + dy];
}

const vectorHandlers: HandlerMap = {
	'shape.addItems': (doc, cmd, h) => {
		const { shape } = vectorOf(doc, cmd.clipId, h);
		const list = targetList(shape, cmd.parentId, h);
		const inputs = inputItems(h, cmd.items, cmd.preset);
		if (!inputs.length) h.fail('E_INVALID_PARAM', 'No items to add');
		const items = build(h, () => buildShapeItems(inputs, idGen(h), shape.contents as ShapeItem[]), ['items']);
		list.splice(clampIndex(cmd.index, list.length), 0, ...items);
		h.defineRef(cmd.ref, items[0]!.id);
		return { itemIds: items.map((i) => i.id) };
	},
	'shape.updateItem': (doc, cmd, h) => {
		const { shape } = vectorOf(doc, cmd.clipId, h);
		const found = locateItem(shape, cmd.itemId, h);
		const next = build(h, () => patchShapeItem(found.item, cmd.patch as Record<string, unknown>, idGen(h)), ['patch']);
		found.list[found.index] = next;
		return { itemId: next.id };
	},
	'shape.removeItems': (doc, cmd, h) => {
		const { shape } = vectorOf(doc, cmd.clipId, h);
		for (const id of cmd.itemIds) locateItem(shape, id, h);
		for (const id of cmd.itemIds) {
			// An id inside a group removed just before is gone with it.
			const found = findItem(shape.contents as ShapeItem[], id);
			if (found) found.list.splice(found.index, 1);
		}
		return { removed: cmd.itemIds.length };
	},
	'shape.moveItem': (doc, cmd, h) => {
		const { shape } = vectorOf(doc, cmd.clipId, h);
		const found = locateItem(shape, cmd.itemId, h);
		if (cmd.parentId && (cmd.parentId === cmd.itemId || found.item.type === 'group')) {
			let inside = cmd.parentId === cmd.itemId;
			if (found.item.type === 'group')
				walkItems(found.item.contents, (it) => {
					if (it.id === cmd.parentId) inside = true;
				});
			if (inside) h.fail('E_INVALID_PARAM', 'A group cannot be moved into itself');
		}
		const [item] = found.list.splice(found.index, 1);
		const list = targetList(shape, cmd.parentId, h);
		list.splice(clampIndex(cmd.index, list.length), 0, item!);
		return { itemId: cmd.itemId };
	},
	'shape.duplicateItem': (doc, cmd, h) => {
		const { shape } = vectorOf(doc, cmd.clipId, h);
		const found = locateItem(shape, cmd.itemId, h);
		const ids = idGen(h);
		const copy = reidKeyframes(
			reidItems([JSON.parse(JSON.stringify(found.item)) as ShapeItem], ids.item)[0]!,
			ids.keyframe,
		);
		copy.name = nextItemName(shape.contents as ShapeItem[], copy.type);
		found.list.splice(found.index, 0, copy);
		h.defineRef(cmd.ref, copy.id);
		return { itemId: copy.id };
	},
	'shape.groupItems': (doc, cmd, h) => {
		const { shape } = vectorOf(doc, cmd.clipId, h);
		const located = cmd.itemIds.map((id) => locateItem(shape, id, h));
		const list = located[0]!.list;
		if (located.some((l) => l.list !== list)) h.fail('E_INVALID_PARAM', 'Only items of the same group can be grouped');
		const order = [...located].sort((a, b) => a.index - b.index);
		const at = order[0]!.index;
		const members = order.map((l) => l.item);
		for (const l of [...order].reverse()) list.splice(l.index, 1);
		const group = newShapeItem('group', {
			id: h.ids.next('shp'),
			name: cmd.name ?? nextItemName(shape.contents as ShapeItem[], 'group'),
			contents: members,
		});
		list.splice(at, 0, group);
		h.defineRef(cmd.ref, group.id);
		return { groupId: group.id };
	},
	'shape.setContents': (doc, cmd, h) => {
		const { shape } = vectorOf(doc, cmd.clipId, h);
		shape.contents = build(h, () => buildShapeItems(cmd.contents, idGen(h)), ['contents']);
		return { itemIds: (shape.contents as ShapeItem[]).map((i) => i.id) };
	},
	'shape.convertToVector': (doc, cmd, h) => {
		const { seq, clip } = h.clip(doc, cmd.clipId);
		assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
		if (clip.kind !== 'shape') return h.fail('E_INVALID_PARAM', `Clip ${cmd.clipId} is not a shape`);
		const c = clip as Draft<ShapeClip>;
		if (c.shape.type === 'vector') return { converted: false };
		const legacy = JSON.parse(JSON.stringify(c.shape)) as LegacyShapeData;
		const before = shapeIntrinsicBox(legacy);
		const frame = frameBox(seq);
		// Old box: geometry centred in it; new box: the frame, contents around its centre. Keep M(c) unchanged.
		shiftAnchor(c, (frame.width - before.width) / 2, (frame.height - before.height) / 2);
		c.shape = { type: 'vector', contents: legacyToVectorItems(legacy, idGen(h)) } as never;
		return { converted: true };
	},
};

/** Fresh keyframe ids everywhere inside a copied item. */
function reidKeyframes<T>(v: T, next: () => string): T {
	const visit = (x: unknown): void => {
		if (!x || typeof x !== 'object') return;
		if (Array.isArray(x)) {
			for (const y of x) visit(y);
			return;
		}
		const o = x as Record<string, unknown>;
		if (Array.isArray(o.keyframes) && 'value' in o)
			for (const k of o.keyframes as { id: string }[]) k.id = next();
		for (const y of Object.values(o)) visit(y);
	};
	visit(v);
	return v;
}

// ---------------------------------------------------------------- clip.addShape

function legacyShapeFromInput(input: CommandOf<'clip.addShape'>['shape'], h: HandlerContext): LegacyShapeData {
	if (input.contents !== undefined || input.preset !== undefined)
		h.fail('E_INVALID_PARAM', 'contents and preset apply to vector shapes (type "vector")', { path: ['shape'] });
	const shape = defaultShape(input.type as 'rect' | 'ellipse', {
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
	return shape;
}

function vectorShapeFromInput(input: CommandOf<'clip.addShape'>['shape'], h: HandlerContext): ShapeData {
	for (const k of ['size', 'fill', 'stroke', 'cornerRadius'] as const)
		if (input[k] !== undefined)
			h.fail('E_INVALID_PARAM', `${k} applies to rectangles and ellipses; vector shapes take contents or a preset`, {
				path: ['shape', k],
			});
	const items = inputItems(h, input.contents, input.preset);
	return { type: 'vector', contents: build(h, () => buildShapeItems(items, idGen(h)), ['shape', 'contents']) };
}

export const shapeHandlers: HandlerMap = {
	...vectorHandlers,
	'clip.addShape': (doc, cmd, h: HandlerContext) => {
		const input = cmd.shape;
		const shape = input.type === 'vector' ? vectorShapeFromInput(input, h) : legacyShapeFromInput(input, h);
		const { seq, track, at, duration, id } = newGeneratorClip(
			doc,
			{ ...cmd, duration: cmd.duration ?? { seconds: DEFAULT_SHAPE_SECONDS } },
			h,
			'shape',
		);
		const transform = applyTransformPatch(
			defaultTransform(shapeIntrinsicBox(shape, frameBox(seq)), frameBox(seq), 'none'),
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
