// Source monitor composition (S03:SRC-002, ARCHITECTURE §8): one asset at its natural size and rate.
// Video plays with its audio, images show as stills, audio-only assets show an audio card (the
// waveform is drawn by the monitor chrome from engine peaks in a later version).
// pp-wma-preview: audio the browser cannot decode plays from the engine's playback audio (first audio stream); a video
// of such media plays its picture without its audio track.
import { FLICKS_PER_SECOND } from '@jasper/project';
import { Audio, Video } from '@remotion/media';
import type { CalculateMetadataFunction } from 'remotion';
import { AbsoluteFill, Img } from 'remotion';
import { FALLBACK_FONT_STACK } from './fonts.ts';
import { audioSrc, mediaSrc, videoAudioTrackProps } from './pipeline.ts';
import type { AssetCompositionProps } from './types.ts';

const DEFAULT_STILL_SECONDS = 5;
const AUDIO_CANVAS = { width: 1280, height: 720 };

/** Natural size of an asset preview (audio assets get a fixed card size). */
export function assetCanvas(asset: AssetCompositionProps['asset']): { width: number; height: number } {
	if (asset.kind === 'audio' || !asset.width || !asset.height) return AUDIO_CANVAS;
	return { width: asset.width, height: asset.height };
}

/** Duration in frames: the media duration, or the still duration for images / unknown durations. */
export function assetDurationFrames(props: AssetCompositionProps): number {
	const still = props.stillDurationFrames ?? Math.round(DEFAULT_STILL_SECONDS * props.fps);
	if (props.asset.kind === 'image' || props.asset.durationFlicks == null) return Math.max(1, still);
	return Math.max(1, Math.round((props.asset.durationFlicks / FLICKS_PER_SECOND) * props.fps));
}

export const calculateAssetMetadata: CalculateMetadataFunction<AssetCompositionProps> = ({ props }) => ({
	...assetCanvas(props.asset),
	fps: props.fps,
	durationInFrames: assetDurationFrames(props),
});

const FILL = { width: '100%', height: '100%', display: 'block' } as const;

export function AssetComposition(props: AssetCompositionProps) {
	const { asset } = props;
	const options = { useProxies: !!props.useProxies };
	const src = mediaSrc(asset, options);
	// -1: the first stream of the playback audio (the Source monitor plays a file's first audio stream)
	const sound = asset.playbackAudio === undefined ? null : audioSrc(asset, -1, options);
	if (asset.kind === 'video' || asset.kind === 'animated-image') {
		return (
			<AbsoluteFill style={{ backgroundColor: 'black' }}>
				{asset.kind === 'video' ? (
					asset.playbackAudio === undefined ? (
						<Video src={src} objectFit="fill" style={FILL} showInTimeline={false} />
					) : (
						<>
							<Video
								src={src}
								objectFit="fill"
								style={FILL}
								showInTimeline={false}
								muted
								{...videoAudioTrackProps(asset)}
							/>
							{sound ? <Audio src={sound} showInTimeline={false} /> : null}
						</>
					)
				) : (
					<Img src={src} style={FILL} alt="" />
				)}
			</AbsoluteFill>
		);
	}
	if (asset.kind === 'image') {
		return (
			<AbsoluteFill>
				<Img src={src} style={FILL} alt="" />
			</AbsoluteFill>
		);
	}
	return (
		<AbsoluteFill
			style={{
				backgroundColor: 'rgb(24, 24, 24)',
				alignItems: 'center',
				justifyContent: 'center',
				color: 'rgba(255,255,255,0.8)',
				fontFamily: FALLBACK_FONT_STACK,
				fontSize: 36,
			}}
		>
			{asset.playbackAudio !== undefined ? (
				sound ? (
					<Audio src={sound} showInTimeline={false} />
				) : null
			) : asset.hasAudio || asset.kind === 'audio' ? (
				<Audio src={src} showInTimeline={false} />
			) : null}
			<div data-asset-audio-card="">{props.name ?? 'Audio'}</div>
		</AbsoluteFill>
	);
}
