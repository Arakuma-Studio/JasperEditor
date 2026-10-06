// @vitest-environment node
// Sapphire-style dissolves (registry/transitions/sapphire-dissolves.ts) in a real WebGL2 (headless Chrome,
// SwiftShader when there is no GPU): the stages run through the GPU host (src/fx/host.ts) over procedural sides
// (A: dark red with a white disc, B: blue with a yellow bar — see transition-sapphire-dissolves-gl/entry.ts) and the
// pixels are checked: the progress contract with default params two-sided and one-sided, one characteristic pixel
// per dissolve mid-way, Reverse, determinism and seeds. SD_GL_TIMINGS=1 prints compile / frame times. FX_GL=0 skips.
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunArgs } from './transition-sapphire-dissolves-gl/entry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

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
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'transition-sapphire-dissolves-gl', 'entry.ts')],
				bundle: true,
				write: false,
				format: 'iife',
				platform: 'browser',
				target: 'es2022',
				define: { 'process.env.NODE_ENV': '"production"' },
				logLevel: 'silent',
			});
			browser = await chromium.launch({
				executablePath: CHROME,
				args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
			});
			page = await browser.newPage();
			const errors: string[] = [];
			page.on('pageerror', (e) => errors.push(e.message));
			await page.setContent('<!doctype html><html><body></body></html>');
			await page.addScriptTag({ content: out.outputFiles[0]!.text });
			if (errors.length) throw new Error(errors.join('\n'));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		it.runIf(process.env.SD_GL_TIMINGS === '1')('times every dissolve', { timeout: 1_800_000 }, async () => {
			const only = (process.env.SD_GL_IDS ?? '').split(',').filter(Boolean);
			const ids = (await call<string[]>('ids')).filter(
				(id) => only.length === 0 || only.some((o) => id.endsWith(o)),
			);
			const t: Record<string, [number, number]> = {};
			for (const id of ids) {
				const t0 = Date.now();
				await run({ id, frame: 5, duration: 11 });
				const t1 = Date.now();
				await run({ id, frame: 6, duration: 11 });
				t[id] = [t1 - t0, Date.now() - t1];
				if (process.env.SD_GL_TIMINGS_OUT)
					writeFileSync(process.env.SD_GL_TIMINGS_OUT, JSON.stringify(t, null, 1));
			}
			expect(ids.length).toBeGreaterThan(0);
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
		const A: Px[] = [
			[160, 20, 20, 255],
			[255, 255, 255, 255],
			[160, 20, 20, 255],
			[160, 20, 20, 255],
		];
		const B: Px[] = [
			[20, 40, 170, 255],
			[20, 40, 170, 255],
			[240, 220, 40, 255],
			[20, 40, 170, 255],
		];
		const bad = (got: Px[], want: Px[], tol = 3) =>
			got.some((g, i) => g.some((v, k) => Math.abs(v - want[i]![k]!) > tol));

		it('keeps the progress contract with default params: A at 0, B at 1, two-sided and one-sided', async () => {
			const ids = await call<string[]>('ids');
			expect(ids).toHaveLength(30);
			const problems: string[] = [];
			for (const id of ids) {
				const a = await run({ id, ...at(0), probes: PROBES });
				const b = await run({ id, ...at(100), probes: PROBES });
				if (bad(a.probes, A)) problems.push(`${id} @0: ${JSON.stringify(a.probes)}`);
				if (bad(b.probes, B)) problems.push(`${id} @1: ${JSON.stringify(b.probes)}`);
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
			// Foreground: the dark areas of A go first.
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

		it('the warping, blurring and glitch dissolves differ from the plain dissolve mid-way', async () => {
			const same: string[] = [];
			for (const [id, params, a, b] of [
				['S_DissolveBlur', {}],
				['S_DissolveDefocus', {}],
				['S_DissolveBubble', {}],
				['S_DissolveVortex', {}],
				['S_DissolveWaves', {}],
				['S_DissolvePuddle', {}],
				['S_DissolveDistort', {}, 'stripes', 'stripes2'],
				['S_DissolveDiffuse', {}],
				['S_DissolveShake', {}],
				['S_DissolveTiles', {}],
				['S_DissolveAutoPaint', {}],
				['S_DissolvePixelSort', {}],
				['S_DissolveDigitalDamage', { timeIntensity: 10, intensity: 3 }],
				['S_DissolvePixelMosh', {}, 'stripes', 'stripes2'],
			] as [string, Record<string, unknown>, string?, string?][]) {
				const sides = { a: a ?? 'a', b: b ?? 'b' };
				const d = await compare(
					{ id, ...at(50, params), ...sides },
					{ id: 'S_Dissolve', ...at(50), ...sides },
				);
				if (!(d > 1)) same.push(`${id}: ${d.toFixed(2)}`);
			}
			expect(same).toEqual([]);
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

		it('Reverse plays the dissolve backwards (the flare sweeps the other way)', async () => {
			const fwd = { id: 'S_DissolveLensFlare', frame: 2, duration: 9 };
			const d = await compare(fwd, { ...fwd, params: { reverse: true } });
			expect(d).toBeGreaterThan(1);
		});
	},
);
