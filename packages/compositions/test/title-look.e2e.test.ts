// @vitest-environment node
// Spec 19 end to end in real Chrome (REMOTION_E2E=1): a text clip with a text animator and a keyed look param, in the
// Player (HTML-in-Canvas: `--enable-features=CanvasDrawElement`) and through Remotion renders. Program against export
// by SSIM, determinism with fresh ids, a razor cut, resolution, and per-frame cost at 1080p.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type LookRecipe,
} from '@jasper/project';
import { bundleForBrowser } from '@jasper/testkit/browser';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { type FxMedia, startFxMedia } from './fx-media.ts';
import { resampleLuma, ssim } from './title-look-harness.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);

const W = 640;
const H = 360;
const OUT = process.env.TL_E2E_OUT ?? join(here, '..', '..', '..', 'test-results', 'title-look-e2e');

const recipe: LookRecipe = {
	palette: {
		face: [0.98, 0.82, 0.25, 1],
		keyline: [0.08, 0.1, 0.35, 1],
		accent1: [1, 1, 1, 1],
		glow: [1, 0.35, 0.1, 1],
		shadow: [0, 0, 0, 1],
	},
	layers: [
		{ type: 'shadow', params: { distance: 8, blur: 6, angle: 60 } },
		{ type: 'glow', params: { radius: 24 } },
		{ type: 'rim', name: 'Outer', params: { width: 8 } },
		{ type: 'rim', name: 'Inner', params: { width: 3, paint: { kind: 'role', role: 'accent1' } } },
		{
			type: 'face',
			params: {
				paint: {
					kind: 'gradient',
					gradient: {
						type: 'linear',
						span: 'block',
						angle: 90,
						stops: [
							{ at: 0, paint: { color: [1, 0.95, 0.6, 1] } },
							{ at: 1, paint: { role: 'face' } },
						],
					},
				},
			},
		},
	],
};

type Opts = {
	idSeed?: number;
	split?: number;
	scale?: number;
	still?: boolean;
	text?: string;
	/** Spec 19 §7: generator layers on the look, and a standalone generator from `clip.addGenerator`. */
	generators?: boolean;
};

/** A sequence with a dark gradient-free background, the animated title and a keyed look param. */
function build(o: Opts = {}) {
	const k = o.scale ?? 1;
	const ids = createCounterIdSource(o.idSeed ?? 1);
	const project = createEmptyProject({ ids, name: 'look', preset: 'hd-720p-30' });
	const seqId = Object.keys(project.sequences)[0]!;
	const ctx = {
		ids,
		now: () => '2026-11-02T10:00:00.000Z',
		revision: 0,
		registries: defaultRegistries(),
	};
	const step = (doc: typeof project, commands: unknown[]) => {
		const { document, result } = applyTransaction(
			doc,
			{ label: 't', origin: 'user', sequenceId: seqId, commands },
			{
				...ctx,
			},
		);
		if (!result.ok) throw new Error(JSON.stringify(result.errors));
		return { document, result };
	};
	let { document: doc, result } = step(project, [
		{ type: 'sequence.updateSettings', sequenceId: seqId, settings: { width: W * k, height: H * k } },
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [0.09, 0.12, 0.2, 1] },
		{
			type: 'clip.addText',
			at: 0,
			duration: 90,
			track: 'V2',
			content: {
				text: o.text ?? 'LOOK',
				style: { sizePx: 120 * k, fill: [1, 1, 1, 1], align: 'center', weight: 700 },
			},
			box: { width: 520 * k, height: 180 * k, autoSize: 'none' },
			ref: '$t',
		},
		{ type: 'look.apply', clipIds: ['$t'], look: { name: 'E2E', recipe }, seed: 4242 },
		...(o.still ? [] : [{ type: 'textAnimator.add', clipId: '$t', properties: ['position'], ref: '$a' }]),
	]);
	if (o.still) return buildRenderSnapshot(doc, seqId, { resolveMedia: () => null, resolveFont: () => null });
	const t = result.refs.$t!;
	const a = result.refs.$a!;
	const fx = (result.results[3] as { effectInstanceIds: string[] }).effectInstanceIds[0]!;
	const also: string[] = [];
	if (o.generators) {
		const added = step(doc, [
			{
				type: 'appearance.addLayer',
				effectInstanceId: fx,
				layerType: 'generator:fire',
				params: { height: 40 },
			},
			{ type: 'appearance.addLayer', effectInstanceId: fx, layerType: 'generator:glints' },
			{
				type: 'appearance.addLayer',
				effectInstanceId: fx,
				layerType: 'generator:particles',
				params: { count: 300, size: 3 },
				index: 0,
			},
			{
				type: 'clip.addGenerator',
				effectId: 'generator:sunburst',
				at: 0,
				duration: 90,
				belowClipId: t,
				params: { rays: 20 },
			},
		]);
		doc = added.document;
		also.push((added.result.results[3] as { clipId: string }).clipId);
	}
	const clip = doc.sequences[seqId]!.clips[t] as unknown as {
		effects: { appearance: { layers: { id: string; name?: string }[] } }[];
	};
	const outer = clip.effects[0]!.appearance.layers.find((l) => l.name === 'Outer')!.id;
	const pos = ['clip', t, 'textAnimators', a, 'properties', 'position'];
	const rim = ['appearance', fx, outer, 'width'];
	({ document: doc } = step(doc, [
		// The text animator lifts the characters; a look param keys over the same span.
		{ type: 'keyframe.add', target: pos, at: { frames: 0 }, value: [0, -50 * k] },
		{ type: 'keyframe.add', target: pos, at: { frames: 60 }, value: [0, 30 * k] },
		{ type: 'keyframe.add', target: rim, at: { frames: 0 }, value: 2 },
		{ type: 'keyframe.add', target: rim, at: { frames: 60 }, value: 14 },
	]));
	if (o.split !== undefined)
		({ document: doc } = step(doc, [{ type: 'clip.split', at: o.split, clipIds: [t, ...also] }]));
	return buildRenderSnapshot(doc, seqId, { resolveMedia: () => null, resolveFont: () => null });
}

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
const maxDiff = (a: Raw, b: Raw) => {
	let m = 0;
	for (let i = 0; i < a.data.length; i++) m = Math.max(m, Math.abs(a.data[i]! - b.data[i]!));
	return m;
};

describe.runIf(enabled && !!CHROME)(
	'Title Looks in real Chrome (REMOTION_E2E=1)',
	{ timeout: 300_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		let puppeteerInstance: Awaited<ReturnType<typeof renderer.openBrowser>> | undefined;
		let browser: Browser;
		let page: Page;
		const remotionBrowser = { browserExecutable: CHROME, chromeMode: 'chrome-for-testing' as const };

		beforeAll(async () => {
			mkdirSync(OUT, { recursive: true });
			media = await startFxMedia('title-look-');
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			puppeteerInstance = await renderer.openBrowser('chrome', {
				...remotionBrowser,
				chromiumOptions: { gl: 'swangle' },
			});
			const code = await bundleForBrowser(join(here, 'fx-player', 'entry.tsx'));
			media.page('bundle.js', 'text/javascript', code);
			media.page(
				'index.html',
				'text/html',
				`<!doctype html><html><body style="margin:0;background:#000"><script>window.__tlDraws = 0; const d = WebGL2RenderingContext.prototype.drawArrays; WebGL2RenderingContext.prototype.drawArrays = function (...a) { window.__tlDraws++; return d.apply(this, a); }; window.__docs = ${JSON.stringify({ animated: build(), still: build({ still: true }) })};</script><script src="/bundle.js"></script></body></html>`,
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
			page.on('pageerror', (e) => console.error(`[title-look] page error: ${e.message}`));
			await page.goto(`${media.base}/index.html`);
		}, 300_000);

		afterAll(async () => {
			await browser?.close();
			await puppeteerInstance?.close({ silent: true });
			media?.close();
		});

		async function still(doc: ReturnType<typeof build>, frame: number, name: string): Promise<Raw> {
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

		async function programFrame(frame: number, name: string): Promise<Raw> {
			await page.evaluate((f) => {
				(window as never as { __fxPlayer: { seek(a: string, b: number): void } }).__fxPlayer.seek(
					'animated',
					f,
				);
			}, frame);
			// Settle: the Player redraws asynchronously; two identical screenshots in a row end the wait.
			let prev = null as Buffer | null;
			for (let i = 0; i < 40; i++) {
				await page.waitForTimeout(150);
				const shot = await page.locator('#animated').screenshot();
				if (prev?.equals(shot) && i > 2) break;
				prev = shot;
			}
			writeFileSync(join(OUT, `${name}.png`), prev!);
			return decode(prev!, W, H);
		}

		it('HTML-in-Canvas is available in the test Chrome', async () => {
			const supported = await page.evaluate(() => {
				const c = document.createElement('canvas');
				return (
					typeof (c.getContext('2d') as unknown as { drawElementImage?: unknown }).drawElementImage ===
					'function'
				);
			});
			console.info(`[title-look] Chrome ${browser.version()} drawElementImage: ${supported}`);
			expect(supported).toBe(true);
		});

		it('a still look is not recomputed between frames in the Player (TL-037)', async () => {
			const seek = (name: string, f: number) =>
				page.evaluate(
					([n, frame]) =>
						(window as never as { __fxPlayer: { seek(a: string, b: number): void } }).__fxPlayer.seek(
							n as string,
							frame as number,
						),
					[name, f] as const,
				);
			const draws = () => page.evaluate(() => (window as never as { __tlDraws: number }).__tlDraws);
			await seek('still', 5);
			await page.waitForTimeout(3000);
			const settled = await draws();
			for (const f of [10, 20, 30, 40]) {
				await seek('still', f);
				await page.waitForTimeout(400);
			}
			const after = await draws();
			console.info(`[title-look] still look: ${after - settled} GL draws across 4 seeks`);
			expect(after - settled).toBe(0);
			// The input changed: a text edit makes a new clip, and the cache must not hide it.
			await page.evaluate(
				(doc) =>
					(window as never as { __fxPlayer: { setDoc(a: string, b: unknown): void } }).__fxPlayer.setDoc(
						'still',
						doc,
					),
				build({ still: true, text: 'EDIT' }),
			);
			await page.waitForTimeout(3000);
			const edited = await draws();
			expect(edited).toBeGreaterThan(after);
			// The animated clip does redraw: the counter is live.
			await seek('animated', 11);
			await page.waitForTimeout(1500);
			await seek('animated', 12);
			await page.waitForTimeout(1500);
			expect(await draws()).toBeGreaterThan(edited);
		});

		it('Program and export agree on an animated look, frame by frame', async () => {
			const doc = build();
			for (const frame of [0, 30, 60]) {
				const exported = await still(doc, frame, `export-${frame}`);
				const program = await programFrame(frame, `program-${frame}`);
				const score = ssim(luma(program), luma(exported), W, H);
				console.info(
					`[title-look] frame ${frame}: Program vs export SSIM ${score.toFixed(4)}, max ${maxDiff(program, exported)}`,
				);
				expect(score).toBeGreaterThan(0.98);
			}
			// The animation is real: frames differ.
			const a = await still(doc, 0, 'export-a');
			const b = await still(doc, 60, 'export-b');
			expect(maxDiff(a, b)).toBeGreaterThan(50);
			expect(
				await page.evaluate(() => document.querySelector('[data-grade-chip]')?.textContent ?? null),
			).toBeNull();
		});

		it('a double build with fresh ids is byte-identical (TL-035)', async () => {
			const a = await still(build({ idSeed: 1 }), 30, 'double-a');
			const b = await still(build({ idSeed: 5000 }), 30, 'double-b');
			expect(Buffer.compare(a.data, b.data)).toBe(0);
		});

		it('a razor cut leaves every frame of the look unchanged (TL-035)', async () => {
			const whole = build();
			const cut = build({ split: 20 });
			for (const frame of [10, 19, 20, 21, 45]) {
				const a = await still(whole, frame, `whole-${frame}`);
				const b = await still(cut, frame, `cut-${frame}`);
				console.info(`[title-look] razor frame ${frame}: max difference ${maxDiff(a, b)}`);
				expect(maxDiff(a, b)).toBeLessThanOrEqual(2);
			}
		});

		it('generators: a look with generators and a generator clip, through a real render, cut and uncut', async () => {
			const whole = build({ generators: true });
			const cut = build({ generators: true, split: 20 });
			for (const frame of [10, 19, 20, 21, 45]) {
				const a = await still(whole, frame, `gen-whole-${frame}`);
				const b = await still(cut, frame, `gen-cut-${frame}`);
				console.info(`[title-look] generators, razor frame ${frame}: max difference ${maxDiff(a, b)}`);
				expect(maxDiff(a, b)).toBeLessThanOrEqual(2);
			}
			// Frame N after a seek from either side: a render holds no state to reach it with.
			await still(whole, 60, 'gen-seek');
			const again = await still(whole, 45, 'gen-again');
			expect(maxDiff(await still(whole, 45, 'gen-whole-45b'), again)).toBe(0);
			// The generators move, and the title stays in front of the sunburst.
			const a = await still(whole, 10, 'gen-a');
			const b = await still(whole, 11, 'gen-b');
			expect(maxDiff(a, b)).toBeGreaterThan(30);
			const bare = await still(build({ generators: false }), 30, 'gen-bare');
			const lit = await still(whole, 30, 'gen-lit');
			expect(maxDiff(bare, lit)).toBeGreaterThan(30);
		});

		it('resolution independence through real text (TL-034)', async () => {
			const half = await still(build({ scale: 0.5 }), 30, 'res-50');
			const full = await still(build({ scale: 1 }), 30, 'res-100');
			const twice = await still(build({ scale: 2 }), 30, 'res-200');
			const fl = luma(full);
			const small = resampleLuma(fl, full.w, full.h, half.w, half.h);
			const big = resampleLuma(luma(twice), twice.w, twice.h, half.w, half.h);
			const s1 = ssim(small, luma(half), half.w, half.h);
			const s2 = ssim(big, small, half.w, half.h);
			console.info(
				`[title-look] resolution through Remotion: 100 vs 50 ${s1.toFixed(4)}, 200 vs 100 ${s2.toFixed(4)}`,
			);
			expect(s1).toBeGreaterThan(0.95);
			expect(s2).toBeGreaterThan(0.95);
		});
	},
);
