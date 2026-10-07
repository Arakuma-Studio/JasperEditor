// "Amplitude and Compression" dynamics DSP (catalogue: packages/project/src/registry/audio/dynamics.ts).
import type { ProcessorFactory } from '../core/effect.ts';
import { HardLimiter } from './dynamics/limiter.ts';
import { DynamicsRack, MultibandCompressor } from './dynamics/rack.ts';
import { Compressor, ExpanderGate, TubeCompressor } from './dynamics/single.ts';

export { compressorCurve, expanderCurve, softClip } from './dynamics/curves.ts';

export const DYNAMICS_PROCESSORS: Readonly<Record<string, ProcessorFactory>> = {
	'jasper.audio.dynamics': (sr, ch) => new DynamicsRack(sr, ch),
	'jasper.audio.expander-gate': (sr, ch) => new ExpanderGate(sr, ch),
	'jasper.audio.hard-limiter': (sr, ch) => new HardLimiter(sr, ch),
	'jasper.audio.multiband-compressor': (sr, ch) => new MultibandCompressor(sr, ch),
	'jasper.audio.single-band-compressor': (sr, ch) => new Compressor(sr, ch),
	'jasper.audio.tube-compressor': (sr, ch) => new TubeCompressor(sr, ch),
};
