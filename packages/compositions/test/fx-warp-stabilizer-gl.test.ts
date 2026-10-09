// @vitest-environment node
// gaps FX-6: the Warp Stabilizer shader in real WebGL2 (headless Chrome, SwiftShader): with a known camera path, No
// Motion holds every frame on the middle frame (the output is the input shifted by the path difference) for the
// homography methods and for Subspace Warp's mesh; without an analysis the picture passes through. FX_GL=0 skips.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPsdgPage, type PsdgPage, psdgGlEnabled } from './fx-psdg/gl-suite.ts';

const here = dirname(fileURLToPath(import.meta.url));
type Shift = { dx: number; dy: number; err: number; expected: [number, number]; corner: number[] };

describe.skipIf(!psdgGlEnabled)('Warp Stabilizer (GL)', () => {
	let page: PsdgPage;
	beforeAll(async () => {
		page = await openPsdgPage(join(here, 'fx-warp-stabilizer', 'entry.ts'));
	}, 300_000);
	afterAll(() => page?.close());

	for (const method of ['position', 'positionScaleRotation', 'perspective'])
		it(`No Motion locks the frame (${method})`, async () => {
			for (const frame of [1, 3, 4, 7]) {
				const s = await page.call<Shift>('shift', { method, frame });
				expect([s.dx, s.dy], `${method} frame ${frame}`).toEqual(s.expected);
				expect(s.err).toBe(0);
			}
		}, 120_000);

	it('Subspace Warp renders through its mesh', async () => {
		for (const frame of [1, 5]) {
			const s = await page.call<Shift>('shift', { method: 'subspaceWarp', frame, tracks: true });
			expect([s.dx, s.dy]).toEqual(s.expected);
			expect(s.err).toBeLessThan(200);
		}
	}, 120_000);

	it('Stabilize Only leaves the uncovered edge transparent; no analysis passes through', async () => {
		const s = await page.call<Shift>('shift', { method: 'position', frame: 1 });
		expect(s.expected[0]).toBeLessThan(0);
		expect(await page.call<number[]>('passThrough')).toEqual([10, 200, 30, 255]);
		const t = await page.call<Shift>('shift', { method: 'position', frame: 5 });
		expect(t.corner[3]).toBe(0);
	}, 120_000);
});
