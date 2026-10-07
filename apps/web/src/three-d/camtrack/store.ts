// 3D Camera Tracker UI state (three-d): running analyses with their progress, the last error per clip, and the track
// points selected on the Program monitor. Never in the document.
import { useSyncExternalStore } from 'react';
import { createStore } from 'zustand/vanilla';

export type RunningSolve = {
	jobId: string | null;
	/** `cameraTrackerInputs` the job was started with (a result for other inputs is not committed). */
	inputs: string;
	progress: number;
	stage: string;
	startedAt: number;
};

type CamTrackUiState = {
	running: Record<string, RunningSolve>;
	errors: Record<string, string>;
	/** Selected track points (ids) of one clip's tracker. */
	selection: { clipId: string; ids: number[] } | null;
};

export const camtrackStore = createStore<CamTrackUiState>(() => ({
	running: {},
	errors: {},
	selection: null,
}));

export function useCamTrack<T>(selector: (s: CamTrackUiState) => T): T {
	return useSyncExternalStore(
		camtrackStore.subscribe,
		() => selector(camtrackStore.getState()),
		() => selector(camtrackStore.getState()),
	);
}

export const camtrackUi = {
	get: () => camtrackStore.getState(),
	patchRunning(clipId: string, p: Partial<RunningSolve> | null) {
		camtrackStore.setState((s) => {
			const running = { ...s.running };
			if (p === null) delete running[clipId];
			else
				running[clipId] = {
					...(running[clipId] ?? {
						jobId: null,
						inputs: '',
						progress: 0,
						stage: 'Starting',
						startedAt: Date.now(),
					}),
					...p,
				};
			return { running };
		});
	},
	setError(clipId: string, message: string | null) {
		camtrackStore.setState((s) => {
			const errors = { ...s.errors };
			if (message === null) delete errors[clipId];
			else errors[clipId] = message;
			return { errors };
		});
	},
	select(clipId: string, ids: number[], mode: 'replace' | 'add' | 'toggle' = 'replace') {
		camtrackStore.setState((s) => {
			const cur = s.selection?.clipId === clipId ? s.selection.ids : [];
			let next: number[];
			if (mode === 'replace') next = [...new Set(ids)];
			else if (mode === 'add') next = [...new Set([...cur, ...ids])];
			else {
				const set = new Set(cur);
				for (const id of ids) {
					if (set.has(id)) set.delete(id);
					else set.add(id);
				}
				next = [...set];
			}
			return { selection: next.length ? { clipId, ids: next } : null };
		});
	},
	clearSelection() {
		camtrackStore.setState({ selection: null });
	},
};
