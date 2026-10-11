// An ordered stack of audio effect processors with keyframed parameters (clip, track or master effect stack). The
// owner decides the time base of the keyframes (clip effects: content time; track/master: sequence time, S01:KF-002)
// and calls `automate(t)` at its control points; `process` runs the enabled processors in order.
import { type Animatable, type EffectInstance, evaluate, type ParamValue } from '@jasper/project/audio';
import type { AudioProcessor } from '../core/effect.ts';
import { createProcessor } from '../registry.ts';

export type ChainEffect = Pick<EffectInstance, 'id' | 'effectId' | 'enabled'> & {
	params: Readonly<EffectInstance['params']>;
};

type Slot = {
	instanceId: string;
	effectId: string;
	processor: AudioProcessor;
	enabled: boolean;
	/** Animated params, evaluated at every control point. */
	animated: { name: string; anim: Animatable<ParamValue> }[];
	/** Last value pushed per param (raw document value), to call setParam only on change. */
	last: Map<string, ParamValue>;
};

export class EffectChain {
	private slots: Slot[] = [];
	private active: Slot[] = [];

	constructor(
		readonly sampleRate: number,
		readonly channels = 2,
	) {}

	/**
	 * Updates the stack: instances keep their processor (and its state) when id and effect stay, new ones get a fresh
	 * processor, removed ones are dropped; disabled and unknown effects are bypassed (S01:FX-022).
	 */
	setEffects(effects: readonly ChainEffect[]): void {
		const old = new Map(this.slots.map((s) => [s.instanceId, s]));
		const next: Slot[] = [];
		for (const fx of effects) {
			let slot = old.get(fx.id);
			if (!slot || slot.effectId !== fx.effectId) {
				const processor = createProcessor(fx.effectId, this.sampleRate, this.channels);
				if (!processor) continue;
				slot = {
					instanceId: fx.id,
					effectId: fx.effectId,
					processor,
					enabled: fx.enabled,
					animated: [],
					last: new Map(),
				};
			}
			slot.animated = [];
			for (const p of slot.processor.spec.params) {
				const anim = fx.params[p.name];
				if (!anim) {
					this.push(slot, p.name, p.default);
					continue;
				}
				if (anim.keyframes.length > 0) slot.animated.push({ name: p.name, anim });
				else this.push(slot, p.name, anim.value);
			}
			// A bypassed effect that comes back starts from a clean state (no stale tail).
			if (fx.enabled && !slot.enabled) slot.processor.reset();
			slot.enabled = fx.enabled;
			next.push(slot);
		}
		this.slots = next;
		this.active = next.filter((s) => s.enabled);
	}

	private push(slot: Slot, name: string, v: ParamValue): void {
		if (slot.last.has(name) && slot.last.get(name) === v) return;
		slot.last.set(name, v);
		slot.processor.setParam(name, v);
	}

	/** True when any enabled effect has keyframes. */
	animated(): boolean {
		return this.active.some((s) => s.animated.length > 0);
	}

	/** Evaluates the keyframed params at time `t` (the stack's time base) and pushes changed values. */
	automate(t: number): void {
		for (const s of this.active) for (const a of s.animated) this.push(s, a.name, evaluate(a.anim, t));
	}

	/** Total latency (samples) of the enabled processors. */
	latency(): number {
		let l = 0;
		for (const s of this.active) l += s.processor.latency();
		return l;
	}

	reset(): void {
		for (const s of this.slots) s.processor.reset();
	}

	process(channels: readonly Float32Array[], start: number, end: number): void {
		if (end <= start) return;
		for (const s of this.active) s.processor.process(channels, start, end);
	}

	/** Enabled processors with their instance ids (meters, editors). */
	processors(): readonly { instanceId: string; effectId: string; processor: AudioProcessor }[] {
		return this.active;
	}
}
