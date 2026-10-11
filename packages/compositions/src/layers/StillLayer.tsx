// Still and animated-image layers (S03:KND-030/040). Remotion <Img> waits for decode in renders.
// Animated images are shown with the browser's own animation in M1 (frame-accurate GIF/WebP playback
// honoring sourceIn/speed is KND-040, M2).
// M2 colour (S06:CG-041): with colour runs the still is drawn through the canvas effect chain of <Img effects>
// (a canvas of the layer's intrinsic size; renders wait for it). Graded animated images show their first frame
// (known gap: frame-accurate animated images are KND-040).
// fx framework: with GPU shader effects the still is drawn by `FxPicture` (fed with the decoded image).
import { Img } from 'remotion';
import { useColorStage } from '../color/chain.ts';
import { FxPicture } from '../fx/FxPicture.tsx';
import { FxImageFeed, FxMediaInputs } from '../fx/sources.tsx';
import { useLayerFx } from '../fx/stage.ts';
import { mediaSrc } from '../pipeline.ts';
import type { LayerProps } from '../types.ts';
import { GradeChip, LayerBox } from './LayerBox.tsx';
import { ProxyPendingCard } from './VideoLayer.tsx';

const MEDIA_STYLE = { width: '100%', height: '100%', display: 'block', objectFit: 'fill' } as const;

export function StillLayer(layer: LayerProps) {
	const { media, options } = layer;
	const color = useColorStage(layer.clip.clipId, layer.props.effects);
	const fx = useLayerFx(layer);
	if (!media) return null;
	// imports: a still the browser cannot decode (TIFF, EXR, PSD…) or with a pixel interpretation shows the engine's
	// display picture (`proxyUrl`); while it is being made the preview shows a label.
	if (media.browserDecodable === false && !media.proxyUrl) return <ProxyPendingCard {...layer} />;
	const src = mediaSrc(media, options);
	if (fx.mode === 'active')
		return (
			<LayerBox
				layer={layer}
				effects={fx.cssEffects}
				masksInChain
				overlay={fx.chip ? <GradeChip layer={layer} text={fx.chip} /> : null}
			>
				<FxPicture stage={fx.stage}>
					<FxImageFeed slot="source" src={src} />
					<FxMediaInputs stage={fx.stage} frame={layer.localFrame} />
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
			{color.effects.length > 0 ? (
				<Img
					src={src}
					style={MEDIA_STYLE}
					width={Math.max(1, Math.round(layer.props.box.width))}
					height={Math.max(1, Math.round(layer.props.box.height))}
					effects={color.effects}
					showInTimeline={false}
				/>
			) : (
				// keyframes-blend: CORS-clean (the engine sends CORS headers, as for FxImageFeed), so HTML-in-Canvas captures
				// of the stack (blend scopes, adjustment layers) paint it — cross-origin images without CORS are left out.
				<Img src={src} style={MEDIA_STYLE} alt="" crossOrigin="anonymous" />
			)}
		</LayerBox>
	);
}
