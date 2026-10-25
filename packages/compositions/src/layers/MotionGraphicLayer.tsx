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
	resolveTemplateParams,
	templateRequiredAssets,
} from '@jasper/mg-templates';
import { hash32 } from '@jasper/motion';
import {
	ANIME_TEMPLATE_IMPLS,
	MissingAssetMarker,
	MissingAssetReporterContext,
	type MissingTemplateAsset,
	missingAssetLabel,
	TemplateAssetScopeContext,
} from '@jasper/motion/templates';
import {
	emojiTableKey,
	evaluateTemplateParams,
	FLICKS_PER_SECOND,
	type Keyframe,
	type RenderTemplateAssets,
	type RenderVisualClip,
	type TemplateFaceFile,
	templateFontId,
} from '@jasper/project';
import {
	type CSSProperties,
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
} from 'react';
import { AbsoluteFill, getRemotionEnvironment, useCurrentFrame, useVideoConfig } from 'remotion';
import { EmojiTableContext, FontsReadyContext, useFontsReadyState } from '../fonts.ts';
import type { LayerProps, RenderDoc } from '../types.ts';
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

/**
 * social-comment §7.8: the missing assets of a template clip — its declared faces absent from the document's fonts or
 * failed to load, and its declared emoji absent from the emoji table.
 */
function missingTemplateAssets(
	assets: RenderTemplateAssets | undefined,
	fonts: RenderDoc['fonts'] | undefined,
	emoji: Readonly<Record<string, string>> | undefined,
	isFailed: ((family: string, weight: number, style: 'normal' | 'italic') => boolean) | undefined,
): MissingTemplateAsset[] {
	const out: MissingTemplateAsset[] = [];
	for (const face of assets?.fonts ?? []) {
		const fontId = templateFontId(face.family);
		const have = (fonts ?? []).some(
			(f) => f.fontId === fontId && f.weight === face.weight && f.style === face.style,
		);
		if (!have || isFailed?.(face.family, face.weight, face.style)) out.push({ kind: 'font', ...face });
	}
	for (const { pack, graphemes } of assets?.emoji ?? [])
		for (const g of graphemes)
			if (!emoji?.[emojiTableKey(pack, g)]) out.push({ kind: 'emoji', pack, grapheme: g });
	return out;
}

/**
 * Collects what a template clip could not draw (the layer's own checks and every `EmojiImage` inside) and reports it
 * to the editor (MissingAssetReporterContext, the Program monitor's panel warning).
 */
function useClipAssetScope(clipId: string) {
	const reporter = useContext(MissingAssetReporterContext);
	const state = useRef<{ entries: Map<string, MissingTemplateAsset>; sent: string; timer: number | null }>({
		entries: new Map(),
		sent: '[]',
		timer: null,
	});
	const scope = useMemo(() => {
		const flush = () => {
			state.current.timer = null;
			const seen = new Map<string, MissingTemplateAsset>();
			for (const a of state.current.entries.values()) seen.set(JSON.stringify(a), a);
			const key = JSON.stringify([...seen.keys()].sort());
			if (key === state.current.sent) return;
			state.current.sent = key;
			reporter?.(clipId, [...seen.values()]);
		};
		return {
			report(id: string, asset: MissingTemplateAsset | null) {
				if (asset) state.current.entries.set(id, asset);
				else state.current.entries.delete(id);
				if (reporter && state.current.timer === null) state.current.timer = window.setTimeout(flush, 0);
			},
		};
	}, [reporter, clipId]);
	useEffect(
		() => () => {
			if (state.current.timer !== null) window.clearTimeout(state.current.timer);
			state.current.timer = null;
			if (state.current.sent !== '[]') reporter?.(clipId, []);
			state.current.sent = '[]';
		},
		[reporter, clipId],
	);
	return scope;
}

/** Reports the layer's own missing assets (declared but unresolved / failed) to the clip scope. */
function LayerMissingReport({ missing }: { missing: readonly MissingTemplateAsset[] }) {
	const scope = useContext(TemplateAssetScopeContext);
	const key = JSON.stringify(missing);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `missing`
	useEffect(() => {
		if (!scope) return;
		missing.forEach((a, i) => {
			scope.report(`layer:${i}`, a);
		});
		return () => {
			for (let i = 0; i < missing.length; i++) scope.report(`layer:${i}`, null);
		};
	}, [scope, key]);
	return null;
}

/** The striped "font not available" banners over a template card (preview only). */
function FontMarkers({ missing, height }: { missing: readonly MissingTemplateAsset[]; height: number }) {
	const fonts = missing.filter((a) => a.kind === 'font');
	if (fonts.length === 0) return null;
	const size = Math.max(12, Math.round(height / 40));
	return (
		<div
			style={{
				position: 'absolute',
				left: size / 2,
				top: size / 2,
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'flex-start',
				gap: size / 3,
				pointerEvents: 'none',
				zIndex: 1,
			}}
		>
			{fonts.map((a) => (
				<MissingAssetMarker
					key={missingAssetLabel(a)}
					kind="font"
					label={`${missingAssetLabel(a)} is not available`}
					size={size}
				/>
			))}
		</div>
	);
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

/**
 * An anime template for one frame: keyframed params evaluated at `contentTime` (shared evaluator, S11:ATP-006),
 * schema-resolved, responsive time from the clip (S11:ATP-004), seed `hash32(clipId, 'template')`. Rendered only
 * once the document's font faces have settled (S11:FIX-003; renders wait through `delayRender` anyway).
 */
function AnimeTemplate(p: {
	def: AnyMgTemplate;
	mg: Pick<MgSource, 'template' | 'params' | 'canvas'> & {
		paramKeyframes?: Record<string, Keyframe<unknown>[]>;
		assets?: RenderTemplateAssets;
	};
	clipId: string;
	localFrame: number;
	contentTime: number;
	durationFrames: number;
	sourceInFrames: number;
	fps: number;
	isPreview: boolean;
	/** The document's font faces (template-declared faces are checked against them). */
	fonts?: RenderDoc['fonts'];
}) {
	const fontsState = useContext(FontsReadyContext);
	const fontsReady = fontsState.allLoaded;
	const emojiTable = useContext(EmojiTableContext);
	const key = `${p.def.id}@${p.def.version}`;
	const Impl = ANIME_TEMPLATE_IMPLS[key];
	const info = useMemo(() => mgRegistry.get(p.def.id, p.def.version), [p.def]);
	const evaluated = evaluateTemplateParams(info, p.mg.params, p.mg.paramKeyframes, p.contentTime);
	const params = useMemo(() => resolveTemplateParams(p.def, evaluated), [p.def, evaluated]);
	// social-comment §7.8: the template's emoji URLs and whatever it declared that is not available.
	const assets = p.mg.assets;
	const emojiUrls = useMemo(() => {
		const out: Record<string, string> = {};
		for (const { pack, graphemes } of assets?.emoji ?? [])
			for (const g of graphemes) {
				const k = emojiTableKey(pack, g);
				const url = emojiTable?.[k];
				if (url) out[k] = url;
			}
		return out;
	}, [assets, emojiTable]);
	const missing = useMemo(
		() => (fontsReady ? missingTemplateAssets(assets, p.fonts, emojiTable, fontsState.isFailed) : []),
		[fontsReady, assets, p.fonts, emojiTable, fontsState],
	);
	const scope = useClipAssetScope(p.clipId);
	if (!Impl)
		return (
			<PlaceholderCard text={`Anime template ${key} has no implementation`} height={p.mg.canvas.height} />
		);
	if (!fontsReady) return null;
	// A render never draws a template without its declared assets (the planner blocks such exports; this catches a
	// file that broke after planning): the render fails with the reason instead of substituting.
	if (missing.length > 0 && (!p.isPreview || getRemotionEnvironment().isRendering))
		throw new Error(
			`Template ${key} cannot be drawn: ${missing.map(missingAssetLabel).join(', ')} not available`,
		);
	const t = animeTemplateTiming(p.def, {
		fps: p.fps,
		localFrame: p.localFrame,
		durationFrames: p.durationFrames,
		sourceInFrames: p.sourceInFrames,
	});
	return (
		<TemplateAssetScopeContext.Provider value={scope}>
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
				emojiUrls={emojiUrls}
			/>
			<LayerMissingReport missing={missing} />
			<FontMarkers missing={missing} height={p.mg.canvas.height} />
		</TemplateAssetScopeContext.Provider>
	);
}

export function MotionGraphicLayer(layer: LayerProps) {
	const { clip, props, localFrame, fps, options } = layer;
	const mg = 'mg' in clip.source ? clip.source.mg : null;
	const def = mg ? mgRegistry.getDefinition(mg.template.id, mg.template.version) : undefined;
	const svgParams = useMemo(
		() => (def && mg && isSvgTemplate(def) ? resolveTemplateParams(def, mg.params) : null),
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
				fonts={layer.fonts}
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
	/**
	 * social-comment §7.8: URLs of the template's declared fonts (one URL, or subset files with unicode ranges) and emoji
	 * (null = unavailable), e.g. from the engine's font catalogue (`catalogFaceFiles`, `emojiImagePath` of
	 * `@jasper/api`). Without it a template that declares assets shows its "not available" markers. Keep its identity
	 * stable.
	 */
	assets?: {
		font(face: RenderTemplateAssets['fonts'][number]): string | readonly TemplateFaceFile[] | null;
		emoji(pack: string, grapheme: string): string | null;
	};
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
		() => (def ? resolveTemplateParams(def, { ...def.defaults, ...(props.params ?? {}) }) : null),
		[def, props.params],
	);
	// social-comment §7.8: the template's declared fonts (loaded here: a gallery poster has no document) and emoji.
	const resolver = props.assets;
	const declared = useMemo(() => {
		const assets = def && params ? templateRequiredAssets(def, params) : null;
		const fonts: RenderDoc['fonts'] = [];
		const emoji: Record<string, string> = {};
		for (const face of assets?.fonts ?? []) {
			const found = resolver?.font(face);
			for (const f of typeof found === 'string' ? [{ url: found }] : (found ?? []))
				if (f.url)
					fonts.push({
						fontId: templateFontId(face.family),
						...face,
						url: f.url,
						...('unicodeRange' in f && f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
					});
		}
		for (const { pack, graphemes } of assets?.emoji ?? [])
			for (const g of graphemes) {
				const url = resolver?.emoji(pack, g);
				if (url) emoji[emojiTableKey(pack, g)] = url;
			}
		return { assets: assets ?? undefined, fonts, emoji };
	}, [def, params, resolver]);
	const fontsReady = useFontsReadyState(declared.fonts);
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
			<FontsReadyContext.Provider value={fontsReady}>
				<EmojiTableContext.Provider value={declared.emoji}>
					<AnimeTemplate
						def={def}
						mg={{
							template: { id: def.id, version: def.version },
							params,
							canvas,
							...(declared.assets ? { assets: declared.assets } : {}),
						}}
						clipId={`preview:${def.id}@${def.version}`}
						localFrame={frame}
						contentTime={Math.round((frame * FLICKS_PER_SECOND) / fps)}
						durationFrames={durationInFrames}
						sourceInFrames={0}
						fps={fps}
						isPreview
						fonts={declared.fonts}
					/>
				</EmojiTableContext.Provider>
			</FontsReadyContext.Provider>
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
