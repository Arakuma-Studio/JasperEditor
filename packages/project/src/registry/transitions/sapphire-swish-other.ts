// Transition family "sapphire-swish-other" (transition framework, wave 3): Sapphire-style motion and "other"
// transitions — S_SwishPan, S_Swish3D (sub-bin Wipes, where Sapphire lists them), S_CardFlip,
// S_FilmBurnTransition, S_FilmRoll, S_FlutterCut, S_HyperPull, S_HyperPush, S_MochaWhip,
// S_ParallaxStripsTransition, S_StripSlideTransition, S_TVChannelChange, S_WhipLash (sub-bin Other).
// Ids `jasper.s.<kebab>`; bin TRANSITION_BINS.sapphire. Entries live in ./sapphire-swish-other/* (family-private
// helpers + GLSL in common.ts); this file only lists them in Effects-panel order.
// Authoring guide: docs/wp-notes/fx-transition-framework.md.
// Import rule (no cycles): values only from ./define.ts, ./glsl.ts, ./shader.ts and ../fx/*; types from
// ../../transitions.ts and ../effects.ts (`import type`).
import type { TransitionSpec } from '../../transitions.ts';
import {
	S_CARD_FLIP,
	S_PARALLAX_STRIPS_TRANSITION,
	S_STRIP_SLIDE_TRANSITION,
} from './sapphire-swish-other/cards.ts';
import { S_FLUTTER_CUT, S_TV_CHANNEL_CHANGE } from './sapphire-swish-other/cuts.ts';
import { S_FILM_BURN_TRANSITION, S_FILM_ROLL } from './sapphire-swish-other/film.ts';
import { S_HYPER_PULL, S_HYPER_PUSH } from './sapphire-swish-other/hyper.ts';
import { S_MOCHA_WHIP, S_SWISH_3D, S_SWISH_PAN, S_WHIP_LASH } from './sapphire-swish-other/swish.ts';

export const SAPPHIRE_SWISH_OTHER_TRANSITIONS: readonly TransitionSpec[] = [
	S_SWISH_PAN,
	S_SWISH_3D,
	S_CARD_FLIP,
	S_FILM_BURN_TRANSITION,
	S_FILM_ROLL,
	S_FLUTTER_CUT,
	S_HYPER_PULL,
	S_HYPER_PUSH,
	S_MOCHA_WHIP,
	S_PARALLAX_STRIPS_TRANSITION,
	S_STRIP_SLIDE_TRANSITION,
	S_TV_CHANNEL_CHANGE,
	S_WHIP_LASH,
];
