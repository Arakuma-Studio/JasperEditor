// 3D/1D LUTs (M2, ARCHITECTURE §19.2, S06:CG-050…056): the one LUT representation shared by the grade baker,
// the WebGL preview (3D texture), the native export (`lut3d=file=<baked>.cube`) and imported `.cube` assets.
// Pure: no DOM, no Node. Values are display-referred RGB (Rec.709/sRGB-encoded) in the LUT's domain.

export type Rgb = [number, number, number];

/**
 * A LUT. 3D: `size³` entries, red changing fastest (the `.cube` order), `data[3·(r + size·(g + size·b)) + c]`.
 * 1D: `size` entries per channel, `data[3·i + c]`.
 */
export type Lut = {
	dimensions: 1 | 3;
	size: number;
	title: string | null;
	domainMin: Rgb;
	domainMax: Rgb;
	data: Float32Array;
};

export class CubeParseError extends Error {
	constructor(
		message: string,
		readonly line: number,
	) {
		super(`${message} (line ${line})`);
		this.name = 'CubeParseError';
	}
}

const MAX_3D = 256;
const MAX_1D = 65536;

/**
 * Parses an Adobe/Resolve `.cube` file (TITLE, LUT_3D_SIZE / LUT_1D_SIZE, DOMAIN_MIN/MAX,
 * LUT_3D_INPUT_RANGE / LUT_1D_INPUT_RANGE, `#` comments). Throws `CubeParseError`.
 */
export function parseCube(text: string): Lut {
	let title: string | null = null;
	let dims: 1 | 3 | 0 = 0;
	let size = 0;
	let domainMin: Rgb = [0, 0, 0];
	let domainMax: Rgb = [1, 1, 1];
	let data: Float32Array | null = null;
	let n = 0;
	const lines = text.split(/\r?\n/);
	for (let li = 0; li < lines.length; li++) {
		const raw = lines[li]!;
		const hash = raw.indexOf('#');
		const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
		if (!line) continue;
		const lineNo = li + 1;
		const c0 = line.charCodeAt(0);
		const isNumber = (c0 >= 48 && c0 <= 57) || c0 === 45 || c0 === 43 || c0 === 46;
		if (!isNumber) {
			const [key, ...rest] = line.split(/\s+/);
			const args = rest.map(Number);
			switch (key) {
				case 'TITLE': {
					const m = /"(.*)"/.exec(line);
					title = m ? m[1]! : rest.join(' ');
					break;
				}
				case 'LUT_3D_SIZE':
				case 'LUT_1D_SIZE': {
					if (dims) throw new CubeParseError('Duplicate LUT size', lineNo);
					dims = key === 'LUT_3D_SIZE' ? 3 : 1;
					size = args[0] ?? Number.NaN;
					const max = dims === 3 ? MAX_3D : MAX_1D;
					if (!Number.isInteger(size) || size < 2 || size > max)
						throw new CubeParseError(`Invalid ${key} ${rest.join(' ')}`, lineNo);
					data = new Float32Array((dims === 3 ? size * size * size : size) * 3);
					break;
				}
				case 'DOMAIN_MIN':
				case 'DOMAIN_MAX': {
					if (args.length !== 3 || args.some((x) => !Number.isFinite(x)))
						throw new CubeParseError(`Invalid ${key}`, lineNo);
					if (key === 'DOMAIN_MIN') domainMin = args as Rgb;
					else domainMax = args as Rgb;
					break;
				}
				case 'LUT_3D_INPUT_RANGE':
				case 'LUT_1D_INPUT_RANGE': {
					const [lo, hi] = args;
					if (!Number.isFinite(lo) || !Number.isFinite(hi))
						throw new CubeParseError(`Invalid ${key}`, lineNo);
					domainMin = [lo!, lo!, lo!];
					domainMax = [hi!, hi!, hi!];
					break;
				}
				default:
					// Unknown keywords are ignored (vendor extensions).
					break;
			}
			continue;
		}
		if (!data) throw new CubeParseError('Table data before LUT_3D_SIZE / LUT_1D_SIZE', lineNo);
		const parts = line.split(/\s+/);
		if (parts.length < 3) throw new CubeParseError('Expected three values', lineNo);
		if (n + 3 > data.length) throw new CubeParseError('More table entries than the LUT size', lineNo);
		for (let k = 0; k < 3; k++) {
			const v = Number(parts[k]);
			if (!Number.isFinite(v)) throw new CubeParseError(`Invalid number "${parts[k]}"`, lineNo);
			data[n++] = v;
		}
	}
	if (!data || !dims) throw new CubeParseError('No LUT_3D_SIZE or LUT_1D_SIZE', lines.length);
	if (n !== data.length)
		throw new CubeParseError(`Expected ${data.length / 3} table entries, found ${n / 3}`, lines.length);
	for (let c = 0; c < 3; c++)
		if (!(domainMax[c]! > domainMin[c]!)) throw new CubeParseError('DOMAIN_MAX must exceed DOMAIN_MIN', 0);
	return { dimensions: dims, size, title, domainMin, domainMax, data };
}

const fmt6 = (x: number) => {
	const r = Math.round(x * 1e6) / 1e6;
	return Object.is(r, -0) ? '0' : String(r);
};

/** Serializes a LUT as `.cube` text (what FFmpeg `lut3d`/`lut1d` read). Deterministic output. */
export function serializeCube(lut: Lut): string {
	const out: string[] = [];
	if (lut.title) out.push(`TITLE "${lut.title.replace(/"/g, "'")}"`);
	out.push(`${lut.dimensions === 3 ? 'LUT_3D_SIZE' : 'LUT_1D_SIZE'} ${lut.size}`);
	const isUnit = lut.domainMin.every((v) => v === 0) && lut.domainMax.every((v) => v === 1);
	if (!isUnit) {
		out.push(`DOMAIN_MIN ${lut.domainMin.map(fmt6).join(' ')}`);
		out.push(`DOMAIN_MAX ${lut.domainMax.map(fmt6).join(' ')}`);
	}
	const d = lut.data;
	for (let i = 0; i < d.length; i += 3) out.push(`${fmt6(d[i]!)} ${fmt6(d[i + 1]!)} ${fmt6(d[i + 2]!)}`);
	return `${out.join('\n')}\n`;
}

/**
 * Bakes a colour function into a 3D LUT over the unit cube (red fastest). `fn` transforms `c` in place;
 * it receives the lattice point `[r, g, b]` (0..1).
 */
export function bakeLut(size: number, fn: (c: Rgb) => void, title: string | null = null): Lut {
	if (!Number.isInteger(size) || size < 2 || size > MAX_3D) throw new RangeError(`Invalid LUT size ${size}`);
	const data = new Float32Array(size * size * size * 3);
	const s = size - 1;
	const c: Rgb = [0, 0, 0];
	let o = 0;
	for (let b = 0; b < size; b++)
		for (let g = 0; g < size; g++)
			for (let r = 0; r < size; r++) {
				c[0] = r / s;
				c[1] = g / s;
				c[2] = b / s;
				fn(c);
				data[o++] = c[0];
				data[o++] = c[1];
				data[o++] = c[2];
			}
	return { dimensions: 3, size, title, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data };
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Applies a LUT to `c` in place. 3D uses tetrahedral interpolation (the FFmpeg `lut3d` default and what the
 * WebGL preview implements), 1D linear per channel. Inputs are clamped to the domain.
 */
export function applyLut(lut: Lut, c: Rgb): void {
	// Allocation-free (it runs ~36k times per bake): same arithmetic as the reference formulation.
	const s = lut.size - 1;
	const dmin = lut.domainMin;
	const dmax = lut.domainMax;
	const x0 = clamp01((c[0] - dmin[0]) / (dmax[0] - dmin[0])) * s;
	const x1 = clamp01((c[1] - dmin[1]) / (dmax[1] - dmin[1])) * s;
	const x2 = clamp01((c[2] - dmin[2]) / (dmax[2] - dmin[2])) * s;
	const d = lut.data;
	if (lut.dimensions === 1) {
		const i0 = Math.min(s - 1, Math.floor(x0));
		const i1 = Math.min(s - 1, Math.floor(x1));
		const i2 = Math.min(s - 1, Math.floor(x2));
		const f0 = x0 - i0;
		const f1 = x1 - i1;
		const f2 = x2 - i2;
		c[0] = d[3 * i0]! * (1 - f0) + d[3 * (i0 + 1)]! * f0;
		c[1] = d[3 * i1 + 1]! * (1 - f1) + d[3 * (i1 + 1) + 1]! * f1;
		c[2] = d[3 * i2 + 2]! * (1 - f2) + d[3 * (i2 + 1) + 2]! * f2;
		return;
	}
	const n = lut.size;
	const r0 = Math.min(s - 1, Math.floor(x0));
	const g0 = Math.min(s - 1, Math.floor(x1));
	const b0 = Math.min(s - 1, Math.floor(x2));
	const fr = x0 - r0;
	const fg = x1 - g0;
	const fb = x2 - b0;
	// Lattice offsets: +3 per red step, +3n per green step, +3n² per blue step.
	const sr = 3;
	const sg = 3 * n;
	const sb = 3 * n * n;
	const c000 = 3 * (r0 + n * (g0 + n * b0));
	const c111 = c000 + sr + sg + sb;
	// Tetrahedral: pick the tetrahedron by the order of the fractional parts.
	let a: number;
	let b: number;
	let w0: number;
	let w1: number;
	let w2: number;
	let w3: number;
	if (fr > fg) {
		if (fg > fb) {
			a = c000 + sr;
			b = c000 + sr + sg;
			w0 = 1 - fr;
			w1 = fr - fg;
			w2 = fg - fb;
			w3 = fb;
		} else if (fr > fb) {
			a = c000 + sr;
			b = c000 + sr + sb;
			w0 = 1 - fr;
			w1 = fr - fb;
			w2 = fb - fg;
			w3 = fg;
		} else {
			a = c000 + sb;
			b = c000 + sr + sb;
			w0 = 1 - fb;
			w1 = fb - fr;
			w2 = fr - fg;
			w3 = fg;
		}
	} else if (fb > fg) {
		a = c000 + sb;
		b = c000 + sg + sb;
		w0 = 1 - fb;
		w1 = fb - fg;
		w2 = fg - fr;
		w3 = fr;
	} else if (fb > fr) {
		a = c000 + sg;
		b = c000 + sg + sb;
		w0 = 1 - fg;
		w1 = fg - fb;
		w2 = fb - fr;
		w3 = fr;
	} else {
		a = c000 + sg;
		b = c000 + sr + sg;
		w0 = 1 - fg;
		w1 = fg - fr;
		w2 = fr - fb;
		w3 = fb;
	}
	c[0] = w0 * d[c000]! + w1 * d[a]! + w2 * d[b]! + w3 * d[c111]!;
	c[1] = w0 * d[c000 + 1]! + w1 * d[a + 1]! + w2 * d[b + 1]! + w3 * d[c111 + 1]!;
	c[2] = w0 * d[c000 + 2]! + w1 * d[a + 2]! + w2 * d[b + 2]! + w3 * d[c111 + 2]!;
}

/** `out = lerp(c, lut(c), amount)` in place: the "intensity" of a creative LUT (S06:CG-054). */
export function applyLutMix(lut: Lut, c: Rgb, amount: number): void {
	if (amount <= 0) return;
	const r = c[0];
	const g = c[1];
	const b = c[2];
	applyLut(lut, c);
	if (amount >= 1) return;
	c[0] = r + (c[0] - r) * amount;
	c[1] = g + (c[1] - g) * amount;
	c[2] = b + (c[2] - b) * amount;
}
