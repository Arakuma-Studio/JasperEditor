// "Media Offline" card (S03:RND-032, S01:LIFE-031): fills the layer's visible rect in the offline
// color with the clip name. Colors mirror the --pr-offline-clip tokens (the composition cannot read
// CSS variables of the editor, and renders run outside the app).
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';

export const OFFLINE_CARD_COLORS = { background: 'rgb(179, 38, 30)', text: 'rgb(255, 255, 255)' } as const;

export function OfflineCard(layer: LayerProps) {
	const h = layer.props.box.height;
	return (
		<LayerBox layer={layer} style={{ background: OFFLINE_CARD_COLORS.background }}>
			<div
				data-offline-card=""
				style={{
					position: 'absolute',
					inset: 0,
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					justifyContent: 'center',
					gap: Math.max(4, h / 60),
					color: OFFLINE_CARD_COLORS.text,
					fontFamily: '"Source Sans 3", "Source Sans Pro", Arial, sans-serif',
					textAlign: 'center',
					padding: '0 5%',
				}}
			>
				<div style={{ fontSize: Math.max(14, h / 12), fontWeight: 600 }}>Media Offline</div>
				<div style={{ fontSize: Math.max(10, h / 28), opacity: 0.9, overflowWrap: 'anywhere' }}>
					{layer.clip.name}
				</div>
			</div>
		</LayerBox>
	);
}
