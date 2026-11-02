// Spec 19 TL-089: Intensity shows the clip's own picture through the look: 0 % is the plain input, 100 % the whole look.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, type LookPage, openLookPage, pixel } from './title-look-harness.ts';

describe.runIf(!!CHROME)('look intensity', { timeout: 120_000 }, () => {
	let tl: LookPage;
	beforeAll(async () => {
		tl = await openLookPage(dirname(fileURLToPath(import.meta.url)));
	}, 120_000);
	afterAll(() => tl?.browser.close());

	const req = (intensity?: number) => ({
		recipe: {
			layers: [
				{ type: 'rim', params: { width: 10, paint: { kind: 'color', color: [0, 0, 1, 1] } } },
				{ type: 'face', params: { paint: { kind: 'color', color: [1, 0, 0, 1] } } },
			],
		},
		input: { kind: 'rect' as const, x: 0.25, y: 0.25, w: 0.5, h: 0.5, color: '#00ff00' },
		box: { width: 320, height: 160 },
		unitPx: 100,
		...(intensity === undefined ? {} : { intensity }),
	});

	it('100 % is the look exactly, and an unset Intensity reads 100 %', async () => {
		const a = await tl.render(req());
		const b = await tl.render(req(100));
		expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
		expect(pixel(a, a.box.x + 160, a.box.y + 80).slice(0, 3)).toEqual([255, 0, 0]);
	});

	it('0 % is the plain input: no fill, no rim', async () => {
		const a = await tl.render(req(0));
		expect(pixel(a, a.box.x + 160, a.box.y + 80).slice(0, 3)).toEqual([0, 255, 0]);
		// Where the rim would be, the input is empty.
		expect(pixel(a, a.box.x + 75, a.box.y + 80)[3]).toBe(0);
	});

	it('in between mixes the two, and fades the rim with it', async () => {
		const full = await tl.render(req(100));
		const half = await tl.render(req(50));
		const rimX = full.box.x + 75;
		const rimY = full.box.y + 80;
		expect(pixel(full, rimX, rimY)[3]).toBeGreaterThan(240);
		const a = pixel(half, rimX, rimY)[3]!;
		expect(a).toBeGreaterThan(110);
		expect(a).toBeLessThan(145);
		const c = pixel(half, half.box.x + 160, half.box.y + 80);
		expect(c[0]).toBeGreaterThan(100);
		expect(c[1]).toBeGreaterThan(100);
	});
});
