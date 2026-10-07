// Oracle test, part 2: synthetic programmes (sines across the band and levels, different L/R content, mono, 5.1 with
// LFE and surround weighting, seeded white / pink noise, speech-like, gated and loudness-modulated programmes,
// inter-sample peaks) at 32 / 44.1 / 48 / 96 kHz, LoudnessMeter vs ffmpeg's `ebur128` (and analytic values where
// they exist). See oracle.ts for the method and tolerances.
import { afterAll, describe, it } from 'vitest';
import { dual, type Ffmpeg, findFfmpeg, Oracle, sineLufs } from './oracle.ts';
import { concat, dbfs, pink, sine, speech, white } from './util.ts';

const FF = findFfmpeg();

describe.skipIf(!FF)(
	'loudness oracle: synthetic programmes (ours vs ffmpeg vs analytic)',
	{ timeout: 300_000 },
	() => {
		const oracle = new Oracle(FF as Ffmpeg);
		afterAll(() => oracle.finish('Synthetic programmes'));

		it('sines from 20 Hz to 15 kHz at various levels; different L/R; mono; 32 / 44.1 / 48 / 96 kHz', async () => {
			for (const [f, lvl, sr] of [
				[997, -20, 48000],
				[1000, -12, 44100],
				[20, -10, 48000],
				[100, -18, 96000],
				[5000, -24, 48000],
				[15000, -30, 44100],
				[1000, -16, 32000],
				[15000, -6, 96000],
			]) {
				const a = dbfs(lvl);
				await oracle.compare(`sine ${f} Hz ${lvl} dBFS`, dual(sine(f, a, sr, sr * 4, 0.2)), sr, {
					i: sineLufs(f, sr, [a, a], [1, 1]),
					tp: lvl,
					src: 'analytic',
				});
			}
			const sr = 48000;
			const l = sine(440, dbfs(-14), sr, sr * 8);
			const r = concat([sine(3000, dbfs(-26), sr, sr * 4), pink(sr, 4, 0.2, 7)]);
			await oracle.compare('stereo: L 440 Hz / R 3 kHz then pink', [l, r], sr);
			await oracle.compare(
				'mono 1 kHz −20 dBFS (no dual-mono +3 dB)',
				[sine(1000, dbfs(-20), 44100, 44100 * 5)],
				44100,
				{
					i: sineLufs(1000, 44100, [dbfs(-20)], [1]),
					tp: -20,
					src: 'analytic',
				},
			);
		});

		it('5.1 (L R C LFE Ls Rs, mask 0x3F): LFE excluded, surrounds +1.5 dB, layout agreed with ffmpeg', async () => {
			const sr = 48000;
			const lv = [-28, -26, -24, -10, -30, -22];
			const ch = lv.map((l, c) => sine(1000, dbfs(l), sr, sr * 6, c * 0.4));
			await oracle.compare('5.1 sines, LFE −10 dBFS', ch, sr, {
				i: sineLufs(1000, sr, lv.map(dbfs), [1, 1, 1, 0, 1.41, 1.41]),
				src: 'analytic',
			});
			await oracle.compare(
				'5.1 pink noise, loud LFE',
				[0, 1, 2, 3, 4, 5].map((c) => pink(sr, 8, c === 3 ? 0.8 : 0.25, 100 + c)),
				sr,
			);
		});

		it('seeded white and pink noise; speech-like programmes', async () => {
			await oracle.compare('white noise ±0.25', [white(48000, 8, 0.25, 1), white(48000, 8, 0.25, 2)], 48000);
			await oracle.compare('pink noise', [pink(48000, 10, 0.5, 1), pink(48000, 10, 0.5, 2)], 48000);
			await oracle.compare('pink noise', [pink(96000, 6, 0.4, 21), pink(96000, 6, 0.4, 22)], 96000);
			await oracle.compare('white noise mono ±0.1', [white(44100, 6, 0.1, 5)], 44100);
			await oracle.compare('pink noise', [pink(32000, 8, 0.5, 9), pink(32000, 8, 0.5, 10)], 32000);
			const sp = speech(48000, 20, 7);
			await oracle.compare('speech-like (R = 0.7 L)', [sp, sp.map((v) => v * 0.7)], 48000);
			await oracle.compare('speech-like mono', [speech(44100, 15, 11)], 44100);
		});

		it('gated programmes: digital silence and quiet passages exercise both gates', async () => {
			const sr = 48000;
			const l = concat([
				sine(440, dbfs(-18), sr, 5 * sr),
				new Float32Array(3 * sr),
				sine(1000, dbfs(-30), sr, 5 * sr),
				pink(sr, 4, dbfs(-50), 3),
				pink(sr, 4, dbfs(-80), 4),
			]);
			const r = concat([
				sine(440, dbfs(-18), sr, 5 * sr, 0.3),
				new Float32Array(3 * sr),
				new Float32Array(5 * sr),
				pink(sr, 4, dbfs(-50), 5),
				pink(sr, 4, dbfs(-80), 6),
			]);
			await oracle.compare('gated stereo: tone, silence, −30 L only, −50, −80', [l, r], sr);
			const q = concat([
				pink(sr, 8, 0.4, 31),
				pink(sr, 8, 0.4 * dbfs(-15), 32),
				new Float32Array(4 * sr),
				pink(sr, 8, 0.4 * dbfs(-8), 33),
			]);
			await oracle.compare('pink with −15 dB passage and silence', dual(q), sr);
		});

		it('loudness-modulated programmes (LRA)', async () => {
			const sr = 48000;
			const p = pink(sr, 40, 0.4, 41);
			for (let i = 0; i < p.length; i++) p[i] *= dbfs(8 * Math.sin((2 * Math.PI * i) / (17 * sr)));
			await oracle.compare('pink ±8 dB, 17 s period', dual(p), sr);
			const s = sine(1000, 1, 44100, 44100 * 30);
			for (let i = 0; i < s.length; i++)
				s[i] *= dbfs(-25 + 10 * Math.sin((2 * Math.PI * i) / (13 * 44100)) ** 3);
			await oracle.compare('1 kHz, −25 ± 10 dB (sin³), 13 s period', dual(s), 44100);
		});

		it('true peak: inter-sample-peak sines (fs/4 at 45°) and off-grid tones', async () => {
			for (const sr of [48000, 44100]) {
				await oracle.compare(
					'fs/4 sine at 45°, amplitude 0.9',
					dual(sine(sr / 4, 0.9, sr, sr * 4, Math.PI / 4)),
					sr,
					{
						tp: 20 * Math.log10(0.9),
						src: 'analytic',
					},
				);
			}
			await oracle.compare('11025 Hz at 0 dBFS', [sine(11025, 1, 44100, 44100 * 4)], 44100, {
				tp: 0,
				src: 'analytic',
			});
			await oracle.compare(
				'12 kHz −6 dBFS, off-grid',
				[sine(12000, 0.5, 96000, 96000 * 4, Math.PI / 8)],
				96000,
				{
					tp: 20 * Math.log10(0.5),
					src: 'analytic',
				},
			);
		});
	},
);
