import { mat3ToCss, matrixToCss, type ResolvedEffect } from '@jasper/project';
import { type CSSProperties, type ReactNode, useMemo } from 'react';
import { blendModeCss, effectStages } from '../pipeline.ts';
import type { LayerProps } from '../types.ts';

const FILL: CSSProperties = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' };

/**
 * The per-layer pipeline (S03 §4.2, S03:DM-012), from the inside out:
 * 1. source content (`children`, styled with `style`) in an intrinsic-size box;
 * 2. effects, crop first, each one wrapper element (preview CSS or an SVG filter). Crop uses
 *    `clip-path` on an inner element so blur/shadow of later effects are not clipped. M2 (S06:CG-040): colour
 *    runs (and the non-colour effects before them) run as canvas passes on the source picture inside the source
 *    component (`useColorStage`); the layer then passes only the remaining effects here (`effects`);
 * 3. the layer matrix on the outer element (`transform-origin: 0 0`); a corner pin (M2) makes it the
 *    projective map `props.projective` written as `matrix3d`;
 * 4. opacity on the outer element;
 * 5. blend with `mix-blend-mode` against the layers below (the stack root is `isolation: isolate`).
 * Inline styles only (ARCHITECTURE D-14).
 */
export function LayerBox({
	layer,
	children,
	style,
	effects,
	overlay,
}: {
	layer: LayerProps;
	children?: ReactNode;
	/** Style of the source content box (e.g. a solid background). */
	style?: CSSProperties;
	/** Effects drawn as CSS/SVG stages (default: all of the layer's effects). */
	effects?: readonly ResolvedEffect[];
	/** Drawn over the layer content inside its box (e.g. the "Grade unavailable" chip, preview only). */
	overlay?: ReactNode;
}) {
	const { props, clip } = layer;
	const cssEffects = effects ?? props.effects;
	const stages = useMemo(() => effectStages(cssEffects, `fx-${clip.clipId}`), [cssEffects, clip.clipId]);
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
				transform: props.projective ? mat3ToCss(props.projective) : matrixToCss(props.matrix),
				opacity: props.opacity / 100,
				mixBlendMode: blendModeCss(clip.blendMode),
			}}
		>
			{content}
			{overlay}
		</div>
	);
}

/** "Grade unavailable" chip (S06:CG-045): the layer draws ungraded because WebGL2 is missing or lost (preview). */
export function GradeChip({ layer, text = 'Grade unavailable' }: { layer: LayerProps; text?: string }) {
	const h = layer.props.box.height;
	return (
		<div
			data-grade-chip=""
			style={{
				position: 'absolute',
				right: '2%',
				top: '3%',
				padding: `${Math.max(2, h / 180)}px ${Math.max(6, h / 90)}px`,
				borderRadius: Math.max(3, h / 180),
				background: 'rgba(120, 60, 0, 0.8)',
				color: 'rgba(255, 255, 255, 0.95)',
				fontFamily: '"Source Sans 3", "Source Sans Pro", Arial, sans-serif',
				fontSize: Math.max(11, h / 36),
				pointerEvents: 'none',
			}}
		>
			{text}
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
