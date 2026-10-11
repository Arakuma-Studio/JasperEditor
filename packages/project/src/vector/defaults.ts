// New shape items with After Effects' defaults (wp shapes) and the read-time defaults of optional fields.
// Sources: After Effects' Add ▸ menu defaults as documented by Adobe ("Shape attributes, paint operations, and path
// operations for shape layers"), the Lottie format's property set (lottie-docs) and EffectCraft's
// `crates/project/src/build.rs`; where Adobe documents no default the most plausible one is used (wp-note §Defaults).

import type { BezierPath } from '../path/model.ts';
import type { Animatable, RGBA, Vec2 } from '../schema/common.ts';
import type {
	ShapeItem,
	ShapeItemOf,
	ShapeItemType,
	ShapeTransform,
	StrokeDashes,
	StrokeTaper,
	StrokeWave,
} from '../schema/shapes.ts';
import { DEFAULT_GRADIENT, type GradientValue } from './values.ts';

export const a = <T>(value: T): Animatable<T> => ({ value, keyframes: [] });
const jsonClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const v2 = (x: number, y: number): Animatable<Vec2> => a<Vec2>([x, y]);

/** Display names of new items (After Effects' default names, numbered per clip). */
export const SHAPE_ITEM_LABELS: Record<ShapeItemType, string> = {
	group: 'Group',
	rect: 'Rectangle Path',
	ellipse: 'Ellipse Path',
	polystar: 'Polystar Path',
	path: 'Path',
	fill: 'Fill',
	stroke: 'Stroke',
	gradientFill: 'Gradient Fill',
	gradientStroke: 'Gradient Stroke',
	trim: 'Trim Paths',
	repeater: 'Repeater',
	offsetPaths: 'Offset Paths',
	roundCorners: 'Round Corners',
	zigZag: 'Zig Zag',
	twist: 'Twist',
	wiggle: 'Wiggle Paths',
	puckerBloat: 'Pucker & Bloat',
	mergePaths: 'Merge Paths',
};

export function defaultShapeTransform(): ShapeTransform {
	return {
		anchor: v2(0, 0),
		position: v2(0, 0),
		scale: v2(100, 100),
		skew: a(0),
		skewAxis: a(0),
		rotation: a(0),
		opacity: a(100),
	};
}

export function defaultDashes(): StrokeDashes {
	return { segments: [{ dash: a(10), gap: a(10) }], offset: a(0) };
}

export function defaultTaper(): StrokeTaper {
	return {
		units: 'percent',
		startLength: a(0),
		endLength: a(0),
		startWidth: a(0),
		endWidth: a(0),
		startEase: a(0),
		endEase: a(0),
	};
}

export function defaultWave(): StrokeWave {
	return { amount: a(0), units: 'pixels', wavelength: a(20), cycles: a(10), phase: a(0) };
}

export type NewItemOptions = {
	id: string;
	name?: string;
	/** Paint colour (fill / stroke). */
	color?: RGBA;
	/** Stroke width. */
	width?: number;
	/** Path value for `path` items. */
	path?: BezierPath;
	/** Initial gradient. */
	gradient?: GradientValue;
	/** Group contents. */
	contents?: ShapeItem[];
};

/** A new item of `type` with After Effects' defaults. */
export function newShapeItem<T extends ShapeItemType>(type: T, o: NewItemOptions): ShapeItemOf<T> {
	const base = { id: o.id, name: o.name ?? `${SHAPE_ITEM_LABELS[type]} 1` };
	const strokeStyle = {
		opacity: a(100),
		width: a(o.width ?? 2),
		lineCap: 'butt' as const,
		lineJoin: 'miter' as const,
		miterLimit: a(4),
	};
	const gradient = {
		gradientType: 'linear' as const,
		startPoint: v2(0, 0),
		endPoint: v2(100, 0),
		highlightLength: a(0),
		highlightAngle: a(0),
		colors: a<GradientValue>(jsonClone(o.gradient ?? DEFAULT_GRADIENT)),
	};
	let item: ShapeItem;
	switch (type) {
		case 'group':
			item = { ...base, type, contents: o.contents ?? [], transform: defaultShapeTransform() };
			break;
		case 'rect':
			item = { ...base, type, size: v2(100, 100), position: v2(0, 0), roundness: a(0) };
			break;
		case 'ellipse':
			item = { ...base, type, size: v2(100, 100), position: v2(0, 0) };
			break;
		case 'polystar':
			item = {
				...base,
				type,
				starType: 'star',
				points: a(5),
				position: v2(0, 0),
				rotation: a(0),
				innerRadius: a(50),
				outerRadius: a(100),
				innerRoundness: a(0),
				outerRoundness: a(0),
			};
			break;
		case 'path':
			item = {
				...base,
				type,
				path: a<BezierPath>(jsonClone(o.path ?? { closed: false, vertices: [] })),
			};
			break;
		case 'fill':
			item = { ...base, type, color: a<RGBA>([...(o.color ?? [1, 0, 0, 1])] as RGBA), opacity: a(100) };
			break;
		case 'stroke':
			item = { ...base, type, ...strokeStyle, color: a<RGBA>([...(o.color ?? [1, 1, 1, 1])] as RGBA) };
			break;
		case 'gradientFill':
			item = { ...base, type, opacity: a(100), ...gradient };
			break;
		case 'gradientStroke':
			item = { ...base, type, ...strokeStyle, ...gradient };
			break;
		case 'trim':
			item = { ...base, type, start: a(0), end: a(100), offset: a(0) };
			break;
		case 'repeater':
			item = {
				...base,
				type,
				copies: a(3),
				offset: a(0),
				transform: {
					anchor: v2(0, 0),
					position: v2(100, 0),
					scale: v2(100, 100),
					rotation: a(0),
					startOpacity: a(100),
					endOpacity: a(100),
				},
			};
			break;
		case 'offsetPaths':
			item = { ...base, type, amount: a(0), miterLimit: a(4), copies: a(1), copyOffset: a(0) };
			break;
		case 'roundCorners':
			item = { ...base, type, radius: a(10) };
			break;
		case 'zigZag':
			item = { ...base, type, size: a(10), ridges: a(5), points: 'corner' };
			break;
		case 'twist':
			item = { ...base, type, angle: a(0), center: v2(0, 0) };
			break;
		case 'wiggle':
			item = {
				...base,
				type,
				size: a(10),
				detail: a(10),
				points: 'smooth',
				speed: a(2),
				correlation: a(50),
				temporalPhase: a(0),
				spatialPhase: a(0),
				seed: a(0),
			};
			break;
		case 'puckerBloat':
			item = { ...base, type, amount: a(0) };
			break;
		case 'mergePaths':
			item = { ...base, type, mode: 'add' };
			break;
		default:
			throw new Error(`Unknown shape item type ${String(type)}`);
	}
	return item as ShapeItemOf<T>;
}

/** Depth-first walk (pre-order) with each item's parent group (null = top level) and index. */
export function walkItems(
	contents: readonly ShapeItem[],
	cb: (item: ShapeItem, parent: ShapeItemOf<'group'> | null, index: number, depth: number) => void,
	parent: ShapeItemOf<'group'> | null = null,
	depth = 0,
): void {
	contents.forEach((it, i) => {
		cb(it, parent, i, depth);
		if (it.type === 'group') walkItems(it.contents, cb, it, depth + 1);
	});
}

/** Finds an item by id: the item, the list holding it and its index, and the chain of group ids above it. */
export function findItem(
	contents: ShapeItem[],
	id: string,
	ancestors: string[] = [],
): { item: ShapeItem; list: ShapeItem[]; index: number; ancestors: string[] } | null {
	for (let i = 0; i < contents.length; i++) {
		const it = contents[i]!;
		if (it.id === id) return { item: it, list: contents, index: i, ancestors };
		if (it.type === 'group') {
			const r = findItem(it.contents, id, [...ancestors, it.id]);
			if (r) return r;
		}
	}
	return null;
}

/** Every item id in a tree. */
export function itemIds(contents: readonly ShapeItem[]): string[] {
	const out: string[] = [];
	walkItems(contents, (it) => out.push(it.id));
	return out;
}

/** Next free numbered name for a new item of `type` ("Fill 1", "Fill 2", …). */
export function nextItemName(contents: readonly ShapeItem[], type: ShapeItemType): string {
	const label = SHAPE_ITEM_LABELS[type];
	const used = new Set<string>();
	walkItems(contents, (it) => used.add(it.name));
	for (let n = 1; ; n++) if (!used.has(`${label} ${n}`)) return `${label} ${n}`;
}

/** Item ids are unique within their clip: a copy needs fresh ids. */
export function reidItems(items: ShapeItem[], next: () => string): ShapeItem[] {
	return items.map((it) => {
		const copy = { ...it, id: next() } as ShapeItem;
		if (copy.type === 'group') copy.contents = reidItems(copy.contents, next);
		return copy;
	});
}
