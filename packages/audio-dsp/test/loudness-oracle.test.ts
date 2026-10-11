import { afterAll, describe, expect, it } from 'vitest';
import { dual, type Ffmpeg, findFfmpeg, Oracle } from './oracle.ts';
import { segments } from './util.ts';

const FF = findFfmpeg();
const SR = 48000;

describe.skipIf(!FF)(
	'loudness oracle: EBU Tech 3341 / 3342 cases (ours vs ffmpeg vs published)',
	{
		timeout: 300_000,
	},
	() => {
		const oracle = new Oracle(FF as Ffmpeg);
		afterAll(() => oracle.finish('EBU Tech 3341 / 3342'));

		it('Tech 3341 cases 1, 2: stereo 1 kHz sine at −23 / −33 dBFS → M, S, I = −23.0 / −33.0 LUFS', async () => {
			for (const [n, lvl] of [
				[1, -23],
				[2, -33],
			]) {
				await oracle.compare(
					`3341 case ${n}: 1 kHz ${lvl} dBFS, 20 s`,
					dual(segments(1000, SR, [[20, lvl]])),
					SR,
					{
						i: lvl,
						m: lvl,
						s: lvl,
						lra: 0,
						lraTol: 0.1,
						src: 'Tech 3341',
					},
				);
			}
		});

		it('Tech 3341 cases 3, 4, 5: gated sequences → −23.0 LUFS', async () => {
			await oracle.compare(
				'3341 case 3: −36/−23/−36 dBFS, 10/60/10 s',
				dual(
					segments(1000, SR, [
						[10, -36],
						[60, -23],
						[10, -36],
					]),
				),
				SR,
				{ i: -23, src: 'Tech 3341' },
			);
			await oracle.compare(
				'3341 case 4: −72/−36/−23/−36/−72 dBFS, 10/10/60/10/10 s',
				dual(
					segments(1000, SR, [
						[10, -72],
						[10, -36],
						[60, -23],
						[10, -36],
						[10, -72],
					]),
				),
				SR,
				{ i: -23, src: 'Tech 3341' },
			);
			await oracle.compare(
				'3341 case 5: −26/−20/−26 dBFS, 20/20.1/20 s',
				dual(
					segments(1000, SR, [
						[20, -26],
						[20.1, -20],
						[20, -26],
					]),
				),
				SR,
				{ i: -23, src: 'Tech 3341' },
			);
		});

		it('Tech 3341 case 9 style: S stays −23.0 with 1.34 s @ −20 / 1.66 s @ −30 dBFS alternation', async () => {
			const segs: [number, number][] = [];
			for (let k = 0; k < 5; k++) segs.push([1.34, -20], [1.66, -30]);
			const r = await oracle.compare(
				'3341 case 9: 1.34 s −20 / 1.66 s −30 dBFS ×5',
				dual(segments(1000, SR, segs)),
				SR,
				{
					s: -23,
					src: 'Tech 3341',
				},
			);
			for (let k = 29; k < r.o.s.length; k++)
				expect(Math.abs(r.o.s[k] + 23), `S at ${(k + 1) / 10} s`).toBeLessThan(0.1);
		});

		it('Tech 3341 cases 10, 12 style: max S of 3 s bursts and max M of 0.4 s bursts at −23 dBFS', async () => {
			await oracle.compare(
				'3341 case 10: 3 s bursts (−23, −23, −26 dBFS)',
				dual(
					segments(1000, SR, [
						[1, -150],
						[3, -23],
						[0.7, -150],
						[3, -23],
						[1.9, -150],
						[3, -26],
						[2, -150],
					]),
				),
				SR,
				{ s: -23, src: 'Tech 3341' },
			);
			const m: [number, number][] = [];
			for (let k = 0; k < 8; k++) m.push([0.4, k === 5 ? -23 : -26], [0.3 + 0.1 * (k % 3), -150]);
			await oracle.compare('3341 case 12: 0.4 s bursts (one at −23 dBFS)', dual(segments(1000, SR, m)), SR, {
				m: -23,
				src: 'Tech 3341',
			});
		});

		it('Tech 3342 LRA cases 1–4 (1 kHz stereo)', async () => {
			const cases: [string, [number, number][], number][] = [
				[
					'3342 case 1: 20 s −20 / 20 s −30 dBFS',
					[
						[20, -20],
						[20, -30],
					],
					10,
				],
				[
					'3342 case 2: 20 s −20 / 20 s −15 dBFS',
					[
						[20, -20],
						[20, -15],
					],
					5,
				],
				[
					'3342 case 3: 20 s −40 / 20 s −20 dBFS',
					[
						[20, -40],
						[20, -20],
					],
					20,
				],
				[
					'3342 case 4: −50/−35/−20/−35/−50 dBFS × 20 s',
					[
						[20, -50],
						[20, -35],
						[20, -20],
						[20, -35],
						[20, -50],
					],
					15,
				],
			];
			for (const [name, segs, lra] of cases)
				await oracle.compare(name, dual(segments(1000, SR, segs)), SR, { lra, src: 'Tech 3342' });
		});
	},
);
