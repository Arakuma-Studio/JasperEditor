import type { Draft } from 'immer';
import type { PuppetPin, PuppetPinProp } from '../../schema/puppet.ts';
import type { EffectInstance } from '../../schema/sequence.ts';
import type { DDoc } from '../context.ts';
import type { ClipEffectLocation as FxLoc } from './util.ts';

export type PuppetPinLocation = FxLoc & { pin: Draft<PuppetPin>; index: number };

export function locatePin(doc: DDoc, pinId: string): PuppetPinLocation | null {
	for (const seq of Object.values(doc.sequences))
		for (const clip of Object.values(seq.clips))
			for (const fx of (clip as { effects?: Draft<EffectInstance>[] }).effects ?? []) {
				const pins = fx.puppet?.pins ?? [];
				const index = pins.findIndex((p) => p.id === pinId);
				if (index >= 0) return { seq, clip, fx, pin: pins[index]!, index };
			}
	return null;
}
/** Ranges of the pin properties (clamped on write). */
export const PUPPET_PIN_RANGES: Record<PuppetPinProp, { min?: number; max?: number }> = {
	position: {},
	scale: { min: 0, max: 10000 },
	rotation: {},
	amount: { min: 0, max: 100 },
	extent: { min: 0, max: 10000 },
	inFront: { min: -100, max: 100 },
};
export const isPinProp = (s: string): s is PuppetPinProp =>
	['position', 'scale', 'rotation', 'amount', 'extent', 'inFront'].includes(s);
