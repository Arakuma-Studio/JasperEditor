// The bridge between the Sound Library panel and the commands that drive it (keymap scope `soundLibrary`, menus,
// agents through the UI command catalogue): the mounted panel registers its controller here (the panel is single
// instance). Commands that do not need the panel (insert a sound by id at the playhead) work without it.
import type { SoundEntry } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { SoundAlignRequest } from '@jasper/project';
import type { EditorSession, TransportStore } from '@jasper/session';
import type { ToastRequest } from '../commands/types.ts';
import { t } from '../i18n/runtime.ts';
import { type AuditionPlayer, type AuditionSound, auditionPlayer } from './audition.ts';
import { InsertSoundError, insertLibrarySound } from './insert.ts';
import { soundLibraryPrefs } from './prefs.ts';

export type SoundLibraryController = {
	/** The selected result, or null. */
	selected(): SoundEntry | null;
	/** Plays / stops the selected sound (Space). */
	toggleAudition(): void;
	/** Inserts the selected sound at the playhead (Enter). */
	insertSelected(): void;
	toggleFavourite(): void;
	focusSearch(): void;
	setQuery(q: string): void;
	findSimilar(): void;
	showLicense(): void;
};

let active: SoundLibraryController | null = null;
let pendingQuery: string | null = null;

export function registerSoundLibraryController(c: SoundLibraryController): () => void {
	active = c;
	if (pendingQuery !== null) {
		c.setQuery(pendingQuery);
		pendingQuery = null;
	}
	return () => {
		if (active === c) active = null;
	};
}

export function soundLibraryController(): SoundLibraryController | null {
	return active;
}

/** Sets the panel's search (now, or when the panel mounts). */
export function requestSoundSearch(q: string): void {
	if (active) active.setQuery(q);
	else pendingQuery = q;
}

/** What the audition player needs of a library entry (its URL and format: long sounds stream). */
export function auditionSoundOf(
	engine: Pick<EngineClient, 'soundAudioUrl'>,
	e: Pick<SoundEntry, 'id' | 'title' | 'format'>,
): AuditionSound {
	return { id: e.id, title: e.title || e.id, url: engine.soundAudioUrl(e.id), format: e.format };
}

/** Plays / stops a sound through the shared audition player (recorded in Recent). */
export function toggleAuditionOf(engine: Pick<EngineClient, 'soundAudioUrl'>, e: SoundEntry): void {
	const player = auditionPlayer();
	player.setLoop(soundLibraryPrefs.get().loop);
	player.setVolumeDb(soundLibraryPrefs.get().volumeDb);
	const playing = player.state.soundId === e.id && player.state.phase !== 'idle';
	if (!playing) soundLibraryPrefs.touchRecent(e.id);
	void player.toggle(auditionSoundOf(engine, e));
}

/**
 * The audition plays alone (spec 12 §2.7): starting one pauses the Program transport, and the transport starting to
 * play stops it. Returns the unsubscribe.
 */
export function auditionPlaysAlone(player: AuditionPlayer, transport: TransportStore): () => void {
	const offAudition = player.store.subscribe((s, prev) => {
		if (s.phase !== 'idle' && (prev.phase === 'idle' || s.soundId !== prev.soundId)) {
			if (transport.getState().playing) transport.pause();
		}
	});
	const offTransport = transport.subscribe((s, prev) => {
		if (s.playing && !prev.playing && player.state.phase !== 'idle') player.stop();
	});
	return () => {
		offAudition();
		offTransport();
	};
}

/**
 * Inserts a library sound peak-aligned at the playhead (or `at`) and reports it: a toast "Added <name> to A4 · peak
 * at <tc>" with Undo, or the error. Returns the inserted clip id, or null.
 */
export async function insertSoundWithFeedback(
	session: EditorSession,
	engine: Pick<EngineClient, 'registerSound'>,
	entry: SoundEntry,
	toast: (r: ToastRequest) => void,
	opts: { at?: number; align?: SoundAlignRequest; preferredTrackId?: string | null } = {},
): Promise<string | null> {
	const r = await insertSoundReporting(session, engine, entry, toast, opts);
	return r.ok ? r.clipId : null;
}

/** `insertSoundWithFeedback` that also returns why it failed (agents get the real reason, not just "failed"). */
export async function insertSoundReporting(
	session: EditorSession,
	engine: Pick<EngineClient, 'registerSound'>,
	entry: SoundEntry,
	toast: (r: ToastRequest) => void,
	opts: { at?: number; align?: SoundAlignRequest; preferredTrackId?: string | null } = {},
): Promise<{ ok: true; clipId: string } | { ok: false; message: string }> {
	try {
		const r = await insertLibrarySound(session, engine, entry, opts);
		toast({
			kind: 'success',
			message: r.message,
			...(r.trimmedHeadSec > 0
				? {
						detail: t(
							'The sound started before 0: its first {0} s were trimmed',
							r.trimmedHeadSec.toFixed(2),
						),
					}
				: {}),
			action: { label: t('Undo'), command: 'history.undo' },
		});
		return { ok: true, clipId: r.clipId };
	} catch (e) {
		const message = e instanceof InsertSoundError || e instanceof Error ? e.message : String(e);
		toast({ kind: 'error', message: t('Could not add the sound'), detail: message });
		return { ok: false, message };
	}
}
