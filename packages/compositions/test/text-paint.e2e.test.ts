// @vitest-environment node
// spec 13 SH-004 (docs/wp-notes/text-render.md): text paint — every stroke (outside / centre / inside), the shadow
// (offset, blur, spread, opacity) — and the text box measurer, in the Program preview (a Remotion Player in Chrome)
// and in the Remotion export (renderStill of the same document). Geometry oracles use a generated font whose
// glyph is an exact square (`glyphRects`), so every stroke ring and shadow edge has a known place; the parity
// cases compare preview and export frames pixel by pixel. REMOTION_E2E=1 (needs Chrome and ffmpeg).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	applyTransaction,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type TextContent,
} from '@jasper/project';
import { bundleForBrowser } from '@jasper/testkit/browser';
import { makeTestTtf, TEST_FONT_METRICS } from '@jasper/testkit/fonts';
import type { Rgba8 } from '@jasper/testkit/image';
import { decodePng, encodePng } from '@jasper/testkit/png';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MeasureFace } from '../src/layers/text/box-measure.ts';
import { type RenderDoc, SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { type FxMedia, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
const W = 640;
const H = 360;

type Rgb = [number, number, number];
type Style = Record<string, unknown>;

/** The square font: "A" is the square [100, 0, 500, 400] font units (80 × 80 px at 200 px), every other glyph empty. */
const SQUARE: [number, number, number, number] = [100, 0, 500, 400];
const FAMILIES: Record<string, (weight: number) => string> = {
	'Source Sans 3': (w) => (w >= 600 ? 'ss3-700.woff2' : 'ss3-400.woff2'),
	'TP Square': () => 'square.ttf',
	'TP Pixel': () => 'pixel.ttf',
};

function snapshotOf(m: FxMedia, commands: Command[], opts: { captions?: boolean } = {}): RenderDoc {
	const ids = createCounterIdSource(1);
	const project = createEmptyProject({ ids, name: 'text paint', preset: 'hd-720p-30' });
	const seqId = Object.keys(project.sequences)[0]!;
	const { document, result } = applyTransaction(
		project,
		{
			label: 'text paint',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'sequence.updateSettings', sequenceId: seqId, settings: { width: W, height: H } } as Command,
				...commands,
			],
		},
		{ ids, now: () => '2026-10-25T10:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return buildRenderSnapshot(document, seqId, {
		resolveMedia: () => null,
		resolveFont: (f, weight) => (FAMILIES[f.family] ? `${m.base}/${FAMILIES[f.family]!(weight)}` : null),
		...(opts.captions ? { captions: 'visible' as const } : {}),
	});
}

/** A text clip in `family` (box fixed so its place is known), over an optional solid background. */
function text(
	family: string,
	s: string,
	style: Style,
	o: { box?: [number, number]; background?: [number, number, number, number] } = {},
): Command[] {
	const [bw, bh] = o.box ?? [520, 300];
	return [
		...(o.background
			? [{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: o.background } as Command]
			: []),
		{ type: 'font.add', family, ref: '$f' } as Command,
		{
			type: 'clip.addText',
			at: 0,
			duration: 30,
			track: o.background ? 'V2' : 'V1',
			content: { text: s, style: { fontId: '$f', sizePx: 200, fill: [1, 1, 1, 1], align: 'left', ...style } },
			box: { width: bw, height: bh, autoSize: 'none' },
			ref: '$t',
		} as unknown as Command,
	];
}

const RED = [1, 0, 0, 1];
const BLUE = [0, 0, 1, 1];
const GREEN = [0, 1, 0, 1];

describe.runIf(enabled && !!CHROME)('text paint in preview and export (REMOTION_E2E=1)', { timeout: 300_000 }, () => {
	let media: FxMedia;
	let serveUrl: string;
	let renderer: typeof import('@remotion/renderer');
	let browser: Browser;
	let page: Page;
	const docs: Record<string, RenderDoc> = {};
	const remotionBrowser = { browserExecutable: CHROME!, chromeMode: 'chrome-for-testing' as const };

	beforeAll(async () => {
		media = await startFxMedia('text-paint-');
		const req = createRequire(import.meta.url);
		const dir = dirname(
			req.resolve('@fontsource/source-sans-3/package.json', { paths: [join(here, '../../../apps/engine')] }),
		);
		copyFileSync(join(dir, 'files/source-sans-3-latin-400-normal.woff2'), join(media.dir, 'ss3-400.woff2'));
		copyFileSync(join(dir, 'files/source-sans-3-latin-700-normal.woff2'), join(media.dir, 'ss3-700.woff2'));
		writeFileSync(
			join(media.dir, 'square.ttf'),
			makeTestTtf({ family: 'TP Square', glyphRects: (code) => (code === 65 ? [SQUARE] : []) }),
		);
		// Pixel12x10-like: blocky cell glyphs (a pixel font's outlines: right angles only).
		writeFileSync(join(media.dir, 'pixel.ttf'), makeTestTtf({ family: 'TP Pixel', seed: 7 }));

		docs.outside = snapshotOf(media, text('TP Square', 'A', { strokes: [stroke(RED, 10, 'outside'), stroke(BLUE, 30, 'outside')] }));
		docs.insideCentre = snapshotOf(
			media,
			text('TP Square', 'A', { strokes: [stroke(RED, 10, 'inside'), stroke(GREEN, 8, 'center')] }),
		);
		docs.translucent = snapshotOf(
			media,
			text('TP Square', 'A', { fill: [1, 1, 1, 0.5], strokes: [stroke(RED, 12, 'outside')] }),
		);
		docs.spread = snapshotOf(
			media,
			text('TP Square', 'A', {
				shadow: { color: [0, 1, 0, 0.8], angleDeg: 0, distancePx: 40, blurPx: 0, spreadPx: 10 },
			}),
		);
		docs.blur = snapshotOf(
			media,
			text('TP Square', 'A', {
				shadow: { color: GREEN, angleDeg: 0, distancePx: 0, blurPx: 40, spreadPx: 20 },
			}),
		);
		// The user's subtitle look (spec 13 §0): pixel font ≈ 98 px, white, #AE00FF outside 11.5 px, shadow #221D58 at
		// 80 %, distance 0, size 26.87, blur 250 — over a mid-grey picture.
		const pop = {
			sizePx: 98,
			align: 'center',
			strokes: [stroke([0xae / 255, 0, 1, 1], 11.5, 'outside')],
			shadow: { color: [0x22 / 255, 0x1d / 255, 0x58 / 255, 0.8], angleDeg: 90, distancePx: 0, blurPx: 250, spreadPx: 26.87 },
		};
		docs.pop = snapshotOf(media, text('TP Pixel', 'JASPER 12', pop, { box: [600, 140], background: [0.5, 0.55, 0.6, 1] }));
		docs.multi = snapshotOf(
			media,
			text(
				'Source Sans 3',
				'Hola señor',
				{
					sizePx: 90,
					weight: 700,
					fill: [1, 0.9, 0.2, 1],
					strokes: [stroke([0.1, 0.1, 0.1, 1], 4, 'inside'), stroke([1, 1, 1, 0.8], 6, 'center'), stroke([0.6, 0, 0.9, 1], 14, 'outside')],
					shadow: { color: [0, 0, 0, 0.7], angleDeg: 45, distancePx: 12, blurPx: 16, spreadPx: 6 },
				},
				{ box: [600, 140], background: [0.2, 0.5, 0.3, 1] },
			),
		);
		docs.runs = snapshotOf(media, [
			...text('Source Sans 3', 'Big small', {
				sizePx: 80,
				strokes: [stroke(RED, 8, 'outside')],
			}),
			{
				type: 'clip.update',
				clipIds: ['$t'],
				patch: {
					content: {
						runs: [{ from: 4, to: 9, style: { fill: [0.2, 0.8, 1, 0.6], strokes: [stroke(BLUE, 5, 'inside')] } }],
					},
				},
			} as Command,
		]);
		docs.typeset = snapshotOf(
			media,
			text('Source Sans 3', 'Typeset', {
				sizePx: 90,
				tsume: 20,
				strokes: [stroke(RED, 6, 'inside'), stroke(BLUE, 12, 'outside')],
				shadow: { color: [0, 0, 0, 0.8], angleDeg: 90, distancePx: 8, blurPx: 10, spreadPx: 4 },
			}, { background: [0.6, 0.6, 0.6, 1] }),
		);
		docs.animated = snapshotOf(media, [
			...text('Source Sans 3', 'Fade in', {
				sizePx: 90,
				strokes: [stroke(RED, 6, 'inside'), stroke(BLUE, 10, 'outside')],
			}, { background: [0.4, 0.4, 0.4, 1] }),
			{
				type: 'clip.update',
				clipIds: ['$t'],
				patch: { textAnimation: { in: { preset: 'fade', durationFrames: 20, params: { unit: 'char' } } } },
			} as Command,
		]);
		// A colour / GPU effect on the layer: the painted text (tile filter, shadow) is captured through HTML-in-Canvas.
		docs.fx = snapshotOf(media, [
			...text('TP Square', 'A', {
				strokes: [stroke(RED, 8, 'inside'), stroke(BLUE, 10, 'outside')],
				shadow: { color: [0, 1, 0, 1], angleDeg: 0, distancePx: 60, blurPx: 0, spreadPx: 0 },
			}),
			{ type: 'effect.add', target: { clipId: '$t' }, effectId: 'jasper.invert' } as Command,
		]);
		docs.captions = snapshotOf(
			media,
			[
				{ type: 'font.add', family: 'Source Sans 3', ref: '$cf' } as Command,
				{
					type: 'caption.add',
					at: 0,
					duration: 30,
					text: 'Caption strokes',
					style: {
						fontId: '$cf',
						sizePx: 48,
						strokes: [stroke(RED, 3, 'inside'), stroke([0, 0, 0, 1], 8, 'outside')],
						shadow: { color: [0, 0, 0.5, 0.9], angleDeg: 90, distancePx: 4, blurPx: 12, spreadPx: 5 },
					},
				} as unknown as Command,
			],
			{ captions: true },
		);

		const { bundle } = await import('@remotion/bundler');
		serveUrl = await bundle({ entryPoint: join(here, 'text-animators', 'entry.ts') });
		renderer = await import('@remotion/renderer');
		const code = await bundleForBrowser(join(here, 'text-paint', 'entry.tsx'));
		media.page('bundle.js', 'text/javascript', code);
		media.page(
			'index.html',
			'text/html',
			`<!doctype html><html><body style="margin:0;background:#000"><script>window.__docs = ${JSON.stringify(docs)};</script><script src="/bundle.js"></script></body></html>`,
		);
		// The render browser (Remotion) runs without font hinting; so does this preview browser, so the comparison
		// measures the text paint, not Linux FreeType hinting (the editor's Chrome on macOS / Windows does not hint
		// outlines that way either).
		browser = await chromium.launch({
			executablePath: CHROME!,
			args: [
				'--enable-features=CanvasDrawElement',
				'--use-angle=swiftshader',
				'--enable-unsafe-swiftshader',
				'--font-render-hinting=none',
			],
		});
		page = await browser.newPage({ viewport: { width: W, height: H * Object.keys(docs).length } });
		await page.goto(`${media.base}/index.html`);
		console.info(`[text-paint] frames in ${media.dir}`);
	}, 300_000);

	afterAll(async () => {
		await browser?.close();
		media?.close();
	});

	function stroke(color: number[], widthPx: number, position: 'outside' | 'center' | 'inside') {
		return { color, widthPx, position };
	}

	async function exported(name: string, frame = 5): Promise<Rgba8> {
		const inputProps = { doc: docs[name]!, options: { isPreview: false, useProxies: false, transparentBackground: false } };
		const composition = await renderer.selectComposition({ serveUrl, id: SEQUENCE_COMPOSITION_ID, inputProps, ...remotionBrowser });
		const output = join(media.dir, `${name}-export.png`);
		await renderer.renderStill({ composition, serveUrl, inputProps, frame, output, ...remotionBrowser });
		return decodePng(readFileSync(output));
	}

	/** The Player's frame once it stopped changing (fonts load and layout settles asynchronously). */
	async function preview(name: string, frame = 5): Promise<Rgba8> {
		await page.evaluate(([n, f]) => (window as never as { __textPaint: { seek(a: string, b: number): void } }).__textPaint.seek(n as string, f as number), [name, frame] as const);
		let prev: Buffer | null = null;
		for (let i = 0; i < 40; i++) {
			await page.waitForTimeout(150);
			const png = await page.locator(`#${name}`).screenshot();
			if (prev && png.equals(prev)) break;
			prev = png;
		}
		const img = decodePng(prev!);
		writeFileSync(join(media.dir, `${name}-preview.png`), encodePng(img));
		return img;
	}

	const px = (img: Rgba8, x: number, y: number): Rgb => {
		const i = (Math.round(y) * img.width + Math.round(x)) * 4;
		return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
	};
	const near = (a: Rgb, b: Rgb, tol = 24) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
	function bbox(img: Rgba8, pred: (p: Rgb) => boolean) {
		let x0 = img.width;
		let y0 = img.height;
		let x1 = -1;
		let y1 = -1;
		for (let y = 0; y < img.height; y++)
			for (let x = 0; x < img.width; x++)
				if (pred(px(img, x, y))) {
					x0 = Math.min(x0, x);
					x1 = Math.max(x1, x);
					y0 = Math.min(y0, y);
					y1 = Math.max(y1, y);
				}
		return { x0, y0, x1, y1 };
	}
	/** Preview vs export: share of pixels off by more than 16 levels in a channel, and the mean difference. */
	function diff(a: Rgba8, b: Rgba8) {
		let off = 0;
		let sum = 0;
		const n = a.width * a.height;
		for (let i = 0; i < n; i++) {
			let m = 0;
			for (let k = 0; k < 3; k++) {
				const d = Math.abs(a.data[i * 4 + k]! - b.data[i * 4 + k]!);
				sum += d;
				m = Math.max(m, d);
			}
			if (m > 16) off++;
		}
		return { off: off / n, mean: sum / (n * 3) };
	}
	const white = (p: Rgb) => p.every((v) => v > 235);

	/** Checks both renders: preview and export must agree and satisfy `check`. */
	async function both(name: string, check: (img: Rgba8, which: string) => void, frame = 5) {
		const e = await exported(name, frame);
		const p = await preview(name, frame);
		check(e, 'export');
		check(p, 'preview');
		const d = diff(p, e);
		console.info(`[text-paint] ${name}: ${(d.off * 100).toFixed(3)} % of pixels > 16 levels, mean ${d.mean.toFixed(3)}`);
		// AGENTS §4 tolerance for preview vs export of text paint: ≤ 1 % of pixels off by > 16 levels, mean ≤ 1 level.
		// The Player rasterises glyph edges a fraction of a pixel differently from the render page (measured on the
		// build VM: 0.67 % on the hard-edged two-ring square, ≤ 0.4 % on the other squares, ≈ 0 on real fonts).
		expect(d.off, `${name} preview vs export`).toBeLessThanOrEqual(0.01);
		expect(d.mean, `${name} preview vs export`).toBeLessThanOrEqual(1);
		return { e, p };
	}

	it('two outside strokes: each paints its ring from the glyph outline, the first on top (fast path)', async () => {
		await both('outside', (img, which) => {
			const sq = bbox(img, white);
			expect(sq.x1 - sq.x0, which).toBeGreaterThan(70);
			const ym = (sq.y0 + sq.y1) / 2;
			// ring edges ±1 px (the Player draws the composition at a sub-pixel offset)
			for (const d of [3, 5, 8]) expect(near(px(img, sq.x1 + d, ym), [255, 0, 0]), `${which} red at +${d}`).toBe(true);
			for (const d of [14, 20, 28]) expect(near(px(img, sq.x1 + d, ym), [0, 0, 255]), `${which} blue at +${d}`).toBe(true);
			expect(near(px(img, sq.x1 + 34, ym), [0, 0, 0]), `${which} black past the strokes`).toBe(true);
			for (const d of [3, 8]) expect(near(px(img, sq.x0 - d, ym), [255, 0, 0]), `${which} red left`).toBe(true);
			// miter joins keep a square's corners square
			expect(near(px(img, sq.x1 + 25, sq.y0 - 25), [0, 0, 255]), `${which} blue corner`).toBe(true);
		});
		const s = await page.evaluate(() => (window as never as { __textPaint: { structure(n: string): unknown } }).__textPaint.structure('outside'));
		expect(s).toMatchObject({ blocks: 1, copies: 2, tiles: 0 });
	});

	it('inside and centre strokes: inside paints within the glyph, centre straddles the outline (tile filter)', async () => {
		await both('insideCentre', (img, which) => {
			const all = bbox(img, (p) => p.some((v) => v > 60));
			const ym = (all.y0 + all.y1) / 2;
			// outer edge = outline + 4 (centre half); green 0…4 outside, red 10 px inside, then white.
			const edge = all.x1;
			expect(near(px(img, edge - 2, ym), [0, 255, 0]), `${which} green outside half`).toBe(true);
			for (const d of [6, 9, 12]) expect(near(px(img, edge - d, ym), [255, 0, 0]), `${which} red inside at ${d}`).toBe(true);
			expect(white(px(img, edge - 20, ym)), `${which} white core`).toBe(true);
		});
		const s = await page.evaluate(() => (window as never as { __textPaint: { structure(n: string): { tiles: number } } }).__textPaint.structure('insideCentre'));
		expect(s.tiles).toBe(4);
	});

	it('an outside stroke under a translucent fill: no stroke under the fill, no seam at the outline', async () => {
		await both('translucent', (img, which) => {
			const red = bbox(img, (p) => p[0] > 200 && p[1] < 60);
			const ym = (red.y0 + red.y1) / 2;
			const inner = px(img, (red.x0 + red.x1) / 2, ym);
			expect(near(inner, [128, 128, 128], 6), `${which} 50 % white over black, no red under it`).toBe(true);
			// Every pixel across the left and right outlines stays at least as bright (red channel) as the fill.
			for (let x = red.x0; x <= red.x1; x++) expect(px(img, x, ym)[0], `${which} seam at x=${x}`).toBeGreaterThanOrEqual(120);
		});
	});

	it('shadow spread grows the silhouette before the offset (blur 0)', async () => {
		await both('spread', (img, which) => {
			const sq = bbox(img, white);
			const ym = (sq.y0 + sq.y1) / 2;
			// square + 10 px, moved 40 px right
			expect(near(px(img, sq.x1 + 44, ym), [0, 204, 0], 10), `${which} shadow inside spread`).toBe(true);
			expect(near(px(img, sq.x1 + 54, ym), [0, 0, 0], 10), `${which} beyond spread`).toBe(true);
			expect(near(px(img, sq.x1 + 20, sq.y0 - 6), [0, 204, 0], 10), `${which} spread above`).toBe(true);
			expect(near(px(img, sq.x1 + 20, sq.y0 - 14), [0, 0, 0], 10), `${which} beyond spread above`).toBe(true);
		});
	});

	it('shadow blur is a Gaussian of σ = blurPx / 2 around the spread silhouette', async () => {
		const Phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
		await both('blur', (img, which) => {
			const sq = bbox(img, white);
			const ym = (sq.y0 + sq.y1) / 2;
			for (const e of [10, 20, 30, 40, 55]) {
				const want = 255 * Phi((20 - e) / 20);
				expect(Math.abs(px(img, sq.x1 + e, ym)[1] - want), `${which} green at +${e} (want ${want.toFixed(0)})`).toBeLessThanOrEqual(12);
			}
		});
	});

	it('the subtitle look on a pixel font: same frame in preview and export, a wide soft shadow', async () => {
		await both('pop', (img, which) => {
			const purple = bbox(img, (p) => p[0] > 140 && p[1] < 40 && p[2] > 200);
			expect(purple.x1, `${which} stroke drawn`).toBeGreaterThan(purple.x0);
			const bg = [128, 140, 153] as const;
			const above = px(img, (purple.x0 + purple.x1) / 2, Math.max(0, purple.y0 - 20));
			expect(bg[2] - above[2], `${which} shadow darkens near the text`).toBeGreaterThan(10);
			const corner = px(img, 2, 2);
			expect(corner[2], `${which} darker near the text than in the corner`).toBeGreaterThan(above[2]);
		});
	});

	it('three strokes with a shadow, runs with their own strokes, typeset text, animated units and captions match', async () => {
		await both('multi', () => {});
		await both('runs', () => {});
		await both('typeset', () => {});
		await both('animated', () => {}, 8);
		await both('captions', (img, which) => {
			const red = bbox(img, (p) => p[0] > 200 && p[1] < 60 && p[2] < 60);
			expect(red.x1, `${which} caption inside stroke`).toBeGreaterThan(red.x0);
		});
	});

	it('through a layer effect (HTML-in-Canvas): every stroke, the cut and the shadow reach the effect', async () => {
		await both('fx', (img, which) => {
			// inverted: the fill is black, the inside stroke cyan, the outside stroke yellow, the shadow magenta
			const yellow = bbox(img, (p) => p[0] > 220 && p[1] > 220 && p[2] < 40);
			expect(yellow.x1, `${which} outside ring`).toBeGreaterThan(yellow.x0);
			const ym = (yellow.y0 + yellow.y1) / 2;
			expect(near(px(img, yellow.x1 - 4, ym), [255, 255, 0]), `${which} yellow outside`).toBe(true);
			expect(near(px(img, yellow.x1 - 14, ym), [0, 255, 255]), `${which} cyan inside`).toBe(true);
			expect(near(px(img, yellow.x1 - 40, ym), [0, 0, 0]), `${which} black core`).toBe(true);
			expect(near(px(img, yellow.x1 + 40, ym), [255, 0, 255]), `${which} magenta shadow`).toBe(true);
		});
	});

	it('the measurer sizes boxes from the glyph metrics of the faces the renderers load', async () => {
		const face = (family: string, url: string, weight = 400): MeasureFace => ({ fontId: 'fnt_x', family, weight, style: 'normal', url: `${media.base}/${url}` });
		const content = (t: string, style: Style): TextContent => ({
			text: t,
			style: { fontId: 'fnt_x', weight: 400, italic: false, sizePx: 100, lineHeight: 1.2, trackingEm: 0, align: 'left', direction: 'auto', fill: [1, 1, 1, 1], strokes: [], background: null, shadow: null, allCaps: false, ...style } as TextContent['style'],
		});
		const measure = (c: TextContent, box: { width: number; autoSize: 'width' | 'height' }, faces: MeasureFace[]) =>
			page.evaluate(([cc, bb, ff]) => (window as never as { __textPaint: { measure(...a: unknown[]): Promise<unknown> } }).__textPaint.measure(cc, bb, ff), [c, box, faces] as const) as Promise<{ width: number; height: number } | null>;
		const pixel = [face('TP Pixel', 'pixel.ttf')];
		const adv = (TEST_FONT_METRICS.advance / TEST_FONT_METRICS.upem) * 100;
		// point text: n advances × line height; two lines double the height
		expect(await measure(content('ABCD', {}), { width: 10, autoSize: 'width' }, pixel)).toEqual({ width: 4 * adv, height: 120 });
		expect(await measure(content('AB\nABCDEF', {}), { width: 10, autoSize: 'width' }, pixel)).toEqual({ width: 6 * adv, height: 240 });
		// tracking adds after every character
		expect(await measure(content('ABCD', { trackingEm: 0.1 }), { width: 10, autoSize: 'width' }, pixel)).toEqual({ width: 4 * adv + 40, height: 120 });
		// paragraph text wraps at the box width: "ABC DEF" (7 advances, 420 px) fits 450 px, "GHI" wraps → 2 lines
		expect(await measure(content('ABC DEF GHI', {}), { width: 450, autoSize: 'height' }, pixel)).toEqual({ width: 450, height: 240 });
		expect(await measure(content('ABC DEF GHI', {}), { width: 400, autoSize: 'height' }, pixel)).toEqual({ width: 400, height: 360 });
		// a real font: Source Sans 3 bold is wider than regular; the typeset layout (tsume) measures too
		const ss = [face('Source Sans 3', 'ss3-400.woff2'), face('Source Sans 3', 'ss3-700.woff2', 700)];
		const reg = await measure(content('Subtitles', {}), { width: 10, autoSize: 'width' }, ss);
		const bold = await measure(content('Subtitles', { weight: 700 }), { width: 10, autoSize: 'width' }, ss);
		expect(reg!.width).toBeGreaterThan(300);
		expect(bold!.width).toBeGreaterThan(reg!.width);
		const tight = await measure(content('Subtitles', { tsume: 50 }), { width: 10, autoSize: 'width' }, ss);
		expect(tight!.width).toBeLessThan(reg!.width);
		expect(reg!.height).toBe(120);
	});
});

/** Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7). */
function erf(x: number): number {
	const s = Math.sign(x);
	const a = Math.abs(x);
	const t = 1 / (1 + 0.3275911 * a);
	const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
	return s * y;
}
