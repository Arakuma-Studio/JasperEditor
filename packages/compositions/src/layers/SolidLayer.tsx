// Solid (color matte) layer: the matte color fills the intrinsic box (S01:KND-007).
// M2 colour (S06): colour runs are applied to the matte colour itself (baked LUT, same maths as lut3d).
// fx framework (wave 1): with GPU shader effects the matte is a canvas picture through `FxPicture` (its colour runs
// then run as LUT steps of the chain, same maths).
import { useGradedSolid } from '../color/chain.ts';
import { FxPicture } from '../fx/FxPicture.tsx';
import { FxMediaInputs, FxSolidFeed } from '../fx/sources.tsx';
import { useLayerFx } from '../fx/stage.ts';
import { rgbaCss } from '../metadata.ts';
import type { LayerProps } from '../types.ts';
import { GradeChip, LayerBox } from './LayerBox.tsx';

const BLACK: [number, number, number, number] = [0, 0, 0, 1];

export function SolidLayer(layer: LayerProps) {
	const color = 'color' in layer.clip.source ? layer.clip.source.color : BLACK;
	const graded = useGradedSolid(layer.clip.clipId, layer.props.effects, color);
	const fx = useLayerFx(layer);
	if (fx.mode === 'active')
		return (
			<LayerBox
				layer={layer}
				effects={fx.cssEffects}
				masksInChain
				overlay={fx.chip ? <GradeChip layer={layer} text={fx.chip} /> : null}
			>
				<FxPicture stage={fx.stage}>
					<FxSolidFeed
						slot="source"
						rgba={color}
						width={layer.props.box.width}
						height={layer.props.box.height}
					/>
					<FxMediaInputs stage={fx.stage} frame={layer.localFrame} />
				</FxPicture>
			</LayerBox>
		);
	return (
		<LayerBox
			layer={layer}
			effects={graded.cssEffects}
			style={{ background: rgbaCss(graded.rgba) }}
			overlay={fx.mode === 'bypass' ? <GradeChip layer={layer} text={fx.chip} /> : null}
		/>
	);
}
