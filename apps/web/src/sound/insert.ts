// Inserting library sounds (spec 12 §2.3 placement, §2.7 Insert, P1-R7): a sound goes in with its PEAK on the playhead
// (or the drop frame), frame-accurate, with the sub-frame rest taken out of its In point when the head is quiet
// (`peakAlignedStart`). It lands on the drop track or a targeted audio track when that is free over the clip's span,
// else on a free "SFX" track, else on a new track "SFX n": inserting never overwrites audio.
// The sound is registered with the engine first (`registerSound`), then ONE transaction (one undo step) adds the
// media to the "Sound Effects" bin (or reuses the project's copy) and runs `soundDesign.place` (spec 12 §2.9), which
// adds the track if needed and the clip, tags it Essential Sound ▸ SFX and records its `AudioClip.sfx`.
// Also the drag payload of the Sound Library (`application/x-jasper-sound`).
import type { RegisterSoundResponse, SoundEntry } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	audioTrackIsFree,
	type Command,
	chooseSoundTrack,
	nextSfxTrackName,
	planSoundInsert,
	type Rational,
	resolveSoundAlign,
	type Sequence,
	type SoundAlign,
	type SoundAlignRequest,
	type SoundInsertPlacement,
	type SoundTiming,
	type SoundTrackChoice,
	soundTimingOf,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { z } from 'zod';
import { formatTimecode } from '../gaps/time-display.ts';
import { t } from '../i18n/runtime.ts';
import { type RegisteredSound, registerLibrarySounds, soundMediaCommands } from './library-media.ts';
import { soundLibraryPrefs } from './prefs.ts';

// ---------------------------------------------------------------------------------------------------------------
// Drag payload

/** DataTransfer type of a sound dragged from the Sound Library. */
export const JASPER_SOUND_MIME = 'application/x-jasper-sound';
/** The sound id is also encoded in a type name: types (not data) are readable during dragover. */
const SOUND_ID_TYPE_PREFIX = 'application/x-jasper-sound-id.';

const SoundDragSchema = z.object({
	type: z.literal('jasper/sound'),
	soundId: z.string().regex(/^snd_[0-9a-f]{16}$/),
});
export type SoundDragPayload = z.infer<typeof SoundDragSchema>;

/** What the timeline needs to draw a drag ghost (peak tick, length): the entry of this window's drag. */
export type SoundDragInfo = Pick<SoundEntry, 'id' | 'title' | 'descriptors' | 'format' | 'types'>;

let dragging: SoundDragInfo | null = null;

export function writeSoundDrag(dt: DataTransfer, entry: SoundDragInfo): void {
	const payload: SoundDragPayload = { type: 'jasper/sound', soundId: entry.id };
	dt.setData(JASPER_SOUND_MIME, JSON.stringify(payload));
	dt.setData(`${SOUND_ID_TYPE_PREFIX}${entry.id}`, entry.id);
	dt.setData('text/plain', entry.title || entry.id);
	dt.effectAllowed = 'copy';
	dragging = entry;
}

/** The drag ended (dropped or cancelled). */
export function endSoundDrag(): void {
	dragging = null;
}

/** True while a sound is dragged (dragover: types only). */
export function isSoundDrag(dt: Pick<DataTransfer, 'types'> | null): boolean {
	return !!dt && Array.from(dt.types ?? []).includes(JASPER_SOUND_MIME);
}

/** The dragged sound's details during dragover (this window's drag), or null (a drag from another window). */
export function soundDragInfo(dt: Pick<DataTransfer, 'types'> | null): SoundDragInfo | null {
	if (!dragging || !dt) return null;
	const t = Array.from(dt.types ?? []).find((x) => x.startsWith(SOUND_ID_TYPE_PREFIX));
	return t && t.slice(SOUND_ID_TYPE_PREFIX.length) === dragging.id ? dragging : t ? null : dragging;
}

/** Parses a sound drop (null when the DataTransfer carries none or a malformed one). */
export function readSoundDrag(dt: Pick<DataTransfer, 'getData'> | null): SoundDragPayload | null {
	if (!dt) return null;
	try {
		const raw = dt.getData(JASPER_SOUND_MIME);
		if (!raw) return null;
		const parsed = SoundDragSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Placement (pure): the rules are @jasper/project's (`planSoundInsert`, `chooseSoundTrack`), shared with MCP insert_sound.

export type { SoundTiming };
export { chooseSoundTrack, nextSfxTrackName };
export type TrackChoice = SoundTrackChoice;

/** The library entry's timing (the unpadded library file): what the drag ghost knows before registering. */
export function timingOf(e: Pick<SoundEntry, 'descriptors' | 'format'>): SoundTiming {
	const d = e.descriptors;
	return {
		peakSec: d.peakSec,
		onsetSec: d.onsetSec,
		headQuietSec: d.headQuietSec,
		durationSec: e.format.durationSec > 0 ? e.format.durationSec : d.durationSec,
	};
}

export type SoundPlacement = SoundInsertPlacement & { track: TrackChoice };

/** Whether an audio track is unlocked and has no clip over `[start, start + frames)`. */
export function trackIsFree(seq: Sequence, trackId: string, start: number, frames: number): boolean {
	return audioTrackIsFree(seq, trackId, start, frames);
}

/**
 * Where a sound goes so that its `align` point (peak, start = onset, end) lands on `cueFrame`, and on which track.
 * `mediaDurationFlicks`: the registered media's length when known (else the timing's). Refuses only impossible input.
 */
export function planSoundPlacement(input: {
	seq: Sequence;
	timing: SoundTiming;
	cueFrame: number;
	align: SoundAlign;
	mediaDurationFlicks?: number | null;
	preferredTrackId?: string | null;
	targeted?: readonly string[];
}): { ok: true; placement: SoundPlacement } | { ok: false; message: string } {
	const r = planSoundInsert({
		cueFrame: input.cueFrame,
		fps: input.seq.settings.frameRate as Rational,
		align: input.align,
		timing: input.timing,
		mediaDurationFlicks: input.mediaDurationFlicks ?? null,
	});
	if (!r.ok) return { ok: false, message: r.message };
	const p = r.placement;
	const track = chooseSoundTrack(
		input.seq,
		{ start: p.start, frames: p.frames },
		{ preferredTrackId: input.preferredTrackId ?? null, targeted: input.targeted ?? [] },
	);
	return { ok: true, placement: { ...p, track } };
}

// ---------------------------------------------------------------------------------------------------------------
// Insert (engine + one transaction)

export type InsertSoundResult = {
	clipId: string;
	mediaId: string;
	trackLabel: string;
	start: number;
	cueFrame: number;
	trimmedHeadSec: number;
	/** The point of the sound that landed on `cueFrame`. */
	align: SoundAlign;
	/** How late it plays, flicks (0 for padded library sounds: sample-exact). */
	errorFlicks: number;
	/** "Added <name> to A4 · peak at 00:00:01:12" */
	message: string;
};

export class InsertSoundError extends Error {}

/**
 * Registers a library sound with the engine and inserts it, peak-aligned at `at` (default: the playhead) of the
 * active sequence, as ONE undoable transaction "Add Sound <title>". Throws `InsertSoundError` with a message for
 * the user; never leaves a partial edit (the transaction is atomic).
 */
export async function insertLibrarySound(
	session: EditorSession,
	engine: Pick<EngineClient, 'registerSound'>,
	entry: Pick<SoundEntry, 'id' | 'title' | 'descriptors' | 'format' | 'types'>,
	opts: {
		at?: number;
		/** Which point of the sound lands on `at`: auto (default: by its type), peak, start (onset) or end. */
		align?: SoundAlignRequest;
		preferredTrackId?: string | null;
		sequenceId?: string;
		signal?: AbortSignal;
	} = {},
): Promise<InsertSoundResult> {
	const before = session.getState();
	if (before.readOnly) throw new InsertSoundError(t('The project is read-only'));
	const sequenceId = opts.sequenceId ?? before.activeSequenceId;
	if (!sequenceId || !before.document.sequences[sequenceId])
		throw new InsertSoundError(t('Open a sequence first'));
	const cueFrame = Math.max(0, Math.round(opts.at ?? session.transport.getState().frame));
	const align = resolveSoundAlign(entry.types, opts.align);
	if (!(timingOf(entry).durationSec > 0)) throw new InsertSoundError(t('This sound has no length'));

	let reg: RegisterSoundResponse;
	try {
		[{ reg }] = (await registerLibrarySounds(engine, before.document.projectId, [entry], opts.signal)) as [
			RegisteredSound,
		];
	} catch (e) {
		throw new InsertSoundError(e instanceof Error ? e.message : String(e));
	}

	// The document after the await (other edits may have happened meanwhile).
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId];
	if (!seq) throw new InsertSoundError(t('The sequence was closed'));
	const state = session.getState();
	const prepared = soundMediaCommands(session, doc, [{ entry, reg }]);
	const commands: Command[] = [...prepared.commands];
	const sm = prepared.media.get(entry.id)!;
	const existing = sm.existing;
	const mediaRef = sm.ref;
	const durFlicks = sm.durFlicks;
	// The timing of the media actually placed: its provenance describes that file (lead silence included).
	const provenance = sm.provenance;
	const title = sm.title;
	// The plan (the same rules soundDesign.place applies) checks the sound can be placed before committing.
	const timing = soundTimingOf(provenance, timingOf(entry));
	const plan = planSoundPlacement({
		seq,
		timing,
		cueFrame,
		align,
		mediaDurationFlicks: durFlicks,
		preferredTrackId: opts.preferredTrackId ?? null,
		targeted: state.views[sequenceId]?.targeting.audio ?? [],
	});
	if (!plan.ok) throw new InsertSoundError(plan.message);
	const p = plan.placement;
	// spec 12 §2.9: one `soundDesign.place` places the clip peak-aligned on a free track (the drop track, a targeted
	// track, a free SFX track or a new "SFX n"), tags it Essential Sound ▸ SFX and records `AudioClip.sfx`.
	const preferTrackIds = [
		...(opts.preferredTrackId ? [opts.preferredTrackId] : []),
		...(state.views[sequenceId]?.targeting.audio ?? []),
	].filter((id, i, a) => a.indexOf(id) === i && seq.audioTracks.some((t) => t.id === id));
	commands.push({
		type: 'soundDesign.place',
		sequenceId,
		frame: cueFrame,
		layers: [{ mediaId: mediaRef, align, ref: '$soundClip' }],
		...(preferTrackIds.length ? { preferTrackIds } : {}),
		// A sound that would start before frame 0 starts there with its head trimmed (the aligned point stays exact).
		clampStart: true,
	} as Command);
	const r = session.apply({ label: `Add Sound ${title}`, origin: 'user', sequenceId, commands });
	if (!r.ok)
		throw new InsertSoundError(
			r.errors.map((e) => e.message).join('; ') || t('The sound could not be added'),
		);
	const placed = (
		r.results[commands.length - 1] as
			| { clips?: { clipId: string; start: number; errorFlicks: number; trimmedHeadSec: number }[] }
			| undefined
	)?.clips?.[0];
	const clipId = placed?.clipId;
	if (!clipId) throw new InsertSoundError(t('The sound was added but its clip was not found'));
	const after = session.getCommitted().sequences[sequenceId]!;
	const clip = after.clips[clipId];
	const trackLabel = clip
		? `A${after.audioTracks.findIndex((t) => t.id === clip.trackId) + 1}`
		: p.track.label;
	const mediaId = (clip as { mediaId?: string } | undefined)?.mediaId ?? existing ?? '';
	session.select('timeline', [clipId], 'replace', { primary: clipId });
	soundLibraryPrefs.touchRecent(entry.id);
	const tc = formatTimecode(cueFrame, after.settings.frameRate, { dropFrame: after.settings.dropFrame });
	return {
		clipId,
		mediaId,
		trackLabel,
		start: placed.start,
		cueFrame,
		trimmedHeadSec: placed.trimmedHeadSec,
		align,
		errorFlicks: placed.errorFlicks,
		message:
			align === 'peak'
				? t('Added {0} to {1} · peak at {2}', title, trackLabel, tc)
				: align === 'end'
					? t('Added {0} to {1} · end at {2}', title, trackLabel, tc)
					: t('Added {0} to {1} · start at {2}', title, trackLabel, tc),
	};
}
