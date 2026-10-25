// Motion-graphic layer (ARCHITECTURE §8, D-12, D-31; S03:KND-060…062; S11:ATP-004/005/006, FIX-001).
// Dispatches on the template's renderer (the registry definition when the template is installed; the clip's
// stamp otherwise):
// - fframes: the template's TypeScript SVG twin for the clip-local frame at the template canvas size (the exported
//   master comes from `jasper-mg`; the twin mirrors its markup, unchanged by M2);
// - anime (M2): the `@jasper/motion/templates` implementation, mounted with responsive-time props (intro anchored
//   at content 0, outro at the content end) and its keyframed params evaluated for this frame;
// - not installed: a placeholder card (exports refuse such clips, S11:ATP-010).
// Both renderers draw through LayerBox (FIX-001): Motion, corner pin (projective), opacity, every blend mode
// (incl. `add`) and the CSS/SVG effect stages apply like on any other layer. Inline styles only (D-14).
import {
	type AnyMgTemplate,
	animeTemplateTiming,
	isAnimeTemplate,
	isSvgTemplate,
	mgRegistry,
} from '@jasper/mg-templates';
import { hash32 } from '@jasper/motion';
import { ANIME_TEMPLATE_IMPLS } from '@jasper/motion/templates';
import {
	collectParamMediaIds,
	evaluateTemplateParams,
	FLICKS_PER_SECOND,
	type Keyframe,
	type RenderVisualClip,
} from '@jasper/project';
import { type CSSProperties, createContext, type ReactNode, useContext, useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { ColorDocContext } from '../color/chain.ts';
import { FontsReadyContext } from '../fonts.ts';
import { mediaSrc } from '../pipeline.ts';
import type { LayerProps, RenderOptions } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';

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

type MgSource = Extract<RenderVisualClip['source'], { mg: unknown }>['mg'];

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

/** Card drawn for templates that are not installed (or anime templates without an implementation). */
function PlaceholderCard({ text, height }: { text: string; height: number }) {
	return (
		<div
			data-mg-placeholder=""
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
				fontSize: Math.max(12, height / 20),
			}}
		>
			{text}
		</div>
	);
}

function SvgTwin({ markup }: { markup: string }) {
	return (
		<div
			style={{ position: 'absolute', inset: 0, lineHeight: 0 }}
			// Markup is produced by our own twin; params are XML-escaped there (core.ts escapeXml).
			// biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, escaped template output
			dangerouslySetInnerHTML={{ __html: markup }}
		/>
	);
}

const NO_MEDIA: Readonly<Record<string, string>> = Object.freeze({});

/**
 * `AnimeTemplateProps.mediaUrls`: the URL of every medium the template params reference (avatars), from the
 * document's media handles exactly like effect media (engine URLs, signed in renders; the proxy or display picture
 * where the original is not browser-decodable). Missing or offline media are left out.
 */
function useTemplateMediaUrls(
	params: Record<string, unknown>,
	options: Pick<RenderOptions, 'useProxies'>,
): Readonly<Record<string, string>> {
	const media = useContext(ColorDocContext).media;
	const ids = collectParamMediaIds(params);
	const key = ids.join('\n');
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the referenced ids
	return useMemo(() => {
		if (ids.length === 0) return NO_MEDIA;
		const out: Record<string, string> = {};
		for (const id of ids) {
			const h = media[id];
			if (!h || (h.browserDecodable === false && !h.proxyUrl)) continue;
			out[id] = mediaSrc(h, options);
		}
		return out;
	}, [key, media, options.useProxies]);
}

/**
 * An anime template for one frame: keyframed params evaluated at `contentTime` (shared evaluator, S11:ATP-006),
 * schema-resolved, responsive time from the clip (S11:ATP-004), seed `hash32(clipId, 'template')`. Rendered only
 * once the document's font faces have settled (S11:FIX-003; renders wait through `delayRender` anyway).
 */
function AnimeTemplate(p: {
	def: AnyMgTemplate;
	mg: Pick<MgSource, 'template' | 'params' | 'canvas'> & {
		paramKeyframes?: Record<string, Keyframe<unknown>[]>;
	};
	clipId: string;
	localFrame: number;
	contentTime: number;
	durationFrames: number;
	sourceInFrames: number;
	fps: number;
	isPreview: boolean;
	/** Proxy choice of the media URLs (absent: originals). */
	useProxies?: boolean;
}) {
	const fontsReady = useContext(FontsReadyContext).allLoaded;
	const key = `${p.def.id}@${p.def.version}`;
	const Impl = ANIME_TEMPLATE_IMPLS[key];
	const info = useMemo(() => mgRegistry.get(p.def.id, p.def.version), [p.def]);
	const evaluated = evaluateTemplateParams(info, p.mg.params, p.mg.paramKeyframes, p.contentTime);
	const params = useMemo(() => resolveParams(p.def, evaluated), [p.def, evaluated]);
	const mediaUrls = useTemplateMediaUrls(params, { useProxies: p.useProxies ?? false });
	if (!Impl)
		return (
			<PlaceholderCard text={`Anime template ${key} has no implementation`} height={p.mg.canvas.height} />
		);
	if (!fontsReady) return null;
	const t = animeTemplateTiming(p.def, {
		fps: p.fps,
		localFrame: p.localFrame,
		durationFrames: p.durationFrames,
		sourceInFrames: p.sourceInFrames,
	});
	return (
		<Impl
			params={params}
			timeMs={t.timeMs}
			totalMs={t.totalMs}
			introMs={t.introMs}
			outroMs={t.outroMs}
			fps={p.fps}
			canvas={p.mg.canvas}
			seed={hash32(p.clipId, 'template')}
			isPreview={p.isPreview}
			mediaUrls={mediaUrls}
		/>
	);
}

export function MotionGraphicLayer(layer: LayerProps) {
	const { clip, props, localFrame, fps, options } = layer;
	const mg = 'mg' in clip.source ? clip.source.mg : null;
	const def = mg ? mgRegistry.getDefinition(mg.template.id, mg.template.version) : undefined;
	const svgParams = useMemo(
		() => (def && mg && isSvgTemplate(def) ? resolveParams(def, mg.params) : null),
		[def, mg],
	);
	const renderState = useContext(MgRenderStateContext)(clip.clipId);
	const sourceInFrames = Math.max(0, Math.round((clip.sourceIn * fps) / FLICKS_PER_SECOND));
	// The registry decides when the template is installed; the stamp only for unknown templates (S11:ATP-002).
	const renderer = def ? (isAnimeTemplate(def) ? 'anime' : 'fframes') : (mg?.renderer ?? 'fframes');
	let content: ReactNode;
	if (!mg) content = <PlaceholderCard text="Motion graphic" height={props.box.height} />;
	else if (!def)
		content = (
			<PlaceholderCard
				text={`Template ${mg.template.id}@${mg.template.version} is not installed`}
				height={props.box.height}
			/>
		);
	else if (isAnimeTemplate(def))
		content = (
			<AnimeTemplate
				def={def}
				mg={mg}
				clipId={clip.clipId}
				localFrame={localFrame}
				contentTime={layer.contentTime}
				durationFrames={clip.duration}
				sourceInFrames={sourceInFrames}
				fps={fps}
				isPreview={options.isPreview}
				useProxies={options.useProxies}
			/>
		);
	else {
		const markup = def.renderSvg(svgParams ?? def.defaults, localFrame, fps, mg.canvas, {
			durationFrames: clip.duration,
			sourceInFrames,
			idPrefix: `mg-${clip.clipId}`,
		});
		content = markup ? <SvgTwin markup={markup} /> : null;
	}
	const showBadge = options.isPreview && !!mg && !!def && renderer === 'fframes';
	return (
		<LayerBox
			layer={layer}
			overlay={showBadge ? <RenderBadge state={renderState} height={props.box.height} /> : undefined}
		>
			<div
				data-mg-template={mg ? `${mg.template.id}@${mg.template.version}` : undefined}
				data-mg-renderer={renderer}
				data-mg-installed={def ? 'true' : 'false'}
				style={FILL}
			>
				{content}
			</div>
		</LayerBox>
	);
}

const FILL: CSSProperties = { position: 'absolute', inset: 0 };

/** Props of `MgTemplatePreview` (gallery posters and hover previews, S11:ATP-007). */
export type MgTemplatePreviewProps = {
	templateId: string;
	version: number;
	/** Params over the template defaults (default: the defaults). */
	params?: Record<string, unknown>;
	/** Backdrop behind the template (default: transparent). */
	background?: string;
};

/**
 * A template alone on a canvas of the composition's size, `durationInFrames` long (gallery posters / hover
 * previews in the Motion Templates panel, through `<Thumbnail>` / `<Player>`). Same drawing code as the layer:
 * the SVG twin for fframes templates, the `@jasper/motion` implementation for anime templates.
 */
export function MgTemplatePreview(props: MgTemplatePreviewProps) {
	const frame = useCurrentFrame();
	const { fps, width, height, durationInFrames } = useVideoConfig();
	const def = mgRegistry.getDefinition(props.templateId, props.version);
	const canvas = { width, height };
	const params = useMemo(
		() => (def ? resolveParams(def, { ...def.defaults, ...(props.params ?? {}) }) : null),
		[def, props.params],
	);
	let content: ReactNode = null;
	if (!def || !params)
		content = (
			<PlaceholderCard
				text={`Template ${props.templateId}@${props.version} is not installed`}
				height={height}
			/>
		);
	else if (isAnimeTemplate(def))
		content = (
			<AnimeTemplate
				def={def}
				mg={{ template: { id: def.id, version: def.version }, params, canvas }}
				clipId={`preview:${def.id}@${def.version}`}
				localFrame={frame}
				contentTime={Math.round((frame * FLICKS_PER_SECOND) / fps)}
				durationFrames={durationInFrames}
				sourceInFrames={0}
				fps={fps}
				isPreview
			/>
		);
	else {
		const markup = def.renderSvg(params, frame, fps, canvas, {
			durationFrames: durationInFrames,
			sourceInFrames: 0,
			idPrefix: `mgp-${def.id}-${def.version}`,
		});
		content = markup ? <SvgTwin markup={markup} /> : null;
	}
	return (
		<AbsoluteFill
			style={{ background: props.background ?? 'transparent' }}
			data-mg-preview-template={props.templateId}
		>
			{content}
		</AbsoluteFill>
	);
}
