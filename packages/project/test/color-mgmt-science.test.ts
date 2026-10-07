// color-mgmt: colour science against published test vectors (ITU-R, SMPTE, Academy and camera vendors' documents).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	ACES_WHITE,
	bradford,
	bt2390Eetf,
	COLOR_SPACES,
	type ColorMatrix,
	colorSpace,
	curveDecode,
	curveEncode,
	D65,
	defaultWorkingSettings,
	desaturateIntoGamut,
	displaySpaceFor,
	GAMUT_IDS,
	gamutCompress,
	gamutLuma,
	gamutMatrix,
	gamutToXyz,
	gamutWithin,
	gradeSpace,
	hdrPeakNits,
	hlgDecode,
	hlgEncode,
	inputTransformFn,
	inv3,
	LOG_CURVE_IDS,
	LOG_CURVES,
	logDecode,
	logEncode,
	mul3,
	nitsOfWorkingSignal,
	normalizedFromSignal,
	outputTransformFn,
	parseColorSpace,
	pqDecode,
	pqEncode,
	pqFromNits,
	type Rgb,
	signalFromNormalized,
	spaceFromStreamTags,
	toneMapNits,
	WORKING_SPACE_IDS,
	workingSignalOfNits,
} from '../src/index.ts';

const close = (a: number, b: number, tol: number) =>
	expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tol);
const closeM = (m: ColorMatrix, want: readonly number[], tol: number) => {
	for (let k = 0; k < 9; k++) close(m[k]!, want[k]!, tol);
};
const run = (fn: ((c: Rgb) => void) | null, c: Rgb): Rgb => {
	const o: Rgb = [c[0], c[1], c[2]];
	fn?.(o);
	return o;
};

describe('matrices (SMPTE RP 177, BT.2087, ACES, Bradford)', () => {
	it('BT.709 RGB→XYZ equals the published matrix (IEC 61966-2-1, 4 places)', () => {
		closeM(
			gamutToXyz('bt709'),
			[0.4124, 0.3576, 0.1805, 0.2126, 0.7152, 0.0722, 0.0193, 0.1192, 0.9505],
			1e-4,
		);
	});
	it('BT.2020 luma coefficients (BT.2020-2 Table 4)', () => {
		const l = gamutLuma('bt2020');
		close(l[0], 0.2627, 1e-4);
		close(l[1], 0.678, 1e-4);
		close(l[2], 0.0593, 1e-4);
	});
	it('BT.709 → BT.2020 equals ITU-R BT.2087-0 eq. 4', () => {
		closeM(
			gamutMatrix('bt709', 'bt2020'),
			[0.6274, 0.3293, 0.0433, 0.0691, 0.9195, 0.0114, 0.0164, 0.088, 0.8956],
			1e-4,
		);
	});
	it('ACES AP0/AP1 NPMs and AP0→AP1 equal SMPTE ST 2065-1 / Academy S-2014-004', () => {
		closeM(
			gamutToXyz('ap0'),
			[0.9525523959, 0, 0.0000936786, 0.3439664498, 0.7281660966, -0.0721325464, 0, 0, 1.0088251844],
			1e-9,
		);
		closeM(
			gamutToXyz('ap1'),
			[
				0.6624541811, 0.1340042065, 0.156187687, 0.2722287168, 0.6740817658, 0.0536895174, -0.0055746495,
				0.0040607335, 1.0103391003,
			],
			1e-9,
		);
		closeM(
			gamutMatrix('ap0', 'ap1'),
			[
				1.4514393161, -0.2365107469, -0.2149285693, -0.0765537734, 1.1762296998, -0.0996759264, 0.0083161484,
				-0.0060324498, 0.9977163014,
			],
			1e-9,
		);
	});
	it('Rec.709 → ACES2065-1 with Bradford equals the OCIO studio config matrix', () => {
		closeM(
			gamutMatrix('bt709', 'ap0'),
			[
				0.439632981919491, 0.382988698151554, 0.177378319928955, 0.0897764429588423, 0.813439428748981,
				0.0967841282921771, 0.0175411703831727, 0.111546553302387, 0.87091227631444,
			],
			1e-6,
		);
	});
	it('Bradford D65 → D50 equals the published ICC/Lindbloom matrix', () => {
		// Lindbloom's whites as XYZ: D65 (0.95047, 1, 1.08883), D50 (0.96422, 1, 0.82521)
		const xy = (X: number, Z: number) => [X / (X + 1 + Z), 1 / (X + 1 + Z)] as const;
		closeM(
			bradford(xy(0.95047, 1.08883), xy(0.96422, 0.82521)),
			[1.0478112, 0.0228866, -0.050127, 0.0295424, 0.9904844, -0.0170491, -0.0092345, 0.0150436, 0.7521316],
			1e-6,
		);
		closeM(bradford(D65, D65), [1, 0, 0, 0, 1, 0, 0, 0, 1], 0);
	});
	it('camera gamut NPMs equal the vendors’ published RGB→XYZ matrices', () => {
		closeM(
			gamutToXyz('sgamut3cine'),
			[
				0.59908392, 0.248925516, 0.10244649, 0.21507582, 0.885068502, -0.100144322, -0.032065849,
				-0.027658391, 1.148781596,
			],
			1e-6,
		);
		closeM(
			gamutToXyz('vgamut'),
			[0.679644, 0.152211, 0.1186, 0.260686, 0.774894, -0.03558, -0.00931, -0.004612, 1.10298],
			1e-5,
		);
		closeM(
			gamutToXyz('awg3'),
			[0.638008, 0.214704, 0.097744, 0.291954, 0.823841, -0.115795, 0.002798, -0.067034, 1.153294],
			1e-5,
		);
		closeM(
			gamutToXyz('rwg'),
			[0.735275, 0.068609, 0.146571, 0.286694, 0.842979, -0.129673, -0.079681, -0.347343, 1.516082],
			1e-5,
		);
	});
	it('every gamut maps white to white, conversions invert, and nesting is detected', () => {
		for (const a of GAMUT_IDS) {
			if (a === 'ap0' || a === 'ap1' || a === 'p3dci') continue; // non-D65 whites adapt (white → D65 white)
			const m = gamutMatrix(a, 'bt709');
			const w = [m[0] + m[1] + m[2], m[3] + m[4] + m[5], m[6] + m[7] + m[8]];
			for (const v of w) close(v, 1, 1e-6);
			closeM(mul3(gamutMatrix('bt709', a), m), [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-9);
		}
		expect(gamutWithin('bt709', 'bt2020')).toBe(true);
		expect(gamutWithin('p3d65', 'bt2020')).toBe(true);
		expect(gamutWithin('bt2020', 'bt709')).toBe(false);
		expect(gamutWithin('sgamut3cine', 'bt2020')).toBe(false);
		expect(() => inv3([1, 2, 3, 2, 4, 6, 0, 0, 1])).toThrow(RangeError);
		expect(ACES_WHITE).toEqual([0.32168, 0.33767]);
	});
});

describe('transfer functions', () => {
	it('PQ (SMPTE ST 2084) reference points', () => {
		close(pqFromNits(100), 0.5081, 1e-4);
		close(pqFromNits(203), 0.5807, 1e-4); // BT.2408 Table 1: 58 %
		close(pqFromNits(1000), 0.7518, 1e-4);
		close(pqFromNits(10000), 1, 1e-12);
		close(pqFromNits(0), 7.3e-7, 1e-6);
		for (const n of [0.01, 1, 48, 203, 600, 4000, 10000])
			close(pqDecode(pqEncode(n / 10000)) * 10000, n, n * 1e-9 + 1e-9);
	});
	it('HLG (BT.2100) reference points and the 75 % ↔ 203 cd/m² relation (BT.2408)', () => {
		close(hlgEncode(1 / 12), 0.5, 1e-12);
		close(hlgEncode(1), 1, 1e-7);
		const e = hlgDecode(0.75);
		close(1000 * e ** 1.2, 203, 0.5);
		for (const x of [0, 0.01, 1 / 12, 0.3, 1]) close(hlgDecode(hlgEncode(x)), x, 1e-12);
	});
	it('sRGB, BT.709 OETF, BT.1886, ACEScct reference points', () => {
		close(curveDecode('srgb', 0.5), 0.214041, 1e-6);
		close(curveEncode('bt709', 0.01), 0.045, 1e-12);
		close(curveEncode('bt709', 0.018), 0.0812, 1e-4);
		close(curveEncode('bt709', 1), 1, 1e-12);
		close(curveDecode('bt1886', 0.5), 0.5 ** 2.4, 1e-15);
		close(curveEncode('acescct', 0.18), 0.4135884, 1e-6); // S-2016-001: 18 % grey
		close(curveEncode('acescc', 0.18), 0.4135884, 1e-6);
		close(curveEncode('acescct', 0), 0.0729055341958355, 1e-15);
	});
	it('every curve round-trips (property)', () => {
		const curves = ['srgb', 'bt1886', 'gamma22', 'gamma26', 'bt709', 'bt2020', 'acescct'] as const;
		fc.assert(
			fc.property(fc.constantFrom(...curves), fc.double({ min: -0.5, max: 4, noNaN: true }), (c, x) => {
				const back = curveDecode(c, curveEncode(c, x));
				return Math.abs(back - x) <= 1e-9 * Math.max(1, Math.abs(x));
			}),
		);
	});
});

describe('camera log curves (manufacturers’ published reference points)', () => {
	const cv = (id: keyof typeof LOG_CURVES, x: number) => {
		const y = logEncode(id, x);
		return LOG_CURVES[id].domain === 'cv' ? y * 1023 : 64 + y * 876;
	};
	it('code values of 0 %, 18 % and 90 % reflectance', () => {
		close(cv('slog3', 0), 95, 0.01);
		close(cv('slog3', 0.18), 420, 0.01);
		close(cv('slog3', 0.9), 598, 0.5);
		close(cv('slog2', 0.18), 347, 0.5);
		close(cv('slog2', 0.9), 582, 0.5);
		close(cv('vlog', 0), 128, 0.5);
		close(cv('vlog', 0.18), 433, 0.5);
		close(cv('vlog', 0.9), 602, 0.5);
		close(logEncode('logc3', 0.18), 0.391, 0.0006);
		close(cv('logc3', 0.18), 400, 0.5);
		close(logEncode('logc4', 0.18), 0.2784, 0.0005);
		close(logEncode('logc4', 0), 95 / 1023, 1e-9);
		close(logEncode('clog2', 0.18) * 100, 39.2, 0.7);
		close(logEncode('clog3', 0.18) * 100, 34.3, 0.2);
		close(logEncode('clog', 0.18) * 100, 34.3, 0.2);
		close(logEncode('applelog', 0.18), 0.488, 0.001);
		close(logEncode('dlog', 0), 0.0929, 1e-9);
		close(logEncode('dlog', 0.18), 0.398, 0.002);
		close(logEncode('log3g10', 0.18), 1 / 3, 1e-4); // RED: mid grey → 1/3
		close(logEncode('log3g10', -0.01), 0, 1e-12);
		close(cv('flog', 0.18), 470, 0.5); // Fujifilm F-Log: 18 % → 470
		close(cv('flog', 0), 95, 0.5);
		close(cv('flog2', 0.18), 400, 1);
		close(cv('nlog', 0.18), 372, 1);
		close(logEncode('bmdfilm5', 0.18), 0.3835, 0.001);
		close(logEncode('davinci', 0.18), 0.336, 0.001);
		close(cv('cineon', 1), 685, 1e-6); // Kodak: reference white at code 685, black at 95
		close(cv('cineon', 0), 95, 1e-6);
	});
	it('every curve round-trips over −1 %…40× grey and is increasing', () => {
		for (const id of LOG_CURVE_IDS) {
			for (let i = 0; i <= 400; i++) {
				const x = -0.01 + (i / 400) ** 3 * 8;
				if (id === 'applelog' && x < -0.0564) continue; // no code values below Apple Log's black floor
				if (id === 'nlog' && x <= -0.0075) continue;
				const back = logDecode(id, logEncode(id, x));
				expect(Math.abs(back - x), `${id} ${x}`).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(x)) + 1e-9);
			}
			let prev = Number.NEGATIVE_INFINITY;
			for (let i = 0; i <= 1000; i++) {
				const y = logEncode(id, i / 100);
				expect(y, id).toBeGreaterThan(prev);
				prev = y;
			}
		}
	});
	it('domain conversion with the file range (limited code 420 = S-Log3 grey)', () => {
		for (const r of ['tv', 'pc'] as const)
			for (const d of ['cv', 'ire'] as const)
				for (const v of [0, 0.25, 0.8, 1])
					close(normalizedFromSignal(signalFromNormalized(v, r, d), r, d), v, 1e-12);
		const s = signalFromNormalized((420 - 64) / 876, 'tv', 'cv');
		close(logDecode('slog3', s), 0.18, 1e-6);
	});
});

describe('tone and gamut mapping', () => {
	it('BT.2390 EETF: identity below the knee, monotone, hits the target peak', () => {
		close(bt2390Eetf(1, 1000, 203), 1, 1e-3);
		close(bt2390Eetf(1000, 1000, 203), 203, 0.5);
		let prev = 0;
		for (let i = 1; i <= 1000; i++) {
			const y = bt2390Eetf(i, 1000, 203);
			expect(y).toBeGreaterThanOrEqual(prev - 1e-3);
			expect(y).toBeLessThanOrEqual(203.05);
			prev = y;
		}
		const rw = bt2390Eetf(203, 1000, 203) / 203;
		expect(rw).toBeGreaterThan(0.7);
		expect(rw).toBeLessThan(0.9);
		expect(bt2390Eetf(500, 203, 1000)).toBe(500);
	});
	it('tone mapping keeps hue and maps the peak', () => {
		const c: Rgb = [800, 400, 200];
		toneMapNits(c, 1000, 203);
		close(c[0] / c[1], 2, 1e-9);
		close(c[1] / c[2], 2, 1e-9);
		const p: Rgb = [1000, 1000, 1000];
		toneMapNits(p, 1000, 203);
		close(p[0], 203, 0.5);
	});
	it('ACES RGC leaves the inner gamut alone and brings colours to the limit inside', () => {
		for (const c of [
			[0.5, 0.4, 0.3],
			[1, 0.25, 0.25],
			[0.2, 0.2, 0.2],
		] as Rgb[]) {
			const o: Rgb = [c[0], c[1], c[2]];
			gamutCompress(o);
			expect(o).toEqual(c);
		}
		// distance at the limit (1.147 for cyan) comes back to the gamut boundary (distance 1 → value 0)
		const lim: Rgb = [1, 1 - 1.264, 1 - 1.312];
		gamutCompress(lim);
		close(lim[1], 0, 1e-9);
		close(lim[2], 0, 1e-9);
		const o: Rgb = [1, -0.2, 0.3];
		gamutCompress(o);
		expect(o.every((v) => v >= 0)).toBe(true);
		expect(o[0] > o[2] && o[2] > o[1]).toBe(true);
	});
	it('desaturation into a gamut keeps luminance', () => {
		const l = gamutLuma('bt709');
		const c: Rgb = [0.6, -0.1, 0.2];
		const y0 = l[0] * c[0] + l[1] * c[1] + l[2] * c[2];
		desaturateIntoGamut(c, l);
		close(l[0] * c[0] + l[1] * c[1] + l[2] * c[2], y0, 1e-12);
		close(Math.min(...c), 0, 1e-12);
	});
	it('HDR peak from static metadata', () => {
		expect(hdrPeakNits(null)).toBeNull();
		expect(hdrPeakNits({ masteringMaxNits: 4000, maxCll: 1200 })).toBe(1200);
		expect(hdrPeakNits({ masteringMaxNits: 0, maxCll: 0 })).toBeNull();
		expect(hdrPeakNits({ masteringMaxNits: 50 })).toBe(203);
	});
});

describe('spaces and transforms', () => {
	it('every space has a unique id and parses from its id and label', () => {
		expect(new Set(COLOR_SPACES.map((s) => s.id)).size).toBe(COLOR_SPACES.length);
		for (const s of COLOR_SPACES) {
			expect(parseColorSpace(s.id)?.id).toBe(s.id);
			expect(parseColorSpace(s.label)?.id).toBe(s.id);
		}
		expect(parseColorSpace('Rec. 2100 PQ')?.id).toBe('rec2100-pq');
		expect(parseColorSpace('nonsense')).toBeUndefined();
		for (const id of WORKING_SPACE_IDS) expect(colorSpace(id)?.tags).not.toBeNull();
	});
	it('auto-detection from stream tags', () => {
		expect(spaceFromStreamTags({ primaries: 'bt2020', transfer: 'smpte2084' }).id).toBe('rec2100-pq');
		expect(spaceFromStreamTags({ primaries: 'bt2020', transfer: 'arib-std-b67' }).id).toBe('rec2100-hlg');
		expect(spaceFromStreamTags({ primaries: 'bt2020', transfer: 'bt2020-10' }).id).toBe('rec2020');
		expect(spaceFromStreamTags({ primaries: 'bt709', transfer: 'bt709' }).id).toBe('rec709');
		expect(spaceFromStreamTags({ primaries: 'unknown', transfer: 'unknown' }).id).toBe('rec709');
		expect(spaceFromStreamTags({ primaries: 'smpte432', transfer: 'iec61966-2-1' }).id).toBe('displayp3');
		expect(spaceFromStreamTags({ transfer: 'iec61966-2-1' }).id).toBe('srgb');
		expect(spaceFromStreamTags({ transfer: 'iec61966-2-1' }, { still: true }).id).toBe('rec709');
		expect(spaceFromStreamTags({ transfer: 'iec61966-2-1' }, { still: true, workingCurve: 'srgb' }).id).toBe(
			'srgb',
		);
	});
	it('same space is the identity; Rec.709 into Rec.2020 is BT.2087 in linear light', () => {
		const w709 = defaultWorkingSettings('rec709');
		expect(inputTransformFn({ space: 'rec709' }, w709)).toBeNull();
		const fn = inputTransformFn({ space: 'rec709' }, defaultWorkingSettings('rec2020'));
		const red = run(fn, [1, 0, 0]);
		close(red[0], 0.6274 ** (1 / 2.4), 1e-4);
		close(red[1], 0.0691 ** (1 / 2.4), 1e-4);
		const grey = run(fn, [0.5, 0.5, 0.5]);
		for (const v of grey) close(v, 0.5, 1e-12);
	});
	it('SDR into PQ maps SDR white to the graphics white (203 cd/m² → PQ 58 %)', () => {
		const fn = inputTransformFn({ space: 'rec709' }, defaultWorkingSettings('rec2100-pq'));
		const w = run(fn, [1, 1, 1]);
		for (const v of w) close(v, pqFromNits(203), 1e-9);
		const fn100 = inputTransformFn(
			{ space: 'rec709' },
			{ ...defaultWorkingSettings('rec2100-pq'), sdrWhiteNits: 100 },
		);
		close(run(fn100, [1, 1, 1])[0], pqFromNits(100), 1e-9);
	});
	it('SDR into HLG: SDR white at 203 cd/m² is the 75 % HLG signal (BT.2408)', () => {
		const fn = inputTransformFn({ space: 'rec709' }, defaultWorkingSettings('rec2100-hlg'));
		close(run(fn, [1, 1, 1])[0], 0.75, 0.002);
	});
	it('PQ and HLG convert into each other through display light', () => {
		const pq = defaultWorkingSettings('rec2100-pq');
		const hlg = defaultWorkingSettings('rec2100-hlg');
		const toPq = inputTransformFn({ space: 'rec2100-hlg' }, pq);
		close(run(toPq, [0.75, 0.75, 0.75])[0], pqFromNits(203), 0.002);
		const toHlg = inputTransformFn({ space: 'rec2100-pq' }, hlg);
		close(run(toHlg, [pqFromNits(203), pqFromNits(203), pqFromNits(203)])[0], 0.75, 0.002);
	});
	it('log into Rec.709: 18 % grey lands at 26/203 of SDR white (BT.2408 OOTF), neutral and in range', () => {
		const w = defaultWorkingSettings('rec709');
		for (const s of COLOR_SPACES.filter((x) => x.group === 'Camera log')) {
			const curve = LOG_CURVES[s.curve as keyof typeof LOG_CURVES];
			const grey = normalizedFromSignal(curve.encode(0.18), 'tv', curve.domain);
			const fn = inputTransformFn({ space: s.id, range: 'tv' }, w);
			const g = run(fn, [grey, grey, grey]);
			for (const v of g) close(v, (26 / 203) ** (1 / 2.4), 0.012);
			const red = run(fn, [0.9, grey, grey]);
			expect(red.every((v) => v >= 0 && v <= 1)).toBe(true);
		}
	});
	it('PQ into Rec.709 is tone mapped: 1000 cd/m² reaches SDR white, dark tones unchanged', () => {
		const fn = inputTransformFn({ space: 'rec2100-pq', peakNits: 1000 }, defaultWorkingSettings('rec709'));
		const top = run(fn, [pqFromNits(1000), pqFromNits(1000), pqFromNits(1000)]);
		close(top[0], 1, 0.01);
		const dark = run(fn, [pqFromNits(10), pqFromNits(10), pqFromNits(10)]);
		close(dark[0], (10 / 203) ** (1 / 2.4), 0.003);
		const off = inputTransformFn({ space: 'rec2100-pq', toneMap: false }, defaultWorkingSettings('rec709'));
		close(run(off, [pqFromNits(1000), 0, 0])[0], 1, 1e-12); // clipped
	});
	it('output transforms: HDR working → SDR display is tone mapped, SDR working → its display keeps the curve', () => {
		expect(outputTransformFn(defaultWorkingSettings('rec709'), displaySpaceFor('rec709'))).toBeNull();
		expect(outputTransformFn(defaultWorkingSettings('srgb'), displaySpaceFor('srgb'))).toBeNull();
		const d2020 = outputTransformFn(defaultWorkingSettings('rec2020'), displaySpaceFor('rec2020'));
		const back = run(
			d2020,
			run(inputTransformFn({ space: 'rec709' }, defaultWorkingSettings('rec2020')), [0.8, 0.3, 0.1]),
		);
		close(back[0], 0.8, 1e-9);
		close(back[1], 0.3, 1e-9);
		close(back[2], 0.1, 1e-9);
		const dpq = outputTransformFn(defaultWorkingSettings('rec2100-pq'), displaySpaceFor('rec2100-pq'));
		close(run(dpq, [pqFromNits(1000), pqFromNits(1000), pqFromNits(1000)])[0], 1, 0.01);
		const toPq = outputTransformFn(defaultWorkingSettings('rec709'), 'rec2100-pq');
		close(run(toPq, [1, 1, 1])[0], pqFromNits(203), 1e-9);
	});
	it('the grading signal of PQ/HLG (1 = HDR White) round-trips', () => {
		const pq = gradeSpace('rec2100-pq', 1000)!;
		const c: Rgb = [pqFromNits(1000), pqFromNits(203), pqFromNits(4000)];
		const g: Rgb = [...c];
		pq.toGrade(g);
		close(g[0], 1, 1e-12);
		expect(g[2]).toBeGreaterThan(1);
		pq.fromGrade(g);
		for (let k = 0; k < 3; k++) close(g[k]!, c[k]!, 1e-12);
		const hlg = gradeSpace('rec2100-hlg', 1000)!;
		const h: Rgb = [0.75, 0.5, 0.9];
		const hg: Rgb = [...h];
		hlg.toGrade(hg);
		hlg.fromGrade(hg);
		for (let k = 0; k < 3; k++) close(hg[k]!, h[k]!, 1e-9);
		expect(gradeSpace('rec709', 1000)).toBeNull();
	});
	it('nits scale of the scopes', () => {
		close(nitsOfWorkingSignal('rec2100-pq', pqFromNits(1000)), 1000, 1e-6);
		close(nitsOfWorkingSignal('rec2100-hlg', 0.75), 203, 0.5);
		close(workingSignalOfNits('rec2100-hlg', 1000), 1, 1e-7);
		close(nitsOfWorkingSignal('rec709', 1), 100, 1e-12);
	});
	it('every transform keeps outputs finite and in 0…1 (property)', () => {
		const spaces = COLOR_SPACES.map((s) => s.id);
		fc.assert(
			fc.property(
				fc.constantFrom(...spaces),
				fc.constantFrom(...WORKING_SPACE_IDS),
				fc.tuple(
					fc.double({ min: 0, max: 1, noNaN: true }),
					fc.double({ min: 0, max: 1, noNaN: true }),
					fc.double({ min: 0, max: 1, noNaN: true }),
				),
				(s, w, c) => {
					const out = run(inputTransformFn({ space: s }, defaultWorkingSettings(w)), c as Rgb);
					return out.every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
				},
			),
			{ numRuns: 2000 },
		);
	});
});
