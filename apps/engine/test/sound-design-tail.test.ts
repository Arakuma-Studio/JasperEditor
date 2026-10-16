// How long a sound-design solo render runs after its clip (`soloTailSec`, `effectTailSec`; wp-note "Phase 4"): every
// effect with a tail on the sound's way to the Mix lengthens it — reverbs (decay + pre-delay), the Convolution
// Reverb's impulse, delays and echoes until their feedback falls 60 dB, the Flanger's ringing — including the Mix's own
// inserts; 0.5 s at least, 6 s at most. Pure.
import type { Clip, Sequence } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { effectTailSec, MAX_TAIL_SEC, SOLO_TAIL_SEC, soloTailSec } from '../src/sound-design/bed.ts';

const p = (value: number | string, keyframes: { value: number | string }[] = []) => ({ value, keyframes });
const fx = (effectId: string, params: Record<string, ReturnType<typeof p>>, enabled = true) => ({
	id: `fx_${effectId.length}`,
	effectId,
	effectVersion: 1,
	enabled,
	params,
});

describe('effectTailSec', () => {
	it('reverbs: decay + pre-delay; convolution: its impulse + pre-delay', () => {
		expect(effectTailSec(fx('jasper.audio.studio-reverb', { decay: p(0.6), preDelay: p(8) }))).toBeCloseTo(
			0.608,
			9,
		);
		expect(
			effectTailSec(fx('jasper.audio.surround-reverb', { decay: p(1.5, [{ value: 3 }]), preDelay: p(20) })),
		).toBeCloseTo(3.02, 9);
		expect(
			effectTailSec(fx('jasper.audio.convolution-reverb', { impulse: p('cathedral'), preDelay: p(100) })),
		).toBeCloseTo(3.2 * 1.1 + 0.12 + 0.1, 9);
		expect(effectTailSec(fx('jasper.audio.convolution-reverb', {}))).toBeCloseTo(0.8 * 1.1 + 0.045, 9);
	});

	it('delays and echoes: the delay times the repeats their feedback takes to fall 60 dB', () => {
		// 50 % feedback: 0.5^10 < 1e-3 → 10 repeats + the first echo
		expect(effectTailSec(fx('jasper.audio.delay', { time: p(300), feedback: p(50) }))).toBeCloseTo(
			0.3 * 11,
			9,
		);
		expect(effectTailSec(fx('jasper.audio.delay', { time: p(300), feedback: p(0) }))).toBeCloseTo(0.3, 9);
		// tempo-synced: a quarter note at 120 bpm
		expect(
			effectTailSec(
				fx('jasper.audio.delay', { mode: p('tempo'), bpm: p(120), division: p('1/4'), feedback: p(0) }),
			),
		).toBeCloseTo(0.5, 9);
		expect(effectTailSec(fx('jasper.audio.analog-delay', { delay: p(250), feedback: p(40) }))).toBeCloseTo(
			0.25 * (Math.ceil(Math.log(1e-3) / Math.log(0.4)) + 1),
			9,
		);
		// saturating feedback (≥ 100 %) does not decay
		expect(effectTailSec(fx('jasper.audio.analog-delay', { delay: p(250), feedback: p(150) }))).toBe(
			Number.POSITIVE_INFINITY,
		);
		const taps = fx('jasper.audio.multitap-delay', {
			delay1: p(250),
			feedback1: p(0),
			level1: p(-6),
			delay2: p(1000),
			feedback2: p(0),
			level2: p(-96),
		});
		expect(effectTailSec(taps)).toBeCloseTo(0.25, 9); // tap 2 is off (−96 dB)
		expect(
			effectTailSec(fx('jasper.audio.flanger', { initialDelay: p(1), finalDelay: p(20), feedback: p(-100) })),
		).toBeCloseTo(0.02 * (Math.ceil(Math.log(1e-3) / Math.log(0.95)) + 1), 9);
	});

	it('disabled and tail-less effects add nothing', () => {
		expect(effectTailSec(fx('jasper.audio.studio-reverb', { decay: p(4) }, false))).toBe(0);
		expect(effectTailSec(fx('jasper.audio.parametric-equalizer', {}))).toBe(0);
		expect(effectTailSec({})).toBe(0);
	});
});

describe('soloTailSec', () => {
	const seq = (over: Partial<Record<'clipFx' | 'trackFx' | 'busFx' | 'mixFx', unknown[]>>) => {
		const clip = { id: 'clp_1', trackId: 'trk_a', effects: over.clipFx ?? [] } as unknown as Clip;
		const s = {
			audioTracks: [
				{ id: 'trk_a', effects: over.trackFx ?? [], mixer: { output: null, sends: [{ target: 'trk_s' }] } },
			],
			submixTracks: [{ id: 'trk_s', effects: over.busFx ?? [], mixer: { output: null, sends: [] } }],
			master: { effects: over.mixFx ?? [] },
		} as unknown as Sequence;
		return soloTailSec(s, clip);
	};
	it('walks the clip, its track, the submixes it sends to and the Mix', () => {
		expect(seq({})).toBe(SOLO_TAIL_SEC);
		expect(seq({ clipFx: [fx('jasper.audio.delay', { time: p(400), feedback: p(50) })] })).toBeCloseTo(
			4.4,
			9,
		);
		expect(seq({ busFx: [fx('jasper.audio.studio-reverb', { decay: p(2), preDelay: p(20) })] })).toBeCloseTo(
			2.02,
			9,
		);
		// the Mix's own echo (before: cut at 0.5 s)
		expect(seq({ mixFx: [fx('jasper.audio.delay', { time: p(500), feedback: p(20) })] })).toBeCloseTo(
			0.5 * (Math.ceil(Math.log(1e-3) / Math.log(0.2)) + 1),
			9,
		);
		// never more than 6 s, also for a saturating echo
		expect(seq({ trackFx: [fx('jasper.audio.analog-delay', { delay: p(250), feedback: p(150) })] })).toBe(
			MAX_TAIL_SEC,
		);
	});
});
