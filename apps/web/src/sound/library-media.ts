// Library sounds → project media (spec 12 §2.1 "Register into a project"), shared by every path that puts a library
// sound into the document (Insert, Fill, Swap, variation cycling, Add Layer, Fill Unfilled Cues, the In Context
// audition's transient document): the engine registers the sound into the project first (`registerSound`: kit, pack
// and synth files are copied into managed media, padded with lead silence), then `soundMediaCommands` gives the
// commands that make the media exist in the document — reuse the project's copy (the engine's match, else the same
// fingerprint), filling its provenance when it has none, or `media.register` it into the root "Sound Effects" bin
// (created once per transaction) — and the reference later commands use (`$snd0`, `$snd1`… or the media id).
import { type RegisterSoundResponse, SOUND_EFFECTS_BIN, type SoundEntry } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	type Command,
	type LibraryProvenance,
	type MediaAsset,
	mediaDurationFlicks,
	olderLibraryCopyOf,
	type ProjectDocument,
	readLibraryProvenance,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { labelDefault, labelKindOfMedia } from '../gaps/app-prefs.ts';
import { t } from '../i18n/runtime.ts';
import { buildMediaAsset } from '../import/assets.ts';
import { findExistingMedia } from '../import/transaction.ts';
import { noticeInexactSounds } from './inexact.ts';

/** What registering needs of a library entry: its id (and title when known; else the engine's). */
export type LibraryEntryLike = Pick<SoundEntry, 'id'> & { title?: string };

export type RegisteredSound = { entry: LibraryEntryLike; reg: RegisterSoundResponse };

export class SoundMediaError extends Error {}

/**
 * Registers library sounds with the engine for a project (sequentially; the engine dedupes). A sound the engine had
 * to register as it is, not as a sample-exact copy (`inexact`), is announced by a warning toast (`noticeInexactSounds`)
 * unless `notifyInexact` is false (the In Context audition's transient document).
 */
export async function registerLibrarySounds(
	engine: Pick<EngineClient, 'registerSound'>,
	projectId: string,
	entries: readonly LibraryEntryLike[],
	signal?: AbortSignal,
	opts: { notifyInexact?: boolean } = {},
): Promise<RegisteredSound[]> {
	const out: RegisteredSound[] = [];
	const seen = new Map<string, RegisterSoundResponse>();
	for (const entry of entries) {
		if (signal?.aborted) throw new SoundMediaError(t('Cancelled'));
		let reg = seen.get(entry.id);
		if (!reg) {
			try {
				reg = await engine.registerSound(entry.id, projectId);
			} catch (e) {
				throw new SoundMediaError(
					t('Could not add the sound: {0}', e instanceof Error ? e.message : String(e)),
				);
			}
			seen.set(entry.id, reg);
		}
		out.push({ entry, reg });
	}
	if (signal?.aborted) throw new SoundMediaError(t('Cancelled'));
	if (opts.notifyInexact !== false) noticeInexactSounds(out);
	return out;
}

/** The root "Sound Effects" bin of the project, or null. */
export function soundEffectsBin(doc: Pick<ProjectDocument, 'rootItems' | 'items'>): string | null {
	for (const id of doc.rootItems) {
		const it = doc.items[id];
		if (it?.kind === 'bin' && it.name === SOUND_EFFECTS_BIN) return it.id;
	}
	return null;
}

/** The media in the project for a registered sound: the engine's match (saved project), else the same file. */
export function existingMediaFor(doc: ProjectDocument, reg: RegisterSoundResponse): string | null {
	const byEngine = reg.existingMediaId;
	if (byEngine && Object.hasOwn(doc.media, byEngine) && !doc.media[byEngine]!.derivation) return byEngine;
	return findExistingMedia(doc, reg.fingerprint);
}

export type SoundMedia = {
	/** The media id, or the `$ref` a `media.register` of this transaction defines. */
	ref: string;
	/** The project media already there (null = registered by this transaction). */
	existing: string | null;
	/** Provenance of the media placed (its own when it has one: it describes that file, lead silence included). */
	provenance: LibraryProvenance;
	/** The registered media's length (flicks), when known. */
	durFlicks: number | null;
	title: string;
};

/**
 * Commands that make each registered sound a project media (pure: reads `doc`, draws ids from the session). The bin is
 * created at most once; the same sound twice gets one media.
 */
export function soundMediaCommands(
	session: Pick<EditorSession, 'ctx'>,
	doc: ProjectDocument,
	sounds: readonly RegisteredSound[],
	opts: { refPrefix?: string } = {},
): { commands: Command[]; media: Map<string, SoundMedia> } {
	const commands: Command[] = [];
	const media = new Map<string, SoundMedia>();
	let binId: string | null = soundEffectsBin(doc);
	const prefix = opts.refPrefix ?? '$snd';
	const byFingerprint = new Map<string, SoundMedia>();
	for (const { entry, reg } of sounds) {
		if (media.has(entry.id)) continue;
		const title = entry.title || reg.library.title || reg.originalName;
		const existing = existingMediaFor(doc, reg);
		if (existing) {
			const own = readLibraryProvenance((doc.media[existing] as { library?: unknown }).library);
			if (!own)
				commands.push({ type: 'media.setLibraryInfo', mediaId: existing, library: reg.library } as Command);
			media.set(entry.id, {
				ref: existing,
				existing,
				provenance: own ?? reg.library,
				durFlicks: mediaDurationFlicks(doc.media[existing] as MediaAsset),
				title,
			});
			continue;
		}
		// two library ids of the same file (a pack and a folder) become one media
		const twin = byFingerprint.get(reg.fingerprint);
		if (twin) {
			media.set(entry.id, twin);
			continue;
		}
		if (!binId) {
			commands.push({ type: 'bin.create', name: SOUND_EFFECTS_BIN, ref: '$sfxBin' } as Command);
			binId = '$sfxBin';
		}
		const asset = buildMediaAsset(reg, { id: session.ctx.ids.next('med'), now: new Date().toISOString() });
		const label = labelDefault(labelKindOfMedia(asset));
		const ref = `${prefix}${media.size}`;
		// An older copy of this sound in the project (registered before a registration rule changed) is replaced in place:
		// one media per sound, its clips moved onto the new copy sample for sample (WP6.5b).
		const older = olderLibraryCopyOf(doc, reg.library.soundId, reg.fingerprint);
		commands.push({
			type: older ? 'media.upgradeLibraryCopy' : 'media.register',
			...(older ? { mediaId: older, ifPossible: true } : {}),
			asset: { ...asset, library: reg.library },
			binId,
			name: title,
			...(label ? { label } : {}),
			ref,
		} as Command);
		const m: SoundMedia = {
			ref,
			existing: null,
			provenance: reg.library,
			durFlicks: mediaDurationFlicks(asset),
			title,
		};
		media.set(entry.id, m);
		byFingerprint.set(reg.fingerprint, m);
	}
	return { commands, media };
}
