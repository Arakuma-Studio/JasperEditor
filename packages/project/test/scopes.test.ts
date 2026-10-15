// Tests ported from FilmCraft crates/scopes/src/tests.rs (MIT OR Apache-2.0).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { budgetMs, budgetReport } from '../../../scripts/perf/budget.ts';
import {
	angleDeg,
	channelStats,
	DEFAULT_SCOPE_PARAMS,
	histogram,
	paintGrids,
	parade,
	paradeTypeFromName,
	readScopes,
	redAngle,
	rgbToYcbcr,
	rowOf,
	type ScopeGrid,
	type ScopeMatrix,
	type ScopeSignal,
	SKIN_TONE_DEG,
	scaleLabels,
	scopeIntensity,
	scopeKindFromName,
	scopeMatrixFromName,
	signalFromFn,
	signalFromRgba8,
	traceColumns,
	VECTOR_EXTENT,
	vectorCell,
	vectorPeaks,
	vectorscopeHls,
	vectorscopeYuv,
	vectorTargets,
	waveform,
	waveformReference,
	waveformTypeFromName,
	ycbcrToRgb,
} from '../src/index.ts';

function rgba8(w: number, h: number, f: (x: number, y: number) => [number, number, number]): Uint8Array {
	const px = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const [r, g, b] = f(x, y);
			px.set([r, g, b, 255], (y * w + x) * 4);
		}
	return px;
}
const solid = (w: number, h: number, c: [number, number, number]) =>
	signalFromRgba8(
		rgba8(w, h, () => c),
		w,
		h,
	);
const BAR = 191;
const BARS: [number, number, number][] = [
	[BAR, BAR, BAR],
	[BAR, BAR, 0],
	[0, BAR, BAR],
	[0, BAR, 0],
	[BAR, 0, BAR],
	[BAR, 0, 0],
	[0, 0, BAR],
	[0, 0, 0],
];
const bars = () =>
	signalFromRgba8(
		rgba8(256, 16, (x) => BARS[Math.floor(x / 32)]!),
		256,
		16,
	);
const at = (g: ScopeGrid, col: number, row: number) => g.data[row * g.cols + col]!;
const rowsIn = (g: ScopeGrid, col: number) => {
	const out: number[] = [];
	for (let r = 0; r < g.rows; r++) if (at(g, col, r) > 0) out.push(r);
	return out;
};
const trace = (w: { traces: ScopeGrid[] }, name: string) => w.traces.find((t) => t.name === name)!;
const MATRICES: ScopeMatrix[] = ['bt601', 'bt709', 'bt2020'];

/** Documented budget of one scope at 1080p (ms). */
const SCOPE_BUDGET_MS = 60;

describe('scopes maths (FilmCraft port)', () => {
	it('a single colour lands in exact histogram bins', () => {
		const s = solid(64, 36, [200, 100, 50]);
		const h = histogram(s);
		const n = 64 * 36;
		expect(h.samples).toBe(n);
		expect([h.r[200], h.g[100], h.b[50]]).toEqual([n, n, n]);
		const [y] = rgbToYcbcr(200 / 255, 100 / 255, 50 / 255, 'bt709');
		expect(h.y[Math.round(y * 255)]).toBe(n);
		expect([h.below, h.above]).toEqual([
			[0, 0, 0, 0],
			[0, 0, 0, 0],
		]);
	});

	it('a ramp fills every bin and the waveform row equals the code value', () => {
		const s = signalFromRgba8(
			rgba8(256, 10, (x) => [x, x, x]),
			256,
			10,
		);
		const h = histogram(s);
		for (let k = 0; k < 256; k++) expect([h.r[k], h.g[k], h.b[k], h.y[k]]).toEqual([10, 10, 10, 10]);
		for (const t of ['luma', 'ycNoChroma'] as const) {
			const y = trace(waveform(s, t), 'Y');
			for (let x = 0; x < 256; x++) {
				expect(rowsIn(y, x)).toEqual([x]);
				expect(at(y, x, x)).toBe(10);
			}
		}
		const w = waveform(s, 'rgb');
		expect(w.traces.length).toBe(3);
		for (const t of w.traces) for (let x = 0; x < 256; x++) expect(rowsIn(t, x)).toEqual([x]);
	});

	it('colour bars have exact RGB parade levels', () => {
		const s = bars();
		const par = parade(s, 'rgb');
		['R', 'G', 'B'].forEach((name, ch) => {
			const t = trace(par, name);
			BARS.forEach((bar, i) => {
				for (let x = i * 32; x < (i + 1) * 32; x++) {
					expect(rowsIn(t, x)).toEqual([bar[ch]]);
					expect(at(t, x, bar[ch]!)).toBe(16);
				}
			});
		});
		expect(parade(s, 'rgbWhite').traces.map((t) => t.name)).toEqual(['R', 'G', 'B', 'Y']);
		expect(parade(s, 'yuv').traces.map((t) => t.name)).toEqual(['Y', 'Cb', 'Cr']);
	});

	it('vectorscope positions of primaries are known', () => {
		const v = vectorscopeYuv(solid(8, 8, [255, 0, 0]));
		const pk = vectorPeaks(v, 1)[0]!;
		expect([pk.x, pk.y]).toEqual([103, 21]);
		expect([pk.share, v.samples]).toEqual([1, 64]);
		expect(Math.abs(redAngle('bt709') - 102.906)).toBeLessThan(0.01);
		expect(Math.abs(redAngle('bt601') - 108.645)).toBeLessThan(0.01);
		const [, cb, cr] = rgbToYcbcr(1, 0, 0, 'bt709');
		expect(Math.abs(v.mean[0] - cb)).toBeLessThan(1e-6);
		expect(Math.abs(v.mean[1] - cr)).toBeLessThan(1e-6);
		for (const m of MATRICES) {
			const g = vectorscopeYuv(solid(4, 4, [77, 77, 77]), { ...DEFAULT_SCOPE_PARAMS, matrix: m });
			expect(g.data[127 * g.size + 127]).toBe(16);
		}
		const yl = vectorTargets('bt709', 100)[5]!;
		expect(redAngle('bt709') < SKIN_TONE_DEG && SKIN_TONE_DEG < angleDeg(yl.cb, yl.cr)).toBe(true);
	});

	it('the HLS vectorscope puts hue on the angle and saturation on the radius', () => {
		const red = redAngle('bt709');
		const cases: [[number, number, number], number][] = [
			[[255, 0, 0], 0],
			[[255, 255, 0], 60],
			[[0, 255, 0], 120],
			[[0, 255, 255], 180],
			[[0, 0, 255], 240],
			[[255, 0, 255], 300],
		];
		for (const [rgb, hue] of cases) {
			const v = vectorscopeHls(solid(4, 4, rgb));
			const a = ((red + hue) * Math.PI) / 180;
			const want = vectorCell(0.5 * Math.cos(a), 0.5 * Math.sin(a), 255, VECTOR_EXTENT);
			const pk = vectorPeaks(v, 1)[0]!;
			expect([pk.x, pk.y]).toEqual(want);
			expect(Math.abs(pk.magnitude - 100)).toBeLessThan(0.6);
		}
		const half = vectorPeaks(vectorscopeHls(solid(4, 4, [191, 64, 64])), 1)[0]!;
		expect(Math.abs(half.magnitude - 50)).toBeLessThan(1);
		expect(Math.abs(half.angleDeg - red)).toBeLessThan(0.5);
		const grey = vectorscopeHls(solid(4, 4, [90, 90, 90]));
		expect(grey.data[127 * grey.size + 127]).toBe(16);
	});

	it('the YC waveform draws chroma around luma; the YUV parade offsets chroma to mid scale', () => {
		const w0 = waveform(solid(4, 4, [128, 128, 128]), 'yc');
		expect([rowsIn(trace(w0, 'Y'), 0), rowsIn(trace(w0, 'C'), 0)]).toEqual([[128], [128]]);
		const w = waveform(solid(4, 4, [255, 0, 0]), 'yc');
		const [y, cb, cr] = rgbToYcbcr(1, 0, 0, 'bt709');
		const c = Math.hypot(cb, cr);
		const row = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
		expect(rowsIn(trace(w, 'Y'), 2)).toEqual([row(y)]);
		expect(rowsIn(trace(w, 'C'), 2)).toEqual([row(y - c), row(y + c)]);
		const p = parade(solid(4, 4, [128, 128, 128]), 'yuv');
		for (const n of ['Y', 'Cb', 'Cr']) expect(rowsIn(trace(p, n), 0)).toEqual([128]);
	});

	it('decimation keeps whole samples', () => {
		const s = signalFromRgba8(
			rgba8(1920, 1080, (x, y) => [x % 256, y % 256, 7]),
			1920,
			1080,
		);
		expect([s.w, s.h]).toEqual([480, 270]);
		expect([...s.rgb.slice(3, 6)]).toEqual([4 / 255, 0, 7 / 255].map((v) => Math.fround(v)));
		expect([...s.rgb.slice(480 * 3, 480 * 3 + 3)]).toEqual([0, 4 / 255, 7 / 255].map((v) => Math.fround(v)));
		const s2 = signalFromRgba8(
			rgba8(1921, 9, () => [1, 2, 3]),
			1921,
			9,
		);
		expect([s2.w, s2.h]).toEqual([385, 9]);
		expect(signalFromRgba8(new Uint8Array(12), 10, 10).rgb.length).toBe(0);
	});

	it('Clamp Signal controls out-of-range values', () => {
		const s = signalFromFn(4, 4, (x) => (x < 2 ? [1.2, 0.5, -0.05] : [0.5, 0.5, 0.5]));
		const on = DEFAULT_SCOPE_PARAMS;
		const off = { ...on, clamp: false };
		let h = histogram(s, on);
		expect([h.r[255], h.above[0], h.b[0], h.below[2]]).toEqual([8, 8, 8, 8]);
		h = histogram(s, off);
		expect([h.r[255], h.above[0], h.b[0], h.below[2]]).toEqual([0, 8, 0, 8]);
		expect(rowsIn(trace(waveform(s, 'rgb', on), 'R'), 0)).toEqual([255]);
		const w = waveform(s, 'rgb', off);
		expect([w.lo, w.hi]).toEqual([-0.1, 1.1]);
		expect(rowsIn(trace(w, 'R'), 0)).toEqual([]);
		expect(rowsIn(trace(w, 'B'), 0)).toEqual([rowOf(-0.05, -0.1, 1.1, 256)]);
	});

	it('NaN (transparent) samples and empty signals do not throw', () => {
		const s = signalFromFn(3, 3, (x) => (x === 1 ? [Number.NaN, Number.NaN, Number.NaN] : [0.5, 0.5, 0.5]));
		const empty: ScopeSignal = { w: 0, h: 0, rgb: new Float32Array(0) };
		for (const clamp of [true, false]) {
			const p = { ...DEFAULT_SCOPE_PARAMS, clamp };
			for (const sig of [s, empty]) {
				waveform(sig, 'yc', p);
				parade(sig, 'rgbWhite', p);
				histogram(sig, p);
				vectorscopeYuv(sig, p);
				vectorscopeHls(sig, p);
				readScopes(sig, { clamp });
			}
		}
		expect(histogram(s).samples).toBe(6);
		expect(channelStats(empty)).toBeNull();
	});

	it('summaries report levels in percent', () => {
		const st = channelStats(solid(8, 8, [200, 100, 50]))!;
		expect([st.r.mean, st.g.mean, st.b.mean]).toEqual([78.43, 39.22, 19.61]);
		expect([st.r.min, st.r.max]).toEqual([78.43, 78.43]);
		const s = signalFromRgba8(
			rgba8(100, 4, (x) => (x < 50 ? [0, 0, 0] : [255, 255, 255])),
			100,
			4,
		);
		const w = waveform(s, 'luma');
		const cols = traceColumns(w, trace(w, 'Y'), 4);
		expect(cols.length).toBe(4);
		expect(cols[0]).toEqual({ min: 0, max: 0, mean: 0 });
		expect(cols[3]).toEqual({ min: 100, max: 100, mean: 100 });
		expect([cols[1]!.max, cols[2]!.min]).toEqual([0, 100]);
		// Clipping: half the samples at 0, half at full scale.
		const c = channelStats(s)!;
		expect(c.clipLow).toEqual([50, 50, 50, 50]);
		expect(c.clipHigh).toEqual([50, 50, 50, 50]);
	});

	it('paint adds traces and leaves empty cells transparent', () => {
		const w = waveform(solid(4, 8, [128, 128, 128]), 'rgb');
		const cols: [number, number, number][] = [
			[255, 0, 0],
			[0, 255, 0],
			[0, 0, 255],
		];
		const p = paintGrids(
			w.traces.map((grid, i) => ({ grid, color: cols[i]! })),
			waveformReference(w.perColumn),
			1,
		);
		const i = 127 * 4 * 4;
		expect([...p.image.slice(i, i + 4)]).toEqual([255, 255, 255, 255]);
		expect([...p.image.slice(0, 4)]).toEqual([0, 0, 0, 0]);
		expect(scopeIntensity(3, 100, 0.55)).toBeLessThan(scopeIntensity(3, 100, 1.6));
	});

	it('accepts public scope aliases', () => {
		expect(scopeKindFromName('vectorscope')).toBe('vectorscopeYuv');
		expect(waveformTypeFromName('YC no Chroma')).toBe('ycNoChroma');
		expect(paradeTypeFromName('rgb-white')).toBe('rgbWhite');
		expect(scopeMatrixFromName('709')).toBe('bt709');
		expect(scopeMatrixFromName('Rec. 2020')).toBe('bt2020');
		expect(scopeMatrixFromName('Rec.601')).toBe('bt601');
	});
});

describe('scopes maths (color-grade additions)', () => {
	it('Y′CbCr round-trips for every matrix', () => {
		const unit = fc.double({ min: 0, max: 1, noNaN: true });
		fc.assert(
			fc.property(unit, unit, unit, fc.constantFrom<ScopeMatrix>(...MATRICES), (r, g, b, m) => {
				const [y, cb, cr] = rgbToYcbcr(r, g, b, m);
				const back = ycbcrToRgb(y, cb, cr, m);
				return back.every((v, i) => Math.abs(v - [r, g, b][i]!) < 1e-9) && Math.abs(cb) <= 0.5 + 1e-9;
			}),
		);
	});
	it('100 % targets of BT.2020 sit further out than 75 %; scale labels follow the bit depth', () => {
		const t75 = vectorTargets('bt2020', 75);
		const t100 = vectorTargets('bt2020', 100);
		t75.forEach((t, i) => {
			expect(Math.hypot(t100[i]!.cb, t100[i]!.cr)).toBeGreaterThan(Math.hypot(t.cb, t.cr));
		});
		expect(scaleLabels('8bit').at(-1)).toEqual([1, '255']);
		expect(scaleLabels('10bit').at(-1)).toEqual([1, '1023']);
		expect(scaleLabels('float')[5]).toEqual([0.5, '0.5']);
	});
	it('readScopes reports every scope as numbers', () => {
		const r = readScopes(bars(), { columns: 8, peaks: 7, waveformType: 'rgb', paradeType: 'yuv' });
		expect(r.samples).toEqual([256, 16]);
		expect(r.waveform!.traces.R!.length).toBe(8);
		expect(r.parade!.type).toBe('yuv');
		expect(r.histogram!.r!.length).toBe(256);
		expect(r.vectorscopeYuv!.peaks.length).toBe(7);
		expect(r.vectorscopeHls!.samples).toBe(256 * 16);
		expect(r.stats!.samples).toBe(256 * 16);
		const lean = readScopes(bars(), { scopes: ['histogram'], bins: false });
		expect(lean.waveform).toBeUndefined();
		expect(lean.histogram!.r).toBeUndefined();
	});
	it('stays real time: every scope of a 1080p frame in well under a frame budget', () => {
		let seed = 0x12345678;
		const px = rgba8(1920, 1080, () => {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			return [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
		});
		const best = (f: () => void) => {
			f();
			let b = 1e9;
			for (let i = 0; i < 5; i++) {
				const t = performance.now();
				f();
				b = Math.min(b, performance.now() - t);
			}
			return b;
		};
		let s = signalFromRgba8(px, 1920, 1080);
		const times = {
			decimate: best(() => {
				s = signalFromRgba8(px, 1920, 1080);
			}),
			waveformRgb: best(() => waveform(s, 'rgb')),
			waveformYc: best(() => waveform(s, 'yc')),
			paradeRgbWhite: best(() => parade(s, 'rgbWhite')),
			histogram: best(() => histogram(s)),
			vectorscopeYuv: best(() => vectorscopeYuv(s)),
			vectorscopeHls: best(() => vectorscopeHls(s)),
		};
		console.info(
			'[color-grade] scopes at 1080p (ms):',
			JSON.stringify(times, (_, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)),
		);
		// PERF=1 enforces the 60 ms budget; ordinary runs account for shared-host load (docs/performance.md).
		const limit = budgetMs(SCOPE_BUDGET_MS);
		for (const [name, t] of Object.entries(times)) {
			console.info(budgetReport(`scope ${name} at 1080p`, t, SCOPE_BUDGET_MS));
			expect(t, name).toBeLessThan(limit);
		}
	});
});
