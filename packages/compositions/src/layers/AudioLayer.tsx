// Audio layer (S03:KND-020, KND-011): @remotion/media <Audio> with `trimBefore` from sourceIn,
// `playbackRate = speed` and a per-frame volume callback. An audio crossfade (S10:TUI-052) plays the clip's handles:
// the enclosing <Sequence> starts `headHandle` frames before the clip and lasts `duration + head + tail`.
// audio-mix: in the Program preview the clip plays into the mix graph (`MixGraphContext`): Remotion's per-clip gain
// node connects to our clip node through an overridden SharedAudioContext, the callback applies the clip's gain,
// volume and fades, and the graph does clip pan, the track strip (fader, pan law, sends, mute/solo), submixes, the
// Mix, loudness normalisation and metering. Without a graph (no Web Audio) the callback also applies the track and
// master faders as before.
import { audioFadeGain, type MediaHandle, type Rational, type RenderAudioClip } from '@jasper/project';
import { Audio } from '@remotion/media';
import { useCallback, useContext, useEffect, useMemo } from 'react';
import { Internals } from 'remotion';
import { MixGraphContext } from '../audio/context.ts';
import { audioGainAt, mediaSrc, videoTrimBefore, volumeFrameToClipFrame } from '../pipeline.ts';
import type { RenderOptions } from '../types.ts';

/**
 * Linear gain of an audio layer at frame `layerFrame` of its <Sequence> (which starts `headHandle` frames
 * before the clip). Levels (gain, volume, track, master) are those of the nearest clip frame; the fades are
 * evaluated at the real sequence frame, so a crossfade ramps through the handles exactly like the export mixer.
 */
function audioLayerGain(
	clip: Pick<
		RenderAudioClip,
		'start' | 'duration' | 'sourceIn' | 'speed' | 'gainDb' | 'volumeDb' | 'track' | 'fades' | 'headHandle'
	>,
	layerFrame: number,
	fps: Rational,
	master: { volumeDb: RenderAudioClip['volumeDb'] } | undefined,
	includeBus: boolean,
): number {
	const { fades, headHandle, ...levels } = clip;
	const f = layerFrame - (headHandle ?? 0); // clip-local frame (negative inside the head handle)
	return audioGainAt(levels, f, fps, master, includeBus) * audioFadeGain(fades, clip.start + f);
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
	// A stable context value: Remotion re-creates its media player when the context object changes.
	const routed = useMemo(() => (shared && node ? { ...shared, gainNode: node } : null), [shared, node]);
	const volume = useCallback(
		(f: number) =>
			audioLayerGain(clip, volumeFrameToClipFrame(f, sequenceFrom), { num, den }, master, !routed),
		[clip, num, den, master, sequenceFrom, routed],
	);
	if (!media || (!media.hasAudio && media.kind !== 'audio')) return null;
	const audio = (
		<Audio
			src={mediaSrc(media, options)}
			trimBefore={videoTrimBefore(clip, { num, den })}
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
