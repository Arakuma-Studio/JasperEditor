// Spec 19 TL-116: a frame against an output gamut and the legal range.
import { describe, expect, it } from 'vitest';
import { checkGamut, defaultWorkingSettings, GAMUT_FLAG, gamutMask, LEGAL_FLAG } from '../src/index.ts';

function frame(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Uint8Array {
	const px = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			px.set(paint(x, y), (y * w + x) * 4);
			px[(y * w + x) * 4 + 3] = 255;
		}
	return px;
}

describe('gamut check (TL-116)', () => {
	it('a Rec. 709 frame is inside Rec. 709', () => {
		const px = frame(16, 16, (x, y) => [x * 17, y * 17, 128]);
		const r = checkGamut(px, 16, 16, defaultWorkingSettings('rec709'), 'rec709');
		expect(r.gamutPercent).toBe(0);
	});

	it('saturated Rec. 2020 is outside Rec. 709 and inside Rec. 2020', () => {
		const px = frame(10, 10, (x) => (x < 5 ? [255, 0, 0] : [128, 128, 128]));
		const out = checkGamut(px, 10, 10, defaultWorkingSettings('rec2020'), 'rec709');
		expect(out.gamutPercent).toBe(50);
		expect(out.flags[0]! & GAMUT_FLAG).toBe(GAMUT_FLAG);
		expect(out.flags[9]! & GAMUT_FLAG).toBe(0);
		const same = checkGamut(px, 10, 10, defaultWorkingSettings('rec2020'), 'rec2020');
		expect(same.gamutPercent).toBe(0);
	});

	it('Rec. 709 fits inside Rec. 2020: a wider output flags nothing', () => {
		const px = frame(4, 4, () => [255, 0, 0]);
		expect(checkGamut(px, 4, 4, defaultWorkingSettings('rec709'), 'rec2020').gamutPercent).toBe(0);
	});

	it('flat colours never break the legal range: no chroma to average', () => {
		for (const c of [
			[255, 255, 255],
			[0, 0, 0],
			[255, 0, 0],
			[0, 255, 0],
			[0, 0, 255],
			[255, 255, 0],
		] as [number, number, number][]) {
			const r = checkGamut(frame(8, 8, () => c), 8, 8, defaultWorkingSettings('rec709'), 'rec709');
			expect(r.legalPercent).toBe(0);
		}
	});

	it('a thin saturated line on black breaks it after 4:2:0, as EBU R 103 measures', () => {
		// One column of pure green beside black: the black neighbour gets its chroma and comes back with R and B below −5 %.
		const px = frame(8, 8, (x) => (x === 2 ? [0, 255, 0] : [0, 0, 0]));
		const r = checkGamut(px, 8, 8, defaultWorkingSettings('rec709'), 'rec709');
		expect(r.legalPercent).toBeGreaterThan(0);
		const hit = [...r.flags].findIndex((f) => f & LEGAL_FLAG);
		expect(hit % 8).toBe(3);
	});

	it('counts a pixel flagged both ways once', () => {
		const px = frame(8, 8, (x) => (x === 2 ? [255, 0, 0] : [0, 0, 0]));
		const r = checkGamut(px, 8, 8, defaultWorkingSettings('rec2020'), 'rec709');
		expect(r.anyPercent).toBeLessThanOrEqual(r.gamutPercent + r.legalPercent);
		expect(r.anyPercent).toBeGreaterThanOrEqual(Math.max(r.gamutPercent, r.legalPercent));
	});

	it('odd frame sizes reach the last row and column, and a 1 × 1 frame is fine', () => {
		const px = frame(5, 3, (x, y) => (x === 4 && y === 2 ? [0, 0, 255] : [0, 0, 0]));
		const r = checkGamut(px, 5, 3, defaultWorkingSettings('rec709'), 'rec709');
		expect(Number.isFinite(r.legalPercent)).toBe(true);
		expect(checkGamut(frame(1, 1, () => [9, 9, 9]), 1, 1, defaultWorkingSettings('rec709'), 'rec709').anyPercent).toBe(0);
		expect(checkGamut(new Uint8Array(0), 0, 0, defaultWorkingSettings('rec709'), 'rec709').anyPercent).toBe(0);
	});

	it('the mask is transparent where a pixel passes, and colours the two kinds apart', () => {
		const flags = new Uint8Array([0, GAMUT_FLAG, LEGAL_FLAG, GAMUT_FLAG | LEGAL_FLAG]);
		const m = gamutMask({ flags, gamutPercent: 0, legalPercent: 0, anyPercent: 0 }, 4, 1);
		expect(m[3]).toBe(0);
		expect([...m.subarray(4, 8)]).toEqual([255, 0, 255, 255]);
		expect([...m.subarray(8, 12)]).toEqual([255, 176, 0, 255]);
		expect([...m.subarray(12, 16)]).toEqual([255, 0, 255, 255]);
	});

	it('refuses an unknown space', () => {
		expect(() => checkGamut(new Uint8Array(4), 1, 1, defaultWorkingSettings('rec709'), 'cmyk')).toThrow(RangeError);
	});
});
