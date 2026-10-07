// audio-fx preview (docs/wp-notes/audio-fx.md §Preview): a clip whose audio needs the DSP chain (enabled audio
// effects, clip or track pan) plays through its own AudioWorkletNode hosting `ClipChain` — the same TypeScript the
// native export streams into ffmpeg. Remotion's <Audio> keeps decoding and scheduling the source; we hand it a
// SharedAudioContext whose `gainNode` is the clip's chain input, and whose `scheduleAudioNode` starts every buffer
// `latency` samples early (delay compensation of look-ahead/STFT effects). Levels, fades and pan are applied inside
// the chain (after the effects), so <Audio> plays at unity.
import {
	CLIP_CHAIN_PROCESSOR,
	type ClipChainConfig,
	type FromWorklet,
	type ToWorklet,
} from '@jasper/audio-fx';
import type { Animatable, Rational, RenderAudioClip } from '@jasper/project';
import { type ContextType, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Internals } from 'remotion';

type SharedAudio = NonNullable<ContextType<typeof Internals.SharedAudioContext>>;
type ScheduleOptions = Parameters<SharedAudio['scheduleAudioNode']>[0];

let workletUrl: string | null = null;
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** The web app registers the bundled worklet module (Vite `?worker&url`); null disables the FX preview. */
export function setAudioFxWorkletUrl(url: string | null): void {
	workletUrl = url;
}

/** True when the preview can host clip chains (worklet registered and AudioWorklet supported). */
export function audioFxPreviewAvailable(): boolean {
	return workletUrl !== null && typeof AudioWorkletNode !== 'undefined';
}

function loadWorklet(ctx: BaseAudioContext): Promise<void> {
	let p = loaded.get(ctx);
	if (!p) {
		p = ctx.audioWorklet.addModule(workletUrl!);
		loaded.set(ctx, p);
	}
	return p;
}

// ---------------------------------------------------------------- live meters (Effect Controls)

type MeterReading = { latency: number; values: Record<string, number[]> };
type MeterListener = (clipId: string, reading: MeterReading) => void;
const meterListeners = new Set<MeterListener>();
const meterWanted = new Map<string, number>();
const meterPorts = new Map<string, Set<MessagePort>>();

/**
 * Live meters of the previewed clip chains: `subscribe(clipIds, fn)` turns metering on for those clips while
 * subscribed (Effect Controls shows gain reduction and loudness for the selected clip).
 */
export const audioFxMeters = {
	subscribe(clipIds: readonly string[], fn: MeterListener): () => void {
		meterListeners.add(fn);
		for (const id of clipIds) {
			meterWanted.set(id, (meterWanted.get(id) ?? 0) + 1);
			for (const port of meterPorts.get(id) ?? []) port.postMessage({ type: 'meters', on: true } satisfies ToWorklet);
		}
		return () => {
			meterListeners.delete(fn);
			for (const id of clipIds) {
				const n = (meterWanted.get(id) ?? 1) - 1;
				if (n > 0) meterWanted.set(id, n);
				else {
					meterWanted.delete(id);
					for (const port of meterPorts.get(id) ?? [])
						port.postMessage({ type: 'meters', on: false } satisfies ToWorklet);
				}
			}
		};
	},
};

// ---------------------------------------------------------------- the chain node

/** The chain settings of a snapshot clip (sample rate filled in by the worklet). */
export function clipChainConfig(
	clip: RenderAudioClip,
	fps: Rational,
	master: { volumeDb: Animatable<number> } | undefined,
): ClipChainConfig {
	return {
		sampleRate: 48000,
		fps,
		clip: {
			start: clip.start,
			duration: clip.duration,
			sourceIn: clip.sourceIn,
			speed: { rate: clip.speed.rate, reverse: clip.speed.reverse },
			...(clip.headHandle ? { headHandle: clip.headHandle } : {}),
			...(clip.tailHandle ? { tailHandle: clip.tailHandle } : {}),
			gainDb: clip.gainDb,
			volumeDb: clip.volumeDb,
			pan: clip.pan,
			effects: clip.effects,
			track: clip.track,
			...(clip.fades ? { fades: clip.fades } : {}),
		},
		master: master ?? null,
	};
}

type Chain = { input: GainNode; node: AudioWorkletNode; latency: { samples: number } };

/**
 * The SharedAudioContext value to give the clip's <Audio>, or null while the worklet loads (or when there is no
 * audio context). The node lives as long as the layer; it is released a moment after unmount so the compensated
 * tail drains.
 */
export function useClipFxAudioContext(o: {
	clipId: string;
	config: ClipChainConfig;
	/** Composition frame of the clip span's first frame (the enclosing Sequence's `from`). */
	sequenceFrom: number;
	fps: Rational;
}): SharedAudio | null {
	const shared = useContext(Internals.SharedAudioContext);
	const { playbackRate } = Internals.usePlaybackRate();
	const ctx = shared?.audioContext ?? null;
	const destination = shared?.gainNode ?? null;
	const [chain, setChain] = useState<Chain | null>(null);
	const configRef = useRef(o.config);
	configRef.current = o.config;

	useEffect(() => {
		if (!ctx || !destination || !workletUrl) return;
		let cancelled = false;
		let made: Chain | null = null;
		loadWorklet(ctx)
			.then(() => {
				if (cancelled) return;
				const node = new AudioWorkletNode(ctx, CLIP_CHAIN_PROCESSOR, {
					numberOfInputs: 1,
					numberOfOutputs: 1,
					outputChannelCount: [2],
					channelCount: 2,
					channelCountMode: 'explicit',
					channelInterpretation: 'speakers',
				});
				const input = ctx.createGain();
				input.channelCount = 2;
				input.channelCountMode = 'explicit';
				input.connect(node);
				node.connect(destination);
				const latency = { samples: 0 };
				node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
					const m = e.data;
					if (m.type === 'latency') latency.samples = m.samples;
					else for (const fn of meterListeners) fn(o.clipId, { latency: m.latency, values: m.values });
				};
				node.port.postMessage({ type: 'config', config: configRef.current } satisfies ToWorklet);
				made = { input, node, latency };
				let ports = meterPorts.get(o.clipId);
				if (!ports) meterPorts.set(o.clipId, (ports = new Set()));
				ports.add(node.port);
				if (meterWanted.has(o.clipId)) node.port.postMessage({ type: 'meters', on: true } satisfies ToWorklet);
				setChain(made);
			})
			.catch(() => {
				// No AudioWorklet (or the module failed): the layer stays silent rather than playing unprocessed audio.
			});
		return () => {
			cancelled = true;
			const c = made;
			if (!c) return;
			meterPorts.get(o.clipId)?.delete(c.node.port);
			// Let the compensated tail drain, then release the node.
			setTimeout(() => {
				c.node.port.postMessage({ type: 'dispose' } satisfies ToWorklet);
				c.input.disconnect();
				c.node.disconnect();
			}, 250);
		};
	}, [ctx, destination, o.clipId]);

	// Settings → worklet.
	useEffect(() => {
		chain?.node.port.postMessage({ type: 'config', config: o.config } satisfies ToWorklet);
	}, [chain, o.config]);

	// Time mapping → worklet (on every anchor change: play, seek, rate change).
	const startSec = (o.sequenceFrom * o.fps.den) / o.fps.num;
	useEffect(() => {
		if (!chain || !shared) return;
		const post = () =>
			chain.node.port.postMessage({
				type: 'timing',
				anchor: shared.audioSyncAnchor.value,
				rate: playbackRate,
				startSec,
			} satisfies ToWorklet);
		post();
		const sub = shared.audioSyncAnchorEmitter.subscribe(post);
		return () => sub.remove();
	}, [chain, shared, playbackRate, startSec]);

	return useMemo(() => {
		if (!shared || !chain || !ctx) return null;
		const schedule = (opts: ScheduleOptions) => {
			const shift = chain.latency.samples / ctx.sampleRate;
			if (shift <= 0) return shared.scheduleAudioNode(opts);
			let { scheduledTime, offset, duration } = opts;
			scheduledTime -= shift;
			const now = ctx.currentTime;
			if (scheduledTime < now) {
				const late = (now - scheduledTime) * opts.node.playbackRate.value;
				offset += late;
				duration -= late;
				scheduledTime = now;
			}
			return shared.scheduleAudioNode({ ...opts, scheduledTime, offset, duration });
		};
		return { ...shared, gainNode: chain.input, scheduleAudioNode: schedule };
	}, [shared, chain, ctx]);
}
