import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	applyLut,
	bakeLut,
	CubeParseError,
	describeLut,
	flattenLut,
	type Lut,
	lutFormatOf,
	parse3dl,
	parseCsp,
	parseCube,
	parseLutFile,
	parseSpi1d,
	parseSpi3d,
	type Rgb,
	serializeCube,
	write3dl,
} from '../src/index.ts';

const at = (l: Lut, c: Rgb): Rgb => {
	const o: Rgb = [c[0], c[1], c[2]];
	applyLut(l, o);
	return o;
};
const node = (l: Lut, r: number, g: number, b: number): Rgb => {
	const o = 3 * (r + l.size * (g + l.size * b));
	return [l.data[o]!, l.data[o + 1]!, l.data[o + 2]!];
};

/** Brute-force tetrahedral reference (FilmCraft lut.rs test): the Kuhn simplex whose barycentric weights are ≥ 0. */
function bruteTetra(l: Lut, c: Rgb): Rgb {
	const n = l.size;
	const g = [0, 1, 2].map((k) => Math.min(1, Math.max(0, c[k]!)) * (n - 1));
	const base = g.map((v) => Math.min(Math.floor(v), n - 2));
	const f = [g[0]! - base[0]!, g[1]! - base[1]!, g[2]! - base[2]!];
	const perms = [
		[0, 1, 2],
		[0, 2, 1],
		[1, 0, 2],
		[1, 2, 0],
		[2, 0, 1],
		[2, 1, 0],
	];
	for (const p of perms) {
		// vertices 0, e_p0, e_p0 + e_p1, 1; weights from the sorted fractions
		const s = [f[p[0]!]!, f[p[1]!]!, f[p[2]!]!];
		if (!(s[0]! >= s[1]! - 1e-12 && s[1]! >= s[2]! - 1e-12)) continue;
		const w = [1 - s[0]!, s[0]! - s[1]!, s[1]! - s[2]!, s[2]!];
		const v1 = [0, 0, 0];
		v1[p[0]!] = 1;
		const v2 = [...v1];
		v2[p[1]!] = 1;
		const verts = [[0, 0, 0], v1, v2, [1, 1, 1]];
		const o: Rgb = [0, 0, 0];
		verts.forEach((v, k) => {
			const val = node(l, base[0]! + v[0]!, base[1]! + v[1]!, base[2]! + v[2]!);
			for (let ch = 0; ch < 3; ch++) o[ch] += w[k]! * val[ch]!;
		});
		return o;
	}
	throw new Error('no simplex');
}

const wild = (size: number) =>
	bakeLut(size, (c) => {
		const [r, g, b] = c;
		c[0] = Math.sin(r * g + b * b);
		c[1] = g ** 0.45 * (1 - 0.3 * r);
		c[2] = Math.abs(r - b) + 0.1 * g;
	});

describe('tetrahedral interpolation', () => {
	it('matches the brute-force simplex reference for sizes 2–33', () => {
		let s = 12345;
		const rnd = () => {
			s = (s * 1103515245 + 12345) % 2147483648;
			return s / 2147483648;
		};
		for (const size of [2, 5, 17, 33]) {
			const l = wild(size);
			for (let i = 0; i < 2000; i++) {
				const c: Rgb = [rnd() * 1.1 - 0.05, rnd(), rnd()];
				const a = at(l, c);
				const b = bruteTetra(l, c);
				for (let k = 0; k < 3; k++) expect(Math.abs(a[k]! - b[k]!)).toBeLessThan(2e-6);
			}
		}
	});
	it('is exact on affine LUTs and at lattice nodes', () => {
		const aff = (c: Rgb) => {
			const [r, g, b] = c;
			c[0] = 0.2 + 0.5 * r - 0.1 * b;
			c[1] = 0.3 * g + 0.4 * r;
			c[2] = 0.9 * b - 0.05;
		};
		const l = bakeLut(9, aff);
		for (const c of [
			[0.13, 0.77, 0.5],
			[0.99, 0.01, 0.42],
		] as Rgb[]) {
			const want: Rgb = [c[0], c[1], c[2]];
			aff(want);
			const got = at(l, c);
			for (let k = 0; k < 3; k++) expect(Math.abs(got[k]! - want[k]!)).toBeLessThan(1e-6);
		}
		const w = wild(7);
		expect(at(w, [3 / 6, 5 / 6, 1 / 6])).toEqual(node(w, 3, 5, 1));
	});
});

describe('.cube', () => {
	it('1D shaper + 3D (Resolve layout): parse, apply, write, read back', () => {
		const shaper = 'LUT_1D_SIZE 3\nLUT_1D_INPUT_RANGE 0 4\n0 0 0\n0.5 0.5 0.5\n1 1 1\n';
		const cube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
		const text = `TITLE "shaped"\n${shaper.split('\n').slice(0, 2).join('\n')}\n${cube.split('\n')[0]}\n${shaper.split('\n').slice(2).join('\n')}${cube.split('\n').slice(1).join('\n')}`;
		const l = parseCube(text);
		expect(l.dimensions).toBe(3);
		expect(l.shaper?.size).toBe(3);
		expect(l.shaper?.domainMax).toEqual([4, 4, 4]);
		expect(l.domainMax).toEqual([1, 1, 1]);
		const v = at(l, [1, 2, 3]); // shaper: x/4
		for (let k = 0; k < 3; k++) expect(v[k]).toBeCloseTo((k + 1) / 4, 6);
		const back = parseCube(serializeCube(l));
		expect(back.shaper?.size).toBe(3);
		expect(at(back, [1, 2, 3])).toEqual(v);
		expect(describeLut(l)).toBe('1D 3 shaper + 2³');
	});
	it('1D only, with LUT_1D_INPUT_RANGE', () => {
		const l = parseCube('LUT_1D_SIZE 2\nLUT_1D_INPUT_RANGE 0 2\n0 0 0\n1 0.5 0.25\n');
		expect(l.dimensions).toBe(1);
		expect(at(l, [1, 1, 1])).toEqual([0.5, 0.25, 0.125]);
	});
	it('a 3D LUT with LUT_3D_INPUT_RANGE alone takes that domain', () => {
		const l = parseCube(
			'LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE -0.5 1.5\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n',
		);
		expect(l.domainMin).toEqual([-0.5, -0.5, -0.5]);
		expect(at(l, [0.5, 0.5, 0.5])).toEqual([0.5, 0.5, 0.5]);
	});
	it('refuses duplicate sizes and data before sizes', () => {
		expect(() => parseCube('LUT_3D_SIZE 2\nLUT_3D_SIZE 2\n')).toThrow(CubeParseError);
		expect(() => parseCube('0 0 0\nLUT_3D_SIZE 2\n')).toThrow(CubeParseError);
		expect(() => parseCube('LUT_3D_SIZE 2\nLUT_1D_SIZE 2\n0 0 0\n')).toThrow(/Expected 10 table entries/);
	});
});

describe('.3dl', () => {
	it('round-trips with blue-fastest orientation (a red↔blue swap shows any mistake)', () => {
		const swap = bakeLut(17, (c) => {
			const r = c[0];
			c[0] = c[2];
			c[1] *= 0.5;
			c[2] = r;
		});
		const text = write3dl(swap);
		expect(text.split('\n')[1]).toMatch(/^0 64 128 /);
		const back = parse3dl(text);
		for (const c of [
			[0.1, 0.2, 0.9],
			[0.8, 0.5, 0.3],
		] as Rgb[]) {
			const a = at(swap, c);
			const b = at(back, c);
			for (let k = 0; k < 3; k++) expect(Math.abs(a[k]! - b[k]!)).toBeLessThan(1 / 4095 + 1e-4);
		}
	});
	it('reads a hand-written Lustre file (Mesh header, 12-bit output)', () => {
		const lustre =
			'3DMESH\nMesh 1 12\n0 1023\n0 0 0\n0 0 4095\n0 4095 0\n0 4095 4095\n4095 0 0\n4095 0 4095\n4095 4095 0\n4095 4095 4095\n';
		const l = parse3dl(lustre);
		const v = at(l, [0.2, 0.4, 0.6]);
		for (let k = 0; k < 3; k++) expect(v[k]).toBeCloseTo([0.2, 0.4, 0.6][k]!, 4);
	});
	it('a non-uniform input mesh becomes a 1D shaper', () => {
		let rows = '';
		for (let i = 0; i < 27; i++)
			rows += `${Math.floor(i / 9) * 2047} ${(Math.floor(i / 3) % 3) * 2047} ${(i % 3) * 2047}\n`;
		const l = parse3dl(`0 100 1023\n${rows}`);
		expect(l.shaper).toBeTruthy();
		expect(at(l, [100 / 1023, 0, 1])[0]).toBeCloseTo(2047 / 4095, 3);
		expect(() => parse3dl('0 512 1023\n1 2 3\n')).toThrow(CubeParseError);
		expect(() => parse3dl('0 1023 512\n')).toThrow(CubeParseError);
	});
});

describe('.spi1d / .spi3d / .csp', () => {
	it('spi1d with From and one component', () => {
		const l = parseSpi1d('Version 1\nFrom 0.0 2.0\nLength 3\nComponents 1\n{\n0\n0.25\n1\n}\n');
		expect(l.dimensions).toBe(1);
		expect(at(l, [1, 1.5, 2])).toEqual([0.25, 0.625, 1]);
		expect(() => parseSpi1d('Version 1\nLength 3\n{\n0\n1\n}\n')).toThrow(CubeParseError);
	});
	it('spi3d rows with explicit indices', () => {
		let rows = '';
		for (let i = 0; i < 2; i++)
			for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) rows += `${i} ${j} ${k} ${k} ${j} ${i}\n`;
		const l = parseSpi3d(`SPILUT 1.0\n3 3\n2 2 2\n${rows}`);
		expect(at(l, [0.25, 0.5, 0.75])).toEqual([0.75, 0.5, 0.25]);
		expect(() => parseSpi3d('SPILUT 1.0\n3 3\n2 2 2\n0 0 0 1 1 1\n')).toThrow(/Expected 8 rows/);
	});
	it('csp 3D with non-uniform pre-LUTs', () => {
		const pre = '3\n0 0.5 2\n0 0.75 1\n';
		let cube = '2 2 2\n';
		for (let b = 0; b < 2; b++)
			for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) cube += `${r} ${g} ${b}\n`;
		const l = parseCsp(`CSPLUTV100\n3D\n\nBEGIN METADATA\nx\nEND METADATA\n${pre}${pre}${pre}${cube}`);
		expect(l.shaper?.domainMax).toEqual([2, 2, 2]);
		const v = at(l, [0.5, 1.25, 2]);
		expect(v[0]).toBeCloseTo(0.75, 3);
		expect(v[1]).toBeCloseTo(0.875, 3);
		expect(v[2]).toBeCloseTo(1, 6);
	});
	it('dispatches by extension and sniffs unknown files', () => {
		expect(lutFormatOf('a/Look.CUBE')).toBe('cube');
		expect(lutFormatOf('x.3dl')).toBe('3dl');
		expect(lutFormatOf('x.png')).toBeNull();
		const cube = serializeCube(wild(3));
		expect(parseLutFile(cube, null).size).toBe(3);
		expect(parseLutFile(write3dl(wild(3)), null).size).toBe(3);
		expect(parseLutFile(write3dl(parseCube('LUT_1D_SIZE 2\n0 0 0\n1 1 1\n')), null).size).toBe(33);
	});
	it('flattens shapers and 1D tables into a plain unit cube', () => {
		const l = parseCube('LUT_1D_SIZE 2\nLUT_1D_INPUT_RANGE 0 2\n0 0 0\n1 0.5 0.25\n');
		const f = flattenLut(l, 17);
		expect(f.dimensions).toBe(3);
		expect(f.shaper).toBeUndefined();
		const p = wild(5);
		expect(flattenLut(p)).toBe(p);
	});
});

describe('parsers on hostile input (fuzz)', () => {
	const formats = ['cube', '3dl', 'spi1d', 'spi3d', 'csp', null] as const;
	it('random text throws only CubeParseError', () => {
		fc.assert(
			fc.property(fc.constantFrom(...formats), fc.string({ maxLength: 400 }), (f, t) => {
				try {
					parseLutFile(t, f);
				} catch (e) {
					return e instanceof CubeParseError;
				}
				return true;
			}),
			{ numRuns: 3000 },
		);
	});
	it('mutated valid files throw only CubeParseError', () => {
		const seeds = [
			serializeCube(wild(3)),
			write3dl(wild(2)).split('\n').slice(0, 12).join('\n'),
			'Version 1\nFrom 0 1\nLength 2\nComponents 3\n{\n0 0 0\n1 1 1\n}\n',
		];
		fc.assert(
			fc.property(
				fc.constantFrom(...seeds),
				fc.integer({ min: 0, max: 400 }),
				fc.string({ maxLength: 8 }),
				(seed, pos, ins) => {
					const t = seed.slice(0, pos) + ins + seed.slice(pos + ins.length);
					for (const f of formats) {
						try {
							parseLutFile(t, f);
						} catch (e) {
							if (!(e instanceof CubeParseError)) return false;
						}
					}
					return true;
				},
			),
			{ numRuns: 1500 },
		);
	});
});
