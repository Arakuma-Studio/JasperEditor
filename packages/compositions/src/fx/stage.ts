// The fx stage of a layer at the current frame (wave-1 fx framework): the stack plan (fx/plan.ts), the canvas
// layout (box + padding), one `FxEffectPlan` per shader effect (registry/fx/shader.ts `planGpuEffect`), baked LUTs
// for colour runs, time samples, media inputs and the built-in uniforms — everything `FxPicture` (media layers) and
// `FxDomPicture` (DOM layers) need to build the canvas effect chain. Renders that need the GPU and cannot have it
// fail with WEBGL_UNAVAILABLE (never silently unprocessed, as S06:CG-042 for grades).
// Follow-ups: every hook gets `paramsAt` (the instance's params at other frames, from the clip's keyframes) and
// `clip` (names, source in-point/timecode); time samples and remaps of the whole stack compose (`fxStackTime`):
// `samples` are absolute clip-local source frames; LUT media params are bound as 3D textures; the preview may draw
// the canvases at a reduced resolution (`RenderOptions.fxPreviewScale`).
import {
	colorRunKey,
	type EffectSpec,
	FX_MAX_CANVAS,
	type FxClipInfo,
	type FxEffectPlan,
	type FxFrameContext,
	type FxParamsAt,
	type FxStepTime,
	type FxTimeStep,
	type FxUniform,
	fxBuiltinUniforms,
	fxClipProgress,
	fxParamsAtFn,
	fxSeed,
	fxStackTime,
	isLutMediaParam,
	type Lut,
	layerMapOf,
	type MediaHandle,
	PREVIEW_LUT_SIZE,
	planGpuEffect,
	type ResolvedEffect,
	sideCompToCanvas,
} from '@jasper/project';
import { useContext, useMemo } from 'react';
import { cancelRender, Internals } from 'remotion';
import { ColorDocContext, referencedMedia, useLutAssets } from '../color/chain.ts';
import { NestCompSizeContext } from '../layers/nest-context.ts';
import { bakedRunLut, loadedLutAsset, lutUrlKey } from '../color/luts.ts';
import type { LayerProps, TransitionTap } from '../types.ts';
import { type FxBypass, type FxCanvasLayout, fxCanvasLayout, type LayerFxPlan, planLayerFx } from './plan.ts';
import { fxEffectRegistry } from './registry.ts';
import { fxStatus, useFxStatus } from './status.ts';
import { fxClipInfoOf } from './time.ts';

export type FxLayout = FxCanvasLayout;

export type FxPreparedStep =
	| {
			kind: 'gpu';
			key: string;
			plan: FxEffectPlan;
			seed: number;
			/** Requested offsets (`u_sampleOffsets`), request order. */
			sampleOffsets: number[];
			/** Source frame of each sample (absolute clip-local frame; null = transparent). */
			sampleFrames: (number | null)[];
			/** `u_sampleValid`. */
			sampleValid: number;
	  }
	| { kind: 'lut'; key: string; lut: Lut | null }
	| { kind: 'css'; key: string; filter: string }
	| { kind: 'crop'; key: string; insets: [number, number, number, number] }
	| { kind: 'flip'; key: string; horizontal: boolean }
	/** Transition framework: hand the picture to the GPU transition stage (always the last step). */
	| {
			kind: 'tap';
			key: string;
			tap: TransitionTap;
			meta: { compToCanvas: readonly number[] | null; opacity: number };
	  }
	/** edit-structure (adjustment layers): keep a copy of the picture before the effects (`holder`). */
	| { kind: 'stash'; key: string; holder: AdjustmentHolder }
	/**
	 * edit-structure (adjustment layers): the adjusted picture over the stashed original, with opacity, blend mode
	 * and the crop region (canvas px) the effects are limited to (Premiere: cropping an adjustment layer limits it).
	 */
	| {
			kind: 'mix';
			key: string;
			holder: AdjustmentHolder;
			opacity: number;
			blend: GlobalCompositeOperation;
			/** Crop insets (left, top, right, bottom) as fractions of the layer box; null = the whole box. */
			insets: readonly [number, number, number, number] | null;
	  };

/** The original picture of an adjustment scope, kept by its `stash` step for its `mix` step. */
export type AdjustmentHolder = { canvas: HTMLCanvasElement | null };

/** A media param input of the layer's shader effects (`lut`: a .cube asset bound as a 3D texture). */
export type FxMediaInput = { mediaId: string; url: string; kind: 'image' | 'video' | 'lut' };

export type FxStage = {
	plan: LayerFxPlan;
	layout: FxLayout;
	steps: FxPreparedStep[];
	/**
	 * Union of the time-sample SOURCE FRAMES (absolute clip-local frames, in the drawn span) of every shader effect:
	 * the extra source pictures to fetch (slots `sample@<frame>`).
	 */
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
export function useLayerFx(
	layer: LayerProps,
	opts: {
		canRun?: boolean;
		enabled?: boolean;
		/** The effects to plan (default: the layer's); e.g. none for a picture that already has them baked. */
		effects?: readonly ResolvedEffect[];
		/**
		 * edit-structure: run the whole stack in the canvas chain even without shader effects (colour runs, CSS filters,
		 * crop, flips) — nest pictures with colour effects and adjustment scopes.
		 */
		chain?: boolean;
		/** edit-structure: steps appended after the stack (adjustment scope stash/mix), prepended when `first`. */
		extraSteps?: { first: FxPreparedStep[]; last: FxPreparedStep[] };
	} = {},
): LayerFx {
	const doc = useContext(ColorDocContext);
	const gpu = useFxStatus();
	// Null outside a composition (layers rendered standalone, e.g. template thumbnails/tests).
	const config = Internals.useUnsafeVideoConfig();
	// edit-structure: inside a nested sequence the "composition" is the nested frame.
	const nestComp = useContext(NestCompSizeContext);
	const compW = nestComp?.width ?? config?.width ?? 0;
	const compH = nestComp?.height ?? config?.height ?? 0;
	const { clip, props, fps } = layer;
	const effects = opts.effects ?? props.effects;
	const box = props.box;
	// Transition framework: a side of a GPU transition captures its picture for the stage.
	const tap = layer.transition?.tap ?? null;
	const capture = !!tap || !!opts.chain;
	const colorBypass = doc.isPreview && doc.bypass.has(clip.clipId);
	const canRun = opts.canRun ?? true;
	const enabled = opts.enabled ?? true;
	const failures = fxStatus.version();
	const realFrame = layer.realFrame ?? layer.localFrame;
	const sourceFrame = layer.localFrame;
	const duration = clip.duration;
	// Params at other frames (sub-frame shutters, write-on paths, …) from the clip's keyframes, per effect instance.
	const paramsAtOf = useMemo(() => {
		const cache = new Map<string, FxParamsAt>();
		const byId = new Map(clip.effects.map((e) => [e.id, e]));
		return (fx: ResolvedEffect): FxParamsAt | undefined => {
			const hit = cache.get(fx.id);
			if (hit) return hit;
			const inst = byId.get(fx.id);
			if (!inst) return undefined;
			const f = fxParamsAtFn(inst, clip, fps, { frame: realFrame, params: fx.params });
			cache.set(fx.id, f);
			return f;
		};
	}, [clip, fps, realFrame]);
	const clipInfo = useMemo((): FxClipInfo => fxClipInfoOf(clip), [clip]);
	const mediaKind = useMemo(() => (id: string) => doc.media[id]?.kind, [doc.media]);
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
						ctx: { width: box.width, height: box.height, pxScale: 1, fps, frame: realFrame },
						paramsAt: paramsAtOf,
						mediaKind,
						clip: clipInfo,
						capture,
					}),
		[
			enabled,
			effects,
			gpu,
			canRun,
			colorBypass,
			box.width,
			box.height,
			fps,
			doc.isPreview,
			failures,
			capture,
			paramsAtOf,
			mediaKind,
			clipInfo,
		],
	);
	if (plan && !doc.isPreview && (!plan.active || plan.bypassed.length > 0))
		cancelRender(
			new Error(
				canRun
					? 'WEBGL_UNAVAILABLE: GPU shader effects need WebGL2 in the render browser'
					: `FX_LAYER_UNSUPPORTED: GPU shader effects on ${clip.kind} layers need HTML-in-Canvas (Chrome ≥ 148)`,
			),
		);

	// Reduced preview resolution (Program monitor 1/2, 1/4…): the canvas is drawn smaller, px params follow pxScale.
	const previewScale = doc.isPreview ? (layer.options.fxPreviewScale ?? 1) : 1;
	const layout = useMemo(
		() => (plan?.active ? fxCanvasLayout(box, plan.padding, FX_MAX_CANVAS, previewScale) : null),
		[plan, box, previewScale],
	);

	// Colour runs inside the chain: LUT assets (renders wait) and baked LUTs (cached by run key, like the colour stage).
	const lutEffects = useMemo(
		() => plan?.steps.flatMap((s) => (s.kind === 'lut' ? s.effects : [])) ?? [],
		[plan],
	);
	// `lut` media params of shader effects (3D textures): their .cube assets load the same way.
	const fxLutIds = useMemo(
		() =>
			plan?.steps.flatMap((s) =>
				s.kind === 'gpu'
					? s.spec.params
							.filter((ps) => isLutMediaParam(ps))
							.map((ps) => (s.fx.params[ps.name] as { mediaId?: unknown } | undefined)?.mediaId)
							.filter((id): id is string => typeof id === 'string' && !!id)
					: [],
			) ?? [],
		[plan],
	);
	const lutUrls = [...referencedMedia(lutEffects), ...fxLutIds]
		.map((id) => doc.media[id]?.url)
		.filter((u): u is string => !!u);
	const lutVersion = useLutAssets(lutUrls, doc.isPreview);
	const pending = lutUrls.some((u) => loadedLutAsset(u) === undefined);

	const progress = layer.transition?.progress ?? fxClipProgress(realFrame, duration);
	const side = layer.transition ? (layer.transition.side === 'out' ? 1 : 2) : 0;
	const map = layerMapOf(props);

	// Time of the whole stack: every enabled effect with time hooks, in stack order (samples compose with remaps).
	const stackTime = useMemo(() => {
		const registry = fxEffectRegistry();
		const steps: (FxTimeStep & { id: string })[] = [];
		for (const fx of props.effects) {
			if (!fx.enabled) continue;
			const spec = registry.get(fx.effectId, fx.effectVersion);
			if (!spec?.gpu?.time?.remap && !spec?.gpu?.time?.samples) continue;
			const paramsAt = paramsAtOf(fx);
			steps.push({
				id: fx.id,
				spec,
				params: fx.params,
				seed: fxSeed(clip.clipId, fx.id, fx.params),
				clip: clipInfo,
				...(paramsAt ? { paramsAt } : {}),
			});
		}
		if (steps.length === 0) return new Map<string, FxStepTime>();
		const r = fxStackTime(steps, {
			frame: realFrame,
			fps,
			duration,
			headHandle: clip.headHandle ?? 0,
			tailHandle: clip.tailHandle ?? 0,
		});
		return new Map(steps.map((s, i) => [s.id, r.steps[i]!]));
	}, [props.effects, paramsAtOf, clipInfo, clip, realFrame, fps, duration]);

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
					const paramsAt = paramsAtOf(s.fx);
					const ctx: FxFrameContext = {
						width: box.width,
						height: box.height,
						pxScale: layout.pxScale,
						fps,
						frame: realFrame,
						duration,
						seed,
						progress,
						clip: clipInfo,
						...(paramsAt ? { paramsAt } : {}),
					};
					const gp = planGpuEffect(s.spec as EffectSpec, { id: s.fx.id, params: s.fx.params }, ctx, canvas);
					const st = stackTime.get(s.fx.id);
					const offsets = st?.offsets ?? [];
					const frames = st?.frames ?? [];
					for (const f of frames) if (f !== null && !samples.includes(f)) samples.push(f);
					for (const t of gp.textures) {
						const h: MediaHandle | null | undefined = t.mediaId ? doc.media[t.mediaId] : null;
						if (!h) continue;
						if (t.kind === 'lut') {
							if (h.kind === 'lut') media.set(t.mediaId, { mediaId: t.mediaId, url: h.url, kind: 'lut' });
						} else if (h.kind === 'image' || h.kind === 'video')
							media.set(t.mediaId, { mediaId: t.mediaId, url: h.url, kind: h.kind });
					}
					return {
						kind: 'gpu',
						key: `${gp.key}|${JSON.stringify(gp.uniforms)}|${seed}|${frames.join(',')}/${st?.valid ?? 0}`,
						plan: gp,
						seed,
						sampleOffsets: offsets,
						sampleFrames: frames,
						sampleValid: st?.valid ?? 0,
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
		if (opts.extraSteps) {
			steps.unshift(...opts.extraSteps.first);
			steps.push(...opts.extraSteps.last);
		}
		if (tap) {
			const opacity = Math.min(1, Math.max(0, props.opacity / 100));
			const compToCanvas = sideCompToCanvas(map, layout);
			steps.push({
				kind: 'tap',
				key: `tap:${tap.side}:${opacity}:${compToCanvas?.join(',') ?? 'none'}`,
				tap,
				meta: { compToCanvas, opacity },
			});
		}
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
		tap,
		props.opacity,
		stackTime,
		paramsAtOf,
		clipInfo,
		opts.extraSteps,
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
