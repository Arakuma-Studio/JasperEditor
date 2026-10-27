// Essential Graphics (docs/wp-notes/gaps.md §GR-4/GR-5). A GRAPHIC is a nested sequence flagged
// `Sequence.graphic`: its tracks are the graphic's layers (text, shapes, clips; the top track is the top layer), the
// nest clip on the timeline is the graphic clip. Everything a layer can do (fonts, animators, effects, keyframes)
// therefore works and renders on every path the nest does. The graphic adds, applied when a render snapshot is built
// (`applyGraphics`, so preview, stills and every export path agree):
// - Responsive Design – Time: a graphic clip longer or shorter than its graphic plays the Intro (first `intro` frames)
//   and the Outro (last `outro` frames) at their own speed and stretches the middle (a generated Time Remapping of the
//   nest clip);
// - Responsive Design – Position: a layer pinned to the video frame or to another layer keeps its edge offsets when
//   the frame or the other layer changes (a translation of the layer at render time; the stored values are the
//   layer's own);
// - Roll / Crawl: the graphic moves through the frame over the clip (Start Off Screen, End Off Screen, Pre-roll,
//   Ease-in, Ease-out, Post-roll, Premiere's options), as generated Position keys of the nest clip.
// Templates: `.jgt` files (Jasper Graphic Template, JSON) carry a graphic's frame, settings and layer clips
// (`graphicTemplateOf` / `graphic.importTemplate`).
import { z } from 'zod';
import { evaluate } from '../keyframes.ts';
import { layerMatrix, layerQuad, quadBounds, type Rect } from '../render/transform.ts';
import type { Animatable, Vec2 } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';

export * from './graphics-schema.ts';

import {
	type GraphicRoll,
	type GraphicSettings,
	GraphicSettingsSchema,
	type LayerPins,
	type PinEdge,
} from './graphics-schema.ts';

export const ALIGN_MODES = [
	'left',
	'center',
	'right',
	'top',
	'middle',
	'bottom',
	'distributeHorizontal',
	'distributeVertical',
] as const;
export type AlignMode = (typeof ALIGN_MODES)[number];

type Transformed = {
	transform?: {
		position: Animatable<Vec2>;
		anchor: Animatable<Vec2>;
		scale: Animatable<number>;
		scaleWidth: Animatable<number>;
		uniformScale: boolean;
		rotation: Animatable<number>;
		flipH: boolean;
		flipV: boolean;
	} | null;
};

/** Whether a sequence is a graphic. */
export const isGraphic = (seq: Pick<Sequence, 'graphic'> | undefined): boolean => !!seq && !!seq.graphic;

/** The settings of a graphic sequence (null for other sequences). */
export function graphicSettingsOf(seq: Pick<Sequence, 'graphic'> | undefined): GraphicSettings | null {
	const g = seq?.graphic;
	if (!g) return null;
	const p = GraphicSettingsSchema.safeParse(g);
	return p.success ? p.data : { intro: 0, outro: 0, roll: null };
}

/** The layers of a graphic, top first: its video clips with their track index (0 = V1). */
export function graphicLayers(seq: Sequence): { clip: Clip; track: number }[] {
	const order = new Map(seq.videoTracks.map((t, i) => [t.id, i]));
	return Object.values(seq.clips)
		.filter((c) => order.has(c.trackId))
		.map((clip) => ({ clip, track: order.get(clip.trackId)! }))
		.sort((a, b) => b.track - a.track || a.clip.start - b.clip.start);
}

/** The bounds (sequence px) of a layer at content time `t` (its Motion and box; null without Motion). */
export function layerBounds(clip: Clip, box: { width: number; height: number }, t = 0): Rect | null {
	const tr = (clip as Transformed).transform;
	if (!tr) return null;
	const v = {
		position: evaluate(tr.position, t) as Vec2,
		anchor: evaluate(tr.anchor, t) as Vec2,
		scale: evaluate(tr.scale, t) as number,
		scaleWidth: evaluate(tr.scaleWidth, t) as number,
		uniformScale: tr.uniformScale,
		rotation: evaluate(tr.rotation, t) as number,
		flipH: tr.flipH,
		flipV: tr.flipV,
	};
	return quadBounds(layerQuad(layerMatrix(v), { x: 0, y: 0, width: box.width, height: box.height }));
}

/**
 * The translations (px) that align or distribute layers. `rects` per layer; `to` = the frame rect (Align to Video
 * Frame) or null (align to the selection's bounds).
 */
export function alignOffsets(rects: readonly Rect[], mode: AlignMode, to: Rect | null): [number, number][] {
	if (!rects.length) return [];
	const sel = to ?? {
		x: Math.min(...rects.map((r) => r.x)),
		y: Math.min(...rects.map((r) => r.y)),
		width: Math.max(...rects.map((r) => r.x + r.width)) - Math.min(...rects.map((r) => r.x)),
		height: Math.max(...rects.map((r) => r.y + r.height)) - Math.min(...rects.map((r) => r.y)),
	};
	if (mode === 'distributeHorizontal' || mode === 'distributeVertical') {
		const h = mode === 'distributeHorizontal';
		const order = rects.map((r, i) => ({ r, i })).sort((a, b) => (h ? a.r.x - b.r.x : a.r.y - b.r.y));
		const out: [number, number][] = rects.map(() => [0, 0]);
		if (order.length < 3 && !to) return out;
		const total = order.reduce((s, o) => s + (h ? o.r.width : o.r.height), 0);
		const span = h ? sel.width : sel.height;
		const gap = order.length > 1 ? (span - total) / (order.length - 1) : 0;
		let cur = h ? sel.x : sel.y;
		for (const o of order) {
			const at = h ? o.r.x : o.r.y;
			out[o.i] = h ? [cur - at, 0] : [0, cur - at];
			cur += (h ? o.r.width : o.r.height) + gap;
		}
		return out;
	}
	return rects.map((r) => {
		switch (mode) {
			case 'left':
				return [sel.x - r.x, 0];
			case 'center':
				return [sel.x + sel.width / 2 - (r.x + r.width / 2), 0];
			case 'right':
				return [sel.x + sel.width - (r.x + r.width), 0];
			case 'top':
				return [0, sel.y - r.y];
			case 'middle':
				return [0, sel.y + sel.height / 2 - (r.y + r.height / 2)];
			default:
				return [0, sel.y + sel.height - (r.y + r.height)];
		}
	});
}

/** Edge coordinate of a rect. */
export const edgeOf = (r: Rect, e: PinEdge): number =>
	e === 'left' ? r.x : e === 'right' ? r.x + r.width : e === 'top' ? r.y : r.y + r.height;

/** The offsets of a layer's edges from a target's (what a pin stores). */
export function pinOffsets(
	layer: Rect,
	target: Rect,
	edges: readonly PinEdge[],
): Partial<Record<PinEdge, number>> {
	const out: Partial<Record<PinEdge, number>> = {};
	for (const e of edges) out[e] = edgeOf(layer, e) - edgeOf(target, e);
	return out;
}

/** The translation that restores a pinned layer's offsets (left / top win over right / bottom when both are set). */
export function pinTranslation(
	layer: Rect,
	target: Rect,
	pins: Partial<Record<PinEdge, number>>,
): [number, number] {
	let dx = 0;
	let dy = 0;
	if (pins.left !== undefined) dx = target.x + pins.left - layer.x;
	else if (pins.right !== undefined) dx = target.x + target.width + pins.right - (layer.x + layer.width);
	if (pins.top !== undefined) dy = target.y + pins.top - layer.y;
	else if (pins.bottom !== undefined) dy = target.y + target.height + pins.bottom - (layer.y + layer.height);
	return [dx, dy];
}

/** Graphic time (frames) shown at visible clip time `tau` (frames) with Intro / Outro protection. */
export function responsiveGraphicTime(
	tau: number,
	clipFrames: number,
	graphicFrames: number,
	intro: number,
	outro: number,
): number {
	const i = Math.max(0, Math.min(intro, clipFrames, graphicFrames));
	const o = Math.max(0, Math.min(outro, clipFrames - i, graphicFrames - i));
	if (tau <= i) return tau;
	if (tau >= clipFrames - o) return graphicFrames - (clipFrames - tau);
	const a = clipFrames - o - i;
	const b = graphicFrames - o - i;
	return a > 0 ? i + ((tau - i) * b) / a : i;
}

/** Position (sequence px) of a roll / crawl at visible frame `tau` of a `clipFrames` clip. */
export function rollPositionAt(
	roll: GraphicRoll,
	tau: number,
	clipFrames: number,
	frame: { width: number; height: number },
	graphic: { width: number; height: number },
	rest: Vec2,
	scale: number,
	anchor: Vec2,
): Vec2 {
	const s = scale / 100;
	const vertical = roll.mode === 'roll';
	const sign = roll.mode === 'crawlRight' ? -1 : 1;
	// Leading / trailing edge along the motion axis (y for roll, x for crawls).
	const ax = vertical ? 1 : 0;
	const size = vertical ? graphic.height : graphic.width;
	const fsize = vertical ? frame.height : frame.width;
	const a = anchor[ax];
	// Start: the graphic's leading edge (top / left) at the far edge (off screen) or at its rest position.
	const restC = rest[ax];
	const offStart = sign > 0 ? fsize + a * s : -(size - a) * s;
	const offEnd = sign > 0 ? -(size - a) * s : fsize + a * s;
	// Not off screen: a graphic taller (wider) than the frame starts with its leading edge on the frame edge and ends
	// with its trailing edge on the other one; a smaller one starts / ends at its rest position.
	const alignedStart = sign > 0 ? a * s : fsize - (size - a) * s;
	const alignedEnd = sign > 0 ? fsize - (size - a) * s : a * s;
	const start = roll.startOffScreen
		? offStart
		: sign > 0
			? Math.max(restC, alignedStart)
			: Math.min(restC, alignedStart);
	const end = roll.endOffScreen
		? offEnd
		: sign > 0
			? Math.min(restC, alignedEnd)
			: Math.max(restC, alignedEnd);
	const t0 = Math.min(roll.preRoll, clipFrames);
	const t1 = Math.max(t0, clipFrames - roll.postRoll);
	let u = t1 > t0 ? (tau - t0) / (t1 - t0) : tau >= t1 ? 1 : 0;
	u = Math.max(0, Math.min(1, u));
	// Ease-in / ease-out as fractions of the motion: a constant-acceleration ramp at each end.
	const ei = t1 > t0 ? Math.min(0.5, roll.easeIn / (t1 - t0)) : 0;
	const eo = t1 > t0 ? Math.min(0.5, roll.easeOut / (t1 - t0)) : 0;
	const v = 1 / (1 - ei / 2 - eo / 2);
	let p: number;
	if (u < ei) p = (v * u * u) / (2 * ei);
	else if (u > 1 - eo) {
		const r = 1 - u;
		p = 1 - (v * r * r) / (2 * eo);
	} else p = v * (u - ei / 2);
	const c = start + (end - start) * Math.max(0, Math.min(1, p));
	return vertical ? [rest[0], c] : [c, rest[1]];
}

const linearKey = (id: string, time: number, value: Vec2) => ({
	id,
	time: Math.round(time),
	value,
	interpolation: 'linear' as const,
	easeIn: { influence: 1 / 3, slope: 0 },
	easeOut: { influence: 1 / 3, slope: 0 },
	spatial: { mode: 'linear' as const, inTangent: [0, 0] as Vec2, outTangent: [0, 0] as Vec2 },
});

/** Box of a layer for bounds: the snapshot's intrinsic box rule (text box, shape box, media size, frame). */
type BoxOf = (clip: Clip, seq: Sequence) => { width: number; height: number };

/**
 * The document a render snapshot draws: graphic nest clips get their Responsive Time remap and Roll keys, pinned
 * layers their pin translation. Returns `doc` itself when there are no graphics (no copy).
 */
export function applyGraphics(doc: ProjectDocument, boxOf: BoxOf): ProjectDocument {
	const graphics = Object.values(doc.sequences).filter((s) => isGraphic(s));
	if (!graphics.length) return doc;
	const sequences: Record<string, Sequence> = { ...doc.sequences };
	// Pins inside graphics.
	for (const g of graphics) {
		let changed: Record<string, Clip> | null = null;
		const frameRect = { x: 0, y: 0, width: g.settings.width, height: g.settings.height };
		for (const c of Object.values(g.clips)) {
			const pins = (c as { pins?: LayerPins }).pins;
			if (!pins || !(c as Transformed).transform) continue;
			const own = layerBounds(c, boxOf(c, g));
			const tc = pins.target === 'frame' ? null : g.clips[pins.target];
			const target = pins.target === 'frame' ? frameRect : tc ? layerBounds(tc, boxOf(tc, g)) : null;
			if (!own || !target) continue;
			const [dx, dy] = pinTranslation(own, target, pins.edges);
			if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) continue;
			const tr = (c as Transformed).transform!;
			const shift = (p: Vec2): Vec2 => [p[0] + dx, p[1] + dy];
			changed ??= { ...g.clips };
			changed[c.id] = {
				...c,
				transform: {
					...tr,
					position: {
						...tr.position,
						value: shift(tr.position.value),
						keyframes: tr.position.keyframes.map((k) => ({ ...k, value: shift(k.value as Vec2) })),
					},
				},
			} as Clip;
		}
		if (changed) sequences[g.id] = { ...g, clips: changed };
	}
	// Graphic clips (nests of graphics) everywhere.
	for (const seq of Object.values(sequences)) {
		let changed: Record<string, Clip> | null = null;
		for (const c of Object.values(seq.clips)) {
			if (c.kind !== 'nest-video') continue;
			const g = sequences[(c as { sequenceId: string }).sequenceId];
			const set = graphicSettingsOf(g);
			if (!g || !set) continue;
			const rate = seq.settings.frameRate as Rational;
			const fpf = flicksPerFrame(rate);
			const gEnd = Math.max(1, ...Object.values(g.clips).map((x) => x.start + x.duration));
			// Graphic frames at the nest's rate (nested sequences share the outer frame grid here).
			const gRate = g.settings.frameRate as Rational;
			const gFrames = Math.round((gEnd * gRate.den * rate.num) / (gRate.num * rate.den));
			const D = c.duration;
			let next: Clip = c;
			const sp = c.speed?.rate ?? 1;
			const hasRemap = !!(c as { timeRemap?: { enabled?: boolean } }).timeRemap?.enabled;
			if (!hasRemap && sp === 1 && !c.speed?.reverse && D !== gFrames && (set.intro > 0 || set.outro > 0)) {
				const pts = [0, Math.min(set.intro, D), Math.max(0, D - set.outro), D];
				const uniq = [...new Set(pts)].sort((a, b) => a - b);
				next = {
					...next,
					timeRemap: {
						enabled: true,
						keyframes: uniq.map((tau, i) => ({
							id: `rt_${c.id}_${i}`,
							time: c.sourceIn + tau * fpf,
							source: responsiveGraphicTime(tau, D, gFrames, set.intro, set.outro) * fpf,
						})),
					},
				} as Clip;
			}
			const tr = (next as Transformed).transform;
			if (set.roll && tr) {
				const rest = evaluate(tr.position, c.sourceIn) as Vec2;
				const scale = evaluate(tr.scale, c.sourceIn) as number;
				const anchor = evaluate(tr.anchor, c.sourceIn) as Vec2;
				const frame = { width: seq.settings.width, height: seq.settings.height };
				const graphic = { width: g.settings.width, height: g.settings.height };
				const step = Math.max(1, Math.ceil(D / 2000));
				const keys = [];
				for (let tau = 0; tau <= D; tau += step) {
					const v = rollPositionAt(set.roll, Math.min(tau, D), D, frame, graphic, rest, scale, anchor);
					keys.push(linearKey(`roll_${c.id}_${tau}`, c.sourceIn + Math.min(tau, D) * fpf * sp, v));
				}
				next = {
					...next,
					transform: { ...tr, position: { ...tr.position, keyframes: keys, value: keys[0]!.value } },
				} as Clip;
			}
			if (next !== c) {
				changed ??= { ...seq.clips };
				changed[c.id] = next;
			}
		}
		if (changed) sequences[seq.id] = { ...seq, clips: changed };
	}
	return { ...doc, sequences };
}

export const GRAPHIC_TEMPLATE_FORMAT = 'jasper-graphic-template';
export const GRAPHIC_TEMPLATE_EXTENSION = '.jgt';

/**
 * A Jasper Graphic Template (`.jgt`, JSON): the graphic's sequence item as a `project-items` clipboard payload (the
 * graphic sequence with its layers, fonts and every media its layers use, by reference), plus a name and the frame.
 */
export const GraphicTemplateSchema = z.looseObject({
	format: z.literal(GRAPHIC_TEMPLATE_FORMAT),
	version: z.literal(1),
	name: z.string().min(1).max(255),
	frame: z.looseObject({ width: z.number().int().positive(), height: z.number().int().positive() }),
	payload: z.record(z.string(), z.unknown()),
});
export type GraphicTemplate = z.infer<typeof GraphicTemplateSchema>;

/** The `.jgt` template of a graphic sequence item. */
export function graphicTemplateOf(
	doc: ProjectDocument,
	itemId: string,
	name: string,
	build: (doc: ProjectDocument, itemIds: readonly string[]) => unknown,
): GraphicTemplate | null {
	const item = doc.items[itemId] as { kind?: string; sequenceId?: string } | undefined;
	const seq = item?.kind === 'sequence' ? doc.sequences[item.sequenceId!] : undefined;
	if (!seq || !isGraphic(seq)) return null;
	return {
		format: GRAPHIC_TEMPLATE_FORMAT,
		version: 1,
		name,
		frame: { width: seq.settings.width, height: seq.settings.height },
		payload: build(doc, [itemId]) as Record<string, unknown>,
	};
}
