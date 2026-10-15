import { describe, expect, it } from 'vitest';
import {
	type BezierPath,
	ellipsePath,
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
	return { cov: rasterizeMaskPack(packMasks(prepared, w, h)!) };
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
		expect(prepareMasks([rm(sq, { mode: 'none' })], ident, 1)).toHaveLength(0);
		expect(prepareMasks([rm({ ...sq, closed: false })], ident, 1)).toHaveLength(0);
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
		const { cov } = raster([rm(sq, { falloff: 'linear' })], 200, 200);
		const at = (x: number, y: number) => cov[y * 200 + x]!;
		// Top: soft outside (the outer radius reaches 20 px out), hard inside.
		expect(at(100, 45)).toBeGreaterThan(0.6);
		expect(at(100, 45)).toBeLessThan(0.8);
		expect(at(100, 52)).toBeGreaterThan(0.97);
		// Bottom: hard outside, soft inside.
		expect(at(100, 152)).toBeLessThan(0.02);
		expect(at(100, 140)).toBeGreaterThan(0.4);
		expect(at(100, 140)).toBeLessThan(0.6);
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

describe('mask coverage golden frame', () => {
	it('a fixed stack of every feature rasterises to the stored checksum (8-bit, 160×90)', () => {
		const masks: ResolvedMask[] = [
			rm(ellipsePath([70, 45], [50, 30]), { feather: 12, expansion: 3 }),
			rm(rectPath(60, 20, 140, 70), { mode: 'subtract', feather: 4, opacity: 80 }),
			rm(
				polygonPath([
					[10, 80],
					[80, 5],
					[150, 85],
				]),
				{ mode: 'lighten', inverted: true, opacity: 35, falloff: 'linear', feather: 20 },
			),
			rm(
				{ ...rectPath(20, 10, 60, 50), feather: [{ segment: 1, t: 0.5, radius: 15, tension: 0.3 }] },
				{ mode: 'difference' },
			),
		];
		const { cov } = raster(masks, 160, 90);
		let h = 2166136261;
		let sum = 0;
		for (const v of cov) {
			const b = Math.round(v * 255);
			sum += b;
			h = Math.imul(h ^ b, 16777619) >>> 0;
		}
		expect({ sum, hash: h.toString(16) }).toMatchSnapshot();
	});
});
