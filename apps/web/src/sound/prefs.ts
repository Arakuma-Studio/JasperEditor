// Sound Library UI preferences (spec 12 §2.7, P1-R7), kept in localStorage like the other UI preferences
// (audio/prefs.ts): favourites and recently auditioned / inserted sounds, the audition options (loop, auto-play on
// select, audition on hover, volume) and the list density. Never part of a project document or of undo history.
// Every value read back is validated: a damaged or hand-edited entry falls back to the default (AGENTS.md §0.2).
import { SOUND_REF_RE } from '@jasper/project';
import { useSyncExternalStore } from 'react';

/** A library sound id or a take id (P6-E9). */
const SOUND_ID = SOUND_REF_RE;
export const MAX_FAVOURITES = 500;
export const MAX_RECENTS = 50;

export type SoundLibraryPrefs = {
	/** Favourite sound ids, most recently starred first. */
	favourites: string[];
	/** Recently auditioned or inserted sound ids, most recent first. */
	recents: string[];
	/** Loop the audition (with a 250 ms gap). */
	loop: boolean;
	/** Audition a sound when it becomes the selection (arrow keys, click). */
	autoPlay: boolean;
	/** Audition while the pointer rests on a row (off by default: spec 12 §2.7). */
	auditionOnHover: boolean;
	/** Audition volume, dB (−40 … +6). */
	volumeDb: number;
	/** Row height: normal 36 px, compact 24 px. */
	density: 'normal' | 'compact';
	/** The Refine pills are shown. */
	refineOpen: boolean;
	/** Space, Auto-play and hover audition IN CONTEXT (the timeline with the candidate mixed in; spec 12 §2.7). */
	inContext: boolean;
	/** After a swap or a variation step, play the 2 s around the sound in context (default on). */
	auditionOnSwap: boolean;
	/** Seconds of the timeline played before the anchor in an In Context audition (0.5 … 10, default 2). */
	preRollSec: number;
};

export const DEFAULT_SOUND_LIBRARY_PREFS: SoundLibraryPrefs = {
	favourites: [],
	recents: [],
	loop: false,
	autoPlay: false,
	auditionOnHover: false,
	volumeDb: -6,
	density: 'normal',
	refineOpen: false,
	inContext: false,
	auditionOnSwap: true,
	preRollSec: 2,
};

export const MIN_PRE_ROLL_SEC = 0.5;
export const MAX_PRE_ROLL_SEC = 10;

export const MIN_AUDITION_DB = -40;
export const MAX_AUDITION_DB = 6;

const KEY = 'jasper:sound-library-prefs';

const ids = (v: unknown, max: number): string[] => {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const x of v) {
		if (typeof x !== 'string' || !SOUND_ID.test(x) || out.includes(x)) continue;
		out.push(x);
		if (out.length >= max) break;
	}
	return out;
};

/** Tolerant parse: unknown keys are dropped and bad values fall back to the defaults. */
export function parseSoundLibraryPrefs(raw: unknown): SoundLibraryPrefs {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const d = DEFAULT_SOUND_LIBRARY_PREFS;
	const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
	const vol =
		typeof o.volumeDb === 'number' && Number.isFinite(o.volumeDb)
			? Math.min(MAX_AUDITION_DB, Math.max(MIN_AUDITION_DB, Math.round(o.volumeDb * 10) / 10))
			: d.volumeDb;
	return {
		favourites: ids(o.favourites, MAX_FAVOURITES),
		recents: ids(o.recents, MAX_RECENTS),
		loop: bool(o.loop, d.loop),
		autoPlay: bool(o.autoPlay, d.autoPlay),
		auditionOnHover: bool(o.auditionOnHover, d.auditionOnHover),
		volumeDb: vol,
		density: o.density === 'compact' ? 'compact' : 'normal',
		refineOpen: bool(o.refineOpen, d.refineOpen),
		inContext: bool(o.inContext, d.inContext),
		auditionOnSwap: bool(o.auditionOnSwap, d.auditionOnSwap),
		preRollSec:
			typeof o.preRollSec === 'number' && Number.isFinite(o.preRollSec)
				? Math.min(MAX_PRE_ROLL_SEC, Math.max(MIN_PRE_ROLL_SEC, Math.round(o.preRollSec * 10) / 10))
				: d.preRollSec,
	};
}

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

function load(): SoundLibraryPrefs {
	try {
		return parseSoundLibraryPrefs(JSON.parse(storage()?.getItem(KEY) ?? '{}'));
	} catch {
		return { ...DEFAULT_SOUND_LIBRARY_PREFS };
	}
}

let state: SoundLibraryPrefs = load();
const listeners = new Set<() => void>();

function commit(next: SoundLibraryPrefs): void {
	state = parseSoundLibraryPrefs(next);
	try {
		storage()?.setItem(KEY, JSON.stringify(state));
	} catch {
		/* quota / private mode: keep in memory */
	}
	for (const l of [...listeners]) l();
}

export const soundLibraryPrefs = {
	get: (): SoundLibraryPrefs => state,
	set(patch: Partial<SoundLibraryPrefs>): void {
		commit({ ...state, ...patch });
	},
	isFavourite: (soundId: string): boolean => state.favourites.includes(soundId),
	/**
	 * Stars or unstars a sound; returns whether it is a favourite now. Starring a sound when there are already
	 * `MAX_FAVOURITES` is refused (`'full'`: the caller says so), never by silently dropping the oldest favourite.
	 */
	toggleFavourite(soundId: string): boolean | 'full' {
		if (!SOUND_ID.test(soundId)) return false;
		const on = !state.favourites.includes(soundId);
		if (on && state.favourites.length >= MAX_FAVOURITES) return 'full';
		commit({
			...state,
			favourites: on ? [soundId, ...state.favourites] : state.favourites.filter((x) => x !== soundId),
		});
		return on;
	},
	/** Moves a sound to the front of Recent. */
	touchRecent(soundId: string): void {
		if (!SOUND_ID.test(soundId) || state.recents[0] === soundId) return;
		commit({ ...state, recents: [soundId, ...state.recents.filter((x) => x !== soundId)] });
	},
	/** Re-reads localStorage (tests, another window). */
	reload(): void {
		state = load();
		for (const l of [...listeners]) l();
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};

export function useSoundLibraryPrefs(): SoundLibraryPrefs {
	return useSyncExternalStore(soundLibraryPrefs.subscribe, soundLibraryPrefs.get, soundLibraryPrefs.get);
}
