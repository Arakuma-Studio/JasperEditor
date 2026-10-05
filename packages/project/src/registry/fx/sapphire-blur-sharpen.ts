// Effect family "sapphire-blur-sharpen" (fx catalogue, wave 2): Sapphire-style blurs, defocus/bokeh, motion blurs,
// convolution, edge-aware smoothing and sharpening. Entries are built with `defineShaderEffect`; ids start with
// `jasper.s.`; Effects-panel bin: SAPPHIRE_BINS.blurSharpen. The implementations live in the family-private folder
// `./sapphire-blur-sharpen/` (shared core: common.ts — units, edge modes, separable blurs, pass graph).
// Authoring guide: docs/wp-notes/fx-shader-framework.md.
import type { EffectSpec } from '../effects.ts';
import { SBS_BLURS } from './sapphire-blur-sharpen/blurs.ts';
import { SBS_DEFOCUS } from './sapphire-blur-sharpen/defocus.ts';
import { SBS_DETAIL } from './sapphire-blur-sharpen/detail.ts';
import { SBS_MOTION } from './sapphire-blur-sharpen/motion.ts';
import { SBS_SMOOTH } from './sapphire-blur-sharpen/smooth.ts';

const byLabel = (a: EffectSpec, b: EffectSpec) => a.label.localeCompare(b.label);

export const SAPPHIRE_BLUR_SHARPEN_EFFECTS: readonly EffectSpec[] = [...SBS_BLURS, ...SBS_DEFOCUS, ...SBS_DETAIL, ...SBS_SMOOTH, ...SBS_MOTION].sort(byLabel);
