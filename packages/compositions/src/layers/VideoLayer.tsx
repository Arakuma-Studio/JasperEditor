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
// fx framework: with GPU shader effects the picture is drawn by `FxPicture` (padded canvas, shader passes,
// colour runs, time samples) fed by a headless <Video> / an invisible <OffthreadVideo>; see fx/.
import { Video } from '@remotion/media';
import { useCallback, useRef } from 'react';
import { OffthreadVideo } from 'remotion';
import { ColorCanvas, type ColorCanvasHandle } from '../color/ColorCanvas.tsx';
import { useColorStage } from '../color/chain.ts';
import { FxPicture } from '../fx/FxPicture.tsx';
import { FxVideoSources, RetimedFxSources } from '../fx/sources.tsx';
import { useLayerFx } from '../fx/stage.ts';
import { videoSource, videoTrimBefore } from '../pipeline.ts';
import { RetimedFeed } from '../retime/RetimedVideo.tsx';
import type { LayerProps } from '../types.ts';
import { GradeChip, LayerBox } from './LayerBox.tsx';

const MEDIA_STYLE = { width: '100%', height: '100%', display: 'block' } as const;
const OFFTHREAD_STYLE = { ...MEDIA_STYLE, objectFit: 'fill' } as const;

export function VideoLayer(layer: LayerProps) {
	const { clip, media, options, fps } = layer;
	const color = useColorStage(clip.clipId, layer.props.effects);
	const fx = useLayerFx(layer);
	if (!media) return null;
	const source = videoSource(media, options);
	if (source.via === 'pending-proxy') return <ProxyPendingCard {...layer} />;
	const trimBefore = videoTrimBefore(clip, fps);
	// Workstream `time`: reverse, time remaps, Frame Blending / Optical Flow and VFR media are drawn frame by frame
	// from media times (retime/).
	if (clip.retime) return <RetimedVideoLayer layer={layer} media={media} color={color} fx={fx} />;
	if (fx.mode === 'active')
		return (
			<LayerBox
				layer={layer}
				effects={fx.cssEffects}
				masksInChain
				overlay={fx.chip ? <GradeChip layer={layer} text={fx.chip} /> : null}
			>
				<FxPicture stage={fx.stage}>
					<FxVideoSources
						layer={layer}
						stage={fx.stage}
						src={source.src}
						trimBefore={trimBefore}
						offthread={source.via === 'offthread' ? { transparent: source.transparent } : undefined}
					/>
				</FxPicture>
			</LayerBox>
		);
	return (
		<LayerBox
			layer={layer}
			effects={color.cssEffects}
			overlay={
				fx.mode === 'bypass' ? (
					<GradeChip layer={layer} text={fx.chip} />
				) : color.unavailable ? (
					<GradeChip layer={layer} />
				) : null
			}
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

/** A retimed video layer in its three modes: fx picture, colour stage, plain. */
function RetimedVideoLayer({
	layer,
	media,
	color,
	fx,
}: {
	layer: LayerProps;
	media: NonNullable<LayerProps['media']>;
	color: ReturnType<typeof useColorStage>;
	fx: ReturnType<typeof useLayerFx>;
}) {
	const { clip, options } = layer;
	const pictureTime = layer.pictureTime ?? layer.contentTime;
	const stage = useRef<ColorCanvasHandle | null>(null);
	const toColor = useCallback((frame: CanvasImageSource) => {
		void stage.current?.draw(frame);
	}, []);
	if (fx.mode === 'active')
		return (
			<LayerBox
				layer={layer}
				effects={fx.cssEffects}
				masksInChain
				overlay={fx.chip ? <GradeChip layer={layer} text={fx.chip} /> : null}
			>
				<FxPicture stage={fx.stage}>
					<RetimedFxSources layer={layer} stage={fx.stage} media={media} />
				</FxPicture>
			</LayerBox>
		);
	const graded = color.effects.length > 0;
	return (
		<LayerBox
			layer={layer}
			effects={color.cssEffects}
			overlay={
				fx.mode === 'bypass' ? (
					<GradeChip layer={layer} text={fx.chip} />
				) : color.unavailable ? (
					<GradeChip layer={layer} />
				) : null
			}
		>
			<RetimedFeed
				clip={clip}
				media={media}
				options={options}
				pictureTime={pictureTime}
				visible={!graded}
				onPicture={graded ? toColor : NOOP}
			/>
			{graded ? (
				<ColorCanvas
					ref={stage}
					effects={color.effects}
					width={Math.max(1, Math.round(layer.props.box.width))}
					height={Math.max(1, Math.round(layer.props.box.height))}
					style={{ ...MEDIA_STYLE, position: 'absolute', left: 0, top: 0 }}
					data-color-output=""
				/>
			) : null}
		</LayerBox>
	);
}

const NOOP = () => undefined;

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
