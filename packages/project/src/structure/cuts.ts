// Cut map (spec 13 §2 SH-001; docs/wp-notes/auto-subtitles.md "Cut map"): every frame of a sequence where the picture
// the viewer sees changes — a cut to another source, a jump cut inside one source, or an overlay covering at least
// `overlayCoverage` of the frame coming or going. Pure; shared by cut-aware subtitles (spec 13), transcript cleanup
// (spec 14) and editing-pattern automation (spec 15). MCP `list_cuts`.
//
// Model (per frame, below the optional output track, top track first):
// - Picture layers are the enabled clips of shown video tracks that draw a picture of a source: video, still,
//   animated-image, solid (not Transparent Video) and nest-video. Text, shapes, captions, adjustment layers, motion
//   graphics, compositions, 3D models, cameras and lights are graphics or draw nothing of a source: never layers.
// - Nest clips are followed (depth ≤ MAX_CUT_MAP_NEST_DEPTH, cycles detected) exactly as the renderer draws them: the
//   multi-camera angle, the nested sequence conformed to this rate, the nested frame `floor(pictureTime / F + 1e-6)`
//   (speed, reverse, frame hold and time remap included); their layers are flattened into the stack with the nest
//   clip's Motion, Crop, corner pin and opacity applied and its visible quad as a clipping window.
// - A layer's coverage = area(its visible quad — Motion, Crop windows, corner pin — ∩ every enclosing window ∩ the
//   frame) / frame area. Layers covering less than `overlayCoverage` are ignored. A layer is opaque-full when it
//   covers the frame (≥ FULL_FRAME_COVERAGE), its opacity (times its nests') is ≥ 99.5 % and nothing can make it
//   see-through (blend mode, masks, 3D, alpha media, a translucent matte, keying / distortion / Transform effects):
//   layers below it are hidden.
// - The base picture = the topmost opaque-full layer, else the topmost layer covering the frame, else the layer with
//   the largest coverage; every other kept layer is an overlay.
// - An event at frame f compares f − 1 with f: the base changes to another source (or to / from nothing) = 'cut';
//   to the same source discontinuously = 'jump'; overlays enter or leave, or the base reshuffles with a layer that
//   stays visible = 'overlay'. Continuity = same layer, or same source showing the content that continues (within half
//   a source step, any speed — through edits, frame-hold resumes and speed changes are not cuts). A fade to / from
//   black (a one-sided transition at that edge, or opacity ≤ 5 %) is not a cut; a one-sided transition never makes
//   a zone. A two-sided transition between the outgoing and incoming clips adds its id and its span as `zone`.
// - Frames are reported in (0, sequence duration) ∩ range, at most one entry per frame, sorted.
import { z } from 'zod';
import { clipAt, clipEnd, clipsInRange, sequenceDuration } from '../derive/index.ts';
import { mediaAlpha } from '../interpret/model.ts';
import { evaluate, isAnimated } from '../keyframes.ts';
import { multicamView } from '../multicam/model.ts';
import { defaultEffectRegistry, evaluateEffectParam } from '../registry/effects.ts';
import { intrinsicBoxOf } from '../registry/properties.ts';
import { cropWindow } from '../render/crop.ts';
import { applyMat3, boxToQuad, type Mat3, mat3FromMat2D, multiplyMat3 } from '../render/homography.ts';
import {
	CORNER_PIN_EFFECT_ID,
	clipContentTime,
	cornerPinQuad,
	type ResolvedEffect,
} from '../render/scene.ts';
import { IDENTITY, layerMatrix, visibleRect } from '../render/transform.ts';
import type { Animatable, ParamValue, Vec2 } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence, Track, Transition } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational, rationalEquals } from '../time.ts';
import { clipMediaTimeFn } from '../time-remap/model.ts';
import { transitionSpan } from '../transitions.ts';
import { conformSequenceRate } from './nest.ts';
import { SYNTHETIC_INFO } from './synthetic.ts';

export const CUT_KINDS = ['cut', 'jump', 'overlay'] as const;
export type CutKind = (typeof CUT_KINDS)[number];

/** Deepest nesting followed (spec 13 SH-001); deeper nest clips count as one picture each (warning `nest-depth`). */
export const MAX_CUT_MAP_NEST_DEPTH = 8;
/** Coverage from which a layer counts as covering the whole frame (≈ 2,000 px² short of 1920×1080). */
export const FULL_FRAME_COVERAGE = 0.999;
/** Opacity (0…1) from which a full-frame layer hides the layers below it. */
const OPAQUE = 0.995;
/** A picture at most this opaque fading to / from nothing is not a cut. */
const FADED = 0.05;
/** Frames evaluated one by one for animated Motion / Opacity / Crop / corner pin over a whole call. */
export const MAX_CUT_MAP_DENSE_FRAMES = 250_000;
/** Nest frames mapped (per frame of every followed nest clip) over a whole call. */
export const MAX_CUT_MAP_NEST_WORK = 4_000_000;

export const CUT_MAP_DEFAULTS = {
	overlayCoverage: 0.5,
	includeJumpCuts: true,
	includeOverlays: true,
} as const;

/** Options of `pictureCuts` (strict: unknown keys are refused). */
export const CutMapOptionsSchema = z.strictObject({
	/** Only tracks below this one count (the subtitles' own track); a caption track = every video track. */
	outputTrackId: z.string().min(1).optional(),
	/** Only these video tracks count (ids), still below `outputTrackId`. */
	trackIds: z.array(z.string().min(1)).max(1000).optional(),
	/** Fraction of the frame an overlay must cover (0.01…1, default 0.5). */
	overlayCoverage: z.number().min(0.01).max(1).optional(),
	/** Report jump cuts (same source, discontinuous; default true). */
	includeJumpCuts: z.boolean().optional(),
	/** Report overlays coming and going (default true). */
	includeOverlays: z.boolean().optional(),
	/** Sequence frames `[start, end)` to report. */
	range: z
		.strictObject({ start: z.number().int().min(0), end: z.number().int().min(0) })
		.refine((r) => r.end >= r.start, 'range.end must not be before range.start')
		.optional(),
});
export type CutMapOptions = z.input<typeof CutMapOptionsSchema>;

/** A clip inside a nested sequence: its sequence, its id and the nest clips leading to it from the queried sequence. */
export type NestedClipRef = { sequenceId: string; clipId: string; nestPath: string[] };

export type PictureCut = {
	/** First frame of the new picture (sequence frames). */
	frame: number;
	kind: CutKind;
	/** Track (of the queried sequence) of the incoming picture, else of the outgoing one. */
	trackId: string;
	/** Clip of the queried sequence shown before the cut (a nest clip when the picture is inside a nest). */
	outgoingClipId?: string;
	/** Clip of the queried sequence shown from the cut on. */
	incomingClipId?: string;
	/** Two-sided transition of the queried sequence at this edit point. */
	transitionId?: string;
	/** The transition's span `[start, end)` in sequence frames (a cut zone). */
	zone?: { start: number; end: number };
	/** Present when either side (or the transition) is inside a nested sequence. */
	nested?: {
		outgoing?: NestedClipRef;
		incoming?: NestedClipRef;
		transition?: { sequenceId: string; transitionId: string; nestPath: string[] };
	};
};

export type CutMapWarningCode =
	| 'nest-missing'
	| 'nest-cycle'
	| 'nest-depth'
	| 'sampled'
	| 'nest-work-limit'
	| 'unreadable-clip';
export type CutMapWarning = { code: CutMapWarningCode; message: string; clipId?: string };

export type CutMapResult = {
	sequenceId: string;
	cuts: PictureCut[];
	warnings: CutMapWarning[];
	/** Video tracks considered, top first. */
	trackIds: string[];
	/** Sequence duration (frames). */
	duration: number;
	/** Frames analysed `[start, end)`. */
	range: { start: number; end: number };
};

/** A refused query (missing sequence or track, invalid options). */
export class CutMapError extends Error {
	constructor(
		readonly code: 'E_NOT_FOUND' | 'E_INVALID_PARAM',
		message: string,
	) {
		super(message);
		this.name = 'CutMapError';
	}
}

/** The picture cuts of a sequence (see the file comment); throws `CutMapError` for a missing sequence / track. */
export function pictureCuts(
	doc: ProjectDocument,
	sequenceId: string,
	opts: CutMapOptions = {},
): PictureCut[] {
	return analyzePictureCuts(doc, sequenceId, opts).cuts;
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry

type P = Vec2;

function signedArea(poly: readonly P[]): number {
	let s = 0;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i]!;
		const b = poly[(i + 1) % poly.length]!;
		s += a[0] * b[1] - b[0] * a[1];
	}
	return s / 2;
}

/** `subject ∩ clip` for convex polygons (Sutherland–Hodgman); [] when they do not overlap or one is degenerate. */
function clipConvexPolygon(subject: readonly P[], clip: readonly P[]): P[] {
	const orient = Math.sign(signedArea(clip));
	if (!orient || subject.length < 3) return [];
	let out: P[] = subject as P[];
	for (let i = 0; i < clip.length && out.length; i++) {
		const a = clip[i]!;
		const b = clip[(i + 1) % clip.length]!;
		const ex = (b[0] - a[0]) * orient;
		const ey = (b[1] - a[1]) * orient;
		const input = out;
		let inside = true;
		for (const p of input) if (ex * (p[1] - a[1]) - ey * (p[0] - a[0]) < 0) inside = false;
		if (inside) continue; // the whole polygon is on the inner side of this edge
		out = [];
		for (let j = 0; j < input.length; j++) {
			const p = input[j]!;
			const q = input[(j + 1) % input.length]!;
			const sp = ex * (p[1] - a[1]) - ey * (p[0] - a[0]);
			const sq = ex * (q[1] - a[1]) - ey * (q[0] - a[0]);
			if (sp >= 0) out.push(p);
			if (sp >= 0 !== sq >= 0) {
				const t = sp / (sp - sq);
				out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
			}
		}
	}
	return out.length >= 3 ? out : [];
}

const polygonArea = (poly: readonly P[]) => Math.abs(signedArea(poly));
const finitePoly = (poly: readonly P[]) => poly.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));

// ---------------------------------------------------------------------------------------------------------------
// Context

/** The picture of a clip in its own sequence at one frame: its layer map, visible quad, opacity. */
type Geo = { map: Mat3; quad: P[]; opacity: number };

type SeqTransitions = { pairs: Map<string, Transition>; head: Set<string>; tail: Set<string> };

type Ctx = {
	doc: ProjectDocument;
	rate: Rational;
	F: number;
	framePoly: P[];
	frameArea: number;
	overlayCoverage: number;
	includeJumpCuts: boolean;
	includeOverlays: boolean;
	views: Map<string, Sequence | null>;
	geo: Map<Clip, Geo | null>;
	boxes: Map<Clip, { width: number; height: number }>;
	staticClip: Map<Clip, boolean>;
	soft: Map<Clip, boolean>;
	times: Map<Clip, (f: number) => number>;
	nestFrames: Map<Clip, (g: number) => number>;
	rootCoverage: Map<Clip, { coverage: number } | null>;
	transitions: Map<string, SeqTransitions>;
	warnings: CutMapWarning[];
	warned: Set<string>;
	denseLeft: number;
	nestWorkLeft: number;
};

function warn(ctx: Ctx, code: CutMapWarningCode, message: string, clipId?: string): void {
	const key = `${code}:${clipId ?? ''}`;
	if (ctx.warned.has(key) || ctx.warnings.length >= 200) return;
	ctx.warned.add(key);
	ctx.warnings.push({ code, message, ...(clipId ? { clipId } : {}) });
}

const PICTURE_KINDS: ReadonlySet<string> = new Set([
	'video',
	'still',
	'animated-image',
	'solid',
	'nest-video',
]);

type Rec = Record<string, unknown>;

/** True when the clip draws a picture of a source (see the file comment). */
function isPicture(ctx: Ctx, c: Clip | undefined): c is Clip {
	if (!c || c.enabled === false || !PICTURE_KINDS.has(c.kind)) return false;
	if (c.kind === 'solid') {
		const s = ctx.doc.synthetics?.[(c as Rec).syntheticId as string];
		return !!s && s.kind !== 'transparent' && s.kind !== 'adjustment';
	}
	return true;
}

type Anim = { keyframes?: unknown; expression?: unknown };
const animated = (a: unknown): boolean => {
	const x = a as Anim | undefined;
	return !!x && Array.isArray(x.keyframes) && isAnimated(x as Parameters<typeof isAnimated>[0]);
};

type FxLike = { id?: string; effectId: string; effectVersion?: number; enabled: boolean; params?: Rec };
const effectsOf = (c: Clip): FxLike[] => {
	const e = (c as { effects?: unknown }).effects;
	return Array.isArray(e) ? (e as FxLike[]) : [];
};
const CROP_ID = 'jasper.crop';
const GEOMETRY_FX = new Set([CROP_ID, CORNER_PIN_EFFECT_ID]);

/** Motion, Opacity, Crop or corner pin vary over the clip (evaluated frame by frame). */
function isAnimatedClip(ctx: Ctx, c: Clip): boolean {
	let v = ctx.staticClip.get(c);
	if (v !== undefined) return !v;
	const hold = (c as { frameHold?: { holdFilters?: boolean } }).frameHold;
	let anim = false;
	if (!hold?.holdFilters) {
		const tr = (c as { transform?: Rec }).transform;
		anim =
			(!!tr && ['position', 'anchor', 'scale', 'scaleWidth', 'rotation'].some((k) => animated(tr[k]))) ||
			animated((c as Rec).opacity) ||
			effectsOf(c).some(
				(fx) => fx.enabled && GEOMETRY_FX.has(fx.effectId) && Object.values(fx.params ?? {}).some(animated),
			);
	}
	v = !anim;
	ctx.staticClip.set(c, v);
	return anim;
}

/** Nothing below shows through this clip only when this is false (see the file comment). */
function isSoft(ctx: Ctx, c: Clip): boolean {
	const cached = ctx.soft.get(c);
	if (cached !== undefined) return cached;
	const r = c as Rec;
	let soft =
		(typeof r.blendMode === 'string' && r.blendMode !== 'normal') ||
		(Array.isArray(r.masks) && (r.masks as { mode?: string }[]).some((m) => m?.mode !== 'none')) ||
		(r.threeD as { enabled?: boolean } | undefined)?.enabled === true;
	if (!soft && (c.kind === 'video' || c.kind === 'still' || c.kind === 'animated-image')) {
		const asset = ctx.doc.media?.[r.mediaId as string];
		if (asset?.probe?.hasAlpha) {
			const a = mediaAlpha(asset);
			soft = a.mode !== 'ignore' || a.invert;
		}
	}
	if (!soft && c.kind === 'solid') {
		const s = ctx.doc.synthetics?.[r.syntheticId as string];
		if (s?.kind === 'color-matte') {
			const alpha = (s.color as unknown[] | undefined)?.[3];
			soft = typeof alpha === 'number' && alpha < 1;
		}
	}
	if (!soft)
		soft = effectsOf(c).some((fx) => {
			if (!fx.enabled || fx.effectId === CORNER_PIN_EFFECT_ID || fx.effectId === CROP_ID) return false;
			if (fx.effectId === 'jasper.transform' || fx.effectId === 'jasper.edge-feather') return true;
			const cat = defaultEffectRegistry.get(fx.effectId)?.category;
			return cat === 'Keying' || cat === 'Distort' || cat === 'Perspective';
		});
	ctx.soft.set(c, soft);
	return soft;
}

/** The clip's layer map (box px → its sequence px), visible quad and opacity at frame `g` of its sequence. */
function geometry(ctx: Ctx, seq: Sequence, c: Clip, g: number): Geo | null {
	const isStatic = !isAnimatedClip(ctx, c);
	if (isStatic && ctx.geo.has(c)) return ctx.geo.get(c)!;
	let geo: Geo | null = null;
	try {
		const t = clipContentTime(c as Parameters<typeof clipContentTime>[0], g, ctx.rate);
		const tr = (c as { transform?: Record<string, never> }).transform;
		const m2 = tr
			? layerMatrix({
					position: evaluate(tr.position, t) as Vec2,
					anchor: evaluate(tr.anchor, t) as Vec2,
					scale: evaluate(tr.scale, t) as number,
					scaleWidth: evaluate(tr.scaleWidth, t) as number,
					uniformScale: (tr as { uniformScale?: boolean }).uniformScale === true,
					rotation: evaluate(tr.rotation, t) as number,
					flipH: (tr as { flipH?: boolean }).flipH === true,
					flipV: (tr as { flipV?: boolean }).flipV === true,
				})
			: IDENTITY;
		let box = ctx.boxes.get(c);
		if (!box) {
			box = intrinsicBoxOf({ doc: ctx.doc, seq, clip: c });
			ctx.boxes.set(c, box);
		}
		// Only the params that move the picture's outline are evaluated (Crop windows, flips, the corner pin).
		const resolved: ResolvedEffect[] = effectsOf(c).map((fx) => ({
			id: fx.id ?? '',
			effectId: fx.effectId,
			effectVersion: fx.effectVersion ?? 1,
			enabled: fx.enabled === true,
			params: GEOMETRY_FX.has(fx.effectId)
				? Object.fromEntries(
						Object.entries(fx.params ?? {}).map(([k, a]) => [
							k,
							evaluateEffectParam(fx, k, a as Parameters<typeof evaluateEffectParam>[2], t, box),
						]),
					)
				: ({} as Record<string, ParamValue>),
		}));
		const crop = cropWindow(resolved);
		const rect = visibleRect(box, crop ?? undefined);
		const pin = cornerPinQuad(resolved, box);
		const pinMap = pin ? boxToQuad(box.width, box.height, pin) : null;
		const map = pinMap ? multiplyMat3(mat3FromMat2D(m2), pinMap) : mat3FromMat2D(m2);
		const corners: P[] = [
			[rect.x, rect.y],
			[rect.x + rect.width, rect.y],
			[rect.x + rect.width, rect.y + rect.height],
			[rect.x, rect.y + rect.height],
		];
		const quad = corners.map((p) => applyMat3(map, p));
		const opAnim = (c as { opacity?: Animatable<number> }).opacity;
		const op = opAnim ? Number(evaluate(opAnim, t)) : 100;
		const opacity = Number.isFinite(op) ? Math.min(100, Math.max(0, op)) / 100 : 0;
		geo = finitePoly(quad) && rect.width > 0 && rect.height > 0 ? { map, quad, opacity } : null;
	} catch {
		warn(ctx, 'unreadable-clip', `Clip ${c.id} has unreadable Motion, Opacity or Crop values; ignored`, c.id);
		geo = null;
	}
	if (isStatic) ctx.geo.set(c, geo);
	return geo;
}

/** Picture time (flicks of the clip's source) at frame `g` of its sequence. */
function timeFn(ctx: Ctx, c: Clip): (g: number) => number {
	let f = ctx.times.get(c);
	if (!f) {
		f = clipMediaTimeFn(c as Parameters<typeof clipMediaTimeFn>[0], ctx.rate);
		ctx.times.set(c, f);
	}
	return f;
}

/** The frame of the (conformed) nested sequence a nest clip draws at frame `g` of its own sequence (renderer). */
function nestFrameFn(ctx: Ctx, c: Clip): (g: number) => number {
	let f = ctx.nestFrames.get(c);
	if (!f) {
		const t = timeFn(ctx, c);
		const F = ctx.F;
		f = (g: number) => Math.floor(Math.max(0, t(g)) / F + 1e-6);
		ctx.nestFrames.set(c, f);
	}
	return f;
}

type Follow = { view: Sequence } | { skip: 'missing' | 'cycle' } | { flat: true };

/** What a nest clip shows: its nested sequence (multi-camera view, conformed), nothing, or one flat picture. */
function followNest(ctx: Ctx, c: Clip, depth: number, stack: readonly string[]): Follow {
	const id = (c as Rec).sequenceId as string;
	if (stack.includes(id)) {
		warn(
			ctx,
			'nest-cycle',
			`Nest clip ${c.id} shows a sequence that contains itself; it draws nothing`,
			c.id,
		);
		return { skip: 'cycle' };
	}
	if (depth + 1 > MAX_CUT_MAP_NEST_DEPTH) {
		warn(
			ctx,
			'nest-depth',
			`Nest clip ${c.id} is nested deeper than ${MAX_CUT_MAP_NEST_DEPTH} levels; its content counts as one picture`,
			c.id,
		);
		return { flat: true };
	}
	const mc = (c as { multicam?: { enabled?: boolean; angle?: string } }).multicam;
	const key = `${id}|${mc?.enabled ? (mc.angle ?? '') : ''}`;
	let view = ctx.views.get(key);
	if (view === undefined) {
		const whole = ctx.doc.sequences[id];
		if (!whole) view = null;
		else {
			const mv = multicamView(whole, c);
			view = rationalEquals(mv.settings.frameRate as Rational, ctx.rate)
				? mv
				: conformSequenceRate(mv, ctx.rate);
		}
		ctx.views.set(key, view);
	}
	if (!view) {
		warn(ctx, 'nest-missing', `Nest clip ${c.id} shows a missing sequence; it draws nothing`, c.id);
		return { skip: 'missing' };
	}
	return { view };
}

/** Shown video tracks of a nested sequence, top first. */
const innerTracks = (seq: Sequence): Track[] => seq.videoTracks.filter((t) => t.output !== false).reverse();

function seqTransitions(ctx: Ctx, seq: Sequence): SeqTransitions {
	let s = ctx.transitions.get(seq.id);
	if (!s) {
		s = { pairs: new Map(), head: new Set(), tail: new Set() };
		for (const t of Object.values(seq.transitions ?? {})) {
			if (!t) continue;
			if (t.outgoingClipId && t.incomingClipId) s.pairs.set(`${t.outgoingClipId}>${t.incomingClipId}`, t);
			else if (t.incomingClipId) s.head.add(t.incomingClipId);
			else if (t.outgoingClipId) s.tail.add(t.outgoingClipId);
		}
		ctx.transitions.set(seq.id, s);
	}
	return s;
}

// ---------------------------------------------------------------------------------------------------------------
// The stack at one frame

/** One level of a layer's nesting: the clip, its sequence, and that sequence's frame at a root frame. */
type Level = { seq: Sequence; clip: Clip; at: (f: number) => number };

type Layer = {
	/** Root first; the last level is the layer's own clip. */
	chain: Level[];
	key: string;
	source: string;
	timeless: boolean;
	/** Picture time at a root frame (extrapolated outside the clip). */
	time: (f: number) => number;
	coverage: number;
	opacity: number;
	full: boolean;
	soft: boolean;
};

type State = { base: Layer | null; overlays: Layer[] };

function sourceOf(ctx: Ctx, c: Clip): { source: string; timeless: boolean } {
	const r = c as Rec;
	switch (c.kind) {
		case 'video':
			return { source: `v:${r.mediaId}:${r.videoStreamIndex ?? 0}`, timeless: false };
		case 'still':
			return { source: `i:${r.mediaId}`, timeless: true };
		case 'animated-image':
			return { source: `a:${r.mediaId}`, timeless: false };
		case 'solid': {
			const s = ctx.doc.synthetics?.[r.syntheticId as string];
			return { source: `s:${r.syntheticId}`, timeless: !(s && SYNTHETIC_INFO[s.kind]?.timeDependent) };
		}
		default:
			return { source: `n:${r.sequenceId}`, timeless: false };
	}
}

const ROOT_AT = (f: number) => f;

function visit(
	ctx: Ctx,
	seq: Sequence,
	tracks: readonly Track[],
	g: number,
	prefix: readonly Level[],
	at: (f: number) => number,
	map: Mat3 | null,
	window: readonly P[],
	opacity: number,
	soft: boolean,
	depth: number,
	stack: readonly string[],
	out: Layer[],
): boolean {
	for (const track of tracks) {
		const c = clipAt(seq, track.id, g);
		if (!isPicture(ctx, c)) continue;
		const geo = geometry(ctx, seq, c, g);
		if (!geo) continue;
		const op = opacity * geo.opacity;
		if (op <= 0) continue;
		const layerSoft = soft || isSoft(ctx, c);
		const chain = [...prefix, { seq, clip: c, at }];
		let win: P[];
		let area: number;
		const root = map === null && !isAnimatedClip(ctx, c);
		const cached = root ? ctx.rootCoverage.get(c) : undefined;
		if (cached !== undefined && c.kind !== 'nest-video') {
			if (!cached) continue;
			win = [];
			area = cached.coverage * ctx.frameArea;
		} else {
			const quad = map ? geo.quad.map((p) => applyMat3(map, p)) : geo.quad;
			win = clipConvexPolygon(quad, window);
			area = polygonArea(win);
			if (root && c.kind !== 'nest-video')
				ctx.rootCoverage.set(c, area > 0 ? { coverage: area / ctx.frameArea } : null);
		}
		if (!(area > 0)) continue;
		if (c.kind === 'nest-video') {
			const follow = followNest(ctx, c, depth, stack);
			if ('skip' in follow) continue;
			if ('view' in follow) {
				const nf = nestFrameFn(ctx, c);
				const innerAt = (f: number) => nf(at(f));
				const innerMap = map ? multiplyMat3(map, geo.map) : geo.map;
				const stop = visit(
					ctx,
					follow.view,
					innerTracks(follow.view),
					nf(g),
					chain,
					innerAt,
					innerMap,
					win,
					op,
					layerSoft,
					depth + 1,
					[...stack, follow.view.id],
					out,
				);
				if (stop) return true;
				continue;
			}
		}
		const coverage = Math.min(1, area / ctx.frameArea);
		if (coverage + 1e-9 < ctx.overlayCoverage) continue;
		const { source, timeless } = sourceOf(ctx, c);
		const own = timeFn(ctx, c);
		const full = coverage >= FULL_FRAME_COVERAGE && op >= OPAQUE && !layerSoft;
		out.push({
			chain,
			key: chain.length === 1 ? c.id : chain.map((l) => l.clip.id).join('/'),
			source,
			timeless,
			time: at === ROOT_AT ? own : (f: number) => own(at(f)),
			coverage,
			opacity: op,
			full,
			soft: layerSoft,
		});
		if (full) return true;
	}
	return false;
}

function stateAt(ctx: Ctx, seq: Sequence, tracks: readonly Track[], f: number): State {
	const layers: Layer[] = [];
	visit(ctx, seq, tracks, f, [], ROOT_AT, null, ctx.framePoly, 1, false, 0, [seq.id], layers);
	if (!layers.length) return { base: null, overlays: [] };
	let base = layers[layers.length - 1]!;
	if (!base.full) {
		base =
			layers.find((l) => l.coverage >= FULL_FRAME_COVERAGE) ??
			layers.reduce((best, l) => (l.coverage > best.coverage + 1e-9 ? l : best), layers[0]!);
	}
	return { base, overlays: layers.filter((l) => l !== base) };
}

/** `b` (shown at `f`) continues `a` (shown at `f − 1`): the same layer, or the same source's continuing content. */
function continues(a: Layer, b: Layer, f: number): boolean {
	if (a.key === b.key) return true;
	if (a.source !== b.source) return false;
	if (a.timeless) return true;
	const ta = a.time(f);
	const tb = b.time(f);
	const step = Math.max(Math.abs(ta - a.time(f - 1)), Math.abs(b.time(f + 1) - tb));
	const d = Math.abs(ta - tb);
	return Number.isFinite(d) && d < Math.max(step / 2, 1);
}

/** A picture fading in from / out to nothing at `f` (a one-sided transition at the edge it crosses, or ≤ 5 %). */
function fadedEdge(ctx: Ctx, l: Layer, f: number, dir: 'enter' | 'exit'): boolean {
	if (l.opacity <= FADED) return true;
	for (const level of l.chain) {
		const c = level.clip;
		const inSpan = (x: number) => {
			const g = level.at(x);
			return g >= c.start && g < clipEnd(c);
		};
		const inner = dir === 'exit' ? f - 1 : f;
		const outer = dir === 'exit' ? f : f - 1;
		if (!inSpan(inner) || inSpan(outer)) continue;
		const g = level.at(outer);
		// Crossing the clip's end (leaving forwards, or entering while played in reverse) is its tail side.
		const tailSide = !(g < c.start);
		const t = seqTransitions(ctx, level.seq);
		if (tailSide ? t.tail.has(c.id) : t.head.has(c.id)) return true;
	}
	return false;
}

function nestedRef(l: Layer): NestedClipRef | undefined {
	if (l.chain.length < 2) return undefined;
	const own = l.chain[l.chain.length - 1]!;
	return {
		sequenceId: own.seq.id,
		clipId: own.clip.id,
		nestPath: l.chain.slice(0, -1).map((x) => x.clip.id),
	};
}

/** Root frames around `f` where `at(x)` lies in `[zs, ze)` (a nested transition's span seen from the root). */
function mapZone(at: (f: number) => number, zs: number, ze: number, f: number, duration: number) {
	const inZ = (x: number) => {
		const g = at(x);
		return g >= zs && g < ze;
	};
	const cap = 100_000;
	let s = f;
	let n = 0;
	while (s - 1 >= 0 && inZ(s - 1) && n++ < cap) s--;
	let e = f;
	n = 0;
	while (e < duration && inZ(e) && n++ < cap) e++;
	return e > s ? { start: s, end: e } : undefined;
}

function makeCut(
	ctx: Ctx,
	kind: CutKind,
	out: Layer | null,
	inc: Layer | null,
	f: number,
	duration: number,
): PictureCut {
	const cut: PictureCut = { frame: f, kind, trackId: (inc ?? out)!.chain[0]!.clip.trackId };
	if (out) cut.outgoingClipId = out.chain[0]!.clip.id;
	if (inc) cut.incomingClipId = inc.chain[0]!.clip.id;
	const nested: NonNullable<PictureCut['nested']> = {};
	const no = out && nestedRef(out);
	const ni = inc && nestedRef(inc);
	if (no) nested.outgoing = no;
	if (ni) nested.incoming = ni;
	if (out && inc) {
		// The level where the two pictures part: the clips there may be joined by a two-sided transition.
		let k = 0;
		while (k < out.chain.length && k < inc.chain.length && out.chain[k]!.clip.id === inc.chain[k]!.clip.id)
			k++;
		const a = out.chain[k];
		const b = inc.chain[k];
		if (a && b && a.seq === b.seq && a.clip.trackId === b.clip.trackId && clipEnd(a.clip) === b.clip.start) {
			const t = seqTransitions(ctx, a.seq).pairs.get(`${a.clip.id}>${b.clip.id}`);
			if (t && Number.isFinite(t.duration) && t.duration >= 1) {
				const span = transitionSpan(b.clip.start, t.duration, t.alignment, t.cutPosition);
				if (k === 0) {
					cut.transitionId = t.id;
					cut.zone = span;
				} else {
					nested.transition = {
						sequenceId: a.seq.id,
						transitionId: t.id,
						nestPath: out.chain.slice(0, k).map((x) => x.clip.id),
					};
					const z = mapZone(a.at, span.start, span.end, f, duration);
					if (z) cut.zone = z;
				}
			}
		}
	}
	if (nested.outgoing || nested.incoming || nested.transition) cut.nested = nested;
	return cut;
}

function compare(ctx: Ctx, prev: State, cur: State, f: number, duration: number): PictureCut | null {
	const out = prev.base;
	const inc = cur.base;
	if ((out || inc) && !(out && inc && continues(out, inc, f))) {
		let kind: CutKind | null;
		const stays =
			(out && cur.overlays.some((o) => continues(out, o, f))) ||
			(inc && prev.overlays.some((o) => continues(o, inc, f)));
		if (stays) kind = ctx.includeOverlays ? 'overlay' : null;
		else if (out && inc && out.source === inc.source) kind = ctx.includeJumpCuts ? 'jump' : null;
		else if (!inc ? fadedEdge(ctx, out!, f, 'exit') : !out ? fadedEdge(ctx, inc, f, 'enter') : false)
			kind = null;
		else kind = 'cut';
		if (kind) return makeCut(ctx, kind, out, inc, f, duration);
	}
	if (!ctx.includeOverlays) return null;
	const entered = cur.overlays.find((b) => !prev.overlays.some((a) => continues(a, b, f)) && b !== inc);
	const left = prev.overlays.find((a) => !cur.overlays.some((b) => continues(a, b, f)) && a !== out);
	if (!entered && !left) return null;
	return makeCut(ctx, 'overlay', left ?? null, entered ?? null, f, duration);
}

// ---------------------------------------------------------------------------------------------------------------
// Where the stack may change

function lowerBound(sorted: readonly number[], x: number): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (sorted[mid]! < x) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function sortedUnique(list: number[]): number[] {
	list.sort((a, b) => a - b);
	const out: number[] = [];
	for (const x of list) if (out[out.length - 1] !== x) out.push(x);
	return out;
}

/** Every frame of `[from, to)` of `seq` where its picture stack may differ from the frame before (sorted, unique). */
function changeFrames(
	ctx: Ctx,
	seq: Sequence,
	tracks: readonly Track[],
	from: number,
	to: number,
	depth: number,
	stack: readonly string[],
): number[] {
	const frames: number[] = [];
	const add = (x: number) => {
		if (x >= from && x < to) frames.push(x);
	};
	const dense = (lo: number, hi: number, clipId: string, changes?: (x: number) => boolean) => {
		const n = hi - lo;
		if (n <= 0) return;
		let stride = 1;
		if (n > ctx.denseLeft) {
			stride = Math.max(2, Math.ceil(n / Math.max(1, ctx.denseLeft)));
			warn(
				ctx,
				'sampled',
				`Too many animated frames to check one by one; clip ${clipId} is checked every ${stride} frames`,
				clipId,
			);
		}
		ctx.denseLeft = Math.max(0, ctx.denseLeft - Math.ceil(n / stride));
		for (let x = lo; x < hi; x += stride) if (!changes || changes(x)) add(x);
	};
	// An animated picture of this sequence's own tracks (depth 0: no enclosing nest map) can change the stack only
	// where its status changes — off / under the overlay threshold / opaque-full — or on any frame while it is a
	// partial or see-through layer (its coverage and opacity then matter). A punch-in zoom costs no stack evaluation.
	const statusChanges = (c: Clip) => {
		let prev: string | null = null;
		return (x: number): boolean => {
			const geo = geometry(ctx, seq, c, x);
			let sig: string;
			if (!geo || geo.opacity <= 0) sig = 'off';
			else {
				const cov = polygonArea(clipConvexPolygon(geo.quad, ctx.framePoly)) / ctx.frameArea;
				if (cov + 1e-9 < ctx.overlayCoverage) sig = 'small';
				else if (cov >= FULL_FRAME_COVERAGE && geo.opacity >= OPAQUE && !isSoft(ctx, c)) sig = 'full';
				else sig = `partial:${x}`;
			}
			const changed = sig !== prev;
			prev = sig;
			return changed;
		};
	};
	for (const track of tracks) {
		for (const c of clipsInRange(seq, track.id, from, to)) {
			if (!isPicture(ctx, c)) continue;
			add(c.start);
			add(clipEnd(c));
			const lo = Math.max(from, c.start);
			const hi = Math.min(to, clipEnd(c));
			if (isAnimatedClip(ctx, c))
				dense(lo, hi, c.id, depth === 0 && c.kind !== 'nest-video' ? statusChanges(c) : undefined);
			if (c.kind !== 'nest-video' || hi <= lo) continue;
			const follow = followNest(ctx, c, depth, stack);
			if (!('view' in follow)) continue;
			const span = hi - lo;
			if (span * 2 > ctx.nestWorkLeft) {
				warn(
					ctx,
					'nest-work-limit',
					`Too much nested material to follow; cuts inside nest clip ${c.id} are not listed`,
					c.id,
				);
				continue;
			}
			ctx.nestWorkLeft -= span * 2;
			const nf = nestFrameFn(ctx, c);
			let gmin = Number.POSITIVE_INFINITY;
			let gmax = Number.NEGATIVE_INFINITY;
			for (let x = Math.max(0, lo - 1); x < hi; x++) {
				const g = nf(x);
				if (g < gmin) gmin = g;
				if (g > gmax) gmax = g;
			}
			if (!Number.isFinite(gmin) || !Number.isFinite(gmax)) continue;
			const inner = changeFrames(ctx, follow.view, innerTracks(follow.view), gmin, gmax + 1, depth + 1, [
				...stack,
				follow.view.id,
			]);
			if (!inner.length) continue;
			// A parent frame is a change frame when the nested frames shown at x − 1 and x enclose a nested change.
			let prevG = nf(Math.max(0, lo - 1));
			for (let x = Math.max(1, lo); x < hi; x++) {
				const g = nf(x);
				if (g !== prevG) {
					const a = Math.min(g, prevG);
					const b = Math.max(g, prevG);
					const i = lowerBound(inner, a + 1);
					if (i < inner.length && inner[i]! <= b) add(x);
				}
				prevG = g;
			}
		}
	}
	return sortedUnique(frames);
}

// ---------------------------------------------------------------------------------------------------------------

/** The cut map with its warnings and the analysed tracks / range (see the file comment). */
export function analyzePictureCuts(
	doc: ProjectDocument,
	sequenceId: string,
	opts: CutMapOptions = {},
): CutMapResult {
	const parsed = CutMapOptionsSchema.safeParse(opts);
	if (!parsed.success)
		throw new CutMapError(
			'E_INVALID_PARAM',
			`Invalid cut map options: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'options'}: ${i.message}`).join('; ')}`,
		);
	const o = parsed.data;
	const seq = doc.sequences?.[sequenceId];
	if (!seq) throw new CutMapError('E_NOT_FOUND', `Sequence not found: ${sequenceId}`);
	let below = seq.videoTracks.length;
	if (o.outputTrackId !== undefined) {
		const v = seq.videoTracks.findIndex((t) => t.id === o.outputTrackId);
		if (v >= 0) below = v;
		else if (!seq.captionTracks.some((t) => t.id === o.outputTrackId)) {
			if (seq.audioTracks.some((t) => t.id === o.outputTrackId))
				throw new CutMapError('E_INVALID_PARAM', `Output track ${o.outputTrackId} is an audio track`);
			throw new CutMapError('E_NOT_FOUND', `Track not found: ${o.outputTrackId}`);
		}
	}
	if (o.trackIds)
		for (const id of o.trackIds)
			if (!seq.videoTracks.some((t) => t.id === id))
				throw new CutMapError(
					seq.audioTracks.some((t) => t.id === id) || seq.captionTracks.some((t) => t.id === id)
						? 'E_INVALID_PARAM'
						: 'E_NOT_FOUND',
					`Not a video track of the sequence: ${id}`,
				);
	const only = o.trackIds ? new Set(o.trackIds) : null;
	const tracks = seq.videoTracks
		.slice(0, below)
		.filter((t) => t.output !== false && (!only || only.has(t.id)))
		.reverse();
	const duration = sequenceDuration(seq);
	const lo = Math.max(1, o.range?.start ?? 0);
	const hi = Math.min(duration, o.range?.end ?? duration);
	const range = { start: o.range?.start ?? 0, end: Math.min(duration, o.range?.end ?? duration) };
	const result: CutMapResult = {
		sequenceId: seq.id,
		cuts: [],
		warnings: [],
		trackIds: tracks.map((t) => t.id),
		duration,
		range,
	};
	const rate = seq.settings?.frameRate as Rational | undefined;
	const F = rate ? flicksPerFrame(rate) : Number.NaN;
	const W = seq.settings?.width;
	const H = seq.settings?.height;
	if (!(Number.isFinite(F) && F > 0 && (W ?? 0) > 0 && (H ?? 0) > 0)) {
		result.warnings.push({
			code: 'unreadable-clip',
			message: 'The sequence has an unusable frame rate or size',
		});
		return result;
	}
	if (hi <= lo || !tracks.length) return result;
	const ctx: Ctx = {
		doc,
		rate: rate!,
		F,
		framePoly: [
			[0, 0],
			[W!, 0],
			[W!, H!],
			[0, H!],
		],
		frameArea: W! * H!,
		overlayCoverage: o.overlayCoverage ?? CUT_MAP_DEFAULTS.overlayCoverage,
		includeJumpCuts: o.includeJumpCuts ?? CUT_MAP_DEFAULTS.includeJumpCuts,
		includeOverlays: o.includeOverlays ?? CUT_MAP_DEFAULTS.includeOverlays,
		views: new Map(),
		geo: new Map(),
		boxes: new Map(),
		staticClip: new Map(),
		soft: new Map(),
		times: new Map(),
		nestFrames: new Map(),
		rootCoverage: new Map(),
		transitions: new Map(),
		warnings: result.warnings,
		warned: new Set(),
		denseLeft: MAX_CUT_MAP_DENSE_FRAMES,
		nestWorkLeft: MAX_CUT_MAP_NEST_WORK,
	};
	const frames = changeFrames(ctx, seq, tracks, lo, hi, 0, [seq.id]);
	if (frames[0] !== lo) frames.unshift(lo);
	let prev = stateAt(ctx, seq, tracks, lo - 1);
	for (const f of frames) {
		const cur = stateAt(ctx, seq, tracks, f);
		const cut = compare(ctx, prev, cur, f, duration);
		if (cut) result.cuts.push(cut);
		prev = cur;
	}
	return result;
}
