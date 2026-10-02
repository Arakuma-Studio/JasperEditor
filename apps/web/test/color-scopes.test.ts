// Scope maths (S06:SCP-001…003): waveform, RGB parade, Rec.709 vectorscope with 75 % targets and the skin-tone
// line, histogram, density rendering and the read-back sizing.
import { describe, expect, it } from 'vitest';
import { readbackSize } from '../src/color/scopes/capture.ts';
import {
	computeScope,
	histogram,
	skinToneDirection,
	vectorscope,
	vectorscopePoint,
	vectorscopeTargets,
	waveform,
	ycbcr,
} from '../src/color/scopes/math.ts';

/** w×h frame filled by `px(x, y)` → [r, g, b] (0..255). */
function frame(w: number, h: number, px: (x: number, y: number) => [number, number, number]) {
	const d = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const [r, g, b] = px(x, y);
			d.set([r, g, b, 255], (y * w + x) * 4);
		}
	return d;
}

const nonZero = (a: Uint32Array) => [...a.keys()].filter((i) => a[i]! > 0);

describe('waveform', () => {
	it('a flat grey lands on one row per column; a horizontal ramp draws a diagonal', () => {
		const grey = frame(8, 4, () => [128, 128, 128]);
		const [p] = waveform(grey, 8, 4, 8, 101, 'luma');
		const hits = nonZero(p!.counts);
		expect(new Set(hits.map((i) => Math.floor(i / 8)))).toEqual(
			new Set([100 - Math.round((128 / 255) * 100)]),
		);
		expect(hits).toHaveLength(8);
		expect(p!.counts[hits[0]!]).toBe(4);

		const ramp = frame(11, 2, (x) => [x * 25.5, x * 25.5, x * 25.5]);
		const [q] = waveform(ramp, 11, 2, 11, 11, 'luma');
		for (let x = 0; x < 11; x++) expect(q!.counts[(10 - x) * 11 + x], `column ${x}`).toBe(2);
	});

	it('the RGB parade separates channels', () => {
		const red = frame(4, 4, () => [255, 0, 0]);
		const [r, g, b] = waveform(red, 4, 4, 4, 11, 'parade');
		expect(nonZero(r!.counts).every((i) => Math.floor(i / 4) === 0)).toBe(true);
		expect(nonZero(g!.counts).every((i) => Math.floor(i / 4) === 10)).toBe(true);
		expect(nonZero(b!.counts).every((i) => Math.floor(i / 4) === 10)).toBe(true);
	});

	it('transparent pixels are ignored', () => {
		const d = new Uint8ClampedArray(4 * 4);
		const [p] = waveform(d, 2, 2, 2, 10, 'luma');
		expect(nonZero(p!.counts)).toEqual([]);
	});
});

describe('vectorscope', () => {
	it('neutral greys sit at the centre; 75 % red hits the R target', () => {
		const size = 65;
		const grey = frame(4, 4, () => [90, 90, 90]);
		const p = vectorscope(grey, 4, 4, size);
		expect(nonZero(p.counts)).toEqual([32 * size + 32]);

		const red = frame(2, 2, () => [191, 0, 0]);
		const q = vectorscope(red, 2, 2, size);
		const [hit] = nonZero(q.counts);
		// Rec.709 places the 75 % red bar at approximately (Cb=-0.086, Cr=0.375).
		expect(hit! % size).toBe(27);
		expect(Math.floor(hit! / size)).toBe(8);
	});

	it('uses Rec.709 colour differences; targets and skin line are where colourists expect them', () => {
		const w = ycbcr(1, 1, 1);
		expect(w.y).toBeCloseTo(1, 12);
		expect(w.cb).toBeCloseTo(0, 12);
		expect(w.cr).toBeCloseTo(0, 12);
		expect(ycbcr(0, 0, 1).cb).toBeCloseTo(0.5, 12);
		expect(ycbcr(1, 0, 0).cr).toBeCloseTo(0.5, 12);
		const t = Object.fromEntries(vectorscopeTargets(0.75).map((x) => [x.name, x]));
		expect(t.R!.cb).toBeCloseTo(-0.086, 2);
		expect(t.R!.cr).toBeCloseTo(0.375, 2);
		expect(t.B!.cb).toBeGreaterThan(0);
		expect(t.Cy!.cr).toBeLessThan(0);
		// Skin tones (e.g. 224/172/140) lie close to the I line (123°).
		const dir = skinToneDirection();
		expect((Math.atan2(dir.cr, dir.cb) * 180) / Math.PI).toBeCloseTo(123, 6);
		// Top of the scope is +Cr (red side up), right is +Cb.
		expect(vectorscopePoint(0, 0.5, 101)).toEqual({ x: 50, y: 0 });
		expect(vectorscopePoint(0.5, 0, 101)).toEqual({ x: 100, y: 50 });
	});
});

describe('histogram and rendering', () => {
	it('counts code values per channel and luma', () => {
		const d = frame(
			3,
			1,
			(x) =>
				[
					[0, 0, 0],
					[255, 0, 0],
					[10, 20, 30],
				][x] as [number, number, number],
		);
		const h = histogram(d, 3, 1);
		expect(h.r[0]).toBe(1);
		expect(h.r[255]).toBe(1);
		expect(h.r[10]).toBe(1);
		expect(h.g[0]).toBe(2);
		expect(h.y[Math.round(0.2126 * 255)]).toBe(1);
		expect([...h.b].reduce((a, b) => a + b, 0)).toBe(3);
	});

	it('computeScope produces a trace image of the requested size for every mode', () => {
		const d = frame(16, 9, (x, y) => [x * 16, y * 28, 128]);
		const colors = {
			trace: [0, 255, 0] as const,
			luma: [255, 255, 255] as const,
			red: [255, 0, 0] as const,
			green: [0, 255, 0] as const,
			blue: [0, 0, 255] as const,
		};
		const base = { id: 1, data: d, width: 16, height: 9, outW: 120, outH: 64, colors };
		const wf = computeScope({ ...base, mode: 'waveform' });
		expect([wf.width, wf.height, wf.image.length]).toEqual([120, 64, 120 * 64 * 4]);
		const pa = computeScope({ ...base, mode: 'parade' });
		expect([pa.width, pa.height]).toEqual([120, 64]);
		// Parade bands: red band only has red trace pixels.
		let redOnly = true;
		for (let y = 0; y < 64; y++)
			for (let x = 0; x < 40; x++) {
				const o = (y * 120 + x) * 4;
				if (pa.image[o + 3]! > 0 && (pa.image[o + 1] !== 0 || pa.image[o + 2] !== 0)) redOnly = false;
			}
		expect(redOnly).toBe(true);
		const vs = computeScope({ ...base, mode: 'vectorscope' });
		expect([vs.width, vs.height]).toEqual([64, 64]);
		const hi = computeScope({ ...base, mode: 'histogram' });
		expect(hi.histogram?.r.length).toBe(256);
	});

	it('reads back at most 256 px wide, keeping the aspect', () => {
		expect(readbackSize(1920, 1080)).toEqual({ width: 256, height: 144 });
		expect(readbackSize(200, 100)).toEqual({ width: 200, height: 100 });
		expect(readbackSize(0, 100)).toBeNull();
	});
});
