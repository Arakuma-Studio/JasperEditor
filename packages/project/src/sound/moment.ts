// Placing a found moment (spec 12 P6-E14, WP-E9 Find Moment): a sub-range of a registered library sound, starting at a
// frame, on a free track — the moment's start lands on `at`. The commands are ordinary ones (`track.add` when no SFX
// track is free, then `clip.place` with the source range), so the edit is one undo step wherever it is applied (the
// Sound Library panel, MCP `insert_sound_moment`). Pure.
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import { chooseSoundTrack, type SoundTrackChoice, type SoundTrackSequence } from './insert.ts';

export type MomentPlacement = {
	/** `track.add` (when a new SFX track is needed) and `clip.place`; the clip is bound to `$momentClip`. */
	commands: Record<string, unknown>[];
	track: SoundTrackChoice;
	/** Sequence frames the clip spans. */
	frames: number;
	sourceInFlicks: number;
	sourceOutFlicks: number;
};

/**
 * The commands that place `[startSec, endSec)` of a sound's media (seconds of the library sound; `leadSec` = the lead
 * silence its registered copy has in front) at sequence frame `at`. Refuses (typed) an empty or non-finite range or
 * one past the media's end.
 */
export function planMomentPlacement(input: {
	seq: SoundTrackSequence & { id: string; settings: { frameRate: Rational } };
	mediaRef: string;
	startSec: number;
	endSec: number;
	leadSec?: number;
	mediaDurationFlicks?: number | null;
	at: number;
	preferredTrackId?: string | null;
	targeted?: readonly string[];
}): { ok: true; placement: MomentPlacement } | { ok: false; code: string; message: string } {
	const lead = Number.isFinite(input.leadSec) && (input.leadSec ?? 0) > 0 ? input.leadSec! : 0;
	const { startSec, endSec } = input;
	if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || !(endSec > startSec))
		return { ok: false, code: 'E_INVALID_PARAM', message: 'The moment’s range is empty' };
	if (!Number.isInteger(input.at) || input.at < 0)
		return { ok: false, code: 'E_INVALID_PARAM', message: 'The frame to place the moment at must be ≥ 0' };
	const sourceInFlicks = Math.round((startSec + lead) * FLICKS_PER_SECOND);
	let sourceOutFlicks = Math.round((endSec + lead) * FLICKS_PER_SECOND);
	const media = input.mediaDurationFlicks;
	if (media !== undefined && media !== null && Number.isFinite(media)) {
		if (sourceInFlicks >= media)
			return { ok: false, code: 'E_INVALID_PARAM', message: 'The moment starts after the end of the sound' };
		sourceOutFlicks = Math.min(sourceOutFlicks, media);
	}
	if (
		!Number.isSafeInteger(sourceInFlicks) ||
		!Number.isSafeInteger(sourceOutFlicks) ||
		sourceOutFlicks <= sourceInFlicks
	)
		return { ok: false, code: 'E_INVALID_PARAM', message: 'The moment’s range is empty or out of bounds' };
	const fpf = flicksPerFrame(input.seq.settings.frameRate);
	if (!(fpf > 0)) return { ok: false, code: 'E_INVALID_PARAM', message: 'The sequence has no frame rate' };
	const frames = Math.max(1, Math.ceil((sourceOutFlicks - sourceInFlicks) / fpf - 1e-9));
	const track = chooseSoundTrack(
		input.seq,
		{ start: input.at, frames },
		{ preferredTrackId: input.preferredTrackId ?? null, targeted: input.targeted ?? [] },
	);
	const commands: Record<string, unknown>[] = [];
	if (track.kind === 'new')
		commands.push({
			type: 'track.add',
			sequenceId: input.seq.id,
			kind: 'audio',
			name: track.name,
			ref: '$momentTrack',
		});
	commands.push({
		type: 'clip.place',
		sequenceId: input.seq.id,
		source: { mediaId: input.mediaRef },
		sourceRange: { in: { flicks: sourceInFlicks }, out: { flicks: sourceOutFlicks } },
		at: input.at,
		tracks: { audio: track.kind === 'new' ? '$momentTrack' : track.trackId },
		mode: 'overwrite',
		ref: '$momentClip',
	});
	return { ok: true, placement: { commands, track, frames, sourceInFlicks, sourceOutFlicks } };
}
