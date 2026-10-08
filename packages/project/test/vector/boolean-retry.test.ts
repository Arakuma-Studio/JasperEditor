// PathBool.js failing on one orientation of the input must not empty a Merge Paths result (wp fixups).
import { describe, expect, it, vi } from 'vitest';

const failures = vi.hoisted(() => ({ left: 0 }));
vi.mock('path-bool', async (importOriginal) => {
	const real = await importOriginal<typeof import('path-bool')>();
	class FlakyPathBoolean extends real.PathBoolean {
		constructor(...args: ConstructorParameters<typeof real.PathBoolean>) {
			if (failures.left > 0) {
				failures.left--;
				throw new TypeError("Cannot destructure property 'top' of 'object null' as it is null.");
			}
			super(...args);
		}
	}
	return { ...real, PathBoolean: FlakyPathBoolean };
});

const { filledArea } = await import('../../src/vector/boolean.ts');
const { circlePath, polyline } = await import('../../src/vector/geom.ts');
const { merge } = await import('../../src/vector/ops.ts');

const sq = (x: number, y: number, s: number) => [
	polyline(
		[
			[x, y],
			[x + s, y],
			[x + s, y + s],
			[x, y + s],
		],
		true,
	),
];

describe('boolean retry', () => {
	it('retries in a rotated frame and returns the same geometry', () => {
		const a = sq(0, 0, 100);
		const b = [circlePath([100, 50], 30)];
		const direct = merge([a, b], 'add');
		failures.left = 1;
		const retried = merge([a, b], 'add');
		expect(failures.left).toBe(0);
		expect(Math.abs(filledArea(retried) - filledArea(direct))).toBeLessThan(1e-6);
		expect(retried.flatMap((sp) => sp.segs)).toHaveLength(direct.flatMap((sp) => sp.segs).length);
		// Vertices come back in the original frame (rotated there and back: round-off only).
		const corners = retried.flatMap((sp) => sp.segs.map((c) => c[0]));
		for (const p of [
			[0, 0],
			[100, 0],
			[0, 100],
		])
			expect(corners.some((q) => Math.hypot(q[0] - p[0]!, q[1] - p[1]!) < 1e-9)).toBe(true);
	});
	it('gives up with an empty result (never a throw) when the retry fails too', () => {
		failures.left = 2;
		expect(merge([sq(0, 0, 10), sq(5, 5, 10)], 'add')).toEqual([]);
		failures.left = 0;
	});
});
