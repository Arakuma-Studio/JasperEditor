// The fx stage of a layer at the current frame (wave-1 fx framework): the stack plan (fx/plan.ts), the canvas
// layout (box + padding), one `FxEffectPlan` per shader effect (registry/fx/shader.ts `planGpuEffect`), baked LUTs
// for colour runs, time samples, media inputs and the built-in uniforms — everything `FxPicture` (media layers) and
// `FxDomPicture` (DOM layers) need to build the canvas effect chain. Renders that need the GPU and cannot have it
// fail with WEBGL_UNAVAILABLE (never silently unprocessed, as S06:CG-042 for grades).
import {
	colorRunKey,
	type EffectSpec,
	FX_MAX_CANVAS,
	type FxEffectPlan,
	type FxFrameContext,
	type FxUniform,
	fxBuiltinUniforms,
	fxClipProgress,
	fxSeed,
	fxTimeSamples,
	type Lut,
	layerMapOf,
	type MediaHandle,
	PREVIEW_LUT_SIZE,
	planGpuEffect,
	type ResolvedEffect,
} from '@jasper/project';
import { useContext, useMemo } from 'react';
import { cancelRender, Internals } from 'remotion';
import { ColorDocContext, referencedMedia, useLutAssets } from '../color/chain.ts';
import { bakedRunLut, loadedLutAsset, lutUrlKey } from '../color/luts.ts';
import type { LayerProps } from '../types.ts';
import { type FxBypass, type FxCanvasLayout, fxCanvasLayout, type LayerFxPlan, planLayerFx } from './plan.ts';
import { fxEffectRegistry } from './registry.ts';
import { fxStatus, useFxStatus } from './status.ts';

export type FxLayout = FxCanvasLayout;

export type FxPreparedStep =
	| { kind: 'gpu'; key: string; plan: FxEffectPlan; seed: number; sampleOffsets: number[] }
	| { kind: 'lut'; key: string; lut: Lut | null }
	| { kind: 'css'; key: string; filter: string }
	| { kind: 'crop'; key: string; insets: [number, number, number, number] }
	| { kind: 'flip'; key: string; horizontal: boolean };

/** A media param input of the layer's shader effects. */
export type FxMediaInput = { mediaId: string; url: string; kind: 'image' | 'video' };

export type FxStage = {
	plan: LayerFxPlan;
	layout: FxLayout;
	steps: FxPreparedStep[];
	/** Union of the time-sample offsets of every shader effect (the extra source pictures to fetch). */
	samples: number[];
	media: FxMediaInput[];
	/** Built-in uniforms of the layer at this frame (u_seed is per step). */
	builtins: FxUniform[];
	/** Identity of the stage (redraw when it changes). */
	key: string;
	/** LUT assets of colour runs are still loading (the preview draws without them meanwhile). */
	pending: boolean;
};

export type LayerFx =
	/** No enabled shader effect: the layer draws the M1/M2 way. */
	| { mode: 'none' }
	/** Shader effects present but not drawable here (preview only): M1/M2 drawing + a chip. */
	| { mode: 'bypass'; chip: string; bypassed: FxBypass[] }
	| { mode: 'active'; stage: FxStage; cssEffects: ResolvedEffect[]; chip: string | null };

const NONE: LayerFx = { mode: 'none' };

function chipText(bypassed: readonly FxBypass[], gpu: string): string | null {
	if (bypassed.length === 0) return null;
	if (bypassed.some((b) => b.reason === 'layer-unsupported'))
		return 'GPU effects need HTML-in-Canvas here (chrome://flags/#canvas-draw-element)';
	if (bypassed.some((b) => b.reason === 'gpu-unavailable'))
		return gpu === 'lost' ? 'GPU effects paused (context lost)' : 'GPU effects unavailable (no WebGL2)';
	return `Effect failed: ${[...new Set(bypassed.map((b) => b.effectId))].join(', ')}`;
}

/**
 * The fx stage of a layer. `opts.canRun = false` declares that this layer cannot draw shader effects here (a DOM
 * layer without HTML-in-Canvas): the preview bypasses them with a chip; a render cancels.
 */
export function useLayerFx(layer: LayerProps, opts: { canRun?: boolean; enabled?: boolean } = {}): LayerFx {
	const doc = useContext(ColorDocContext);
	const gpu = useFxStatus();
	// Null outside a composition (layers rendered standalone, e.g. template thumbnails/tests).
	const config = Internals.useUnsafeVideoConfig();
	const compW = config?.width ?? 0;
	const compH = config?.height ?? 0;
	const { clip, props, fps } = layer;
	const effects = props.effects;
	const box = props.box;
	const colorBypass = doc.isPreview && doc.bypass.has(clip.clipId);
	const canRun = opts.canRun ?? true;
	const enabled = opts.enabled ?? true;
	const failures = fxStatus.version();
	// biome-ignore lint/correctness/useExhaustiveDependencies: `failures` re-plans when a shader fails
	const plan = useMemo(
		() =>
			!enabled
				? null
				: planLayerFx(effects, {
						registry: fxEffectRegistry(),
						gpu: canRun ? gpu : 'unavailable',
						failed: (id) => doc.isPreview && fxStatus.failure(id) !== undefined,
						colorBypass,
						ctx: { width: box.width, height: box.height, pxScale: 1, fps },
					}),
		[enabled, effects, gpu, canRun, colorBypass, box.width, box.height, fps, doc.isPreview, failures],
	);
	if (plan && !doc.isPreview && (!plan.active || plan.bypassed.length > 0))
		cancelRender(
			new Error(
				canRun
					? 'WEBGL_UNAVAILABLE: GPU shader effects need WebGL2 in the render browser'
					: `FX_LAYER_UNSUPPORTED: GPU shader effects on ${clip.kind} layers need HTML-in-Canvas (Chrome ≥ 148)`,
			),
		);

	const layout = useMemo(
		() => (plan?.active ? fxCanvasLayout(box, plan.padding, FX_MAX_CANVAS) : null),
		[plan, box],
	);

	// Colour runs inside the chain: LUT assets (renders wait) and baked LUTs (cached by run key, like the colour stage).
	const lutEffects = useMemo(
		() => plan?.steps.flatMap((s) => (s.kind === 'lut' ? s.effects : [])) ?? [],
		[plan],
	);
	const lutUrls = referencedMedia(lutEffects)
		.map((id) => doc.media[id]?.url)
		.filter((u): u is string => !!u);
	const lutVersion = useLutAssets(lutUrls, doc.isPreview);
	const pending = lutUrls.some((u) => loadedLutAsset(u) === undefined);

	const realFrame = layer.realFrame ?? layer.localFrame;
	const sourceFrame = layer.localFrame;
	const duration = clip.duration;
	const progress = layer.transition?.progress ?? fxClipProgress(realFrame, duration);
	const side = layer.transition ? (layer.transition.side === 'out' ? 1 : 2) : 0;
	const map = layerMapOf(props);

	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the values that change the output
	const stage = useMemo((): FxStage | null => {
		if (!plan?.active || !layout) return null;
		const canvas = { width: layout.width, height: layout.height };
		const lutKey = (id: string) => {
			const u = doc.media[id]?.url;
			return u ? lutUrlKey(u) : `offline:${id}`;
		};
		const lutOf = (id: string) => {
			const u = doc.media[id]?.url;
			return u ? (loadedLutAsset(u) ?? null) : null;
		};
		const samples: number[] = [];
		const media = new Map<string, FxMediaInput>();
		const steps: FxPreparedStep[] = plan.steps.map((s, i): FxPreparedStep => {
			switch (s.kind) {
				case 'gpu': {
					const seed = fxSeed(clip.clipId, s.fx.id, s.fx.params);
					const ctx: FxFrameContext = {
						width: box.width,
						height: box.height,
						pxScale: layout.pxScale,
						fps,
						frame: realFrame,
						duration,
						seed,
						progress,
					};
					const gp = planGpuEffect(s.spec as EffectSpec, { id: s.fx.id, params: s.fx.params }, ctx, canvas);
					const offsets = fxTimeSamples(s.spec as EffectSpec, s.fx.params, {
						frame: realFrame,
						fps,
						duration,
						headHandle: clip.headHandle ?? 0,
						tailHandle: clip.tailHandle ?? 0,
						seed,
					});
					for (const o of offsets) if (!samples.includes(o)) samples.push(o);
					for (const t of gp.textures) {
						const h: MediaHandle | null | undefined = t.mediaId ? doc.media[t.mediaId] : null;
						if (h && (h.kind === 'image' || h.kind === 'video'))
							media.set(t.mediaId, { mediaId: t.mediaId, url: h.url, kind: h.kind });
					}
					return {
						kind: 'gpu',
						key: `${gp.key}|${JSON.stringify(gp.uniforms)}|${seed}`,
						plan: gp,
						seed,
						sampleOffsets: offsets,
					};
				}
				case 'lut': {
					const key = colorRunKey(s.effects, lutKey, PREVIEW_LUT_SIZE);
					const lut = pending
						? null
						: bakedRunLut(clip.clipId, key, s.effects, fxEffectRegistry(), lutOf, PREVIEW_LUT_SIZE);
					return { kind: 'lut', key: `lut${i}:${key}`, lut };
				}
				case 'css':
					return { kind: 'css', key: `css${i}:${s.filter}`, filter: s.filter };
				case 'crop':
					return { kind: 'crop', key: `crop${i}`, insets: s.insets };
				default:
					return { kind: 'flip', key: `flip${i}`, horizontal: s.horizontal };
			}
		});
		const builtins = fxBuiltinUniforms({
			canvas,
			box: layout.box,
			pxScale: layout.pxScale,
			frame: realFrame,
			fps,
			duration,
			transition: layer.transition ?? null,
			layerToComp: map,
			compSize: { width: compW, height: compH },
		});
		const key = [
			`${layout.width}x${layout.height}`,
			`f${realFrame}/${sourceFrame}`,
			progress,
			side,
			map.join(','),
			...steps.map((s) => s.key),
		].join('\u0000');
		return { plan, layout, steps, samples, media: [...media.values()], builtins, key, pending };
	}, [
		plan,
		layout,
		realFrame,
		sourceFrame,
		progress,
		side,
		map.join(','),
		compW,
		compH,
		doc.media,
		pending,
		lutVersion,
		clip.clipId,
		duration,
	]);

	if (!plan) return NONE;
	// A layer that cannot run shader effects at all (DOM layer without HTML-in-Canvas) says so in its chip.
	const bypassed = canRun
		? plan.bypassed
		: plan.bypassed.map((b) => ({ ...b, reason: 'layer-unsupported' as const }));
	const chip = doc.isPreview ? chipText(bypassed, gpu) : null;
	if (!plan.active || !stage) return { mode: 'bypass', chip: chip ?? 'GPU effects unavailable', bypassed };
	return { mode: 'active', stage, cssEffects: plan.cssEffects, chip };
}
