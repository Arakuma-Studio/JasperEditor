// Lumetri Scopes maths (color-grade): waveform (RGB, Luma, YC, YC no Chroma), parade (RGB, YUV, RGB-White),
// histogram, YUV vectorscope (75 % / 100 % colour-bar targets, skin-tone line) and HLS vectorscope, with the
// BT.601 / BT.709 / BT.2020 Y'CbCr matrices — as count grids ("how many samples land on this cell"), the
// density → pixels mapping the panel draws, and numeric summaries for agents (`scopes_read`).
// Pure TypeScript (typed arrays, no DOM): the Lumetri Scopes worker (apps/web) and the engine (`scopes_read`) run
// the same code, so what an agent reads is what the panel shows.
//
// Ported from FilmCraft `crates/scopes` (lib.rs, summary.rs, paint.rs; MIT OR Apache-2.0, see
// licenses/ported/color-grade.md): grid layout, the clamp / unclamped ranges, the HLS hue placement, the colour-bar
// targets, the log intensity, the trace-column levels and the vectorscope peaks.
//
// | Scope | Grid | Columns × rows |
// |---|---|---|
// | Waveform RGB / Luma / YC / YC no Chroma | per trace: R, G, B / Y / Y and C (Y ± |CbCr|) / Y | signal width × rows |
// | Parade RGB / YUV / RGB-White / YUV-White | per trace: R, G, B / Y, Cb + ½, Cr + ½ / R, G, B, Y / as YUV | signal width × rows |
// | Histogram | 256 bins per channel R, G, B, Y | — |
// | Vectorscope YUV | Cb right, Cr up, ±VECTOR_EXTENT | size² |
// | Vectorscope HLS | hue = angle (red at the YUV red angle), HLS saturation = radius (1 → 0.5) | size² |
//
// Waveform rows cover [0, 1] with Clamp Signal on (values clamped first) and [−0.1, 1.1] without (values outside
// are dropped). With 256 rows over [0, 1] an 8-bit code value c lands exactly on row c.

/** Largest decimated signal (a 1080p frame is sampled every 4th pixel both ways). */
export const SCOPE_MAX_W = 480;
export const SCOPE_MAX_H = 270;
/** Half-width of the vectorscope plane in Cb/Cr units (the 100 % targets of every matrix fit). */
export const VECTOR_EXTENT = 0.6;
/** The skin-tone line (the NTSC "I" axis): 123° counter-clockwise from +Cb. */
export const SKIN_TONE_DEG = 123;
export const HISTOGRAM_BINS = 256;

export type ScopeMatrix = 'bt601' | 'bt709' | 'bt2020';
export type ScopeKind = 'waveform' | 'parade' | 'histogram' | 'vectorscopeYuv' | 'vectorscopeHls';
export type WaveformType = 'rgb' | 'luma' | 'yc' | 'ycNoChroma';
export type ParadeType = 'rgb' | 'yuv' | 'rgbWhite' | 'yuvWhite';
/** Levels axis labels: 8-bit code values, 10-bit code values or 0.0–1.0. */
export type ScopeScale = '8bit' | '10bit' | 'float';
export type ScopeBrightness = 'dimmed' | 'normal' | 'bright';
export type VectorTargets = 75 | 100;

export const SCOPE_KINDS: readonly ScopeKind[] = [
	'vectorscopeYuv',
	'vectorscopeHls',
	'histogram',
	'parade',
	'waveform',
];
export const SCOPE_KIND_LABELS: Record<ScopeKind, string> = {
	vectorscopeYuv: 'Vectorscope YUV',
	vectorscopeHls: 'Vectorscope HLS',
	histogram: 'Histogram',
	parade: 'Parade',
	waveform: 'Waveform',
};
export const WAVEFORM_TYPES: readonly WaveformType[] = ['rgb', 'luma', 'yc', 'ycNoChroma'];
export const WAVEFORM_TYPE_LABELS: Record<WaveformType, string> = {
	rgb: 'RGB',
	luma: 'Luma',
	yc: 'YC',
	ycNoChroma: 'YC no Chroma',
};
export const PARADE_TYPES: readonly ParadeType[] = ['rgb', 'yuv', 'rgbWhite', 'yuvWhite'];
export const PARADE_TYPE_LABELS: Record<ParadeType, string> = {
	rgb: 'RGB',
	yuv: 'YUV',
	rgbWhite: 'RGB-White',
	yuvWhite: 'YUV-White',
};
export const SCOPE_MATRICES: readonly ScopeMatrix[] = ['bt601', 'bt709', 'bt2020'];
export const SCOPE_MATRIX_LABELS: Record<ScopeMatrix, string> = {
	bt601: 'Rec. 601',
	bt709: 'Rec. 709',
	bt2020: 'Rec. 2020',
};
export const SCOPE_SCALES: readonly ScopeScale[] = ['8bit', '10bit', 'float'];
export const SCOPE_SCALE_LABELS: Record<ScopeScale, string> = {
	'8bit': '8 Bit',
	'10bit': '10 Bit',
	float: 'Float',
};
export const BRIGHTNESS_GAIN: Record<ScopeBrightness, number> = { dimmed: 0.55, normal: 1, bright: 1.6 };

const norm = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
/** A scope kind by id or label, ignoring case, spaces and dashes (`vectorscope` = the YUV one). */
export function scopeKindFromName(s: string): ScopeKind | null {
	const n = norm(s);
	if (n === 'vectorscope' || n === 'yuv') return 'vectorscopeYuv';
	if (n === 'hls') return 'vectorscopeHls';
	return SCOPE_KINDS.find((k) => norm(k) === n || norm(SCOPE_KIND_LABELS[k]) === n) ?? null;
}
export function waveformTypeFromName(s: string): WaveformType | null {
	const n = norm(s);
	return WAVEFORM_TYPES.find((k) => norm(k) === n || norm(WAVEFORM_TYPE_LABELS[k]) === n) ?? null;
}
export function paradeTypeFromName(s: string): ParadeType | null {
	const n = norm(s);
	return PARADE_TYPES.find((k) => norm(k) === n || norm(PARADE_TYPE_LABELS[k]) === n) ?? null;
}
export function scopeMatrixFromName(s: string): ScopeMatrix | null {
	const n = norm(s).replace(/^rec/, '').replace(/^bt/, '');
	if (n === '601') return 'bt601';
	if (n === '709') return 'bt709';
	if (n === '2020' || n === '2100') return 'bt2020';
	return null;
}

/** Kr, Kb of each matrix (Y' = Kr R' + (1 − Kr − Kb) G' + Kb B'). */
const MATRIX_K: Record<ScopeMatrix, [number, number]> = {
	bt601: [0.299, 0.114],
	bt709: [0.2126, 0.0722],
	bt2020: [0.2627, 0.0593],
};

/** R'G'B' (0..1 nominal) → Y'CbCr (Cb, Cr in ±0.5) with a matrix. */
export function rgbToYcbcr(r: number, g: number, b: number, m: ScopeMatrix): [number, number, number] {
	const [kr, kb] = MATRIX_K[m];
	const y = kr * r + (1 - kr - kb) * g + kb * b;
	return [y, (b - y) / (2 * (1 - kb)), (r - y) / (2 * (1 - kr))];
}

/** Y'CbCr → R'G'B' (inverse of `rgbToYcbcr`). */
export function ycbcrToRgb(y: number, cb: number, cr: number, m: ScopeMatrix): [number, number, number] {
	const [kr, kb] = MATRIX_K[m];
	const r = y + cr * 2 * (1 - kr);
	const b = y + cb * 2 * (1 - kb);
	const g = (y - kr * r - kb * b) / (1 - kr - kb);
	return [r, g, b];
}

// ---------------------------------------------------------------- signal

/** A frame's R'G'B' samples (decimated), row-major, 3 floats per sample; NaN = no sample (transparent pixel). */
export type ScopeSignal = { w: number; h: number; rgb: Float32Array };

const LUT8 = (() => {
	const t = new Float32Array(256);
	for (let i = 0; i < 256; i++) t[i] = i / 255;
	return t;
})();

function steps(w: number, h: number, maxW: number, maxH: number): [number, number] {
	return [Math.max(1, Math.ceil(w / Math.max(1, maxW))), Math.max(1, Math.ceil(h / Math.max(1, maxH)))];
}

/**
 * Signal from straight RGBA8 (code / 255), decimated by nearest-sample picking (no averaging: flat colours and test
 * patterns land on exact cells). Fully transparent pixels give no sample.
 */
export function signalFromRgba8(
	data: ArrayLike<number>,
	w: number,
	h: number,
	maxW = SCOPE_MAX_W,
	maxH = SCOPE_MAX_H,
): ScopeSignal {
	if (!(w > 0 && h > 0) || data.length < w * h * 4) return { w: 0, h: 0, rgb: new Float32Array(0) };
	const [sx, sy] = steps(w, h, maxW, maxH);
	const ow = Math.ceil(w / sx);
	const oh = Math.ceil(h / sy);
	const rgb = new Float32Array(ow * oh * 3);
	let o = 0;
	for (let y = 0; y < h; y += sy) {
		const row = y * w * 4;
		for (let x = 0; x < w; x += sx) {
			const i = row + x * 4;
			if (data[i + 3] === 0) {
				rgb[o] = Number.NaN;
				rgb[o + 1] = Number.NaN;
				rgb[o + 2] = Number.NaN;
			} else {
				rgb[o] = LUT8[data[i]!]!;
				rgb[o + 1] = LUT8[data[i + 1]!]!;
				rgb[o + 2] = LUT8[data[i + 2]!]!;
			}
			o += 3;
		}
	}
	return { w: ow, h: oh, rgb };
}

/** Signal from float RGBA (straight, code values; values outside 0..1 are super-whites / sub-blacks). */
export function signalFromRgbaFloat(
	data: ArrayLike<number>,
	w: number,
	h: number,
	maxW = SCOPE_MAX_W,
	maxH = SCOPE_MAX_H,
): ScopeSignal {
	if (!(w > 0 && h > 0) || data.length < w * h * 4) return { w: 0, h: 0, rgb: new Float32Array(0) };
	const [sx, sy] = steps(w, h, maxW, maxH);
	const ow = Math.ceil(w / sx);
	const oh = Math.ceil(h / sy);
	const rgb = new Float32Array(ow * oh * 3);
	let o = 0;
	for (let y = 0; y < h; y += sy)
		for (let x = 0; x < w; x += sx) {
			const i = (y * w + x) * 4;
			const a = data[i + 3]!;
			rgb[o] = a > 0 ? data[i]! : Number.NaN;
			rgb[o + 1] = a > 0 ? data[i + 1]! : Number.NaN;
			rgb[o + 2] = a > 0 ? data[i + 2]! : Number.NaN;
			o += 3;
		}
	return { w: ow, h: oh, rgb };
}

/** A synthetic signal (tests, generated patterns). */
export function signalFromFn(
	w: number,
	h: number,
	f: (x: number, y: number) => [number, number, number],
): ScopeSignal {
	const rgb = new Float32Array(w * h * 3);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const c = f(x, y);
			rgb.set(c, (y * w + x) * 3);
		}
	return { w, h, rgb };
}

// ---------------------------------------------------------------- settings

export type ScopeParams = {
	matrix: ScopeMatrix;
	/** Clamp Signal: values are clamped to 0..1 before they are plotted. */
	clamp: boolean;
	/** Waveform / parade levels. */
	rows: number;
	/** Vectorscope grid size (square; odd so the centre is a cell). */
	vectorSize: number;
};

export const DEFAULT_SCOPE_PARAMS: ScopeParams = { matrix: 'bt709', clamp: true, rows: 256, vectorSize: 255 };

/** The plotted value range of waveform rows. */
export const scopeRange = (p: Pick<ScopeParams, 'clamp'>): [number, number] =>
	p.clamp ? [0, 1] : [-0.1, 1.1];

// ---------------------------------------------------------------- grids

/** A count grid: `data[row · cols + col]`, row 0 = the lowest level. */
export type ScopeGrid = { name: string; cols: number; rows: number; data: Uint32Array };

/** Waveform or parade: one grid per trace, columns = the signal's width. */
export type ScopeWaveform = { lo: number; hi: number; perColumn: number; traces: ScopeGrid[] };

/** Value at the centre of a waveform row. */
export const waveformLevel = (w: Pick<ScopeWaveform, 'lo' | 'hi'>, row: number, rows: number) =>
	w.lo + ((w.hi - w.lo) * row) / (Math.max(2, rows) - 1);

/** Row of value `v` in [lo, hi] over `rows` levels (−1 outside, or NaN). */
export function rowOf(v: number, lo: number, hi: number, rows: number): number {
	const t = (v - lo) / (hi - lo);
	if (!(t >= 0 && t <= 1)) return -1;
	return Math.min(rows - 1, Math.round(t * (rows - 1)));
}

/**
 * Values per sample of each trace layout: 0 RGB (R, G, B), 1 Y, 2 YC (Y, Y + C, Y − C → traces 0, 1, 1),
 * 3 RGB-White (R, G, B, Y), 4 YUV (Y, Cb + ½, Cr + ½).
 */
type Layout = 0 | 1 | 2 | 3 | 4;
const LAYOUT_NAMES: Record<Layout, string[]> = {
	0: ['R', 'G', 'B'],
	1: ['Y'],
	2: ['Y', 'C'],
	3: ['R', 'G', 'B', 'Y'],
	4: ['Y', 'Cb', 'Cr'],
};

// One monomorphic loop for every layout (no per-sample closures: ~3× faster in V8, the scopes stay real time).
function buildWaveform(s: ScopeSignal, p: ScopeParams, layout: Layout): ScopeWaveform {
	const [lo, hi] = scopeRange(p);
	const rows = Math.max(2, Math.floor(p.rows));
	const names = LAYOUT_NAMES[layout];
	const traces: ScopeGrid[] = names.map((name) => ({
		name,
		cols: s.w,
		rows,
		data: new Uint32Array(s.w * rows),
	}));
	const d0 = traces[0]!.data;
	const d1 = traces[1]?.data ?? d0;
	const d2 = traces[2]?.data ?? d0;
	const d3 = traces[3]?.data ?? d0;
	const [kr, kb] = MATRIX_K[p.matrix];
	const kg = 1 - kr - kb;
	const cbk = 1 / (2 * (1 - kb));
	const crk = 1 / (2 * (1 - kr));
	const scale = (rows - 1) / (hi - lo);
	const clamp = p.clamp;
	const w = s.w;
	const rgb = s.rgb;
	const put = (d: Uint32Array, v0: number, x: number) => {
		const v = clamp ? (v0 < 0 ? 0 : v0 > 1 ? 1 : v0) : v0;
		const u = (v - lo) * scale;
		if (!(u >= 0 && u <= rows - 1 + 1e-6)) return;
		d[((u + 0.5) | 0) * w + x]!++;
	};
	for (let y = 0; y < s.h; y++)
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 3;
			let r = rgb[i]!;
			if (r !== r) continue;
			let g = rgb[i + 1]!;
			let b = rgb[i + 2]!;
			if (clamp) {
				r = r < 0 ? 0 : r > 1 ? 1 : r;
				g = g < 0 ? 0 : g > 1 ? 1 : g;
				b = b < 0 ? 0 : b > 1 ? 1 : b;
			}
			if (layout === 0) {
				put(d0, r, x);
				put(d1, g, x);
				put(d2, b, x);
				continue;
			}
			const yy = kr * r + kg * g + kb * b;
			if (layout === 1) put(d0, yy, x);
			else if (layout === 3) {
				put(d0, r, x);
				put(d1, g, x);
				put(d2, b, x);
				put(d3, yy, x);
			} else {
				const cb = (b - yy) * cbk;
				const cr = (r - yy) * crk;
				put(d0, yy, x);
				if (layout === 4) {
					put(d1, cb + 0.5, x);
					put(d2, cr + 0.5, x);
				} else {
					const c = Math.sqrt(cb * cb + cr * cr);
					put(d1, yy + c, x);
					if (c > 1e-6) put(d1, yy - c, x);
				}
			}
		}
	return { lo, hi, perColumn: s.h, traces };
}

/** The waveform of a signal. */
export function waveform(
	s: ScopeSignal,
	type: WaveformType,
	p: ScopeParams = DEFAULT_SCOPE_PARAMS,
): ScopeWaveform {
	return buildWaveform(s, p, type === 'rgb' ? 0 : type === 'yc' ? 2 : 1);
}

/** The parade of a signal (the traces are drawn side by side). */
export function parade(
	s: ScopeSignal,
	type: ParadeType,
	p: ScopeParams = DEFAULT_SCOPE_PARAMS,
): ScopeWaveform {
	// YUV-White: the YUV components (drawn in white by the panel; Premiere's option, behaviour undocumented).
	return buildWaveform(s, p, type === 'rgb' ? 0 : type === 'rgbWhite' ? 3 : 4);
}

// ---------------------------------------------------------------- histogram

/** 256-bin histograms of R', G', B' and Y'. */
export type ScopeHistogram = {
	r: Uint32Array;
	g: Uint32Array;
	b: Uint32Array;
	y: Uint32Array;
	samples: number;
	/** Samples below 0 / above 1 per channel (R, G, B, Y); with Clamp Signal also counted in the end bins. */
	below: [number, number, number, number];
	above: [number, number, number, number];
};

/** Bin of a value (−1 outside 0..1). */
export const binOf = (v: number) =>
	v >= 0 && v <= 1 + 1e-6 ? Math.min(HISTOGRAM_BINS - 1, Math.round(v * 255)) : -1;

export function histogram(s: ScopeSignal, p: ScopeParams = DEFAULT_SCOPE_PARAMS): ScopeHistogram {
	const h: ScopeHistogram = {
		r: new Uint32Array(HISTOGRAM_BINS),
		g: new Uint32Array(HISTOGRAM_BINS),
		b: new Uint32Array(HISTOGRAM_BINS),
		y: new Uint32Array(HISTOGRAM_BINS),
		samples: 0,
		below: [0, 0, 0, 0],
		above: [0, 0, 0, 0],
	};
	const [kr, kb] = MATRIX_K[p.matrix];
	const kg = 1 - kr - kb;
	const bins = [h.r, h.g, h.b, h.y];
	const v = [0, 0, 0, 0];
	for (let i = 0; i < s.rgb.length; i += 3) {
		const r = s.rgb[i]!;
		if (Number.isNaN(r)) continue;
		h.samples++;
		v[0] = r;
		v[1] = s.rgb[i + 1]!;
		v[2] = s.rgb[i + 2]!;
		v[3] = kr * v[0] + kg * v[1] + kb * v[2];
		for (let c = 0; c < 4; c++) {
			const x = v[c]!;
			const k = binOf(x);
			if (k >= 0) bins[c]![k]!++;
			else if (!Number.isNaN(x)) {
				const low = x < 0;
				if (low) h.below[c]!++;
				else h.above[c]!++;
				if (p.clamp) bins[c]![low ? 0 : HISTOGRAM_BINS - 1]!++;
			}
		}
	}
	return h;
}

// ---------------------------------------------------------------- vectorscopes

/** A vectorscope: `data[y · size + x]`, x = Cb (right = +), y = Cr (row 0 = top = +Cr). */
export type ScopeVectorscope = {
	size: number;
	extent: number;
	data: Uint32Array;
	samples: number;
	/** Mean (Cb, Cr) of the plotted points. */
	mean: [number, number];
};

/** Cell of a (Cb, Cr) point on a size² plane spanning ±extent, or null outside. */
export function vectorCell(
	cb: number,
	cr: number,
	size: number,
	extent = VECTOR_EXTENT,
): [number, number] | null {
	const n = size - 1;
	const fx = (cb / extent / 2 + 0.5) * n;
	const fy = (0.5 - cr / extent / 2) * n;
	if (!(fx >= 0 && fx <= n && fy >= 0 && fy <= n)) return null;
	return [Math.round(fx), Math.round(fy)];
}

/** (Cb, Cr) at the centre of a cell. */
export function vectorPoint(
	v: Pick<ScopeVectorscope, 'size' | 'extent'>,
	x: number,
	y: number,
): [number, number] {
	const n = v.size - 1;
	return [(x / n - 0.5) * 2 * v.extent, (0.5 - y / n) * 2 * v.extent];
}

function newVectorscope(size: number): ScopeVectorscope {
	const n = Math.max(2, Math.floor(size));
	return { size: n, extent: VECTOR_EXTENT, data: new Uint32Array(n * n), samples: 0, mean: [0, 0] };
}

/** The YUV vectorscope (Cb, Cr of each sample). */
export function vectorscopeYuv(s: ScopeSignal, p: ScopeParams = DEFAULT_SCOPE_PARAMS): ScopeVectorscope {
	const v = newVectorscope(p.vectorSize);
	const [kr, kb] = MATRIX_K[p.matrix];
	const kg = 1 - kr - kb;
	const cbk = 1 / (2 * (1 - kb));
	const crk = 1 / (2 * (1 - kr));
	const n = v.size - 1;
	const scale = n / (2 * v.extent);
	let sx = 0;
	let sy = 0;
	for (let i = 0; i < s.rgb.length; i += 3) {
		let r = s.rgb[i]!;
		if (Number.isNaN(r)) continue;
		let g = s.rgb[i + 1]!;
		let b = s.rgb[i + 2]!;
		if (p.clamp) {
			r = r < 0 ? 0 : r > 1 ? 1 : r;
			g = g < 0 ? 0 : g > 1 ? 1 : g;
			b = b < 0 ? 0 : b > 1 ? 1 : b;
		}
		const y = kr * r + kg * g + kb * b;
		const cb = (b - y) * cbk;
		const cr = (r - y) * crk;
		const fx = cb * scale + n / 2;
		const fy = n / 2 - cr * scale;
		if (!(fx >= 0 && fx <= n && fy >= 0 && fy <= n)) continue;
		v.data[((fy + 0.5) | 0) * v.size + ((fx + 0.5) | 0)]!++;
		v.samples++;
		sx += cb;
		sy += cr;
	}
	if (v.samples > 0) v.mean = [sx / v.samples, sy / v.samples];
	return v;
}

/** Angle (degrees, counter-clockwise from +Cb, 0..360) of a chroma point. */
export function angleDeg(cb: number, cr: number): number {
	const a = (Math.atan2(cr, cb) * 180) / Math.PI;
	return a < 0 ? a + 360 : a;
}

/** The angle of pure red on a matrix's vectorscope (BT.709 ≈ 103°): the HLS scope puts hue 0 there. */
export function redAngle(m: ScopeMatrix): number {
	const [, cb, cr] = rgbToYcbcr(1, 0, 0, m);
	return angleDeg(cb, cr);
}

/** HLS hue (0..1) and saturation of a clamped colour. */
function hueSat(r: number, g: number, b: number): [number, number] {
	const mx = Math.max(r, g, b);
	const mn = Math.min(r, g, b);
	const d = mx - mn;
	if (d < 1e-9) return [0, 0];
	const l = (mx + mn) / 2;
	const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
	let h: number;
	if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
	else if (mx === g) h = (b - r) / d + 2;
	else h = (r - g) / d + 4;
	return [h / 6, s];
}

/** A sample's point on the HLS vectorscope: hue as the angle from red (counter-clockwise), saturation × 0.5 radius. */
export function hlsPoint(rgb: readonly [number, number, number], m: ScopeMatrix): [number, number] {
	const c = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
	const [h, s] = hueSat(c(rgb[0]), c(rgb[1]), c(rgb[2]));
	const a = ((redAngle(m) + h * 360) * Math.PI) / 180;
	const rad = Math.min(1, Math.max(0, s)) * 0.5;
	return [rad * Math.cos(a), rad * Math.sin(a)];
}

/** The HLS vectorscope (hue → direction tabulated at 0.1°). */
export function vectorscopeHls(s: ScopeSignal, p: ScopeParams = DEFAULT_SCOPE_PARAMS): ScopeVectorscope {
	const v = newVectorscope(p.vectorSize);
	const red = redAngle(p.matrix);
	const dx = new Float32Array(3601);
	const dy = new Float32Array(3601);
	for (let i = 0; i <= 3600; i++) {
		const a = ((red + i / 10) * Math.PI) / 180;
		dx[i] = Math.cos(a);
		dy[i] = Math.sin(a);
	}
	const n = v.size - 1;
	const scale = n / (2 * v.extent);
	let sx = 0;
	let sy = 0;
	for (let i = 0; i < s.rgb.length; i += 3) {
		let r = s.rgb[i]!;
		if (Number.isNaN(r)) continue;
		let g = s.rgb[i + 1]!;
		let b = s.rgb[i + 2]!;
		r = r < 0 ? 0 : r > 1 ? 1 : r;
		g = g < 0 ? 0 : g > 1 ? 1 : g;
		b = b < 0 ? 0 : b > 1 ? 1 : b;
		// HLS hue and saturation inline (no allocation per sample).
		const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
		const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
		const dd = mx - mn;
		let h = 0;
		let sat = 0;
		if (dd >= 1e-9) {
			const l = (mx + mn) / 2;
			sat = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
			if (mx === r) h = (g - b) / dd + (g < b ? 6 : 0);
			else if (mx === g) h = (b - r) / dd + 2;
			else h = (r - g) / dd + 4;
			h /= 6;
		}
		const k = Math.min(3600, (h * 3600 + 0.5) | 0);
		const rad = (sat < 1 ? sat : 1) * 0.5;
		const cb = rad * dx[k]!;
		const cr = rad * dy[k]!;
		const fx = cb * scale + n / 2;
		const fy = n / 2 - cr * scale;
		if (!(fx >= 0 && fx <= n && fy >= 0 && fy <= n)) continue;
		v.data[((fy + 0.5) | 0) * v.size + ((fx + 0.5) | 0)]!++;
		v.samples++;
		sx += cb;
		sy += cr;
	}
	if (v.samples > 0) v.mean = [sx / v.samples, sy / v.samples];
	return v;
}

/** A colour-bar target of the YUV vectorscope. */
export type VectorTarget = { name: string; rgb: [number, number, number]; cb: number; cr: number };

/** The six colour-bar targets (R, Mg, B, Cy, G, Yl) at 75 % or 100 % amplitude. */
export function vectorTargets(m: ScopeMatrix, amplitude: VectorTargets = 75): VectorTarget[] {
	const a = amplitude / 100;
	const bars: [string, [number, number, number]][] = [
		['R', [a, 0, 0]],
		['Mg', [a, 0, a]],
		['B', [0, 0, a]],
		['Cy', [0, a, a]],
		['G', [0, a, 0]],
		['Yl', [a, a, 0]],
	];
	return bars.map(([name, rgb]) => {
		const [, cb, cr] = rgbToYcbcr(rgb[0], rgb[1], rgb[2], m);
		return { name, rgb, cb, cr };
	});
}

/** Hue labels of the HLS vectorscope at radius 0.5: (name, Cb, Cr). */
export function hlsTargets(m: ScopeMatrix): { name: string; cb: number; cr: number }[] {
	const red = redAngle(m);
	return (
		[
			['R', 0],
			['Yl', 60],
			['G', 120],
			['Cy', 180],
			['B', 240],
			['Mg', 300],
		] as const
	).map(([name, h]) => {
		const a = ((red + h) * Math.PI) / 180;
		return { name, cb: 0.5 * Math.cos(a), cr: 0.5 * Math.sin(a) };
	});
}

/** Unit direction (Cb, Cr) of the skin-tone line. */
export function skinToneLine(): [number, number] {
	const a = (SKIN_TONE_DEG * Math.PI) / 180;
	return [Math.cos(a), Math.sin(a)];
}

// ---------------------------------------------------------------- scale labels

/** Graticule labels of the levels axis: `[value 0..1, label]`, bottom to top (`hi` > 1 adds super-white rows). */
export function scaleLabels(scale: ScopeScale, lo = 0, hi = 1): [number, string][] {
	const out: [number, string][] = [];
	for (let i = 0; i <= 10; i++) {
		const v = i / 10;
		if (v < lo - 1e-9 || v > hi + 1e-9) continue;
		const label =
			scale === '8bit'
				? String(Math.round(v * 255))
				: scale === '10bit'
					? String(Math.round(v * 1023))
					: v.toFixed(1);
		out.push([v, label]);
	}
	return out;
}

// ---------------------------------------------------------------- paint (counts → pixels)

/** Intensity 0..1 of a cell holding `count` samples (`reference` = a full cell, `gain` = Brightness). */
export function scopeIntensity(count: number, reference: number, gain: number): number {
	if (count === 0) return 0;
	const r = Math.log(1 + Math.max(1, reference));
	return Math.min(1, Math.max(0, gain * (0.12 + (0.88 * Math.log(1 + count)) / r)));
}

/** The reference count of a waveform cell: half a column. */
export const waveformReference = (perColumn: number) => Math.max(1, perColumn / 2);

/**
 * Paints grids of equal size with colours (0..255 RGB), additively, into RGBA8 with the highest row at the top
 * (straight alpha = the brightest channel). Empty cells are transparent. `out` (optional) is reused.
 */
export function paintGrids(
	layers: readonly { grid: ScopeGrid; color: readonly [number, number, number] }[],
	reference: number,
	gain: number,
	out?: Uint8ClampedArray,
): { width: number; height: number; image: Uint8ClampedArray } {
	const first = layers[0]?.grid;
	if (!first) return { width: 0, height: 0, image: new Uint8ClampedArray(0) };
	const w = first.cols;
	const h = first.rows;
	const acc = new Float32Array(w * h * 3);
	// Intensity table by count (counts repeat a lot).
	const cache = new Map<number, number>();
	const inten = (c: number) => {
		let v = cache.get(c);
		if (v === undefined) {
			v = scopeIntensity(c, reference, gain);
			cache.set(c, v);
		}
		return v;
	};
	for (const { grid, color } of layers) {
		if (grid.cols !== w || grid.rows !== h) continue;
		const cr = color[0] / 255;
		const cg = color[1] / 255;
		const cb = color[2] / 255;
		for (let row = 0; row < h; row++) {
			const dst = (h - 1 - row) * w;
			const src = row * w;
			for (let x = 0; x < w; x++) {
				const c = grid.data[src + x]!;
				if (c === 0) continue;
				const i = inten(c);
				const a = (dst + x) * 3;
				acc[a] += cr * i;
				acc[a + 1] += cg * i;
				acc[a + 2] += cb * i;
			}
		}
	}
	const image = out && out.length === w * h * 4 ? out : new Uint8ClampedArray(w * h * 4);
	image.fill(0);
	for (let p = 0; p < w * h; p++) {
		const r = acc[p * 3]!;
		const g = acc[p * 3 + 1]!;
		const b = acc[p * 3 + 2]!;
		const m = Math.max(r, g, b);
		if (m <= 0) continue;
		// Straight alpha: colour / brightness so that drawing over a dark background shows the additive sum.
		const a = Math.min(1, m);
		image[p * 4] = Math.round((Math.min(1, r) / a) * 255);
		image[p * 4 + 1] = Math.round((Math.min(1, g) / a) * 255);
		image[p * 4 + 2] = Math.round((Math.min(1, b) / a) * 255);
		image[p * 4 + 3] = Math.round(a * 255);
	}
	return { width: w, height: h, image };
}

/**
 * Paints a vectorscope: each point takes the colour of its own position (hue = angle) when `colorize`, else
 * `color`, and spreads over its 3 × 3 neighbourhood (falling off), so isolated points stay visible when drawn
 * smaller than the grid. RGBA8 straight, row 0 = +Cr.
 */
export function paintVectorscope(
	v: ScopeVectorscope,
	color: readonly [number, number, number],
	gain: number,
	colorize: boolean,
	matrix: ScopeMatrix = 'bt709',
): { width: number; height: number; image: Uint8ClampedArray } {
	const n = v.size;
	const reference = Math.max(1, v.samples / 64);
	const level = new Float32Array(n * n);
	const tint = new Float32Array(n * n * 3);
	const K: [number, number, number][] = [
		[0, 0, 1],
		[-1, 0, 0.6],
		[1, 0, 0.6],
		[0, -1, 0.6],
		[0, 1, 0.6],
		[-1, -1, 0.35],
		[-1, 1, 0.35],
		[1, -1, 0.35],
		[1, 1, 0.35],
	];
	for (let y = 0; y < n; y++)
		for (let x = 0; x < n; x++) {
			const c = v.data[y * n + x]!;
			if (c === 0) continue;
			const i = scopeIntensity(c, reference, gain);
			let t0 = color[0] / 255;
			let t1 = color[1] / 255;
			let t2 = color[2] / 255;
			if (colorize) {
				const [cb, cr] = vectorPoint(v, x, y);
				const [r, g, b] = ycbcrToRgb(0.6, cb * 0.8, cr * 0.8, matrix);
				const c01 = (q: number) => (q < 0 ? 0 : q > 1 ? 1 : q);
				t0 = 0.55 + 0.45 * c01(r);
				t1 = 0.55 + 0.45 * c01(g);
				t2 = 0.55 + 0.45 * c01(b);
			}
			for (const [dy, dx, w] of K) {
				const yy = y + dy;
				const xx = x + dx;
				if (yy < 0 || xx < 0 || yy >= n || xx >= n) continue;
				const k = yy * n + xx;
				if (i * w > level[k]!) {
					level[k] = i * w;
					tint[k * 3] = t0;
					tint[k * 3 + 1] = t1;
					tint[k * 3 + 2] = t2;
				}
			}
		}
	const image = new Uint8ClampedArray(n * n * 4);
	for (let k = 0; k < n * n; k++) {
		const l = level[k]!;
		if (l <= 0) continue;
		image[k * 4] = Math.round(tint[k * 3]! * 255);
		image[k * 4 + 1] = Math.round(tint[k * 3 + 1]! * 255);
		image[k * 4 + 2] = Math.round(tint[k * 3 + 2]! * 255);
		image[k * 4 + 3] = Math.round(Math.min(1, l) * 255);
	}
	return { width: n, height: n, image };
}

// ---------------------------------------------------------------- numeric summaries (agents)

/** Minimum, maximum and mean of a set of levels (percent of full scale). */
export type ScopeLevel = { min: number; max: number; mean: number };

const round2 = (v: number) => Math.round(v * 100) / 100;

class Acc {
	min = 0;
	max = 0;
	sum = 0;
	n = 0;
	add(v: number, count: number) {
		if (this.n === 0) {
			this.min = v;
			this.max = v;
		} else {
			if (v < this.min) this.min = v;
			if (v > this.max) this.max = v;
		}
		this.sum += v * count;
		this.n += count;
	}
	level(): ScopeLevel | null {
		return this.n > 0
			? { min: round2(this.min), max: round2(this.max), mean: round2(this.sum / this.n) }
			: null;
	}
}

/** Per-channel levels of the signal itself (R', G', B', Y' in %), its mean chroma, hue and saturation. */
export type ScopeChannelStats = {
	r: ScopeLevel;
	g: ScopeLevel;
	b: ScopeLevel;
	y: ScopeLevel;
	/** Mean chroma (Cb, Cr) in −50..50. */
	chromaMean: [number, number];
	hueDeg: number;
	/** Magnitude of the mean chroma in percent of 0.5. */
	saturation: number;
	/** Share (%) of samples at or below 0 / at or above 1 per channel R, G, B, Y (clipping). */
	clipLow: [number, number, number, number];
	clipHigh: [number, number, number, number];
	samples: number;
};

export function channelStats(s: ScopeSignal, m: ScopeMatrix = 'bt709'): ScopeChannelStats | null {
	const acc = [new Acc(), new Acc(), new Acc(), new Acc()];
	let cbSum = 0;
	let crSum = 0;
	let n = 0;
	const low = [0, 0, 0, 0];
	const high = [0, 0, 0, 0];
	const eps = 0.5 / 255;
	for (let i = 0; i < s.rgb.length; i += 3) {
		const r = s.rgb[i]!;
		if (Number.isNaN(r)) continue;
		const g = s.rgb[i + 1]!;
		const b = s.rgb[i + 2]!;
		const [y, cb, cr] = rgbToYcbcr(r, g, b, m);
		const vals = [r, g, b, y];
		for (let c = 0; c < 4; c++) {
			const v = vals[c]!;
			acc[c]!.add(v * 100, 1);
			if (v <= eps) low[c]!++;
			if (v >= 1 - eps) high[c]!++;
		}
		cbSum += cb;
		crSum += cr;
		n++;
	}
	if (n === 0) return null;
	const cb = cbSum / n;
	const cr = crSum / n;
	const pct = (k: number) => Math.round((k / n) * 10000) / 100;
	return {
		r: acc[0]!.level()!,
		g: acc[1]!.level()!,
		b: acc[2]!.level()!,
		y: acc[3]!.level()!,
		chromaMean: [round2(cb * 100), round2(cr * 100)],
		hueDeg: round2(angleDeg(cb, cr)),
		saturation: round2((Math.hypot(cb, cr) / 0.5) * 100),
		clipLow: low.map(pct) as [number, number, number, number],
		clipHigh: high.map(pct) as [number, number, number, number],
		samples: n,
	};
}

/** A trace split into `buckets` column ranges, each with the levels its cells hold (null when empty). */
export function traceColumns(w: ScopeWaveform, g: ScopeGrid, buckets: number): (ScopeLevel | null)[] {
	const nb = Math.min(Math.max(1, Math.floor(buckets)), Math.max(1, g.cols));
	const out: (ScopeLevel | null)[] = [];
	for (let b = 0; b < nb; b++) {
		const c0 = Math.floor((b * g.cols) / nb);
		const c1 = Math.min(g.cols, Math.max(Math.floor(((b + 1) * g.cols) / nb), c0 + 1));
		const a = new Acc();
		for (let col = c0; col < c1; col++)
			for (let row = 0; row < g.rows; row++) {
				const n = g.data[row * g.cols + col]!;
				if (n > 0) a.add(waveformLevel(w, row, g.rows) * 100, n);
			}
		out.push(a.level());
	}
	return out;
}

/** A dense spot of a vectorscope. */
export type ScopePeak = {
	x: number;
	y: number;
	/** Cb, Cr at the cell centre (percent: −50..50 nominal). */
	cb: number;
	cr: number;
	angleDeg: number;
	/** Distance from the centre in percent of 0.5 (100 % red in BT.709 ≈ 102.6). */
	magnitude: number;
	/** Share of the plotted samples in this cell (0..1). */
	share: number;
};

/** The `n` densest cells holding at least `minShare` of the samples, densest first. */
export function vectorPeaks(v: ScopeVectorscope, n = 8, minShare = 0): ScopePeak[] {
	const total = Math.max(1, v.samples);
	const cells: [number, number][] = [];
	for (let i = 0; i < v.data.length; i++) if (v.data[i]! > 0) cells.push([v.data[i]!, i]);
	cells.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
	return cells
		.filter(([c]) => c / total >= minShare)
		.slice(0, Math.max(0, n))
		.map(([c, i]) => {
			const x = i % v.size;
			const y = Math.floor(i / v.size);
			const [cb, cr] = vectorPoint(v, x, y);
			return {
				x,
				y,
				cb: round2(cb * 100),
				cr: round2(cr * 100),
				angleDeg: round2(angleDeg(cb, cr)),
				magnitude: round2((Math.hypot(cb, cr) / 0.5) * 100),
				share: Math.round((c / total) * 10000) / 10000,
			};
		});
}

/** Index of the fullest bin (lowest on ties). */
export function peakBin(bins: ArrayLike<number>): number {
	let best = 0;
	for (let i = 1; i < bins.length; i++) if (bins[i]! > bins[best]!) best = i;
	return best;
}

// ---------------------------------------------------------------- scopes_read

export type ScopesReadOptions = {
	scopes?: readonly ScopeKind[];
	waveformType?: WaveformType;
	paradeType?: ParadeType;
	matrix?: ScopeMatrix;
	clamp?: boolean;
	/** Column ranges per waveform/parade trace (1..512, default 8). */
	columns?: number;
	/** Vectorscope peaks (1..64, default 8). */
	peaks?: number;
	/** Include the 256 histogram bins (default true). */
	bins?: boolean;
};

export type ScopesReadResult = {
	samples: [number, number];
	matrix: ScopeMatrix;
	clamp: boolean;
	unit: '%';
	stats: ScopeChannelStats | null;
	waveform?: {
		type: WaveformType;
		lo: number;
		hi: number;
		columns: number;
		traces: Record<string, (ScopeLevel | null)[]>;
	};
	parade?: {
		type: ParadeType;
		lo: number;
		hi: number;
		columns: number;
		traces: Record<string, (ScopeLevel | null)[]>;
	};
	histogram?: {
		samples: number;
		below: number[];
		above: number[];
		peakBin: { r: number; g: number; b: number; y: number };
		r?: number[];
		g?: number[];
		b?: number[];
		y?: number[];
	};
	vectorscopeYuv?: { samples: number; mean: [number, number]; meanAngleDeg: number; peaks: ScopePeak[] };
	vectorscopeHls?: { samples: number; mean: [number, number]; meanAngleDeg: number; peaks: ScopePeak[] };
};

/** Lumetri Scopes as numbers (FilmCraft `scopes.read`): levels in percent, histogram bins, vectorscope peaks. */
export function readScopes(sig: ScopeSignal, o: ScopesReadOptions = {}): ScopesReadResult {
	const p: ScopeParams = { ...DEFAULT_SCOPE_PARAMS, matrix: o.matrix ?? 'bt709', clamp: o.clamp ?? true };
	const columns = Math.min(512, Math.max(1, Math.floor(o.columns ?? 8)));
	const npeaks = Math.min(64, Math.max(1, Math.floor(o.peaks ?? 8)));
	const kinds = o.scopes?.length ? o.scopes : SCOPE_KINDS;
	const levels = (w: ScopeWaveform) => {
		const traces: Record<string, (ScopeLevel | null)[]> = {};
		for (const g of w.traces) traces[g.name] = traceColumns(w, g, columns);
		return { lo: Math.round(w.lo * 100), hi: Math.round(w.hi * 100), columns, traces };
	};
	const vec = (v: ScopeVectorscope) => ({
		samples: v.samples,
		mean: [round2(v.mean[0] * 100), round2(v.mean[1] * 100)] as [number, number],
		meanAngleDeg: round2(angleDeg(v.mean[0], v.mean[1])),
		peaks: vectorPeaks(v, npeaks, 0),
	});
	const out: ScopesReadResult = {
		samples: [sig.w, sig.h],
		matrix: p.matrix,
		clamp: p.clamp,
		unit: '%',
		stats: channelStats(sig, p.matrix),
	};
	for (const k of kinds) {
		if (k === 'waveform') {
			const t = o.waveformType ?? 'rgb';
			out.waveform = { type: t, ...levels(waveform(sig, t, p)) };
		} else if (k === 'parade') {
			const t = o.paradeType ?? 'rgb';
			out.parade = { type: t, ...levels(parade(sig, t, p)) };
		} else if (k === 'histogram') {
			const h = histogram(sig, p);
			out.histogram = {
				samples: h.samples,
				below: [...h.below],
				above: [...h.above],
				peakBin: { r: peakBin(h.r), g: peakBin(h.g), b: peakBin(h.b), y: peakBin(h.y) },
				...(o.bins !== false ? { r: [...h.r], g: [...h.g], b: [...h.b], y: [...h.y] } : {}),
			};
		} else if (k === 'vectorscopeYuv') out.vectorscopeYuv = vec(vectorscopeYuv(sig, p));
		else if (k === 'vectorscopeHls') out.vectorscopeHls = vec(vectorscopeHls(sig, p));
	}
	return out;
}
