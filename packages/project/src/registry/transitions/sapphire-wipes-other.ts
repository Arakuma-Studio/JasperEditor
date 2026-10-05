// Transition family "sapphire-wipes-other" (transition framework, wave 3): Sapphire-style wipes and the other
// transitions (S_Wipe*, S_SwishPan, S_Swish3D, S_CardFlip, S_FilmBurnTransition, S_FilmRoll, S_FlutterCut,
// S_HyperPull, S_HyperPush, S_MochaWhip, S_ParallaxStripsTransition, S_StripSlideTransition, S_TVChannelChange,
// S_WhipLash). Ids `jasper.s.<kebab>`; bin TRANSITION_BINS.sapphire, sub-bins SAPPHIRE_TRANSITION_SUBBINS.wipes /
// .other.
// Owner: the wave-3 agent of this family; this is the ONLY file it edits (plus its tests). Entries are built with
// `defineShaderTransition` (./define.ts). Authoring guide: docs/wp-notes/fx-transition-framework.md.
// Import rule (no cycles): values only from ./define.ts, ./glsl.ts, ./shader.ts and ../fx/*; types from
// ../../transitions.ts and ../effects.ts (`import type`).
import type { TransitionSpec } from '../../transitions.ts';

export const SAPPHIRE_WIPES_OTHER_TRANSITIONS: readonly TransitionSpec[] = [];
