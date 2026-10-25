// Audio layer (S03:KND-020, KND-011): @remotion/media <Audio> with `trimBefore` from sourceIn,
// `playbackRate = speed` and a per-frame volume callback. An audio crossfade (S10:TUI-052) plays the clip's handles: the
// enclosing <Sequence> starts `headHandle` frames before the clip and lasts `duration + head + tail`.
// edit-structure: clips flattened out of nested sequences carry their nested gain (`nestGain`, dB per sequence frame);
// synthetic sounds (Bars and Tone's tone, the leader's blips) play a WAV generated in the page from the same samples
// the native export writes (`syntheticSamples`).
// audio-mix: in the Program preview the clip plays into the mix graph (`MixGraphContext`): Remotion's per-clip gain
// node connects to our clip node through an overridden SharedAudioContext, the callback applies the clip's gain,
// volume, fades and nested gain, and the graph does clip pan, the track strip (fader, pan law, sends, mute/solo),
// submixes, the Mix, loudness normalisation and metering. Without a graph (no Web Audio) the callback also applies
// the track and master faders as before.

import {
	audioFadeGain,
	encodeWavStereo16,
	FLICKS_PER_SECOND,
	type MediaHandle,
	nestGainDbAt,
	type Rational,
	type RenderAudioClip,
	type SyntheticSound,
	syntheticSamples,
} from '@jasper/project';
import { Audio } from '@remotion/media';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { cancelRender, continueRender, delayRender, getRemotionEnvironment, Internals } from 'remotion';
import { MixGraphContext } from '../audio/context.ts';
import { clipEffectsLatency, graphAppliesLevels, type MixGraph } from '../audio/graph.ts';
import { mappedAudioUrl, reversedAudioUrl } from '../audio/reversed.ts';
import { audioGainAt, audioSrc, dbToGain, videoTrimBefore, volumeFrameToClipFrame } from '../pipeline.ts';
import type { RenderOptions } from '../types.ts';

/**
 * Linear gain of an audio layer at frame `layerFrame` of its <Sequence> (which starts `headHandle` frames
 * before the clip). Levels (gain, volume, track, master) are those of the nearest clip frame; the fades are
 * evaluated at the real sequence frame, so a crossfade ramps through the handles exactly like `afade` does
 * in the native export.
 */
function audioLayerGain(
	clip: Pick<
		RenderAudioClip,
		'start' | 'duration' | 'sourceIn' | 'speed' | 'gainDb' | 'volumeDb' | 'track' | 'fades' | 'headHandle'
	> & { nestGain?: RenderAudioClip['nestGain'] },
	layerFrame: number,
	fps: Rational,
	master: { volumeDb: RenderAudioClip['volumeDb'] } | undefined,
	includeBus: boolean,
): number {
	const { fades, headHandle, nestGain, ...levels } = clip;
	const f = layerFrame - (headHandle ?? 0); // clip-local frame (negative inside the head handle)
	return (
		audioGainAt(levels, f, fps, master, includeBus) *
		audioFadeGain(fades, clip.start + f) *
		(nestGain ? dbToGain(nestGainDbAt(nestGain, clip.start + f)) : 1)
	);
}

export type AudioLayerProps = {
	clip: RenderAudioClip;
	media: MediaHandle | null;
	fps: number;
	options: RenderOptions;
	/** Exact sequence rate (content-time math); defaults to `{num: fps, den: 1}`. */
	fpsRational?: Rational;
	/** Master fader of the sequence. */
	master?: { volumeDb: RenderAudioClip['volumeDb'] };
	/**
	 * The `from` of the enclosing <Sequence> (negative when the render range starts inside the clip); the
	 * Sequence starts `clip.headHandle` frames before the clip.
	 */
	sequenceFrom?: number;
};

export function AudioLayer({
	clip,
	media,
	fps,
	options,
	fpsRational,
	master,
	sequenceFrom = 0,
}: AudioLayerProps) {
	const num = fpsRational?.num ?? fps;
	const den = fpsRational?.den ?? 1;
	const graph = useContext(MixGraphContext);
	const shared = useContext(Internals.SharedAudioContext);
	const node = graph ? graph.clipInput(clip) : null;
	useEffect(() => (graph ? () => graph.releaseClip(clip.clipId) : undefined), [graph, clip.clipId]);
	// audio-fx: a clip with enabled effects plays at unity into the graph, which applies its levels after the effect
	// slots (export order); so does a clip whose level changes over time (Volume keyframes, fades, nested gain): the
	// graph follows it sample by sample while playing, where this callback would step once per frame (sound-design
	// Phase 4 verification). The source is scheduled early by the latency of its effect slots plus the graph's
	// read-ahead (track / submix / Mix inserts and the loudness limiter, compensated like the export: `MixGraph`), so
	// what leaves the Mix lines up with the picture.
	const fx = !!node && graphAppliesLevels(clip);
	const graphLatency = useGraphLatency(node ? graph : null);
	const epoch = useGraphEpoch(node ? graph : null);
	const fxLatency = useMemo(
		() => (fx && graph ? clipEffectsLatency(clip.effects, graph.sampleRate) / graph.sampleRate : 0),
		[fx, graph, clip.effects],
	);
	const clipRef = useRef(clip);
	clipRef.current = clip;
	// The schedule epoch the media player's buffers are being scheduled for (read when each buffer is scheduled).
	const epochRef = useRef(epoch);
	epochRef.current = epoch;
	// A stable context value: Remotion re-creates its media player when the context object changes (only with the
	// shared context or the clip node). When every source must schedule again — the graph's read-ahead or a primed
	// start changed while paused (`MixGraph.epoch`), or the clip's own effect latency changed — the player is not
	// re-created (that re-opened and re-probed the media, sound-design Phase 6): its trim moves by a millionth of a
	// frame (`TRIM_NUDGE`, a 0.03 µs shift), which makes Remotion drop its queued buffers and schedule again from the
	// current position with the current anchor; the lead is read when each buffer is scheduled.
	const routed = useMemo(
		() =>
			shared && node && graph
				? {
						...shared,
						gainNode: node,
						...compensate(
							shared,
							() => graph.clipLead(clipRef.current),
							// the player is under way: a playback held for the sources to start again may go on
							() => graph.noteScheduled(clipRef.current.clipId, epochRef.current),
						),
					}
				: null,
		[shared, node, graph],
	);
	const nudge = useToggle(routed ? `${epoch}|${fxLatency}` : '');
	// The source plays `graphLatency` ahead of the picture: its levels are those of the samples it is playing.
	const leadFrames = routed ? (graphLatency * num) / den : 0;
	const volume = useCallback(
		(f: number) =>
			fx
				? 1
				: audioLayerGain(
						clip,
						volumeFrameToClipFrame(f, sequenceFrom) + leadFrames,
						{ num, den },
						master,
						!routed,
					),
		[clip, num, den, master, sequenceFrom, routed, fx, leadFrames],
	);
	const generated = useGeneratedAudio(clip, { num, den });
	// pp-wma-preview: audio the browser cannot decode plays from the engine's playback audio (the clip's stream).
	const mediaUrl =
		!generated && media && (media.hasAudio || media.kind === 'audio')
			? audioSrc(media, clip.channels.streamIndex, options)
			: null;
	// Remotion's Audio plays forwards only; reversed and interpreted ranges use a WAV prepared in the page.
	const mapped = !!clip.mediaTime;
	const reversed = useReversedAudio(clip, clip.speed.reverse && !mapped ? mediaUrl : null, { num, den });
	const mappedUrl = useMappedAudio(clip, mapped ? mediaUrl : null, { num, den });
	const src = generated ?? (mapped ? mappedUrl : clip.speed.reverse ? reversed : mediaUrl);
	if (!src) return null;
	const audio = (
		<Audio
			src={src}
			trimBefore={
				((reversed && src === reversed) || (mappedUrl && src === mappedUrl)
					? 0
					: videoTrimBefore(clip, { num, den })) + (nudge ? TRIM_NUDGE : 0)
			}
			playbackRate={clip.speed.rate}
			volume={volume}
			showInTimeline={false}
		/>
	);
	return routed ? (
		<Internals.SharedAudioContext.Provider value={routed}>{audio}</Internals.SharedAudioContext.Provider>
	) : (
		audio
	);
}

/**
 * The reversed WAV of a reversed clip's content (its handles included): WAV time 0 is the content shown at the first
 * frame of the clip's <Sequence> (`headHandle` frames before the clip), so it plays with `trimBefore` 0 at the clip's
 * speed. Renders wait for it (delayRender); the preview is silent until it is ready.
 */
function useReversedAudio(clip: RenderAudioClip, src: string | null, fps: Rational): string | null {
	const [url, setUrl] = useState<string | null>(null);
	const F = (FLICKS_PER_SECOND * fps.den) / fps.num;
	const step = F * clip.speed.rate;
	const hi = (clip.sourceIn + (clip.duration + (clip.headHandle ?? 0)) * step) / FLICKS_PER_SECOND;
	const lo = Math.max(0, clip.sourceIn - (clip.tailHandle ?? 0) * step) / FLICKS_PER_SECOND;
	const rendering = getRemotionEnvironment().isRendering;
	useEffect(() => {
		if (!src) {
			setUrl(null);
			return;
		}
		let alive = true;
		const handle = rendering ? delayRender(`Reversed audio of ${src}`) : null;
		void reversedAudioUrl(src, lo, hi)
			.then((u) => {
				if (alive) setUrl(u);
			})
			.catch((e: unknown) => {
				if (rendering) cancelRender(e instanceof Error ? e : new Error(String(e)));
			})
			.finally(() => {
				if (handle !== null) continueRender(handle);
			});
		return () => {
			alive = false;
		};
	}, [src, lo, hi, rendering]);
	return src ? url : null;
}

/**
 * The WAV of a clip of interpreted media (Interpret Footage ▸ assumed frame rate / loop): its content range with the
 * handles, in interpreted time (`mappedAudioUrl`); WAV time 0 is the content shown at the first frame of the clip's
 * <Sequence>, so it plays with `trimBefore` 0 at the clip's speed (reversed clips: reversed). Renders wait for it.
 */
function useMappedAudio(clip: RenderAudioClip, src: string | null, fps: Rational): string | null {
	const [url, setUrl] = useState<string | null>(null);
	const F = (FLICKS_PER_SECOND * fps.den) / fps.num;
	const step = F * clip.speed.rate;
	const reverse = clip.speed.reverse;
	const head = clip.headHandle ?? 0;
	const tail = clip.tailHandle ?? 0;
	const lo = Math.max(0, clip.sourceIn - (reverse ? tail : head) * step);
	const hi = clip.sourceIn + (clip.duration + (reverse ? head : tail)) * step;
	const map = clip.mediaTime;
	const rendering = getRemotionEnvironment().isRendering;
	const mapKey = map ? `${map.scale}|${map.period ?? 0}` : '';
	// biome-ignore lint/correctness/useExhaustiveDependencies: the map is keyed by its values
	useEffect(() => {
		if (!src || !map) {
			setUrl(null);
			return;
		}
		let alive = true;
		const handle = rendering ? delayRender(`Interpreted audio of ${src}`) : null;
		void mappedAudioUrl(src, map, lo, hi, reverse)
			.then((u) => {
				if (alive) setUrl(u);
			})
			.catch((e: unknown) => {
				if (rendering) cancelRender(e instanceof Error ? e : new Error(String(e)));
			})
			.finally(() => {
				if (handle !== null) continueRender(handle);
			});
		return () => {
			alive = false;
		};
	}, [src, mapKey, lo, hi, reverse, rendering]);
	return src ? url : null;
}

type SharedAudio = NonNullable<React.ContextType<typeof Internals.SharedAudioContext>>;

/** Frames the trim moves by to have Remotion schedule a media player's audio again (`AudioLayer`). */
const TRIM_NUDGE = 1e-6;

/** Flips each time `key` changes after the first render (false at first). */
function useToggle(key: string): boolean {
	const state = useRef({ key, on: false });
	if (state.current.key !== key) state.current = { key, on: !state.current.on };
	return state.current.on;
}

const noGraph = () => () => undefined;

/** The mix graph's read-ahead in seconds (0 without a graph); re-renders when it changes. */
export function useGraphLatency(graph: MixGraph | null): number {
	const subscribe = useMemo(() => (graph ? (cb: () => void) => graph.onLatency(cb) : noGraph), [graph]);
	const get = useCallback(() => graph?.latency ?? 0, [graph]);
	return useSyncExternalStore(subscribe, get, get);
}

/** The mix graph's schedule epoch (`MixGraph.epoch`, 0 without a graph); re-renders when it changes. */
export function useGraphEpoch(graph: MixGraph | null): number {
	const subscribe = useMemo(() => (graph ? (cb: () => void) => graph.onLatency(cb) : noGraph), [graph]);
	const get = useCallback(() => graph?.epoch ?? 0, [graph]);
	return useSyncExternalStore(subscribe, get, get);
}

/**
 * A `scheduleAudioNode` that starts every source buffer `lead()` seconds early (effect latency compensation and the
 * graph's read-ahead), read when the buffer is scheduled; `scheduled` is told of every buffer.
 */
function compensate(shared: SharedAudio, lead: () => number, scheduled?: () => void): Partial<SharedAudio> {
	return {
		scheduleAudioNode: (opts) => {
			scheduled?.();
			const shift = lead();
			if (!(shift > 0)) return shared.scheduleAudioNode(opts);
			const ctx = shared.audioContext;
			let { scheduledTime, offset, duration } = opts;
			scheduledTime -= shift;
			const now = ctx?.currentTime ?? scheduledTime;
			if (scheduledTime < now) {
				const late = (now - scheduledTime) * opts.node.playbackRate.value;
				offset += late;
				duration -= late;
				scheduledTime = now;
			}
			return shared.scheduleAudioNode({ ...opts, scheduledTime, offset, duration });
		},
	};
}

const SAMPLE_RATE = 48000;
const generatedUrls = new Map<string, string>();

/**
 * A WAV (blob URL) of a synthetic sound from content time 0 to `seconds` (one per sound and length, kept for the
 * page's life). Content time 0 is file time 0, so the clip's `sourceIn` maps like media.
 */
export function generatedAudioUrl(sound: SyntheticSound, seconds: number, frameSeconds: number): string {
	const key = `${JSON.stringify(sound)}|${seconds}|${frameSeconds}`;
	const hit = generatedUrls.get(key);
	if (hit) return hit;
	const samples = syntheticSamples(sound, 0, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE, frameSeconds);
	const wav = encodeWavStereo16(samples, SAMPLE_RATE);
	const url = URL.createObjectURL(new Blob([wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }));
	generatedUrls.set(key, url);
	return url;
}

function useGeneratedAudio(clip: RenderAudioClip, fps: Rational): string | null {
	const sound = clip.generator;
	const frameSeconds = fps.den / fps.num;
	// Content needed: up to the end of the tail handle, rounded up to whole seconds (shared between clips).
	const endFlicks =
		clip.sourceIn +
		(clip.duration + (clip.tailHandle ?? 0) + 1) * frameSeconds * FLICKS_PER_SECOND * clip.speed.rate;
	const seconds = Math.max(1, Math.ceil(endFlicks / FLICKS_PER_SECOND));
	const key = sound ? JSON.stringify(sound) : '';
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the sound's JSON
	return useMemo(
		() => (sound ? generatedAudioUrl(sound, seconds, frameSeconds) : null),
		[key, seconds, frameSeconds],
	);
}
