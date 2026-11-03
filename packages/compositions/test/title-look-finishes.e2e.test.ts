// @vitest-environment node
// Spec 19 finishes end to end (REMOTION_E2E=1): real text through HTML-in-Canvas and Remotion renders. TL-036 boxes from every
// text drawing path (plain block, unit overlay of a legacy animation, typeset characters), TL-021 a real image on a look,
// offline media, a picture that cannot be read (renders fail by name, Program draws a stand-in with a chip), and Program
// against export for a look with finishes. GL detail: title-look-finishes-gl.test.ts.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command, LookRecipe, Paint } from '@jasper/project';
import { bundleForBrowser } from '@jasper/testkit/browser';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxSnapshot, startFxMedia } from './fx-media.ts';
import { ssim, ssimRgb } from './title-look-harness.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
const OUT = process.env.TL_E2E_OUT ?? join(here, '..', '..', '..', 'test-results', 'title-look-finishes-e2e');

const W = FX_W;
const H = FX_H;

const ramp = (span: string, angle: number): Paint =>
	({
		kind: 'gradient',
		gradient: {
			type: 'linear',
			span,
			angle,
			stops: [
				{ at: 0, paint: { color: [0, 0, 0, 1] } },
				{ at: 1, paint: { color: [1, 1, 1, 1] } },
			],
		},
	}) as Paint;

const text = (extra: Record<string, unknown> = {}) => ({
	type: 'clip.addText',
	at: 0,
	duration: 90,
	track: 'V2',
	content: { text: 'LOOK', style: { sizePx: 120, fill: [1, 1, 1, 1], align: 'center', weight: 700 } },
	box: { width: 520, height: 180, autoSize: 'none' },
	ref: '$t',
	...extra,
});

const backdrop = { type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [0.2, 0.3, 0.2, 1] };

const looked = (recipe: LookRecipe, extra: Record<string, unknown> = {}, more: unknown[] = []) =>
	fxSnapshot([
		backdrop,
		text(extra),
		{ type: 'look.apply', clipIds: ['$t'], look: { name: 'E2E', recipe }, seed: 4242 },
		...more,
	] as Command[]);

const faceRamp = (span: string, angle = 0): LookRecipe => ({
	layers: [{ type: 'face', params: { paint: ramp(span, angle) } }],
});

type Raw = { data: Buffer; w: number; h: number };
const decode = (png: Buffer | string, w: number, h: number): Raw => ({
	data: execFileSync(
		'ffmpeg',
		[
			'-v',
			'error',
			'-i',
			typeof png === 'string' ? png : 'pipe:0',
			'-f',
			'rawvideo',
			'-pix_fmt',
			'rgb24',
			'-',
		],
		{
			maxBuffer: 1 << 27,
			...(typeof png === 'string' ? {} : { input: png }),
		},
	),
	w,
	h,
});
const luma = (r: Raw) => {
	const out = new Float64Array(r.w * r.h);
	for (let i = 0; i < out.length; i++)
		out[i] = 0.2126 * r.data[i * 3]! + 0.7152 * r.data[i * 3 + 1]! + 0.0722 * r.data[i * 3 + 2]!;
	return out;
};
const rgb = (r: Raw, x: number, y: number) => {
	const i = (Math.round(y) * r.w + Math.round(x)) * 3;
	return [r.data[i]!, r.data[i + 1]!, r.data[i + 2]!] as const;
};

describe.runIf(enabled && !!CHROME)(
	'Title Look finishes in real Chrome (REMOTION_E2E=1)',
	{ timeout: 300_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		let puppeteerInstance: Awaited<ReturnType<typeof renderer.openBrowser>> | undefined;
		let browser: Browser;
		let page: Page;
		let panorama: ReturnType<typeof fxAsset>;
		/** A `.png` the browser cannot decode: online media whose picture cannot be read. */
		let broken: ReturnType<typeof fxAsset>;
		const remotionBrowser = { browserExecutable: CHROME!, chromeMode: 'chrome-for-testing' as const };

		/** The bars of a look: glyph spans, the same look on the whole text, and metal over a plate with a sheen. */
		const showcase: LookRecipe = {
			palette: { base: [0.1, 0.12, 0.3, 1] },
			layers: [
				{ type: 'plate', params: { kind: 'slant', grow: 10 } },
				{ type: 'rim', params: { width: 5, paint: ramp('glyph', 90) } },
				{ type: 'face', params: { finish: 'metal', metalKind: 'gold' } },
				{ type: 'sheen', params: { position: 40 } },
			],
		};

		beforeAll(async () => {
			mkdirSync(OUT, { recursive: true });
			media = await startFxMedia('title-finishes-');
			// A panorama in three bands: red zenith, green horizon, blue ground.
			execFileSync('ffmpeg', [
				'-v',
				'error',
				'-y',
				'-f',
				'lavfi',
				'-i',
				'color=c=red:s=64x12[a];color=c=lime:s=64x12[b];color=c=blue:s=64x12[c];[a][b][c]vstack=inputs=3',
				'-frames:v',
				'1',
				join(media.dir, 'panorama.png'),
			]);
			panorama = fxAsset(media, 'image', 'panorama.png', 64, 36);
			writeFileSync(join(media.dir, 'broken.png'), 'not a picture, only its name says so');
			broken = fxAsset(media, 'image', 'broken.png', 64, 36);
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			puppeteerInstance = await renderer.openBrowser('chrome', {
				...remotionBrowser,
				chromiumOptions: { gl: 'swangle' },
			});
			const code = await bundleForBrowser(join(here, 'fx-player', 'entry.tsx'));
			media.page('bundle.js', 'text/javascript', code);
			const docs = {
				showcase: looked(showcase, {}, [mover()]),
				gone: offlineDoc(),
				unreadable: pictureDoc(broken),
			};
			media.page(
				'index.html',
				'text/html',
				`<!doctype html><html><body style="margin:0;background:#000"><script>window.__docs = ${JSON.stringify(docs)};</script><script src="/bundle.js"></script></body></html>`,
			);
			browser = await chromium.launch({
				executablePath: CHROME!,
				args: [
					'--enable-features=CanvasDrawElement',
					'--use-angle=swiftshader',
					'--enable-unsafe-swiftshader',
				],
			});
			page = await browser.newPage({ viewport: { width: W, height: H * 2 } });
			page.on('pageerror', (e) => console.error(`[finishes] page error: ${e.message}`));
			await page.goto(`${media.base}/index.html`, { timeout: 600_000 });
		}, 1_500_000);

		afterAll(async () => {
			await browser?.close();
			await puppeteerInstance?.close({ silent: true });
			media?.close();
		});

		/** A position animator lifting every character over the clip, keyed by the next commands. */
		function mover(): unknown {
			return { type: 'textAnimator.add', clipId: '$t', properties: ['position'], ref: '$a' };
		}

		function offlineDoc() {
			return pictureDoc({ ...panorama, locators: [{ type: 'engine-store', engineId: 'x', key: 'mk_gone' }] });
		}

		/** A reflection face mirroring `asset`. */
		function pictureDoc(asset: ReturnType<typeof fxAsset>) {
			return fxSnapshot([
				backdrop,
				text(),
				{ type: 'media.register', asset, ref: '$m' },
				{
					type: 'look.apply',
					clipIds: ['$t'],
					look: {
						name: 'E2E',
						recipe: {
							layers: [
								{ type: 'face', params: { finish: 'reflection', reflectionImage: { mediaId: '$m' } } },
							],
						},
					},
				},
			] as Command[]);
		}

		async function still(doc: ReturnType<typeof fxSnapshot>, frame: number, name: string): Promise<Raw> {
			const inputProps = {
				doc,
				options: { isPreview: false, useProxies: false, transparentBackground: false },
			};
			const composition = await renderer.selectComposition({
				serveUrl,
				id: SEQUENCE_COMPOSITION_ID,
				inputProps,
				puppeteerInstance,
				...remotionBrowser,
			});
			const output = join(OUT, `${name}.png`);
			await renderer.renderStill({
				composition,
				serveUrl,
				inputProps,
				frame,
				output,
				puppeteerInstance,
				...remotionBrowser,
			});
			return decode(output, doc.settings.width, doc.settings.height);
		}

		/** Mean luma of the text in each column band, left to right: rises within a letter when a ramp runs across it. */
		const inkColumns = (r: Raw) => {
			const out: number[] = [];
			for (let x = 0; x < r.w; x++) {
				let sum = 0;
				let n = 0;
				for (let y = 0; y < r.h; y++) {
					const [a, b, c] = rgb(r, x, y);
					// Not the backdrop.
					if (Math.abs(a - 51) + Math.abs(b - 77) + Math.abs(c - 51) < 12) continue;
					sum += a;
					n++;
				}
				out.push(n > 4 ? sum / n : -1);
			}
			return out;
		};
		/** Letters (runs of inked columns) whose right part is much brighter than their left: each ran a ramp of its own. */
		const ramps = (columns: number[]) => {
			let count = 0;
			let x = 0;
			while (x < columns.length) {
				if (columns[x]! < 0) {
					x++;
					continue;
				}
				const from = x;
				while (x < columns.length && columns[x]! >= 0) x++;
				const third = Math.max(1, Math.floor((x - from) / 3));
				const mean = (a: number, b: number) => columns.slice(a, b).reduce((u, v) => u + v, 0) / (b - a);
				if (mean(x - third, x) > mean(from, from + third) + 90) count++;
			}
			return count;
		};

		it('glyph spans on real text: every letter runs the ramp, block runs it once', async () => {
			const glyph = await still(looked(faceRamp('glyph')), 0, 'glyph');
			const block = await still(looked(faceRamp('block')), 0, 'block');
			expect(ramps(inkColumns(glyph))).toBeGreaterThanOrEqual(3);
			expect(ramps(inkColumns(block))).toBeLessThanOrEqual(1);
		});

		it('line spans follow the lines of real text', async () => {
			const two = fxSnapshot([
				backdrop,
				{
					...text(),
					content: {
						text: 'AB\nCD',
						style: { sizePx: 80, fill: [1, 1, 1, 1], align: 'center', weight: 700 },
					},
					box: { width: 400, height: 220, autoSize: 'none' },
				},
				{ type: 'look.apply', clipIds: ['$t'], look: { name: 'E2E', recipe: faceRamp('line', 90) } },
			] as Command[]);
			const img = await still(two, 0, 'lines');
			const inRow = (y: number) => {
				let sum = 0;
				let n = 0;
				for (let x = 0; x < img.w; x++) {
					const [a, b, c] = rgb(img, x, y);
					if (Math.abs(a - 51) + Math.abs(b - 77) + Math.abs(c - 51) < 12) continue;
					sum += a;
					n++;
				}
				return n > 8 ? sum / n : -1;
			};
			const rows = Array.from({ length: img.h }, (_, y) => inRow(y));
			// Each line is dark at its top and bright at its bottom, so the ramp starts again between them.
			const ink = rows.flatMap((v, y) => (v >= 0 ? [{ y, v }] : []));
			const gap = ink.findIndex((r, i) => i > 0 && r.y > ink[i - 1]!.y + 2);
			expect(gap).toBeGreaterThan(0);
			const [first, second] = [ink.slice(0, gap), ink.slice(gap)];
			for (const line of [first, second]) {
				expect(line[0]!.v).toBeLessThan(90);
				expect(line.at(-1)!.v).toBeGreaterThan(170);
			}
		});

		it('glyph spans on vertical text: each letter of the column runs the ramp (integration 2)', async () => {
			// Vertical text (TL-111), upright CJK, wraps at the box height: its rest layout must be measured with it, or the
			// glyph boxes that a look's spans read sit where the letters are not.
			const column = (span: string) =>
				fxSnapshot([
					backdrop,
					{
						...text(),
						content: {
							text: '縦書文字',
							style: { sizePx: 60, fill: [1, 1, 1, 1], align: 'center', weight: 700 },
							writingMode: 'vertical',
						},
						box: { width: 120, height: 320, autoSize: 'none' },
					},
					{ type: 'look.apply', clipIds: ['$t'], look: { name: 'E2E', recipe: faceRamp(span, 90) } },
				] as Command[]);
			/** Mean red of the text in each row, top to bottom; -1 where a row has no ink. */
			const inkRows = (r: Raw) =>
				Array.from({ length: r.h }, (_, y) => {
					let sum = 0;
					let n = 0;
					for (let x = 0; x < r.w; x++) {
						const [a, b, c] = rgb(r, x, y);
						if (Math.abs(a - 51) + Math.abs(b - 77) + Math.abs(c - 51) < 12) continue;
						sum += a;
						n++;
					}
					return n > 4 ? sum / n : -1;
				});
			const glyph = await still(column('glyph'), 0, 'vertical-glyph');
			const block = await still(column('block'), 0, 'vertical-block');
			expect(ramps(inkRows(glyph))).toBeGreaterThanOrEqual(3);
			expect(ramps(inkRows(block))).toBeLessThanOrEqual(1);
		});

		it('a moved text keeps its ramp on the letters: typeset characters report their matrices', async () => {
			const atRest = await still(looked(faceRamp('glyph', 90)), 0, 'rest');
			const lifted = looked(faceRamp('glyph', 90), {}, [
				mover(),
				{
					type: 'keyframe.add',
					target: ['clip', '$t', 'textAnimators', '$a', 'properties', 'position'],
					at: { frames: 0 },
					value: [0, -40],
				},
			]);
			const moved = await still(lifted, 0, 'lifted');
			// The same letters 40 px higher, with the same shades: compare the crop shifted.
			const a = new Float64Array(W * (H - 80));
			const b = new Float64Array(W * (H - 80));
			const la = luma(atRest);
			const lb = luma(moved);
			for (let y = 0; y < H - 80; y++)
				for (let x = 0; x < W; x++) {
					a[y * W + x] = la[(y + 60) * W + x]!;
					b[y * W + x] = lb[(y + 20) * W + x]!;
				}
			const score = ssim(a, b, W, H - 80);
			console.info(`[finishes] typeset: moved glyph ramp vs rest SSIM ${score.toFixed(4)}`);
			expect(score).toBeGreaterThan(0.97);
		});

		it('a legacy text animation keeps its ramp on the letters: the unit overlay reports its boxes', async () => {
			const anim = {
				textAnimation: { in: { preset: 'slide-up', durationFrames: 30, params: { unit: 'char' } } },
			};
			const animated = looked(faceRamp('glyph'), anim);
			const mid = await still(animated, 10, 'legacy-mid');
			const done = await still(looked(faceRamp('glyph')), 0, 'legacy-rest');
			// Mid animation every visible letter still runs the ramp left to right, whichever letters have arrived.
			expect(ramps(inkColumns(mid))).toBeGreaterThanOrEqual(2);
			expect(ramps(inkColumns(done))).toBeGreaterThanOrEqual(3);
		});

		it('Program and export agree on finishes, spans and a moving title', async () => {
			const doc = looked(showcase, {}, [mover()]);
			for (const frame of [0, 30]) {
				const exported = await still(doc, frame, `showcase-${frame}`);
				await page.evaluate(
					(f) =>
						(window as never as { __fxPlayer: { seek(a: string, b: number): void } }).__fxPlayer.seek(
							'showcase',
							f,
						),
					frame,
				);
				let prev = null as Buffer | null;
				for (let i = 0; i < 50; i++) {
					await page.waitForTimeout(200);
					const shot = await page.locator('#showcase').screenshot();
					if (prev?.equals(shot) && i > 2) break;
					prev = shot;
				}
				const program = decode(prev!, W, H);
				// Colour, not luma alone (AGENTS §4): the least SSIM of R, G and B.
				const score = ssimRgb(program.data, exported.data, W, H).min;
				console.info(`[finishes] frame ${frame}: Program vs export colour SSIM ${score.toFixed(4)}`);
				expect(score).toBeGreaterThan(0.98);
			}
		});

		it('a real image reaches a look through its {mediaId} param in a render', async () => {
			const doc = fxSnapshot([
				backdrop,
				text(),
				{ type: 'media.register', asset: panorama, ref: '$m' },
				{
					type: 'look.apply',
					clipIds: ['$t'],
					look: {
						name: 'E2E',
						recipe: {
							layers: [
								{
									type: 'face',
									params: { finish: 'reflection', reflectionImage: { mediaId: '$m' }, reflectionBlur: 0 },
								},
							],
						},
					},
				},
			] as Command[]);
			expect(Object.values(doc.media).some((m) => m?.url.endsWith('panorama.png'))).toBe(true);
			const img = await still(doc, 0, 'panorama');
			let red = 0;
			let blue = 0;
			for (let y = 0; y < img.h; y++)
				for (let x = 0; x < img.w; x++) {
					const [r, g, b] = rgb(img, x, y);
					if (r > 200 && g < 90 && b < 90) red++;
					if (b > 200 && r < 90 && g < 90) blue++;
				}
			console.info(`[finishes] panorama on real text: ${red} red, ${blue} blue pixels`);
			expect(red).toBeGreaterThan(100);
			expect(blue).toBeGreaterThan(100);
		});

		it('an offline image: the preset draws, and Program says so with a chip', async () => {
			const offline = offlineDoc();
			expect(Object.values(offline.media).every((m) => m === null)).toBe(true);
			await page.evaluate(() =>
				(window as never as { __fxPlayer: { seek(a: string, b: number): void } }).__fxPlayer.seek('gone', 3),
			);
			await page.waitForTimeout(2500);
			const chip = await page.evaluate(() =>
				(window as never as { __fxPlayer: { chip(a: string): string | null } }).__fxPlayer.chip('gone'),
			);
			expect(chip).toMatch(/offline/i);
		});

		it('an offline picture fails a render by name: the look is never exported without it (AGENTS §4)', async () => {
			const e = await still(offlineDoc(), 0, 'offline-render').catch((x: unknown) => x);
			expect(e).toBeInstanceOf(Error);
			expect((e as Error).message).toMatch(
				/LOOK_MEDIA_OFFLINE: a picture of the look on layer "[^"]+" is offline/,
			);
		});

		it('a picture that cannot be read fails a render by name, naming the layer and the media', async () => {
			const doc = pictureDoc(broken);
			expect(Object.values(doc.media).some((m) => m?.url.endsWith('broken.png'))).toBe(true);
			const e = await still(doc, 0, 'unreadable-render').catch((x: unknown) => x);
			expect(e).toBeInstanceOf(Error);
			expect((e as Error).message).toMatch(
				/LOOK_MEDIA_UNREADABLE: the look picture med_\w+ \(reflectionImage\) of layer "LOOK" could not be read/,
			);
		});

		it('Program draws a picture that cannot be read as a visible stand-in, with a chip', async () => {
			await page.evaluate(() =>
				(window as never as { __fxPlayer: { seek(a: string, b: number): void } }).__fxPlayer.seek(
					'unreadable',
					3,
				),
			);
			let chip: string | null = null;
			for (let i = 0; i < 50 && !chip; i++) {
				await page.waitForTimeout(200);
				chip = await page.evaluate(() =>
					(window as never as { __fxPlayer: { chip(a: string): string | null } }).__fxPlayer.chip(
						'unreadable',
					),
				);
			}
			expect(chip).toBe('A picture of this look could not be read');
			await page.waitForTimeout(1000);
			const png = await page.locator('#unreadable').screenshot();
			writeFileSync(join(OUT, 'unreadable-program.png'), png);
			const shot = decode(png, W, H);
			const gone = decode(await page.locator('#gone').screenshot(), W, H);
			// The stand-in is a magenta and black checkerboard: the mirror shows magenta, which nothing else here draws.
			const magenta = (r: Raw) => {
				let n = 0;
				for (let y = 0; y < r.h; y++)
					for (let x = 0; x < r.w; x++) {
						const [a, b, c] = rgb(r, x, y);
						if (a > 150 && c > 150 && b < 90) n++;
					}
				return n;
			};
			console.info(`[finishes] stand-in: ${magenta(shot)} magenta pixels (offline preset: ${magenta(gone)})`);
			expect(magenta(shot)).toBeGreaterThan(200);
			expect(magenta(gone)).toBe(0);
		});
	},
);
