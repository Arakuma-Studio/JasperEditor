// audio-fx DSP family file (filled by the family port); the catalogue entries are in
// packages/project/src/registry/audio/reverb.ts.
import type { ProcessorFactory } from '../core/effect.ts';

export const REVERB_PROCESSORS: Readonly<Record<string, ProcessorFactory>> = {};
