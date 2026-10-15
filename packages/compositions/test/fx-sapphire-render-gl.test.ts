// @vitest-environment node

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunOpts } from './fx-sapphire-render-gl/entry.ts';
import { CHROME, openGlPage } from './gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));

type Px = [number, number, number, number];
const W = 160;
const H = 90;

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Sapphire Render effects in WebGL2 (headless Chrome)',
	{ timeout: Number(process.env.FX_TIMEOUT ?? 120_000) },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string, arg?: unknown): Promise<T> =>
			page.evaluate(
				([n, a]) =>
					(window as unknown as { __srt: Record<string, (x: unknown) => unknown> }).__srt[n as string]!(a),
				[name, arg] as const,
			) as Promise<T>;
		const solid = { kind: 'solid', color: '#204060' } as const;
		const pixels = (o: RunOpts, at: [number, number][]) => call<{ px: Px[] }>('pixels', { ...o, at });
		const stats = (o: RunOpts) => call<{ hash: number; alpha: number; canvas: number[] }>('stats', o);

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'fx-sapphire-render-gl', 'entry.ts')));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		it('S_Zap: a bright bolt over the source, deterministic, animated by Wiggle and re-drawn by Seed', async () => {
			const base: RunOpts = { id: 'jasper.s.zap', width: W, height: H, paint: solid };
			const a = await stats(base);
			const b = await stats(base);
			expect(a.hash).toBe(b.hash);
			const c = await stats({ ...base, frame: 9 });
			expect(c.hash).not.toBe(a.hash);
			const d = await stats({ ...base, params: { seed: 7 } });
			expect(d.hash).not.toBe(a.hash);
			// The bolt passes through Control Point 3 (0.7, 0.5) region: somewhere on that row it is near white.
			const row: [number, number][] = Array.from({ length: 160 }, (_, i) => [260 + i, 135]);
			const px = (await pixels({ ...base, width: 480, height: 270 }, row)).px;
			expect(Math.max(...px.map((p) => p[0] + p[1] + p[2]))).toBeGreaterThan(600);
			// Zap Only: black where there is no lightning (corner far from the path)
			const only = await pixels({ ...base, params: { combine: 'only' } }, [[2, H - 2]]);
			expect(only.px[0]![0]).toBeLessThan(40);
		});

		it('S_Zap: Jitter Frames re-draws the bolt each period, constant inside a period without wiggle', async () => {
			const base: RunOpts = {
				id: 'jasper.s.zap',
				width: W,
				height: H,
				paint: solid,
				params: { wiggleSpeed: 0, jitterFrames: 4 },
			};
			const f0 = await stats({ ...base, frame: 0 });
			const f3 = await stats({ ...base, frame: 3 });
			const f4 = await stats({ ...base, frame: 4 });
			expect(f3.hash).toBe(f0.hash);
			expect(f4.hash).not.toBe(f0.hash);
		});

		it('characteristic pixels: gradients, grid, shape, laser beam', async () => {
			const g = await pixels({ id: 'jasper.s.gradient', width: W, height: H, paint: solid }, [
				[W / 2, 1],
				[W / 2, H - 2],
			]);
			expect(g.px[0]![0]).toBeGreaterThan(235); // Start Color white at the top (Grad Only)
			expect(g.px[1]![0]).toBeLessThan(20);
			const r = await pixels({ id: 'jasper.s.gradient-radial', width: W, height: H, paint: solid }, [
				[W / 2, H / 2],
				[1, 1],
			]);
			expect(r.px[0]![1]).toBeGreaterThan(245);
			expect(r.px[1]![1]).toBeLessThan(r.px[0]![1] - 120);
			const m = await pixels({ id: 'jasper.s.gradient-multi', width: W, height: H, paint: solid }, [
				[2, H - 2],
			]);
			expect(m.px[0]![0]).toBeGreaterThan(m.px[0]![1] + 100);
			const s = await pixels({ id: 'jasper.s.shape', width: W, height: H, paint: solid }, [
				[W / 2, H / 2],
				[2, 2],
			]);
			expect(s.px[0]!.slice(0, 3)).toEqual([255, 255, 255]);
			expect(s.px[1]!.slice(0, 3)).toEqual([0x20, 0x40, 0x60]);
			const grid = await pixels({ id: 'jasper.s.grid', width: 480, height: 270, paint: solid }, [
				[240, 140],
				[250, 140],
			]);
			expect(grid.px[0]![0]).toBeGreaterThan(grid.px[1]![0] + 40); // the centre vertical line
			// laser: a point a quarter of the way from Start to Stop lies on the beam (Position 0.5, Length 0.5)
			const sx = 0.278 * 480 + (0.556 - 0.278) * 480 * 0.3;
			const sy = 0.755 * 270 + (0.207 - 0.755) * 270 * 0.3;
			const l = await pixels({ id: 'jasper.s.laser-beam', width: 480, height: 270, paint: solid }, [
				[sx, sy],
			]);
			expect(l.px[0]![0]).toBeGreaterThan(200);
		});

		it('alpha: generators keep a transparent input transparent (Copy From Input); light adds alpha (Affect Alpha)', async () => {
			const none = { kind: 'none' } as const;
			const g = await pixels({ id: 'jasper.s.gradient', width: W, height: H, paint: none }, [[W / 2, 2]]);
			expect(g.px[0]![3]).toBe(0);
			const ga = await pixels(
				{ id: 'jasper.s.gradient', width: W, height: H, paint: none, params: { outputOpacity: 'allOpaque' } },
				[[W / 2, 2]],
			);
			expect(ga.px[0]![3]).toBe(255);
			const z = await stats({ id: 'jasper.s.zap', width: 480, height: 270, paint: none });
			expect(z.alpha).toBeGreaterThan(0.5);
			const z0 = await stats({
				id: 'jasper.s.zap',
				width: 480,
				height: 270,
				paint: none,
				params: { affectAlpha: 0 },
			});
			expect(z0.alpha).toBe(0);
			const far = await pixels({ id: 'jasper.s.zap', width: 480, height: 270, paint: none }, [[5, 265]]);
			expect(far.px[0]![3]).toBeLessThan(8);
		});

		it('every random generator is deterministic and re-seeded by Seed', async () => {
			for (const id of [
				'jasper.s.ultra-zap',
				'jasper.s.dust',
				'jasper.s.sparkles',
				'jasper.s.night-sky',
				'jasper.s.caustics',
			]) {
				const o: RunOpts = { id, width: W, height: H, paint: solid, frame: 5 };
				const a = await stats(o);
				expect((await stats(o)).hash, id).toBe(a.hash);
				expect((await stats({ ...o, params: { seed: 11 } })).hash, id).not.toBe(a.hash);
			}
		});
	},
);
