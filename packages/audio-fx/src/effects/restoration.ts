// Restoration and speech DSP (catalogue: packages/project/src/registry/audio/restoration.ts).
import type { ProcessorFactory } from '../core/effect.ts';
import { ClickRemover } from './restoration/declick.ts';
import { DeHum } from './restoration/dehum.ts';
import { DeNoise, DeReverb } from './restoration/spectral.ts';
import { DeEsser, SpeechEnhance } from './restoration/speech.ts';

export const RESTORATION_PROCESSORS: Readonly<Record<string, ProcessorFactory>> = {
	'jasper.audio.click-remover': (sr, ch) => new ClickRemover(sr, ch),
	'jasper.audio.dehummer': (sr, ch) => new DeHum(sr, ch),
	'jasper.audio.deesser': (sr, ch) => new DeEsser(sr, ch),
	'jasper.audio.denoise': (sr, ch) => new DeNoise(sr, ch),
	'jasper.audio.dereverb': (sr, ch) => new DeReverb(sr, ch),
	'jasper.audio.enhance-speech': (sr, ch) => new SpeechEnhance(sr, ch),
};
