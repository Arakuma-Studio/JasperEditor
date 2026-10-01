// Tracking UI state (S09:TRU-001…003): the active tracker, per-tracker options (quality, planar options), running
// `track` jobs with their live `tracking.progress` geometry and trail, the Corner Pin handles toggle, and the
// last error per tracker. Never in the document (options are UI preferences; results are committed as samples).

import type { TrackMode, TrackPlan, TrackQuality, Vec2 } from '@jasper/project';
import { useSyncExternalStore } from 'react';
import { createStore } from 'zustand/vanilla';

type TrackerOptions = {
	quality: TrackQuality;
	/** Planar: take features from a ring around the quad (screens whose content changes). */
	surroundings: boolean;
	/** Planar: snap the quad's sides to straight edges (engine `options.refineEdges`). */
	refineEdges: boolean;
};

const DEFAULT_OPTIONS: TrackerOptions = {
	quality: 'balanced',
	surroundings: false,
	refineEdges: true,
};
const POINT_OPTIONS: TrackerOptions = { quality: 'balanced', surroundings: false, refineEdges: false };

type LiveProgress = {
	/** Source frame of the plate media. */
	frame: number;
	data: number[];
	confidence: number;
	done: number;
	total: number;
};

export type RunningTrack = {
	/** Null while the request is in flight. */
	jobId: string | null;
	mode: TrackMode;
	plan: TrackPlan;
	mediaKey: string;
	startedAt: number;
	progress: LiveProgress | null;
	/** Last tracked centres (media px), oldest first, ≤ 30. */
	trail: Vec2[];
	/** Set while the result is being fetched/committed (guards duplicate finish events). */
	finishing?: boolean;
};

type TrackingState = {
	/** The tracker whose overlay is shown (it must belong to a selected clip). */
	activeTrackerId: string | null;
	options: Record<string, TrackerOptions>;
	running: Record<string, RunningTrack>;
	errors: Record<string, string>;
	/** Show the corner-pin handles on the Program monitor for the selected clip (TRU-003 tool mode). */
	cornerPinTool: boolean;
	/** Throttled redraw counter of the live progress of running jobs per tracker (timeline strips, live.ts). */
	liveVersion: Record<string, number>;
};

const initial = (): TrackingState => ({
	activeTrackerId: null,
	options: {},
	running: {},
	errors: {},
	cornerPinTool: false,
	liveVersion: {},
});

export const trackingStore = createStore<TrackingState>(() => initial());

export function resetTrackingStore(): void {
	trackingStore.setState(initial(), true);
}

export function useTracking<T>(selector: (s: TrackingState) => T): T {
	return useSyncExternalStore(
		trackingStore.subscribe,
		() => selector(trackingStore.getState()),
		() => selector(trackingStore.getState()),
	);
}

export function optionsOf(trackerId: string, kind: 'point' | 'planar' = 'planar'): TrackerOptions {
	return trackingStore.getState().options[trackerId] ?? (kind === 'planar' ? DEFAULT_OPTIONS : POINT_OPTIONS);
}

export function setOptions(
	trackerId: string,
	kind: 'point' | 'planar',
	patch: Partial<TrackerOptions>,
): void {
	trackingStore.setState((s) => ({
		options: { ...s.options, [trackerId]: { ...optionsOf(trackerId, kind), ...patch } },
	}));
}

export function setActiveTracker(id: string | null): void {
	if (trackingStore.getState().activeTrackerId !== id) trackingStore.setState({ activeTrackerId: id });
}

export function setError(trackerId: string, message: string | null): void {
	trackingStore.setState((s) => {
		const errors = { ...s.errors };
		if (message) errors[trackerId] = message;
		else delete errors[trackerId];
		return { errors };
	});
}

export function patchRunning(trackerId: string, patch: Partial<RunningTrack> | null): void {
	trackingStore.setState((s) => {
		const running = { ...s.running };
		if (patch === null) delete running[trackerId];
		else if (running[trackerId]) running[trackerId] = { ...running[trackerId]!, ...patch };
		else return {};
		return { running };
	});
}
