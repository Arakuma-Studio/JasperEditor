// Audio layer (S03:KND-020, KND-011): @remotion/media <Audio> with `trimBefore` from sourceIn,
// `playbackRate = speed` and a per-frame volume callback from gainDb + volumeDb + track/master volume.
// Track mute/solo are already resolved in the snapshot (muted tracks are omitted). Pan is not
// previewed in M1 (S03:KND-012 is P1). An audio crossfade (S10:TUI-052) plays the clip's handles: the
// enclosing <Sequence> starts `headHandle` frames before the clip and lasts `duration + head + tail`.
import { audioFadeGain, type MediaHandle, type Rational, type RenderAudioClip } from '@jasper/project';
import { Audio } from '@remotion/media';
import { useCallback } from 'react';
import { audioGainAt, mediaSrc, videoTrimBefore, volumeFrameToClipFrame } from '../pipeline.ts';
import type { RenderOptions } from '../types.ts';

/**
 * Linear gain of an audio layer at frame `layerFrame` of its <Sequence> (which starts `headHandle` frames
 * before the clip). Levels (gain, volume, track, master) are those of the nearest clip frame; the fades are
 * evaluated at the real sequence frame, so a crossfade ramps through the handles exactly like `afade` does
 * in the native export.
 */
export function audioLayerGain(
	clip: Pick<
		RenderAudioClip,
		'start' | 'duration' | 'sourceIn' | 'speed' | 'gainDb' | 'volumeDb' | 'track' | 'fades' | 'headHandle'
	>,
	layerFrame: number,
	fps: Rational,
	master?: { volumeDb: RenderAudioClip['volumeDb'] },
): number {
	const { fades, headHandle, ...levels } = clip;
	const f = layerFrame - (headHandle ?? 0); // clip-local frame (negative inside the head handle)
	return audioGainAt(levels, f, fps, master) * audioFadeGain(fades, clip.start + f);
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
	const volume = useCallback(
		(f: number) => audioLayerGain(clip, volumeFrameToClipFrame(f, sequenceFrom), { num, den }, master),
		[clip, num, den, master, sequenceFrom],
	);
	if (!media?.hasAudio && media?.kind !== 'audio') return null;
	if (!media) return null;
	return (
		<Audio
			src={mediaSrc(media, options)}
			trimBefore={videoTrimBefore(clip, { num, den })}
			playbackRate={clip.speed.rate}
			volume={volume}
			showInTimeline={false}
		/>
	);
}
