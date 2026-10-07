// "Filter and EQ" family DSP (catalogue: packages/project/src/registry/audio/filter-eq.ts): biquad-bank equalisers
// and filters (./filter-eq/eq.ts), the Scientific Filter (./filter-eq/scientific.ts, designs in core/design.ts) and
// the FFT Filter (./filter-eq/fft-filter.ts). Every effect reports its analytic `responseDb` for the EQ editors.
import type { ProcessorFactory } from '../core/effect.ts';
import { EQ_PROCESSORS } from './filter-eq/eq.ts';
import { FftFilter } from './filter-eq/fft-filter.ts';
import { ScientificFilter } from './filter-eq/scientific.ts';

export const FILTER_EQ_PROCESSORS: Readonly<Record<string, ProcessorFactory>> = {
	...EQ_PROCESSORS,
	'jasper.audio.scientific-filter': (sr, ch) => new ScientificFilter(sr, ch),
	'jasper.audio.fft-filter': (sr, ch) => new FftFilter(sr, ch),
};
