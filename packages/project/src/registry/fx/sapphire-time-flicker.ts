// Effect family "sapphire-time-flicker": Sapphire-style Time effects (freeze, get frame,
// jitter, random/reverse edits, retime, reverse, cut-to-dissolve, repair frames, trails, feedback, time average/
// displace/slice, RGB time warp, motion detect, nearest colour, field remove) and the Flicker tools (add, match,
// remove; luma/colour; rectangle/matte), all in Video Effects ▸ Sapphire Time.
// Determinism (S11 §2): remaps and sample offsets are pure functions of params + frame; recursive effects (trails,
// feedback) are unrolled over time samples within one frame; flicker measurements are in-shader reductions of the
// current frame. Implementation: ./sapphire-time-flicker/*; authoring guide: docs/wp-notes/fx-shader-framework.md.
import type { EffectSpec } from '../effects.ts';
import {
	S_FEEDBACK,
	S_FEEDBACK_BUBBLE,
	S_FEEDBACK_DISTORT,
	S_TRAILS,
	S_TRAILS_DIFFUSE,
} from './sapphire-time-flicker/feedback.ts';
import {
	S_FLICKER,
	S_FLICKER_MATCH,
	S_FLICKER_MATCH_COLOR,
	S_FLICKER_MATCH_MATTE,
	S_FLICKER_MCH_MATTE_COLOR,
	S_FLICKER_REMOVE,
	S_FLICKER_REMOVE_COLOR,
	S_FLICKER_REMOVE_MATTE,
	S_FLICKER_RM_MATTE_COLOR,
} from './sapphire-time-flicker/flicker-effects.ts';
import {
	S_FREEZE_FRAME,
	S_GET_FRAME,
	S_JITTER_FRAMES,
	S_RANDOM_EDITS,
	S_RETIME,
	S_REVERSE_CLIP,
	S_REVERSE_EDITS,
} from './sapphire-time-flicker/remap-effects.ts';
import {
	S_CUT_TO_DISSOLVE,
	S_FIELD_REMOVE,
	S_MOTION_DETECT,
	S_NEAREST_COLOR,
	S_REPAIR_FRAMES,
	S_TIME_AVERAGE,
	S_TIME_DISPLACE,
	S_TIME_SLICE,
	S_TIME_WARP_RGB,
} from './sapphire-time-flicker/sample-effects.ts';

/** In Sapphire's menu order (Time effects, then Flicker tools). */
export const SAPPHIRE_TIME_FLICKER_EFFECTS: readonly EffectSpec[] = [
	S_CUT_TO_DISSOLVE,
	S_FEEDBACK,
	S_FEEDBACK_BUBBLE,
	S_FEEDBACK_DISTORT,
	S_FIELD_REMOVE,
	S_FREEZE_FRAME,
	S_GET_FRAME,
	S_JITTER_FRAMES,
	S_MOTION_DETECT,
	S_NEAREST_COLOR,
	S_RANDOM_EDITS,
	S_REPAIR_FRAMES,
	S_RETIME,
	S_REVERSE_CLIP,
	S_REVERSE_EDITS,
	S_TIME_AVERAGE,
	S_TIME_DISPLACE,
	S_TIME_SLICE,
	S_TIME_WARP_RGB,
	S_TRAILS,
	S_TRAILS_DIFFUSE,
	S_FLICKER,
	S_FLICKER_MATCH,
	S_FLICKER_MATCH_COLOR,
	S_FLICKER_MATCH_MATTE,
	S_FLICKER_MCH_MATTE_COLOR,
	S_FLICKER_REMOVE,
	S_FLICKER_REMOVE_COLOR,
	S_FLICKER_REMOVE_MATTE,
	S_FLICKER_RM_MATTE_COLOR,
];
