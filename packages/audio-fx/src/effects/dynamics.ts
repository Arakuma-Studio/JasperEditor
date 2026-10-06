// audio-fx DSP family file (filled by the family port); the catalogue entries are in
// packages/project/src/registry/audio/dynamics.ts.
import type { ProcessorFactory } from '../core/effect.ts';

export const DYNAMICS_PROCESSORS: Readonly<Record<string, ProcessorFactory>> = {};
