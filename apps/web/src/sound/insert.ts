// Inserting library sounds (spec 12 §2.3 placement, §2.7 Insert, P1-R7): a sound goes in with its PEAK on the playhead
// (or the drop frame), frame-accurate, with the sub-frame rest taken out of its In point when the head is quiet
// (`peakAlignedStart`). It lands on the drop track or a targeted audio track when that is free over the clip's span,
// else on a free "SFX" track, else on a new track "SFX n": inserting never overwrites audio.
// The sound is registered with the engine first (`registerSound`), then ONE transaction (one undo step) adds the
// media to the "Sound Effects" bin (or reuses the project's copy) and runs `soundDesign.place` (spec 12 §2.9), which
// adds the track if needed and the clip, tags it Essential Sound ▸ SFX and records its `AudioClip.sfx`.
// Also the drag payload of the Sound Library (`application/x-jasper-sound`).
import {
	type RegisterSoundResponse,
	SOUND_ANALYSIS_SECONDS,
	SOUND_EFFECTS_BIN,
	type SoundEntry,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	audioTrackIsFree,
	type Command,
	chooseSoundTrack,
	nextSfxTrackName,
	planMomentPlacement,
	planSoundInsert,
	type Rational,
	resolveSoundAlign,
	type Sequence,
	SOUND_LABELS,
	SOUND_REF_RE,
	type SoundAlign,
	type SoundAlignRequest,
	type SoundInsertPlacement,
	type SoundTiming,
	type SoundTrackChoice,
	soundText,
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
	soundId: z.string().regex(SOUND_REF_RE),
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

/**
 * The library entry's timing (the unpadded library file): what the drag ghost knows before registering — with where the
 * sound has faded (−60 dB) when the analysis covered the whole file, so the ghost is as long as the clip will be.
 */
export function timingOf(e: Pick<SoundEntry, 'descriptors' | 'format'>): SoundTiming {
	const d = e.descriptors;
	const durationSec = e.format.durationSec > 0 ? e.format.durationSec : d.durationSec;
	const tail = d.tailSec;
	return {
		peakSec: d.peakSec,
		onsetSec: d.onsetSec,
		headQuietSec: d.headQuietSec,
		durationSec,
		...(Number.isFinite(tail) && tail >= 0 && durationSec <= SOUND_ANALYSIS_SECONDS
			? { tailEndSec: Math.min(durationSec, d.peakSec + tail) }
			: {}),
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

/**
 * Adds library sounds to the project's "Sound Effects" bin without placing them — the Sound Library's Import to Project,
 * MCP `import_sounds`' twin (spec 12 §1 parity) — as ONE undoable transaction "Import Sound <title>" / "Import n
 * Sounds". Sounds the project already has are reused (nothing is added for them). Needs no sequence. Throws
 * `InsertSoundError` with a message for the user; never leaves a partial edit.
 */
export async function importLibrarySounds(
	session: EditorSession,
	engine: Pick<EngineClient, 'registerSound'>,
	entries: readonly Pick<SoundEntry, 'id' | 'title' | 'descriptors' | 'format' | 'types'>[],
	signal?: AbortSignal,
): Promise<{ imported: number; reused: number; message: string }> {
	const before = session.getState();
	if (before.readOnly) throw new InsertSoundError(t('The project is read-only'));
	if (!entries.length) throw new InsertSoundError(t('Choose a sound first'));
	let regs: RegisteredSound[];
	try {
		regs = await registerLibrarySounds(engine, before.document.projectId, entries, signal);
	} catch (e) {
		throw new InsertSoundError(e instanceof Error ? e.message : String(e));
	}
	const doc = session.getCommitted();
	const prepared = soundMediaCommands(session, doc, regs);
	const reused = [...prepared.media.values()].filter((m) => m.existing).length;
	const imported = prepared.media.size - reused;
	const title = [...prepared.media.values()][0]?.title ?? entries[0]!.title;
	if (!prepared.commands.length)
		return {
			imported: 0,
			reused,
			message:
				reused === 1
					? t('{0} is already in the project', title)
					: t('These {0} sounds are already in the project', reused),
		};
	const label =
		prepared.media.size === 1
			? soundText(SOUND_LABELS.importSound, title)
			: soundText(SOUND_LABELS.importSounds, prepared.media.size);
	const r = session.apply({ label, origin: 'user', commands: prepared.commands });
	if (!r.ok)
		throw new InsertSoundError(
			r.errors.map((e) => e.message).join('; ') || t('The sound could not be added'),
		);
	for (const e of entries) soundLibraryPrefs.touchRecent(e.id);
	return {
		imported,
		reused,
		message:
			imported === 1 && prepared.media.size === 1
				? t('Imported {0} into the “{1}” bin', title, SOUND_EFFECTS_BIN)
				: t('Imported {0} sounds into the “{1}” bin', imported, SOUND_EFFECTS_BIN),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Find Moment (spec 12 P6-E14, WP-E9)

/**
 * Inserts a range of a library sound (a found moment) with its start at `at` (default: the playhead) as ONE undoable
 * transaction "Add Sound Moment <title>": the media (reusing the project's copy), a new "SFX n" track when no SFX track
 * is free over the span, and the clip with that source range. Throws `InsertSoundError` with a message for the user.
 */
export async function insertSoundMoment(
	session: EditorSession,
	engine: Pick<EngineClient, 'registerSound'>,
	entry: Pick<SoundEntry, 'id' | 'title' | 'descriptors' | 'format' | 'types'>,
	range: { startSec: number; endSec: number },
	opts: { at?: number; sequenceId?: string; signal?: AbortSignal } = {},
): Promise<{ clipId: string; trackLabel: string; message: string }> {
	const before = session.getState();
	if (before.readOnly) throw new InsertSoundError(t('The project is read-only'));
	const sequenceId = opts.sequenceId ?? before.activeSequenceId;
	if (!sequenceId || !before.document.sequences[sequenceId])
		throw new InsertSoundError(t('Open a sequence first'));
	const at = Math.max(0, Math.round(opts.at ?? session.transport.getState().frame));
	let reg: RegisterSoundResponse;
	try {
		[{ reg }] = (await registerLibrarySounds(engine, before.document.projectId, [entry], opts.signal)) as [
			RegisteredSound,
		];
	} catch (e) {
		throw new InsertSoundError(e instanceof Error ? e.message : String(e));
	}
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId];
	if (!seq) throw new InsertSoundError(t('The sequence was closed'));
	const prepared = soundMediaCommands(session, doc, [{ entry, reg }]);
	const sm = prepared.media.get(entry.id)!;
	const plan = planMomentPlacement({
		seq,
		mediaRef: sm.ref,
		startSec: range.startSec,
		endSec: range.endSec,
		leadSec: sm.provenance.leadSilenceSec ?? 0,
		mediaDurationFlicks: sm.durFlicks,
		at,
		targeted: session.getState().views[sequenceId]?.targeting.audio ?? [],
	});
	if (!plan.ok) throw new InsertSoundError(plan.message);
	const commands: Command[] = [...prepared.commands, ...(plan.placement.commands as Command[])];
	const r = session.apply({ label: `Add Sound Moment ${sm.title}`, origin: 'user', sequenceId, commands });
	if (!r.ok)
		throw new InsertSoundError(
			r.errors.map((e) => e.message).join('; ') || t('The moment could not be added'),
		);
	const clipId = r.refs?.$momentClip;
	if (!clipId) throw new InsertSoundError(t('The moment was added but its clip was not found'));
	const after = session.getCommitted().sequences[sequenceId]!;
	const clip = after.clips[clipId];
	const trackLabel = clip
		? `A${after.audioTracks.findIndex((x) => x.id === clip.trackId) + 1}`
		: plan.placement.track.label;
	session.select('timeline', [clipId], 'replace', { primary: clipId });
	soundLibraryPrefs.touchRecent(entry.id);
	const tc = formatTimecode(at, after.settings.frameRate, { dropFrame: after.settings.dropFrame });
	return { clipId, trackLabel, message: t('Added a moment of {0} to {1} at {2}', sm.title, trackLabel, tc) };
}
