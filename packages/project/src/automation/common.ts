// Shared helpers of the editing-automation planners (spec 15 EA-030): the A-roll track, clip candidates, tracks for
// the new adjustment clips, frame geometry and errors. Pure; never throws for damaged documents except the typed
// `AutomationInputError` for what the caller asked (an unknown sequence or track).
import { clipsOnTrack, resolveTrackRef, sequenceDuration, trackLabel } from '../derive/index.ts';
import { intrinsicBoxOf } from '../registry/properties.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence, Track } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import { formatTimecode } from '../timecode.ts';
import type { AutomationRange } from './params.ts';

/** A refusal of a pass's input: `E_NOT_FOUND` (sequence, track) or `E_INVALID_PARAM`. */
export class AutomationInputError extends Error {
	constructor(
		readonly code: 'E_NOT_FOUND' | 'E_INVALID_PARAM' | 'E_TRACK_LOCKED',
		message: string,
	) {
		super(message);
		this.name = 'AutomationInputError';
	}
}

/** The sequence a pass works on: the given one, else the project's first. */
export function automationSequence(doc: ProjectDocument, sequenceId?: string | null): Sequence {
	const id = sequenceId ?? Object.keys(doc.sequences ?? {})[0];
	const seq = id ? doc.sequences?.[id] : undefined;
	if (!seq) throw new AutomationInputError('E_NOT_FOUND', `Sequence not found: ${sequenceId ?? '(none)'}`);
	return seq;
}

export type FrameGeometry = {
	fps: Rational;
	width: number;
	height: number;
	/** Vertical (shorts) when the frame is taller than wide. */
	vertical: boolean;
	/** Short side ÷ 1080: pixel parameters of the kits scale by it. */
	pxScale: number;
	duration: number;
};

export function frameGeometry(seq: Sequence): FrameGeometry {
	const s = seq.settings;
	const fps =
		s?.frameRate && s.frameRate.num > 0 && s.frameRate.den > 0
			? s.frameRate
			: ({ num: 30, den: 1 } as Rational);
	const width = Number.isFinite(s?.width) && s.width > 0 ? s.width : 1920;
	const height = Number.isFinite(s?.height) && s.height > 0 ? s.height : 1080;
	return {
		fps,
		width,
		height,
		vertical: height > width,
		pxScale: Math.min(width, height) / 1080,
		duration: sequenceDuration(seq),
	};
}

export const fpsValue = (fps: Rational) => fps.num / fps.den;

/** "00:00:03:12" for reports and why-lines. */
export function timecodeOf(seq: Sequence, frame: number): string {
	try {
		return formatTimecode(frame, seq.settings.frameRate as Rational, {
			dropFrame: seq.settings.dropFrame,
			startFrames: seq.settings.startTimecodeFrames ?? 0,
		});
	} catch {
		return String(frame);
	}
}

/** A video track by id or label (`V2`), else `E_NOT_FOUND` / `E_INVALID_PARAM` (not a video track). */
export function videoTrackOf(seq: Sequence, ref: string): Track {
	const id = resolveTrackRef(seq, ref);
	const t = id ? seq.videoTracks.find((x) => x.id === id) : undefined;
	if (!t) {
		if (id && (seq.audioTracks.some((x) => x.id === id) || seq.captionTracks?.some((x) => x.id === id)))
			throw new AutomationInputError('E_INVALID_PARAM', `${ref} is not a video track`);
		throw new AutomationInputError('E_NOT_FOUND', `Track not found: ${ref}`);
	}
	return t;
}

/** Clips that show a picture of a source (the A-roll kinds). */
const PICTURE_KINDS: ReadonlySet<string> = new Set(['video', 'nest-video', 'still', 'animated-image']);
const isPicture = (c: Clip) => PICTURE_KINDS.has(c.kind) && c.enabled !== false;

/**
 * The A-roll track: the lowest video track carrying ≥ 60 % of the most picture any one track carries (video and nest
 * clips, leaving out clips covering ≥ 90 % of the sequence: full-length pre-renders and backgrounds). The research's
 * rule (FINDINGS §1, "A-roll track"). Null when no track has picture.
 */
export function aRollTrack(seq: Sequence): Track | null {
	const total = sequenceDuration(seq);
	const per = new Map<string, number>();
	for (const c of Object.values(seq.clips ?? {})) {
		if (!(c.kind === 'video' || c.kind === 'nest-video') || c.enabled === false) continue;
		if (total > 0 && c.duration >= 0.9 * total && total > 30) continue;
		per.set(c.trackId, (per.get(c.trackId) ?? 0) + c.duration);
	}
	let best = 0;
	for (const v of per.values()) best = Math.max(best, v);
	if (!(best > 0)) return null;
	for (const t of seq.videoTracks) if ((per.get(t.id) ?? 0) >= 0.6 * best) return t;
	return null;
}

/**
 * The base picture of the overlay passes (reactions, slides): the lowest video track whose enabled picture clips
 * (and colour mattes) cover at least half of the sequence — a single full-length take included, which `aRollTrack` leaves out as a possible
 * pre-render — else `aRollTrack`, else the lowest video track with a picture clip; null without picture.
 */
export function basePictureTrack(seq: Sequence): Track | null {
	const total = sequenceDuration(seq);
	const per = new Map<string, number>();
	// colour mattes count as base picture too (a background under the overlays)
	for (const c of Object.values(seq.clips ?? {}))
		if (isPicture(c) || (c.kind === 'solid' && c.enabled !== false))
			per.set(c.trackId, (per.get(c.trackId) ?? 0) + c.duration);
	if (total > 0) for (const t of seq.videoTracks) if ((per.get(t.id) ?? 0) >= 0.5 * total) return t;
	const a = aRollTrack(seq);
	if (a) return a;
	for (const t of seq.videoTracks) if ((per.get(t.id) ?? 0) > 0) return t;
	return null;
}

/** The A-roll track a pass uses: `ref` when given, else `aRollTrack`; `E_NOT_FOUND` when there is none. */
export function passTrack(seq: Sequence, ref: string | undefined): Track {
	if (ref !== undefined) return videoTrackOf(seq, ref);
	const t = aRollTrack(seq);
	if (!t) throw new AutomationInputError('E_NOT_FOUND', 'The sequence has no video clips to work on');
	return t;
}

const MOTION_PATHS = ['position', 'anchor', 'scale', 'scaleWidth', 'rotation'] as const;

/** The clip's Motion is keyframed (Ken Burns, an earlier punch-in, a reframe). */
export function hasMotionKeys(c: Clip): boolean {
	const tr = (c as { transform?: Record<string, { keyframes?: unknown[] } | undefined> }).transform;
	if (!tr) return false;
	return MOTION_PATHS.some((k) => Array.isArray(tr[k]?.keyframes) && tr[k]!.keyframes!.length > 0);
}

/** Effects that move the picture themselves: a zoom on top would fight them (EA-021 "kit-incompatible"). */
const MOVING_EFFECTS: ReadonlySet<string> = new Set([
	'jasper.transform',
	'jasper.s.shake',
	'jasper.corner-pin',
	'jasper.warp-stabilizer',
]);

export function hasMovingEffect(c: Clip): boolean {
	const fx = (c as { effects?: { effectId: string; enabled?: boolean }[] }).effects ?? [];
	return fx.some((e) => e.enabled !== false && MOVING_EFFECTS.has(e.effectId));
}

/**
 * The clip has a static reframing of its own: a scale other than 100 % or the scale that fits / fills the frame with
 * its picture, a position off the frame centre, or a rotation (the user's "static framing": a punch-in on such a
 * clip is rare, 17 % vs 66 %, FINDINGS §3 / simulate.py). Keyframed Motion is `hasMotionKeys`.
 */
export function isReframed(doc: ProjectDocument, seq: Sequence, c: Clip): boolean {
	const tr = (c as { transform?: Record<string, { value?: unknown } | boolean | undefined> }).transform;
	if (!tr) return false;
	const val = (k: string) => {
		const x = tr[k];
		return x && typeof x === 'object' ? x.value : undefined;
	};
	const geo = frameGeometry(seq);
	const scale = typeof val('scale') === 'number' ? (val('scale') as number) : 100;
	const rot = typeof val('rotation') === 'number' ? (val('rotation') as number) : 0;
	const pos = Array.isArray(val('position'))
		? (val('position') as number[])
		: [geo.width / 2, geo.height / 2];
	if (Math.abs(rot) > 0.01) return true;
	if (Math.abs((pos[0] ?? 0) - geo.width / 2) > 1 || Math.abs((pos[1] ?? 0) - geo.height / 2) > 1)
		return true;
	let box: { width: number; height: number } | null = null;
	try {
		box = intrinsicBoxOf({ clip: c, doc, seq } as never);
	} catch {
		box = null;
	}
	const ok = [100];
	if (box && box.width > 0 && box.height > 0) {
		ok.push(Math.min(geo.width / box.width, geo.height / box.height) * 100);
		ok.push(Math.max(geo.width / box.width, geo.height / box.height) * 100);
	}
	return !ok.some((s) => Math.abs(s - scale) <= Math.max(0.5, s * 0.005));
}

export type ClipSkip = { clipId: string; frame: number; code: string; reason: string };

/**
 * A-roll clips of `track` inside `range` (whole clips) that a punch-in or a Ken Burns move may decorate: picture
 * clips of at least `minFrames`, Motion not keyframed, no picture-moving effect, unlocked track, not excluded. The
 * others in the range are listed with why (frame order).
 */
export function motionCandidates(
	seq: Sequence,
	track: Track,
	opts: {
		range?: AutomationRange;
		minFrames: number;
		exclude?: ReadonlySet<string>;
		/** Leave clips with a static reframing alone (`isReframed`; `doc` needed). */
		skipReframed?: ProjectDocument;
	},
): { clips: Clip[]; skipped: ClipSkip[] } {
	const clips: Clip[] = [];
	const skipped: ClipSkip[] = [];
	const list = clipsOnTrack(seq, track.id);
	for (const c of list) {
		if (opts.range && (c.start < opts.range.start || c.start + c.duration > opts.range.end)) continue;
		const skip = (code: string, reason: string) =>
			skipped.push({ clipId: c.id, frame: c.start, code, reason });
		if (!isPicture(c)) {
			if (c.kind !== 'adjustment') skip('kind', `a ${c.kind} clip`);
			continue;
		}
		if (opts.exclude?.has(c.id)) skip('excluded', 'left to another pass');
		else if (c.duration < opts.minFrames) skip('short', 'shorter than the minimum length');
		else if (hasMotionKeys(c)) skip('motion', 'its Motion is already keyframed (Ken Burns or a zoom)');
		else if (hasMovingEffect(c)) skip('effect', 'an effect already moves its picture');
		else if (opts.skipReframed && isReframed(opts.skipReframed, seq, c))
			skip('reframed', 'it has a static reframing of its own (scale or position)');
		else clips.push(c);
	}
	return { clips, skipped };
}

/** [start, end) of the clips on a track. */
export function trackSpans(seq: Sequence, trackId: string): [number, number][] {
	return clipsOnTrack(seq, trackId).map((c) => [c.start, c.start + c.duration]);
}

/** Whether a span [a, b) is free of every span of `taken` (sorted or not). */
export function spanFree(taken: readonly (readonly [number, number])[], a: number, b: number): boolean {
	for (const [s, e] of taken) if (s < b && e > a) return false;
	return true;
}

/**
 * A video track for new adjustment clips covering `spans`: the explicit `ref` (must be an unlocked video track), else
 * the first track (from `fromIndex` up, or from the top when `topDown`) named like `name` ("FX", "FX 2") that is free
 * and unlocked; null = a new track named `name` (or `name n` when that name is taken) must be created.
 */
export function adjustmentTrackFor(
	seq: Sequence,
	spans: readonly (readonly [number, number])[],
	opts: { name: string; ref?: string; minIndex?: number },
): { trackId: string; label: string; create: false } | { create: true; name: string; index?: number } {
	if (opts.ref !== undefined) {
		const t = videoTrackOf(seq, opts.ref);
		if (t.locked) throw new AutomationInputError('E_TRACK_LOCKED', `${opts.ref} is locked`);
		return { trackId: t.id, label: trackLabel(seq, t.id) ?? t.id, create: false };
	}
	const re = new RegExp(`^${opts.name}(?: \\d+)?$`, 'i');
	const min = opts.minIndex ?? 0;
	const tracks = seq.videoTracks.map((t, i) => ({ t, i })).filter(({ i }) => i >= min);
	for (const { t } of tracks.reverse()) {
		if (t.locked || !re.test((t.name ?? '').trim())) continue;
		const taken = trackSpans(seq, t.id);
		if (spans.every(([a, b]) => spanFree(taken, a, b)))
			return { trackId: t.id, label: trackLabel(seq, t.id) ?? t.id, create: false };
	}
	const names = new Set(seq.videoTracks.map((t) => (t.name ?? '').trim().toLowerCase()));
	let name = opts.name;
	for (let n = 2; names.has(name.toLowerCase()) && n < 1000; n++) name = `${opts.name} ${n}`;
	return { create: true, name, ...(opts.minIndex !== undefined ? { index: opts.minIndex } : {}) };
}

/** Flicks of one sequence frame. */
export function frameFlicks(seq: Sequence): number {
	return flicksPerFrame(frameGeometry(seq).fps);
}
