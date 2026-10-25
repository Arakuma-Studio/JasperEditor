// The insert rules the Sound Library panel and MCP insert_sound share (spec 12 §2.3, §2.7; packages/project/src/sound/
// insert.ts): alignment by type, the timing of the placed media, lead silence (sample-exact placement), SFX tracks.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	ALLOWED_SEQUENCE_RATES,
	chooseSoundTrack,
	defaultAlignForTypes,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	libraryLeadSilenceSamples,
	planSoundInsert,
	resolveSoundAlign,
	SOUND_TYPE_IDS,
	SOUND_TYPES,
	type SoundTrackSequence,
	shiftLibraryDescriptors,
	soundTimingOf,
} from '../src/index.ts';

describe('alignment by type', () => {
	it('uses the first known type’s defaultAlign: risers and reverses by their end, UI by its start, else the peak', () => {
		expect(defaultAlignForTypes(['riser'])).toBe('end');
		expect(defaultAlignForTypes(['reverse', 'hit'])).toBe('end');
		expect(defaultAlignForTypes(['ui'])).toBe('start');
		expect(defaultAlignForTypes(['hit'])).toBe('peak');
		expect(defaultAlignForTypes(['whoosh'])).toBe('peak');
		expect(defaultAlignForTypes(['newer-type', 'riser'])).toBe('end');
		for (const bad of [[], null, undefined, ['__proto__'], [42], ['constructor']])
			expect(defaultAlignForTypes(bad as never)).toBe('peak');
		for (const t of SOUND_TYPE_IDS) expect(defaultAlignForTypes([t])).toBe(SOUND_TYPES[t].defaultAlign);
	});
	it('auto (or nothing) resolves by type; an explicit point wins', () => {
		expect(resolveSoundAlign(['riser'], 'auto')).toBe('end');
		expect(resolveSoundAlign(['riser'], undefined)).toBe('end');
		expect(resolveSoundAlign(['riser'], 'peak')).toBe('peak');
		expect(resolveSoundAlign(['hit'], 'start')).toBe('start');
		expect(resolveSoundAlign(['hit'], 'nonsense' as never)).toBe('peak');
	});
});

describe('lead silence', () => {
	it('pads short sounds whose head is not quiet, by whole samples (≥ one frame at 23.976 fps)', () => {
		expect(libraryLeadSilenceSamples({ headQuietSec: 0.001, durationSec: 0.5 }, 48000)).toBe(2400);
		expect(libraryLeadSilenceSamples({ headQuietSec: 0, durationSec: 0.5 }, 44100)).toBe(2205);
		// 22.05 kHz: 1102.5 → 1103 samples, the shift is then 1103 / 22050 s (≥ 50 ms)
		expect(libraryLeadSilenceSamples({ headQuietSec: 0, durationSec: 0.5 }, 22050)).toBe(1103);
		// a quiet head already absorbs any sub-frame rest: no padding
		expect(libraryLeadSilenceSamples({ headQuietSec: 0.05, durationSec: 0.5 }, 48000)).toBe(0);
		expect(libraryLeadSilenceSamples({ headQuietSec: 0, durationSec: 3600 }, 48000)).toBe(2400);
		// Files over the specified one-hour limit are registered as they are.
		expect(libraryLeadSilenceSamples({ headQuietSec: 0, durationSec: 3601 }, 48000)).toBe(0);
		for (const sr of [Number.NaN, 0, -1, 500, 1e7, Number.POSITIVE_INFINITY])
			expect(libraryLeadSilenceSamples({ headQuietSec: 0, durationSec: 1 }, sr)).toBe(0);
		for (const d of [
			{ headQuietSec: Number.NaN, durationSec: 1 },
			{ headQuietSec: 0, durationSec: Number.NaN },
			{ headQuietSec: 0, durationSec: 0 },
		])
			expect(libraryLeadSilenceSamples(d, 48000)).toBe(0);
	});
	it('moves the time points of the descriptors, not the levels', () => {
		const d = {
			peakSec: 0.02,
			onsetSec: 0.01,
			headQuietSec: 0,
			durationSec: 0.5,
			octaveBandsDb: [-1, -2, -3, -4, -5, -6, -7],
			centroidHz: 900,
			maxMomentaryLufs: -14,
		};
		expect(shiftLibraryDescriptors(d, 0.05)).toEqual({
			...d,
			peakSec: 0.07,
			onsetSec: 0.060000000000000005,
			headQuietSec: 0.05,
			durationSec: 0.55,
		});
	});
	it('uses the placed media’s provenance descriptors, else the library entry', () => {
		const fallback = { peakSec: 0.02, onsetSec: 0.01, headQuietSec: 0, durationSec: 0.5 };
		expect(soundTimingOf({ descriptors: { ...fallback, peakSec: 0.07 } }, fallback).peakSec).toBe(0.07);
		expect(soundTimingOf(null, fallback)).toBe(fallback);
		expect(soundTimingOf({ descriptors: { peakSec: Number.NaN } as never }, fallback)).toBe(fallback);
		expect(soundTimingOf({ descriptors: { ...fallback, durationSec: 0 } }, fallback)).toBe(fallback);
	});
});

describe('planSoundInsert', () => {
	it('is sample-exact for padded sounds at every sequence rate, every alignment (property)', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...ALLOWED_SEQUENCE_RATES),
				fc.constantFrom(44100, 48000, 22050, 96000),
				fc.integer({ min: 0, max: 20_000 }),
				fc.double({ min: 0, max: 0.95, noNaN: true }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.double({ min: 0.05, max: 3, noNaN: true }),
				fc.constantFrom('peak', 'start', 'end') as fc.Arbitrary<'peak' | 'start' | 'end'>,
				(fps, sr, cue, peakFrac, onsetFrac, dur, align) => {
					// the library sound: a head that is not quiet at all
					const peakSec = Math.round(peakFrac * dur * sr) / sr;
					const onsetSec = Math.round(onsetFrac * peakSec * sr) / sr;
					const samples = libraryLeadSilenceSamples({ headQuietSec: 0, durationSec: dur }, sr);
					expect(samples).toBeGreaterThan(0);
					const lead = samples / sr;
					const timing = {
						peakSec: peakSec + lead,
						onsetSec: onsetSec + lead,
						headQuietSec: lead,
						durationSec: dur + lead,
					};
					const r = planSoundInsert({ cueFrame: cue, fps, align, timing });
					const F = flicksPerFrame(fps);
					const point =
						align === 'peak' ? timing.peakSec : align === 'start' ? timing.onsetSec : timing.durationSec;
					if (!r.ok) {
						// only when the clip would start at frame 0 with nothing of the sound left after the point
						expect(point * FLICKS_PER_SECOND - cue * F).toBeGreaterThanOrEqual(
							timing.durationSec * FLICKS_PER_SECOND - 2,
						);
						return;
					}
					const p = r.placement;
					// where the aligned point plays, in sequence flicks
					const at = p.start * F + point * FLICKS_PER_SECOND - p.sourceInFlicks;
					expect(p.errorFlicks).toBe(0);
					expect(Math.abs(at - cue * F)).toBeLessThanOrEqual(1);
					// never cuts the sound (only lead silence), unless the clip had to start at frame 0
					if (p.start > 0) expect(p.sourceInFlicks).toBeLessThanOrEqual(lead * FLICKS_PER_SECOND + 1);
					expect(p.trimmedHeadSec).toBeGreaterThanOrEqual(0);
					expect(p.outFlicks).toBe(Math.round(timing.durationSec * FLICKS_PER_SECOND));
				},
			),
			{ numRuns: 1500 },
		);
	});
	it('without lead silence a sound with a loud head plays up to one frame late (why the engine pads)', () => {
		const fps = { num: 30000, den: 1001 };
		const F = flicksPerFrame(fps);
		const r = planSoundInsert({
			cueFrame: 45,
			fps,
			align: 'peak',
			timing: { peakSec: 0.0245, onsetSec: 0.009, headQuietSec: 0.0014, durationSec: 0.65 },
		});
		expect(r.ok && r.placement.errorFlicks).toBeGreaterThan(0);
		expect(r.ok && r.placement.errorFlicks).toBeLessThan(F);
	});
	it('refuses impossible input with E_INVALID_PARAM and never throws (property)', () => {
		const fps = { num: 25, den: 1 };
		expect(
			planSoundInsert({
				cueFrame: 0,
				fps,
				align: 'peak',
				timing: { peakSec: 0, onsetSec: 0, headQuietSec: 0, durationSec: 0 },
			}),
		).toMatchObject({ ok: false, code: 'E_INVALID_PARAM' });
		fc.assert(
			fc.property(fc.anything(), fc.anything(), fc.anything(), (cue, timing, dur) => {
				const r = planSoundInsert({
					cueFrame: cue as number,
					fps,
					align: 'peak',
					timing: timing as never,
					mediaDurationFlicks: dur as number,
				});
				expect(typeof r.ok).toBe('boolean');
			}),
			{ numRuns: 300 },
		);
	});
});

describe('chooseSoundTrack', () => {
	const seq = (
		tracks: { name: string; locked?: boolean; mute?: boolean }[],
		clips: [number, number, number][],
	) =>
		({
			audioTracks: tracks.map((t, i) => ({ id: `a${i + 1}`, ...t })),
			clips: Object.fromEntries(
				clips.map(([track, start, duration], i) => [`c${i}`, { trackId: `a${track}`, start, duration }]),
			),
		}) satisfies SoundTrackSequence;
	const span = { start: 10, frames: 20 };
	it('drop track, then targeted, then a free unmuted unlocked SFX track, else a new SFX n; never another track', () => {
		const s = seq(
			[{ name: 'Dialogue' }, { name: 'Music' }, { name: 'SFX 1' }, { name: 'SFX 2' }],
			[[3, 0, 15]],
		);
		expect(chooseSoundTrack(s, span)).toEqual({ kind: 'existing', trackId: 'a4', label: 'A4' });
		expect(chooseSoundTrack(s, span, { preferredTrackId: 'a1' })).toMatchObject({ trackId: 'a1' });
		expect(chooseSoundTrack(s, span, { targeted: ['a2'] })).toMatchObject({ trackId: 'a2' });
		expect(chooseSoundTrack(s, span, { preferredTrackId: 'a3' })).toMatchObject({ trackId: 'a4' });
		const busy = seq(
			[{ name: 'Dialogue' }, { name: 'SFX 1', mute: true }, { name: 'SFX 2', locked: true }],
			[],
		);
		expect(chooseSoundTrack(busy, span)).toEqual({ kind: 'new', name: 'SFX 3', label: 'A4' });
		expect(chooseSoundTrack(seq([], []), span)).toEqual({ kind: 'new', name: 'SFX 1', label: 'A1' });
	});
	it('never picks a track with a clip over the span (property)', () => {
		fc.assert(
			fc.property(
				fc.array(fc.record({ sfx: fc.boolean(), locked: fc.boolean(), mute: fc.boolean() }), {
					maxLength: 6,
				}),
				fc.array(
					fc.tuple(
						fc.integer({ min: 1, max: 6 }),
						fc.integer({ min: 0, max: 60 }),
						fc.integer({ min: 1, max: 30 }),
					),
					{
						maxLength: 10,
					},
				),
				fc.option(fc.integer({ min: 1, max: 6 })),
				(tracks, clips, pref) => {
					const s = seq(
						tracks.map((t, i) => ({
							name: t.sfx ? `SFX ${i}` : `Audio ${i}`,
							locked: t.locked,
							mute: t.mute,
						})),
						clips,
					);
					const c = chooseSoundTrack(s, span, { preferredTrackId: pref ? `a${pref}` : null });
					if (c.kind === 'existing') {
						const t = s.audioTracks.find((x) => x.id === c.trackId)!;
						expect(t.locked).toBeFalsy();
						for (const x of Object.values(s.clips))
							if (x.trackId === c.trackId) expect(x.start + x.duration <= 10 || x.start >= 30).toBe(true);
						if (c.trackId !== (pref ? `a${pref}` : null)) expect(t.name.startsWith('SFX')).toBe(true);
					}
				},
			),
			{ numRuns: 400 },
		);
	});
});
