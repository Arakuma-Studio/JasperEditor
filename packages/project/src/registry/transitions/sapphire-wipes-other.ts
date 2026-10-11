// Transition family "sapphire-wipes-other": the Sapphire-style wipes (S_Wipe*).
// Ids `jasper.s.<kebab>`; bin TRANSITION_BINS.sapphire, sub-bin SAPPHIRE_TRANSITION_SUBBINS.wipes. (The swish /
// other Sapphire transitions live in their own family file.)
// Entries are built with `sapphireWipe` (./sapphire-wipes/common.ts, on top
// of `defineShaderTransition`), the family-private helpers live in ./sapphire-wipes/. Authoring guide:
// docs/wp-notes/fx-transition-framework.md.
// Import rule (no cycles): values only from ./define.ts, ./glsl.ts, ./shader.ts, ../fx/* and the family-private
// ./sapphire-wipes/*; types from ../../transitions.ts and ../effects.ts (`import type`).
import type { TransitionSpec } from '../../transitions.ts';
import { SAPPHIRE_PATTERN_WIPES } from './sapphire-wipes/patterns.ts';
import { SAPPHIRE_SHAPE_WIPES } from './sapphire-wipes/shapes.ts';
import { SAPPHIRE_TEXTURE_WIPES } from './sapphire-wipes/textures.ts';
import { SAPPHIRE_BAND_WIPES } from './sapphire-wipes/warps.ts';

/** Every Sapphire wipe, in Sapphire's (alphabetical) order. */
export const SAPPHIRE_WIPE_TRANSITIONS: readonly TransitionSpec[] = [
	...SAPPHIRE_SHAPE_WIPES,
	...SAPPHIRE_PATTERN_WIPES,
	...SAPPHIRE_TEXTURE_WIPES,
	...SAPPHIRE_BAND_WIPES,
].sort((a, b) => a.label.localeCompare(b.label));

export const SAPPHIRE_WIPES_OTHER_TRANSITIONS: readonly TransitionSpec[] = SAPPHIRE_WIPE_TRANSITIONS;
