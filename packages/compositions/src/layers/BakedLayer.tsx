// Baked pictures of DOM layers (M2, S11:LBK-010 — FIX-002; owner wp-m2-layer-bake). Text, shapes and anime templates
// are drawn by React/DOM, which has no colour stage: their colour effects (D-21) are applied by ffmpeg to a baked
// master instead. This wrapper (applied to the DOM layer components in the layer table) shows that picture:
// - renders (`isPreview: false`): `clip.baked` — the graded master the engine injects on the Remotion path — played
//   through <OffthreadVideo transparent> in its region of the frame;
// - preview (Player): the graded VP9-alpha preview of the clip's current state, when the host app's runtime has it
//   (`setBakedLayerRuntime`, apps/web/src/layer-bake/runtime.ts); until then the layer draws ungraded with a
//   "Grade pending" chip.
// The baked picture is the whole placed layer (Motion, effects, opacity and transition fades included), so it is
// positioned in sequence pixels, outside the layer box. Layers without colour effects are untouched.
import { defaultEffectRegistry, type RenderVisualClip } from '@jasper/project';
import { Video } from '@remotion/media';
import { type ComponentType, type CSSProperties, useSyncExternalStore } from 'react';
import { OffthreadVideo, Sequence } from 'remotion';
import { blendModeCss } from '../pipeline.ts';
import type { LayerProps } from '../types.ts';
import { GradeChip, LayerBox } from './LayerBox.tsx';

/** A graded preview of a DOM layer: frame 0 = the clip's first drawn frame (`start − headHandle`). */
export type BakedLayerPreview = {
	url: string;
	/** Region of the sequence frame (null = the whole frame); the video is scaled to it. */
	rect: { x: number; y: number; w: number; h: number } | null;
};

/** What the wrapper asks the host app in the preview (installed once by the web app). */
export type BakedLayerRuntime = {
	/** The graded preview of the clip as it is now, or null (not requested / not ready / stale). */
	previewFor(clip: RenderVisualClip, fps: number): BakedLayerPreview | null;
	subscribe(cb: () => void): () => void;
	version(): number;
};

let installed: BakedLayerRuntime | null = null;
const listeners = new Set<() => void>();

/** Installs the process-wide runtime (the web app does this at start-up). */
export function setBakedLayerRuntime(r: BakedLayerRuntime | null): void {
	installed = r;
	for (const l of listeners) l();
}

const subscribeInstall = (cb: () => void) => {
	listeners.add(cb);
	return () => listeners.delete(cb);
};

function useBakedLayerRuntime(): BakedLayerRuntime | null {
	const rt = installed;
	useSyncExternalStore(
		rt ? rt.subscribe : subscribeInstall,
		() => (rt ? rt.version() : 0),
		() => 0,
	);
	return rt;
}

/** DOM layers (S11 §0): text, shapes and Remotion-rendered motion graphics (anime templates). */
export function isDomLayerClip(clip: Pick<RenderVisualClip, 'kind' | 'engine'>): boolean {
	return (
		(clip.kind === 'text' || clip.kind === 'shape' || clip.kind === 'motion-graphic') &&
		clip.engine === 'remotion'
	);
}

/** The DOM layer has enabled colour-op effects (they need a baked, graded picture). */
export function hasDomColorEffects(clip: RenderVisualClip): boolean {
	return (
		isDomLayerClip(clip) &&
		clip.effects.some((fx) => fx.enabled && !!defaultEffectRegistry.get(fx.effectId, fx.effectVersion)?.color)
	);
}

function regionStyle(
	rect: { x: number; y: number; w: number; h: number } | null | undefined,
	clip: RenderVisualClip,
): CSSProperties {
	return {
		position: 'absolute',
		left: rect?.x ?? 0,
		top: rect?.y ?? 0,
		width: rect ? rect.w : '100%',
		height: rect ? rect.h : '100%',
		mixBlendMode: blendModeCss(clip.blendMode),
		pointerEvents: 'none',
	};
}

const FILL: CSSProperties = { width: '100%', height: '100%', display: 'block' };

/** Engine renders: the injected graded master (frame 0 = sequence frame `baked.startFrame`). */
function BakedMaster({ layer }: { layer: LayerProps }) {
	const { clip } = layer;
	const baked = clip.baked!;
	// The clip's Sequence starts at its first drawn frame.
	const offset = baked.startFrame - (clip.start - (clip.headHandle ?? 0));
	return (
		<div
			data-clip-id={clip.clipId}
			data-kind={clip.kind}
			data-baked="master"
			style={regionStyle(baked.rect, clip)}
		>
			<Sequence from={offset} layout="none" name="Baked layer">
				<OffthreadVideo src={baked.url} transparent muted style={FILL} showInTimeline={false} />
			</Sequence>
		</div>
	);
}

function BakedPreview({ layer, preview }: { layer: LayerProps; preview: BakedLayerPreview }) {
	const { clip } = layer;
	return (
		<div
			data-clip-id={clip.clipId}
			data-kind={clip.kind}
			data-baked="preview"
			style={regionStyle(preview.rect, clip)}
		>
			<Video src={preview.url} muted objectFit="fill" style={FILL} showInTimeline={false} />
		</div>
	);
}

/** The layer needs the wrapper: a baked picture (renders) or colour effects on a DOM layer (preview chip/preview). */
export function needsBakedPicture(clip: RenderVisualClip): boolean {
	return !!clip.baked || hasDomColorEffects(clip);
}

const wrapped = new WeakMap<ComponentType<LayerProps>, ComponentType<LayerProps>>();

/**
 * Wraps a DOM layer component (`layerComponentFor` does it for the layers that need it; one stable wrapper per
 * component): plays the baked picture when there is one, else draws the layer (with a "Grade pending" chip in the
 * preview when it has colour effects).
 */
export function withBakedLayer(Component: ComponentType<LayerProps>): ComponentType<LayerProps> {
	const existing = wrapped.get(Component);
	if (existing) return existing;
	function Baked(layer: LayerProps) {
		const { clip, options } = layer;
		const runtime = useBakedLayerRuntime();
		if (clip.baked) return <BakedMaster layer={layer} />;
		if (!options.isPreview || !hasDomColorEffects(clip)) return <Component {...layer} />;
		const bypass = options.colorBypassClipIds?.includes(clip.clipId) ?? false;
		const preview = bypass ? null : (runtime?.previewFor(clip, layer.fps) ?? null);
		if (preview) return <BakedPreview layer={layer} preview={preview} />;
		return (
			<>
				<Component {...layer} />
				{bypass ? null : (
					<LayerBox layer={layer} effects={[]} overlay={<GradeChip layer={layer} text="Grade pending" />} />
				)}
			</>
		);
	}
	Baked.displayName = `Baked(${Component.displayName ?? Component.name ?? 'Layer'})`;
	wrapped.set(Component, Baked);
	return Baked;
}
