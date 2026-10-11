import { z } from 'zod';
// Multi-Camera view state (wp-multicam): editor state, not project data — persisted in localStorage like the other
// monitor settings (Program monitor ▸ Settings ▸ Multi-Camera). The live recording pass is session-only.
import { createStore, type StoreApi } from 'zustand/vanilla';

export type MulticamViewState = {
	/** Program monitor shows the Multi-Camera view (Shift+0). */
	view: boolean;
	/** Show Multi-Camera Preview Monitor: the program next to the grid (off: the grid fills the monitor). */
	showPreview: boolean;
	/** Multi-Camera Selection Top Down: of stacked multi-camera clips, the topmost is switched. */
	topDown: boolean;
	/** Multi-Camera Audio Follows Video: switching the picture switches the linked multi-camera audio too. */
	audioFollowsVideo: boolean;
	/** Grid layout: auto, 2×2, 3×3, 4×4 (paged when the cameras do not fit). */
	layout: 'auto' | 2 | 3 | 4;
	page: number;
	/** Show the camera names over the cells. */
	showNames: boolean;
};

const DEFAULTS: MulticamViewState = {
	view: false,
	showPreview: true,
	topDown: false,
	audioFollowsVideo: true,
	layout: 'auto',
	page: 0,
	showNames: true,
};

const KEY = 'jasper.multicam.view.v1';

const MulticamViewSchema = z.object({
	view: z.boolean().catch(DEFAULTS.view),
	showPreview: z.boolean().catch(DEFAULTS.showPreview),
	topDown: z.boolean().catch(DEFAULTS.topDown),
	audioFollowsVideo: z.boolean().catch(DEFAULTS.audioFollowsVideo),
	layout: z.union([z.literal('auto'), z.literal(2), z.literal(3), z.literal(4)]).catch('auto'),
	showNames: z.boolean().catch(DEFAULTS.showNames),
});

export function parseMulticamView(value: unknown): MulticamViewState {
	const parsed = MulticamViewSchema.safeParse(value);
	return parsed.success ? { ...parsed.data, page: 0 } : { ...DEFAULTS };
}

function load(): MulticamViewState {
	try {
		const raw = globalThis.localStorage?.getItem(KEY);
		if (!raw) return { ...DEFAULTS };
		return parseMulticamView(JSON.parse(raw));
	} catch {
		return { ...DEFAULTS };
	}
}

export const multicamViewStore: StoreApi<MulticamViewState> = createStore<MulticamViewState>(() => load());
multicamViewStore.subscribe((s) => {
	try {
		globalThis.localStorage?.setItem(KEY, JSON.stringify(s));
	} catch {
		// best effort
	}
});

/** A live switching pass in progress: cuts recorded while playing, applied as one gesture (one undo step). */
export type RecorderState = {
	recording: boolean;
	sequenceId: string | null;
	trackId: string | null;
	cuts: { at: number; angle: string }[];
};

export const multicamRecorderStore: StoreApi<RecorderState> = createStore<RecorderState>(() => ({
	recording: false,
	sequenceId: null,
	trackId: null,
	cuts: [],
}));
