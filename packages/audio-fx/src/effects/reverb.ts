// "Reverb" DSP (catalogue: packages/project/src/registry/audio/reverb.ts).
import type { ProcessorFactory } from '../core/effect.ts';
import { ConvolutionReverb } from './reverb/convolution.ts';
import { StudioReverb } from './reverb/fdn.ts';
import { SurroundReverb } from './reverb/surround.ts';

export const REVERB_PROCESSORS: Readonly<Record<string, ProcessorFactory>> = {
	'jasper.audio.convolution-reverb': (sr, ch) => new ConvolutionReverb(sr, ch),
	'jasper.audio.studio-reverb': (sr, ch) => new StudioReverb(sr, ch),
	'jasper.audio.surround-reverb': (sr, ch) => new SurroundReverb(sr, ch),
};
