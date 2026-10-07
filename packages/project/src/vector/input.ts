// Shape item input (wp shapes): the relaxed form agents, presets, paste and the SVG converter use to create and
// patch vector shape items. Any animatable field takes a static value or a full Animatable; colours take RGBA floats
// or "#RRGGBB(AA)"; a `path` takes a path value or SVG path data (several subpaths become several path items);
// group contents nest. `buildShapeItems` fills in After Effects' defaults and fresh ids, `patchShapeItem` merges a
// patch into an item, and `checkShapeItem` validates a whole item (also used by the document invariants).
import { z } from 'zod';
import { AnimNumberSchema, AnimRGBASchema, AnimVec2Schema, type Animatable, RGBASchema, type RGBA, type Vec2 } from '../schema/common.ts';
import {
	AnimGradientSchema,
	AnimPathSchema,
	GradientValueSchema,
	PathValueSchema,
	SHAPE_BLEND_MODES,
	SHAPE_ITEM_TYPES,
	type ShapeItem,
	type ShapeItemType,
} from '../schema/shapes.ts';
import { defaultDashes, defaultTaper, defaultWave, newShapeItem, nextItemName, walkItems } from './defaults.ts';
import { shapeItemSpecsOf } from './properties.ts';
import { parseSvgPath } from './svg-path.ts';
import { bezToPathValues, type PathValue } from './values.ts';

const HEX = z.string().regex(/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8}|[0-9a-fA-F]{3})$/, 'colour "#RRGGBB" or "#RRGGBBAA"');
const num = z.union([z.number(), AnimNumberSchema]);
const vec = z.union([z.tuple([z.number(), z.number()]), AnimVec2Schema]);
const color = z.union([RGBASchema, HEX, AnimRGBASchema]);
const pathIn = z.union([z.string().describe('SVG path data'), PathValueSchema, AnimPathSchema]);
const gradientIn = z.union([GradientValueSchema, AnimGradientSchema]);

/** Item fields an input may carry (validated per type when the item is built). */
const ItemFields = z.looseObject({
	type: z.enum(SHAPE_ITEM_TYPES),
	name: z.string().max(200).optional(),
	enabled: z.boolean().optional(),
	direction: z.enum(['normal', 'reversed']).optional(),
	blendMode: z.enum(SHAPE_BLEND_MODES).optional(),
	composite: z.enum(['below', 'above']).optional(),
	fillRule: z.enum(['nonzero', 'evenodd']).optional(),
	// geometry
	size: z.union([vec, num]).optional(),
	position: z.union([vec, z.enum(['center', 'inside', 'outside'])]).optional(),
	roundness: num.optional(),
	starType: z.enum(['star', 'polygon']).optional(),
	points: z.union([num, z.enum(['corner', 'smooth'])]).optional(),
	rotation: num.optional(),
	innerRadius: num.optional(),
	outerRadius: num.optional(),
	innerRoundness: num.optional(),
	outerRoundness: num.optional(),
	path: pathIn.optional(),
	// paint
	color: color.optional(),
	opacity: num.optional(),
	width: num.optional(),
	lineCap: z.enum(['butt', 'round', 'square']).optional(),
	lineJoin: z.enum(['miter', 'round', 'bevel']).optional(),
	miterLimit: num.optional(),
	dashes: z
		.union([
			z.null(),
			z.array(z.number().min(0)).describe('dash, gap, dash 2, gap 2, dash 3, gap 3 (px)'),
			z.looseObject({
				segments: z.array(z.looseObject({ dash: num, gap: num.optional() })).max(3),
				offset: num.optional(),
			}),
		])
		.optional(),
	taper: z.union([z.null(), z.looseObject({})]).optional(),
	wave: z.union([z.null(), z.looseObject({})]).optional(),
	gradientType: z.enum(['linear', 'radial']).optional(),
	startPoint: vec.optional(),
	endPoint: vec.optional(),
	highlightLength: num.optional(),
	highlightAngle: num.optional(),
	colors: gradientIn.optional(),
	// operators
	start: num.optional(),
	end: num.optional(),
	offset: num.optional(),
	mode: z.enum(['simultaneous', 'individual', 'merge', 'add', 'subtract', 'intersect', 'exclude']).optional(),
	copies: num.optional(),
	amount: num.optional(),
	copyOffset: num.optional(),
	radius: num.optional(),
	ridges: num.optional(),
	angle: num.optional(),
	center: vec.optional(),
	detail: num.optional(),
	speed: num.optional(),
	correlation: num.optional(),
	temporalPhase: num.optional(),
	spatialPhase: num.optional(),
	seed: num.optional(),
	// group / repeater
	transform: z.looseObject({}).optional(),
	contents: z.array(z.unknown()).optional(),
});

/**
 * One shape item as given by a caller. `type` picks the item; any other field of that item may be given (static
 * values or Animatables); missing fields take After Effects' defaults. Groups take `contents` (nested inputs) and
 * `transform` ({anchor, position, scale, skew, skewAxis, rotation, opacity}); repeaters take `transform`
 * ({anchor, position, scale, rotation, startOpacity, endOpacity}); strokes take `dashes` ([dash, gap, …] or
 * {segments, offset}), `taper` ({units, startLength, endLength, startWidth, endWidth, startEase, endEase}) and `wave`
 * ({amount, units, wavelength, cycles, phase}); `path` takes SVG path data or {vertices, inTangents, outTangents,
 * closed}.
 */
export const ShapeItemInputSchema = ItemFields;
export type ShapeItemInput = z.infer<typeof ItemFields> & { contents?: ShapeItemInput[] };

/** A patch of an existing item: any field of its type (the type and id cannot change; contents move by command). */
export const ShapeItemPatchSchema = ItemFields.omit({ type: true, contents: true }).partial();
export type ShapeItemPatch = z.infer<typeof ShapeItemPatchSchema>;

export class ShapeInputError extends Error {
	constructor(
		message: string,
		readonly path: string[] = [],
	) {
		super(message);
	}
}

export type IdGen = { item(): string; keyframe(): string };

export function hexToRgba(hex: string): RGBA {
	let h = hex.replace('#', '');
	if (h.length === 3) h = h.replace(/./g, (c) => c + c);
	const v = (i: number) => Number.parseInt(h.slice(i, i + 2), 16) / 255;
	return [v(0), v(2), v(4), h.length === 8 ? v(6) : 1];
}

const isAnim = (v: unknown): v is Animatable<unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v) && 'value' in v && Array.isArray((v as { keyframes?: unknown }).keyframes);

/** A static value (wrapped) or an Animatable (keyframe ids refreshed). */
function toAnim(v: unknown, ids: IdGen, conv: (x: unknown) => unknown = (x) => x): Animatable<unknown> {
	if (isAnim(v))
		return {
			value: conv(v.value),
			keyframes: v.keyframes.map((k) => ({ ...k, id: ids.keyframe(), value: conv(k.value) })),
		};
	return { value: conv(v), keyframes: [] };
}

const colorConv = (x: unknown) => (typeof x === 'string' ? hexToRgba(x) : x);

/** Fields of each type that hold an Animatable, with their value converter. */
const COLOR_FIELDS = new Set(['color']);

function setAnimField(target: Record<string, unknown>, key: string, v: unknown, ids: IdGen): void {
	target[key] = toAnim(v, ids, COLOR_FIELDS.has(key) ? colorConv : (x) => x);
}

/** Applies the fields of `src` onto `item` (a fresh default item or a draft), following the item's own shape. */
function assign(item: Record<string, unknown>, src: Record<string, unknown>, ids: IdGen, path: string[]): void {
	for (const [k, v] of Object.entries(src)) {
		if (v === undefined || k === 'type' || k === 'id' || k === 'contents') continue;
		const cur = item[k];
		const p = [...path, k];
		if (k === 'name') {
			if (typeof v !== 'string') throw new ShapeInputError('name must be a string', p);
			item.name = v;
		} else if (k === 'enabled') {
			if (typeof v !== 'boolean') throw new ShapeInputError('enabled must be a boolean', p);
			if (v) delete item.enabled;
			else item.enabled = false;
		} else if (k === 'dashes') {
			if (v === null) item.dashes = null;
			else if (Array.isArray(v)) {
				const segs: { dash: Animatable<number>; gap: Animatable<number> }[] = [];
				for (let i = 0; i < Math.min(6, v.length); i += 2)
					segs.push({ dash: toAnim(v[i], ids) as never, gap: toAnim(v[i + 1] ?? v[i], ids) as never });
				const prev = item.dashes as { offset?: Animatable<number> } | null | undefined;
				item.dashes = { segments: segs, offset: prev?.offset ?? defaultDashes().offset };
			} else {
				const o = v as { segments?: { dash: unknown; gap?: unknown }[]; offset?: unknown };
				const base = (item.dashes as Record<string, unknown> | null | undefined) ?? defaultDashes();
				const next: Record<string, unknown> = { ...base };
				if (o.segments)
					next.segments = o.segments.slice(0, 3).map((s) => ({ dash: toAnim(s.dash, ids), gap: toAnim(s.gap ?? s.dash, ids) }));
				if (o.offset !== undefined) next.offset = toAnim(o.offset, ids);
				item.dashes = next;
			}
		} else if (k === 'taper' || k === 'wave') {
			if (v === null) item[k] = null;
			else {
				const base = (cur as Record<string, unknown> | null | undefined) ?? (k === 'taper' ? defaultTaper() : defaultWave());
				const next: Record<string, unknown> = { ...base };
				assign(next, v as Record<string, unknown>, ids, p);
				item[k] = next;
			}
		} else if (k === 'transform') {
			if (!cur || typeof cur !== 'object') throw new ShapeInputError(`${String(item.type)} has no transform`, p);
			const next = { ...(cur as Record<string, unknown>) };
			assign(next, v as Record<string, unknown>, ids, p);
			item.transform = next;
		} else if (k === 'path') {
			const conv = (x: unknown): PathValue => {
				if (typeof x === 'string') {
					const pv = bezToPathValues(parseSvgPath(x));
					return pv[0] ?? { vertices: [], inTangents: [], outTangents: [], closed: false };
				}
				return x as PathValue;
			};
			item.path = toAnim(v, ids, conv);
		} else if (isAnim(cur)) {
			setAnimField(item, k, v, ids);
		} else if (cur === undefined && !(k in item)) {
			// Optional enum fields (direction, blendMode, composite, …) and unknown fields.
			if (typeof v !== 'string') throw new ShapeInputError(`${k} is not a field of ${String(item.type)}`, p);
			item[k] = v;
		} else {
			if (typeof v !== typeof cur && cur !== undefined)
				throw new ShapeInputError(`${k} of ${String(item.type)} has the wrong type`, p);
			item[k] = v;
		}
	}
}

/** Optional (enum) fields each type accepts. */
const OPTIONAL_FIELDS: Partial<Record<ShapeItemType, readonly string[]>> = {
	group: ['blendMode'],
	rect: ['direction'],
	ellipse: ['direction'],
	polystar: ['direction'],
	path: ['direction'],
	fill: ['composite', 'fillRule', 'blendMode'],
	gradientFill: ['composite', 'fillRule', 'blendMode'],
	stroke: ['composite', 'blendMode', 'lineCap', 'lineJoin', 'position'],
	gradientStroke: ['composite', 'blendMode', 'lineCap', 'lineJoin', 'position'],
	trim: ['mode'],
	repeater: ['composite'],
	offsetPaths: ['lineJoin'],
	zigZag: ['points'],
	wiggle: ['points'],
};

function checkKnownFields(type: ShapeItemType, src: Record<string, unknown>, path: string[]): void {
	const template = newShapeItem(type, { id: 'x' }) as unknown as Record<string, unknown>;
	const allowed = new Set([
		...Object.keys(template),
		...(OPTIONAL_FIELDS[type] ?? []),
		'type',
		'id',
		'enabled',
		...(type === 'stroke' || type === 'gradientStroke' ? ['dashes', 'taper', 'wave'] : []),
	]);
	for (const k of Object.keys(src))
		if (!allowed.has(k) && src[k] !== undefined)
			throw new ShapeInputError(`${k} is not a field of a ${type} item`, [...path, k]);
}

/**
 * Builds items from inputs: defaults, fresh ids (item and keyframe), numbered names unique in `existing`. A `path`
 * input with several subpaths becomes several path items. Throws ShapeInputError on invalid input.
 */
export function buildShapeItems(
	inputs: readonly unknown[],
	ids: IdGen,
	existing: readonly ShapeItem[] = [],
	path: string[] = [],
): ShapeItem[] {
	const out: ShapeItem[] = [];
	const naming = [...existing];
	inputs.forEach((raw, i) => {
		const p = [...path, String(i)];
		const parsed = ItemFields.safeParse(raw);
		if (!parsed.success) throw new ShapeInputError(`Invalid shape item: ${parsed.error.issues[0]?.message ?? ''}`, p);
		const src = parsed.data as Record<string, unknown>;
		const type = src.type as ShapeItemType;
		checkKnownFields(type, src, p);
		// SVG path data with several subpaths: one path item per subpath.
		if (type === 'path' && typeof src.path === 'string') {
			let values: PathValue[];
			try {
				values = bezToPathValues(parseSvgPath(src.path));
			} catch (e) {
				throw new ShapeInputError((e as Error).message, [...p, 'path']);
			}
			if (values.length > 1) {
				const expanded = values.map((v, k) => ({ ...src, path: v, ...(src.name ? { name: `${String(src.name)} ${k + 1}` } : {}) }));
				const items = buildShapeItems(expanded, ids, [...existing, ...out], path);
				out.push(...items);
				naming.push(...items);
				return;
			}
		}
		const item = newShapeItem(type, { id: ids.item(), name: nextItemName(naming, type) }) as unknown as Record<string, unknown>;
		assign(item, src, ids, p);
		if (type === 'group') {
			const kids = (src.contents as unknown[] | undefined) ?? [];
			(item as { contents: ShapeItem[] }).contents = buildShapeItems(kids, ids, [...naming, ...out], [...p, 'contents']);
		}
		const err = checkShapeItem(item as ShapeItem);
		if (err) throw new ShapeInputError(err.message, [...p, ...err.path]);
		out.push(item as ShapeItem);
		naming.push(item as ShapeItem);
	});
	return out;
}

/** Merges a patch into a copy of `item` and validates it. */
export function patchShapeItem(item: ShapeItem, patch: Record<string, unknown>, ids: IdGen): ShapeItem {
	const parsed = ShapeItemPatchSchema.safeParse(patch);
	if (!parsed.success) throw new ShapeInputError(`Invalid patch: ${parsed.error.issues[0]?.message ?? ''}`);
	checkKnownFields(item.type, parsed.data as Record<string, unknown>, []);
	const copy = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
	assign(copy, parsed.data as Record<string, unknown>, ids, []);
	const err = checkShapeItem(copy as ShapeItem, false);
	if (err) throw new ShapeInputError(err.message, err.path);
	return copy as ShapeItem;
}

// ---------------------------------------------------------------- validation

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Validates an item (recursively for groups unless `deep` is false): every field a spec describes exists with a
 * valid value (numbers finite and within the hard range, vectors of two numbers, colours RGBA in 0…1, enums known,
 * paths and gradients well-formed) — static value and every keyframe.
 */
export function checkShapeItem(item: ShapeItem, deep = true): { message: string; path: string[] } | null {
	if (!item || typeof item !== 'object' || !SHAPE_ITEM_TYPES.includes(item.type))
		return { message: 'Unknown shape item type', path: ['type'] };
	if (typeof item.id !== 'string' || !item.id) return { message: 'Shape item without an id', path: ['id'] };
	if (typeof item.name !== 'string') return { message: 'Shape item without a name', path: ['name'] };
	for (const spec of shapeItemSpecsOf(item)) {
		const rel = spec.storagePath;
		let v: unknown = item;
		for (const k of rel) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
		const label = `${item.name}: ${spec.label}`;
		if (spec.animatable === 'no') {
			if (v === undefined) continue;
			if (spec.kind === 'enum' && !spec.options?.includes(v as string))
				return { message: `${label} must be one of ${spec.options?.join(', ')}`, path: [...rel] };
			continue;
		}
		if (!isAnim(v)) return { message: `${label} is missing`, path: [...rel] };
		const values = [v.value, ...v.keyframes.map((k) => k.value)];
		for (const x of values) {
			const bad = (): { message: string; path: string[] } => ({ message: `${label}: invalid value ${JSON.stringify(x)}`, path: [...rel] });
			const inRange = (n: unknown) => finite(n) && (spec.range?.min === undefined || n >= spec.range.min - 1e-9) && (spec.range?.max === undefined || n <= spec.range.max + 1e-9);
			switch (spec.kind) {
				case 'number':
					if (!inRange(x)) return bad();
					break;
				case 'vec2':
					if (!Array.isArray(x) || x.length !== 2 || !x.every(inRange)) return bad();
					break;
				case 'color':
					if (!Array.isArray(x) || x.length !== 4 || !x.every((c) => finite(c) && c >= 0 && c <= 1)) return bad();
					break;
				case 'json':
					if (spec.validate && !spec.validate(x)) return bad();
					break;
			}
		}
		for (const k of v.keyframes) if (typeof k.id !== 'string' || !finite(k.time)) return { message: `${label}: malformed keyframe`, path: [...rel] };
	}
	if (item.type === 'group') {
		if (!Array.isArray(item.contents)) return { message: `${item.name}: contents missing`, path: ['contents'] };
		if (deep)
			for (let i = 0; i < item.contents.length; i++) {
				const e = checkShapeItem(item.contents[i]!);
				if (e) return { message: e.message, path: ['contents', String(i), ...e.path] };
			}
	}
	return null;
}

/** Duplicate item ids within one tree (they must be unique per clip). */
export function duplicateItemIds(contents: readonly ShapeItem[]): string[] {
	const seen = new Set<string>();
	const dup = new Set<string>();
	walkItems(contents, (it) => {
		if (seen.has(it.id)) dup.add(it.id);
		seen.add(it.id);
	});
	return [...dup];
}


