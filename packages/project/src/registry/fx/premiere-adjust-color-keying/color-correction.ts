// Premiere Pro "Color Correction" video effects (fx family premiere-adjust-color-keying).
import type { EffectSpec } from '../../effects.ts';
import { EQUALIZE } from './analysis.ts';

export const COLOR_CORRECTION_EFFECTS: readonly EffectSpec[] = [EQUALIZE];
