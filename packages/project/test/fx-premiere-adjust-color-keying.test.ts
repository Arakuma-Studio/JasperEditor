import { describe, expect, it } from 'vitest';
import { kernelMat3 } from '../src/registry/fx/premiere-adjust-color-keying/adjust.ts';
import { transformInverse } from '../src/registry/fx/premiere-adjust-color-keying/transform.ts';

describe('effect coordinate math', () => {
	it('Convolution Kernel → column-major mat3 (m[col][row] = M<row><col>)', () => {
		const m = kernelMat3({ m12: 5, m21: 7 });
		expect(m).toEqual([0, 7, 0, 5, 1, 0, 0, 0, 0]);
	});

	it('Transform inverse: identity by default; position, scale and rotation invert exactly', () => {
		const size = { width: 100, height: 50 };
		expect(transformInverse({}, size)!.map((v) => v + 0)).toEqual([1, 0, 0, 1, 0, 0]);
		const apply = (m: number[], x: number, y: number) => [
			m[0]! * x + m[2]! * y + m[4]!,
			m[1]! * x + m[3]! * y + m[5]!,
		];
		const moved = transformInverse({ position: [0.75, 0.5] }, size)!;
		expect(apply(moved, 75, 25)).toEqual([50, 25]);
		const scaled = transformInverse({ uniformScale: false, scaleWidth: 200, scaleHeight: 50 }, size)!;
		const [sx, sy] = apply(scaled, 70, 30);
		expect(sx).toBeCloseTo(60);
		expect(sy).toBeCloseTo(35);
		const rot = transformInverse({ rotation: 90 }, size)!;
		const [rx, ry] = apply(rot, 50, 35); // 10 px below the centre came from 10 px right of it (clockwise)
		expect(rx).toBeCloseTo(60);
		expect(ry).toBeCloseTo(25);
		expect(transformInverse({ scaleHeight: 0 }, size)).toBeNull();
	});
});
