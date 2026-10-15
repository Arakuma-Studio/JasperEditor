// @vitest-environment node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, openGlPage } from './gl-browser.ts';
import type { RunArgs } from './transition-sapphire-dissolves-gl/entry.ts';

const here = dirname(fileURLToPath(import.meta.url));

type Px = [number, number, number, number];
type Out = { probes: Px[]; checksum: number; mean: Px };

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Sapphire dissolves in WebGL2 (headless Chrome)',
	{ timeout: 300_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const run = (a: RunArgs): Promise<Out> =>
			page.evaluate(
				(args) => (window as unknown as { __sd: { run(a: unknown): unknown } }).__sd.run(args) as Out,
				a,
			) as Promise<Out>;
		const call = <T>(name: string): Promise<T> =>
			page.evaluate(
				(n) => (window as unknown as { __sd: Record<string, () => unknown> }).__sd[n]!(),
				name,
			) as Promise<T>;

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'transition-sapphire-dissolves-gl', 'entry.ts')));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		const compare = (a: RunArgs, b: RunArgs): Promise<number> =>
			page.evaluate(
				([x, y]) =>
					(window as unknown as { __sd: { compare(a: unknown, b: unknown): number } }).__sd.compare(x, y),
				[a, b] as const,
			);
		/** Progress fixed by Start = End (%), whatever the frame. */
		const at = (pct: number, params: Record<string, unknown> = {}) => ({
			frame: 4,
			duration: 9,
			params: { startPercent: pct, endPercent: pct, ...params },
		});
		// Probes: A's dark red field, A's white disc (centre), B's yellow bar (bottom), a corner.
		const PROBES: [number, number][] = [
			[10, 10],
			[48, 27],
			[48, 44],
			[90, 50],
		];
		const bad = (got: Px[], want: Px[], tol = 3) =>
			got.some((g, i) => g.some((v, k) => Math.abs(v - want[i]![k]!) > tol));

		it('single-sided fades start or end at transparency', async () => {
			const ids = await call<string[]>('ids');
			const problems: string[] = [];
			for (const id of ids) {
				// A fade at the head of B starts transparent, one at the tail of A ends transparent.
				const head = await run({ id, ...at(0), sides: 'in', probes: PROBES });
				const tail = await run({ id, ...at(100), sides: 'out', probes: PROBES });
				if (head.probes.some((p) => p[3] > 3)) problems.push(`${id} head: ${JSON.stringify(head.probes)}`);
				if (tail.probes.some((p) => p[3] > 3)) problems.push(`${id} tail: ${JSON.stringify(tail.probes)}`);
			}
			expect(problems).toEqual([]);
		});

		it('S_Dissolve is a cross fade; S_DissolveFilm keeps the highlights longer', async () => {
			const d = await run({ id: 'S_Dissolve', ...at(50), probes: PROBES });
			expect(bad([d.probes[0]!], [[90, 30, 95, 255]], 2)).toBe(false);
			const f = await run({ id: 'S_DissolveFilm', ...at(50), probes: PROBES });
			// White over blue at gamma 2: sqrt((1 + b²) / 2) > (1 + b) / 2 per channel.
			expect(f.probes[1]![0]).toBeGreaterThan(d.probes[1]![0] + 20);
			expect(f.probes[1]![1]).toBeGreaterThan(d.probes[1]![1] + 20);
		});

		it('S_DissolveLuma switches the pixels in the order of the chosen luma pattern', async () => {
			const halves = {
				a: 'halves',
				b: 'rgb(0, 255, 0)',
				probes: [
					[20, 27],
					[76, 27],
				] as [number, number][],
			};
			const fg = await run({ id: 'S_DissolveLuma', ...at(50, { useLumaOf: 'foreground' }), ...halves });
			expect(
				bad(fg.probes, [
					[255, 255, 255, 255],
					[0, 255, 0, 255],
				]),
			).toBe(false);
			const inv = await run({
				id: 'S_DissolveLuma',
				...at(50, { useLumaOf: 'foreground', invertPattern: true }),
				...halves,
			});
			expect(
				bad(inv.probes, [
					[0, 255, 0, 255],
					[0, 0, 0, 255],
				]),
			).toBe(false);
		});

		it('S_DissolveSpeckle and S_DissolveStatic show A and B in patches mid-way', async () => {
			const probes = Array.from({ length: 40 }, (_, i) => [(i * 37) % 96, (i * 23) % 54] as [number, number]);
			for (const id of ['S_DissolveSpeckle', 'S_DissolveStatic']) {
				const r = await run({ id, ...at(50), a: 'rgb(255, 0, 0)', b: 'rgb(0, 0, 255)', probes });
				const red = r.probes.filter((p) => p[0] > 200 && p[2] < 55).length;
				const blue = r.probes.filter((p) => p[2] > 200 && p[0] < 55).length;
				expect(red, id).toBeGreaterThan(5);
				expect(blue, id).toBeGreaterThan(5);
			}
		});

		it('the light dissolves add light mid-way (brighter than the plain dissolve)', async () => {
			const plain = await run({ id: 'S_Dissolve', ...at(50) });
			const lum = (o: Out) => o.mean[0] + o.mean[1] + o.mean[2];
			const dim: string[] = [];
			for (const id of [
				'S_DissolveGlow',
				'S_DissolveUltraGlow',
				'S_DissolveGlint',
				'S_DissolveGlintRainbow',
				'S_DissolveGlare',
				'S_DissolveFlashbulbs',
				'S_DissolveLensFlare',
				'S_DissolveLightLeak',
				'S_DissolveZap',
				'S_DissolveRays',
				'S_DissolveEdgeRays',
			]) {
				const r = await run({ id, ...at(50) });
				if (lum(r) < lum(plain) + 6) dim.push(`${id}: ${lum(r).toFixed(1)} vs ${lum(plain).toFixed(1)}`);
			}
			expect(dim).toEqual([]);
		});

		it('Mix with Dissolve 1 gives the plain dissolve', async () => {
			for (const id of ['S_DissolveGlow', 'S_DissolveVortex', 'S_DissolveTiles']) {
				const d = await compare(
					{ id, ...at(50, { mixWithDissolve: 1, dissolveSpeed: 1, slowIn: 0, slowOut: 0 }) },
					{ id: 'S_Dissolve', ...at(50, { slowIn: 0, slowOut: 0 }) },
				);
				expect(d, id).toBeLessThan(0.6);
			}
		});

		it('random dissolves are deterministic and follow the seed', async () => {
			for (const id of ['S_DissolveStatic', 'S_DissolveFlashbulbs', 'S_DissolveZap', 'S_DissolveDiffuse']) {
				const one = await run({ id, ...at(50) });
				const two = await run({ id, ...at(50) });
				const other = await run({ id, ...at(50, { seed: 7 }) });
				expect(two.checksum, id).toBe(one.checksum);
				expect(other.checksum, id).not.toBe(one.checksum);
			}
		});
	},
);
