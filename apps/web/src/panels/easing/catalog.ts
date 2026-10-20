// Easing panel ▸ the read-only built-in curve catalogue and preset matching. The catalogue itself belongs to the
// document model (packages/project ease presets); until it is part of this build the Library shows the user's own
// groups only. `matchPreset` finds the preset whose curve equals the current one (the highlighted thumbnail).
import type { EaseCurve, EasePreset } from '@jasper/project';
import { curvesEqual } from './curve-edit.ts';

export type EaseGroup = { id: string; name: string };

export type EaseCatalog = {
	groups: readonly EaseGroup[];
	presets: readonly EasePreset[];
	/** The preset among `presets` whose curve matches `curve` within `tol`, else null. */
	match(curve: EaseCurve, presets: readonly EasePreset[], tol?: number): EasePreset | null;
};

export function matchPreset(curve: EaseCurve, presets: readonly EasePreset[], tol = 1e-3): EasePreset | null {
	return presets.find((p) => curvesEqual(p.curve, curve, tol)) ?? null;
}

export const BUILTIN_CATALOG: EaseCatalog = { groups: [], presets: [], match: matchPreset };
