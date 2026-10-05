// Monitor view state (S03:DM-020): per monitor, not in the document, not undoable. Persisted in
// localStorage (without pan) so zoom/overlay toggles survive reloads.
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Vec2, Zoom } from './viewport.ts';

export type PlaybackResolution = 'full' | '1/2' | '1/4' | '1/8';
export const PLAYBACK_RESOLUTIONS: readonly PlaybackResolution[] = ['full', '1/2', '1/4', '1/8'];

export type MonitorViewState = {
	zoom: Zoom;
	pan: Vec2;
	playbackResolution: PlaybackResolution;
	safeMargins: boolean;
	transparencyGrid: boolean;
	snapInMonitor: boolean;
};

type MonitorKind = 'program' | 'source';

const DEFAULT_MONITOR_VIEW: MonitorViewState = {
	zoom: 'fit',
	pan: [0, 0],
	playbackResolution: 'full',
	safeMargins: false,
	transparencyGrid: false,
	snapInMonitor: true,
};

const KEY = (kind: MonitorKind) => `jasper.monitor.${kind}.v1`;

function load(kind: MonitorKind): MonitorViewState {
	try {
		const raw = globalThis.localStorage?.getItem(KEY(kind));
		if (!raw) return { ...DEFAULT_MONITOR_VIEW };
		const v = JSON.parse(raw) as Partial<MonitorViewState>;
		return {
			...DEFAULT_MONITOR_VIEW,
			...v,
			pan: [0, 0],
			playbackResolution: PLAYBACK_RESOLUTIONS.includes(v.playbackResolution as PlaybackResolution)
				? (v.playbackResolution as PlaybackResolution)
				: 'full',
		};
	} catch {
		return { ...DEFAULT_MONITOR_VIEW };
	}
}

function createMonitorStore(kind: MonitorKind): StoreApi<MonitorViewState> {
	const store = createStore<MonitorViewState>(() => load(kind));
	store.subscribe((s) => {
		try {
			const { pan: _pan, ...rest } = s;
			globalThis.localStorage?.setItem(KEY(kind), JSON.stringify(rest));
		} catch {
			// storage full or unavailable: view state is best-effort
		}
	});
	return store;
}

export const monitorStores: Record<MonitorKind, StoreApi<MonitorViewState>> = {
	program: createMonitorStore('program'),
	source: createMonitorStore('source'),
};

/** Playback resolution → proxy toggle and tier (S03:PGM-030, ARCHITECTURE §2.3 proxy tiers). */
export function resolutionToProxy(r: PlaybackResolution): { useProxies: boolean; tier: '720' | '540' } {
	switch (r) {
		case 'full':
			return { useProxies: false, tier: '720' };
		case '1/2':
			return { useProxies: true, tier: '720' };
		default:
			return { useProxies: true, tier: '540' };
	}
}
