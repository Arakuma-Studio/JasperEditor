// Adjustment layers (edit-structure, S01:KND-012, FX-002): an adjustment clip's effects run on the composite of every
// track below it (background included) during its range, and the result is mixed back over that composite with the
// clip's opacity (× transition fades) and blend mode, limited to its crop (Premiere: cropping an adjustment layer
// limits where its effects apply). `VideoTracks` wraps the tracks below each track that holds adjustment clips in one
// scope; the scope's element structure never changes over time (no remounts of the layers below).
// Two ways, decided per track from all its adjustment clips (static, so the DOM stays stable):
// - `css`: every effect is a CSS filter / SVG filter at full opacity, Normal blend and no crop — the scope element
//   gets the filter (exact; works in every browser; not a Repeat Edge blur, which Chrome's SVG filter cannot draw);
// - `canvas`: the composite is drawn through Remotion's `<HtmlInCanvas>` and the canvas effect chain: `stash` (keep
//   the original) → the effects (shader passes, colour runs, CSS filters, flips) → `mix` (adjusted over original with
//   opacity, blend and the crop region). Renders always have HTML-in-Canvas; a Player without it shows the composite
//   unadjusted with a chip, and a render that cannot run it fails (FX_LAYER_UNSUPPORTED), never a different picture.
// crop-order (schema v8, docs/wp-notes/crop-order.md §4): a crop limits the region the adjustment replaces — its window
// mirrored by the flips after it, several crops intersecting, Edge Feather fading the region in from the edges; a crop
// placed before an effect that mixes pixels (blur, glow…) also clears the picture outside its window at its stack
// position (a hard cut), so that effect sees transparency beyond the crop edge as it does beyond the frame edge.
import {
	activeMasks,
	type CropInsets,
	clipContentTime,
	clipHasMasks,
	defaultEffectRegistry,
	dissolveSeed,
	fadeFactor,
	gaussianBlurRepeatsEdge,
	type RenderVisualClip,
	type ResolvedEffect,
	resolveCachedLayerProps,
	stackCrops,
} from '@jasper/project';
import { type CSSProperties, type ReactNode, useMemo, useRef } from 'react';
import { type EffectDescriptor, useCurrentFrame } from 'remotion';
import { ScopedHtmlInCanvas } from '../fx/canvas-scope.tsx';
import { canUseHtmlInCanvas, useDomFxDescriptors } from '../fx/FxPicture.tsx';
import { usePublishFlatChain } from '../fx/flat.tsx';
import { type AdjustmentHolder, type FxPreparedStep, useLayerFx } from '../fx/stage.ts';
import { effectStages } from '../pipeline.ts';
import type { LayerProps, RenderDoc, RenderOptions } from '../types.ts';
import { GradeChip } from './LayerBox.tsx';

const CROP = 'jasper.crop';
const FILL: CSSProperties = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' };

/** True when a CSS filter on the scope renders the clip exactly (see the file comment). */
export function cssExactAdjustment(clip: RenderVisualClip): boolean {
	if (clip.blendMode !== 'normal') return false;
	// wp masks: Opacity / effect masks limit where the effects apply (canvas chain).
	if (clipHasMasks(clip)) return false;
	if (clip.opacity.value !== 100 || clip.opacity.keyframes.length > 0) return false;
	if (clip.fades?.length) return false;
	for (const fx of clip.effects) {
		if (!fx.enabled) continue;
		const spec = defaultEffectRegistry.get(fx.effectId, fx.effectVersion);
		if (spec?.appliesTo !== 'video') continue;
		if (fx.effectId === CROP || spec.gpu || spec.color) return false;
		// No SVG filter repeats the edge pixels in Chrome: the canvas chain's stand-in does.
		if (gaussianBlurRepeatsEdge(fx)) return false;
		// Only filter-type CSS (or an SVG filter): anything else (transforms, clip paths) changes geometry.
		const probe = spec.preview.css?.(Object.fromEntries(spec.params.map((p) => [p.name, p.default])));
		if (probe && Object.keys(probe).some((k) => k !== 'filter')) return false;
		if (!probe && !spec.preview.svgFilter) return false;
	}
	return true;
}

/** Effects that commute with a crop on an adjustment layer (pointwise colour, flips, other crops, the layer map). */
function commutesWithCrop(fx: ResolvedEffect): boolean {
	if (
		fx.effectId === CROP ||
		fx.effectId === 'jasper.flip-horizontal' ||
		fx.effectId === 'jasper.flip-vertical'
	)
		return true;
	if (fx.effectId === 'jasper.corner-pin') return true;
	const spec = defaultEffectRegistry.get(fx.effectId, fx.effectVersion);
	return spec?.appliesTo !== 'video' || (!!spec.color && !spec.gpu);
}

/**
 * crop-order: the effects an adjustment layer's canvas chain runs: its stack without crops (the `mix` region applies
 * them), except that a crop placed before an effect that mixes pixels stays at its place as a hard cut (feather 0,
 * id suffixed so it never takes the feathered path: the feather is the region's).
 */
function adjustmentChainEffects(effects: readonly ResolvedEffect[]): ResolvedEffect[] {
	const out: ResolvedEffect[] = [];
	effects.forEach((fx, i) => {
		if (fx.effectId !== CROP) {
			out.push(fx);
			return;
		}
		if (!fx.enabled) return;
		if (effects.slice(i + 1).some((e) => e.enabled && !commutesWithCrop(e)))
			out.push({ ...fx, id: `${fx.id}:cut`, params: { ...fx.params, feather: 0 } });
	});
	return out;
}

/**
 * crop-order: the region an adjustment layer replaces — the intersection of its hard crops' windows and the
 * feathered crops' windows with their Edge Feather (each window mirrored by the flips after its crop).
 */
function adjustmentCropRegion(effects: readonly ResolvedEffect[]): {
	insets: CropInsets | null;
	feather: { insets: CropInsets; feather: number }[];
} {
	let insets: CropInsets | null = null;
	const feather: { insets: CropInsets; feather: number }[] = [];
	for (const c of stackCrops(effects)) {
		if (c.feather > 0) feather.push({ insets: c.insets, feather: c.feather });
		else insets = insets ? (insets.map((v, i) => Math.max(v, c.insets[i]!)) as CropInsets) : c.insets;
	}
	return { insets, feather };
}

/** The clips of `clips` covering sequence frame `frame` (adjustment clips have no transition handles). */
export function activeAt(clips: readonly RenderVisualClip[], frame: number): RenderVisualClip | null {
	for (const c of clips) if (frame >= c.start && frame < c.start + c.duration) return c;
	return null;
}

export function AdjustmentScope({
	clips,
	doc,
	options,
	offset,
	children,
}: {
	clips: readonly RenderVisualClip[];
	doc: RenderDoc;
	options: RenderOptions;
	offset: number;
	children?: ReactNode;
}) {
	const frame = useCurrentFrame() + offset;
	const css = useMemo(() => clips.every(cssExactAdjustment), [clips]);
	const active = activeAt(clips, frame);
	const props = active
		? resolveCachedLayerProps(active, clipContentTime(active, frame, doc.settings.fps))
		: null;
	if (css)
		return (
			<CssScope active={active} effects={props?.effects ?? []}>
				{children}
			</CssScope>
		);
	return (
		<CanvasScope clips={clips} active={active} frame={frame} doc={doc} options={options} props={props}>
			{children}
		</CanvasScope>
	);
}

function CssScope({
	active,
	effects,
	children,
}: {
	active: RenderVisualClip | null;
	effects: readonly ResolvedEffect[];
	children?: ReactNode;
}) {
	const stages = useMemo(
		() => (active ? effectStages(effects, `adj-${active.clipId}`) : []),
		[active, effects],
	);
	const filter = stages
		.map((s) => s.style.filter)
		.filter((f): f is string => typeof f === 'string' && f.length > 0)
		.join(' ');
	const markup = stages.map((s) => s.svg?.markup ?? '').join('');
	return (
		<>
			<svg
				width={0}
				height={0}
				style={{ position: 'absolute', width: 0, height: 0 }}
				aria-hidden="true"
				// biome-ignore lint/security/noDangerouslySetInnerHtml: effect registry SVG filter markup (app code)
				dangerouslySetInnerHTML={{ __html: markup }}
			/>
			<div
				data-adjustment-scope="css"
				data-adjustment-active={active?.clipId ?? ''}
				style={{ ...FILL, filter: filter || undefined }}
			>
				{children}
			</div>
		</>
	);
}

/**
 * The canvas chain of an adjustment track at the current frame (`stash` → effects → `mix`), in the padded layout of the
 * active clip's effects: shared by the canvas scope (HTML-in-Canvas capture of the stack below) and by the flat
 * compositor (fx/flat.tsx), which runs the same descriptors on its accumulated composite.
 */
export function useAdjustmentChain(
	clips: readonly RenderVisualClip[],
	active: RenderVisualClip | null,
	frame: number,
	doc: RenderDoc,
	options: RenderOptions,
	props: ReturnType<typeof resolveCachedLayerProps> | null,
	canRun: boolean,
) {
	const holder = useRef<AdjustmentHolder>({ canvas: null }).current;
	const fps = doc.settings.fps.num / doc.settings.fps.den;
	const clip = active ?? clips[0]!;
	const effects = useMemo(() => adjustmentChainEffects(props?.effects ?? []), [props]);
	const region = useMemo(() => adjustmentCropRegion(props?.effects ?? []), [props]);
	const opacity = active && props ? (props.opacity / 100) * fadeFactor(active.fades, frame) : 0;
	// wp masks: the Opacity masks limit where the adjustment applies (the mix step's coverage), they do not cut the
	// composite below; effect masks stay on their effects (fxMasked: mix(input, effected, coverage)).
	const baseProps =
		props ?? resolveCachedLayerProps(clip, clipContentTime(clip, clip.start, doc.settings.fps));
	const opacityMasks = useMemo(
		() => (active && baseProps.masks?.length ? activeMasks(baseProps.masks) : []),
		[active, baseProps.masks],
	);
	const layerProps = useMemo(
		() => (baseProps.masks?.length ? { ...baseProps, masks: [] } : baseProps),
		[baseProps],
	);
	const layer: LayerProps = {
		clip,
		props: layerProps,
		localFrame: frame - clip.start,
		contentTime: clipContentTime(clip, frame, doc.settings.fps),
		fps,
		media: null,
		options,
		fonts: doc.fonts,
	};
	// keyframes-blend: every clip blend mode, composited on the GPU with the formulas of the native kernel.
	const blend = active ? clip.blendMode : 'normal';
	const seed = active ? dissolveSeed(active.clipId, frame - active.start) : 0;
	const insets = region.insets;
	const feather = region.feather;
	const key = `${opacity}:${blend}:${seed}:${insets?.join(',') ?? ''}:${feather.map((f) => `${f.insets.join(',')}/${f.feather}`).join(';')}:${opacityMasks.length ? JSON.stringify(opacityMasks) : ''}`;
	const extraSteps = useMemo((): { first: FxPreparedStep[]; last: FxPreparedStep[] } => {
		return {
			first: [{ kind: 'stash', key: 'stash', holder }],
			last: [
				{
					kind: 'mix',
					key: `mix:${key}`,
					holder,
					opacity,
					blend,
					seed,
					insets,
					...(feather.length ? { feather } : {}),
					...(opacityMasks.length ? { opacityMasks } : {}),
				},
			],
		};
	}, [key, holder, opacity, blend, seed, insets, feather, opacityMasks]);
	const fx = useLayerFx(layer, {
		enabled: !!active,
		canRun,
		chain: true,
		effects,
		extraSteps,
	});
	const stage = fx.mode === 'active' ? fx.stage : null;
	const descriptors = useDomFxDescriptors(stage);
	return { layer, fx, stage, descriptors };
}

function CanvasScope({
	clips,
	active,
	frame,
	doc,
	options,
	props,
	children,
}: {
	clips: readonly RenderVisualClip[];
	active: RenderVisualClip | null;
	frame: number;
	doc: RenderDoc;
	options: RenderOptions;
	props: ReturnType<typeof resolveCachedLayerProps> | null;
	children?: ReactNode;
}) {
	const canRun = canUseHtmlInCanvas();
	const W = doc.settings.width;
	const H = doc.settings.height;
	const { layer, fx, stage, descriptors } = useAdjustmentChain(
		clips,
		active,
		frame,
		doc,
		options,
		props,
		canRun,
	);
	if (!canRun)
		return (
			<>
				<div data-adjustment-scope="bypass" style={FILL}>
					{children}
				</div>
				{active && options.isPreview ? (
					<GradeChip
						layer={layer}
						text="Adjustment layers need HTML-in-Canvas here (chrome://flags/#canvas-draw-element)"
					/>
				) : null}
			</>
		);
	const L = stage?.layout;
	const chip =
		active && options.isPreview && fx.mode !== 'active' ? (
			<GradeChip layer={layer} text={fx.mode === 'bypass' ? fx.chip : 'Adjustment layer unavailable'} />
		) : null;
	return (
		<>
			<ScopedHtmlInCanvas
				scope="An adjustment layer"
				width={L?.cssWidth ?? W}
				height={L?.cssHeight ?? H}
				pixelDensity={L?.pxScale ?? 1}
				effects={stage ? descriptors : []}
				style={{
					position: 'absolute',
					left: -(L?.padding.left ?? 0),
					top: -(L?.padding.top ?? 0),
					width: L?.cssWidth ?? W,
					height: L?.cssHeight ?? H,
					display: 'block',
				}}
				showInTimeline={false}
			>
				<div
					data-adjustment-scope="canvas"
					data-adjustment-active={active?.clipId ?? ''}
					style={{
						position: 'absolute',
						left: L?.padding.left ?? 0,
						top: L?.padding.top ?? 0,
						width: W,
						height: H,
					}}
				>
					{children}
				</div>
			</ScopedHtmlInCanvas>
			{chip}
		</>
	);
}

/**
 * compositor: an adjustment track of a flat stack (fx/flat.tsx). Nothing is captured: the track's chain at the current
 * frame is published for the compositor, which runs it on the composite of everything below.
 */
export function FlatAdjustment({
	trackId,
	clips,
	doc,
	options,
	offset,
}: {
	trackId: string;
	clips: readonly RenderVisualClip[];
	doc: RenderDoc;
	options: RenderOptions;
	offset: number;
}) {
	const frame = useCurrentFrame() + offset;
	const active = activeAt(clips, frame);
	const props = active
		? resolveCachedLayerProps(active, clipContentTime(active, frame, doc.settings.fps))
		: null;
	const { layer, fx, stage, descriptors } = useAdjustmentChain(
		clips,
		active,
		frame,
		doc,
		options,
		props,
		true,
	);
	usePublishFlatChain(`adjust:${trackId}`, {
		frame,
		effects: stage ? descriptors : NO_EFFECTS,
		layout: stage?.layout ?? null,
		// Renders wait for the chain's LUT assets (the scope's capture would draw again when they arrive).
		ready: !active || (!!stage && !stage.pending),
		key: stage ? `${stage.key}|${descriptors.length}` : active ? 'unavailable' : 'idle',
	});
	if (active && options.isPreview && fx.mode !== 'active')
		return <GradeChip layer={layer} text={fx.mode === 'bypass' ? fx.chip : 'Adjustment layer unavailable'} />;
	return null;
}

const NO_EFFECTS: EffectDescriptor[] = [];
