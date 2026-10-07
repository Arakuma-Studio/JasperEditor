// Audio layer (S03:KND-020, KND-011): @remotion/media <Audio> with `trimBefore` from sourceIn,
// `playbackRate = speed` and a per-frame volume callback from gainDb + volumeDb + track/master volume.
// Track mute/solo are already resolved in the snapshot (muted tracks are omitted). Pan is not
// previewed in M1 (S03:KND-012 is P1). An audio crossfade (S10:TUI-052) plays the clip's handles: the
// enclosing <Sequence> starts `headHandle` frames before the clip and lasts `duration + head + tail`.
// edit-structure: clips flattened out of nested sequences carry their nested gain (`nestGain`, dB per sequence frame);
// synthetic sounds (Bars and Tone's tone, the leader's blips) play a WAV generated in the page from the same samples
// the native export writes (`syntheticSamples`).
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
import { useCallback, useMemo } from 'react';
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
	master?: { volumeDb: RenderAudioClip['volumeDb'] },
): number {
	const { fades, headHandle, nestGain, ...levels } = clip;
	const f = layerFrame - (headHandle ?? 0); // clip-local frame (negative inside the head handle)
	return (
		audioGainAt(levels, f, fps, master) *
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
	const volume = useCallback(
		(f: number) => audioLayerGain(clip, volumeFrameToClipFrame(f, sequenceFrom), { num, den }, master),
		[clip, num, den, master, sequenceFrom],
	);
	const generated = useGeneratedAudio(clip, { num, den });
	if (generated)
		return (
			<Audio
				src={generated}
				trimBefore={videoTrimBefore(clip, { num, den })}
				playbackRate={clip.speed.rate}
				volume={volume}
				showInTimeline={false}
			/>
		);
	if (!media || (!media.hasAudio && media.kind !== 'audio')) return null;
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
