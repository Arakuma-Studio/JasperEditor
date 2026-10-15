// Inserting a library sound (spec 12 §2.3, §2.7 "Insert"; P1-R7): the one set of rules the Sound Library panel and
// the MCP `insert_sound` tool share, so a sound lands in the same place whichever surface inserts it:
//
// - alignment: `auto` = the sound type's `defaultAlign` (hits and whooshes by their peak, risers and reverses by their
//   end, UI blips by their start), else what the caller asks (the panel's Alt forces `start`);
// - timing: the descriptors of the media actually placed (its provenance), which describe the registered file — the
//   engine pads short library sounds with lead silence when it registers them (`LIBRARY_LEAD_SILENCE_SEC`) so the
//   sub-frame rest always comes out of a quiet head and the aligned point lands exactly on the frame;
// - placement: `peakAlignedStart` with `clampStart` (a sound that would start before frame 0 starts there with its head
//   trimmed) and the clip covering `[In, end of media)` as `clip.place` makes it;
// - track: the preferred (drop) track, a targeted track, an unmuted "SFX…" track — the first that is unlocked and free
//   over the clip's span — else a new "SFX n"; the clip is placed as ONE clip (`audioMapping: 'stereo'`, never the
//   Project item's Modify ▸ Audio Channels routing, which could add clips on other tracks). Never overwrites audio.
// Pure.
import { FLICKS_PER_SECOND, FRAME_EPS, flicksPerFrame, type Rational } from '../time.ts';
import { peakAlignedStart } from './place.ts';
import type { LibraryDescriptors } from './provenance.ts';
import { isSoundTypeId, SOUND_TYPES, type SoundAlign } from './taxonomy.ts';

/** What a caller may ask for: a point of the sound, or `auto` (by its type). */
export type SoundAlignRequest = SoundAlign | 'auto';

/**
 * Seconds of silence the engine puts in front of a library sound whose head is not quiet when it registers it into a
 * project (one frame at the lowest sequence rate, 23.976 fps, is 41.7 ms; 50 ms leaves room for ±2 % varispeed).
 */
export const LIBRARY_LEAD_SILENCE_SEC = 0.05;
/** Library sounds longer than this are registered as they are (beds: aligned by their start; padding would copy them). */
export const LIBRARY_PAD_MAX_SECONDS = 120;

/**
 * Samples of lead silence a library sound gets when registered (0 = registered as it is): sounds whose quiet head is
 * shorter than `LIBRARY_LEAD_SILENCE_SEC` and which are at most `LIBRARY_PAD_MAX_SECONDS` long. The count is whole
 * samples at the file's rate (`ceil(0.05 · rate)`), so the shift is `samples / rate` seconds exactly.
 */
export function libraryLeadSilenceSamples(
	d: { headQuietSec: number; durationSec: number },
	sampleRate: number,
): number {
	if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 768_000) return 0;
	if (!Number.isFinite(d.headQuietSec) || !Number.isFinite(d.durationSec)) return 0;
	if (d.durationSec <= 0 || d.durationSec > LIBRARY_PAD_MAX_SECONDS) return 0;
	if (d.headQuietSec >= LIBRARY_LEAD_SILENCE_SEC) return 0;
	return Math.ceil(LIBRARY_LEAD_SILENCE_SEC * sampleRate - 1e-9);
}

/** Library descriptors moved by `leadSec` of silence put in front of the file (time points shift; levels do not). */
export function shiftLibraryDescriptors(d: LibraryDescriptors, leadSec: number): LibraryDescriptors {
	if (!(leadSec > 0)) return d;
	return {
		...d,
		peakSec: d.peakSec + leadSec,
		onsetSec: d.onsetSec + leadSec,
		headQuietSec: d.headQuietSec + leadSec,
		durationSec: d.durationSec + leadSec,
	};
}

/** The alignment a sound uses by default: its first known type's `defaultAlign` (spec 12 §2.1), else peak. */
export function defaultAlignForTypes(types: readonly unknown[] | null | undefined): SoundAlign {
	if (Array.isArray(types)) for (const t of types) if (isSoundTypeId(t)) return SOUND_TYPES[t].defaultAlign;
	return 'peak';
}

/** `auto` (or nothing) → the type's default alignment; an explicit point is kept. */
export function resolveSoundAlign(
	types: readonly unknown[] | null | undefined,
	requested?: SoundAlignRequest | null,
): SoundAlign {
	return requested === 'peak' || requested === 'start' || requested === 'end'
		? requested
		: defaultAlignForTypes(types);
}

/** The time points placement needs, in seconds of the file placed. */
export type SoundTiming = { peakSec: number; onsetSec: number; headQuietSec: number; durationSec: number };

/**
 * The timing of the media a sound is placed from: its provenance descriptors (they describe the registered file,
 * padding included); without them the library entry's (`fallback`, the unpadded file: only right for media that was
 * not padded, e.g. provenance repaired without descriptors).
 */
export function soundTimingOf(
	provenance: { descriptors?: Partial<SoundTiming> | null } | null | undefined,
	fallback: SoundTiming,
): SoundTiming {
	const d = provenance?.descriptors;
	const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
	if (d && ok(d.peakSec) && ok(d.onsetSec) && ok(d.headQuietSec) && ok(d.durationSec) && d.durationSec > 0)
		return {
			peakSec: d.peakSec,
			onsetSec: d.onsetSec,
			headQuietSec: d.headQuietSec,
			durationSec: d.durationSec,
		};
	return fallback;
}

export type SoundInsertPlacement = {
	/** Sequence frame of the clip's first frame. */
	start: number;
	/** Clip In point (content flicks). */
	sourceInFlicks: number;
	/** Clip Out point (content flicks): the end of the media. */
	outFlicks: number;
	/** Clip length in frames (what `clip.place` gives for `[In, Out)`). */
	frames: number;
	/** The frame the aligned point lands on. */
	cueFrame: number;
	align: SoundAlign;
	/** The aligned point in the source (content flicks from the file start). */
	alignFlicks: number;
	/** The aligned point within the clip, frames from its start (fractional; the ghost's tick). */
	alignOffsetFrames: number;
	/** How late the aligned point plays, sequence flicks (0 when exact; < 1 frame). */
	errorFlicks: number;
	/** Seconds of audible head cut because the clip would have started before frame 0. */
	trimmedHeadSec: number;
};

/**
 * Where a sound's clip goes so that its `align` point lands on `cueFrame`. `mediaDurationFlicks`: the placed media's
 * length (else the timing's). Refuses only impossible input (non-finite, a point past the end, no length).
 */
export function planSoundInsert(input: {
	cueFrame: number;
	fps: Rational;
	align: SoundAlign;
	timing: SoundTiming;
	mediaDurationFlicks?: number | null;
}): { ok: true; placement: SoundInsertPlacement } | { ok: false; code: 'E_INVALID_PARAM'; message: string } {
	const t = input.timing;
	const durFlicks =
		input.mediaDurationFlicks && Number.isFinite(input.mediaDurationFlicks) && input.mediaDurationFlicks > 0
			? Math.round(input.mediaDurationFlicks)
			: Math.round(t.durationSec * FLICKS_PER_SECOND);
	if (!(durFlicks > 0)) return { ok: false, code: 'E_INVALID_PARAM', message: 'The sound has no length' };
	const durSec = durFlicks / FLICKS_PER_SECOND;
	const cue = Number.isFinite(input.cueFrame) ? Math.max(0, Math.round(input.cueFrame)) : 0;
	const r = peakAlignedStart({
		cueFrame: cue,
		peakSec: Math.min(t.peakSec, durSec),
		onsetSec: Math.min(t.onsetSec, durSec),
		durationSec: durSec,
		headQuietSec: t.headQuietSec,
		fps: input.fps,
		align: input.align,
		clampStart: true,
	});
	if (!r.ok) return r;
	if (!(durFlicks > r.sourceInFlicks))
		return { ok: false, code: 'E_INVALID_PARAM', message: 'The sound is too short to place' };
	const F = flicksPerFrame(input.fps);
	return {
		ok: true,
		placement: {
			start: r.start,
			sourceInFlicks: r.sourceInFlicks,
			outFlicks: durFlicks,
			frames: Math.max(1, Math.floor(durFlicks / F - r.sourceInFlicks / F + FRAME_EPS)),
			cueFrame: cue,
			align: input.align,
			alignFlicks: r.alignFlicks,
			alignOffsetFrames: (r.alignFlicks - r.sourceInFlicks) / F,
			errorFlicks: r.errorFlicks,
			trimmedHeadSec: r.trimmedHeadSec,
		},
	};
}

/** The parts of a sequence the track choice reads. */
export type SoundTrackSequence = {
	audioTracks: readonly {
		id: string;
		name?: string | null;
		locked?: boolean | null;
		mute?: boolean | null;
	}[];
	clips: Readonly<Record<string, { trackId: string; start: number; duration: number }>>;
};

export type SoundTrackChoice =
	| { kind: 'existing'; trackId: string; label: string }
	| { kind: 'new'; name: string; label: string };

const SFX_NAME = /^sfx\b/i;

/** The next free "SFX n" name (names already used by audio tracks are skipped). */
export function nextSfxTrackName(seq: Pick<SoundTrackSequence, 'audioTracks'>): string {
	const used = new Set(seq.audioTracks.map((t) => (t.name ?? '').trim().toLowerCase()));
	for (let n = 1; n < 1000; n++) if (!used.has(`sfx ${n}`)) return `SFX ${n}`;
	return 'SFX';
}

/** Clips on an audio track over `[start, start + frames)`. */
export function audioTrackClipsIn(
	seq: SoundTrackSequence,
	trackId: string,
	start: number,
	frames: number,
): { id: string; start: number; duration: number }[] {
	const end = start + frames;
	const out: { id: string; start: number; duration: number }[] = [];
	for (const [id, c] of Object.entries(seq.clips))
		if (c.trackId === trackId && c.start < end && start < c.start + c.duration)
			out.push({ id, start: c.start, duration: c.duration });
	return out;
}

/** Whether an audio track exists, is unlocked and has no clip over `[start, start + frames)`. */
export function audioTrackIsFree(
	seq: SoundTrackSequence,
	trackId: string,
	start: number,
	frames: number,
): boolean {
	const t = seq.audioTracks.find((x) => x.id === trackId);
	if (!t || t.locked) return false;
	return audioTrackClipsIn(seq, trackId, start, frames).length === 0;
}

/**
 * The track a sound goes on (spec 12 §2.3 "Track 'auto'", §2.7 "Tracks"): the preferred track (the drop target, an
 * explicit choice) when it is free, else the first free targeted audio track, else the first free unmuted track named
 * "SFX…", else a new "SFX n". Never a track with audio over the span, never another kind of track (dialogue, music)
 * by itself: sound effects keep to SFX tracks so they do not pick up that track's effects, ducking or stem.
 */
export function chooseSoundTrack(
	seq: SoundTrackSequence,
	span: { start: number; frames: number },
	opts: { preferredTrackId?: string | null; targeted?: readonly string[] } = {},
): SoundTrackChoice {
	const label = (id: string) => `A${seq.audioTracks.findIndex((t) => t.id === id) + 1}`;
	const free = (id: string) => audioTrackIsFree(seq, id, span.start, span.frames);
	const pick = (id: string): SoundTrackChoice => ({ kind: 'existing', trackId: id, label: label(id) });
	if (opts.preferredTrackId && free(opts.preferredTrackId)) return pick(opts.preferredTrackId);
	for (const t of seq.audioTracks) if (opts.targeted?.includes(t.id) && free(t.id)) return pick(t.id);
	for (const t of seq.audioTracks)
		if (SFX_NAME.test(t.name ?? '') && !t.mute && free(t.id)) return pick(t.id);
	return { kind: 'new', name: nextSfxTrackName(seq), label: `A${seq.audioTracks.length + 1}` };
}
