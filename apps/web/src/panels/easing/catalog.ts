// Easing panel ▸ the read-only built-in curve catalogue (packages/project/src/ease/presets.ts: fitted on first use,
// cached) and preset matching (`matchEasePreset`: the preset within tolerance of the current curve, so the Library
// highlights it). Components take the catalogue as a prop so tests can give their own.
import {
	BUILTIN_EASE_GROUPS,
	builtinEasePresets,
	type EaseCurve,
	type EasePreset,
	matchEasePreset,
} from '@jasper/project';

export type EaseGroup = { readonly id: string; readonly name: string };

export type EaseCatalog = {
	readonly groups: readonly EaseGroup[];
	readonly presets: readonly EasePreset[];
	/** The preset among `presets` whose curve matches `curve` within `tol`, else null. */
	match(curve: EaseCurve, presets: readonly EasePreset[], tol?: number): EasePreset | null;
};

export const BUILTIN_CATALOG: EaseCatalog = {
	groups: BUILTIN_EASE_GROUPS,
	get presets() {
		return builtinEasePresets();
	},
	match: (curve, presets, tol) => matchEasePreset(curve, presets, tol),
};
