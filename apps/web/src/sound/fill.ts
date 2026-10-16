// Filling cues (spec 12 §2.7 "Insert": Enter or double-click fills the selected cue; drop on a cue glyph; Cue menu
// Fill With ▸ / Fill from Library… / Add Layer…; Sequence ▸ Sound Design ▸ Fill Unfilled Cues). Every fill is ONE
// transaction: the library sound becomes project media (`soundMediaCommands`), then `soundDesign.place {cueId}` puts
// it on the cue — the cue gives the role (hero / support), the alignment (its `align`, else the sound type's), the pan
// or pan sweep; the variation ring (the chosen sound, then the next 1–3 ranked sounds) is stored for variation cycling
// (`sfx.alternatives`, original first, as MCP place_sound stores it); `variationOf` gives
// the seeded ±2 % speed and ±1 dB gain. A layer (Add Layer…) is placed on the next free SFX track, aligned to the same
// point, and linked to the cue's other clips (Premiere-style link: moving one moves the others).
// Fill Unfilled Cues ranks sounds per cue with the engine, picks one with `pickVariant` (round-robin over the top 4,
// never the same file twice in a row) and fills every cue in one transaction; cues that cannot be placed are skipped
// and reported (a dry run finds them). Until Phase 3 (proposals) it applies directly.
import type { SoundEntry } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	type Clip,
	type Command,
	type Sequence,
	type SoundCue,
	soundDesignSettingsOf,
	variationOf,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { t } from '../i18n/runtime.ts';
import { type CueFillTarget, cueFillTarget, requestCueFill } from './controller.ts';
import { cuesOf, placedClips } from './cues/model.ts';
import {
	alignedFrameOf,
	alignOf,
	cueLabel,
	cueOfClip,
	cueSearchRequest,
	layersLinked,
	layersOf,
	trackLabelOf,
} from './design-model.ts';
import { type LibraryEntryLike, registerLibrarySounds, soundMediaCommands } from './library-media.ts';
import { soundLibraryPrefs } from './prefs.ts';

export class FillError extends Error {}

/** Sounds ranked for a cue by the engine (types / visual kind / window / align / rotation), best first. */
export async function cueCandidates(
	engine: Pick<EngineClient, 'searchSounds'>,
	session: EditorSession,
	seq: Sequence,
	cue: SoundCue,
	limit = 8,
	signal?: AbortSignal,
): Promise<SoundEntry[]> {
	const r = await engine.searchSounds(cueSearchRequest(session.getCommitted(), seq, cue, limit), signal);
	return r.results.map((x) => x.sound);
}

/** The cue Enter / double-click fills: Fill mode's cue, else the last selected cue of the active sequence. */
export function fillTargetFor(session: EditorSession): CueFillTarget | null {
	const fill = cueFillTarget();
	const s = session.getState();
	if (fill && s.document.sequences[fill.sequenceId]) return fill;
	const seqId = s.activeSequenceId;
	const seq = seqId ? s.document.sequences[seqId] : undefined;
	const id = s.selection.cues?.at(-1);
	const cue = seq && id ? cuesOf(seq).find((c) => c.id === id) : undefined;
	if (!seq || !cue) return null;
	return { sequenceId: seq.id, cueId: cue.id, types: cue.types ?? [], label: cueLabel(seq, cue) };
}

export type FillResult = { clipId: string; trackLabel: string; message: string; trimmedHeadSec: number };

/**
 * Fills a cue with a library sound (or adds it as one more layer). One undo step "Fill Cue <title>" / "Add Layer
 * <title>". Throws `FillError` with a message for the user; never leaves a partial edit.
 */
export async function fillCueWithSound(
	session: EditorSession,
	engine: Pick<EngineClient, 'registerSound'>,
	entry: LibraryEntryLike,
	opts: { sequenceId: string; cueId: string; layer?: boolean; alternatives?: readonly string[] },
): Promise<FillResult> {
	const s0 = session.getState();
	if (s0.readOnly) throw new FillError(t('The project is read-only'));
	if (!s0.document.sequences[opts.sequenceId]) throw new FillError(t('The sequence was closed'));
	let sounds: Awaited<ReturnType<typeof registerLibrarySounds>>;
	try {
		sounds = await registerLibrarySounds(engine, s0.document.projectId, [entry]);
	} catch (e) {
		throw new FillError(e instanceof Error ? e.message : String(e));
	}
	const doc = session.getCommitted();
	const seq = doc.sequences[opts.sequenceId];
	const cue = seq ? cuesOf(seq).find((c) => c.id === opts.cueId) : undefined;
	if (!seq || !cue) throw new FillError(t('The cue is gone'));
	const prepared = soundMediaCommands(session, doc, sounds);
	const media = prepared.media.get(entry.id)!;
	const existing = placedClips(seq, cue);
	const layer = !!opts.layer && existing.length > 0;
	const settings = soundDesignSettingsOf(seq as { soundDesign?: unknown });
	const v = variationOf({ seed: settings.seed, cueId: cue.id, sequenceId: seq.id, layer: existing.length });
	// the clip's variation ring: the chosen sound first (the cycle's anchor), then up to 3 ranked alternatives
	const others = (opts.alternatives ?? []).filter((id) => id !== entry.id).slice(0, 3);
	const alternatives = others.length ? [entry.id, ...others] : [];
	const commands: Command[] = [
		...prepared.commands,
		{
			type: 'soundDesign.place',
			sequenceId: seq.id,
			cueId: cue.id,
			layers: [
				{
					mediaId: media.ref,
					rate: v.rate,
					// the seeded ±1 dB variation, on top of the sound's default level (soundDesign.place)
					gainOffsetDb: v.gainDb,
					...(layer ? { role: 'layer' } : {}),
					ref: '$fill',
				},
			],
			...(layer ? { group: false } : alternatives.length ? { alternatives } : {}),
			clampStart: true,
		} as Command,
		// Layers are linked (one clip per track, like a linked A/V pair): moving one moves the others.
		...(layer ? [{ type: 'clip.link', clipIds: [...existing, '$fill'] } as Command] : []),
	];
	const title = media.title;
	const r = session.apply({
		label: layer ? t('Add Layer {0}', title) : t('Fill Cue {0}', title),
		origin: 'user',
		sequenceId: seq.id,
		commands,
	});
	if (!r.ok)
		throw new FillError(r.errors.map((e) => e.message).join('; ') || t('The cue could not be filled'));
	const placed = (
		r.results[prepared.commands.length] as
			| { clips?: { clipId: string; trackId: string; trimmedHeadSec: number }[] }
			| undefined
	)?.clips?.[0];
	if (!placed) throw new FillError(t('The sound was added but its clip was not found'));
	const after = session.getCommitted().sequences[seq.id]!;
	const trackLabel = trackLabelOf(after, placed.trackId);
	session.select('timeline', [placed.clipId], 'replace', { primary: placed.clipId });
	soundLibraryPrefs.touchRecent(entry.id);
	// the mode ends with the fill (the cue is filled now)
	const target = cueFillTarget();
	if (target?.cueId === cue.id) requestCueFill(null);
	return {
		clipId: placed.clipId,
		trackLabel,
		trimmedHeadSec: placed.trimmedHeadSec,
		message: layer
			? t('Added {0} as a layer of the {1} on {2}', title, cueLabel(seq, cue), trackLabel)
			: t('Filled the {0} with {1} on {2}', cueLabel(seq, cue), title, trackLabel),
	};
}

/**
 * Add Layer… on an SFX clip that fills no cue: the sound is placed with its aligned point on the clip's (same align),
 * on the next free SFX track, and linked to the clip (and the layers already linked to it). One undo step.
 */
export async function addLayerToClip(
	session: EditorSession,
	engine: Pick<EngineClient, 'registerSound'>,
	entry: LibraryEntryLike,
	opts: { sequenceId: string; clipId: string },
): Promise<FillResult> {
	const s0 = session.getState();
	if (s0.readOnly) throw new FillError(t('The project is read-only'));
	let sounds: Awaited<ReturnType<typeof registerLibrarySounds>>;
	try {
		sounds = await registerLibrarySounds(engine, s0.document.projectId, [entry]);
	} catch (e) {
		throw new FillError(e instanceof Error ? e.message : String(e));
	}
	const doc = session.getCommitted();
	const seq = doc.sequences[opts.sequenceId];
	const clip = seq?.clips[opts.clipId];
	if (!seq || !clip) throw new FillError(t('The clip is gone'));
	const cue = cueOfClip(seq, clip);
	if (cue)
		return fillCueWithSound(session, engine, entry, { sequenceId: seq.id, cueId: cue.id, layer: true });
	const at = alignedFrameOf(doc, seq, clip);
	if (at === null) throw new FillError(t('This clip has no peak to align a layer to'));
	const prepared = soundMediaCommands(session, doc, sounds);
	const media = prepared.media.get(entry.id)!;
	const layers = layersOf(seq, clip).clipIds;
	const commands: Command[] = [
		...prepared.commands,
		{
			type: 'soundDesign.place',
			sequenceId: seq.id,
			frame: Math.floor(at),
			layers: [{ mediaId: media.ref, align: alignOf(clip), role: 'layer', ref: '$layer' }],
			group: false,
			clampStart: true,
		} as Command,
		{ type: 'clip.link', clipIds: [...layers, '$layer'] } as Command,
	];
	const r = session.apply({
		label: t('Add Layer {0}', media.title),
		origin: 'user',
		sequenceId: seq.id,
		commands,
	});
	if (!r.ok)
		throw new FillError(r.errors.map((e) => e.message).join('; ') || t('The layer could not be added'));
	const placed = (
		r.results[prepared.commands.length] as
			| { clips?: { clipId: string; trackId: string; trimmedHeadSec: number }[] }
			| undefined
	)?.clips?.[0];
	if (!placed) throw new FillError(t('The sound was added but its clip was not found'));
	const after = session.getCommitted().sequences[seq.id]!;
	const trackLabel = trackLabelOf(after, placed.trackId);
	session.select('timeline', [placed.clipId], 'replace', { primary: placed.clipId, linked: false });
	soundLibraryPrefs.touchRecent(entry.id);
	return {
		clipId: placed.clipId,
		trackLabel,
		trimmedHeadSec: placed.trimmedHeadSec,
		message: t('Added {0} as a layer of {1} on {2}', media.title, clip.name || clip.id, trackLabel),
	};
}

/** Link Layers / Unlink Layers of a clip (Premiere-style link: one clip per track, they move together). */
export function linkLayersCommands(seq: Sequence, clip: Clip): { link: boolean; commands: Command[] } | null {
	const ids = layersOf(seq, clip).clipIds;
	if (ids.length < 2) return null;
	const linked = layersLinked(seq, ids);
	return {
		link: !linked,
		commands: [{ type: linked ? 'clip.unlink' : 'clip.link', clipIds: ids } as Command],
	};
}
