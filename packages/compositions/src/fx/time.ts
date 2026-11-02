// Time hooks of the fx framework in the composition: the source-frame remap of a layer (`gpu.time.remap` of
// its enabled shader effects, NESTED in stack order — see `fxSourceFrame`) and the frame dependence of GPU layers.
// `SequenceComposition` applies the remap around the layer: `<Freeze frame>` (media elements decode the remapped
// frame) plus the remapped `localFrame`/`contentTime` (DOM layers draw their content at it); `realFrame` keeps the
// real time for the built-in uniforms. Pure functions of the snapshot and the frame (deterministic under random
// seek). Remap hooks get `paramsAt` (the instance's params at other frames) like every other hook.
import {
	type EffectParams,
	type EffectRegistry,
	effectParamMetric,
	FLICKS_PER_SECOND,
	type FxClipInfo,
	type FxTimeStep,
	fxParamsAtFn,
	fxSeed,
	fxSourceFrame,
	gpuIsTimeDependent,
	type RenderVisualClip,
	type ResolvedEffect,
} from '@jasper/project';
import { fxEffectRegistry } from './registry.ts';

type TimeClip = Pick<
	RenderVisualClip,
	| 'clipId'
	| 'duration'
	| 'headHandle'
	| 'tailHandle'
	| 'effects'
	| 'sourceIn'
	| 'speed'
	| 'name'
	| 'sourceInfo'
	| 'intrinsicBox'
>;

/** The clip context of fx hooks (`FxClipInfo`). */
export function fxClipInfoOf(
	clip: Pick<RenderVisualClip, 'name' | 'sourceIn' | 'speed' | 'duration' | 'sourceInfo'>,
): FxClipInfo {
	const info = clip.sourceInfo;
	return {
		clipName: clip.name,
		itemName: info?.itemName ?? '',
		fileName: info?.fileName ?? '',
		sourceInSeconds: clip.sourceIn / FLICKS_PER_SECOND,
		sourceStartTimecode: info?.startTimecode ?? null,
		speed: clip.speed.rate,
		reverse: !!clip.speed.reverse,
		duration: clip.duration,
	};
}

/** The clip-local source frame to show at `localFrame`, or null when no enabled effect remaps time. */
export function fxRemapFrame(
	clip: Pick<RenderVisualClip, 'clipId' | 'duration' | 'headHandle' | 'tailHandle'> & Partial<TimeClip>,
	effects: readonly ResolvedEffect[],
	localFrame: number,
	fps: number,
	registry: EffectRegistry = fxEffectRegistry(),
): number | null {
	const steps: FxTimeStep[] = [];
	const instances = new Map((clip.effects ?? []).map((e) => [e.id, e]));
	const info =
		clip.name !== undefined && clip.sourceIn !== undefined && clip.speed
			? fxClipInfoOf(clip as TimeClip)
			: undefined;
	for (const fx of effects) {
		if (!fx.enabled) continue;
		const spec = registry.get(fx.effectId, fx.effectVersion);
		if (!spec?.gpu?.time?.remap) continue;
		const inst = instances.get(fx.id);
		steps.push({
			spec,
			params: fx.params,
			seed: fxSeed(clip.clipId, fx.id, fx.params, fx.patternOrigin),
			...(inst && clip.sourceIn !== undefined && clip.speed
				? {
						paramsAt: fxParamsAtFn(
							inst,
							{ duration: clip.duration, sourceIn: clip.sourceIn, speed: clip.speed },
							fps,
							{ frame: localFrame, params: fx.params },
							// spatial-points: effect points sampled with the layer box's metric (as `resolveLayerProps`).
							(name) => effectParamMetric(inst, name, clip.intrinsicBox),
						),
					}
				: {}),
			...(info ? { clip: info } : {}),
		});
	}
	if (steps.length === 0) return null;
	return fxSourceFrame(steps, {
		frame: localFrame,
		fps,
		duration: clip.duration,
		headHandle: clip.headHandle ?? 0,
		tailHandle: clip.tailHandle ?? 0,
	});
}

/** The (unevaluated) value of an instance param, for media references. */
const heldParams = (fx: RenderVisualClip['effects'][number]): EffectParams =>
	Object.fromEntries(Object.entries(fx.params).map(([k, a]) => [k, a.value])) as EffectParams;

/**
 * The clip has an enabled shader effect whose output changes over time (the layer re-renders every frame): not
 * `timeInvariant`, time hooks, or a `media` param bound to a video (`mediaKind` resolves the bound media; without
 * it any bound media param that accepts videos counts).
 */
export function hasTimeDependentFx(
	clip: Pick<RenderVisualClip, 'effects'>,
	registry: EffectRegistry = fxEffectRegistry(),
	mediaKind?: (mediaId: string) => string | null | undefined,
): boolean {
	return clip.effects.some((fx) => {
		if (!fx.enabled) return false;
		const spec = registry.get(fx.effectId, fx.effectVersion);
		return !!spec && gpuIsTimeDependent(spec, heldParams(fx), mediaKind, fx);
	});
}
