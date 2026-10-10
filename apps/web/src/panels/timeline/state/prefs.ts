// Per-user timeline preferences (S02:TL-330 display settings persisted per user, TL-119 follow mode,
// TL-264 header width). Stored in localStorage; not per sequence, never in the document.
import { createStore, type StoreApi } from 'zustand/vanilla';

export type ThumbnailStyle = 'off' | 'head' | 'head-tail' | 'continuous';

export type TimelinePrefs = {
	version: 1;
	headerWidth: number;
	thumbnails: ThumbnailStyle;
	showVideoNames: boolean;
	showAudioNames: boolean;
	showWaveforms: boolean;
	rectifiedWaveforms: boolean;
	showClipMarkers: boolean;
	showFxBadges: boolean;
	showEngineBadges: boolean;
	showLabelColors: boolean;
	follow: 'page' | 'smooth' | 'none';
	/** TL-111 "Mouse wheel scrolls horizontally" override (null = platform default). */
	wheelHorizontal: boolean | null;
	/** TL-455 "Snap playhead in timeline when snap is enabled". */
	snapPlayhead: boolean;
	/** gaps (Premiere's Show Audio Time Units): ruler and playhead in the project's audio display format. */
	showAudioTimeUnits?: boolean;
};

export const HEADER_MIN = 140;
export const HEADER_MAX = 280;

function defaultPrefs(): TimelinePrefs {
	return {
		version: 1,
		headerWidth: 176,
		thumbnails: 'continuous',
		showVideoNames: true,
		showAudioNames: true,
		showWaveforms: true,
		rectifiedWaveforms: true,
		showClipMarkers: true,
		showFxBadges: true,
		showEngineBadges: true,
		showLabelColors: true,
		follow: 'page',
		wheelHorizontal: null,
		snapPlayhead: false,
	};
}

const KEY = 'jasper.timeline.prefs.v1';

function load(): TimelinePrefs {
	try {
		const raw = globalThis.localStorage?.getItem(KEY);
		if (!raw) return defaultPrefs();
		const parsed = JSON.parse(raw) as Partial<TimelinePrefs>;
		return { ...defaultPrefs(), ...parsed, version: 1 };
	} catch {
		return defaultPrefs();
	}
}

let store: StoreApi<TimelinePrefs> | null = null;

/** The shared per-user preference store (lazily loaded; writes are persisted). */
export function timelinePrefs(): StoreApi<TimelinePrefs> {
	if (store) return store;
	const s = createStore<TimelinePrefs>(() => load());
	s.subscribe((v) => {
		try {
			globalThis.localStorage?.setItem(KEY, JSON.stringify(v));
		} catch {
			/* storage may be unavailable (private mode, tests) */
		}
	});
	store = s;
	return s;
}

export function setPrefs(patch: Partial<TimelinePrefs>): void {
	timelinePrefs().setState(patch);
}
