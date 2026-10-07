// @vitest-environment node
// three-d: the Advanced 3D GL renderer (WebGL2 in headless Chrome, SwiftShader). Unlit scenes must match the Classic 3D
// CPU reference (same projection, depth order and sampling; multisampled edges may differ); lit scenes check what
// Advanced 3D adds: shadow maps (the caster's shadow on the floor), extruded text (walls widen the silhouette, the
// hole stays open), environment reflection and background, and the GGX highlight.
// Runs when a Chrome is found (JASPER_BROWSER_EXECUTABLE or the usual paths); FX_GL=0 skips it.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe.runIf(!!CHROME && process.env.FX_GL !== '0')('Advanced 3D on the GPU', { timeout: 180_000 }, () => {
	let browser: Browser;
	let page: Page;
	let W = 0;
	let H = 0;
	const call = <T>(name: string, arg?: unknown): Promise<T> =>
		page.evaluate(
			([n, a]) => (window as unknown as { __adv: Record<string, (a?: unknown) => unknown> }).__adv[n]!(a),
			[name, arg] as const,
		) as Promise<T>;
	const px = (img: number[], x: number, y: number) => img.slice((y * W + x) * 4, (y * W + x) * 4 + 4);

	beforeAll(async () => {
		const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
		const esbuild = req('esbuild') as {
			build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
		};
		const out = await esbuild.build({
			entryPoints: [join(here, 'three-d-advanced', 'entry.ts')],
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
		page = await browser.newPage({ viewport: { width: 64, height: 64 } });
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.setContent('<!doctype html><html><body></body></html>');
		await page.addScriptTag({ content: out.outputFiles[0]!.text });
		if (errors.length) throw new Error(errors.join('\n'));
		({ W, H } = await call<{ W: number; H: number }>('size'));
		if (process.env.THREE_D_DEBUG)
			for (const n of [
				'flat',
				'stack',
				'shadowOn',
				'shadowOff',
				'ringFlat',
				'ringExtruded',
				'env',
				'highlight',
				'model',
				'dof',
			]) {
				const url = await call<string>('png', n);
				const { writeFileSync } = await import('node:fs');
				writeFileSync(`/tmp/adv-${n}.png`, Buffer.from(url.split(',')[1]!, 'base64'));
			}
	}, 120_000);

	afterAll(async () => {
		await browser?.close();
	});

	it.each([
		['flat', 0.03],
		['stack', 0.06],
		['orbit', 0.06],
		['ortho', 0.04],
	] as const)('unlit %s = Classic 3D (CPU reference)', async (name, allowed) => {
		const a = await call<number[]>('advanced', name);
		const c = await call<number[]>('classic', name);
		let bad = 0;
		let drawn = 0;
		for (let i = 0; i < W * H; i++) {
			const ca = c[i * 4 + 3]!;
			const aa = a[i * 4 + 3]!;
			if (ca > 0) drawn++;
			let e = Math.abs(ca - aa);
			for (let k = 0; k < 3; k++)
				e = Math.max(e, Math.abs((c[i * 4 + k]! * ca) / 255 - (a[i * 4 + k]! * aa) / 255));
			if (e > 6) bad++;
		}
		expect(drawn).toBeGreaterThan(100);
		expect(bad / (W * H)).toBeLessThanOrEqual(allowed);
	});

	it('shadow maps: the caster darkens the floor where Classic 3D puts its shadow', async () => {
		const on = await call<number[]>('advanced', 'shadowOn');
		const off = await call<number[]>('advanced', 'shadowOff');
		let shadowed = 0;
		let lighter = 0;
		for (let i = 0; i < W * H; i++) {
			const d = off[i * 4]! - on[i * 4]!;
			if (d > 20) shadowed++;
			if (d < -3) lighter++;
		}
		expect(shadowed).toBeGreaterThan(40);
		expect(lighter).toBe(0);
	});

	it('extruded text: walls widen the silhouette, the hole stays open, walls take the fill colour', async () => {
		const flat = await call<number[]>('advanced', 'ringFlat');
		const ext = await call<number[]>('advanced', 'ringExtruded');
		const cover = (img: number[]) => {
			let n = 0;
			for (let i = 0; i < W * H; i++) if (img[i * 4 + 3]! > 128) n++;
			return n;
		};
		expect(cover(ext)).toBeGreaterThan(cover(flat) * 1.15);
		// Seen at an angle, the ring's hole shows its inner wall: darker than the lit front face.
		let face = 0;
		for (let i = 0; i < W * H; i++) face = Math.max(face, ext[i * 4]!);
		expect(px(ext, W / 2, H / 2)[0]).toBeLessThan(face - 60);
		// Lit wall pixels are grey-white (the fill colour), not black.
		let lit = 0;
		for (let i = 0; i < W * H; i++)
			if (ext[i * 4 + 3]! > 200 && flat[i * 4 + 3]! < 10 && ext[i * 4]! > 40) lit++;
		expect(lit).toBeGreaterThan(10);
	});

	it('environment light: the background is the environment ahead, the mirror reflects the one behind', async () => {
		const img = await call<number[]>('advanced', 'env');
		const bg = px(img, 2, 2);
		expect(bg[0]).toBeGreaterThan(200);
		expect(bg[1]).toBeLessThan(40);
		const mirror = px(img, W / 2, H / 2);
		expect(mirror[1]).toBeGreaterThan(150);
		expect(mirror[0]).toBeLessThan(80);
	});

	it('depth of field: the layer in focus stays sharp, the far one is blurred', async () => {
		const img = await call<number[]>('advanced', 'dof');
		// Local contrast (mean |Δ| between horizontal neighbours) in a window of each layer.
		const contrast = (x0: number, x1: number) => {
			let s = 0;
			let n = 0;
			for (let y = 26; y < 38; y++)
				for (let x = x0; x < x1; x++) {
					s += Math.abs(px(img, x + 1, y)[0]! - px(img, x, y)[0]!);
					n++;
				}
			return s / n;
		};
		const sharp = contrast(15, 35);
		const blurred = contrast(62, 80);
		expect(sharp).toBeGreaterThan(60);
		expect(blurred).toBeLessThan(sharp / 3);
	});

	it('3D model layer: a lit cube shows three differently shaded faces in its base colour', async () => {
		const img = await call<number[]>('advanced', 'model');
		const shades = new Set<number>();
		let red = 0;
		for (let i = 0; i < W * H; i++) {
			if (img[i * 4 + 3]! < 250) continue;
			const [r, g, b] = [img[i * 4]!, img[i * 4 + 1]!, img[i * 4 + 2]!];
			if (r > g * 3 && r > b * 3 && r > 30) {
				red++;
				shades.add(Math.round(r / 12));
			}
		}
		expect(red).toBeGreaterThan(400);
		expect(shades.size).toBeGreaterThanOrEqual(3);
	});

	it('GGX: a shiny surface shows a highlight under a point light', async () => {
		const img = await call<number[]>('advanced', 'highlight');
		const centre = px(img, W / 2, H / 2);
		const edge = px(img, 4, H / 2);
		expect(centre[0]! + centre[1]! + centre[2]!).toBeGreaterThan(edge[0]! + edge[1]! + edge[2]! + 120);
	});
});
