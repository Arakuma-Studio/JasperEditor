// Effect family "premiere-adjust-color-keying": Premiere Pro's standard video effects of the
// Adjust, Blur & Sharpen, Channel, Color Correction, Image Control, Keying, Perspective, Transform and Utility bins,
// as GPU shader effects (ids `jasper.<kebab>`, Effects-panel folder = the category; no bin). One module per bin lives
// in ./premiere-adjust-color-keying/; this file concatenates them in Effects-panel order. Effects that already exist
// in the registry (Crop, Gaussian Blur, Brightness & Contrast, Hue/Saturation, Black & White, flips, Corner Pin,
// Lumetri Color) are not duplicated. Authoring guide: docs/wp-notes/fx-shader-framework.md.
import type { EffectSpec } from '../effects.ts';
import { ADJUST_EFFECTS } from './premiere-adjust-color-keying/adjust.ts';
import { BLUR_SHARPEN_EFFECTS } from './premiere-adjust-color-keying/blur-sharpen.ts';
import { CHANNEL_EFFECTS } from './premiere-adjust-color-keying/channel.ts';
import { COLOR_CORRECTION_EFFECTS } from './premiere-adjust-color-keying/color-correction.ts';
import { IMAGE_CONTROL_EFFECTS } from './premiere-adjust-color-keying/image-control.ts';
import { KEYING_EFFECTS } from './premiere-adjust-color-keying/keying.ts';
import { PERSPECTIVE_EFFECTS } from './premiere-adjust-color-keying/perspective.ts';
import { TRANSFORM_EFFECTS } from './premiere-adjust-color-keying/transform.ts';
import { UTILITY_EFFECTS } from './premiere-adjust-color-keying/utility.ts';

export const PREMIERE_ADJUST_COLOR_KEYING_EFFECTS: readonly EffectSpec[] = [
	...ADJUST_EFFECTS,
	...BLUR_SHARPEN_EFFECTS,
	...CHANNEL_EFFECTS,
	...COLOR_CORRECTION_EFFECTS,
	...IMAGE_CONTROL_EFFECTS,
	...KEYING_EFFECTS,
	...PERSPECTIVE_EFFECTS,
	...TRANSFORM_EFFECTS,
	...UTILITY_EFFECTS,
];
