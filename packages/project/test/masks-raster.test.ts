// wp masks: the coverage definition and the tiled CPU rasteriser (the GL shader's algorithm).
import { describe, expect, it } from 'vitest';
import {
	type BezierPath,
	ellipsePath,
	type MaskMode,
	maskCoverageAt,
	packMasks,
	polygonPath,
	prepareMasks,
	type ResolvedMask,
	rasterizeMaskPack,
	rectPath,
} from '../src/index.ts';

const ident = (q: [number, number]): [number, number] => [q[0], q[1]];

function rm(path: BezierPath, o: Partial<ResolvedMask> = {}): ResolvedMask {
	return {
		id: 'm',
		mode: 'add',
		inverted: false,
		path,
		feather: 0,
		opacity: 100,
		expansion: 0,
		falloff: 'smooth',
		...o,
	};
}

function raster(masks: ResolvedMask[], w: number, h: number) {
	const prepared = prepareMasks(masks, ident, 1);
	return { prepared, cov: rasterizeMaskPack(packMasks(prepared, w, h)!) };
}

describe('mask coverage', () => {
	it('a hard rectangle is exact box coverage', () => {
		const { cov } = raster([rm(rectPath(2, 2, 6.5, 6))], 10, 10);
		expect(cov[3 * 10 + 3]).toBe(1);
		expect(cov[3 * 10 + 1]).toBe(0);
		expect(cov[3 * 10 + 6]).toBeCloseTo(0.5, 6);
		expect(cov[8 * 10 + 3]).toBe(0);
	});

	it('an ellipse area matches the analytic area', () => {
		const rx = 37.3;
		const ry = 21.7;
		const { cov } = raster([rm(ellipsePath([50.2, 40.1], [rx, ry]))], 100, 80);
		const area = cov.reduce((a, b) => a + b, 0);
		const exact = Math.PI * rx * ry;
		expect(Math.abs(area - exact) / exact).toBeLessThan(0.002);
	});

	it('feather is a symmetric distance falloff centred on the edge', () => {
		const { cov } = raster([rm(rectPath(20, -100, 200, 200), { feather: 10 })], 60, 4);
		expect(cov[19]! + cov[20]!).toBeCloseTo(1, 5);
		expect(cov[13]).toBeLessThan(1e-6);
		expect(cov[26]).toBeGreaterThan(1 - 1e-6);
		for (let x = 14; x < 26; x++) expect(cov[x + 1]!).toBeGreaterThanOrEqual(cov[x]!);
	});

	it('expansion, inversion, opacity and modes', () => {
		const sq = rectPath(10, 10, 20, 20);
		let r = raster([rm(sq, { expansion: 5 })], 30, 30).cov;
		expect(r[15 * 30 + 6]).toBe(1);
		expect(r[15 * 30 + 4]).toBe(0);
		r = raster([rm(sq, { inverted: true, opacity: 50 })], 30, 30).cov;
		expect(r[15 * 30 + 15]).toBe(0);
		expect(r[2]).toBe(0.5);
		const big = rm(rectPath(0, 0, 30, 30), { mode: 'add' });
		const hole = rm(sq, { mode: 'subtract' });
		r = raster([big, hole], 30, 30).cov;
		expect(r[15 * 30 + 15]).toBe(0);
		expect(r[5 * 30 + 5]).toBe(1);
		// A lone subtract mask cuts a hole; a lone intersect shows its inside (AE).
		r = raster([rm(sq, { mode: 'subtract' })], 30, 30).cov;
		expect(r[15 * 30 + 15]).toBe(0);
		expect(r[2]).toBe(1);
		r = raster([rm(sq, { mode: 'intersect' })], 30, 30).cov;
		expect(r[15 * 30 + 15]).toBe(1);
		expect(r[2]).toBe(0);
		// none is ignored; open paths are ignored.
		expect(prepareMasks([rm(sq, { mode: 'none' })], ident, 1)).toHaveLength(0);
		expect(prepareMasks([rm({ ...sq, closed: false })], ident, 1)).toHaveLength(0);
	});

	it('the tiled rasteriser matches the brute-force definition (every mode, feather, expansion, inversion)', () => {
		const modes: MaskMode[] = ['add', 'subtract', 'intersect', 'lighten', 'darken', 'difference'];
		let seed = 7;
		const rnd = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		for (let trial = 0; trial < 6; trial++) {
			const masks: ResolvedMask[] = [];
			for (let k = 0; k < 3; k++) {
				const shape =
					k === 0
						? ellipsePath([20 + rnd() * 40, 15 + rnd() * 30], [8 + rnd() * 20, 6 + rnd() * 15])
						: polygonPath(
								Array.from(
									{ length: 3 + Math.floor(rnd() * 5) },
									() => [rnd() * 70, rnd() * 50] as [number, number],
								),
							);
				masks.push(
					rm(shape, {
						mode: modes[Math.floor(rnd() * modes.length)]!,
						inverted: rnd() < 0.3,
						feather: rnd() < 0.5 ? 0 : rnd() * 12,
						expansion: (rnd() - 0.5) * 8,
						opacity: 40 + rnd() * 60,
						falloff: rnd() < 0.3 ? 'linear' : 'smooth',
					}),
				);
			}
			const w = 70;
			const h = 50;
			const prepared = prepareMasks(masks, ident, 1);
			const cov = rasterizeMaskPack(packMasks(prepared, w, h)!);
			for (let y = 0; y < h; y++)
				for (let x = 0; x < w; x++) {
					const ref = maskCoverageAt(prepared, x + 0.5, y + 0.5)!;
					expect(Math.abs(ref - cov[y * w + x]!)).toBeLessThan(1e-4);
				}
		}
	});

	it('variable feather points (outer on top, inner at the bottom)', () => {
		// 100×100 square from (50,50) to (150,150), segments: top, right, bottom, left.
		const sq: BezierPath = {
			...rectPath(50, 50, 150, 150),
			feather: [
				{ segment: 0, t: 0.5, radius: 20, tension: 1 },
				{ segment: 2, t: 0.5, radius: -20, tension: 1 },
			],
		};
		const { cov, prepared } = raster([rm(sq, { falloff: 'linear' })], 200, 200);
		const at = (x: number, y: number) => cov[y * 200 + x]!;
		// Top: soft outside (the outer radius reaches 20 px out), hard inside.
		expect(at(100, 45)).toBeGreaterThan(0.6);
		expect(at(100, 45)).toBeLessThan(0.8);
		expect(at(100, 52)).toBeGreaterThan(0.97);
		// Bottom: hard outside, soft inside.
		expect(at(100, 152)).toBeLessThan(0.02);
		expect(at(100, 140)).toBeGreaterThan(0.4);
		expect(at(100, 140)).toBeLessThan(0.6);
		// The tiled rasteriser agrees with the definition here too.
		for (const [x, y] of [
			[100, 45],
			[154, 100],
			[145, 100],
			[100, 140],
		] as const)
			expect(Math.abs(at(x, y) - maskCoverageAt(prepared, x + 0.5, y + 0.5)!)).toBeLessThan(1e-4);
	});

	it('px scale converts feather and expansion', () => {
		const half = prepareMasks(
			[rm(rectPath(0, 0, 1, 1), { feather: 10, expansion: 4 })],
			(q) => [q[0] * 50, q[1] * 50],
			0.5,
		);
		expect(half[0]!.feather).toBe(5);
		expect(half[0]!.expansion).toBe(2);
	});
});
