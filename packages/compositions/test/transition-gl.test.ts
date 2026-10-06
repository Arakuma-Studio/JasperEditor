// @vitest-environment node
// GPU transitions on the fx GPU host in a real WebGL2 (wave-2 transition framework): headless Chrome (Playwright,
// SwiftShader when there is no GPU) runs the stage planning + host (test/transition-gl/entry.ts, bundled with
// esbuild). Compiles the whole transition GLSL library and EVERY registered GPU transition (wave-3 families get this
// check for free): two-sided, one-sided (in / out) and reversed; at progress 0 the stage shows A and at 1 B (the
// contract every transition keeps); placement of scaled / moved / half-transparent sides; a transition that reads
// both sides (S_DissolveLuma). Runs when a Chrome is found (JASPER_BROWSER_EXECUTABLE or the usual paths); FX_GL=0
// skips it.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSITION_FAMILIES } from '@jasper/project';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

type Px = [number, number, number, number];
const near = (a: Px, b: Px, tol = 4) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
/** Frame height of the entry's stage (transition-gl/entry.ts). */
const H_TEST = 36;

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'GPU transitions in WebGL2 (headless Chrome)',
	{ timeout: 60_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string, arg?: string): Promise<T> =>
			page.evaluate(
				([n, a]) => (window as unknown as { __tr: Record<string, (a?: string) => unknown> }).__tr[n]!(a),
				[name, arg] as const,
			) as Promise<T>;
		const endsOk = (r: Record<string, { first: Px; last: Px }>) =>
			Object.entries(r)
				.filter(([, v]) => !near(v.first, [255, 0, 0, 255], 6) || !near(v.last, [0, 0, 255, 255], 6))
				.map(([id, v]) => `${id}: ${v.first.join(',')} → ${v.last.join(',')}`);

		beforeAll(async () => {
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'transition-gl', 'entry.ts')],
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

		it('has WebGL2 and compiles the whole transition GLSL library', async () => {
			expect((await call<{ webgl2: boolean }>('info')).webgl2).toBe(true);
			expect(await call<{ ok: boolean; error?: string }>('library')).toEqual({ ok: true });
		});

		it('compiles and runs the test transitions and any GPU transition outside the families', async () => {
			const r = await call<{ count: number; errors: string[] }>('catalogue');
			expect(r.errors).toEqual([]);
			expect(r.count).toBeGreaterThanOrEqual(2);
			expect(endsOk(await call('ends'))).toEqual([]);
		});

		// One test per transition family (as fx-gl.test.ts does for effects): SwiftShader compiles slowly, so the whole
		// catalogue does not fit one timeout. Each runs every GPU transition of the family two-sided, one-sided (in /
		// out) and reversed, then checks the contract: A at progress 0, B at progress 1.
		for (const family of TRANSITION_FAMILIES.map((f) => f.file))
			it(`compiles and runs every GPU transition of ${family}; A at progress 0, B at 1`, {
				timeout: 240_000,
			}, async () => {
				const r = await call<{ count: number; errors: string[] }>('catalogue', family);
				expect(r.errors).toEqual([]);
				expect(r.count).toBeGreaterThan(0);
				expect(endsOk(await call('ends', family))).toEqual([]);
			});

		it('places the side pictures through their matrices and opacity', async () => {
			const r = await call<{ left: Px; right: Px; outside: Px; inside: Px }>('placement');
			expect(near(r.left, [255, 0, 0, 128], 3)).toBe(true); // scaled ×2, half opacity (premultiplied out)
			expect(near(r.right, [0, 0, 255, 128], 3)).toBe(true);
			expect(r.outside[3]).toBe(0); // left of the moved picture: transparent
			expect(near(r.inside, [255, 0, 0, 255])).toBe(true);
		});

		it('binds image params (Gradient Wipe / VR Gradient Wipe Custom Gradient; none or missing → built-in)', async () => {
			const r = await call<Record<string, [Px, Px]>>('gradientImage');
			const RED: Px = [255, 0, 0, 255];
			const BLUE: Px = [0, 0, 255, 255];
			// Left to Right: the left switches first. Custom (white | black): the dark right half first.
			expect(near(r.plain![0], BLUE) && near(r.plain![1], RED)).toBe(true);
			expect(near(r.custom![0], RED) && near(r.custom![1], BLUE)).toBe(true);
			expect(r.missing).toEqual(r.plain);
			expect(near(r.vrCustom![0], RED) && near(r.vrCustom![1], BLUE)).toBe(true);
		});

		it('Push: the border is never visible at progress 0 or 1 (it travels between the clips)', async () => {
			const r = await call<{ first: Px[]; last: Px[]; mid: Px[] }>('pushBorder');
			expect(r.first.every((p) => near(p, [255, 0, 0, 255]))).toBe(true);
			expect(r.last.every((p) => near(p, [0, 0, 255, 255]))).toBe(true);
			// Mid-way the white band sits between B (top) and A (bottom).
			expect(r.mid.some((p) => near(p, [255, 255, 255, 255], 10))).toBe(true);
			expect(near(r.mid[1]!, [0, 0, 255, 255]) && near(r.mid[H_TEST - 2]!, [255, 0, 0, 255])).toBe(true);
		});

		it("S_MochaWhip follows the incoming side's planar track (Track Mode Off: as without a track)", async () => {
			const r = await call<{ diff: number; diffOff: number; endCentre: Px; endCorner: Px }>('mochaTrack');
			expect(r.diff).toBeGreaterThan(20);
			expect(r.diffOff).toBe(0);
			// At progress 1 the cut-out has landed exactly: B everywhere.
			expect(near(r.endCentre, [0, 255, 0, 255])).toBe(true);
			expect(near(r.endCorner, [0, 0, 255, 255])).toBe(true);
		});

		it('Custom Completion replaces the timing; off keeps the linear ramp', async () => {
			const r = await call<{ zero: Px; full: Px; offLeft: Px; offRight: Px }>('completion');
			expect(near(r.zero, [255, 0, 0, 255])).toBe(true);
			expect(near(r.full, [0, 0, 255, 255])).toBe(true);
			// Off (completion ignored): p = 0.5 → B on the left half, A on the right.
			expect(near(r.offLeft, [0, 0, 255, 255]) && near(r.offRight, [255, 0, 0, 255])).toBe(true);
		});

		it('reads both sides in one shader (S_DissolveLuma)', async () => {
			const r = await call<{ white: Px; black: Px }>('luma');
			expect(near(r.white, [0, 255, 0, 255])).toBe(true);
			expect(near(r.black, [0, 0, 0, 255])).toBe(true);
		});
	},
);
