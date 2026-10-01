// Motion-graphic (fframes) layer (ARCHITECTURE §8, D-12; S03:KND-060…062).
// Renders the template's TypeScript SVG twin for the clip-local frame at the template canvas size;
// the standard layer matrix (S03:DM-012), opacity and blend mode place it like any other layer. The
// exported master comes from the `jasper-mg` binary; the twin mirrors its markup.
// Inline styles only (ARCHITECTURE D-14).
import { type AnyMgTemplate, mgRegistry } from '@jasper/mg-templates';
import { FLICKS_PER_SECOND, matrixToCss } from '@jasper/project';
import { type CSSProperties, createContext, useContext, useMemo } from 'react';
import type { LayerProps } from '../types.ts';

/** Engine render state of a motion-graphic clip (S03:KND-060 badge: none | rendering n% | ready). */
export type MgRenderState =
	| { status: 'none' }
	| { status: 'rendering'; progress: number }
	| { status: 'ready' }
	| { status: 'failed'; message?: string };

/**
 * Optional render-state lookup by clip id. The Program monitor (or whoever hosts the Player) can
 * provide it from engine job events; without a provider the badge shows the live SVG preview.
 */
export const MgRenderStateContext = createContext<(clipId: string) => MgRenderState | undefined>(
	() => undefined,
);

function resolveParams(def: AnyMgTemplate, params: Record<string, unknown>): Record<string, unknown> {
	const parsed = def.paramsSchema.safeParse(params);
	if (parsed.success) return parsed.data as Record<string, unknown>;
	// Invalid or partial params (e.g. a newer document): fall back field by field to the defaults.
	const merged: Record<string, unknown> = { ...def.defaults };
	for (const [k, v] of Object.entries(params)) {
		if (!(k in merged)) continue;
		const probe = def.paramsSchema.safeParse({ ...def.defaults, [k]: v });
		if (probe.success) merged[k] = v;
	}
	return merged;
}

function badgeText(state: MgRenderState | undefined): string {
	if (!state || state.status === 'none') return 'F · SVG preview';
	if (state.status === 'rendering') return `F · Rendering ${Math.round(state.progress * 100)}%`;
	if (state.status === 'ready') return 'F · Master ready';
	return 'F · Render failed';
}

function RenderBadge({ state, height }: { state: MgRenderState | undefined; height: number }) {
	const size = Math.max(12, Math.round(height / 45));
	return (
		<div
			data-mg-badge={state?.status ?? 'none'}
			style={{
				position: 'absolute',
				left: size / 2,
				top: size / 2,
				padding: `${size / 4}px ${size / 2}px`,
				borderRadius: size / 3,
				background: 'rgba(98, 0, 183, 0.85)',
				color: 'white',
				fontFamily: 'sans-serif',
				fontSize: size,
				lineHeight: 1.2,
				pointerEvents: 'none',
				whiteSpace: 'nowrap',
			}}
		>
			{badgeText(state)}
		</div>
	);
}

export function MotionGraphicLayer(layer: LayerProps) {
	const { clip, props, localFrame, fps, options } = layer;
	const mg = 'mg' in clip.source ? clip.source.mg : null;
	const def = mg ? mgRegistry.getDefinition(mg.template.id, mg.template.version) : undefined;
	const params = useMemo(() => (def && mg ? resolveParams(def, mg.params) : null), [def, mg]);
	const renderState = useContext(MgRenderStateContext)(clip.clipId);
	const sourceInFrames = Math.max(0, Math.round((clip.sourceIn * fps) / FLICKS_PER_SECOND));
	const svg =
		def && mg && params
			? def.renderSvg(params, localFrame, fps, mg.canvas, {
					durationFrames: clip.duration,
					sourceInFrames,
					idPrefix: `mg-${clip.clipId}`,
				})
			: null;
	const box: CSSProperties = {
		position: 'absolute',
		left: 0,
		top: 0,
		width: props.box.width,
		height: props.box.height,
		transformOrigin: '0 0',
		transform: matrixToCss(props.matrix),
		opacity: props.opacity / 100,
		mixBlendMode: clip.blendMode === 'normal' ? undefined : (clip.blendMode as CSSProperties['mixBlendMode']),
		overflow: 'hidden',
	};
	return (
		<div
			data-clip-id={clip.clipId}
			data-kind={clip.kind}
			data-mg-template={mg ? `${mg.template.id}@${mg.template.version}` : undefined}
			style={box}
		>
			{svg ? (
				<div
					style={{ position: 'absolute', inset: 0, lineHeight: 0 }}
					// Markup is produced by our own twin; params are XML-escaped there (core.ts escapeXml).
					// biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, escaped template output
					dangerouslySetInnerHTML={{ __html: svg }}
				/>
			) : (
				<div
					style={{
						position: 'absolute',
						inset: 0,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						background: 'rgba(98, 0, 183, 0.35)',
						outline: '2px dashed rgba(255,255,255,0.6)',
						outlineOffset: -2,
						color: 'white',
						fontFamily: 'sans-serif',
						fontSize: Math.max(12, props.box.height / 20),
					}}
				>
					{mg ? `Unknown motion template ${mg.template.id}@${mg.template.version}` : 'Motion graphic'}
				</div>
			)}
			{options.isPreview ? <RenderBadge state={renderState} height={props.box.height} /> : null}
		</div>
	);
}
