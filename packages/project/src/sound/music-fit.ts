// Music to picture (spec 12 P6-E11; wp-note "Phase 6 → WP-E7"): the commands that land a music clip's drop on a hero
// frame (a remix planned with anchors, `POST /api/audio/remix-plan {anchors}`) and end a music clip on a bar line
// (Clip ▸ Audio Options ▸ End on Bar). The beats, bars and drops come from the engine's analysis; these helpers turn
// them into ordinary undoable commands (`clip.remix`, `clip.trim`, `transition.add` / `transition.update`) the editor
// and MCP apply in one transaction. Pure; never throws (refusals are returned).
import type { ProjectDocument } from '../schema/document.ts';
import type { AudioClip, Clip, Sequence } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import { frameAtContent } from '../time-remap/model.ts';

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const fpsOf = (rate: Rational) => rate.num / rate.den;
const end = (c: { start: number; duration: number }) => c.start + c.duration;

/** A music clip ends this far (s) before the bar line's attack at least, so no part of it is heard. */
export const END_ON_BAR_LEAD_SEC = 0.003;
/** The fade-out of End on Bar when the tempo is unknown (s). */
export const END_ON_BAR_FADE_SEC = 0.5;

/** The pieces of the remix a clip belongs to (by start), or the clip alone. */
export function remixPiecesOf(seq: Sequence, clip: AudioClip): AudioClip[] {
	const id = (clip.remix as { id?: string } | undefined)?.id;
	if (!id) return [clip];
	return (
		Object.values(seq.clips).filter(
			(c) => c.kind === 'audio' && (c as AudioClip).remix && (c as AudioClip).remix!.id === id,
		) as AudioClip[]
	).sort((a, b) => a.start - b.start);
}

/** The first frame a remix of the clip starts at (a remix is planned from its original clip). */
export function remixStartFrame(clip: AudioClip): number {
	return clip.remix ? clip.remix.original.start : clip.start;
}

/** Seconds of the remix's output at sequence frame `frame` (the anchor's `outputSeconds`). */
export function remixOutputSeconds(clip: AudioClip, frame: number, rate: Rational): number {
	return (frame - remixStartFrame(clip)) / fpsOf(rate);
}

/** A remix plan as the engine returns it (`RemixPlanResult`), the fields the command needs. */
export type RemixPlanLike = {
	bpm: number;
	pieces: { srcSeconds: number; lenSeconds: number }[];
	lengthSeconds: number;
	headTrimSeconds?: number;
	/** Each anchor's source moment (seconds from the clip's content start) and where it lands (seconds of output). */
	anchors?: { sourceSeconds: number; outputSeconds: number; landedSeconds: number }[];
};

/**
 * The `clip.remix` command of a planned remix: the clip's length is the plan's (`lengthSeconds` in frames, at most
 * `maxFrames`), the anchors
 * are recorded (sequence frames) so a later remix lands them again, and a plan that trims the intro gets a one-frame
 * fade-in (no abrupt entry).
 */
export function remixCommandOf(
	clip: AudioClip,
	plan: RemixPlanLike,
	rate: Rational,
	opts: { segments?: number; variations?: number; maxFrames?: number } = {},
): Record<string, unknown> {
	const fps = fpsOf(rate);
	const start = remixStartFrame(clip);
	// the plan's length in frames; never over the room on the track (`maxFrames`: the outro is cut by ≤ half a beat)
	const targetFrames = Math.max(
		1,
		Math.min(
			Math.round(plan.lengthSeconds * fps),
			opts.maxFrames !== undefined && Number.isFinite(opts.maxFrames)
				? Math.floor(opts.maxFrames)
				: Number.POSITIVE_INFINITY,
		),
	);
	const anchors = (plan.anchors ?? [])
		.filter((a) => fin(a.sourceSeconds) && fin(a.outputSeconds))
		.map((a) => ({
			sourceSeconds: Math.max(0, a.sourceSeconds),
			frame: start + Math.round(a.outputSeconds * fps),
		}))
		.filter((a) => a.frame >= start && a.frame < start + targetFrames);
	return {
		type: 'clip.remix',
		clipId: clip.id,
		targetFrames,
		pieces: plan.pieces,
		bpm: plan.bpm,
		...(opts.segments !== undefined ? { segments: opts.segments } : {}),
		...(opts.variations !== undefined ? { variations: opts.variations } : {}),
		...(anchors.length ? { anchors } : {}),
		...((plan.headTrimSeconds ?? 0) > 0.0005 ? { fadeInFrames: 1 } : {}),
	};
}

export type EndOnBarPlan =
	| {
			ok: true;
			clipId: string;
			/** The new end frame (exclusive) of the clip. */
			endFrame: number;
			/** The bar line (media seconds of the downbeat's attack) and where it plays (fractional sequence frame). */
			barSeconds: number;
			barFrame: number;
			fadeFrames: number;
			commands: Record<string, unknown>[];
	  }
	| { ok: false; code: 'E_INVALID_PARAM' | 'E_NOT_FOUND'; message: string };

/**
 * End on Bar (P6-E11): the music clip (or its remix's last piece) ends on a bar line — just before the downbeat's
 * attack (≥ 3 ms; within a frame of it) — with a constant-power fade-out of `fadeSeconds` (default one beat at `bpm`,
 * else 0.5 s, at least a frame) ending there. `direction` 'earlier' (default) takes the last bar line at or before the
 * clip's end; 'nearest' also takes one up to half a bar later when the media and the track have room. `downbeats` are
 * media seconds (the engine's analysis of the clip's media). Returns the commands (one transaction) or a refusal.
 */
export function endOnBarPlan(
	doc: Pick<ProjectDocument, 'media'>,
	seq: Sequence,
	clipId: string,
	downbeats: readonly number[],
	opts: { bpm?: number | null; fadeSeconds?: number; direction?: 'earlier' | 'nearest' } = {},
): EndOnBarPlan {
	const c0 = seq.clips[clipId] as Clip | undefined;
	if (c0?.kind !== 'audio')
		return { ok: false, code: 'E_NOT_FOUND', message: `${clipId} is not an audio clip` };
	const pieces = remixPiecesOf(seq, c0 as AudioClip);
	const clip = pieces[pieces.length - 1]!;
	const rate = seq.settings.frameRate as Rational;
	const fps = fpsOf(rate);
	if (clip.speed.reverse)
		return { ok: false, code: 'E_INVALID_PARAM', message: 'End on Bar needs a clip that plays forwards' };
	const track = seq.audioTracks.find((t) => t.id === clip.trackId);
	if (track?.locked) return { ok: false, code: 'E_INVALID_PARAM', message: 'The music track is locked' };
	if (Object.values(seq.transitions).some((t) => t.outgoingClipId === clip.id && t.incomingClipId))
		return {
			ok: false,
			code: 'E_INVALID_PARAM',
			message: 'The music crossfades into the next clip there; remove the crossfade first',
		};
	const lines = downbeats.filter(fin).sort((a, b) => a - b);
	if (lines.length === 0)
		return { ok: false, code: 'E_INVALID_PARAM', message: 'The music has no bar lines (no clear downbeat)' };
	const beatSec = fin(opts.bpm) && opts.bpm > 0 ? 60 / opts.bpm : null;
	const barSec =
		lines.length > 1 ? (lines[lines.length - 1]! - lines[0]!) / (lines.length - 1) : (beatSec ?? 2) * 4;
	const fadeSec =
		fin(opts.fadeSeconds) && opts.fadeSeconds > 0 ? opts.fadeSeconds : (beatSec ?? END_ON_BAR_FADE_SEC);
	const fadeFrames = Math.max(1, Math.round(fadeSec * fps));
	const lead = END_ON_BAR_LEAD_SEC * fps;
	const oldEnd = end(clip);
	const media = doc.media?.[clip.mediaId] as { probe?: { durationFlicks?: number | null } } | undefined;
	const mediaEnd = media?.probe?.durationFlicks;
	const F = flicksPerFrame(rate);
	const contentAt = (frame: number) => clip.sourceIn + (frame - clip.start) * F * clip.speed.rate;
	const roomUntil = Math.min(
		...Object.values(seq.clips)
			.filter((o) => o.trackId === clip.trackId && o.id !== clip.id && o.start >= oldEnd)
			.map((o) => o.start),
		Number.POSITIVE_INFINITY,
	);
	type Cand = { endFrame: number; barSeconds: number; barFrame: number };
	const cands: Cand[] = [];
	for (const m of lines) {
		const f = frameAtContent(clip, m * FLICKS_PER_SECOND, rate);
		const endFrame = Math.floor(f - lead + 1e-9);
		if (endFrame <= clip.start + fadeFrames) continue;
		if (endFrame <= oldEnd) {
			cands.push({ endFrame, barSeconds: m, barFrame: f });
			continue;
		}
		if (opts.direction !== 'nearest') continue;
		if (f - oldEnd > (barSec * fps) / 2) continue;
		if (endFrame > roomUntil) continue;
		if (fin(mediaEnd) && contentAt(endFrame) > mediaEnd) continue;
		cands.push({ endFrame, barSeconds: m, barFrame: f });
	}
	if (!cands.length)
		return {
			ok: false,
			code: 'E_INVALID_PARAM',
			message:
				'No bar line of the music falls inside the clip (it is shorter than a bar, or before its first bar)',
		};
	const best =
		opts.direction === 'nearest'
			? cands.sort(
					(a, b) => Math.abs(a.endFrame - oldEnd) - Math.abs(b.endFrame - oldEnd) || a.endFrame - b.endFrame,
				)[0]!
			: cands.sort((a, b) => b.endFrame - a.endFrame)[0]!;
	const commands: Record<string, unknown>[] = [];
	if (best.endFrame !== oldEnd)
		commands.push({ type: 'clip.trim', clipId: clip.id, edge: 'out', deltaFrames: best.endFrame - oldEnd });
	const fade = Math.min(fadeFrames, Math.max(1, best.endFrame - clip.start - 1));
	const existing = Object.values(seq.transitions).find(
		(t) => t.outgoingClipId === clip.id && !t.incomingClipId,
	);
	if (existing) commands.push({ type: 'transition.update', transitionId: existing.id, duration: fade });
	else
		commands.push({
			type: 'transition.add',
			sequenceId: seq.id,
			clipId: clip.id,
			edge: 'out',
			effectId: 'jasper.constant-power',
			duration: fade,
		});
	return {
		ok: true,
		clipId: clip.id,
		endFrame: best.endFrame,
		barSeconds: best.barSeconds,
		barFrame: Math.round(best.barFrame * 1000) / 1000,
		fadeFrames: fade,
		commands,
	};
}
