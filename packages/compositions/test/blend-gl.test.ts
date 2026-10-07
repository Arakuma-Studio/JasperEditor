// @vitest-environment node
// Clip blend modes in a real WebGL2 and in Chrome's CSS compositor (keyframes-blend), against `blendPixel` — the
// formulas the native export kernel runs:
// - the GL compositor (planComposite + runShaderPlan in headless Chrome, SwiftShader without a GPU) for EVERY mode,
//   opaque and translucent, layer opacity, Dissolve's deterministic noise (`dissolveNoise`), placement, mattes;
// - the CSS modes (`blendModeCss`) drawn by Chrome's compositor with `mix-blend-mode`: equal to the formulas (this is
//   why the preview draws them with CSS and the other modes through the compositor).
// Runs when a Chrome is found (JASPER_BROWSER_EXECUTABLE or the usual paths); FX_GL=0 skips it.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import {
	BLEND_MODES,
	blendModeInfo,
	blendPixel,
	clampPremul,
	dissolveNoise,
	type Rgba,
	storePremul8,
} from '@jasper/project';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blendModeCss } from '../src/pipeline.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

/** Deterministic pseudo-random bytes. */
function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s >>> 24;
	};
}

/** Minimal PNG decoder (8-bit RGBA / RGB, non-interlaced) for Playwright screenshots. */
function decodePng(buf: Buffer): { width: number; height: number; data: Uint8Array } {
	let pos = 8;
	let width = 0;
	let height = 0;
	let channels = 4;
	const idat: Buffer[] = [];
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString('ascii', pos + 4, pos + 8);
		const body = buf.subarray(pos + 8, pos + 8 + len);
		if (type === 'IHDR') {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			channels = body[9] === 6 ? 4 : 3;
		} else if (type === 'IDAT') idat.push(body);
		pos += 12 + len;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const out = new Uint8Array(width * height * 4);
	const prev = new Uint8Array(stride);
	const cur = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		const f = raw[y * (stride + 1)]!;
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let i = 0; i < stride; i++) {
			const a = i >= channels ? cur[i - channels]! : 0;
			const b = prev[i]!;
			const c = i >= channels ? prev[i - channels]! : 0;
			let v = line[i]!;
			if (f === 1) v += a;
			else if (f === 2) v += b;
			else if (f === 3) v += (a + b) >> 1;
			else if (f === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			cur[i] = v & 255;
		}
		for (let x = 0; x < width; x++) {
			for (let k = 0; k < 4; k++) out[(y * width + x) * 4 + k] = k < channels ? cur[x * channels + k]! : 255;
		}
		prev.set(cur);
	}
	return { width, height, data: out };
}

const premul = (px: ArrayLike<number>, i: number, opacity = 1): Rgba => {
	const a = (px[i + 3]! / 255) * opacity;
	return [(px[i]! / 255) * a, (px[i + 1]! / 255) * a, (px[i + 2]! / 255) * a, a];
};
/** Premultiplied output channels in code values (straight bytes × alpha). */
const outPremul = (px: ArrayLike<number>, i: number): Rgba => {
	const a = px[i + 3]! / 255;
	return [px[i]! * a, px[i + 1]! * a, px[i + 2]! * a, px[i + 3]!];
};

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'clip blend modes in WebGL2 and CSS (headless Chrome)',
	{ timeout: 120_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string, arg?: unknown): Promise<T> =>
			page.evaluate(
				([n, a]) =>
					(window as unknown as { __blend: Record<string, (a?: string) => unknown> }).__blend[n]!(
						a as string,
					),
				[name, arg === undefined ? undefined : JSON.stringify(arg)] as const,
			) as Promise<T>;

		beforeAll(async () => {
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'blend-gl', 'entry.ts')],
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
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		const W = 32;
		const H = 32;
		/** Random straight RGBA bytes; alpha in [aMin, 255]. */
		const randomPixels = (seed: number, aMin: number) => {
			const r = rng(seed);
			const a: number[] = [];
			for (let i = 0; i < W * H; i++) {
				// Include the edges of the formulas' branches (0, 0.25, 0.5, 1) now and then.
				const ch = () => {
					const v = r();
					return v < 12 ? [0, 64, 128, 255][v % 4]! : r();
				};
				a.push(ch(), ch(), ch(), aMin >= 255 ? 255 : aMin + Math.round((r() / 255) * (255 - aMin)));
			}
			return a;
		};

		it('has WebGL2', async () => {
			expect((await call<{ webgl2: boolean }>('info')).webgl2).toBe(true);
		});

		/** Modes with discontinuities (thresholds, divisions near 0): an input off by rounding may flip a pixel. */
		const STEEP = new Set([
			'dissolve',
			'color-burn',
			'color-dodge',
			'vivid-light',
			'hard-mix',
			'divide',
			'darker-color',
			'lighter-color',
			'hue',
			'saturation',
			'color',
			'luminosity',
		]);
		it.each(BLEND_MODES.map((m) => [m]))('GL compositor = blendPixel: %s', async (mode) => {
			// [pixel alpha min, opacity below, layer opacity]: opaque pictures (exact inputs) with and without layer
			// opacity, then translucent pictures (stored premultiplied in 8 bits by the browser, as layer pictures are).
			for (const [aMin, opBelow, opLayer] of [
				[255, 1, 1],
				[255, 0.8, 0.7],
				[140, 1, 0.9],
			] as const) {
				const seed = 12345;
				const r = await call<{ out: number[]; stored: number[][] }>('composite', {
					W,
					H,
					layers: [
						{ key: 'below', mode: 'normal', rgba: randomPixels(1, aMin), opacity: opBelow },
						{ key: 'layer', mode, rgba: randomPixels(2, aMin), opacity: opLayer, seed },
					],
				});
				const [below, layer] = r.stored as [number[], number[]];
				let bad = 0;
				let worst = 0;
				for (let y = 0; y < H; y++)
					for (let x = 0; x < W; x++) {
						const i = (y * W + x) * 4;
						const dst = storePremul8(blendPixel('normal', [0, 0, 0, 0], premul(below, i, opBelow), 0));
						const want = clampPremul(
							blendPixel(mode, dst, premul(layer, i, opLayer), dissolveNoise(x, y, seed)),
						);
						const got = outPremul(r.out, i);
						let e = 0;
						for (let k = 0; k < 4; k++) e = Math.max(e, Math.abs(want[k]! * 255 - got[k]!));
						worst = Math.max(worst, e);
						if (e > 2.5) {
							bad++;
							if (process.env.BLEND_DEBUG)
								console.log(
									'BAD',
									mode,
									x,
									y,
									below.slice(i, i + 4),
									layer.slice(i, i + 4),
									want.map((v) => v * 255),
									got,
								);
						}
					}
				const allowed = aMin === 255 ? (mode === 'dissolve' ? 3 : 0) : STEEP.has(mode) ? (W * H) / 30 : 0;
				expect(
					bad,
					`${mode} alpha≥${aMin} opacity ${opBelow}/${opLayer}: worst ${worst}`,
				).toBeLessThanOrEqual(allowed);
			}
		});

		it('color-mgmt: Blend using 1.0 gamma composites in linear light of the working curve', async () => {
			const solid = (v: number) => {
				const out: number[] = [];
				for (let i = 0; i < W * H; i++) out.push(v, v, v, 255);
				return out;
			};
			const layers = [
				{ key: 'below', mode: 'normal', rgba: solid(0) },
				{ key: 'layer', mode: 'normal', rgba: solid(255), opacity: 0.5 },
			];
			const at = async (linear?: string) =>
				(await call<{ out: number[] }>('composite', { W, H, layers, ...(linear ? { linear } : {}) })).out[0]!;
			expect(Math.abs((await at()) - 128)).toBeLessThanOrEqual(1);
			expect(Math.abs((await at('bt1886')) - 255 * 0.5 ** (1 / 2.4))).toBeLessThanOrEqual(1.5);
			expect(Math.abs((await at('srgb')) - 255 * (1.055 * 0.5 ** (1 / 2.4) - 0.055))).toBeLessThanOrEqual(
				1.5,
			);
			// PQ: half the light of white (10 000 cd/m²) = 5000 cd/m² → PQ 0.924
			expect(Math.abs((await at('pq')) - 255 * 0.9235)).toBeLessThanOrEqual(2);
		});

		it('Dissolve keeps about opacity × pixels and changes with the seed', async () => {
			const one = { key: 'layer', mode: 'dissolve', rgba: new Array(W * H).fill([255, 0, 0, 255]).flat() };
			const run = (seed: number, opacity: number) =>
				call<{ out: number[] }>('composite', { W, H, layers: [{ ...one, seed, opacity }] });
			const a = await run(7, 0.3);
			const b = await run(8, 0.3);
			const count = (o: number[]) => o.filter((v, i) => i % 4 === 3 && v === 255).length;
			expect(count(a.out) / (W * H)).toBeGreaterThan(0.2);
			expect(count(a.out) / (W * H)).toBeLessThan(0.4);
			expect(a.out.join(',')).not.toBe(b.out.join(','));
			expect((await run(7, 0.3)).out.join(',')).toBe(a.out.join(','));
		});

		it('places a moved half-size layer and composites mattes', async () => {
			const red = new Array(16 * 16).fill([255, 0, 0, 255]).flat();
			// comp px → picture px: picture at (8, 4) in the frame.
			const r = await call<{ out: number[] }>('composite', {
				W,
				H,
				layers: [
					{ key: 'matte', mode: 'normal', matte: [0.5, 0.5, 0.5, 1] },
					{
						key: 'red',
						mode: 'multiply',
						rgba: red,
						w: 16,
						h: 16,
						compToCanvas: [1, 0, -8, 0, 1, -4, 0, 0, 1],
					},
				],
			});
			const at = (x: number, y: number) => r.out.slice((y * W + x) * 4, (y * W + x) * 4 + 4);
			expect(at(2, 2)).toEqual([128, 128, 128, 255]);
			const inside = at(15, 10);
			expect(Math.abs(inside[0]! - 128)).toBeLessThanOrEqual(1);
			expect(inside[1]).toBeLessThanOrEqual(1);
		});

		it('stencil and silhouette act on the stack below', async () => {
			const opaque = new Array(W * H).fill([200, 100, 50, 255]).flat();
			const half = new Array(W * H).fill(0).flatMap((_, i) => [0, 0, 0, i % W < W / 2 ? 255 : 0]);
			const run = async (mode: string) =>
				(
					await call<{ out: number[] }>('composite', {
						W,
						H,
						layers: [
							{ key: 'below', mode: 'normal', rgba: opaque },
							{ key: 'mask', mode, rgba: half },
						],
					})
				).out;
			const st = await run('stencil-alpha');
			expect(st.slice(0, 4)).toEqual([200, 100, 50, 255]);
			expect(st[(W - 1) * 4 + 3]).toBe(0);
			const si = await run('silhouette-alpha');
			expect(si[3]).toBe(0);
			expect(si.slice((W - 1) * 4, W * 4)).toEqual([200, 100, 50, 255]);
		});

		const cssModes = BLEND_MODES.filter((m) => !!blendModeCss(m));
		it('draws the CSS modes and only those through mix-blend-mode', () => {
			expect(cssModes).toEqual(BLEND_MODES.filter((m) => blendModeInfo(m)!.css));
			expect(cssModes).toEqual([
				'darken',
				'multiply',
				'lighten',
				'screen',
				'overlay',
				'soft-light',
				'hard-light',
				'difference',
				'exclusion',
				'hue',
				'color',
				'luminosity',
			]);
		});

		it.each(cssModes.map((m) => [m]))('Chrome CSS mix-blend-mode = blendPixel: %s', async (mode) => {
			for (const [baseOpacity, topOpacity, tol] of [
				[1, 1, 0],
				[0.7, 0.6, 2],
			] as const) {
				const base = randomPixels(3, 255);
				const top = randomPixels(4, 255);
				await call('css', { W, H, base, top, mode: blendModeCss(mode), baseOpacity, topOpacity });
				const png = decodePng(
					await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H }, omitBackground: true }),
				);
				let worst = 0;
				for (let i = 0; i < W * H * 4; i += 4) {
					const dst = blendPixel('normal', [0, 0, 0, 0], premul(base, i, baseOpacity), 0);
					const want = clampPremul(blendPixel(mode, dst, premul(top, i, topOpacity), 0));
					const got = outPremul(png.data, i);
					for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(want[k]! * 255 - got[k]!));
				}
				expect(worst, `${mode} opacity ${baseOpacity}/${topOpacity}`).toBeLessThanOrEqual(tol + 0.6);
			}
		});
	},
);
