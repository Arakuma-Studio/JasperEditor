// Effect-slot processor registry (audio-mix ↔ audio-fx interface). Track, submix and Mix inserts (and clip effects)
// are hosted by the offline mixer (`audio/mixer.ts`: exports, loudness analysis, scrubbing) through processors
// registered here by effect id. A processor works in place on planar float32 blocks at the mix sample rate; it
// receives the effect instance (params with their keyframes) and the time of every block, so automation of effect
// parameters is evaluated by the processor (sequence flicks for inserts, content flicks for clip effects).
//
// The preview counterpart (Web Audio) is `registerPreviewInsert` in `@jasper/compositions`.
import type { EffectInstance } from '../schema/sequence.ts';

export type AudioBlockContext = {
	sampleRate: number;
	/** Time of the first sample of the block in flicks (sequence time for inserts, content time for clip effects). */
	time: number;
	/** Flicks per sample (time advances by this per sample; negative for reversed clips). */
	flicksPerSample: number;
};

export interface AudioProcessor {
	/** Delay the processor introduces, in samples (look-ahead limiters, FFT effects). */
	readonly latency: number;
	/** Processes `frames` samples of every channel in place. */
	process(channels: Float32Array[], frames: number, ctx: AudioBlockContext): void;
	/** Clears the internal state (seeks). */
	reset(): void;
}

export type ProcessorFactory = (
	effect: EffectInstance,
	opts: { sampleRate: number; channels: number; where: 'insert' | 'clip' },
) => AudioProcessor;

const factories = new Map<string, ProcessorFactory>();

/** Registers the processor of an audio effect id (returns an unregister function). */
export function registerAudioProcessor(effectId: string, factory: ProcessorFactory): () => void {
	factories.set(effectId, factory);
	return () => {
		if (factories.get(effectId) === factory) factories.delete(effectId);
	};
}

export function audioProcessorFactory(effectId: string): ProcessorFactory | null {
	return factories.get(effectId) ?? null;
}

export function hasAudioProcessor(effectId: string): boolean {
	return factories.has(effectId);
}
