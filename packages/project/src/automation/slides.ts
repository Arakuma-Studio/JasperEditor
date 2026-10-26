// Overlay slides planner (spec 15 EA-024, EA-030, EA-032): one-sided Smooth Slide transitions (`jasper.smooth-slide`)
// at the free heads and tails of overlay clips — pictures (images, B-roll video) on the video tracks above the A-roll.
// Measured on the user's projects (FINDINGS §3, research events.csv): 30-frame slides, one-sided, at 166 overlay heads
// and 57 tails of 312 overlays (shares 0.53 / 0.18), directions down 47 % / up 33 % / left 13 % / right 8 %, Ease In
// Out Quad 68 % / Cubic 32 %, motion blur High over a 360° shutter, no dolly or reflection. A head (tail) is free when
// no clip of the same track ends (starts) there and it has no transition: `transition.add {clipId, edge}` then makes a
// one-sided transition (from / to transparent over the clip's own frames). Each edge draws whether it slides, its
// direction and easing from its own seed. GPU transitions export through the span bake (hybrid) or the Remotion
// path. Pure.
import { clipsOnTrack, trackLabel } from '../derive/index.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence, Track } from '../schema/sequence.ts';
import {
	AutomationInputError,
	automationSequence,
	basePictureTrack,
	frameGeometry,
	passTrack,
	timecodeOf,
	videoTrackOf,
} from './common.ts';
import { AUTOMATION_DEFAULTS, SLIDE_DIRECTIONS, SLIDE_EASINGS, SlideParamsSchema } from './params.ts';
import { itemSeed, seededRandom, weightedIndex } from './rng.ts';

export const SLIDES_PASS = 'slides' as const;
export const SMOOTH_SLIDE_ID = 'jasper.smooth-slide';

/** Picture kinds that are overlays (B-roll, images). */
const OVERLAY_KINDS: ReadonlySet<string> = new Set(['video', 'still', 'animated-image', 'nest-video']);

export type SlideDirection = (typeof SLIDE_DIRECTIONS)[number];
export type SlideEasing = (typeof SLIDE_EASINGS)[number];

export type SlideChoice = { direction: SlideDirection; easing: SlideEasing };

export type SlidePlacement = {
	/** Proposal item id: `slide:<clip id>:in|out`. */
	id: string;
	clipId: string;
	clipName: string;
	trackId: string;
	edge: 'in' | 'out';
	/** The slide's span [frame, end) on the clip's own frames. */
	frame: number;
	end: number;
	frames: number;
	timecode: string;
	seed: number;
	choice: SlideChoice;
	/** The other directions (Review ⇄). */
	alternatives: SlideChoice[];
};

export type ResolvedSlideParams = {
	frames: number;
	heads: number;
	tails: number;
	directions: number[];
	easings: number[];
	motionBlur: 'off' | 'low' | 'medium' | 'high';
	shutterAngle: number;
	seed: number;
	track?: string;
	overlayTracks?: string[];
	range?: { start: number; end: number };
};

export type SlideSkip = { frame: number; timecode: string; code: string; reason: string; clipId?: string };

export type SlidePlan = {
	pass: typeof SLIDES_PASS;
	sequenceId: string;
	seed: number;
	slides: SlidePlacement[];
	/** Overlay edges considered (heads + tails of the overlays in the range). */
	considered: number;
	overlays: number;
	skipped: SlideSkip[];
	params: Pick<ResolvedSlideParams, 'motionBlur' | 'shutterAngle'>;
	warnings: { code: string; message: string }[];
};

export function resolveSlideParams(raw: unknown): ResolvedSlideParams {
	const parsed = SlideParamsSchema.safeParse(raw ?? {});
	if (!parsed.success)
		throw new AutomationInputError(
			'E_INVALID_PARAM',
			parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '),
		);
	const p = parsed.data;
	const D = AUTOMATION_DEFAULTS;
	const directions = SLIDE_DIRECTIONS.map(
		(d) => p.directions?.[d] ?? (p.directions ? 0 : D.slideDirections[d]),
	);
	const easings = SLIDE_EASINGS.map((e) => p.easings?.[e] ?? (p.easings ? 0 : D.slideEasings[e]));
	if (!directions.some((w) => w > 0))
		throw new AutomationInputError(
			'E_INVALID_PARAM',
			'directions: at least one direction needs a weight above 0',
		);
	if (!easings.some((w) => w > 0))
		throw new AutomationInputError('E_INVALID_PARAM', 'easings: at least one easing needs a weight above 0');
	return {
		frames: p.frames ?? D.slideFrames,
		heads: p.heads ?? D.slideHeads,
		tails: p.tails ?? D.slideTails,
		directions,
		easings,
		motionBlur: p.motionBlur ?? D.slideMotionBlur,
		shutterAngle: p.shutterAngle ?? D.slideShutterAngle,
		seed: p.seed ?? D.seed,
		...(p.track !== undefined ? { track: p.track } : {}),
		...(p.overlayTracks ? { overlayTracks: p.overlayTracks } : {}),
		...(p.range ? { range: p.range } : {}),
	};
}

/** Tracks the other passes create (reactions, cut kits, punch-ins, stingers): their clips are not overlays. */
const PASS_TRACK_NAME = /^(reactions|fx|zoom|stingers)(?: \d+)?$/i;

/**
 * The tracks whose picture clips are overlays: the given ones, else every video track above the A-roll except the
 * tracks of the other automation passes ("Reactions", "FX", "ZOOM", "Stingers").
 */
export function overlayTracksOf(
	seq: Sequence,
	p: Pick<ResolvedSlideParams, 'track' | 'overlayTracks'>,
): Track[] {
	if (p.overlayTracks) return p.overlayTracks.map((r) => videoTrackOf(seq, r));
	const a = p.track !== undefined ? passTrack(seq, p.track) : basePictureTrack(seq);
	const ai = a ? seq.videoTracks.findIndex((t) => t.id === a.id) : -1;
	return seq.videoTracks.filter((t, i) => i > ai && !PASS_TRACK_NAME.test((t.name ?? '').trim()));
}

/** Whether a clip edge is free: no clip of its track abuts it there and no transition sits on it. */
export function edgeFree(seq: Sequence, c: Clip, edge: 'in' | 'out'): boolean {
	const at = edge === 'in' ? c.start : c.start + c.duration;
	for (const o of clipsOnTrack(seq, c.trackId)) {
		if (o.id === c.id) continue;
		if (edge === 'in' && o.start + o.duration === at) return false;
		if (edge === 'out' && o.start === at) return false;
	}
	for (const t of Object.values(seq.transitions ?? {}))
		if ((edge === 'in' && t.incomingClipId === c.id) || (edge === 'out' && t.outgoingClipId === c.id))
			return false;
	return true;
}

function choose(
	seed: number,
	p: ResolvedSlideParams,
): { take: number; choice: SlideChoice; alternatives: SlideChoice[] } {
	const rng = seededRandom(seed);
	const take = rng();
	const di = Math.max(0, weightedIndex(p.directions, rng()));
	const ei = Math.max(0, weightedIndex(p.easings, rng()));
	const easing = SLIDE_EASINGS[ei]!;
	const choice = { direction: SLIDE_DIRECTIONS[di]!, easing };
	const alternatives = SLIDE_DIRECTIONS.filter((_d, i) => i !== di && p.directions[i]! > 0).map((d) => ({
		direction: d,
		easing,
	}));
	return { take, choice, alternatives };
}

function placeEdge(
	seq: Sequence,
	c: Clip,
	edge: 'in' | 'out',
	seed: number,
	frames: number,
	choice: ReturnType<typeof choose>,
): SlidePlacement {
	const frame = edge === 'in' ? c.start : c.start + c.duration - frames;
	return {
		id: `slide:${c.id}:${edge}`,
		clipId: c.id,
		clipName: c.name,
		trackId: c.trackId,
		edge,
		frame,
		end: frame + frames,
		frames,
		timecode: timecodeOf(seq, frame),
		seed,
		choice: choice.choice,
		alternatives: choice.alternatives,
	};
}

/** Plans the overlay slides of a sequence (see the file comment). */
export function planSlides(
	doc: ProjectDocument,
	sequenceId: string | null | undefined,
	rawParams: unknown,
): SlidePlan {
	const seq = automationSequence(doc, sequenceId);
	const p = resolveSlideParams(rawParams);
	const geo = frameGeometry(seq);
	const tracks = overlayTracksOf(seq, p);
	const slides: SlidePlacement[] = [];
	const skipped: SlideSkip[] = [];
	const skip = (frame: number, code: string, reason: string, clipId?: string) =>
		skipped.push({ frame, timecode: timecodeOf(seq, frame), code, reason, ...(clipId ? { clipId } : {}) });
	let overlays = 0;
	for (const t of tracks) {
		for (const c of clipsOnTrack(seq, t.id)) {
			if (!OVERLAY_KINDS.has(c.kind) || c.enabled === false) continue;
			if (p.range && (c.start < p.range.start || c.start + c.duration > p.range.end)) continue;
			// a full-length layer (a pre-render, a background) is not an overlay
			if (geo.duration > 30 && c.duration >= 0.9 * geo.duration) continue;
			overlays++;
			if (t.locked) {
				skip(c.start, 'locked', 'its track is locked', c.id);
				continue;
			}
			const both: ('in' | 'out')[] = ['in', 'out'];
			const wanted = both.map((edge) => {
				const seed = itemSeed(p.seed, SLIDES_PASS, `${c.id}:${edge}`);
				const ch = choose(seed, p);
				return { edge, seed, ch, take: ch.take < (edge === 'in' ? p.heads : p.tails) };
			});
			const n = wanted.filter((w) => w.take).length;
			for (const w of wanted) {
				const at = w.edge === 'in' ? c.start : c.start + c.duration;
				if (!w.take) {
					skip(at, 'share', `left out by the ${w.edge === 'in' ? 'heads' : 'tails'} share`, c.id);
					continue;
				}
				if (!edgeFree(seq, c, w.edge)) {
					skip(at, 'not-free', 'another clip or a transition touches this edge', c.id);
					continue;
				}
				// both slides must fit on the clip's own frames
				if (c.duration < p.frames * n) {
					skip(at, 'short', `the clip is shorter than ${n > 1 ? 'two slides' : 'the slide'}`, c.id);
					continue;
				}
				slides.push(placeEdge(seq, c, w.edge, w.seed, p.frames, w.ch));
			}
		}
	}
	slides.sort((a, b) => a.frame - b.frame || a.id.localeCompare(b.id));
	const warnings: { code: string; message: string }[] = [];
	if (!overlays)
		warnings.push({
			code: 'W_NO_OVERLAYS',
			message: 'No overlay clips (pictures on the video tracks above the A-roll) in the range',
		});
	return {
		pass: SLIDES_PASS,
		sequenceId: seq.id,
		seed: p.seed,
		slides,
		considered: overlays * 2,
		overlays,
		skipped: skipped.sort((a, b) => a.frame - b.frame),
		params: { motionBlur: p.motionBlur, shutterAngle: p.shutterAngle },
		warnings,
	};
}

/** Re-plans single slides (Refresh / Reroll): the clip must still be an overlay with that edge free. */
export function replanSlides(
	doc: ProjectDocument,
	sequenceId: string | null | undefined,
	rawParams: unknown,
	targets: readonly { itemId: string; clipId: string; edge: 'in' | 'out'; seed: number }[],
): ({ itemId: string; ok: true; slide: SlidePlacement } | { itemId: string; ok: false; reason: string })[] {
	const seq = automationSequence(doc, sequenceId);
	const p = resolveSlideParams(rawParams);
	const overlayTrackIds = new Set(overlayTracksOf(seq, p).map((t) => t.id));
	return targets.map((t) => {
		const c = seq.clips[t.clipId];
		if (!c || !overlayTrackIds.has(c.trackId) || !OVERLAY_KINDS.has(c.kind))
			return { itemId: t.itemId, ok: false as const, reason: 'its overlay clip is gone' };
		if (!edgeFree(seq, c, t.edge))
			return {
				itemId: t.itemId,
				ok: false as const,
				reason: 'another clip or a transition touches the edge now',
			};
		if (c.duration < p.frames)
			return { itemId: t.itemId, ok: false as const, reason: 'the clip is shorter than the slide now' };
		return {
			itemId: t.itemId,
			ok: true as const,
			slide: { ...placeEdge(seq, c, t.edge, t.seed, p.frames, choose(t.seed, p)), id: t.itemId },
		};
	});
}

/** Label of an overlay's track (why-lines). */
export const slideTrackLabel = (seq: Sequence, trackId: string) => trackLabel(seq, trackId) ?? trackId;
