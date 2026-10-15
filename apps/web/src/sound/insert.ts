// Inserting library sounds (spec 12 §2.3 placement, §2.7 Insert, P1-R7): a sound goes in with its PEAK on the playhead
// (or the drop frame), frame-accurate, with the sub-frame rest taken out of its In point when the head is quiet
// (`peakAlignedStart`). It lands on the targeted audio track when that is free over the clip's span, else on a free
// "SFX" track, else on the first free audio track, else on a new track "SFX n": inserting never overwrites audio.
// The sound is registered with the engine first (`registerSound`), then ONE transaction (one undo step) adds the
// media to the "Sound Effects" bin (or reuses the project's copy), the track if needed, the clip, and tags the clip
// Essential Sound ▸ SFX. Also the drag payload of the Sound Library (`application/x-jasper-sound`).
import { type RegisterSoundResponse, SOUND_EFFECTS_BIN, type SoundEntry } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	audioTrackIsFree,
	type Command,
	chooseSoundTrack,
	type MediaAsset,
	mediaDurationFlicks,
	nextSfxTrackName,
	planSoundInsert,
	type Rational,
	readLibraryProvenance,
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
import { labelDefault, labelKindOfMedia } from '../gaps/app-prefs.ts';
import { formatTimecode } from '../gaps/time-display.ts';
import { buildMediaAsset } from '../import/assets.ts';
import { findExistingMedia } from '../import/transaction.ts';
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

/** The root "Sound Effects" bin of the project, or null. */
function soundEffectsBin(doc: ReturnType<EditorSession['getCommitted']>): string | null {
	for (const id of doc.rootItems) {
		const it = doc.items[id];
		if (it?.kind === 'bin' && it.name === SOUND_EFFECTS_BIN) return it.id;
	}
	return null;
}

/** The media in the project for a registered sound: the engine's match (saved project), else the same file. */
function existingMediaFor(
	doc: ReturnType<EditorSession['getCommitted']>,
	reg: RegisterSoundResponse,
): string | null {
	const byEngine = reg.existingMediaId;
	if (byEngine && Object.hasOwn(doc.media, byEngine) && !doc.media[byEngine]!.derivation) return byEngine;
	return findExistingMedia(doc, reg.fingerprint);
}

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
	if (before.readOnly) throw new InsertSoundError('The project is read-only');
	const sequenceId = opts.sequenceId ?? before.activeSequenceId;
	if (!sequenceId || !before.document.sequences[sequenceId])
		throw new InsertSoundError('Open a sequence first');
	const cueFrame = Math.max(0, Math.round(opts.at ?? session.transport.getState().frame));
	const align = resolveSoundAlign(entry.types, opts.align);
	if (!(timingOf(entry).durationSec > 0)) throw new InsertSoundError('This sound has no length');

	let reg: RegisterSoundResponse;
	try {
		reg = await engine.registerSound(entry.id, before.document.projectId);
	} catch (e) {
		throw new InsertSoundError(`Could not add the sound: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (opts.signal?.aborted) throw new InsertSoundError('Cancelled');

	// The document after the await (other edits may have happened meanwhile).
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId];
	if (!seq) throw new InsertSoundError('The sequence was closed');
	const state = session.getState();
	const commands: Command[] = [];
	const existing = existingMediaFor(doc, reg);
	let mediaRef: string;
	let durFlicks: number | null;
	// The timing of the media actually placed: its provenance describes that file (lead silence included).
	let provenance = reg.library;
	const title = entry.title || reg.library.title || reg.originalName;
	if (existing) {
		mediaRef = existing;
		durFlicks = mediaDurationFlicks(doc.media[existing] as MediaAsset);
		const own = readLibraryProvenance((doc.media[existing] as { library?: unknown }).library);
		if (own) provenance = own;
		else commands.push({ type: 'media.setLibraryInfo', mediaId: existing, library: reg.library } as Command);
	} else {
		let binId: string | null = soundEffectsBin(doc);
		if (!binId) {
			commands.push({ type: 'bin.create', name: SOUND_EFFECTS_BIN, ref: '$sfxBin' } as Command);
			binId = '$sfxBin';
		}
		const asset = buildMediaAsset(reg, { id: session.ctx.ids.next('med'), now: new Date().toISOString() });
		const label = labelDefault(labelKindOfMedia(asset));
		commands.push({
			type: 'media.register',
			asset: { ...asset, library: reg.library },
			binId,
			name: title,
			...(label ? { label } : {}),
			ref: '$sound',
		} as Command);
		mediaRef = '$sound';
		durFlicks = mediaDurationFlicks(asset);
	}
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
	let trackRef: string;
	if (p.track.kind === 'new') {
		commands.push({
			type: 'track.add',
			sequenceId,
			kind: 'audio',
			name: p.track.name,
			ref: '$sfxTrack',
		} as Command);
		trackRef = '$sfxTrack';
	} else trackRef = p.track.trackId;
	const outFlicks = p.outFlicks;
	commands.push(
		{
			type: 'clip.place',
			sequenceId,
			source: { mediaId: mediaRef },
			sourceRange: { in: { flicks: p.sourceInFlicks }, out: { flicks: outFlicks } },
			at: p.start,
			tracks: { audio: trackRef },
			mode: 'overwrite',
			video: false,
			// One clip on the chosen track: never the item's Audio Channels routing (more clips, other tracks).
			audioMapping: 'stereo',
			ref: '$soundClip',
		} as Command,
		{ type: 'essentialSound.setType', clipIds: ['$soundClip'], audioType: 'sfx' } as Command,
	);
	const r = session.apply({ label: `Add Sound ${title}`, origin: 'user', sequenceId, commands });
	if (!r.ok)
		throw new InsertSoundError(r.errors.map((e) => e.message).join('; ') || 'The sound could not be added');
	const placeIndex = commands.findIndex((c) => c.type === 'clip.place');
	const clipId =
		(r.results[placeIndex] as { clipIds?: string[]; clipId?: string } | undefined)?.clipIds?.[0] ??
		(r.results[placeIndex] as { clipId?: string } | undefined)?.clipId;
	if (!clipId) throw new InsertSoundError('The sound was added but its clip was not found');
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
		start: p.start,
		cueFrame,
		trimmedHeadSec: p.trimmedHeadSec,
		align,
		errorFlicks: p.errorFlicks,
		message:
			align === 'peak'
				? `Added ${title} to ${trackLabel} · peak at ${tc}`
				: align === 'end'
					? `Added ${title} to ${trackLabel} · end at ${tc}`
					: `Added ${title} to ${trackLabel} · start at ${tc}`,
	};
}
