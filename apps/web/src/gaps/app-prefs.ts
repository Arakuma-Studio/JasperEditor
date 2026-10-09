// Preferences of workstream gaps (docs/wp-notes/gaps.md §UI-4), kept in localStorage like the other UI preferences:
// Auto Save, Labels (names and defaults), Playback (pre-roll / post-roll), Trim (large trim offset), Audio Hardware
// (output device, latency) and Appearance additions (reduced motion, language — UI-6). Tolerant parse: unknown keys and
// bad values fall back to the defaults, so a corrupt entry never breaks the editor.
import { LABEL_COLORS, type LabelColor } from '@jasper/project';
import { LABEL_DISPLAY_NAMES } from '@jasper/ui';
import { useSyncExternalStore } from 'react';

export type LabelDefaultKind = 'bin' | 'sequence' | 'video' | 'movie' | 'audio' | 'still' | 'synthetic';

export type GapsPrefs = {
	autoSave: {
		/** Premiere "Automatically save projects": off = the project file is written on Save only (the crash
		 * journal still keeps unsaved edits). */
		enabled: boolean;
		/** Save at most this long after the first unsaved change, seconds (Premiere's "every N minutes"). */
		maxIntervalSeconds: number;
	};
	labels: {
		/** Display names of the label colours (Premiere: Preferences ▸ Labels). */
		names: Partial<Record<LabelColor, string>>;
		/** Label Defaults: the label new items of a kind get (absent = the built-in default). */
		defaults: Partial<Record<LabelDefaultKind, LabelColor>>;
	};
	playback: {
		/** Pre-roll / post-roll of Play Around and trim-mode playback, seconds (Premiere default 2 / 2). */
		prerollSeconds: number;
		postrollSeconds: number;
	};
	trim: {
		/** Large Trim Offset, frames (Premiere default 5). */
		largeTrimOffset: number;
	};
	audioHardware: {
		/** `MediaDeviceInfo.deviceId` of the output ('' = the system default). */
		outputDeviceId: string;
		/** Web Audio latency hint of new audio contexts (Premiere's I/O buffer size, in effect). */
		latency: 'interactive' | 'balanced' | 'playback';
	};
	appearance: {
		/** Reduce motion: no UI animations or transitions (`prefers-reduced-motion` is honoured too). */
		reducedMotion: 'system' | 'on' | 'off';
		/** UI language (UI-6). */
		language: string;
	};
};

export const DEFAULT_GAPS_PREFS: GapsPrefs = {
	autoSave: { enabled: true, maxIntervalSeconds: 10 },
	labels: { names: {}, defaults: {} },
	playback: { prerollSeconds: 2, postrollSeconds: 2 },
	trim: { largeTrimOffset: 5 },
	audioHardware: { outputDeviceId: '', latency: 'interactive' },
	appearance: { reducedMotion: 'system', language: 'en' },
};

const KEY = 'jasper:gaps-prefs';
const num = (v: unknown, min: number, max: number, d: number) =>
	typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
const obj = (v: unknown): Record<string, unknown> =>
	v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const isLabel = (v: unknown): v is LabelColor =>
	typeof v === 'string' && (LABEL_COLORS as readonly string[]).includes(v);
const KINDS: readonly LabelDefaultKind[] = [
	'bin',
	'sequence',
	'video',
	'movie',
	'audio',
	'still',
	'synthetic',
];

export function parseGapsPrefs(raw: unknown): GapsPrefs {
	const o = obj(raw);
	const d = DEFAULT_GAPS_PREFS;
	const as = obj(o.autoSave);
	const lb = obj(o.labels);
	const names: Partial<Record<LabelColor, string>> = {};
	for (const [k, v] of Object.entries(obj(lb.names)))
		if (isLabel(k) && typeof v === 'string' && v.trim()) names[k] = v.trim().slice(0, 40);
	const defaults: Partial<Record<LabelDefaultKind, LabelColor>> = {};
	for (const [k, v] of Object.entries(obj(lb.defaults)))
		if ((KINDS as readonly string[]).includes(k) && isLabel(v)) defaults[k as LabelDefaultKind] = v;
	const pb = obj(o.playback);
	const tr = obj(o.trim);
	const ah = obj(o.audioHardware);
	const ap = obj(o.appearance);
	return {
		autoSave: {
			enabled: typeof as.enabled === 'boolean' ? as.enabled : d.autoSave.enabled,
			maxIntervalSeconds: num(as.maxIntervalSeconds, 2, 3600, d.autoSave.maxIntervalSeconds),
		},
		labels: { names, defaults },
		playback: {
			prerollSeconds: num(pb.prerollSeconds, 0, 30, d.playback.prerollSeconds),
			postrollSeconds: num(pb.postrollSeconds, 0, 30, d.playback.postrollSeconds),
		},
		trim: { largeTrimOffset: Math.round(num(tr.largeTrimOffset, 2, 100, d.trim.largeTrimOffset)) },
		audioHardware: {
			outputDeviceId: typeof ah.outputDeviceId === 'string' ? ah.outputDeviceId.slice(0, 256) : '',
			latency: (['interactive', 'balanced', 'playback'] as const).includes(ah.latency as never)
				? (ah.latency as GapsPrefs['audioHardware']['latency'])
				: d.audioHardware.latency,
		},
		appearance: {
			reducedMotion: (['system', 'on', 'off'] as const).includes(ap.reducedMotion as never)
				? (ap.reducedMotion as GapsPrefs['appearance']['reducedMotion'])
				: d.appearance.reducedMotion,
			language:
				typeof ap.language === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(ap.language) ? ap.language : 'en',
		},
	};
}

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

let state: GapsPrefs = (() => {
	try {
		return parseGapsPrefs(JSON.parse(storage()?.getItem(KEY) ?? '{}'));
	} catch {
		return structuredClone(DEFAULT_GAPS_PREFS);
	}
})();
const listeners = new Set<() => void>();

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

export const gapsPrefs = {
	get: (): GapsPrefs => state,
	set(patch: DeepPartial<GapsPrefs>): void {
		const next = { ...state } as Record<string, unknown>;
		for (const [k, v] of Object.entries(patch))
			next[k] =
				v && typeof v === 'object' && !Array.isArray(v)
					? { ...(state as Record<string, object>)[k], ...v }
					: v;
		state = parseGapsPrefs(next);
		try {
			storage()?.setItem(KEY, JSON.stringify(state));
		} catch {
			/* quota / private mode: in memory */
		}
		for (const l of [...listeners]) l();
	},
	reset(): void {
		state = structuredClone(DEFAULT_GAPS_PREFS);
		try {
			storage()?.removeItem(KEY);
		} catch {
			/* nothing */
		}
		for (const l of [...listeners]) l();
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
	/** Tests: re-read storage. */
	reload(): void {
		try {
			state = parseGapsPrefs(JSON.parse(storage()?.getItem(KEY) ?? '{}'));
		} catch {
			state = structuredClone(DEFAULT_GAPS_PREFS);
		}
		for (const l of [...listeners]) l();
	},
};

export function useGapsPrefs(): GapsPrefs {
	return useSyncExternalStore(gapsPrefs.subscribe, gapsPrefs.get, gapsPrefs.get);
}

/** The user's default label for new items of a kind, or undefined (the built-in default). */
export function labelDefault(kind: LabelDefaultKind): LabelColor | undefined {
	return state.labels.defaults[kind];
}

/** Label Defaults kind of a media asset. */
export function labelKindOfMedia(asset: {
	kind: string;
	probe: { streams: { type: string }[] };
}): LabelDefaultKind {
	if (asset.kind === 'video') return asset.probe.streams.some((s) => s.type === 'audio') ? 'movie' : 'video';
	if (asset.kind === 'audio') return 'audio';
	return 'still';
}

/** A label colour's display name (Preferences ▸ Labels renames them). */
export function labelName(l: LabelColor): string {
	return state.labels.names[l] ?? LABEL_DISPLAY_NAMES[l as keyof typeof LABEL_DISPLAY_NAMES] ?? l;
}
