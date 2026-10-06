// audio-fx DSP family file (filled by the family port); the catalogue entries are in
// packages/project/src/registry/audio/special.ts.
import type { ProcessorFactory } from '../core/effect.ts';

export const SPECIAL_PROCESSORS: Readonly<Record<string, ProcessorFactory>> = {};
