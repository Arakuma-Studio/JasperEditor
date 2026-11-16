// Decorate Cuts planner (spec 15 EA-020, EA-030, EA-032): one cut kit per picture cut of the cut map (spec 13 §2.1),
// centred on the cut frame exactly (the kit's `before` frames end on the frame before the cut, its `after` frames
// start on the cut), the family drawn with the pack's shares and a repeat penalty against the previous kit's family,
// a variant (direction) drawn with its weights, never overlapping another kit: a cut too close to the previous kit
// takes a family short enough to fit, else it is skipped (reported). Each kit's decisions come from its own seed
// (`itemSeed(seed, 'decorate-cuts', cut frame)`), so the plan is deterministic and Reroll re-plans one kit with the
// next seed. Pure: the engine adds the SFX (sound-design cues and placement) and builds the proposal.

import type { BatchEffect, BatchItemKey } from '../commands/schemas/batch.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';
import { CutMapError, type PictureCut, pictureCuts } from '../structure/cuts.ts';
import {
	AutomationInputError,
	adjustmentTrackFor,
	automationSequence,
	type FrameGeometry,
	frameGeometry,
	spanFree,
	timecodeOf,
	trackSpans,
	videoTrackOf,
} from './common.ts';
import {
	builtinKitPack,
	chainWeights,
	type KitEffect,
	type KitFamily,
	type KitKey,
	type KitPack,
	KitPackSchema,
	type KitVariant,
	kitPackIssues,
	kitRefsOf,
	resolveKitEase,
	selectKits,
	transitionRow,
	variantSpan,
} from './kits.ts';
import {
	AUTOMATION_DEFAULTS,
	type DecorateCutsParams,
	DecorateCutsParamsSchema,
	type WhooshMedia,
} from './params.ts';
import { itemSeed, seededRandom, weightedIndex } from './rng.ts';

export const DECORATE_PASS = 'decorate-cuts' as const;

/** Why a cut got no kit. */
export const DECORATE_SKIP_CODES = [
	'transition',
	'decorated',
	'spacing',
	'coverage',
	'too-close',
	'edge',
	'track-busy',
	'no-family',
] as const;
export type DecorateSkipCode = (typeof DECORATE_SKIP_CODES)[number];

export type DecorateSkip = { frame: number; timecode: string; code: DecorateSkipCode; reason: string };

/** One adjustment clip of a kit (a `clip.addAdjustmentBatch` item without its track). */
export type KitClip = { start: number; length: number; name: string; effects: BatchEffect[] };

/** A family / variant placed at a cut. */
export type KitChoice = {
	family: string;
	familyLabel: string;
	variant: string;
	variantLabel: string;
	before: number;
	after: number;
	start: number;
	end: number;
	clips: KitClip[];
};

export type KitPlacement = KitChoice & {
	/** Proposal item id: `kit:<cut frame>`. */
	id: string;
	/** The cut frame (first frame of the incoming picture). */
	frame: number;
	timecode: string;
	seed: number;
	cut: Pick<PictureCut, 'kind' | 'trackId' | 'outgoingClipId' | 'incomingClipId'>;
	/** Other families / variants that fit at this cut without touching the neighbouring kits (Review ⇄). */
	alternatives: KitChoice[];
};

export type ResolvedDecorateParams = {
	pack: KitPack;
	weights: number[];
	repeatPenalty: number;
	coverage: number;
	minSpacingFrames: number;
	includeInsertEdges: boolean;
	includeJumpCuts: boolean;
	skipDecorated: boolean;
	seed: number;
	track?: string;
	fxTrack?: string;
	range?: { start: number; end: number };
	/** Explicit cut frames (sorted, unique): exactly these cuts are decorated. */
	cuts?: number[];
	/** Whooshes cut from a project media instead of library sounds. */
	whoosh?: WhooshMedia;
};

export type DecoratePlan = {
	pass: typeof DECORATE_PASS;
	sequenceId: string;
	pack: { id: string; label: string };
	seed: number;
	kits: KitPlacement[];
	skipped: DecorateSkip[];
	/** Cuts of the cut map considered (after the kind filters; the explicit cuts when a cut list is given). */
	considered: number;
	/** Where the kits go: an existing video track, or a new one created above the picture. */
	fxTrack: { trackId: string; label: string; create: false } | { create: true; name: string };
	/** Kits per family id. */
	families: Record<string, number>;
	warnings: { code: string; message: string }[];
};

/** Normalised parameters (defaults by aspect); throws `AutomationInputError` for an invalid pack or params. */
export function resolveDecorateParams(
	raw: unknown,
	geo: Pick<FrameGeometry, 'vertical'>,
): ResolvedDecorateParams {
	const parsed = DecorateCutsParamsSchema.safeParse(raw ?? {});
	if (!parsed.success)
		throw new AutomationInputError(
			'E_INVALID_PARAM',
			parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '),
		);
	const p: DecorateCutsParams = parsed.data;
	let pack: KitPack;
	if (p.pack === undefined || typeof p.pack === 'string')
		pack = builtinKitPack(p.pack ?? (geo.vertical ? 'shorts-shake' : 'long-pack'))!;
	else {
		const pk = KitPackSchema.parse(p.pack);
		const issues = kitPackIssues(pk);
		if (issues.length)
			throw new AutomationInputError('E_INVALID_PARAM', `pack: ${issues.slice(0, 3).join('; ')}`);
		pack = pk;
	}
	if (p.families)
		for (const id of Object.keys(p.families))
			if (!pack.families.some((f) => f.id === id))
				throw new AutomationInputError(
					'E_INVALID_PARAM',
					`families: the pack "${pack.id}" has no family "${id}" (it has ${pack.families.map((f) => f.id).join(', ')})`,
				);
	if (p.kits) {
		const sel = selectKits(pack, p.kits);
		if (!sel.ok)
			throw new AutomationInputError(
				'E_INVALID_PARAM',
				`kits: the pack "${pack.id}" has no kit ${sel.unknown
					.slice(0, 5)
					.map((r) => `"${r}"`)
					.join(', ')} (it has ${kitRefsOf(pack).join(', ')})`,
			);
		pack = sel.pack;
	}
	const weights = pack.families.map((f) => p.families?.[f.id] ?? f.weight);
	if (!weights.some((w) => w > 0))
		throw new AutomationInputError(
			'E_INVALID_PARAM',
			p.kits
				? 'kits / families: every chosen kit has weight 0'
				: 'families: at least one family needs a weight above 0',
		);
	return {
		pack,
		weights,
		repeatPenalty: p.repeatPenalty ?? pack.repeatPenalty,
		coverage: p.coverage ?? AUTOMATION_DEFAULTS.coverage,
		minSpacingFrames: p.minSpacingFrames ?? 0,
		includeInsertEdges: p.includeInsertEdges ?? false,
		includeJumpCuts: p.includeJumpCuts ?? true,
		skipDecorated: p.skipDecorated ?? true,
		seed: p.seed ?? AUTOMATION_DEFAULTS.seed,
		...(p.track !== undefined ? { track: p.track } : {}),
		...(p.fxTrack !== undefined ? { fxTrack: p.fxTrack } : {}),
		...(p.range ? { range: p.range } : {}),
		...(p.cuts ? { cuts: [...new Set(p.cuts)].sort((a, b) => a - b) } : {}),
		...(p.sfx?.media ? { whoosh: p.sfx.media } : {}),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Keys → batch keys

/** Value scaled for the frame size (px params of a 1080-px short side). */
function scaled(v: unknown, s: number): unknown {
	if (s === 1) return v;
	if (typeof v === 'number') return Math.round(v * s * 1000) / 1000;
	return v;
}

/**
 * Kit keys (frames from the cut) → batch keys of a clip starting `offset` frames before the cut, with the per-side
 * interpolation of each segment's ease (`ease` on a key = the segment arriving at it).
 */
export function batchKeysOf(keys: readonly KitKey[], offset: number, scale = 1): BatchItemKey[] {
	const out: (BatchItemKey & { frame: number })[] = keys.map((k) => ({
		frame: k.at + offset,
		value: scaled(k.value, scale),
		interpolation: 'linear' as const,
	}));
	for (let i = 1; i < keys.length; i++) {
		const e = resolveKitEase(keys[i]!.ease ?? 'linear');
		const prev = out[i - 1]!;
		const cur = out[i]!;
		if (e === 'hold') prev.interpolation = 'hold';
		else if (e === null || e === 'linear') {
			if (prev.interpolation !== 'hold') prev.interpolation = 'linear';
			cur.inInterpolation = 'linear';
		} else {
			prev.interpolation = 'bezier';
			prev.easeOut = e.easeOut;
			cur.inInterpolation = 'bezier';
			cur.easeIn = e.easeIn;
		}
	}
	return out;
}

function effectOf(e: KitEffect, offset: number, pxScale: number): BatchEffect {
	const px = new Set(e.scaleWithFrame ?? []);
	const params: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(e.params ?? {})) params[k] = px.has(k) ? scaled(v, pxScale) : v;
	const keyframes: Record<string, BatchItemKey[]> = {};
	for (const [k, keys] of Object.entries(e.keyframes ?? {}))
		keyframes[k] = batchKeysOf(keys, offset, px.has(k) ? pxScale : 1);
	return {
		effectId: e.effectId,
		...(Object.keys(params).length ? { params } : {}),
		...(Object.keys(keyframes).length ? { keyframes } : {}),
	};
}

/** The adjustment clips of a variant at `cut`. */
export function kitClips(f: KitFamily, v: KitVariant, cut: number, pxScale: number): KitClip[] {
	const { before, after } = variantSpan(f, v);
	return v.segments.map((s) => {
		const start = s.span === 'after' ? cut : cut - before;
		const length = s.span === 'whole' ? before + after : s.span === 'before' ? before : after;
		const offset = s.span === 'after' ? 0 : before;
		return {
			start,
			length,
			name: v.segments.length > 1 ? `${v.label} (${s.span === 'before' ? 'out' : 'in'})` : v.label,
			effects: s.effects.map((e) => effectOf(e, offset, pxScale)),
		};
	});
}

function choiceOf(f: KitFamily, v: KitVariant, cut: number, pxScale: number): KitChoice {
	const { before, after } = variantSpan(f, v);
	return {
		family: f.id,
		familyLabel: f.label,
		variant: v.id,
		variantLabel: v.label,
		before,
		after,
		start: cut - before,
		end: cut + after,
		clips: kitClips(f, v, cut, pxScale),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Choice at one cut

type PlanContext = {
	seq: Sequence;
	geo: FrameGeometry;
	params: ResolvedDecorateParams;
	chain: number[];
	/** Spans the kits must avoid on a fixed FX track (explicit `fxTrack`). */
	trackTaken: [number, number][] | null;
};

/** The variants of a family that fit in the free window [lo, hi) at `cut`. */
function fittingVariants(f: KitFamily, cut: number, lo: number, hi: number, ctx: PlanContext): KitVariant[] {
	return f.variants.filter((v) => {
		if (!(v.weight > 0)) return false;
		const { before, after } = variantSpan(f, v);
		const a = cut - before;
		const b = cut + after;
		if (a < lo || b > hi) return false;
		return !ctx.trackTaken || spanFree(ctx.trackTaken, a, b);
	});
}

/**
 * The kit at `cut` drawn from `rng` (after the coverage draw): family by the fitted chain weights with the penalty on
 * `prevFamily`, among the families with a variant fitting [lo, hi); variant by weight. Null when nothing fits.
 */
function chooseKit(
	ctx: PlanContext,
	cut: number,
	lo: number,
	hi: number,
	prevFamily: number,
	rng: () => number,
): { family: number; choice: KitChoice } | null {
	const fams = ctx.params.pack.families;
	const fits = fams.map((f, i) => (ctx.params.weights[i]! > 0 ? fittingVariants(f, cut, lo, hi, ctx) : []));
	const row = transitionRow(ctx.chain, ctx.params.repeatPenalty, prevFamily) ?? ctx.chain;
	const w = row.map((x, i) => (fits[i]!.length ? x : 0));
	const fi = weightedIndex(w, rng());
	if (fi < 0) return null;
	const vars = fits[fi]!;
	const vi = weightedIndex(
		vars.map((v) => v.weight),
		rng(),
	);
	const v = vars[Math.max(0, vi)]!;
	return { family: fi, choice: choiceOf(fams[fi]!, v, cut, ctx.geo.pxScale) };
}

/** Up to `max` other families (one variant each, drawn from `rng`) that fit [lo, hi) at `cut`, pack order. */
function alternativesAt(
	ctx: PlanContext,
	cut: number,
	lo: number,
	hi: number,
	chosen: KitChoice,
	rng: () => number,
	max = 3,
): KitChoice[] {
	const out: KitChoice[] = [];
	for (const [i, f] of ctx.params.pack.families.entries()) {
		if (out.length >= max) break;
		if (f.id === chosen.family || !(ctx.params.weights[i]! > 0)) continue;
		const vars = fittingVariants(f, cut, lo, hi, ctx);
		if (!vars.length) continue;
		const vi = weightedIndex(
			vars.map((v) => v.weight),
			rng(),
		);
		out.push(choiceOf(f, vars[Math.max(0, vi)]!, cut, ctx.geo.pxScale));
	}
	// a one-family pack offers its other variants instead
	if (!out.length) {
		const f = ctx.params.pack.families.find((x) => x.id === chosen.family)!;
		for (const v of fittingVariants(f, cut, lo, hi, ctx)) {
			if (out.length >= max) break;
			if (v.id !== chosen.variant) out.push(choiceOf(f, v, cut, ctx.geo.pxScale));
		}
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The pass

const ADJUSTMENT_KINDS: ReadonlySet<string> = new Set(['adjustment']);

/** [start, end) of the enabled adjustment clips of the sequence (decorations already there). */
function adjustmentSpans(seq: Sequence): [number, number][] {
	const out: [number, number][] = [];
	for (const c of Object.values(seq.clips ?? {}))
		if (ADJUSTMENT_KINDS.has(c.kind) && c.enabled !== false) out.push([c.start, c.start + c.duration]);
	return out.sort((a, b) => a[0] - b[0]);
}

/** The cut map of the pass: every kind for an explicit cut list (any real edit point), else the kind filters. */
function cutsOf(doc: ProjectDocument, seq: Sequence, params: ResolvedDecorateParams): PictureCut[] {
	const trackIds = params.track !== undefined ? [videoTrackOf(seq, params.track).id] : undefined;
	const all = params.cuts !== undefined;
	let cuts: PictureCut[];
	try {
		cuts = pictureCuts(doc, seq.id, {
			...(trackIds ? { trackIds } : {}),
			includeJumpCuts: all || params.includeJumpCuts,
			includeOverlays: all || params.includeInsertEdges,
			...(params.range ? { range: params.range } : {}),
		});
	} catch (e) {
		if (e instanceof CutMapError) throw new AutomationInputError(e.code, e.message);
		throw e;
	}
	return cuts;
}

/** The cuts of the cut map an explicit list names; `E_NOT_A_CUT` naming the frames that are none (and the nearest). */
function explicitCuts(
	seq: Sequence,
	map: readonly PictureCut[],
	params: ResolvedDecorateParams,
): PictureCut[] {
	const byFrame = new Map(map.map((c) => [c.frame, c]));
	const wanted = params.cuts ?? [];
	const missing = wanted.filter((f) => !byFrame.has(f));
	if (missing.length) {
		const nearest = (f: number) => {
			let best: number | null = null;
			for (const c of map) if (best === null || Math.abs(c.frame - f) < Math.abs(best - f)) best = c.frame;
			return best;
		};
		const where = [
			params.track !== undefined ? ` on ${params.track}` : '',
			params.range ? ` in [${params.range.start}, ${params.range.end})` : '',
		].join('');
		const list = missing
			.slice(0, 10)
			.map((f) => {
				const n = nearest(f);
				return n === null ? String(f) : `${f} (nearest cut ${n}, ${timecodeOf(seq, n)})`;
			})
			.join(', ');
		throw new AutomationInputError(
			'E_NOT_A_CUT',
			`cuts: ${missing.length} frame(s) are not picture cuts${where}: ${list}${missing.length > 10 ? ', …' : ''}. Take the frames from list_cuts.`,
		);
	}
	return wanted.map((f) => byFrame.get(f)!);
}

/** The whoosh media must be a project media with sound (`E_NOT_FOUND` / `E_INVALID_PARAM`). */
function checkWhooshMedia(doc: ProjectDocument, whoosh: WhooshMedia | undefined): void {
	if (!whoosh) return;
	const m = Object.hasOwn(doc.media ?? {}, whoosh.mediaId) ? doc.media[whoosh.mediaId] : undefined;
	if (!m)
		throw new AutomationInputError('E_NOT_FOUND', `sfx.media: no media ${whoosh.mediaId} in the project`);
	const streams = (m as { probe?: { streams?: { type?: string }[] } }).probe?.streams ?? [];
	if (!streams.some((x) => x.type === 'audio'))
		throw new AutomationInputError(
			'E_INVALID_PARAM',
			`sfx.media: ${m.originalName || whoosh.mediaId} has no sound`,
		);
}

function context(seq: Sequence, params: ResolvedDecorateParams): PlanContext {
	const geo = frameGeometry(seq);
	let trackTaken: [number, number][] | null = null;
	if (params.fxTrack !== undefined) {
		const t = videoTrackOf(seq, params.fxTrack);
		if (t.locked) throw new AutomationInputError('E_TRACK_LOCKED', `${params.fxTrack} is locked`);
		trackTaken = trackSpans(seq, t.id);
	}
	return { seq, geo, params, chain: chainWeights(params.weights, params.repeatPenalty), trackTaken };
}

/** Plans the kits of a sequence (see the file comment). Throws `AutomationInputError` for an invalid request. */
export function planDecorateCuts(
	doc: ProjectDocument,
	sequenceId: string | null | undefined,
	rawParams: unknown,
): DecoratePlan {
	const seq = automationSequence(doc, sequenceId);
	const params = resolveDecorateParams(rawParams, frameGeometry(seq));
	const ctx = context(seq, params);
	checkWhooshMedia(doc, params.whoosh);
	const map = cutsOf(doc, seq, params);
	const explicit = params.cuts !== undefined;
	const cuts = explicit ? explicitCuts(seq, map, params) : map;
	const decorated = params.skipDecorated ? adjustmentSpans(seq) : [];
	const kits: KitPlacement[] = [];
	const skipped: DecorateSkip[] = [];
	const skip = (frame: number, code: DecorateSkipCode, reason: string) =>
		skipped.push({ frame, timecode: timecodeOf(seq, frame), code, reason });
	let prevEnd = 0;
	let prevFamily = -1;
	let lastFrame = Number.NEGATIVE_INFINITY;
	const shortest = Math.min(
		...params.pack.families.flatMap((f) =>
			f.variants.map((v) => {
				const s = variantSpan(f, v);
				return s.before + s.after;
			}),
		),
	);
	for (const cut of cuts) {
		const f = cut.frame;
		if (cut.transitionId) {
			skip(f, 'transition', 'the cut has a transition');
			continue;
		}
		if (params.skipDecorated && !spanFree(decorated, f - 1, f + 1)) {
			skip(f, 'decorated', 'an adjustment clip already covers the cut');
			continue;
		}
		if (f - lastFrame < params.minSpacingFrames) {
			skip(f, 'spacing', `closer than ${params.minSpacingFrames} frames to the previous kit`);
			continue;
		}
		const seed = itemSeed(params.seed, DECORATE_PASS, f);
		const rng = seededRandom(seed);
		// an explicit cut list decorates every listed cut (the draw still happens: the same stream as a refresh)
		if (rng() >= params.coverage && !explicit) {
			skip(f, 'coverage', 'left out by the coverage setting');
			continue;
		}
		const lo = Math.max(prevEnd, 0);
		const hi = ctx.geo.duration;
		const picked = chooseKit(ctx, f, lo, hi, prevFamily, rng);
		if (!picked) {
			if (f - shortest / 2 < 0 || f + shortest / 2 > hi)
				skip(f, 'edge', 'too close to the start or end of the sequence for any kit');
			else if (ctx.trackTaken && f >= prevEnd) skip(f, 'track-busy', 'the FX track already has a clip there');
			else skip(f, 'too-close', 'too close to the previous kit for any kit of the pack');
			continue;
		}
		kits.push({
			...picked.choice,
			id: `kit:${f}`,
			frame: f,
			timecode: timecodeOf(seq, f),
			seed,
			cut: cutRef(cut),
			alternatives: alternativesAt(ctx, f, lo, hi, picked.choice, rng),
		});
		prevEnd = picked.choice.end;
		prevFamily = picked.family;
		lastFrame = f;
	}
	// Alternatives may never reach into a neighbouring kit (choosing one in review must keep the kits apart).
	for (let i = 0; i < kits.length; i++) {
		const lo = i > 0 ? kits[i - 1]!.end : 0;
		const hi = i + 1 < kits.length ? kits[i + 1]!.start : ctx.geo.duration;
		kits[i]!.alternatives = kits[i]!.alternatives.filter((a) => a.start >= lo && a.end <= hi);
	}
	const families: Record<string, number> = {};
	for (const k of kits) families[k.family] = (families[k.family] ?? 0) + 1;
	const warnings: { code: string; message: string }[] = [];
	if (cuts.length === 0)
		warnings.push({
			code: 'W_NO_CUTS',
			message:
				params.track === undefined
					? 'The sequence has no picture cuts here (a full-length clip on a top track hides them: choose the A-roll track)'
					: 'The track has no cuts in the range',
		});
	return {
		pass: DECORATE_PASS,
		sequenceId: seq.id,
		pack: { id: params.pack.id, label: params.pack.label },
		seed: params.seed,
		kits,
		skipped,
		considered: cuts.length,
		fxTrack: fxTrackOf(seq, params, kits),
		families,
		warnings,
	};
}

function cutRef(cut: PictureCut): KitPlacement['cut'] {
	return {
		kind: cut.kind,
		trackId: cut.trackId,
		...(cut.outgoingClipId ? { outgoingClipId: cut.outgoingClipId } : {}),
		...(cut.incomingClipId ? { incomingClipId: cut.incomingClipId } : {}),
	};
}

/** The FX track for `kits` (and their alternatives): explicit, a free "FX" track above the picture, or a new one. */
function fxTrackOf(seq: Sequence, params: ResolvedDecorateParams, kits: readonly KitPlacement[]) {
	const spans: [number, number][] = [];
	for (const k of kits) {
		spans.push([k.start, k.end]);
		for (const a of k.alternatives) spans.push([a.start, a.end]);
	}
	// above every track a decorated cut is on (adjustment clips act on what is below them)
	let minIndex = 0;
	for (const k of kits) {
		const i = seq.videoTracks.findIndex((t) => t.id === k.cut.trackId);
		if (i + 1 > minIndex) minIndex = i + 1;
	}
	const r = adjustmentTrackFor(seq, spans, {
		name: 'FX',
		...(params.fxTrack !== undefined ? { ref: params.fxTrack } : {}),
		minIndex,
	});
	return r.create ? { create: true as const, name: r.name } : r;
}

// ---------------------------------------------------------------------------------------------------------------
// Refresh / Reroll of single kits

export type KitTarget = {
	itemId: string;
	/** The seed to plan with (the item's, or the next one for Reroll). */
	seed: number;
	/** Where the cut was planned and its clips (the cut is found again by its clips when it moved). */
	frame: number;
	outgoingClipId?: string;
	incomingClipId?: string;
};

export type KitReplan =
	| { itemId: string; ok: true; kit: KitPlacement }
	| { itemId: string; ok: false; reason: string };

/**
 * Re-plans single kits on the current document (Refresh proposal / Reroll): each target's cut is found again (same
 * clips, else the same frame), the kit drawn with the target's seed in the window the `neighbours` (the other kits of
 * the proposal: [start, end) and family) leave free, the repeat penalty against the nearest earlier neighbour.
 */
export function replanKits(
	doc: ProjectDocument,
	sequenceId: string | null | undefined,
	rawParams: unknown,
	targets: readonly KitTarget[],
	neighbours: readonly { start: number; end: number; family: string }[],
): KitReplan[] {
	const seq = automationSequence(doc, sequenceId);
	const params = resolveDecorateParams(rawParams, frameGeometry(seq));
	const ctx = context(seq, params);
	const cuts = cutsOf(doc, seq, { ...params, range: undefined } as ResolvedDecorateParams);
	const decorated = params.skipDecorated ? adjustmentSpans(seq) : [];
	const famIndex = new Map(params.pack.families.map((f, i) => [f.id, i]));
	const placed: { start: number; end: number; family: string }[] = [...neighbours];
	const out: KitReplan[] = [];
	for (const t of targets) {
		const cut =
			(t.outgoingClipId && t.incomingClipId
				? cuts.find((c) => c.outgoingClipId === t.outgoingClipId && c.incomingClipId === t.incomingClipId)
				: undefined) ?? cuts.find((c) => c.frame === t.frame && !t.outgoingClipId && !t.incomingClipId);
		if (!cut) {
			out.push({ itemId: t.itemId, ok: false, reason: 'the cut it decorated is gone' });
			continue;
		}
		const f = cut.frame;
		if (cut.transitionId) {
			out.push({ itemId: t.itemId, ok: false, reason: 'the cut now has a transition' });
			continue;
		}
		if (params.skipDecorated && !spanFree(decorated, f - 1, f + 1)) {
			out.push({ itemId: t.itemId, ok: false, reason: 'an adjustment clip now covers the cut' });
			continue;
		}
		let lo = 0;
		let hi = ctx.geo.duration;
		let prev: { end: number; family: string } | null = null;
		for (const n of placed) {
			if (n.end <= f && n.end > lo) lo = n.end;
			if (n.start >= f && n.start < hi) hi = n.start;
			if (n.start < f && n.end > f) {
				// a neighbour already spans this cut: nothing fits
				lo = hi;
			}
			if (n.end <= f && (!prev || n.end > prev.end)) prev = n;
		}
		const rng = seededRandom(t.seed);
		rng(); // the coverage draw of the full pass: same stream positions
		const picked = chooseKit(ctx, f, lo, hi, prev ? (famIndex.get(prev.family) ?? -1) : -1, rng);
		if (!picked) {
			out.push({ itemId: t.itemId, ok: false, reason: 'no kit of the pack fits between its neighbours now' });
			continue;
		}
		const kit: KitPlacement = {
			...picked.choice,
			id: t.itemId,
			frame: f,
			timecode: timecodeOf(seq, f),
			seed: t.seed,
			cut: cutRef(cut),
			alternatives: alternativesAt(ctx, f, lo, hi, picked.choice, rng),
		};
		placed.push({ start: kit.start, end: kit.end, family: kit.family });
		out.push({ itemId: t.itemId, ok: true, kit });
	}
	return out;
}
