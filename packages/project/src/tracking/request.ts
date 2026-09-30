// Planning a tracking job from the document (S09:TRK-010, TRK-024, TRU-001): which source frames of the plate's
// media to track from which reference geometry, and how to merge the result. Shared by the UI and the MCP tools
// so "Track Forward", "Track from Here", steps and agents build identical engine requests.
import type { Quad } from '../render/homography.ts';
import type { Vec2 } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { MediaAsset } from '../schema/media.ts';
import type { ClipTracker, TrackerSamples, VideoClip } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import { stepOfRate, trackerGeometryAt } from './samples.ts';

export type TrackMode =
	| 'forward'
	| 'backward'
	| 'both'
	| 'from-here'
	| 'from-here-backward'
	| 'step-forward'
	| 'step-back';
export type TrackQuality = 'fast' | 'balanced' | 'best';

/** Engine request body without the media key (the caller resolves the engine-store locator). */
export type TrackRequestBody = {
	kind: 'point' | 'planar';
	reference: { frame: number; corners?: Vec2[]; point?: Vec2; patch?: number; search?: number };
	range: { startFrame: number; endFrame: number };
	direction: 'forward' | 'backward' | 'both';
	quality: TrackQuality;
};

export type TrackPlan = {
	clipId: string;
	trackerId: string;
	mediaId: string;
	sequenceId: string;
	/** Media frame rate the request's frames refer to. */
	mediaRate: Rational;
	/** Flicks per source frame (the samples' step). */
	step: number;
	request: TrackRequestBody;
	/** How `tracker.setSamples` merges the result. */
	merge: 'replace' | 'span';
};

export type TrackerLocation = { sequenceId: string; clip: VideoClip; tracker: ClipTracker };

/** Finds a tracker anywhere in the document. */
export function findTracker(doc: ProjectDocument, trackerId: string): TrackerLocation | null {
	for (const seq of Object.values(doc.sequences)) {
		for (const clip of Object.values(seq.clips)) {
			if (clip.kind !== 'video') continue;
			const v = clip as VideoClip;
			const tracker = v.trackers?.find((t) => t.id === trackerId);
			if (tracker) return { sequenceId: seq.id, clip: v, tracker };
		}
	}
	return null;
}

/** Nominal frame rate of a media asset's video stream (null for media without video). */
export function mediaFrameRate(asset: MediaAsset | undefined): Rational | null {
	const vs = asset?.probe.streams.find((s) => s.type === 'video');
	return vs && vs.type === 'video' ? { num: vs.frameRate.num, den: vs.frameRate.den } : null;
}

/** Source frames `[first, end)` the clip shows (its content span), clamped to the media when its length is known. */
export function clipSourceFrames(
	clip: Pick<VideoClip, 'sourceIn' | 'duration' | 'speed'>,
	seqRate: Rational,
	step: number,
	mediaDurationFlicks: number | null,
): { startFrame: number; endFrame: number } {
	const span = clip.duration * flicksPerFrame(seqRate) * clip.speed.rate;
	const startFrame = Math.max(0, Math.floor(clip.sourceIn / step + 1e-6));
	let endFrame = Math.max(startFrame + 1, Math.ceil((clip.sourceIn + span) / step - 1e-6));
	if (mediaDurationFlicks && mediaDurationFlicks > 0)
		endFrame = Math.max(startFrame + 1, Math.min(endFrame, Math.round(mediaDurationFlicks / step)));
	return { startFrame, endFrame };
}

function geometryBody(tracker: ClipTracker, g: { corners: Quad | null; point: Vec2 | null }) {
	return {
		...(g.corners ? { corners: g.corners.map((p) => [p[0], p[1]] as Vec2) } : {}),
		...(g.point ? { point: [g.point[0], g.point[1]] as Vec2 } : {}),
		...(tracker.reference.patch !== undefined ? { patch: tracker.reference.patch } : {}),
		...(tracker.reference.search !== undefined ? { search: tracker.reference.search } : {}),
	};
}

/**
 * The engine request for a tracking action. `forward` / `backward` / `both` start from the tracker's reference;
 * `from-here*` and steps start from the tracker's current geometry at content time `at` (e.g. the playhead after a
 * manual correction) and merge over the re-tracked span only.
 */
export function planTrack(
	doc: ProjectDocument,
	trackerId: string,
	opts: { mode: TrackMode; at?: number; quality?: TrackQuality },
): TrackPlan {
	const loc = findTracker(doc, trackerId);
	if (!loc) throw new Error(`Tracker not found: ${trackerId}`);
	const { clip, tracker, sequenceId } = loc;
	const seq = doc.sequences[sequenceId]!;
	const asset = doc.media[clip.mediaId];
	const rate = mediaFrameRate(asset);
	if (!rate) throw new Error('The tracked clip has no video stream');
	const step = stepOfRate(rate);
	const span = clipSourceFrames(clip, seq.settings.frameRate, step, asset?.probe.durationFlicks ?? null);
	const quality = opts.quality ?? 'balanced';
	const fromRef = opts.mode === 'forward' || opts.mode === 'backward' || opts.mode === 'both';
	const t = fromRef ? tracker.reference.time : (opts.at ?? tracker.reference.time);
	const frame = Math.max(0, Math.round(t / step));
	const g = fromRef
		? trackerGeometryAt(tracker, t, { samples: null, smoothing: 0 })
		: trackerGeometryAt(tracker, t, { smoothing: 0 });
	let range: { startFrame: number; endFrame: number };
	let direction: TrackRequestBody['direction'];
	switch (opts.mode) {
		case 'both':
			range = { startFrame: Math.min(span.startFrame, frame), endFrame: Math.max(span.endFrame, frame + 1) };
			direction = 'both';
			break;
		case 'forward':
		case 'from-here':
			range = { startFrame: frame, endFrame: Math.max(span.endFrame, frame + 1) };
			direction = 'forward';
			break;
		case 'backward':
		case 'from-here-backward':
			range = { startFrame: Math.min(span.startFrame, frame), endFrame: frame + 1 };
			direction = 'backward';
			break;
		case 'step-forward':
			range = { startFrame: frame, endFrame: frame + 2 };
			direction = 'forward';
			break;
		case 'step-back':
			range = { startFrame: Math.max(0, frame - 1), endFrame: frame + 1 };
			direction = 'backward';
			break;
	}
	const merge = opts.mode === 'both' || !tracker.samples ? 'replace' : 'span';
	return {
		clipId: clip.id,
		trackerId,
		mediaId: clip.mediaId,
		sequenceId,
		mediaRate: rate,
		step,
		request: {
			kind: tracker.kind,
			reference: { frame, ...geometryBody(tracker, g) },
			range,
			direction,
			quality,
		},
		merge,
	};
}

/** A `track` job result (engine `TrackResult`, source frames) as document samples (content flicks). */
export function samplesFromTrackResult(
	result: { startFrame: number; stride: 2 | 8; data: readonly number[]; confidence: readonly number[] },
	step: number,
): TrackerSamples {
	return {
		start: result.startFrame * step,
		step,
		stride: result.stride,
		data: [...result.data],
		confidence: result.confidence.map((c) => Math.min(1, Math.max(0, c))),
	};
}

/** Clips following a tracker (their `trackedBy` points at it). */
export function trackedTargets(
	doc: ProjectDocument,
	trackerId: string,
): { sequenceId: string; clipId: string; mode: 'corner-pin' | 'transform' }[] {
	const out: { sequenceId: string; clipId: string; mode: 'corner-pin' | 'transform' }[] = [];
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips)) {
			const tb = (c as { trackedBy?: { trackerId: string; mode: 'corner-pin' | 'transform' } }).trackedBy;
			if (tb?.trackerId === trackerId) out.push({ sequenceId: seq.id, clipId: c.id, mode: tb.mode });
		}
	return out;
}

/** Sequence frames `[start, end)` a content-time span `[t0, t1]` of a clip covers (for re-applying a re-track). */
export function sequenceFramesOfContent(
	clip: Pick<VideoClip, 'start' | 'duration' | 'sourceIn' | 'speed'>,
	seqRate: Rational,
	t0: number,
	t1: number,
): { start: number; end: number } | null {
	const F = flicksPerFrame(seqRate) * clip.speed.rate;
	const a = (Math.min(t0, t1) - clip.sourceIn) / F;
	const b = (Math.max(t0, t1) - clip.sourceIn) / F;
	let i0 = Math.floor(a + 1e-6);
	let i1 = Math.ceil(b - 1e-6) + 1;
	if (clip.speed.reverse) [i0, i1] = [clip.duration - i1, clip.duration - i0];
	i0 = Math.max(0, i0);
	i1 = Math.min(clip.duration, i1);
	return i1 > i0 ? { start: clip.start + i0, end: clip.start + i1 } : null;
}
