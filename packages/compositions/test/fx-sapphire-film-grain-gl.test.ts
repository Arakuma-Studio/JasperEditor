// @vitest-environment node

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FilmRunOptions } from './fx-sapphire-film-grain/entry.ts';
import { CHROME, openGlPage } from './gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));

type Px = number[];
type Result = { probes: Px[]; all?: number[]; png?: string };

const FAMILY = [
	'jasper.s.film-effect',
	'jasper.s.film-damage',
	'jasper.s.film-burn',
	'jasper.s.vhs-damage',
	'jasper.s.vignette',
	'jasper.s.bleach-bypass',
	'jasper.s.grain',
	'jasper.s.grain-static',
	'jasper.s.ultra-grain',
	'jasper.s.diffuse',
	'jasper.s.vintage-color-2strip',
	'jasper.s.vintage-color-3strip',
	'jasper.s.digital-damage',
	'jasper.s.jpeg-damage',
	'jasper.s.tv-damage',
	'jasper.s.grunge',
	'jasper.s.scan-lines',
	'jasper.s.scan-lines-mono',
];

/** Digital damage blinks: force every kind on so a test frame always shows some damage. */
const DIGITAL_ON = {
	freezeAlways: 1,
	shiftAlways: 1,
	brightsAlways: 1,
	pixelateAlways: 1,
	blocksAlways: 1,
	invertAlways: 1,
	flowAlways: 1,
};

const ANIMATED: [string, Record<string, unknown>][] = [
	['jasper.s.film-effect', {}],
	['jasper.s.film-damage', {}],
	['jasper.s.film-burn', {}],
	['jasper.s.vhs-damage', {}],
	['jasper.s.grain', {}],
	['jasper.s.grain-static', {}],
	['jasper.s.ultra-grain', {}],
	['jasper.s.diffuse', {}],
	['jasper.s.digital-damage', DIGITAL_ON],
	['jasper.s.tv-damage', {}],
];

const SEEDED: [string, Record<string, unknown>][] = [
	['jasper.s.film-effect', {}],
	['jasper.s.film-damage', {}],
	['jasper.s.film-burn', {}],
	['jasper.s.vhs-damage', {}],
	['jasper.s.grain', {}],
	['jasper.s.ultra-grain', {}],
	['jasper.s.digital-damage', DIGITAL_ON],
	['jasper.s.jpeg-damage', { errorRate: 20 }],
	['jasper.s.tv-damage', {}],
	['jasper.s.grunge', {}],
	['jasper.s.bleach-bypass', { grainAmp: 1 }],
];

const meanAbsDiff = (a: number[], b: number[]) => {
	let d = 0;
	for (let i = 0; i < a.length; i++) if (i % 4 !== 3) d += Math.abs(a[i]! - b[i]!);
	return d / ((a.length * 3) / 4);
};
const mean = (a: number[], ch: number) => {
	let s = 0;
	let n = 0;
	for (let i = ch; i < a.length; i += 4, n++) s += a[i]!;
	return s / n;
};

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Sapphire film / grain / damage effects in WebGL2',
	{ timeout: 120_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const render = (o: FilmRunOptions) =>
			page.evaluate(
				(opts) => (window as unknown as { __film: { render(o: unknown): Result } }).__film.render(opts),
				o,
			) as Promise<Result>;

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'fx-sapphire-film-grain', 'entry.ts')));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		it.each(FAMILY)('%s Mix with Orig = 1 returns the input', async (id) => {
			const r = await render({
				id,
				width: 32,
				height: 24,
				paint: 'gradient',
				params: { mixWithOriginal: 1 },
				probes: [[16, 12]],
			});
			const expected = Math.round((16.5 / 32) * 255);
			for (const channel of r.probes[0]!.slice(0, 3))
				expect(Math.abs(channel - expected), id).toBeLessThanOrEqual(6);
			expect(r.probes[0]![3], id).toBe(255);
		});

		it.each(SEEDED)('%s is deterministic and follows Seed', async (id, params) => {
			const opts = { id, width: 64, height: 48, paint: 'grey' as const, frame: 3, all: true, params };
			const a = await render(opts);
			const b = await render(opts);
			const c = await render({ ...opts, params: { ...params, seed: 77 } });
			expect(a.all, id).toEqual(b.all);
			expect(meanAbsDiff(a.all!, c.all!), id).toBeGreaterThan(0.2);
		});

		it.each(ANIMATED)('%s changes from frame to frame', async (id, params) => {
			const opts = { id, width: 64, height: 48, paint: 'gradient' as const, all: true, params };
			const f0 = await render({ ...opts, frame: 0 });
			const f1 = await render({ ...opts, frame: 1 });
			expect(meanAbsDiff(f0.all!, f1.all!), id).toBeGreaterThan(0.2);
		});

		it('fully transparent input stays transparent (filters; S_Grunge renders over its background)', async () => {
			const filters = FAMILY.filter((id) => id !== 'jasper.s.grunge');
			for (const id of filters) {
				const r = await render({ id, width: 32, height: 24, paint: 'half', probes: [[28, 12]] });
				expect(r.probes[0]![3], id).toBeLessThanOrEqual(2);
			}
		});

		it('S_Vignette darkens the corners, keeps the centre', async () => {
			const r = await render({
				id: 'jasper.s.vignette',
				width: 160,
				height: 90,
				paint: 'white',
				probes: [
					[80, 45],
					[2, 2],
				],
			});
			expect(r.probes[0]![0]).toBeGreaterThan(240);
			expect(r.probes[1]![0]).toBeLessThan(150);
		});

		it('S_Grain adds zero-mean noise of the stock amplitude', async () => {
			const r = await render({ id: 'jasper.s.grain', width: 96, height: 64, paint: 'grey', all: true });
			const m = mean(r.all!, 1);
			expect(Math.abs(m - 128)).toBeLessThan(6);
			let v = 0;
			for (let i = 1; i < r.all!.length; i += 4) v += (r.all![i]! - m) ** 2;
			const sd = Math.sqrt(v / (r.all!.length / 4));
			expect(sd).toBeGreaterThan(2);
			expect(sd).toBeLessThan(40);
		});

		it('S_BleachBypass desaturates', async () => {
			const r = await render({
				id: 'jasper.s.bleach-bypass',
				width: 16,
				height: 16,
				paint: 'orange',
				probes: [[8, 8]],
			});
			const [R, G, B, A] = r.probes[0]!;
			expect(A).toBe(255);
			expect(Math.max(R!, G!, B!) - Math.min(R!, G!, B!)).toBeLessThan(220 - 40);
		});

		it('S_VintageColor2Strip has no true blue', async () => {
			const r = await render({
				id: 'jasper.s.vintage-color-2strip',
				width: 16,
				height: 16,
				paint: 'blue',
				probes: [[8, 8]],
			});
			const [R, G, B] = r.probes[0]!;
			// a saturated blue comes out teal (cyan dye + little red dye): blue never dominates
			expect(B!).toBeLessThanOrEqual(Math.max(R!, G!));
			expect(B!).toBeLessThan(200);
		});

		it('S_VintageColor3Strip keeps saturated colours, Show: Pure Colors shows the separations', async () => {
			const r = await render({
				id: 'jasper.s.vintage-color-3strip',
				width: 16,
				height: 16,
				paint: 'orange',
				probes: [[8, 8]],
			});
			const [R, , B] = r.probes[0]!;
			expect(R! - B!).toBeGreaterThan(120);
			const s = await render({
				id: 'jasper.s.vintage-color-3strip',
				width: 16,
				height: 16,
				paint: 'blue',
				params: { show: 'pureColors' },
				probes: [[8, 8]],
			});
			expect(s.probes[0]![2]).toBeGreaterThan(s.probes[0]![0]!);
		});

		it('S_JpegDamage quantises in 8×8 blocks (a smooth gradient becomes stepped)', async () => {
			const r = await render({
				id: 'jasper.s.jpeg-damage',
				width: 64,
				height: 16,
				paint: 'gradient',
				params: { quality: 0.03 },
				all: true,
			});
			const row = (x: number) => r.all![(4 * 64 + x) * 4]!;
			let inside = 0;
			let border = 0;
			for (let b = 1; b < 7; b++) {
				border += Math.abs(row(b * 8) - row(b * 8 - 1));
				inside += Math.abs(row(b * 8 + 4) - row(b * 8 + 3));
			}
			expect(border).toBeGreaterThan(inside);
			// quality 1 is (nearly) lossless
			const q = await render({
				id: 'jasper.s.jpeg-damage',
				width: 64,
				height: 16,
				paint: 'gradient',
				params: { quality: 1 },
				all: true,
			});
			const g = await render({
				id: 'jasper.s.jpeg-damage',
				width: 64,
				height: 16,
				paint: 'gradient',
				params: { mixWithOriginal: 1 },
				all: true,
			});
			expect(meanAbsDiff(q.all!, g.all!)).toBeLessThan(4);
		});

		it('S_ScanLines draws periodic dark lines; Lines Sharpness 0 removes them', async () => {
			const r = await render({ id: 'jasper.s.scan-lines', width: 32, height: 64, paint: 'grey', all: true });
			const col = Array.from({ length: 64 }, (_, y) => r.all![(y * 32 + 16) * 4]!);
			expect(Math.min(...col)).toBeLessThan(Math.max(...col) - 40);
			const flat = await render({
				id: 'jasper.s.scan-lines',
				width: 32,
				height: 64,
				paint: 'grey',
				params: { linesSharpness: 0 },
				probes: [[16, 10]],
			});
			expect(Math.abs(flat.probes[0]![0]! - 128)).toBeLessThanOrEqual(3);
		});

		it('S_FilmBurn: the flashes light the picture; with every element off it is the input', async () => {
			const off = {
				flash1: false,
				flash2: false,
				flash3: false,
				scratches: false,
				hairsAndStains: false,
				dust: false,
				grain: false,
			};
			const lo = await render({
				id: 'jasper.s.film-burn',
				width: 96,
				height: 54,
				paint: 'grey',
				params: off,
				all: true,
			});
			const hi = await render({ id: 'jasper.s.film-burn', width: 96, height: 54, paint: 'grey', all: true });
			expect(Math.abs(mean(lo.all!, 1) - 128)).toBeLessThan(2);
			expect(mean(hi.all!, 0)).toBeGreaterThan(mean(lo.all!, 0) + 10);
		});

		it('S_TVDamage Turn Off = 1 ends on black', async () => {
			const r = await render({
				id: 'jasper.s.tv-damage',
				width: 64,
				height: 36,
				paint: 'white',
				params: { turnOff: 1 },
				probes: [
					[32, 18],
					[5, 5],
				],
			});
			expect(r.probes[0]![0]).toBeLessThan(20);
			expect(r.probes[1]![0]).toBeLessThan(20);
		});

		it('S_Grunge draws stamps (Grunge Only shows them alone)', async () => {
			const r = await render({ id: 'jasper.s.grunge', width: 96, height: 54, paint: 'white', all: true });
			expect(mean(r.all!, 0)).toBeLessThan(250);
			const only = await render({
				id: 'jasper.s.grunge',
				width: 96,
				height: 54,
				paint: 'white',
				params: { combine: 'grungeOnly' },
				all: true,
			});
			expect(mean(only.all!, 3)).toBeLessThan(250);
		});
	},
);
