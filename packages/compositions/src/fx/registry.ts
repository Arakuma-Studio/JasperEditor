// The effect registry the fx framework's composition code resolves shader effects with. Default: the
// built-in registry (which contains the fx catalogue). `setFxEffectRegistry` replaces it for the whole page — used by
// tests and by render bundles that add effects outside the catalogue (e.g. the shader-effect render test's entry).
import { defaultEffectRegistry, type EffectRegistry } from '@jasper/project';

let current: EffectRegistry = defaultEffectRegistry;

export function fxEffectRegistry(): EffectRegistry {
	return current;
}

export function setFxEffectRegistry(registry: EffectRegistry | null): void {
	current = registry ?? defaultEffectRegistry;
}
