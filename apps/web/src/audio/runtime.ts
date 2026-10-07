// The web side of the preview mix (audio-mix): installs the AudioWorklet module, follows the Program monitor's mix
// graph and exposes it to panels (Audio Meters, Audio Track / Clip Mixer) as React hooks.
import {
	activeMixGraph,
	type MeterReading,
	type MixGraph,
	onActiveMixGraph,
	installAudioFxPreview,
	setMixWorkletUrl,
} from '@jasper/compositions';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { audioPrefs } from './prefs.ts';
import { MIX_WORKLET_URL } from './worklet-url.ts';

let installed = false;
/** Called once at start-up (commands/audio.ts). */
export function installAudioRuntime(): void {
	if (installed) return;
	installed = true;
	setMixWorkletUrl(MIX_WORKLET_URL);
	// audio-fx: audio effects play through their preview slots (AudioWorklet, the export's DSP code).
	installAudioFxPreview();
	const apply = (g: MixGraph | null) => g?.setMixdown(audioPrefs.get().mixdown);
	onActiveMixGraph(apply);
	audioPrefs.subscribe(() => apply(activeMixGraph()));
}

const subscribeGraph = (cb: () => void) => onActiveMixGraph(() => cb());

/** The Program monitor's preview mix graph (null until audio has played once / without Web Audio). */
export function useMixGraph(): MixGraph | null {
	return useSyncExternalStore(subscribeGraph, activeMixGraph, () => null);
}

/** Re-renders when the graph's topology or monitor solo changes. */
export function useGraphVersion(graph: MixGraph | null): number {
	const [v, setV] = useState(0);
	useEffect(() => (graph ? graph.onChange(() => setV((x) => x + 1)) : undefined), [graph]);
	return v;
}

/**
 * Latest meter reading of a strip (`master` = the Mix), throttled to animation frames. Null when no graph or no
 * reading yet (the meters then show silence).
 */
export function useMeterReading(graph: MixGraph | null, stripId: string): MeterReading | null {
	const [r, setR] = useState<MeterReading | null>(() => graph?.lastMeter(stripId) ?? null);
	useEffect(() => {
		if (!graph) {
			setR(null);
			return;
		}
		let pending: MeterReading | null = null;
		let raf = 0;
		const off = graph.onMeter(stripId, (m) => {
			pending = m;
			if (!raf)
				raf = requestAnimationFrame(() => {
					raf = 0;
					setR(pending);
				});
		});
		return () => {
			off();
			if (raf) cancelAnimationFrame(raf);
		};
	}, [graph, stripId]);
	return r;
}
