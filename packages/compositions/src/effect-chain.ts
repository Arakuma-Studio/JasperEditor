import type { EffectDefinitionAndStack, EffectDescriptor } from 'remotion';

export function memoizeEffects(effects: readonly EffectDescriptor[]): EffectDefinitionAndStack[] {
	return effects.map((effect) => ({ ...effect, memoized: true }));
}
