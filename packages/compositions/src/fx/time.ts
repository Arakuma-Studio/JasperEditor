// Time hooks of the fx framework in the composition (wave 1): the source-frame remap of a layer (`gpu.time.remap` of
// its enabled shader effects, composed in stack order) and the frame dependence of GPU layers. `SequenceComposition`
// applies the remap around the layer: `<Freeze frame>` (media elements decode the remapped frame) plus the remapped
// `localFrame`/`contentTime` (DOM layers draw their content at it); `realFrame` keeps the real time for the
// built-in uniforms. Pure functions of the snapshot and the frame (deterministic under random seek).
import {
	type EffectRegistry,
	fxSeed,
	fxSourceFrame,
	gpuIsTimeDependent,
	type RenderVisualClip,
	type ResolvedEffect,
} from '@jasper/project';
import { fxEffectRegistry } from './registry.ts';

/** The clip-local source frame to show at `localFrame`, or null when no enabled effect remaps time. */
export function fxRemapFrame(
	clip: Pick<RenderVisualClip, 'clipId' | 'duration' | 'headHandle' | 'tailHandle'>,
	effects: readonly ResolvedEffect[],
	localFrame: number,
	fps: number,
	registry: EffectRegistry = fxEffectRegistry(),
): number | null {
	const steps = [];
	for (const fx of effects) {
		if (!fx.enabled) continue;
		const spec = registry.get(fx.effectId, fx.effectVersion);
		if (!spec?.gpu?.time?.remap) continue;
		steps.push({ spec, params: fx.params, seed: fxSeed(clip.clipId, fx.id, fx.params) });
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

/** The clip has an enabled shader effect whose output changes over time (the layer re-renders every frame). */
export function hasTimeDependentFx(
	clip: Pick<RenderVisualClip, 'effects'>,
	registry: EffectRegistry = fxEffectRegistry(),
): boolean {
	return clip.effects.some((fx) => {
		if (!fx.enabled) return false;
		const spec = registry.get(fx.effectId, fx.effectVersion);
		return !!spec && gpuIsTimeDependent(spec);
	});
}
