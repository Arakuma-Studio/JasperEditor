// color-grade: Colour Match (FilmCraft color_match.rs port, solved into Lumetri wheels / levels / saturation) and
// Auto tone. Synthetic frames with known grades, as FilmCraft's tests, plus face-box skin protection and Auto.
import { describe, expect, it } from 'vitest';
import {
	autoTone,
	type ColorMatchResult,
	cropLetterbox,
	gradeMatchImage,
	type MatchImage,
	matchParams,
	matchStats,
	oklab,
	skinWeight,
	solveColorMatch,
	tonalWeights,
} from '../src/index.ts';

const enc = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/** A lightness ramp with colour bands and an optional skin block (linear values → encoded). */
function frame(skin: boolean): MatchImage {
	const w = 192;
	const h = 108;
	const rgb = new Float32Array(w * h * 3);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const t = x / w;
			let c = [t * t, t * t * 0.9 + 0.02, t * 0.8 * t + 0.03];
			if (y < h / 3) c = [c[0]! * 0.6, c[1]! * 1.1, c[2]! * 0.7];
			else if (y > (2 * h) / 3) c = [c[0]! * 0.8, c[1]! * 0.85, c[2]! * 1.2];
			if (skin && x >= 60 && x < 120 && y >= 40 && y < 70) c = [0.55, 0.32, 0.22];
			const i = (y * w + x) * 3;
			rgb[i] = enc(Math.min(1, c[0]!));
			rgb[i + 1] = enc(Math.min(1, c[1]!));
			rgb[i + 2] = enc(Math.min(1, c[2]!));
		}
	return { w, h, rgb };
}

const xOf = (m: ColorMatchResult) => [
	...m.shadowsWheel,
	...m.midtonesWheel,
	...m.highlightsWheel,
	m.shadowsLevel / 100,
	m.midtonesLevel / 100,
	m.highlightsLevel / 100,
	m.saturation / 100 - 1,
];
const graded = (img: MatchImage, x: number[]) => gradeMatchImage(img, matchParams({}, x));

describe('Colour Match (Oklab statistics, Levenberg–Marquardt into Lumetri)', () => {
	it('Oklab reference values and the weights', () => {
		const w = oklab(1, 1, 1);
		expect(Math.abs(w[0] - 1)).toBeLessThan(1e-3);
		expect(Math.abs(w[1])).toBeLessThan(1e-3);
		const r = oklab(1, 0, 0);
		expect(Math.abs(r[0] - 0.6279)).toBeLessThan(2e-3);
		expect(Math.abs(r[1] - 0.2249)).toBeLessThan(2e-3);
		expect(Math.abs(r[2] - 0.1258)).toBeLessThan(2e-3);
		const t = tonalWeights(0.1);
		expect(t[0]).toBeGreaterThan(0.99);
		expect(t[2]).toBe(0);
		expect(skinWeight(oklab(0.55, 0.32, 0.22))).toBeGreaterThan(0.9);
		expect(skinWeight(oklab(0.2, 0.3, 0.8))).toBe(0);
	});

	it('matching a frame to itself changes nothing', () => {
		const f = frame(false);
		const m = solveColorMatch(f, f, {}, { faceDetection: false });
		expect(m.before).toBeLessThan(1e-4);
		for (const v of [...m.shadowsWheel, ...m.midtonesWheel, ...m.highlightsWheel])
			expect(Math.abs(v)).toBeLessThan(0.02);
		expect(Math.abs(m.midtonesLevel)).toBeLessThan(2);
		expect(Math.abs(m.saturation - 100)).toBeLessThan(2);
	});

	it('recovers a known grade (statistics within 0.02)', () => {
		const f = frame(false);
		const truth = [-0.3, -0.2, 0, 0.1, 0.35, 0.15, 0.1, 0, -0.05, 0.2];
		const reference = graded(f, truth);
		const m = solveColorMatch(f, reference, {}, { faceDetection: false });
		// `after` includes the parameter penalty (λ²·|x|², ≈ 0.012 at the truth itself), so the bound is relative.
		expect(m.after).toBeLessThan(m.before * 0.25);
		const out = matchStats(graded(f, xOf(m)), false);
		const want = matchStats(reference, false);
		for (let k = 0; k < 3; k++)
			for (let c = 1; c < 4; c++) expect(Math.abs(out.bands[k]![c]! - want.bands[k]![c]!)).toBeLessThan(0.02);
	});

	it('skin protection limits the skin hue shift to 8°', () => {
		const f = frame(true);
		const reference = graded(f, [-0.6, 0.5, -0.6, 0.5, -0.5, 0.4, 0, 0, 0, 0]);
		const hue = (img: MatchImage) => {
			const s = matchStats(img, true);
			return (Math.atan2(s.skin[1], s.skin[0]) * 180) / Math.PI;
		};
		const h0 = hue(f);
		const shift = (m: ColorMatchResult) => {
			let d = Math.abs(hue(graded(f, xOf(m))) - h0);
			if (d > 180) d = 360 - d;
			return d;
		};
		const free = solveColorMatch(f, reference, {}, { faceDetection: false });
		const prot = solveColorMatch(f, reference, {});
		expect(prot.skin).toBe('hue');
		expect(shift(prot)).toBeLessThanOrEqual(8.5);
		expect(shift(free)).toBeGreaterThan(shift(prot));
	});

	it('Face Detection with faces: the faces weigh more and the current face colour is matched to the reference face', () => {
		const f = frame(true);
		// Reference: a teal cast on everything but the face (the face keeps its colour, as a well-lit actor would).
		const cast = graded(f, [-0.6, 0.5, -0.6, 0.5, -0.5, 0.4, 0, 0, 0, 0]);
		const reference: MatchImage = { w: f.w, h: f.h, rgb: new Float32Array(cast.rgb) };
		for (let y = 40; y < 70; y++)
			for (let x = 60; x < 120; x++)
				for (let k = 0; k < 3; k++) reference.rgb[(y * f.w + x) * 3 + k] = f.rgb[(y * f.w + x) * 3 + k]!;
		const face = { x: 60 / 192, y: 40 / 108, w: 60 / 192, h: 30 / 108 };
		const faceHueError = (m: ColorMatchResult) => {
			const opts = { faces: [face], boost: 4 };
			const a = matchStats(graded(f, xOf(m)), false, opts).face;
			const b = matchStats(reference, false, opts).face;
			let d = Math.abs((Math.atan2(a[2], a[1]) - Math.atan2(b[2], b[1])) * (180 / Math.PI));
			if (d > 180) d = 360 - d;
			return d;
		};
		const off = solveColorMatch(f, reference, {}, { faceDetection: false });
		const faces = solveColorMatch(f, reference, {}, { faces: { current: [face], reference: [face] } });
		expect(faces.skin).toBe('faces');
		expect(faces.skinShare).toBeGreaterThan(0.03);
		expect(faceHueError(faces)).toBeLessThan(faceHueError(off));
		expect(faces.skinHueShift!).toBeLessThan(faceHueError(off));
	});

	it('the face model found no faces: the whole frame counts equally (same as off)', () => {
		const f = frame(true);
		const reference = graded(f, [0.2, 0.1, 0, 0, 0, 0, 0, 0.1, 0, 0.1]);
		const none = solveColorMatch(f, reference, {}, { faces: { current: [], reference: [] } });
		const off = solveColorMatch(f, reference, {}, { faceDetection: false });
		expect(none.skin).toBe('none');
		expect(none.shadowsWheel).toEqual(off.shadowsWheel);
		expect(none.saturation).toBe(off.saturation);
	});

	it('letterbox bars do not count (a pillarboxed copy of the frame matches the frame)', () => {
		const f = frame(false);
		const W = f.w + 80;
		const rgb = new Float32Array(W * f.h * 3);
		for (let y = 0; y < f.h; y++) rgb.set(f.rgb.subarray(y * f.w * 3, (y + 1) * f.w * 3), (y * W + 40) * 3);
		const boxed: MatchImage = { w: W, h: f.h, rgb };
		const crop = cropLetterbox(boxed);
		expect([crop.w, crop.h]).toEqual([f.w, f.h]);
		const m = solveColorMatch(f, boxed, {}, { faceDetection: false });
		expect(m.before).toBeLessThan(0.01);
		expect(Math.abs(m.saturation - 100)).toBeLessThan(3);
	});

	it('keeps the instance’s other settings (base params)', () => {
		const f = frame(false);
		const reference = graded(f, [0, 0, 0.2, 0, 0, 0, 0, 0.1, 0, 0]);
		const m = solveColorMatch(f, reference, { exposure: 0.5 }, { faceDetection: false });
		expect(m.after).toBeLessThan(m.before);
		expect(Number.isFinite(m.midtonesLevel)).toBe(true);
	});
});

describe('Auto tone', () => {
	const flat = (lo: number, hi: number): MatchImage => {
		const w = 128;
		const h = 64;
		const rgb = new Float32Array(w * h * 3);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const v = lo + ((hi - lo) * x) / (w - 1);
				const i = (y * w + x) * 3;
				rgb[i] = v;
				rgb[i + 1] = v * 0.95;
				rgb[i + 2] = v * 0.9;
			}
		return { w, h, rgb };
	};
	it('brightens an under-exposed frame and stretches a flat one', () => {
		const dark = autoTone(flat(0.02, 0.4));
		expect(dark.exposure).toBeGreaterThan(0.2);
		expect(dark.after[4]!).toBeGreaterThan(dark.before[4]!);
		const low = autoTone(flat(0.35, 0.6));
		expect(low.after[4]! - low.after[0]!).toBeGreaterThan(low.before[4]! - low.before[0]! + 15);
		for (const r of [dark, low])
			for (const k of [
				'exposure',
				'contrast',
				'highlights',
				'shadows',
				'whites',
				'blacks',
				'saturation',
			] as const)
				expect(Number.isFinite(r[k])).toBe(true);
	});
	it('leaves a well exposed frame nearly alone', () => {
		const ok = autoTone(flat(0.0, 1.0));
		expect(Math.abs(ok.exposure)).toBeLessThan(0.6);
		expect(ok.saturation).toBe(100);
	});
	it('never throws on an empty or transparent frame', () => {
		expect(() => autoTone({ w: 0, h: 0, rgb: new Float32Array(0) })).not.toThrow();
		expect(() =>
			autoTone({ w: 2, h: 2, rgb: new Float32Array(12), alpha: new Float32Array(4) }),
		).not.toThrow();
	});
});
