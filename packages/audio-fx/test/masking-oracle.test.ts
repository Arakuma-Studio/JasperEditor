// Masking solver, end to end on real signals (spec 12 §2.4, P4-R1): a bed (pink noise plus an amplitude-modulated
// speech-band tone during "dialogue") and Jasper Synth sounds are measured with the shared band / loudness analysis,
// solved, mixed sample by sample at the solved gains, and the mix is measured again. The lift each event achieves in
// the mix must match what the solver reported, and the caps must hold on the rendered audio. The lift is over the bed
// plus the lower-weight sound effects playing under the event (an ambient chime under the clicks; WP6.5b), rendered
// at their solved gains; and all the sound effects together never pass the true-peak ceiling (BS.1770 meter).
import { LoudnessMeter } from '@jasper/audio-dsp';
import { describe, expect, it } from 'vitest';
import {
	BED_CAP_LU,
	bandLevels,
	bedLocalPeakLu,
	DIALOGUE_LIFT_DB,
	energyProfile,
	OCTAVE_BAND_CENTRES_HZ,
	peakProfile,
	QUIET_BED_OFFSET_LU,
	renderSynth,
	type SolverEvent,
	type SolverWeight,
	shortTermPeakLu,
	solveSfxGains,
} from '../src/index.ts';
import { powerLawNoise, SR } from './util.ts';

const BED_SEC = 8;
const SPEECH = { start: 4, end: 8 };
const PROGRAM = -14;
const CEILING = -1;

function makeBed(): Float32Array[] {
	const n = BED_SEC * SR;
	const l = new Float32Array(n);
	const r = new Float32Array(n);
	// pink noise ≈ −30 dBFS RMS (independent per channel, so stereo)
	const pl = powerLawNoise(101, 1 << 19, SR, 20, 20_000, -1, 0.12);
	const pr = powerLawNoise(102, 1 << 19, SR, 20, 20_000, -1, 0.12);
	for (let i = 0; i < n; i++) {
		l[i] = pl[i]!;
		r[i] = pr[i]!;
	}
	// "speech": 1.5 kHz tone with a 4 Hz syllable envelope, from 4 s on
	for (let i = SPEECH.start * SR; i < n; i++) {
		const t = i / SR;
		const v = 0.08 * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * 1500 * t);
		l[i] += v;
		r[i] += v;
	}
	return [l, r];
}

const truePeakDb = (ch: Float32Array[]): number => {
	const m = new LoudnessMeter(SR, ch.length);
	m.process(ch);
	m.flush();
	return m.truePeakDb();
};
const scaled = (ch: Float32Array[], gainDb: number): Float32Array[] => {
	const k = 10 ** (gainDb / 20);
	return ch.map((c) => c.map((v) => v * k));
};
const energyDb = (levels: number[], idx: number[]): number =>
	10 * Math.log10(idx.reduce((s, i) => s + 10 ** (levels[i]! / 10), 0));

type Placed = {
	clipId: string;
	recipe: string;
	seed: number;
	weight: SolverWeight;
	at: number;
	soundId?: string;
};

describe('masking solver on rendered audio', () => {
	it('the lift measured in the mix matches the report within 0.5 dB; caps hold on the audio', () => {
		const bed = makeBed();
		const placed: Placed[] = [
			{ clipId: 'hit', recipe: 'synth.hit', seed: 1, weight: 'hero', at: 0.6 },
			{ clipId: 'whoosh', recipe: 'synth.whoosh', seed: 2, weight: 'support', at: 0.5 },
			{ clipId: 'boom', recipe: 'synth.boom', seed: 3, weight: 'support', at: 2.2 },
			{ clipId: 'click1', recipe: 'synth.click', seed: 4, weight: 'support', at: 4.4, soundId: 'click-4' },
			{ clipId: 'click2', recipe: 'synth.click', seed: 4, weight: 'support', at: 5.4, soundId: 'click-4' },
			{ clipId: 'chime', recipe: 'synth.chime', seed: 5, weight: 'ambient', at: 3.5 },
		];
		const sounds = new Map<string, Float32Array[]>();
		const events: SolverEvent[] = placed.map((p) => {
			const s = renderSynth(p.recipe, p.seed);
			expect(s.sampleRate).toBe(SR);
			sounds.set(p.clipId, s.channels);
			const len = s.channels[0]!.length / SR;
			const win = { start: p.at, end: Math.min(BED_SEC, p.at + len) };
			const own = { start: 0, end: win.end - win.start };
			return {
				clipId: p.clipId,
				soundId: p.soundId ?? `${p.recipe}:${p.seed}`,
				type: s.type,
				weight: p.weight,
				startSec: win.start,
				endSec: win.end,
				soundBandsDb: bandLevels(s.channels, SR, own),
				energyProfile: energyProfile(s.channels, SR, own),
				peakProfileDb: peakProfile(s.channels, SR, own, truePeakDb(s.channels))!,
				soundPeakLu: shortTermPeakLu(s.channels, SR, own),
				truePeakDb: truePeakDb(s.channels),
				bedBandsDb: bandLevels(bed, SR, win),
				bedLocalPeakLu: bedLocalPeakLu(bed, SR, win, p.weight),
				speechOverlap: win.end > SPEECH.start && win.start < SPEECH.end,
				baseGainDb: -24,
			};
		});
		const result = solveSfxGains(events, { programLufs: PROGRAM, truePeakCeilingDb: CEILING });
		expect(result.warnings.filter((w) => w.code === 'W_UNRESOLVED')).toEqual([]);

		const rows: string[] = [];
		const gainOf = (id: string) => result.events.find((x) => x.clipId === id)!.gainDb;
		/** `into` += the event's sound × its solved gain at its start sample. */
		const addSound = (into: Float32Array[], e: SolverEvent, g: number) => {
			const s = sounds.get(e.clipId)!;
			const off = Math.round(e.startSec * SR);
			const n = Math.round((e.endSec - e.startSec) * SR);
			const k = 10 ** (g / 20);
			for (let c = 0; c < into.length; c++)
				for (let j = 0; j < n; j++) into[c]![off + j] = into[c]![off + j]! + s[c]![j]! * k;
		};
		events.forEach((e, i) => {
			const out = result.events[i]!;
			const s = sounds.get(e.clipId)!;
			const g = out.gainDb;
			// the bed this event has to clear: the bed + the lower sound effects under it, at their solved gains
			const masked = bed.map((c) => new Float32Array(c));
			for (const id of out.maskedBy) addSound(masked, events.find((x) => x.clipId === id)!, gainOf(id));
			// render this event over it: mix = masked bed + sound × gain, the sound placed at its start sample
			const mix = masked.map((c) => new Float32Array(c));
			addSound(mix, e, g);
			const win = { start: e.startSec, end: e.endSec };
			const mixBands = bandLevels(mix, SR, win);
			const maskedBands = bandLevels(masked, SR, win);
			const dom = out.dominantBands.map((hz) => OCTAVE_BAND_CENTRES_HZ.indexOf(hz));
			expect(dom.length).toBeGreaterThan(0);
			const bedBands = e.bedBandsDb;
			// the sound's share of the mix energy (bed and sound are uncorrelated) over the masked bed, in the dominant bands
			const eMix = 10 ** (energyDb(mixBands, dom) / 10);
			const eBed = 10 ** (energyDb(maskedBands, dom) / 10);
			const measuredLift = 10 * Math.log10((eMix - eBed) / eBed);
			// and exactly: the mix minus the masked bed is the gained sound
			const diff = mix.map((c, ci) => c.map((v, j) => v - masked[ci]![j]!));
			const exactLift = energyDb(bandLevels(diff, SR, win), dom) - energyDb(maskedBands, dom);
			// the masking the solver estimated (maskers' power spread over their windows) vs the rendered one
			const maskingDb = energyDb(maskedBands, dom) - energyDb(bedBands, dom);
			rows.push(
				`${e.clipId.padEnd(7)} ${out.dominantBands.join('+').padEnd(10)} gain ${g.toFixed(2).padStart(7)} report ${out.achievedLiftDb!.toFixed(2).padStart(6)} mix ${measuredLift.toFixed(2).padStart(6)} exact ${exactLift.toFixed(2).padStart(6)} masking ${out.sfxMaskingDb!.toFixed(2)}/${maskingDb.toFixed(2)} [${out.maskedBy.join(',')}]  ${out.reason}`,
			);
			expect(Math.abs(exactLift - out.achievedLiftDb!), e.clipId).toBeLessThan(0.5);
			// the masking estimate from the maskers' energy profiles is close to the rendered masking
			expect(Math.abs(out.sfxMaskingDb! - maskingDb), `${e.clipId} masking`).toBeLessThan(0.25);
			if (out.achievedLiftDb! >= -3)
				expect(Math.abs(measuredLift - out.achievedLiftDb!), e.clipId).toBeLessThan(0.5);
			// a lift short of its target always has a reason
			if (out.achievedLiftDb! < out.targetLiftDb - 0.01)
				expect(out.limitedBy.length, e.clipId).toBeGreaterThan(0);

			// caps on the rendered sound
			const gained = scaled(s, g);
			const tp = truePeakDb(gained);
			if (!out.limitedBy.some((l) => l.endsWith('/headroom')))
				expect(tp, e.clipId).toBeLessThanOrEqual(CEILING + 0.01);
			const ref = Math.max(e.bedLocalPeakLu ?? -Infinity, PROGRAM + QUIET_BED_OFFSET_LU);
			const peak = shortTermPeakLu(gained, SR, { start: 0, end: e.endSec - e.startSec });
			if (!out.limitedBy.some((l) => l.endsWith('/bed-cap')))
				expect(peak - ref, e.clipId).toBeLessThanOrEqual(BED_CAP_LU[e.weight] + 0.01);
			if (e.speechOverlap && !out.limitedBy.some((l) => l.endsWith('/dialogue'))) {
				const soundBands = bandLevels(diff, SR, win);
				for (const b of [3, 4, 5])
					expect(soundBands[b]! - bedBands[b]!, `${e.clipId} band ${b}`).toBeLessThanOrEqual(
						DIALOGUE_LIFT_DB + 0.5,
					);
			}
		});
		console.log(`masking oracle (lift in dB over the bed):\n${rows.join('\n')}`);
		// every sound effect together (no bed), at the solved gains: the true peak (BS.1770-4 annex 2) of the sum is
		// under the ceiling — the summed-overlap check bounds it by the sum of the overlapping events' true peaks
		const sfx = bed.map((c) => new Float32Array(c.length));
		for (const e of events) addSound(sfx, e, gainOf(e.clipId));
		const sumTp = truePeakDb(sfx);
		console.log(`all sound effects together: true peak ${sumTp.toFixed(2)} dBTP (ceiling ${CEILING})`);
		expect(sumTp).toBeLessThanOrEqual(CEILING + 0.01);
		// the scene exercises the shadow and the dialogue guard
		const by = (id: string) => result.events.find((e) => e.clipId === id)!;
		expect(by('whoosh').limitedBy).toContain('hero-shadow');
		expect(by('click1').speechBandLiftDb!).toBeLessThanOrEqual(DIALOGUE_LIFT_DB + 0.01);
	});
});
