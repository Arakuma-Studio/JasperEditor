// Shape-layer contents at a time (wp shapes): the one evaluation of a vector shape's groups, paths, paints and
// operators, shared by the composition layer (SVG, so preview and export draw the same thing), the Program monitor
// (hit-testing, bounds, vertex editing) and tests. After Effects stacking semantics (port of EffectCraft's
// `crates/render/src/shapes.rs`, MIT OR Apache-2.0):
// - path operators act on every path above them in the same group, including the paths of nested groups;
// - paint items paint the paths above them *as modified by every operator in the stack* (a Trim Paths below a
//   Stroke still trims it): paints reference path slots that later operators rewrite in place;
// - items higher in the list draw on top; Composite "Above Previous in Same Group" lifts a paint over the paints
//   collected before it in its group (EffectCraft stores but ignores this flag);
// - Merge Paths replaces the paths above it with one merged path and drops the paints above it in its group;
// - Repeater copies everything above it (paths and paints) with a compounding transform and opacity ramp.
// Group opacity multiplies into its paints (After Effects applies it per paint); a group blend mode composites the
// group's paints together and blends the result (draws carry their blended-group chain).
import { evaluate, isAnimated } from '../keyframes.ts';
import type { BezierPath } from '../path/model.ts';
import type { Animatable, RGBA, Vec2 } from '../schema/common.ts';
import type {
	FillRuleValue,
	LineCapValue,
	LineJoinValue,
	ShapeBlendMode,
	ShapeItem,
	ShapeItemOf,
	ShapeTransform,
	StrokePositionValue,
} from '../schema/shapes.ts';
import { FLICKS_PER_SECOND } from '../time.ts';
import {
	type Affine,
	apply,
	type BezPath,
	type Bounds,
	compose,
	distanceTo,
	IDENTITY,
	invert,
	meanScale,
	pathBounds,
	reversePath,
	rotateDeg,
	scale,
	skewDeg,
	transformPath,
	translate,
	unionBounds,
	windingAt,
} from './geom.ts';
import {
	merge,
	offset,
	puckerBloat,
	roundCorners,
	trim,
	trimIndividually,
	twist,
	wiggle,
	zigzag,
} from './ops.ts';
import { ellipseShapePath, polystarShapePath, rectShapePath } from './primitives.ts';
import { bezierPathToBez, type GradientValue } from './values.ts';
import { type Taper, varStrokeOutline, type Wave } from './varstroke.ts';

export type ShapePaint =
	| { type: 'solid'; color: RGBA }
	| {
			type: 'linear' | 'radial';
			start: Vec2;
			end: Vec2;
			/** Radial: focal offset (−100…100 % of the radius) and angle (degrees from the start→end axis). */
			highlightLength: number;
			highlightAngle: number;
			gradient: GradientValue;
	  };

export type ShapeStrokeStyle = {
	width: number;
	cap: LineCapValue;
	join: LineJoinValue;
	miterLimit: number;
	/** Dash pattern (dash, gap, …) and offset, or null for a solid stroke. */
	dash: { pattern: number[]; offset: number } | null;
	taper: Taper | null;
	wave: Wave | null;
	position: StrokePositionValue;
};

/** One paint operation. Draw lists run top-most first (index 0 is painted last, over the others). */
export type ShapeDraw = {
	/** The paint item that produced it. */
	itemId: string;
	kind: 'fill' | 'stroke';
	paint: ShapePaint;
	/** Geometry in content space (layer pixels, origin = layer centre). */
	paths: BezPath;
	/** Paint-group space → content space (gradients and strokes are drawn in paint-group space). */
	xf: Affine;
	/** 0…1 (item opacity × group opacities × repeater ramp). */
	opacity: number;
	blend: ShapeBlendMode;
	fillRule: FillRuleValue;
	stroke: ShapeStrokeStyle | null;
	/**
	 * Enclosing groups with a blend mode other than Normal, outermost first: the draws of one group instance are
	 * composited together (isolated) and the result blends with what is below (`key` tells repeated copies apart).
	 */
	groups: { key: string; blend: ShapeBlendMode }[];
};

export type EvalOptions = {
	/** Content time in flicks (keyframes and Wiggle Paths). */
	time: number;
};

const num = (x: Animatable<number> | undefined, t: number, d: number) => {
	if (!x) return d;
	const v = evaluate(x, t);
	return Number.isFinite(v) ? v : d;
};
const vec = (x: Animatable<Vec2> | undefined, t: number, d: Vec2): Vec2 => {
	if (!x) return d;
	const v = evaluate(x, t);
	return Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1]) ? [v[0], v[1]] : d;
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Group transform → matrix: translate(position) · rotate · skew · scale · translate(−anchor). */
export function shapeTransformMatrix(tr: ShapeTransform, t: number): { m: Affine; opacity: number } {
	const anchor = vec(tr.anchor, t, [0, 0]);
	const pos = vec(tr.position, t, [0, 0]);
	const sc = vec(tr.scale, t, [100, 100]);
	const m = compose(
		translate(pos[0], pos[1]),
		compose(
			rotateDeg(num(tr.rotation, t, 0)),
			compose(
				skewDeg(-num(tr.skew, t, 0), num(tr.skewAxis, t, 0)),
				compose(scale(sc[0] / 100, sc[1] / 100), translate(-anchor[0], -anchor[1])),
			),
		),
	);
	return { m, opacity: clamp01(num(tr.opacity, t, 100) / 100) };
}

function strokeStyle(it: ShapeItemOf<'stroke'> | ShapeItemOf<'gradientStroke'>, t: number): ShapeStrokeStyle {
	let dash: ShapeStrokeStyle['dash'] = null;
	const d = it.dashes;
	if (d?.segments.length) {
		const pattern: number[] = [];
		for (const s of d.segments) {
			const dv = Math.max(0, num(s.dash, t, 0));
			const gv = Math.max(0, num(s.gap, t, dv));
			pattern.push(dv, gv);
		}
		if (pattern.some((x) => x > 0) && pattern.reduce((x, y) => x + y, 0) > 1e-6)
			dash = { pattern, offset: num(d.offset, t, 0) };
	}
	let taper: Taper | null = null;
	if (it.taper) {
		const pct = it.taper.units === 'percent';
		const L = (x: Animatable<number>) => Math.max(0, num(x, t, 0)) / (pct ? 100 : 1);
		taper = {
			percent: pct,
			startLength: L(it.taper.startLength),
			endLength: L(it.taper.endLength),
			startWidth: clamp01(num(it.taper.startWidth, t, 0) / 100),
			endWidth: clamp01(num(it.taper.endWidth, t, 0) / 100),
			startEase: clamp01(num(it.taper.startEase, t, 0) / 100),
			endEase: clamp01(num(it.taper.endEase, t, 0) / 100),
		};
	}
	let wave: Wave | null = null;
	if (it.wave) {
		wave = {
			amount: clamp01(num(it.wave.amount, t, 0) / 100),
			cycles: it.wave.units === 'cycles' ? Math.max(0, num(it.wave.cycles, t, 10)) : null,
			wavelength: Math.max(0, num(it.wave.wavelength, t, 20)),
			phase: num(it.wave.phase, t, 0),
		};
	}
	return {
		width: Math.max(0, num(it.width, t, 2)),
		cap: it.lineCap ?? 'butt',
		join: it.lineJoin ?? 'miter',
		miterLimit: Math.max(1, num(it.miterLimit, t, 4)),
		dash,
		taper,
		wave,
		position: it.position ?? 'center',
	};
}

function gradientPaint(
	it: ShapeItemOf<'gradientFill'> | ShapeItemOf<'gradientStroke'>,
	t: number,
): ShapePaint {
	return {
		type: it.gradientType === 'radial' ? 'radial' : 'linear',
		start: vec(it.startPoint, t, [0, 0]),
		end: vec(it.endPoint, t, [100, 0]),
		highlightLength: Math.max(-100, Math.min(100, num(it.highlightLength, t, 0))),
		highlightAngle: num(it.highlightAngle, t, 0),
		gradient: evaluate(it.colors, t),
	};
}

type Ctx = { t: number; seconds: number; arena: BezPath[] };
type Collected = { draws: (ShapeDraw & { slots: number[] })[]; live: number[] };

function usedSlots(live: number[], draws: { slots: number[] }[]): number[] {
	return [...new Set([...live, ...draws.flatMap((d) => d.slots)])].sort((x, y) => x - y);
}

function applyOp(ctx: Ctx, live: number[], f: (p: BezPath[]) => BezPath[]): void {
	const out = f(live.map((i) => ctx.arena[i]!));
	live.forEach((slot, k) => {
		ctx.arena[slot] = out[k] ?? [];
	});
}

function pushPath(ctx: Ctx, live: number[], p: BezPath, reversed: boolean): void {
	ctx.arena.push(reversed ? reversePath(p) : p);
	live.push(ctx.arena.length - 1);
}

function collect(ctx: Ctx, contents: readonly ShapeItem[]): Collected {
	const t = ctx.t;
	let draws: Collected['draws'] = [];
	let live: number[] = [];
	const addDraw = (d: Collected['draws'][number], above: boolean) => {
		if (above) draws.unshift(d);
		else draws.push(d);
	};
	for (const it of contents) {
		if (it.enabled === false) continue;
		switch (it.type) {
			case 'rect': {
				const p = rectShapePath(
					vec(it.size, t, [100, 100]),
					vec(it.position, t, [0, 0]),
					num(it.roundness, t, 0),
				);
				pushPath(ctx, live, p, it.direction === 'reversed');
				break;
			}
			case 'ellipse':
				pushPath(
					ctx,
					live,
					ellipseShapePath(vec(it.size, t, [100, 100]), vec(it.position, t, [0, 0])),
					it.direction === 'reversed',
				);
				break;
			case 'polystar':
				pushPath(
					ctx,
					live,
					polystarShapePath({
						star: it.starType !== 'polygon',
						points: num(it.points, t, 5),
						position: vec(it.position, t, [0, 0]),
						rotation: num(it.rotation, t, 0),
						innerRadius: num(it.innerRadius, t, 50),
						outerRadius: num(it.outerRadius, t, 100),
						innerRoundness: num(it.innerRoundness, t, 0),
						outerRoundness: num(it.outerRoundness, t, 0),
					}),
					it.direction === 'reversed',
				);
				break;
			case 'path': {
				const v = evaluate(it.path, t) as BezierPath;
				pushPath(ctx, live, bezierPathToBez(v), it.direction === 'reversed');
				break;
			}
			case 'fill':
			case 'gradientFill': {
				const paint: ShapePaint =
					it.type === 'fill' ? { type: 'solid', color: evaluate(it.color, t) } : gradientPaint(it, t);
				addDraw(
					{
						itemId: it.id,
						kind: 'fill',
						paint,
						paths: [],
						slots: [...live],
						xf: IDENTITY,
						opacity: clamp01(num(it.opacity, t, 100) / 100),
						blend: it.blendMode ?? 'normal',
						fillRule: it.fillRule ?? 'nonzero',
						stroke: null,
						groups: [],
					},
					it.composite === 'above',
				);
				break;
			}
			case 'stroke':
			case 'gradientStroke': {
				const paint: ShapePaint =
					it.type === 'stroke' ? { type: 'solid', color: evaluate(it.color, t) } : gradientPaint(it, t);
				addDraw(
					{
						itemId: it.id,
						kind: 'stroke',
						paint,
						paths: [],
						slots: [...live],
						xf: IDENTITY,
						opacity: clamp01(num(it.opacity, t, 100) / 100),
						blend: it.blendMode ?? 'normal',
						fillRule: 'nonzero',
						stroke: strokeStyle(it, t),
						groups: [],
					},
					it.composite === 'above',
				);
				break;
			}
			case 'trim': {
				const s = num(it.start, t, 0);
				const e = num(it.end, t, 100);
				const o = num(it.offset, t, 0);
				applyOp(ctx, live, (p) =>
					it.mode === 'individual' ? trimIndividually(p, s, e, o) : trim(p, s, e, o),
				);
				break;
			}
			case 'puckerBloat': {
				const amt = num(it.amount, t, 0);
				applyOp(ctx, live, (p) => puckerBloat(p, amt));
				break;
			}
			case 'roundCorners': {
				const r = num(it.radius, t, 10);
				applyOp(ctx, live, (p) => roundCorners(p, r));
				break;
			}
			case 'offsetPaths': {
				const amount = num(it.amount, t, 0);
				const miter = num(it.miterLimit, t, 4);
				const copies = num(it.copies, t, 1);
				const copyOffset = num(it.copyOffset, t, 0);
				applyOp(ctx, live, (p) => offset(p, amount, it.lineJoin ?? 'miter', miter, copies, copyOffset));
				break;
			}
			case 'twist': {
				const ang = num(it.angle, t, 0);
				const c = vec(it.center, t, [0, 0]);
				applyOp(ctx, live, (p) => twist(p, ang, c));
				break;
			}
			case 'zigZag': {
				const size = num(it.size, t, 10);
				const ridges = num(it.ridges, t, 5);
				applyOp(ctx, live, (p) => zigzag(p, size, ridges, it.points === 'smooth'));
				break;
			}
			case 'wiggle': {
				const w = {
					size: num(it.size, t, 10),
					detail: num(it.detail, t, 10),
					smooth: it.points !== 'corner',
					speed: num(it.speed, t, 2),
					correlation: num(it.correlation, t, 50),
					temporalPhase: num(it.temporalPhase, t, 0),
					spatialPhase: num(it.spatialPhase, t, 0),
					seed: num(it.seed, t, 0),
				};
				applyOp(ctx, live, (p) => wiggle(p, w, ctx.seconds));
				break;
			}
			case 'mergePaths': {
				const merged = merge(
					live.map((i) => ctx.arena[i]!),
					it.mode,
				);
				ctx.arena.push(merged);
				live = [ctx.arena.length - 1];
				// As in After Effects, paints above a Merge Paths in its group are not rendered: the merged path is
				// painted by the paints below it.
				draws = [];
				break;
			}
			case 'group': {
				const inner = collect(ctx, it.contents);
				const { m, opacity } = shapeTransformMatrix(it.transform, t);
				for (const i of usedSlots(inner.live, inner.draws)) ctx.arena[i] = transformPath(ctx.arena[i]!, m);
				for (const d of inner.draws) {
					d.xf = compose(m, d.xf);
					d.opacity *= opacity;
					if (it.blendMode && it.blendMode !== 'normal')
						d.groups = [{ key: it.id, blend: it.blendMode }, ...d.groups];
					draws.push(d);
				}
				live.push(...inner.live);
				break;
			}
			case 'repeater': {
				const copies = Math.max(0, num(it.copies, t, 3));
				const off = num(it.offset, t, 0);
				const n = Math.min(1000, Math.ceil(copies));
				const tr = it.transform;
				const anchor = vec(tr.anchor, t, [0, 0]);
				const pos = vec(tr.position, t, [100, 0]);
				const sc = vec(tr.scale, t, [100, 100]);
				const rot = num(tr.rotation, t, 0);
				const so = clamp01(num(tr.startOpacity, t, 100) / 100);
				const eo = clamp01(num(tr.endOpacity, t, 100) / 100);
				const step = (k: number): Affine =>
					compose(
						translate(pos[0] * k, pos[1] * k),
						compose(
							translate(anchor[0], anchor[1]),
							compose(
								rotateDeg(rot * k),
								compose(
									scale(
										Math.sign(sc[0]) * Math.abs(sc[0] / 100) ** k,
										Math.sign(sc[1]) * Math.abs(sc[1] / 100) ** k,
									),
									translate(-anchor[0], -anchor[1]),
								),
							),
						),
					);
				const baseDraws = draws;
				const baseLive = live;
				const baseSlots = usedSlots(baseLive, baseDraws);
				draws = [];
				live = [];
				// Each copy gets its own transformed slots, so operators below the repeater act on the repeated
				// geometry (copy order: original first).
				const maps: Map<number, number>[] = [];
				for (let i = 0; i < n; i++) {
					const m = step(i + off);
					const map = new Map<number, number>();
					for (const s of baseSlots) {
						ctx.arena.push(transformPath(ctx.arena[s]!, m));
						map.set(s, ctx.arena.length - 1);
					}
					live.push(...baseLive.map((s) => map.get(s)!));
					maps.push(map);
				}
				const order = [...Array(n).keys()];
				// Draw lists run top first. Below (After Effects' default): each copy under the previous one, so the
				// original is on top; Above: each copy over the previous one. (EffectCraft has these swapped.)
				if (it.composite === 'above') order.reverse();
				for (const i of order) {
					const m = step(i + off);
					const ramp = n > 1 ? i / (n - 1) : 0;
					const opk = so + (eo - so) * ramp;
					const partial = i + 1 === n && copies % 1 > 0 ? copies % 1 : 1;
					for (const d of baseDraws)
						draws.push({
							...d,
							slots: d.slots.map((s) => maps[i]!.get(s)!),
							xf: compose(m, d.xf),
							opacity: d.opacity * opk * partial,
							groups: d.groups.map((g) => ({ key: `${g.key}/${it.id}:${i}`, blend: g.blend })),
						});
				}
				break;
			}
		}
	}
	return { draws, live };
}

/**
 * The draws of a vector shape at content time `t` (flicks), top-most first. Geometry in content space (origin = the
 * layer box centre); empty and fully transparent draws are dropped.
 */
export function evaluateVectorShape(contents: readonly ShapeItem[], t: number): ShapeDraw[] {
	const ctx: Ctx = { t, seconds: t / FLICKS_PER_SECOND, arena: [] };
	const { draws } = collect(ctx, contents);
	const out: ShapeDraw[] = [];
	for (const { slots, ...d } of draws) {
		if (!(d.opacity > 0)) continue;
		const paths = slots.flatMap((i) => ctx.arena[i] ?? []).filter((sp) => sp.segs.length > 0);
		if (!paths.length) continue;
		if (d.kind === 'stroke' && !(d.stroke!.width > 0)) continue;
		out.push({ ...d, paths });
	}
	return out;
}

/** The paths of a draw in its paint-group space (what the renderer strokes/fills inside `xf`). */
export function drawLocalPaths(d: ShapeDraw): BezPath | null {
	if (d.xf === IDENTITY) return d.paths;
	const inv = invert(d.xf);
	return inv ? transformPath(d.paths, inv) : null;
}

/** True when a stroke needs a variable-width outline (taper or wave active). */
export function strokeIsVariable(s: ShapeStrokeStyle): boolean {
	const t = s.taper;
	const w = s.wave;
	return (
		(!!t && ((t.startLength > 0 && t.startWidth < 1) || (t.endLength > 0 && t.endWidth < 1))) ||
		(!!w && w.amount > 0 && (w.cycles === null ? w.wavelength > 0 : w.cycles > 0))
	);
}

/**
 * The fill outline of a variable-width stroke in paint-group space (non-zero), the stroke width doubled for
 * inside / outside strokes (the renderer clips the half that does not show). `resScale` = device px per unit.
 */
export function variableStrokeOutline(d: ShapeDraw, resScale: number): BezPath {
	const s = d.stroke!;
	const local = drawLocalPaths(d);
	if (!local) return [];
	return varStrokeOutline(
		local,
		{
			width: s.position === 'center' ? s.width : s.width * 2,
			cap: s.cap,
			dash: s.dash,
			taper: s.taper,
			wave: s.wave,
		},
		resScale * meanScale(d.xf),
	);
}

/** Content-space bounds of what a draw can touch (stroke width, miters and anti-aliasing included). */
export function drawBounds(d: ShapeDraw): Bounds | null {
	const b = pathBounds(d.paths);
	if (!b) return null;
	const s = d.stroke;
	const half = s ? (s.position === 'outside' ? s.width : s.position === 'inside' ? 0 : s.width / 2) : 0;
	const grow = s
		? half * (s.join === 'miter' ? Math.max(1, s.miterLimit) : 1) * Math.max(1, meanScale(d.xf)) + 1
		: 1;
	return { x0: b.x0 - grow, y0: b.y0 - grow, x1: b.x1 + grow, y1: b.y1 + grow };
}

/** Content-space bounds of all draws (null when nothing draws). */
export function vectorShapeBounds(draws: readonly ShapeDraw[]): Bounds | null {
	let b: Bounds | null = null;
	for (const d of draws) b = unionBounds(b, drawBounds(d));
	return b;
}

/** True when a content-space point lies on a draw (fill area under its rule, or within the stroke band). */
export function vectorShapeContainsPoint(draws: readonly ShapeDraw[], p: Vec2, slop = 0): boolean {
	for (const d of draws) {
		if (d.kind === 'fill') {
			const w = windingAt(d.paths, p);
			if (d.fillRule === 'evenodd' ? w % 2 !== 0 : w !== 0) return true;
			if (slop > 0 && distanceTo(d.paths, p) <= slop) return true;
			continue;
		}
		const s = d.stroke!;
		const local = drawLocalPaths(d);
		const inv = invert(d.xf);
		if (!local || !inv) continue;
		const q = apply(inv, p);
		const dd = distanceTo(local, q) - slop / Math.max(1e-6, meanScale(d.xf));
		const inside = windingAt(local, q) !== 0;
		const reach = s.position === 'center' ? s.width / 2 : s.width;
		if (dd <= reach && (s.position === 'center' || (s.position === 'inside') === inside)) return true;
	}
	return false;
}

/**
 * Whether the shape changes over time: any Animatable in the tree keyframed or driven by an active expression, or
 * an enabled Wiggle Paths that moves on its own (Wiggles/Second ≠ 0).
 */
export function vectorShapeIsTimeDependent(contents: readonly ShapeItem[]): boolean {
	const keyed = (v: unknown): boolean => {
		if (!v || typeof v !== 'object') return false;
		if (Array.isArray(v)) return v.some(keyed);
		const o = v as Record<string, unknown>;
		if (Array.isArray(o.keyframes) && 'value' in o) return isAnimated(o as never);
		return Object.values(o).some(keyed);
	};
	let dep = false;
	const visit = (items: readonly ShapeItem[]) => {
		for (const it of items) {
			if (dep) return;
			if (keyed(it)) dep = true;
			else if (
				it.type === 'wiggle' &&
				it.enabled !== false &&
				(it.speed.value !== 0 || it.speed.keyframes.length)
			)
				dep = true;
			else if (it.type === 'group') visit(it.contents);
		}
	};
	visit(contents);
	return dep;
}

/**
 * Item space → content space at time `t`: the product of the transforms of the groups enclosing `itemId` (null when
 * the item is not in the tree). Content space has its origin at the layer box centre.
 */
export function shapeItemMatrix(contents: readonly ShapeItem[], itemId: string, t: number): Affine | null {
	const walk = (items: readonly ShapeItem[], m: Affine): Affine | null => {
		for (const it of items) {
			if (it.id === itemId) return m;
			if (it.type === 'group') {
				const r = walk(it.contents, compose(m, shapeTransformMatrix(it.transform, t).m));
				if (r) return r;
			}
		}
		return null;
	};
	return walk(contents, IDENTITY);
}

/** The path items of a tree with their item → content matrices and evaluated paths (vertex editing). */
export function shapePathItemsAt(
	contents: readonly ShapeItem[],
	t: number,
): { item: ShapeItemOf<'path'>; m: Affine; path: BezierPath }[] {
	const out: { item: ShapeItemOf<'path'>; m: Affine; path: BezierPath }[] = [];
	const walk = (items: readonly ShapeItem[], m: Affine) => {
		for (const it of items) {
			if (it.enabled === false) continue;
			if (it.type === 'path') out.push({ item: it, m, path: evaluate(it.path, t) as BezierPath });
			if (it.type === 'group') walk(it.contents, compose(m, shapeTransformMatrix(it.transform, t).m));
		}
	};
	walk(contents, IDENTITY);
	return out;
}
