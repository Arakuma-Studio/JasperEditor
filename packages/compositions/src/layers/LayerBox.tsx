import { matrixToCss } from '@jasper/project';
import type { CSSProperties, ReactNode } from 'react';
import type { LayerProps } from '../types.ts';

/**
 * Positions content with the layer matrix (S03:DM-012): an intrinsic-size box at the sequence origin
 * with `transform-origin: 0 0`. Inline styles only (ARCHITECTURE D-14).
 */
export function LayerBox({
	layer,
	children,
	style,
}: {
	layer: LayerProps;
	children?: ReactNode;
	style?: CSSProperties;
}) {
	const { props } = layer;
	return (
		<div
			data-clip-id={layer.clip.clipId}
			data-kind={layer.clip.kind}
			style={{
				position: 'absolute',
				left: 0,
				top: 0,
				width: props.box.width,
				height: props.box.height,
				transformOrigin: '0 0',
				transform: matrixToCss(props.matrix),
				opacity: props.opacity / 100,
				mixBlendMode:
					layer.clip.blendMode === 'normal'
						? undefined
						: (layer.clip.blendMode as CSSProperties['mixBlendMode']),
				overflow: 'hidden',
				...style,
			}}
		>
			{children}
		</div>
	);
}

/** Placeholder content: a labeled, outlined box (used by the WP-00 stub layers). */
export function StubLabel({ layer, title, tint }: { layer: LayerProps; title: string; tint: string }) {
	return (
		<LayerBox
			layer={layer}
			style={{ background: tint, outline: '2px solid rgba(255,255,255,0.6)', outlineOffset: -2 }}
		>
			<div
				style={{
					position: 'absolute',
					inset: 0,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					flexDirection: 'column',
					gap: 8,
					color: 'white',
					fontFamily: 'sans-serif',
					fontSize: Math.max(12, Math.min(48, layer.props.box.height / 12)),
					textAlign: 'center',
				}}
			>
				<div style={{ fontWeight: 600 }}>{title}</div>
				<div style={{ opacity: 0.8 }}>{layer.clip.name}</div>
				<div style={{ opacity: 0.6, fontSize: '0.6em' }}>frame {layer.localFrame}</div>
			</div>
		</LayerBox>
	);
}
