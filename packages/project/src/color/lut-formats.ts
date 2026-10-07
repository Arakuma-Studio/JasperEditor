// LUT file formats besides `.cube` (workstream color-mgmt), all parsed into the one `Lut` representation (lut.ts):
// - Autodesk `.3dl` (Lustre/Flame/Nuke): optional `3DMESH` / `Mesh <in> <out>` header, the input mesh line (e.g.
//   `0 64 … 1023`; it sets the input bit depth and need not be uniform: a non-uniform mesh becomes a 1D shaper), then
//   n³ integer rows with **blue changing fastest**; output depth from the `Mesh` header or the largest value.
// - Sony Pictures Imageworks `.spi1d` (Version 1, From, Length, Components, `{ … }`) and `.spi3d` (SPILUT 1.0, sizes,
//   `i j k r g b` rows in any order).
// - Rising Sun cineSpace `.csp` (CSPLUTV100, 1D or 3D, per-channel non-uniform pre-LUTs resampled to one shaper).
// `parseLutFile` dispatches by file extension (sniffing when it is unknown). Every parser throws `CubeParseError`
// (= `LutParseError`) with a 1-based line number; sizes are capped (65536 for 1D, 256 for 3D).
// The `.3dl` reader and writer are ported from FilmCraft `crates/color/src/lut.rs` (MIT OR Apache-2.0).
import { applyLut, bakeLut, CubeParseError, type Lut, parseCube, type Rgb } from './lut.ts';

export const LUT_FILE_EXTENSIONS = ['cube', '3dl', 'spi1d', 'spi3d', 'csp'] as const;
export type LutFileFormat = (typeof LUT_FILE_EXTENSIONS)[number];

const MAX_1D = 65536;
const MAX_3D = 256;
const SHAPER_SIZE = 4096;

/** Format of a LUT file name, or null. */
export function lutFormatOf(name: string): LutFileFormat | null {
	const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
	return (LUT_FILE_EXTENSIONS as readonly string[]).includes(ext ?? '') ? (ext as LutFileFormat) : null;
}

/** Parses a LUT file by format (sniffed from the content when null). */
export function parseLutFile(text: string, format: LutFileFormat | null): Lut {
	const f = format ?? sniff(text);
	switch (f) {
		case 'cube':
			return parseCube(text);
		case '3dl':
			return parse3dl(text);
		case 'spi1d':
			return parseSpi1d(text);
		case 'spi3d':
			return parseSpi3d(text);
		case 'csp':
			return parseCsp(text);
	}
}

function sniff(text: string): LutFileFormat {
	const head = text.slice(0, 4096);
	if (/^\s*CSPLUTV100/m.test(head)) return 'csp';
	if (/^\s*SPILUT/m.test(head)) return 'spi3d';
	if (/^\s*Version\s+1/m.test(head) && /\{/.test(head)) return 'spi1d';
	if (/LUT_(1|3)D_SIZE/.test(head)) return 'cube';
	return '3dl';
}

type Line = { no: number; text: string };
function contentLines(text: string): Line[] {
	const out: Line[] = [];
	const ls = text.split(/\r?\n/);
	for (let i = 0; i < ls.length; i++) {
		const raw = ls[i]!;
		const h = raw.indexOf('#');
		const t = (h >= 0 ? raw.slice(0, h) : raw).trim();
		if (t) out.push({ no: i + 1, text: t });
	}
	return out;
}
function numbers(l: Line): number[] {
	const v = l.text.split(/\s+/).map(Number);
	for (const x of v) if (!Number.isFinite(x)) throw new CubeParseError(`Not a number in "${l.text}"`, l.no);
	return v;
}

/** Full-scale value of the smallest common integer depth that holds `v`. */
function bitMax(v: number): number {
	for (const m of [255, 1023, 4095, 16383, 65535]) if (v <= m) return m;
	return 65535;
}

/** A 1D shaper (identity per channel) mapping x to its fractional index on a non-uniform mesh, over 0..1. */
function meshShaper(meshes: readonly (readonly number[])[], inMax: readonly number[]): Lut {
	const data = new Float32Array(SHAPER_SIZE * 3);
	for (let c = 0; c < 3; c++) {
		const mesh = meshes[c]!;
		const n = mesh.length;
		let j = 1;
		for (let k = 0; k < SHAPER_SIZE; k++) {
			const x = (k / (SHAPER_SIZE - 1)) * inMax[c]!;
			while (j < n - 1 && mesh[j]! < x) j++;
			const t = Math.min(1, Math.max(0, (x - mesh[j - 1]!) / (mesh[j]! - mesh[j - 1]!)));
			data[3 * k + c] = (j - 1 + t) / (n - 1);
		}
	}
	return { dimensions: 1, size: SHAPER_SIZE, title: null, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data };
}

const isUniform = (mesh: readonly number[]) => {
	const n = mesh.length;
	return mesh.every(
		(m, i) =>
			Math.abs(m - (mesh[0]! + ((mesh[n - 1]! - mesh[0]!) * i) / (n - 1))) <=
			1e-3 * Math.max(1, Math.abs(mesh[n - 1]!)),
	);
};

// ---------------------------------------------------------------- .3dl

export function parse3dl(text: string): Lut {
	let mesh: number[] | null = null;
	let meshLine = 0;
	let outBits: number | null = null;
	const rows: number[] = [];
	for (const l of contentLines(text)) {
		const first = l.text.split(/\s+/)[0]!;
		const f = first.toLowerCase();
		if (f === '3dmesh' || f === 'lut8' || f === 'gamma') continue;
		if (f === 'mesh') {
			const v = l.text.split(/\s+/).slice(1).map(Number);
			if (v.length === 2 && Number.isInteger(v[1]) && v[1]! >= 8 && v[1]! <= 16) outBits = v[1]!;
			continue;
		}
		const v = numbers(l);
		if (!mesh) {
			if (v.length < 2) throw new CubeParseError('Expected the input mesh line', l.no);
			if (v.length > MAX_3D)
				throw new CubeParseError(`Input mesh has ${v.length} points (max ${MAX_3D})`, l.no);
			mesh = v;
			meshLine = l.no;
			continue;
		}
		if (v.length !== 3) throw new CubeParseError('Data rows need three values', l.no);
		if (rows.length >= mesh.length ** 3 * 3) throw new CubeParseError('More rows than the mesh size', l.no);
		rows.push(v[0]!, v[1]!, v[2]!);
	}
	if (!mesh) throw new CubeParseError('Empty .3dl file', 0);
	const n = mesh.length;
	if (rows.length !== n * n * n * 3)
		throw new CubeParseError(`Expected ${n}³ = ${n * n * n} rows, found ${rows.length / 3}`, 0);
	for (let i = 1; i < n; i++)
		if (!(mesh[i]! > mesh[i - 1]!)) throw new CubeParseError('The input mesh must increase', meshLine);
	const inMax = bitMax(mesh[n - 1]!);
	let peak = 0;
	for (const v of rows) peak = Math.max(peak, v);
	const outMax = outBits !== null ? 2 ** outBits - 1 : bitMax(peak);
	// Blue fastest in the file → red fastest in memory.
	const data = new Float32Array(n * n * n * 3);
	for (let i = 0; i < n * n * n; i++) {
		const ri = Math.floor(i / (n * n));
		const gi = Math.floor(i / n) % n;
		const bi = i % n;
		const o = 3 * (ri + n * (gi + n * bi));
		data[o] = rows[3 * i]! / outMax;
		data[o + 1] = rows[3 * i + 1]! / outMax;
		data[o + 2] = rows[3 * i + 2]! / outMax;
	}
	if (isUniform(mesh)) {
		const lo = mesh[0]! / inMax;
		const hi = mesh[n - 1]! / inMax;
		return { dimensions: 3, size: n, title: null, domainMin: [lo, lo, lo], domainMax: [hi, hi, hi], data };
	}
	return {
		dimensions: 3,
		size: n,
		title: null,
		domainMin: [0, 0, 0],
		domainMax: [1, 1, 1],
		data,
		shaper: meshShaper([mesh, mesh, mesh], [inMax, inMax, inMax]),
	};
}

/** Writes a `.3dl` (33-point 10-bit input mesh, 12-bit output); shapers and custom domains are baked first. */
export function write3dl(lut: Lut, title?: string | null): string {
	const cube = flattenLut(lut, 33);
	const n = cube.size;
	const out: string[] = ['# written by JasperEditor'];
	if (title ?? lut.title) out.push(`# ${(title ?? lut.title)!.replace(/[\r\n]/g, ' ')}`);
	out.push(Array.from({ length: n }, (_, i) => Math.round((i * 1023) / (n - 1))).join(' '));
	const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 4095);
	const d = cube.data;
	for (let r = 0; r < n; r++)
		for (let g = 0; g < n; g++)
			for (let b = 0; b < n; b++) {
				const o = 3 * (r + n * (g + n * b));
				out.push(`${q(d[o]!)} ${q(d[o + 1]!)} ${q(d[o + 2]!)}`);
			}
	return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------- .spi1d / .spi3d

export function parseSpi1d(text: string): Lut {
	let from: [number, number] = [0, 1];
	let length = 0;
	let components = 1;
	const values: number[] = [];
	let inBlock = false;
	let done = false;
	for (const l of contentLines(text)) {
		if (!inBlock) {
			const [key, ...rest] = l.text.split(/\s+/);
			switch (key!.toLowerCase()) {
				case 'version':
					break;
				case 'from': {
					const a = Number(rest[0]);
					const b = Number(rest[1]);
					if (!Number.isFinite(a) || !Number.isFinite(b) || !(b > a))
						throw new CubeParseError('Invalid From', l.no);
					from = [a, b];
					break;
				}
				case 'length':
					length = Number(rest[0]);
					if (!Number.isInteger(length) || length < 2 || length > MAX_1D)
						throw new CubeParseError('Invalid Length', l.no);
					break;
				case 'components':
					components = Number(rest[0]);
					if (![1, 2, 3].includes(components)) throw new CubeParseError('Invalid Components', l.no);
					break;
				case '{':
					inBlock = true;
					break;
				default:
					if (l.text.startsWith('{')) inBlock = true;
					else throw new CubeParseError(`Unexpected "${l.text}"`, l.no);
			}
			continue;
		}
		if (l.text.startsWith('}')) {
			done = true;
			break;
		}
		const v = numbers(l);
		if (v.length !== components) throw new CubeParseError(`Expected ${components} value(s)`, l.no);
		if (values.length >= length * components) throw new CubeParseError('More values than Length', l.no);
		values.push(...v);
	}
	if (!length) throw new CubeParseError('No Length', 0);
	if (!done) throw new CubeParseError('Missing closing "}"', 0);
	if (values.length !== length * components)
		throw new CubeParseError(`Expected ${length} entries, found ${values.length / components}`, 0);
	const data = new Float32Array(length * 3);
	for (let i = 0; i < length; i++)
		for (let c = 0; c < 3; c++) data[3 * i + c] = values[i * components + Math.min(c, components - 1)]!;
	return {
		dimensions: 1,
		size: length,
		title: null,
		domainMin: [from[0], from[0], from[0]],
		domainMax: [from[1], from[1], from[1]],
		data,
	};
}

export function parseSpi3d(text: string): Lut {
	const ls = contentLines(text);
	if (!ls[0] || !/^SPILUT/i.test(ls[0].text)) throw new CubeParseError('Not an SPILUT file', ls[0]?.no ?? 0);
	const dims = ls[1] ? numbers(ls[1]) : [];
	if (dims[0] !== 3 || dims[1] !== 3)
		throw new CubeParseError('Only 3D → 3D SPILUT files are supported', ls[1]?.no ?? 0);
	const sizes = ls[2] ? numbers(ls[2]) : [];
	const n = sizes[0]!;
	if (sizes.length !== 3 || !sizes.every((s) => s === n) || !Number.isInteger(n) || n < 2 || n > MAX_3D)
		throw new CubeParseError('Expected one cube size (n n n, 2…256)', ls[2]?.no ?? 0);
	const data = new Float32Array(n * n * n * 3);
	const seen = new Uint8Array(n * n * n);
	let count = 0;
	for (const l of ls.slice(3)) {
		const v = numbers(l);
		if (v.length !== 6) throw new CubeParseError('Rows need i j k r g b', l.no);
		const [i, j, k] = v as [number, number, number];
		if (![i, j, k].every((x) => Number.isInteger(x) && x >= 0 && x < n))
			throw new CubeParseError('Index out of range', l.no);
		const idx = i + n * (j + n * k);
		if (seen[idx]) throw new CubeParseError('Duplicate lattice point', l.no);
		seen[idx] = 1;
		count++;
		data[3 * idx] = v[3]!;
		data[3 * idx + 1] = v[4]!;
		data[3 * idx + 2] = v[5]!;
	}
	if (count !== n * n * n) throw new CubeParseError(`Expected ${n * n * n} rows, found ${count}`, 0);
	return { dimensions: 3, size: n, title: null, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data };
}

// ---------------------------------------------------------------- .csp

export function parseCsp(text: string): Lut {
	const ls = contentLines(text);
	if (ls[0]?.text !== 'CSPLUTV100')
		throw new CubeParseError('Not a cineSpace CSPLUTV100 file', ls[0]?.no ?? 0);
	const kind = ls[1]?.text;
	if (kind !== '1D' && kind !== '3D') throw new CubeParseError('Expected 1D or 3D', ls[1]?.no ?? 0);
	let i = 2;
	if (ls[i]?.text === 'BEGIN METADATA') {
		while (i < ls.length && ls[i]!.text !== 'END METADATA') i++;
		i++;
	}
	const next = (): Line => {
		const l = ls[i++];
		if (!l) throw new CubeParseError('Unexpected end of file', 0);
		return l;
	};
	const meshes: number[][] = [];
	const outs: number[][] = [];
	for (let c = 0; c < 3; c++) {
		const cl = next();
		const count = Number(cl.text);
		if (!Number.isInteger(count) || count < 2 || count > MAX_1D)
			throw new CubeParseError('Invalid pre-LUT size', cl.no);
		const ins = numbers(next());
		const os = numbers(next());
		if (ins.length !== count || os.length !== count)
			throw new CubeParseError('Pre-LUT rows must hold the stated count', cl.no);
		for (let k = 1; k < count; k++)
			if (!(ins[k]! > ins[k - 1]!)) throw new CubeParseError('Pre-LUT inputs must increase', cl.no);
		meshes.push(ins);
		outs.push(os);
	}
	// One shaper over the union of the input ranges: x → piecewise-linear pre-LUT, per channel.
	const lo = Math.min(...meshes.map((m) => m[0]!));
	const hi = Math.max(...meshes.map((m) => m[m.length - 1]!));
	const shaperData = new Float32Array(SHAPER_SIZE * 3);
	for (let c = 0; c < 3; c++) {
		const m = meshes[c]!;
		const o = outs[c]!;
		let j = 1;
		for (let k = 0; k < SHAPER_SIZE; k++) {
			const x = lo + ((hi - lo) * k) / (SHAPER_SIZE - 1);
			while (j < m.length - 1 && m[j]! < x) j++;
			const t = Math.min(1, Math.max(0, (x - m[j - 1]!) / (m[j]! - m[j - 1]!)));
			shaperData[3 * k + c] = o[j - 1]! + (o[j]! - o[j - 1]!) * t;
		}
	}
	const shaper: Lut = {
		dimensions: 1,
		size: SHAPER_SIZE,
		title: null,
		domainMin: [lo, lo, lo],
		domainMax: [hi, hi, hi],
		data: shaperData,
	};
	if (kind === '1D') {
		const cl = next();
		const count = Number(cl.text);
		if (!Number.isInteger(count) || count < 2 || count > MAX_1D)
			throw new CubeParseError('Invalid 1D size', cl.no);
		const data = new Float32Array(count * 3);
		for (let k = 0; k < count; k++) {
			const v = numbers(next());
			if (v.length !== 3) throw new CubeParseError('Rows need three values', ls[i - 1]!.no);
			data.set(v, 3 * k);
		}
		const table: Lut = {
			dimensions: 1,
			size: count,
			title: null,
			domainMin: [0, 0, 0],
			domainMax: [1, 1, 1],
			data,
		};
		// 1D after 1D: compose into one table over the shaper's domain.
		const composed = new Float32Array(SHAPER_SIZE * 3);
		const c: Rgb = [0, 0, 0];
		for (let k = 0; k < SHAPER_SIZE; k++) {
			c[0] = shaperData[3 * k]!;
			c[1] = shaperData[3 * k + 1]!;
			c[2] = shaperData[3 * k + 2]!;
			applyLut(table, c);
			composed.set(c, 3 * k);
		}
		return { ...shaper, data: composed };
	}
	const sl = next();
	const sizes = numbers(sl);
	const n = sizes[0]!;
	if (sizes.length !== 3 || !sizes.every((s) => s === n) || !Number.isInteger(n) || n < 2 || n > MAX_3D)
		throw new CubeParseError('Expected one cube size (n n n)', sl.no);
	const data = new Float32Array(n * n * n * 3);
	for (let k = 0; k < n * n * n; k++) {
		const l = next();
		const v = numbers(l);
		if (v.length !== 3) throw new CubeParseError('Rows need three values', l.no);
		data.set(v, 3 * k);
	}
	return { dimensions: 3, size: n, title: null, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data, shaper };
}

// ---------------------------------------------------------------- utilities

/** A plain 3D LUT over the unit cube (shapers, 1D tables and custom domains baked); the LUT itself when it is one. */
export function flattenLut(lut: Lut, size = 33): Lut {
	const plain =
		lut.dimensions === 3 &&
		!lut.shaper &&
		lut.domainMin.every((v) => v === 0) &&
		lut.domainMax.every((v) => v === 1);
	if (plain) return lut;
	return bakeLut(size, (c) => applyLut(lut, c), lut.title);
}

/** Human summary of a LUT's structure (Project panel, MCP). */
export function describeLut(lut: Lut): string {
	const core = lut.dimensions === 1 ? `1D ${lut.size}` : `${lut.size}³`;
	return lut.shaper ? `1D ${lut.shaper.size} shaper + ${core}` : core;
}
