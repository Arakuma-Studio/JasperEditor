// Ken Burns planner (spec 15 EA-022, EA-030, EA-032): `share` (15 %) of the A-roll's clips, chosen among those no
// move or zoom decorates yet, get a slow zoom over the whole clip — keys on its first and last frame, linear, 100 → 118 % on vertical
// sequences / 130 % on landscape ones (measured: 13–16 % of A-roll clips, 100 → 115–122 % shorts, ≈ 130 % long), zoom-in
// and zoom-out 2 : 1 by each clip's seed — about the frame centre (a centred clip keeps its position). Motion keys:
// exported natively. Pure.
import type { Vec2 } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import {
	AutomationInputError,
	automationSequence,
	type ClipSkip,
	type FrameGeometry,
	fpsValue,
	frameGeometry,
	motionCandidates,
	passTrack,
	timecodeOf,
} from './common.ts';
import { AUTOMATION_DEFAULTS, type KenBurnsParams, KenBurnsParamsSchema } from './params.ts';
import { type MotionPlan, zoomMotion } from './punch-ins.ts';
import { itemSeed, seededRandom } from './rng.ts';

export const KEN_BURNS_PASS = 'ken-burns' as const;

export type KenBurnsPlacement = {
	/** Proposal item id: `kb:<clip id>`. */
	id: string;
	clipId: string;
	clipName: string;
	frame: number;
	end: number;
	timecode: string;
	seed: number;
	direction: 'in' | 'out';
	scale: number;
	motion: MotionPlan;
	/** The opposite direction (Review ⇄). */
	alternative: { direction: 'in' | 'out'; motion: MotionPlan };
};

export type ResolvedKenBurnsParams = {
	share: number;
	scale: number;
	inShare: number;
	minFrames: number;
	exclude: Set<string>;
	seed: number;
	track?: string;
	range?: { start: number; end: number };
};

export type KenBurnsPlan = {
	pass: typeof KEN_BURNS_PASS;
	sequenceId: string;
	trackId: string;
	seed: number;
	moves: KenBurnsPlacement[];
	candidates: number;
	skipped: (ClipSkip & { timecode: string })[];
	warnings: { code: string; message: string }[];
};

export function resolveKenBurnsParams(
	raw: unknown,
	geo: Pick<FrameGeometry, 'fps' | 'vertical'>,
): ResolvedKenBurnsParams {
	const parsed = KenBurnsParamsSchema.safeParse(raw ?? {});
	if (!parsed.success)
		throw new AutomationInputError(
			'E_INVALID_PARAM',
			parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '),
		);
	const p: KenBurnsParams = parsed.data;
	const ratio = p.inOutRatio ?? AUTOMATION_DEFAULTS.kenBurnsInOutRatio;
	return {
		share: p.share ?? AUTOMATION_DEFAULTS.kenBurnsShare,
		scale:
			p.scale ??
			(geo.vertical ? AUTOMATION_DEFAULTS.kenBurnsScaleVertical : AUTOMATION_DEFAULTS.kenBurnsScaleLandscape),
		inShare: ratio / (ratio + 1),
		minFrames: Math.max(
			2,
			Math.ceil((p.minClipSeconds ?? AUTOMATION_DEFAULTS.kenBurnsMinClipSeconds) * fpsValue(geo.fps) - 1e-6),
		),
		exclude: new Set(p.excludeClipIds ?? []),
		seed: p.seed ?? AUTOMATION_DEFAULTS.seed,
		...(p.track !== undefined ? { track: p.track } : {}),
		...(p.range ? { range: p.range } : {}),
	};
}

function motionOfClip(c: Clip, geo: FrameGeometry) {
	const tr = (c as { transform?: Record<string, { value?: unknown } | boolean> }).transform;
	const v = <T>(k: string, d: T): T => {
		const x = tr?.[k];
		return x && typeof x === 'object' && 'value' in x ? (x.value as T) : d;
	};
	return {
		position: v<Vec2>('position', [geo.width / 2, geo.height / 2]),
		anchor: v<Vec2>('anchor', [geo.width / 2, geo.height / 2]),
		scale: v<number>('scale', 100),
		scaleWidth: v<number>('scaleWidth', 100),
		uniformScale: tr?.uniformScale !== false,
		rotation: v<number>('rotation', 0),
		flipH: tr?.flipH === true,
		flipV: tr?.flipV === true,
	};
}

function placeOne(seq: Sequence, c: Clip, params: ResolvedKenBurnsParams, seed: number): KenBurnsPlacement {
	const geo = frameGeometry(seq);
	const rng = seededRandom(seed);
	rng(); // the selection draw
	const direction: 'in' | 'out' = rng() < params.inShare ? 'in' : 'out';
	const m = motionOfClip(c, geo);
	const centre: Vec2 = [geo.width / 2, geo.height / 2];
	const last = c.duration - 1;
	const k = params.scale / 100;
	const other = direction === 'in' ? 'out' : 'in';
	return {
		id: `kb:${c.id}`,
		clipId: c.id,
		clipName: c.name,
		frame: c.start,
		end: c.start + c.duration,
		timecode: timecodeOf(seq, c.start),
		seed,
		direction,
		scale: params.scale,
		motion: zoomMotion(m, k, centre, 0, last, direction === 'out'),
		alternative: { direction: other, motion: zoomMotion(m, k, centre, 0, last, other === 'out') },
	};
}

/** Plans the Ken Burns moves of a sequence. Throws `AutomationInputError` for an invalid request. */
export function planKenBurns(
	doc: ProjectDocument,
	sequenceId: string | null | undefined,
	rawParams: unknown,
): KenBurnsPlan {
	const seq = automationSequence(doc, sequenceId);
	const geo = frameGeometry(seq);
	const params = resolveKenBurnsParams(rawParams, geo);
	const track = passTrack(seq, params.track);
	const cand = motionCandidates(seq, track, {
		minFrames: params.minFrames,
		exclude: params.exclude,
		...(params.range ? { range: params.range } : {}),
	});
	const ranked = cand.clips
		.map((c) => {
			const seed = itemSeed(params.seed, KEN_BURNS_PASS, c.id);
			return { c, seed, draw: seededRandom(seed)() };
		})
		.sort((a, b) => a.draw - b.draw || a.c.start - b.c.start);
	// `share` of all the A-roll's picture clips in the range (the measured 13–16 % are of every A-roll clip), chosen
	// among the clips no punch-in or move decorates yet
	const pictureClips = cand.clips.length + cand.skipped.filter((s) => s.code !== 'kind').length;
	const count = Math.min(ranked.length, Math.round(params.share * pictureClips));
	const moves = ranked
		.slice(0, count)
		.sort((a, b) => a.c.start - b.c.start)
		.map((x) => placeOne(seq, x.c, params, x.seed));
	const skipped = [
		...cand.skipped,
		...ranked.slice(count).map((x) => ({
			clipId: x.c.id,
			frame: x.c.start,
			code: 'share',
			reason: 'left out by the share setting',
		})),
	]
		.sort((a, b) => a.frame - b.frame)
		.map((s) => ({ ...s, timecode: timecodeOf(seq, s.frame) }));
	return {
		pass: KEN_BURNS_PASS,
		sequenceId: seq.id,
		trackId: track.id,
		seed: params.seed,
		moves,
		candidates: cand.clips.length,
		skipped,
		warnings: [],
	};
}

/** Re-plans single moves (Refresh / Reroll): the clip must still be a candidate. */
export function replanKenBurns(
	doc: ProjectDocument,
	sequenceId: string | null | undefined,
	rawParams: unknown,
	targets: readonly { itemId: string; clipId: string; seed: number }[],
): ({ itemId: string; ok: true; move: KenBurnsPlacement } | { itemId: string; ok: false; reason: string })[] {
	const seq = automationSequence(doc, sequenceId);
	const params = resolveKenBurnsParams(rawParams, frameGeometry(seq));
	const track = passTrack(seq, params.track);
	const cand = motionCandidates(seq, track, { minFrames: params.minFrames, exclude: params.exclude });
	const byId = new Map(cand.clips.map((c) => [c.id, c]));
	const why = new Map(cand.skipped.map((s) => [s.clipId, s.reason]));
	return targets.map((t) => {
		const c = byId.get(t.clipId);
		if (!c)
			return {
				itemId: t.itemId,
				ok: false as const,
				reason: why.has(t.clipId)
					? `its clip is no longer a candidate: ${why.get(t.clipId)}`
					: 'its clip is gone from the A-roll track',
			};
		return {
			itemId: t.itemId,
			ok: true as const,
			move: { ...placeOne(seq, c, params, t.seed), id: t.itemId },
		};
	});
}
