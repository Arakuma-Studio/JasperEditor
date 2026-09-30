import { matrixToCss } from '@jasper/project';
import { type CSSProperties, type ReactNode, useMemo } from 'react';
import { blendModeCss, effectStages } from '../pipeline.ts';
import type { LayerProps } from '../types.ts';

const FILL: CSSProperties = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' };

/**
 * The per-layer pipeline (S03 §4.2, S03:DM-012), from the inside out:
 * 1. source content (`children`, styled with `style`) in an intrinsic-size box;
 * 2. effects, crop first, each one wrapper element (preview CSS or an SVG filter). Crop uses
 *    `clip-path` on an inner element so blur/shadow of later effects are not clipped;
 * 3. the layer matrix on the outer element (`transform-origin: 0 0`);
 * 4. opacity on the outer element;
 * 5. blend with `mix-blend-mode` against the layers below (the stack root is `isolation: isolate`).
 * Inline styles only (ARCHITECTURE D-14).
 */
export function LayerBox({
	layer,
	children,
	style,
}: {
	layer: LayerProps;
	children?: ReactNode;
	/** Style of the source content box (e.g. a solid background). */
	style?: CSSProperties;
}) {
	const { props, clip } = layer;
	const stages = useMemo(
		() => effectStages(props.effects, `fx-${clip.clipId}`),
		[props.effects, clip.clipId],
	);
	let content: ReactNode = (
		<div data-layer-source="" style={{ ...FILL, ...style }}>
			{children}
		</div>
	);
	for (const stage of stages) {
		content = (
			<div data-effect={stage.effectId} style={{ ...FILL, ...stage.style }}>
				{stage.svg ? (
					<svg
						width={0}
						height={0}
						style={{ position: 'absolute', width: 0, height: 0 }}
						aria-hidden="true"
						// biome-ignore lint/security/noDangerouslySetInnerHtml: effect registry SVG filter markup (app code, not user input)
						dangerouslySetInnerHTML={{ __html: stage.svg.markup }}
					/>
				) : null}
				{content}
			</div>
		);
	}
	return (
		<div
			data-clip-id={clip.clipId}
			data-kind={clip.kind}
			style={{
				position: 'absolute',
				left: 0,
				top: 0,
				width: props.box.width,
				height: props.box.height,
				transformOrigin: '0 0',
				transform: matrixToCss(props.matrix),
				opacity: props.opacity / 100,
				mixBlendMode: blendModeCss(clip.blendMode),
			}}
		>
			{content}
		</div>
	);
}

/** Placeholder content: a labeled, outlined box (kept for layers that are not implemented yet). */
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
			</div>
		</LayerBox>
	);
}
