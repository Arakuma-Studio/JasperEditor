// "Media Offline" card (S03:RND-032, S01:LIFE-031) — stub from WP-00; WP-2C owns it.
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';

export function OfflineCard(layer: LayerProps) {
	return (
		<LayerBox layer={layer} style={{ background: 'rgb(179, 38, 30)' }}>
			<div
				style={{
					position: 'absolute',
					inset: 0,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					color: 'rgb(255, 218, 214)',
					fontFamily: 'sans-serif',
					fontSize: Math.max(14, layer.props.box.height / 14),
					fontWeight: 600,
				}}
			>
				Media Offline
			</div>
		</LayerBox>
	);
}
