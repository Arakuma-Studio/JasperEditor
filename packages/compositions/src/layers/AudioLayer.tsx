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

import { effectLatency } from '@jasper/audio-fx';
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
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { cancelRender, continueRender, delayRender, getRemotionEnvironment, Internals } from 'remotion';
import { MixGraphContext } from '../audio/context.ts';
import { clipHasEffects } from '../audio/graph.ts';
import { mappedAudioUrl, reversedAudioUrl } from '../audio/reversed.ts';
import { audioGainAt, dbToGain, mediaSrc, videoTrimBefore, volumeFrameToClipFrame } from '../pipeline.ts';
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
	// slots (export order); the source is scheduled `latency` early so look-ahead / spectral effects stay in sync.
	const fx = !!node && clipHasEffects(clip);
	const latencySec = useMemo(() => (fx ? clipEffectsLatency(clip.effects) / 48000 : 0), [fx, clip.effects]);
	// A stable context value: Remotion re-creates its media player when the context object changes.
	const routed = useMemo(
		() => (shared && node ? { ...shared, gainNode: node, ...compensate(shared, latencySec) } : null),
		[shared, node, latencySec],
	);
	const volume = useCallback(
		(f: number) =>
			fx ? 1 : audioLayerGain(clip, volumeFrameToClipFrame(f, sequenceFrom), { num, den }, master, !routed),
		[clip, num, den, master, sequenceFrom, routed, fx],
	);
	const generated = useGeneratedAudio(clip, { num, den });
	const mediaUrl =
		!generated && media && (media.hasAudio || media.kind === 'audio') ? mediaSrc(media, options) : null;
	// Workstream `time`: a reversed clip plays its range reversed in the page (Remotion's <Audio> plays forwards only).
	// imports: interpreted media (assumed frame rate, loop) plays a WAV of its interpreted range made in the page.
	const mapped = !!clip.mediaTime;
	const reversed = useReversedAudio(clip, clip.speed.reverse && !mapped ? mediaUrl : null, { num, den });
	const mappedUrl = useMappedAudio(clip, mapped ? mediaUrl : null, { num, den });
	const src = generated ?? (mapped ? mappedUrl : clip.speed.reverse ? reversed : mediaUrl);
	if (!src) return null;
	const audio = (
		<Audio
			src={src}
			trimBefore={(reversed && src === reversed) || (mappedUrl && src === mappedUrl) ? 0 : videoTrimBefore(clip, { num, den })}
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

// ---------------------------------------------------------------- workstream `time`: reversed clips

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

// ---------------------------------------------------------------- imports: interpreted media

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

// ---------------------------------------------------------------- audio-fx: latency compensation

type SharedAudio = NonNullable<React.ContextType<typeof Internals.SharedAudioContext>>;

/** Total latency (samples at 48 kHz) of a clip's enabled effects. */
function clipEffectsLatency(effects: RenderAudioClip['effects']): number {
	let l = 0;
	for (const e of effects) l += effectLatency(e);
	return l;
}

/** A `scheduleAudioNode` that starts every source buffer `shift` seconds early (effect latency compensation). */
function compensate(shared: SharedAudio, shift: number): Partial<SharedAudio> {
	if (shift <= 0) return {};
	return {
		scheduleAudioNode: (opts) => {
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

// ---------------------------------------------------------------- edit-structure: synthetic sounds

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
