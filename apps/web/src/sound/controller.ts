// The bridge between the Sound Library panel and the commands that drive it (keymap scope `soundLibrary`, menus,
// agents through the UI command catalogue): the mounted panel registers its controller here (the panel is single
// instance). Commands that do not need the panel (insert a sound by id at the playhead) work without it.
import type { SoundEntry } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { ProjectDocument, SoundAlignRequest } from '@jasper/project';
import type { EditorSession, TransportStore } from '@jasper/session';
import type { ToastRequest } from '../commands/types.ts';
import { t } from '../i18n/runtime.ts';
import { type AuditionPlayer, type AuditionSound, auditionPlayer } from './audition.ts';
import { cuesOf } from './cues/model.ts';
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
	/** Sets the type filter chips (Fill mode presets them to a cue's suggested types). */
	setTypes?(types: readonly string[]): void;
	findSimilar(): void;
	showLicense(): void;
	/** Ranks by similarity to a sound (Find Similar Sounds on a clip, Replace mode); null clears it. */
	setSimilar?(sound: { id: string; title: string } | null): void;
	/** Shows a sound: searches its title in All sounds and selects it when it is in the results. */
	reveal?(sound: { id: string; title: string }): void;
	/** Plays the selected sound in context (Shift+Space). */
	auditionInContext?(): void;
};

let active: SoundLibraryController | null = null;
let pendingQuery: string | null = null;
let pendingTypes: readonly string[] | null = null;
/** Requests for a panel that is not mounted yet (applied in order when it registers). */
let pendingActions: ((c: SoundLibraryController) => void)[] = [];

export function registerSoundLibraryController(c: SoundLibraryController): () => void {
	active = c;
	if (pendingQuery !== null) {
		c.setQuery(pendingQuery);
		pendingQuery = null;
	}
	if (pendingTypes !== null) {
		c.setTypes?.(pendingTypes);
		pendingTypes = null;
	}
	const actions = pendingActions;
	pendingActions = [];
	for (const a of actions) a(c);
	return () => {
		if (active === c) active = null;
	};
}

/** Runs a request on the panel now, or when it mounts (the latest 8 requests are kept). */
export function withSoundLibrary(action: (c: SoundLibraryController) => void): void {
	if (active) action(active);
	else pendingActions = [...pendingActions.slice(-7), action];
}

export function soundLibraryController(): SoundLibraryController | null {
	return active;
}

/** Sets the panel's search (now, or when the panel mounts). */
export function requestSoundSearch(q: string): void {
	if (active) active.setQuery(q);
	else pendingQuery = q;
}

/**
 * Fill mode (spec 12 §2.7: double-click or Enter on a cue "opens the Library in Fill mode"): the cue the Sound Library
 * is choosing a sound for. The panel shows it and presets its type chips to the cue's suggested types; filling the cue
 * with the chosen sound is the panel's Enter / drop (`soundDesign.place {cueId}`).
 */
export type CueFillTarget = {
	sequenceId: string;
	cueId: string;
	/** Suggested sound types of the cue (may be empty). */
	types: readonly string[];
	/** What the panel shows, e.g. "Hero Land cue at 00:00:04:02". */
	label: string;
	/** Add Layer…: the chosen sound is added as one more layer of the cue (linked to the others). */
	layer?: boolean;
};

let fillTarget: CueFillTarget | null = null;
const fillListeners = new Set<() => void>();

export function cueFillTarget(): CueFillTarget | null {
	return fillTarget;
}

export function subscribeCueFill(l: () => void): () => void {
	fillListeners.add(l);
	return () => fillListeners.delete(l);
}

const notifyMode = () => {
	for (const l of [...fillListeners]) l();
};

/** Enters Fill mode for a cue: remembers it and presets the type filter (now, or when the panel mounts). */
export function requestCueFill(target: CueFillTarget | null): void {
	fillTarget = target;
	if (target) {
		clipTarget = null;
		if (active?.setTypes) active.setTypes(target.types);
		else pendingTypes = target.types;
	}
	notifyMode();
}

/**
 * Replace mode (Swap Sound…, Alt+Shift+S) and Add Layer… on a clip that fills no cue: the library chooses a sound for a
 * placed clip. The panel shows a banner ("Replacing Crunch on A3 at 00:00:01:15 · Enter to swap · Esc to cancel") and
 * Enter swaps (`soundDesign.swap`) or adds the layer (`soundDesign.place` on the clip's aligned frame, linked).
 */
export type ClipSoundTarget = {
	kind: 'replace' | 'layer';
	sequenceId: string;
	clipId: string;
	/** The clip's library sound (Replace mode ranks by similarity to it), or null. */
	soundId: string | null;
	/** The clip's sound name. */
	title: string;
	/** "Crunch on A3 at 00:00:01:15". */
	label: string;
};

let clipTarget: ClipSoundTarget | null = null;
/** Replace mode ranked the list by similarity: leaving the mode clears that ranking again. */
let similarFromMode = false;

export function clipSoundTarget(): ClipSoundTarget | null {
	return clipTarget;
}

function clearModeSimilar(): void {
	if (!similarFromMode) return;
	similarFromMode = false;
	withSoundLibrary((c) => c.setSimilar?.(null));
}

/** Enters Replace / clip-layer mode (clears Fill mode), or leaves it with null. */
export function requestClipTarget(target: ClipSoundTarget | null): void {
	clipTarget = target;
	if (target) {
		fillTarget = null;
		if (target.kind === 'replace' && target.soundId) {
			const similar = { id: target.soundId, title: target.title };
			similarFromMode = true;
			withSoundLibrary((c) => c.setSimilar?.(similar));
		}
	} else clearModeSimilar();
	notifyMode();
}

/** Leaves Fill, Replace and layer modes (Esc in the Sound Library). */
export function cancelLibraryMode(): boolean {
	if (!fillTarget && !clipTarget) return false;
	fillTarget = null;
	clipTarget = null;
	clearModeSimilar();
	notifyMode();
	return true;
}

/**
 * Leaves Fill / Replace / layer mode when its target is no longer in `doc`: the cue or clip was deleted (or its
 * creation undone), or `doc` is another project's. Otherwise Enter would fail on a target that is gone, under a chip
 * or banner that still names it.
 */
export function pruneLibraryMode(doc: Pick<ProjectDocument, 'sequences'>): void {
	const seqOf = (id: string) => (Object.hasOwn(doc.sequences, id) ? doc.sequences[id] : undefined);
	if (fillTarget) {
		const { sequenceId, cueId } = fillTarget;
		const seq = seqOf(sequenceId);
		if (!seq || !cuesOf(seq).some((c) => c.id === cueId)) requestCueFill(null);
	}
	if (clipTarget) {
		const seq = seqOf(clipTarget.sequenceId);
		if (!seq || !Object.hasOwn(seq.clips, clipTarget.clipId)) requestClipTarget(null);
	}
}

/** A snapshot key of the mode (React external store). */
export function libraryModeKey(): string {
	return fillTarget
		? `fill:${fillTarget.cueId}:${fillTarget.layer ? 1 : 0}`
		: clipTarget
			? `${clipTarget.kind}:${clipTarget.clipId}`
			: '';
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
