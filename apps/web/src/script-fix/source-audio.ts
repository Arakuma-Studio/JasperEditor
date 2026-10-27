// ▶ of a transcript fix in Review (spec 17 SC-082): plays the SOURCE recording from 1 s before the fixed words to 1 s
// after them — the recording, not the sequence, because a fix of a whole recording may lie outside what the sequence
// uses. Streams the engine's same-origin media URL through one <audio> element (range requests; nothing is decoded
// whole); a new play stops the previous one. Failures (offline media, a codec the browser cannot play) are reported in
// the store, never thrown. The project document and the transport are not touched.
import { createStore } from 'zustand/vanilla';
import { t } from '../i18n/runtime.ts';

const S = 705_600_000;
/** Context played around the fixed words (SC-082: ±1 s). */
export const SOURCE_CONTEXT_SEC = 1;

export type SourcePlayState = {
	/** The item playing (null: nothing). */
	itemId: string | null;
	error: string | null;
	epoch: number;
};

export const sourcePlayStore = createStore<SourcePlayState>(() => ({ itemId: null, error: null, epoch: 0 }));

/** What the player needs from an <audio> element (tests pass a fake). */
export type SourceAudioElement = {
	src: string;
	preload: string;
	currentTime: number;
	onerror: ((this: never, ev: Event | string) => unknown) | null;
	ontimeupdate: ((this: never, ev: Event) => unknown) | null;
	onloadedmetadata: ((this: never, ev: Event) => unknown) | null;
	play(): Promise<void>;
	pause(): void;
	removeAttribute(name: string): void;
	load(): void;
};

let makeElement: () => SourceAudioElement | null = () =>
	typeof Audio === 'undefined' ? null : (new Audio() as unknown as SourceAudioElement);
/** Tests: replace the element factory (returns the previous one). */
export function setSourceAudioFactory(f: () => SourceAudioElement | null): () => SourceAudioElement | null {
	const prev = makeElement;
	makeElement = f;
	return prev;
}

let current: { el: SourceAudioElement; timer: ReturnType<typeof setTimeout> | null } | null = null;

export function stopSourceAudio(): void {
	const c = current;
	current = null;
	if (c) {
		if (c.timer) clearTimeout(c.timer);
		c.el.onerror = null;
		c.el.ontimeupdate = null;
		c.el.onloadedmetadata = null;
		try {
			c.el.pause();
			c.el.removeAttribute('src');
			c.el.load();
		} catch {
			// a torn-down element
		}
	}
	if (sourcePlayStore.getState().itemId !== null)
		sourcePlayStore.setState((s) => ({ itemId: null, error: null, epoch: s.epoch + 1 }));
}

/**
 * Plays `url` from `start − 1 s` to `end + 1 s` (media flicks). Returns false (with the reason in the store) when it
 * cannot start.
 */
export function playSourceWindow(itemId: string, url: string, start: number, end: number): boolean {
	stopSourceAudio();
	const fail = (error: string) => {
		sourcePlayStore.setState((s) => ({ itemId: null, error, epoch: s.epoch + 1 }));
		return false;
	};
	if (!Number.isFinite(start) || !Number.isFinite(end)) return fail(t('The fix has no time in the recording'));
	const el = makeElement();
	if (!el) return fail(t('Audio playback is not available here'));
	const from = Math.max(0, start / S - SOURCE_CONTEXT_SEC);
	const to = Math.max(from + 0.1, Math.max(start, end) / S + SOURCE_CONTEXT_SEC);
	const mine = { el, timer: null as ReturnType<typeof setTimeout> | null };
	current = mine;
	const stopIfMine = () => {
		if (current === mine) stopSourceAudio();
	};
	el.preload = 'auto';
	el.onerror = () => {
		if (current !== mine) return;
		stopSourceAudio();
		fail(t('The recording could not be played (offline or a format this browser cannot play)'));
	};
	el.ontimeupdate = () => {
		if (current === mine && el.currentTime >= to) stopIfMine();
	};
	el.onloadedmetadata = () => {
		if (current !== mine) return;
		el.currentTime = from;
	};
	el.src = url;
	try {
		el.currentTime = from;
	} catch {
		// set again once the metadata is in
	}
	// a watchdog in case time updates stop (the window plus a generous load allowance)
	mine.timer = setTimeout(stopIfMine, (to - from + 15) * 1000);
	sourcePlayStore.setState((s) => ({ itemId, error: null, epoch: s.epoch + 1 }));
	el.play().catch((e: unknown) => {
		if (current !== mine) return;
		stopSourceAudio();
		fail(t('The recording could not be played: {0}', e instanceof Error ? e.message : String(e)));
	});
	return true;
}
