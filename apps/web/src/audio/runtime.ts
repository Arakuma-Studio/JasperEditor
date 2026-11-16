// The web side of the preview mix (audio-mix): installs the AudioWorklet module, follows the Program monitor's mix
// graph and exposes it to panels (Audio Meters, Audio Track / Clip Mixer) as React hooks.
import {
	activeMixGraph,
	installAudioFxPreview,
	type MeterReading,
	type MixGraph,
	onActiveMixGraph,
	previewRubberBand,
	setMixWorkletUrl,
	VISIBLE_START_WAIT,
} from '@jasper/compositions';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { auditionMeter } from './audition-meter.ts';
import { audioPrefs } from './prefs.ts';
import { RUBBERBAND_WASM_URL } from './rubberband-url.ts';
import { MIX_WORKLET_URL } from './worklet-url.ts';

let installed = false;
/** Called once at start-up (commands/audio.ts). */
export function installAudioRuntime(): void {
	if (installed) return;
	installed = true;
	setMixWorkletUrl(MIX_WORKLET_URL);
	// audio-fx: audio effects play through their preview slots (AudioWorklet, the export's DSP code).
	installAudioFxPreview();
	// the Pitch Shifter's Rubber Band engine: fetched once, when the first Pitch Shifter slot needs it
	previewRubberBand.setLoader(async () => {
		const r = await fetch(RUBBERBAND_WASM_URL);
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		return WebAssembly.compile(await r.arrayBuffer());
	});
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
 * reading yet (the meters then show silence). While a Sound Library audition plays, the Mix shows the audition
 * (`auditionMeter`: what reaches the output).
 */
export function useMeterReading(graph: MixGraph | null, stripId: string): MeterReading | null {
	const [r, setR] = useState<MeterReading | null>(
		() => (stripId === 'master' ? auditionMeter.last() : null) ?? graph?.lastMeter(stripId) ?? null,
	);
	useEffect(() => {
		let pending: MeterReading | null = null;
		let raf = 0;
		const push = (m: MeterReading | null) => {
			pending = m;
			if (!raf)
				raf = requestAnimationFrame(() => {
					raf = 0;
					setR(pending);
				});
		};
		const offGraph = graph
			? graph.onMeter(stripId, (m) => {
					if (!(stripId === 'master' && auditionMeter.active())) push(m);
				})
			: null;
		const offAudition =
			stripId === 'master'
				? auditionMeter.subscribe((m) => push(m ?? graph?.lastMeter(stripId) ?? null))
				: null;
		if (!graph && !auditionMeter.active()) setR(null);
		return () => {
			offGraph?.();
			offAudition?.();
			if (raf) cancelAnimationFrame(raf);
		};
	}, [graph, stripId]);
	return r;
}

/**
 * Whether the Program monitor's audio holds the picture at a primed start for at least `VISIBLE_START_WAIT` seconds
 * (sound-design Phase 6: a long read-ahead — many latent effects — waits for the program instead of losing its first
 * samples; the monitor shows it as buffering).
 */
export function useAudioStartWait(graph: MixGraph | null): boolean {
	const [waiting, setWaiting] = useState(false);
	useEffect(() => {
		if (!graph) return;
		setWaiting(false);
		return graph.onStartWait((w) => setWaiting(w !== null && w >= VISIBLE_START_WAIT));
	}, [graph]);
	return waiting;
}
