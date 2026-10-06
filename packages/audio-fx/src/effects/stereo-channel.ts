// audio-fx DSP family file (filled by the family port); the catalogue entries are in
// packages/project/src/registry/audio/stereo-channel.ts.
import type { ProcessorFactory } from '../core/effect.ts';

export const STEREO_CHANNEL_PROCESSORS: Readonly<Record<string, ProcessorFactory>> = {};
