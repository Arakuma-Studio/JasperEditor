// Processor registry: effect id → factory (one family file per catalogue family, same names as
// packages/project/src/registry/audio/*). Every catalogue entry has exactly one processor (tested).
import type { AudioProcessor, ProcessorFactory } from './core/effect.ts';
import { DELAY_MODULATION_PROCESSORS } from './effects/delay-modulation.ts';
import { DYNAMICS_PROCESSORS } from './effects/dynamics.ts';
import { FILTER_EQ_PROCESSORS } from './effects/filter-eq.ts';
import { PITCH_PROCESSORS } from './effects/pitch.ts';
import { RESTORATION_PROCESSORS } from './effects/restoration.ts';
import { REVERB_PROCESSORS } from './effects/reverb.ts';
import { SPECIAL_PROCESSORS } from './effects/special.ts';
import { STEREO_CHANNEL_PROCESSORS } from './effects/stereo-channel.ts';

const FACTORIES = new Map<string, ProcessorFactory>(
	Object.entries({
		...FILTER_EQ_PROCESSORS,
		...DYNAMICS_PROCESSORS,
		...RESTORATION_PROCESSORS,
		...DELAY_MODULATION_PROCESSORS,
		...REVERB_PROCESSORS,
		...PITCH_PROCESSORS,
		...SPECIAL_PROCESSORS,
		...STEREO_CHANNEL_PROCESSORS,
	}),
);

/** Ids with a processor. */
export function processorIds(): string[] {
	return [...FACTORIES.keys()];
}

export function hasProcessor(id: string): boolean {
	return FACTORIES.has(id);
}

/** Instantiates the processor of an audio effect for `(sampleRate, channels)`; null for unknown ids. */
export function createProcessor(id: string, sampleRate: number, channels = 2): AudioProcessor | null {
	const f = FACTORIES.get(id);
	return f ? f(sampleRate, channels) : null;
}
