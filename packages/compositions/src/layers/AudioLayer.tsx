// Audio layer (S03:KND-020, KND-011): @remotion/media <Audio> with `trimBefore` from sourceIn,
// `playbackRate = speed` and a per-frame volume callback from gainDb + volumeDb + track/master volume.
// Track mute/solo are already resolved in the snapshot (muted tracks are omitted). Pan is not
// previewed in M1 (S03:KND-012 is P1).
import type { MediaHandle, Rational, RenderAudioClip } from '@jasper/project';
import { Audio } from '@remotion/media';
import { useCallback } from 'react';
import { audioGainAt, mediaSrc, trimBeforeFrames, volumeFrameToClipFrame } from '../pipeline.ts';
import type { RenderOptions } from '../types.ts';

export type AudioLayerProps = {
	clip: RenderAudioClip;
	media: MediaHandle | null;
	fps: number;
	options: RenderOptions;
	/** Exact sequence rate (content-time math); defaults to `{num: fps, den: 1}`. */
	fpsRational?: Rational;
	/** Master fader of the sequence. */
	master?: { volumeDb: RenderAudioClip['volumeDb'] };
	/** The `from` of the enclosing <Sequence> (negative when the render range starts inside the clip). */
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
		(f: number) => audioGainAt(clip, volumeFrameToClipFrame(f, sequenceFrom), { num, den }, master),
		[clip, num, den, master, sequenceFrom],
	);
	if (!media?.hasAudio && media?.kind !== 'audio') return null;
	if (!media) return null;
	return (
		<Audio
			src={mediaSrc(media, options)}
			trimBefore={trimBeforeFrames(clip.sourceIn, { num, den })}
			playbackRate={clip.speed.rate}
			volume={volume}
			showInTimeline={false}
		/>
	);
}
