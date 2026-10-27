// Brush choices and job progress are UI state and must not enter project documents.
import { useSyncExternalStore } from 'react';
import { createStore } from 'zustand/vanilla';

export type RotoView = 'overlay' | 'boundary' | 'alpha' | 'off';

export type RunningRoto = {
	jobId: string | null;
	direction: 'both' | 'forward' | 'backward' | 'frame';
	startedAt: number;
	done: number;
	total: number;
	/** Last frame computed (media frame). */
	frame: number | null;
	finishing?: boolean;
};

type RotoUiState = {
	/** The Roto Brush tool is active on the Program monitor. */
	tool: boolean;
	/** Brush radius in screen px (Ctrl-drag on the monitor resizes it, After Effects). */
	radius: number;
	/** Stroke kind of a plain drag (Alt-drag subtracts / erases). */
	brush: 'segment' | 'refine';
	/** The roto object the monitor shows and the brush adds to. */
	activeRotoId: string | null;
	view: RotoView;
	/** Propagate the whole span after each stroke (otherwise only the stroked frame is segmented). */
	autoPropagate: boolean;
	running: Record<string, RunningRoto>;
	errors: Record<string, string>;
};

export const rotoStore = createStore<RotoUiState>(() => ({
	tool: false,
	radius: 12,
	brush: 'segment',
	activeRotoId: null,
	view: 'overlay',
	autoPropagate: false,
	running: {},
	errors: {},
}));

export function useRoto<T>(selector: (s: RotoUiState) => T): T {
	return useSyncExternalStore(
		rotoStore.subscribe,
		() => selector(rotoStore.getState()),
		() => selector(rotoStore.getState()),
	);
}

export const rotoUi = {
	get: () => rotoStore.getState(),
	set: (p: Partial<RotoUiState>) => rotoStore.setState(p),
	setActive(id: string | null) {
		rotoStore.setState({ activeRotoId: id });
	},
	patchRunning(id: string, p: Partial<RunningRoto> | null) {
		rotoStore.setState((s) => {
			const running = { ...s.running };
			if (p === null) delete running[id];
			else
				running[id] = {
					...(running[id] ?? {
						jobId: null,
						direction: 'both',
						startedAt: Date.now(),
						done: 0,
						total: 0,
						frame: null,
					}),
					...p,
				};
			return { running };
		});
	},
	setError(id: string, message: string | null) {
		rotoStore.setState((s) => {
			const errors = { ...s.errors };
			if (message === null) delete errors[id];
			else errors[id] = message;
			return { errors };
		});
	},
};
