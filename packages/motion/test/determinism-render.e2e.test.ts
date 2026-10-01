// @vitest-environment node
// Render parity (S11:ANM-014) and value-engine cost (ANM-015), gated by REMOTION_E2E=1 (bundles with
// @remotion/bundler, renders in headless Chrome: /usr/bin/google-chrome or JASPER_BROWSER_EXECUTABLE).
//
// Two compositions — the fixture scene (animated title in/out with a seeded order, an anime template with an SVG
// DOM leaf, an animated shape) and the real SequenceComposition with the parity document (every installed text
// animator and anime template, a keyframed shape) — rendered frame by frame with `renderStill` are byte-identical
// to `renderFrames` (the frame stage of `renderMedia`) at concurrency 1 and 4 and to one renderer page visiting
// the frames reversed and shuffled (<Freeze> compositions); `renderMedia` ProRes 4444 at concurrency 1 and 4
// decodes to identical pixels; the @remotion/player frame matches `renderStill` within 3/255 on ≥ 99.5 % of the
// pixels, and a paused Player revisiting frames in any order shows byte-identical pixels. The cost of the value engine
// for a 200-unit title is measured in the same Chrome.
// Both compositions repaint every rendered (and paused) frame from scratch (FrameRepaint,
// packages/compositions/src/repaint.tsx); the render browser creates its pages in their own windows like the engine
// does with a full Chrome (packages/compositions/src/render-host.ts).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderPagesInOwnWindows } from '../../compositions/src/render-host.ts';
import { SCENE } from './determinism-fixtures.tsx';
import { PARITY_DOC_FRAMES, parityDoc } from './determinism-render/doc.ts';
import { reversedOrder, shuffledOrder } from './determinism-render/order.ts';

const enabled = process.env.REMOTION_E2E === '1';
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
// The Remotion tooling is a dev dependency of @jasper/compositions (motion stays free of it).
const fromCompositions = createRequire(join(repo, 'packages', 'compositions', 'package.json'));
const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const N = SCENE.durationInFrames;

// @remotion/renderer, @remotion/bundler and esbuild are loaded from @jasper/compositions at run time (untyped
// here: @jasper/motion does not depend on them).
type Renderer = any;
type Composition = { props: Record<string, unknown> } & Record<string, unknown>;

const ffmpeg = process.env.JASPER_FFMPEG ?? 'ffmpeg';
/** Decodes an image or a video file / PNG buffer to raw RGBA frames. */
function rgba(input: Buffer | string): Buffer {
	const args = [
		'-v',
		'error',
		...(typeof input === 'string' ? ['-i', input] : ['-f', 'png_pipe', '-i', '-']),
	];
	const r = spawnSync(ffmpeg, [...args, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], {
		input: typeof input === 'string' ? undefined : input,
		maxBuffer: 1 << 30,
	});
	if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr.toString()}`);
	return r.stdout;
}

/** Fraction of pixels whose largest channel difference exceeds `tolerance` (RGB). */
function differingFraction(a: Buffer, b: Buffer, tolerance: number): number {
	expect(a.length).toBe(b.length);
	let bad = 0;
	for (let i = 0; i < a.length; i += 4) {
		const d = Math.max(
			Math.abs(a[i]! - b[i]!),
			Math.abs(a[i + 1]! - b[i + 1]!),
			Math.abs(a[i + 2]! - b[i + 2]!),
		);
		if (d > tolerance) bad++;
	}
	return bad / (a.length / 4);
}

const mismatches = (got: (Buffer | undefined)[], want: Buffer[], map: (i: number) => number = (i) => i) =>
	got.flatMap((b, i) => (b && want[map(i)] && b.equals(want[map(i)]!) ? [] : [map(i)]));

describe.runIf(enabled)('render parity (REMOTION_E2E=1, S11:ANM-014/015)', { timeout: 1_200_000 }, () => {
	const r = (enabled ? fromCompositions('@remotion/renderer') : null) as Renderer;
	const browserOpts = CHROME ? { browserExecutable: CHROME, chromeMode: 'chrome-for-testing' as const } : {};
	let serveUrl = '';
	let browser: { close(o: { silent: boolean }): Promise<void> } | undefined;
	const work = enabled ? mkdtempSync(join(tmpdir(), 'jasper-anm014-')) : '';
	const doc = parityDoc();
	const PROPS: Record<string, Record<string, unknown>> = {
		AnimeScene: {},
		Sequence: { doc, options: { isPreview: false, useProxies: false, transparentBackground: false } },
	};
	const stills: Record<string, Buffer[]> = {};

	beforeAll(async () => {
		const { bundle } = fromCompositions('@remotion/bundler');
		serveUrl = await bundle({ entryPoint: join(here, 'determinism-render', 'entry.tsx') });
		browser = await r.openBrowser('chrome', { ...browserOpts });
		// A full Chrome (new headless mode) would open the concurrent pages as hidden tabs (render-host.ts).
		if (CHROME) expect(renderPagesInOwnWindows(browser)).toBe(true);
	}, 900_000);
	afterAll(async () => {
		await browser?.close({ silent: true });
	});

	const select = (id: string): Promise<Composition> =>
		r.selectComposition({
			serveUrl,
			id,
			inputProps: PROPS[id.replace(/Reversed|Shuffled/, '')]!,
			puppeteerInstance: browser,
			...browserOpts,
		});

	async function frames(id: string, concurrency: number): Promise<Buffer[]> {
		const composition = await select(id);
		const out: Buffer[] = [];
		await r.renderFrames({
			composition,
			serveUrl,
			inputProps: composition.props,
			outputDir: null,
			imageFormat: 'png',
			concurrency,
			onStart: () => {},
			onFrameUpdate: () => {},
			onFrameBuffer: (buffer: Buffer, frame: number) => {
				out[frame] = buffer;
			},
			puppeteerInstance: browser,
			...browserOpts,
		});
		return out;
	}

	it('the parity document has the expected shape (installed animators, templates, a keyframed shape)', () => {
		expect(doc.durationFrames).toBe(PARITY_DOC_FRAMES);
		expect(PARITY_DOC_FRAMES).toBe(N);
		expect([doc.settings.width, doc.settings.height]).toEqual([SCENE.width, SCENE.height]);
		const clips = doc.videoTracks.flatMap((t) => t.clips);
		expect(clips.some((c) => c.kind === 'shape')).toBe(true);
		expect(clips.some((c) => c.kind === 'text')).toBe(true);
	});

	for (const id of ['AnimeScene', 'Sequence'])
		it(`${id}: renderStill per frame = renderFrames c1 = c4 = reversed = shuffled (byte-identical PNGs)`, async () => {
			const composition = await select(id);
			const still: Buffer[] = [];
			for (let f = 0; f < N; f++) {
				const { buffer } = await r.renderStill({
					composition,
					serveUrl,
					frame: f,
					inputProps: composition.props,
					imageFormat: 'png',
					output: null,
					puppeteerInstance: browser,
					...browserOpts,
				});
				still[f] = buffer!;
			}
			stills[id] = still;
			// it animates: early, middle and late frames differ
			expect(still[0]!.equals(still[Math.floor(N / 2)]!)).toBe(false);
			expect(still[Math.floor(N / 2)]!.equals(still[N - 1]!)).toBe(false);
			const c1 = await frames(id, 1);
			const c4 = await frames(id, 4);
			const reversed = await frames(`${id}Reversed`, 1);
			const shuffled = await frames(`${id}Shuffled`, 1);
			const rev = reversedOrder(N);
			const shuf = shuffledOrder(N);
			expect({
				c1: mismatches(c1, still),
				c4: mismatches(c4, still),
				reversed: mismatches(reversed, still, (i) => rev[i]!),
				shuffled: mismatches(shuffled, still, (i) => shuf[i]!),
			}).toEqual({ c1: [], c4: [], reversed: [], shuffled: [] });
		});

	it('renderMedia (ProRes 4444) at concurrency 1 and 4 decodes to identical frames', async () => {
		for (const id of ['AnimeScene', 'Sequence']) {
			const composition = await select(id);
			const decoded: Buffer[] = [];
			for (const concurrency of [1, 4]) {
				const out = join(work, `${id}-c${concurrency}.mov`);
				await r.renderMedia({
					composition,
					serveUrl,
					inputProps: composition.props,
					codec: 'prores',
					proResProfile: '4444',
					imageFormat: 'png',
					pixelFormat: 'yuva444p10le',
					muted: true,
					concurrency,
					outputLocation: out,
					puppeteerInstance: browser,
					...browserOpts,
				});
				decoded.push(rgba(out));
			}
			expect(decoded[0]!.length).toBe(SCENE.width * SCENE.height * 4 * N);
			expect(decoded[0]!.equals(decoded[1]!), id).toBe(true);
		}
	});

	describe('Player (Chrome)', () => {
		let page: import('@playwright/test').Page;
		let close: () => Promise<void> = async () => {};
		beforeAll(async () => {
			const esbuild = createRequire(fromCompositions.resolve('@remotion/bundler'))('esbuild');
			const dir = mkdtempSync(join(tmpdir(), 'jasper-anm014-player-'));
			await esbuild.build({
				entryPoints: [join(here, 'determinism-render', 'player.tsx')],
				bundle: true,
				format: 'iife',
				outfile: join(dir, 'player.js'),
				jsx: 'automatic',
				define: { 'process.env.NODE_ENV': '"production"' },
				logLevel: 'silent',
			});
			writeFileSync(
				join(dir, 'index.html'),
				'<!doctype html><html><body style="margin:0;background:#000"><div id="root"></div><script src="player.js"></script></body></html>',
			);
			const { chromium } = await import('@playwright/test');
			const b = await chromium.launch({ executablePath: CHROME, headless: true });
			close = () => b.close();
			page = await b.newPage({
				viewport: { width: SCENE.width, height: SCENE.height },
				deviceScaleFactor: 1,
			});
			await page.goto(pathToFileURL(join(dir, 'index.html')).href);
		}, 300_000);
		afterAll(() => close());

		for (const id of ['AnimeScene', 'Sequence'])
			it(`${id}: the Player frame matches renderStill (≤ 3/255 on ≥ 99.5 % of the pixels)`, async () => {
				expect(stills[id], 'renderStill frames (previous test)').toBeDefined();
				const props =
					id === 'Sequence'
						? { doc, options: { isPreview: true, useProxies: false, transparentBackground: false } }
						: {};
				await page.reload();
				await page.evaluate(
					([which, p]) =>
						(window as never as { __parity: { mount(w: string, p: unknown): void } }).__parity.mount(
							which,
							p,
						),
					[id === 'Sequence' ? 'sequence' : 'scene', props] as const,
				);
				const report: Record<number, number> = {};
				let control = 0;
				for (const f of [0, 5, 11, 17, 24, 31, N - 1]) {
					await page.evaluate(
						(frame) =>
							(window as never as { __parity: { seek(f: number): Promise<void> } }).__parity.seek(frame),
						f,
					);
					const shot = await page.screenshot({
						clip: { x: 0, y: 0, width: SCENE.width, height: SCENE.height },
					});
					report[f] = differingFraction(rgba(shot), rgba(stills[id]![f]!), 3);
					// control: the comparison has teeth (another frame of the same composition differs)
					if (f === 0) control = differingFraction(rgba(shot), rgba(stills[id]![Math.floor(N / 2)]!), 3);
				}
				expect(control, 'Player frame 0 vs still of the middle frame').toBeGreaterThan(0.005);
				console.log(
					`[ANM-014] ${id} Player vs renderStill, fraction of pixels > 3/255:`,
					JSON.stringify(report),
				);
				writeFileSync(join(work, `player-${id}.json`), JSON.stringify(report, null, 2));
				for (const [f, fraction] of Object.entries(report))
					expect(fraction, `frame ${f}`).toBeLessThanOrEqual(0.005);
			});

		// Chrome repaints incrementally (partial raster): before FrameRepaint, ~30 % of these revisits of the Sequence
		// (identical DOM) differed by up to 60/255 at the edges of what the frames in between had changed.
		for (const id of ['AnimeScene', 'Sequence'])
			it(`${id}: a paused Player revisiting frames in any order shows byte-identical pixels`, async () => {
				const props =
					id === 'Sequence'
						? { doc, options: { isPreview: true, useProxies: false, transparentBackground: false } }
						: {};
				await page.reload();
				await page.evaluate(
					([which, p]) =>
						(window as never as { __parity: { mount(w: string, p: unknown): void } }).__parity.mount(
							which,
							p,
						),
					[id === 'Sequence' ? 'sequence' : 'scene', props] as const,
				);
				const visits = [...Array.from({ length: N }, (_, i) => i), ...shuffledOrder(N), ...reversedOrder(N)];
				const first = new Map<number, Buffer>();
				const differing: string[] = [];
				for (const [i, f] of visits.entries()) {
					await page.evaluate(
						(frame) =>
							(window as never as { __parity: { seek(f: number): Promise<void> } }).__parity.seek(frame),
						f,
					);
					const shot = await page.screenshot({
						clip: { x: 0, y: 0, width: SCENE.width, height: SCENE.height },
					});
					const was = first.get(f);
					if (!was) first.set(f, shot);
					else if (!was.equals(shot)) differing.push(`frame ${f} (visit ${i})`);
				}
				expect(differing).toEqual([]);
			});

		it('ANM-015: a 200-unit title computes its values in ≤ 2 ms per frame (median, first visits)', async () => {
			const result = await page.evaluate(() => {
				const p = (window as never as { __parity: { bench(u: number, f: number, k: string): unknown } })
					.__parity;
				// warm-up (JIT), then the measured runs
				p.bench(200, 60, 'four');
				return { four: p.bench(200, 300, 'four'), rise8: p.bench(200, 300, 'rise8') };
			});
			console.log('[ANM-015] value engine, ms per frame (200 units, 300 frames):', JSON.stringify(result));
			writeFileSync(join(work, 'anm-015.json'), JSON.stringify(result, null, 2));
			const four = result as { four: { values: { median: number }; revisit: { median: number } } };
			expect(four.four.values.median).toBeLessThanOrEqual(2);
			expect(four.four.revisit.median).toBeLessThanOrEqual(0.1);
		});
	});
});
