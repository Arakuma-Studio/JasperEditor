// Video layer (S03:KND-010/013, RND-020/021). The picture plays through @remotion/media <Video> in the
// Player and in renders for everything a browser decodes (H.264, VP8/VP9 with or without alpha, AV1).
// Originals a browser cannot decode (ProRes, including 4444 with alpha) are not handled by <Video> in
// Remotion 4.0.499 (it fails with "ProRes decoding is not enabled"): engine renders read them through
// <OffthreadVideo> (the render's FFmpeg extracts the frames, PNG when the source has alpha) and previews
// play the proxy, see `videoSource`. The element is muted: in the S01 model a clip's sound is its linked
// audio clip, played by AudioLayer with the volume callback.
import { Video } from '@remotion/media';
import { OffthreadVideo } from 'remotion';
import { videoSource, videoTrimBefore } from '../pipeline.ts';
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';

const MEDIA_STYLE = { width: '100%', height: '100%', display: 'block' } as const;
const OFFTHREAD_STYLE = { ...MEDIA_STYLE, objectFit: 'fill' } as const;

export function VideoLayer(layer: LayerProps) {
	const { clip, media, options, fps } = layer;
	if (!media) return null;
	const source = videoSource(media, options);
	if (source.via === 'pending-proxy') return <ProxyPendingCard {...layer} />;
	const trimBefore = videoTrimBefore(clip, fps);
	return (
		<LayerBox layer={layer}>
			{source.via === 'offthread' ? (
				<OffthreadVideo
					src={source.src}
					trimBefore={trimBefore}
					playbackRate={clip.speed.rate}
					muted
					transparent={source.transparent}
					style={OFFTHREAD_STYLE}
					showInTimeline={false}
				/>
			) : (
				<Video
					src={source.src}
					trimBefore={trimBefore}
					// Reverse playback needs a native retime proxy (S03:KND-015, M2); preview plays forward.
					playbackRate={clip.speed.rate}
					muted
					objectFit="fill"
					style={MEDIA_STYLE}
					showInTimeline={false}
				/>
			)}
		</LayerBox>
	);
}

/**
 * Preview placeholder while the proxy of an original the browser cannot decode is still being made. It
 * stays see-through (a label only), so an overlay that is waiting for its proxy does not hide the footage.
 */
export function ProxyPendingCard(layer: LayerProps) {
	const h = layer.props.box.height;
	return (
		<LayerBox layer={layer}>
			<div
				data-proxy-pending=""
				style={{
					position: 'absolute',
					left: '2%',
					bottom: '3%',
					padding: `${Math.max(2, h / 180)}px ${Math.max(6, h / 90)}px`,
					borderRadius: Math.max(3, h / 180),
					background: 'rgba(20, 20, 20, 0.72)',
					color: 'rgba(255, 255, 255, 0.92)',
					fontFamily: '"Source Sans 3", "Source Sans Pro", Arial, sans-serif',
					fontSize: Math.max(11, h / 36),
				}}
			>
				Preparing preview proxy: {layer.clip.name}
			</div>
		</LayerBox>
	);
}
