// Audio preferences (audio-mix; Premiere Preferences ▸ Audio and Voice-Over Record Settings), kept in localStorage:
// audio scrubbing, the 5.1 mixdown type of the device fold, automation (automatch time, Write → Touch, thinning) and
// voice-over recording (input device, channel, name, countdown cues, pre-roll / post-roll).
import { useSyncExternalStore } from 'react';

export type MixdownType = 'front' | 'frontRear' | 'frontLfe' | 'frontRearLfe';

export type AudioPrefs = {
	/** Transport ▸ Audio Scrubbing (Shift+S). Premiere default: on. */
	scrub: boolean;
	/** Preferences ▸ Audio ▸ 5.1 Mixdown Type (how a 5.1 Mix is folded for the stereo device). */
	mixdown: MixdownType;
	/** Automatch time (s): Touch ramps back to the automation over it after a release. Premiere default 1 s. */
	automatchSeconds: number;
	/** Switch to Touch after Write (Premiere default on). */
	switchToTouchAfterWrite: boolean;
	/** Linear keyframe thinning (Premiere default on). */
	linearThinning: boolean;
	/** Minimum time interval thinning (Premiere default off, 20 ms). */
	minIntervalThinning: boolean;
	minIntervalMs: number;
	/**
	 * Preferences ▸ Audio ▸ "Auto-tag audio types in the timeline" (Premiere 24.x; helpx "Auto tag audio categories":
	 * "This setting allows auto tagging to happen anytime you add an audio clip to your sequence"). Off by default here:
	 * Adobe documents it as a setting you enable and documents no default (community threads report it on in some
	 * builds); tagging starts engine jobs on every add, so it is opt-in (WP6.5a).
	 */
	autoTagInTimeline: boolean;
	voiceOver: {
		/** `MediaDeviceInfo.deviceId` ('' = the system default input). */
		deviceId: string;
		/** Input channel recorded (0-based; the file is mono). */
		inputChannel: number;
		/** Base name of recorded files and clips (`<name> <n>`). Premiere: "Voice-over". */
		name: string;
		/** Beep once a second during the pre-roll and at the record point. */
		countdownCues: boolean;
		prerollSeconds: number;
		postrollSeconds: number;
		/**
		 * Added to the measured round-trip latency when a take is placed (ms, −500 … 500; positive moves the take
		 * earlier). For devices whose latency the browser does not report.
		 */
		latencyOffsetMs: number;
	};
};

export const DEFAULT_AUDIO_PREFS: AudioPrefs = {
	scrub: true,
	mixdown: 'frontRear',
	automatchSeconds: 1,
	switchToTouchAfterWrite: true,
	linearThinning: true,
	minIntervalThinning: false,
	minIntervalMs: 20,
	autoTagInTimeline: false,
	voiceOver: {
		deviceId: '',
		inputChannel: 0,
		name: 'Voice-over',
		countdownCues: true,
		prerollSeconds: 2,
		postrollSeconds: 2,
		latencyOffsetMs: 0,
	},
};

const KEY = 'jasper:audio-prefs';

const num = (v: unknown, min: number, max: number, d: number) =>
	typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;

/** Tolerant parse: unknown keys and bad values fall back to defaults. */
export function parseAudioPrefs(raw: unknown): AudioPrefs {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const v = (o.voiceOver && typeof o.voiceOver === 'object' ? o.voiceOver : {}) as Record<string, unknown>;
	const d = DEFAULT_AUDIO_PREFS;
	return {
		scrub: typeof o.scrub === 'boolean' ? o.scrub : d.scrub,
		mixdown: (['front', 'frontRear', 'frontLfe', 'frontRearLfe'] as const).includes(o.mixdown as MixdownType)
			? (o.mixdown as MixdownType)
			: d.mixdown,
		automatchSeconds: num(o.automatchSeconds, 0, 10, d.automatchSeconds),
		switchToTouchAfterWrite:
			typeof o.switchToTouchAfterWrite === 'boolean' ? o.switchToTouchAfterWrite : d.switchToTouchAfterWrite,
		linearThinning: typeof o.linearThinning === 'boolean' ? o.linearThinning : d.linearThinning,
		minIntervalThinning:
			typeof o.minIntervalThinning === 'boolean' ? o.minIntervalThinning : d.minIntervalThinning,
		minIntervalMs: num(o.minIntervalMs, 1, 2000, d.minIntervalMs),
		autoTagInTimeline: typeof o.autoTagInTimeline === 'boolean' ? o.autoTagInTimeline : d.autoTagInTimeline,
		voiceOver: {
			deviceId: typeof v.deviceId === 'string' ? v.deviceId : d.voiceOver.deviceId,
			inputChannel: Math.round(num(v.inputChannel, 0, 63, d.voiceOver.inputChannel)),
			name: typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 80) : d.voiceOver.name,
			countdownCues: typeof v.countdownCues === 'boolean' ? v.countdownCues : d.voiceOver.countdownCues,
			prerollSeconds: num(v.prerollSeconds, 0, 60, d.voiceOver.prerollSeconds),
			postrollSeconds: num(v.postrollSeconds, 0, 60, d.voiceOver.postrollSeconds),
			latencyOffsetMs: Math.round(num(v.latencyOffsetMs, -500, 500, d.voiceOver.latencyOffsetMs)),
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

let state: AudioPrefs = (() => {
	try {
		return parseAudioPrefs(JSON.parse(storage()?.getItem(KEY) ?? '{}'));
	} catch {
		return { ...DEFAULT_AUDIO_PREFS };
	}
})();
const listeners = new Set<() => void>();

export const audioPrefs = {
	get: (): AudioPrefs => state,
	set(
		patch: Partial<Omit<AudioPrefs, 'voiceOver'>> & { voiceOver?: Partial<AudioPrefs['voiceOver']> },
	): void {
		state = parseAudioPrefs({
			...state,
			...patch,
			voiceOver: { ...state.voiceOver, ...(patch.voiceOver ?? {}) },
		});
		try {
			storage()?.setItem(KEY, JSON.stringify(state));
		} catch {
			/* quota / private mode: keep in memory */
		}
		for (const l of [...listeners]) l();
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};

export function useAudioPrefs(): AudioPrefs {
	return useSyncExternalStore(audioPrefs.subscribe, audioPrefs.get, audioPrefs.get);
}
