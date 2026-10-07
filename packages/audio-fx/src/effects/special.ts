// Special DSP (catalogue: packages/project/src/registry/audio/special.ts).
import type { ProcessorFactory } from '../core/effect.ts';
import { AutoGain, LoudnessMeterFx, Mastering, Mute, VocalEnhancer } from './special/mastering.ts';
import { Distortion, GuitarSuite } from './special/shaping.ts';

export const SPECIAL_PROCESSORS: Readonly<Record<string, ProcessorFactory>> = {
	'jasper.audio.auto-gain': (sr, ch) => new AutoGain(sr, ch),
	'jasper.audio.distortion': (sr, ch) => new Distortion(sr, ch),
	'jasper.audio.guitar-suite': (sr, ch) => new GuitarSuite(sr, ch),
	'jasper.audio.loudness-meter': (sr, ch) => new LoudnessMeterFx(sr, ch),
	'jasper.audio.mastering': (sr, ch) => new Mastering(sr, ch),
	'jasper.audio.mute': (sr, ch) => new Mute(sr, ch),
	'jasper.audio.vocal-enhancer': (sr, ch) => new VocalEnhancer(sr, ch),
};
