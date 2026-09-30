// Video layer (S03:KND-010/013, RND-020/021). The picture plays through @remotion/media <Video> in the
// Player and in renders for everything a browser decodes (H.264, VP8/VP9 with or without alpha, AV1).
// Originals a browser cannot decode (ProRes, including 4444 with alpha) are not handled by <Video> in
// Remotion 4.0.499 (it fails with "ProRes decoding is not enabled"): engine renders read them through
// <OffthreadVideo> (the render's FFmpeg extracts the frames, PNG when the source has alpha) and previews
// play the proxy, see `videoSource`. The element is muted: in the S01 model a clip's sound is its linked
// audio clip, played by AudioLayer with the volume callback.
// M2 colour (S06:CG-040/041): the layer's colour runs are canvas effect passes on the decoded frame —
// `<Video effects>` (the frame canvas of @remotion/media, preview and renders) or, for <OffthreadVideo>, the
// `ColorCanvas` fed from `onVideoFrame` while the element stays mounted (invisible) for Remotion's scheduling.
import { Video } from '@remotion/media';
import { useCallback, useRef } from 'react';
import { OffthreadVideo } from 'remotion';
import { ColorCanvas, type ColorCanvasHandle } from '../color/ColorCanvas.tsx';
import { useColorStage } from '../color/chain.ts';
import { videoSource, videoTrimBefore } from '../pipeline.ts';
import type { LayerProps } from '../types.ts';
import { GradeChip, LayerBox } from './LayerBox.tsx';

const MEDIA_STYLE = { width: '100%', height: '100%', display: 'block' } as const;
const OFFTHREAD_STYLE = { ...MEDIA_STYLE, objectFit: 'fill' } as const;

export function VideoLayer(layer: LayerProps) {
	const { clip, media, options, fps } = layer;
	const color = useColorStage(clip.clipId, layer.props.effects);
	if (!media) return null;
	const source = videoSource(media, options);
	if (source.via === 'pending-proxy') return <ProxyPendingCard {...layer} />;
	const trimBefore = videoTrimBefore(clip, fps);
	return (
		<LayerBox
			layer={layer}
			effects={color.cssEffects}
			overlay={color.unavailable ? <GradeChip layer={layer} /> : null}
		>
			{source.via === 'offthread' ? (
				color.effects.length > 0 ? (
					<GradedOffthread layer={layer} src={source.src} transparent={source.transparent} color={color} />
				) : (
					<OffthreadVideo
						src={source.src}
						trimBefore={trimBefore}
						playbackRate={clip.speed.rate}
						muted
						transparent={source.transparent}
						style={OFFTHREAD_STYLE}
						showInTimeline={false}
					/>
				)
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
					effects={color.effects}
				/>
			)}
		</LayerBox>
	);
}

/** <OffthreadVideo> (renders of originals a browser cannot decode) through the colour stage. */
function GradedOffthread({
	layer,
	src,
	transparent,
	color,
}: {
	layer: LayerProps;
	src: string;
	transparent: boolean;
	color: ReturnType<typeof useColorStage>;
}) {
	const { clip, fps } = layer;
	const stage = useRef<ColorCanvasHandle | null>(null);
	const onFrame = useCallback((frame: CanvasImageSource) => {
		void stage.current?.draw(frame);
	}, []);
	return (
		<>
			<OffthreadVideo
				src={src}
				trimBefore={videoTrimBefore(clip, fps)}
				playbackRate={clip.speed.rate}
				muted
				transparent={transparent}
				style={{ ...OFFTHREAD_STYLE, position: 'absolute', opacity: 0 }}
				showInTimeline={false}
				onVideoFrame={onFrame}
			/>
			<ColorCanvas
				ref={stage}
				effects={color.effects}
				width={Math.max(1, Math.round(layer.props.box.width))}
				height={Math.max(1, Math.round(layer.props.box.height))}
				style={{ ...MEDIA_STYLE, position: 'absolute', left: 0, top: 0 }}
				data-color-output=""
			/>
		</>
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
