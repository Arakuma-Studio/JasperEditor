import { defaultEffectRegistry, mat3ToCss, matrixToCss, type ResolvedEffect } from '@jasper/project';
import { type CSSProperties, type ReactNode, useMemo } from 'react';
import { canUseHtmlInCanvas, FxDomPicture } from '../fx/FxPicture.tsx';
import { useCpuMaskStyle } from '../fx/mask-fallback.ts';
import { useLayerFx } from '../fx/stage.ts';
import { blendModeCss, effectStages } from '../pipeline.ts';
import type { LayerProps } from '../types.ts';

/** DOM layers (S11 §0) whose GPU shader effects LayerBox runs itself through HTML-in-Canvas (fx framework). */
const DOM_FX_KINDS: ReadonlySet<string> = new Set(['text', 'shape', 'motion-graphic', 'nest-video']);

const FILL: CSSProperties = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' };

/**
 * The per-layer pipeline (S03 §4.2, S03:DM-012), from the inside out:
 * 1. source content (`children`, styled with `style`) in an intrinsic-size box;
 * 2. effects in stack order (Crop where it sits, schema v8), each one wrapper element (preview CSS or an SVG filter).
 *    Crop is a `clip-path` on its own wrapper: it cuts what the effects inside it drew, and blur/shadow of later
 *    effects (outer wrappers) are not clipped. M2 (S06:CG-040): colour
 *    runs (and the non-colour effects before them) run as canvas passes on the source picture inside the source
 *    component (`useColorStage`); the layer then passes only the remaining effects here (`effects`);
 * 3. the layer matrix on the outer element (`transform-origin: 0 0`); a corner pin (M2) makes it the
 *    projective map `props.projective` written as `matrix3d`;
 * 4. opacity on the outer element;
 * 5. blend with `mix-blend-mode` against the layers below (the stack root is `isolation: isolate`).
 * fx framework: media layers run GPU shader effects in their source component (`FxPicture`) and pass the
 * remaining effects here; DOM layers (text, shapes, motion graphics) that leave `effects` unset get them here — the
 * content is drawn through `<HtmlInCanvas>` (`FxDomPicture`) when the browser has HTML-in-Canvas, else the shader
 * effects are bypassed with a chip (preview; renders always have it).
 * Inline styles only (ARCHITECTURE D-14).
 */
export function LayerBox({
	layer,
	children,
	style,
	effects,
	overlay,
	masksInChain,
}: {
	layer: LayerProps;
	children?: ReactNode;
	/** Style of the source content box (e.g. a solid background). */
	style?: CSSProperties;
	/** Effects drawn as CSS/SVG stages (default: all of the layer's effects). */
	effects?: readonly ResolvedEffect[];
	/** Drawn over the layer content inside its box (e.g. the "Grade unavailable" chip, preview only). */
	overlay?: ReactNode;
	/** wp masks: the layer's picture already went through the fx chain, Opacity masks included. */
	masksInChain?: boolean;
}) {
	const { props, clip } = layer;
	// Transition framework: a side of a GPU transition whose component did not capture it already (cards, proxies,
	// any DOM content) is captured here through HTML-in-Canvas.
	// edit-structure: a nested sequence's colour effects run in the canvas chain too (no colour stage for DOM).
	// color-mgmt: so do every DOM layer's (text, shapes, motion graphics, captions): grades and the colour input
	// transform of graphics in a non-Rec.709 working space.
	const chain =
		(DOM_FX_KINDS.has(clip.kind) || clip.kind === 'captions') &&
		props.effects.some(
			(fx) => fx.enabled && !!defaultEffectRegistry.get(fx.effectId, fx.effectVersion)?.color,
		);
	const domFx = useLayerFx(layer, {
		enabled:
			effects === undefined &&
			(DOM_FX_KINDS.has(clip.kind) ||
				chain ||
				// imports: Lottie / vector pictures are DOM content too.
				!!layer.media?.lottie ||
				!!layer.media?.vector ||
				!!layer.transition?.tap ||
				!!layer.matte ||
				!!layer.composite),
		canRun: canUseHtmlInCanvas(),
		chain,
	});
	const cssEffects = domFx.mode === 'active' ? domFx.cssEffects : (effects ?? props.effects);
	const stages = useMemo(() => effectStages(cssEffects, `fx-${clip.clipId}`), [cssEffects, clip.clipId]);
	let content: ReactNode = (
		<div data-layer-source="" style={{ ...FILL, ...style }}>
			{children}
		</div>
	);
	if (domFx.mode === 'active') content = <FxDomPicture stage={domFx.stage}>{content}</FxDomPicture>;
	const chip = domFx.mode === 'none' ? null : domFx.chip;
	const shownOverlay = chip ? <GradeChip layer={layer} text={chip} /> : overlay;
	// wp masks: where the chain could not run (preview without WebGL2 / HTML-in-Canvas), the Opacity masks are a CSS
	// mask image of the CPU coverage (same definition), applied after the effects (Premiere's Opacity order).
	const cpuMask = useCpuMaskStyle(props.masks, props.box, !masksInChain && domFx.mode !== 'active');
	// wp masks: a clip of a hidden matte track draws nothing itself (its chain, when it runs, feeds the matte).
	const hidden = !!layer.matte?.hide && !masksInChain && domFx.mode !== 'active';
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
	if (hidden) return null;
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
			{cpuMask ? (
				<div data-mask-fallback="" style={{ ...FILL, ...cpuMask }}>
					{content}
				</div>
			) : (
				content
			)}
			{shownOverlay}
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
