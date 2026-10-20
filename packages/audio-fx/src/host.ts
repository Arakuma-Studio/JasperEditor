// Hosting audio-fx processors in the audio-mix offline mixer (`registerAudioProcessor`, @jasper/project): every export
// path, loudness analysis and audio scrubbing run clip effects (time = content flicks) and track / submix / Mix
// inserts (time = sequence flicks) through `EffectSlot`. Keyframed parameters are evaluated every `CONTROL_BLOCK`
// samples counted from the slot's start (reset), so the output does not depend on how the mixer cuts its blocks.
import {
	AUDIO_EFFECTS,
	type AudioBlockContext,
	type EffectInstance,
	type AudioProcessor as MixProcessor,
	registerAudioProcessor,
} from '@jasper/project/audio';
import { EffectChain } from './chain/effect-chain.ts';
import { createProcessor } from './registry.ts';

/** Samples between two evaluations of keyframed parameters. */
export const CONTROL_BLOCK = 32;

export class EffectSlot implements MixProcessor {
	readonly chain: EffectChain;
	private n = 0;
	/** Whether the parameters have been snapped to their values at the first control point (after a reset). */
	private primed = false;
	readonly latency: number;

	constructor(effect: EffectInstance, sampleRate: number, channels: number) {
		this.chain = new EffectChain(sampleRate, Math.max(1, channels));
		this.chain.setEffects([{ ...effect, enabled: true }]);
		// The processors were built with the spec defaults; their smoothers must not glide from there to the
		// instance's values over the first milliseconds of every clip and export (nothing was processed yet).
		this.chain.reset();
		this.latency = this.chain.latency();
	}

	/** Applies an edited instance (same effect id): static params are pushed, keyframes taken over. */
	update(effect: EffectInstance): void {
		this.chain.setEffects([{ ...effect, enabled: true }]);
	}

	process(channels: Float32Array[], frames: number, ctx: AudioBlockContext): void {
		const animated = this.chain.animated();
		let i = 0;
		while (i < frames) {
			const phase = this.n % CONTROL_BLOCK;
			if (animated && phase === 0) {
				this.chain.automate(ctx.time + i * ctx.flicksPerSample);
				// First control point since construction / reset: keyframed values apply at once, not by a ramp from
				// the static value (the state is still empty, so resetting only snaps the smoothers).
				if (!this.primed) this.chain.reset();
			}
			this.primed = true;
			const k = Math.min(frames - i, CONTROL_BLOCK - phase);
			this.chain.process(channels, i, i + k);
			i += k;
			this.n += k;
		}
	}

	reset(): void {
		this.chain.reset();
		this.n = 0;
		this.primed = false;
	}
}

/** Latency (samples) an effect instance will report at `sampleRate`. */
export function effectLatency(
	effect: Pick<EffectInstance, 'effectId' | 'params' | 'enabled'>,
	sampleRate = 48000,
): number {
	if (!effect.enabled) return 0;
	const p = createProcessor(effect.effectId, sampleRate, 2);
	if (!p) return 0;
	for (const [name, anim] of Object.entries(effect.params)) p.setParam(name, anim.value);
	return p.latency();
}

let installed = false;

/** Registers a mixer processor for every audio effect of the catalogue (idempotent). */
export function installAudioFxProcessors(): void {
	if (installed) return;
	installed = true;
	for (const spec of AUDIO_EFFECTS)
		registerAudioProcessor(spec.id, (effect, o) => new EffectSlot(effect, o.sampleRate, o.channels));
}
