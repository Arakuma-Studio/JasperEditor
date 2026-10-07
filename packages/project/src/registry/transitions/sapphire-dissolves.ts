// Transition family "sapphire-dissolves" (transition framework, wave 3): Sapphire-style dissolves (S_Dissolve*).
// Ids `jasper.s.<kebab>`; bin TRANSITION_BINS.sapphire, sub-bin SAPPHIRE_TRANSITION_SUBBINS.dissolves.
// Family-private modules live in ./sapphire-dissolves/. Authoring guide: docs/wp-notes/fx-transition-framework.md.
// Import rule (no cycles): values only from ./define.ts, ./glsl.ts, ./shader.ts, ../fx/* and the family-private
// modules; types from ../../transitions.ts and ../effects.ts (`import type`).
//
// Every entry is built with `defineDissolve` (./sapphire-dissolves/common.ts): the shared Sapphire timing (Dissolve
// Speed, Slow In / Slow Out, Shift Peak, Mix with Dissolve; the effect peaks mid-transition on both sides while A
// cross-fades to B), Sapphire units and Wrap modes. Parameters and defaults follow Boris FX's public Sapphire
// documentation; all code is a clean-room implementation.
import type { TransitionSpec } from '../../transitions.ts';
import { BLUR_DISSOLVES } from './sapphire-dissolves/blur.ts';
import { GLITCH_DISSOLVES } from './sapphire-dissolves/glitch.ts';
import { GLOW_DISSOLVES } from './sapphire-dissolves/glow.ts';
import { LIGHT_DISSOLVES } from './sapphire-dissolves/light.ts';
import { PAINT_DISSOLVES } from './sapphire-dissolves/paint.ts';
import { PATTERN_DISSOLVES } from './sapphire-dissolves/patterns.ts';
import { RAYS_DISSOLVES } from './sapphire-dissolves/rays.ts';
import { WARP_DISSOLVES } from './sapphire-dissolves/warps.ts';

export { S_DISSOLVE_LUMA } from './sapphire-dissolves/patterns.ts';

/** In Effects-panel order (alphabetical, as Sapphire lists them). */
export const SAPPHIRE_DISSOLVE_TRANSITIONS: readonly TransitionSpec[] = [
	...PATTERN_DISSOLVES,
	...BLUR_DISSOLVES,
	...WARP_DISSOLVES,
	...GLOW_DISSOLVES,
	...LIGHT_DISSOLVES,
	...RAYS_DISSOLVES,
	...GLITCH_DISSOLVES,
	...PAINT_DISSOLVES,
].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
