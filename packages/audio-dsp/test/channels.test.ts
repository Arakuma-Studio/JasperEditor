// Ported from FilmCraft crates/audio-dsp/src/channels.rs and src/effects/channel.rs tests.
import { describe, expect, it } from 'vitest';
import {
	applyMatrix,
	balanceGains,
	CH_C,
	CH_L,
	CH_LFE,
	CH_LS,
	CH_R,
	CH_RS,
	channelCount,
	channelNames,
	channelPeaks,
	conversionMatrix,
	convertChannels,
	convertLayout,
	DEFAULT_PAN51,
	K,
	LAYOUTS,
	layoutFromChannels,
	mixdownFromId,
	pan51Matrix,
	panMonoGains,
	pointGains51,
} from '../src/index.ts';

const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

describe('channel layouts and conversion (ITU-R BS.775)', () => {
	it('layout basics', () => {
		expect(LAYOUTS.map(channelCount)).toEqual([1, 2, 6]);
		expect(channelNames('5.1')).toEqual(['L', 'R', 'C', 'LFE', 'Ls', 'Rs']);
		expect(channelNames('mono')).toEqual(['M']);
		expect(layoutFromChannels(6)).toBe('5.1');
		expect(layoutFromChannels(1)).toBe('mono');
		expect(layoutFromChannels(4)).toBe('stereo');
	});

	it('BS.775 downmix coefficients are exact', () => {
		const k = Math.SQRT1_2;
		let m = conversionMatrix('5.1', 'stereo', 'frontRear');
		expect(m[0]).toEqual([1, 0, k, 0, k, 0]);
		expect(m[1]).toEqual([0, 1, k, 0, 0, k]);
		expect(conversionMatrix('5.1', 'stereo')).toEqual(m); // default is frontRear
		m = conversionMatrix('5.1', 'mono');
		expect(m[0]).toEqual([k, k, 1, 0, 0.5, 0.5]);
		expect(conversionMatrix('stereo', 'mono')[0]).toEqual([k, k]);
		expect(conversionMatrix('5.1', 'stereo', 'front')[0]).toEqual([1, 0, k, 0, 0, 0]);
		expect(conversionMatrix('5.1', 'stereo', 'frontLfe')[1]).toEqual([0, 1, k, k, 0, 0]);
		expect(conversionMatrix('5.1', 'stereo', 'frontRearLfe')[0]).toEqual([1, 0, k, k, k, 0]);
		expect(mixdownFromId('frontRearLfe')).toBe('frontRearLfe');
		expect(mixdownFromId('FRONTREAR')).toBe('frontRear');
		expect(mixdownFromId('nope')).toBeUndefined();
	});

	it('upmix places the source on the front speakers; identity matrices', () => {
		expect(conversionMatrix('mono', '5.1')).toEqual([[0], [0], [1], [0], [0], [0]]);
		const s = conversionMatrix('stereo', '5.1');
		expect(s[CH_L]).toEqual([1, 0]);
		expect(s[CH_R]).toEqual([0, 1]);
		expect(s.slice(CH_C).every((r) => r.every((g) => g === 0))).toBe(true);
		expect(conversionMatrix('mono', 'stereo')).toEqual([[1], [1]]);
		for (const l of LAYOUTS) {
			const m = conversionMatrix(l, l, 'front');
			m.forEach((row, o) => {
				row.forEach((g, i) => {
					expect(g).toBe(o === i ? 1 : 0);
				});
			});
		}
	});

	it('convert applies the matrix per sample', () => {
		const ch = Array.from({ length: 6 }, (_, c) => new Float32Array(4).fill((c + 1) * 0.1));
		const st = convertLayout(ch, '5.1', 'stereo');
		expect(close(st[0][3], Math.fround(0.1) + K * Math.fround(0.3) + K * Math.fround(0.5))).toBe(true);
		expect(close(st[1][0], Math.fround(0.2) + K * Math.fround(0.3) + K * Math.fround(0.6))).toBe(true);
		expect(convertChannels(st, 'stereo')).toEqual(st);
		const up = convertChannels([new Float32Array(3).fill(0.5)], '5.1');
		expect(up.length).toBe(6);
		expect(Array.from(up[CH_C])).toEqual([0.5, 0.5, 0.5]);
		expect(Array.from(up[CH_L])).toEqual([0, 0, 0]);
		// unusual channel counts: first channels that fit, padded with silence
		const odd = convertChannels(
			[new Float32Array(2).fill(1), new Float32Array(2).fill(2), new Float32Array(2)],
			'5.1',
		);
		expect(odd.length).toBe(6);
		expect(Array.from(odd[1])).toEqual([2, 2]);
		expect(Array.from(odd[5])).toEqual([0, 0]);
		expect(channelPeaks([new Float32Array([0.1, -0.7]), new Float32Array(1)])).toEqual([Math.fround(0.7), 0]);
	});

	it('applyMatrix: offset/length, gain, accumulate and in-place', () => {
		const m = conversionMatrix('stereo', 'stereo');
		const swap = [
			[0, 1],
			[1, 0],
		];
		const l = new Float32Array([1, 2, 3, 4]);
		const r = new Float32Array([5, 6, 7, 8]);
		applyMatrix(swap, [l, r], [l, r], 1, 2, 0.5); // in place
		expect(Array.from(l)).toEqual([1, 3, 3.5, 4]);
		expect(Array.from(r)).toEqual([5, 1, 1.5, 8]);
		const out = [new Float32Array(4).fill(1), new Float32Array(4).fill(1)];
		applyMatrix(m, [l, r], out, 0, undefined, 1, true);
		expect(Array.from(out[0])).toEqual([2, 4, 4.5, 5]);
		const mono = [new Float32Array(4)];
		applyMatrix(conversionMatrix('stereo', 'mono'), [new Float32Array(4).fill(1)], mono); // missing R = silence
		expect(close(mono[0][0], K)).toBe(true);
	});
});

describe('pan laws', () => {
	it('mono pan is constant power with −3 dB centre', () => {
		for (let i = -10; i <= 10; i++) {
			const [l, r] = panMonoGains(i / 10);
			expect(Math.abs(l * l + r * r - 1)).toBeLessThan(1e-12);
		}
		const [l, r] = panMonoGains(0);
		expect(close(l, Math.SQRT1_2) && close(r, Math.SQRT1_2)).toBe(true);
		expect(panMonoGains(-1)).toEqual([1, 0]);
		expect(panMonoGains(1)).toEqual([0, 1]);
		expect(panMonoGains(7)).toEqual([0, 1]);
	});

	it('stereo balance: unity centre, far side cosine', () => {
		expect(balanceGains(0)).toEqual([1, 1]);
		expect(balanceGains(1)).toEqual([0, 1]);
		expect(balanceGains(-1)).toEqual([1, 0]);
		const [l, r] = balanceGains(0.5);
		expect(close(l, Math.SQRT1_2) && r === 1).toBe(true);
	});
});

describe('5.1 panner', () => {
	it('point gains are equal power', () => {
		for (let xi = -10; xi <= 10; xi++) {
			for (let yi = -10; yi <= 10; yi++) {
				for (const c of [0, 0.3, 1]) {
					const g = pointGains51(xi / 10, yi / 10, c);
					const p = g.reduce((s, v) => s + v * v, 0);
					expect(Math.abs(p - 1), `(${xi}, ${yi}, ${c}) power ${p}`).toBeLessThan(1e-5);
					expect(g[CH_LFE]).toBe(0);
					expect(g.every((v) => v >= -1e-7)).toBe(true);
				}
			}
		}
		// speaker positions
		expect(close(pointGains51(0, 1, 1)[CH_C], 1)).toBe(true);
		expect(close(pointGains51(-1, 1, 1)[CH_L], 1)).toBe(true);
		expect(close(pointGains51(1, 1, 0.5)[CH_R], 1)).toBe(true);
		expect(close(pointGains51(-1, -1, 1)[CH_LS], 1)).toBe(true);
		expect(close(pointGains51(1, -1, 1)[CH_RS], 1)).toBe(true);
		// phantom centre at 0 % centre: −3 dB each side
		let g = pointGains51(0, 1, 0);
		expect(close(g[CH_L], K) && close(g[CH_R], K) && g[CH_C] === 0).toBe(true);
		// room centre: −3 dB front/rear, then −3 dB left/right
		g = pointGains51(0, 0, 0);
		expect(close(g[CH_L], 0.5) && close(g[CH_R], 0.5) && close(g[CH_LS], 0.5) && close(g[CH_RS], 0.5)).toBe(
			true,
		);
		// 50 % centre at front centre: half the power to C
		g = pointGains51(0, 1, 0.5);
		expect(close(g[CH_C] * g[CH_C], 0.5) && close(g[CH_L] * g[CH_L] + g[CH_R] * g[CH_R], 0.5)).toBe(true);
	});

	it('panner matrices', () => {
		// 5.1 through the default panner is the identity
		const m = pan51Matrix('5.1', DEFAULT_PAN51);
		m.forEach((row, o) => {
			row.forEach((g, i) => {
				expect(g, `out ${o} in ${i}`).toBe(o === i ? 1 : 0);
			});
		});
		expect(pan51Matrix('5.1')).toEqual(m);
		// stereo at front centre: L → L, R → R
		let s = pan51Matrix('stereo', { ...DEFAULT_PAN51, lfeGain: 0 });
		expect(
			close(s[CH_L][0], 1) && close(s[CH_R][1], 1) && Math.abs(s[CH_C][0]) < 1e-6 && s[CH_LFE][0] === 0,
		).toBe(true);
		// mono at the default puck: centre only; LFE gain = mean of inputs
		s = pan51Matrix('mono', { ...DEFAULT_PAN51, lfeGain: 0.5 });
		expect(close(s[CH_C][0], 1) && close(s[CH_LFE][0], 0.5)).toBe(true);
		s = pan51Matrix('stereo', { ...DEFAULT_PAN51, lfeGain: 0.5 });
		expect(close(s[CH_LFE][0], 0.25) && close(s[CH_LFE][1], 0.25)).toBe(true);
		// every source channel keeps unit power (LFE aside)
		for (const l of LAYOUTS) {
			const mm = pan51Matrix(l, { x: 0.37, y: -0.21, center: 0.6, lfeGain: 0 });
			for (let i = 0; i < channelCount(l); i++) {
				if (l === '5.1' && i === CH_LFE) continue;
				const pw = mm.reduce((acc, row) => acc + row[i] * row[i], 0);
				expect(Math.abs(pw - 1)).toBeLessThan(1e-5);
			}
		}
		// puck hard rear-left: 5.1 front channels collapse towards the rear left
		s = pan51Matrix('5.1', { x: -1, y: -1, center: 1, lfeGain: 1 });
		expect(close(s[CH_LS][CH_L], 1) && close(s[CH_LS][CH_C], 1) && close(s[CH_LS][CH_LS], 1)).toBe(true);
	});
});
