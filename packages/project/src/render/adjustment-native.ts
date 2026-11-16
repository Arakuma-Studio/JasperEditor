// What the native export draws on an adjustment layer (engine export/blend/adjust.ts): its geometric effects run as the
// preview's GL chain on the composite below (one pass each), then crops, flips and colour runs through the adjustment
// chain. Shared by the engine's planner and the automation passes' export cost estimate. Pure.
import { defaultEffectRegistry, type EffectRegistry } from '../registry/effects.ts';

/** Geometric effects the native export's adjustment kernel runs (S_Shake without motion blur). */
export const ADJUSTMENT_KERNEL_EFFECTS: ReadonlySet<string> = new Set([
	'jasper.transform',
	'jasper.s.shake',
	'jasper.mirror',
	'jasper.replicate',
	'jasper.offset',
	'jasper.directional-blur',
]);

const AFTER_KERNEL: ReadonlySet<string> = new Set([
	'jasper.crop',
	'jasper.flip-horizontal',
	'jasper.flip-vertical',
]);

/**
 * The effects of an adjustment layer (stack order: `effectId`, its params and keyed values) that the native export cannot
 * draw: anything but geometric effects first, then crops, flips and colour effects; S_Shake with motion blur.
 */
export function adjustmentRemoteEffects(
	effects: readonly {
		effectId: string;
		params?: Record<string, unknown>;
		keyframes?: Record<string, unknown>;
	}[],
	registry: EffectRegistry = defaultEffectRegistry,
): string[] {
	const out: string[] = [];
	let lastKernel = -1;
	effects.forEach((fx, i) => {
		if (ADJUSTMENT_KERNEL_EFFECTS.has(fx.effectId)) lastKernel = i;
	});
	effects.forEach((fx, i) => {
		if (ADJUSTMENT_KERNEL_EFFECTS.has(fx.effectId)) {
			const keyed = fx.keyframes?.motionBlur;
			const values = [fx.params?.motionBlur, ...(Array.isArray(keyed) ? keyed.map((k) => k?.value) : [])];
			if (fx.effectId === 'jasper.s.shake' && values.some((v) => v === true)) out.push(fx.effectId);
			return;
		}
		const after = AFTER_KERNEL.has(fx.effectId) || !!registry.get(fx.effectId, 1)?.color;
		if (!after || i < lastKernel) out.push(fx.effectId);
	});
	return [...new Set(out)];
}
