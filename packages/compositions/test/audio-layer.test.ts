// AudioLayer handle math for audio crossfades (S10:TUI-052): the layer's <Sequence> starts `headHandle`
// frames early, levels come from the nearest clip frame, fades from the real sequence frame.
import { audioFadeGain, type RenderAudioFade } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { audioLayerGain } from '../src/layers/AudioLayer.tsx';

const flat = { value: 0, keyframes: [] };
const fps = { num: 30, den: 1 };
const base = {
	sourceIn: 0,
	speed: { rate: 1, reverse: false, maintainPitch: true },
	gainDb: 0,
	volumeDb: flat,
	track: { volumeDb: flat, pan: flat },
};
// A 20-frame constant-power crossfade centred on the cut at 100: span [90, 110).
const out: RenderAudioFade = { type: 'out', start: 90, frames: 20, curve: 'equal-power' };
const inc: RenderAudioFade = { type: 'in', start: 90, frames: 20, curve: 'equal-power' };
const outgoing = { ...base, start: 0, duration: 100, fades: [out], tailHandle: 10 };
const incoming = { ...base, start: 100, duration: 100, fades: [inc], headHandle: 10 };

describe('audio layer gain through crossfade handles', () => {
	it('evaluates the fades at the real sequence frame, also inside the handles', () => {
		// Outgoing: layer frame = sequence frame (no head handle); 100…109 are its tail handle.
		expect(audioLayerGain(outgoing, 89, fps)).toBe(1);
		expect(audioLayerGain(outgoing, 100, fps)).toBeCloseTo(Math.SQRT1_2, 12);
		expect(audioLayerGain(outgoing, 105, fps)).toBeCloseTo(audioFadeGain([out], 105), 12);
		// Incoming: its Sequence starts at 90, so layer frame 0 is sequence frame 90.
		expect(audioLayerGain(incoming, 0, fps)).toBe(0);
		expect(audioLayerGain(incoming, 5, fps)).toBeCloseTo(audioFadeGain([inc], 95), 12);
		expect(audioLayerGain(incoming, 10, fps)).toBeCloseTo(Math.SQRT1_2, 12);
		expect(audioLayerGain(incoming, 20, fps)).toBe(1);
	});

	it('keeps the powers summing to 1 across the span', () => {
		for (let seqFrame = 85; seqFrame <= 115; seqFrame++) {
			const a = audioLayerGain(outgoing, seqFrame, fps);
			const b = audioLayerGain(incoming, seqFrame - 90, fps);
			expect(a * a + b * b).toBeCloseTo(1, 9);
		}
	});

	it('applies the clip levels in the handles (from the nearest clip frame)', () => {
		const loud = { ...incoming, gainDb: 20 * Math.log10(0.5) };
		expect(audioLayerGain(loud, 5, fps)).toBeCloseTo(0.5 * audioFadeGain([inc], 95), 9);
		expect(audioLayerGain(loud, 50, fps)).toBeCloseTo(0.5, 9);
	});
});
