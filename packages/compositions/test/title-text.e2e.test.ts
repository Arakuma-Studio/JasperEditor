// @vitest-environment node
// Spec 19 TL-110, TL-111 end to end in real Chrome (REMOTION_E2E=1): a vertical title with a look, a keyed Warp Text and
// tate-chu-yoko, drawn by the Player and through a Remotion render, compared frame by frame; a text animator on vertical
// text; and the warp's resolution independence. The pictures land in test-results/title-text-e2e: look at them.
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
	TEXT_WARP_EFFECT_ID,
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
const OUT = join(here, '..', '..', '..', 'test-results', 'title-text-e2e');

const recipe: LookRecipe = {
	palette: { face: [0.98, 0.82, 0.25, 1], keyline: [0.08, 0.1, 0.35, 1], glow: [1, 0.35, 0.1, 1] },
	layers: [
		{ type: 'glow', params: { radius: 14 } },
		{ type: 'rim', params: { width: 6, paint: { kind: 'role', role: 'keyline' } } },
		{ type: 'face', params: { paint: { kind: 'role', role: 'face' } } },
	],
};

type Opts = { scale?: number; warp?: boolean; animator?: boolean; horizontal?: boolean };

function build(o: Opts = {}) {
	const k = o.scale ?? 1;
	const ids = createCounterIdSource(1);
	const project = createEmptyProject({ ids, name: 'text', preset: 'hd-720p-30' });
	const seqId = Object.keys(project.sequences)[0]!;
	const ctx = { ids, now: () => '2026-11-02T10:00:00.000Z', revision: 0, registries: defaultRegistries() };
	const step = (doc: typeof project, commands: unknown[]) => {
		const { document, result } = applyTransaction(
			doc,
			{ label: 't', origin: 'user', sequenceId: seqId, commands },
			ctx,
		);
		if (!result.ok) throw new Error(JSON.stringify(result.errors));
		return { document, result };
	};
	const warp = o.warp !== false;
	let { document: doc, result } = step(project, [
		{ type: 'sequence.updateSettings', sequenceId: seqId, settings: { width: W * k, height: H * k } },
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [0.09, 0.12, 0.2, 1] },
		{
			type: 'clip.addText',
			at: 0,
			duration: 90,
			track: 'V2',
			content: {
				text: '縦書き12月\nTITLE',
				style: { sizePx: 56 * k, fill: [1, 1, 1, 1], align: 'center', weight: 700 },
				runs: [{ from: 0, to: 1, style: { sizePx: 72 * k } }],
				...(o.horizontal ? {} : { writingMode: 'vertical' }),
			},
			box: { width: 200 * k, height: 300 * k, autoSize: 'none' },
			ref: '$t',
		},
		{ type: 'look.apply', clipIds: ['$t'], look: { name: 'E2E', recipe }, seed: 7 },
		...(warp
			? [
					{
						type: 'effect.add',
						target: { clipId: '$t' },
						effectId: TEXT_WARP_EFFECT_ID,
						params: { style: 'arch', orientation: 'vertical' },
						ref: '$w',
					},
				]
			: []),
		...(o.animator ? [{ type: 'textAnimator.add', clipId: '$t', properties: ['position'], ref: '$a' }] : []),
	]);
	const steps: unknown[] = [];
	if (warp) {
		const bend = ['effect', result.refs.$w!, 'bend'];
		steps.push(
			{ type: 'keyframe.add', target: bend, at: { frames: 0 }, value: -30 },
			{ type: 'keyframe.add', target: bend, at: { frames: 60 }, value: 45 },
		);
	}
	if (o.animator) {
		const pos = ['clip', result.refs.$t!, 'textAnimators', result.refs.$a!, 'properties', 'position'];
		steps.push(
			{ type: 'keyframe.add', target: pos, at: { frames: 0 }, value: [40 * k, 0] },
			{ type: 'keyframe.add', target: pos, at: { frames: 60 }, value: [0, 0] },
		);
	}
	if (steps.length) ({ document: doc, result } = step(doc, steps));
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
		{ maxBuffer: 1 << 27, ...(typeof png === 'string' ? {} : { input: png }) },
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
	'vertical, warped titles in real Chrome (REMOTION_E2E=1)',
	{ timeout: 600_000 },
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
			media = await startFxMedia('title-text-');
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
				`<!doctype html><html><body style="margin:0;background:#000"><script>window.__docs = ${JSON.stringify({ warped: build(), animated: build({ warp: false, animator: true }) })};</script><script src="/bundle.js"></script></body></html>`,
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
			page.on('pageerror', (e) => console.error(`[title-text] page error: ${e.message}`));
			await page.goto(`${media.base}/index.html`, { timeout: 300_000 });
		}, 600_000);

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

		async function programFrame(id: string, frame: number, name: string): Promise<Raw> {
			await page.evaluate(
				([n, f]) => {
					(window as never as { __fxPlayer: { seek(a: string, b: number): void } }).__fxPlayer.seek(
						n as string,
						f as number,
					);
				},
				[id, frame] as const,
			);
			let prev = null as Buffer | null;
			for (let i = 0; i < 80; i++) {
				await page.waitForTimeout(200);
				const shot = await page.locator(`#${id}`).screenshot();
				if (prev?.equals(shot) && i > 3) break;
				prev = shot;
			}
			writeFileSync(join(OUT, `${name}.png`), prev!);
			return decode(prev!, W, H);
		}

		it('a warped vertical title with a look: Program against a real render', async () => {
			const doc = build();
			for (const f of [0, 30, 60]) {
				const a = await programFrame('warped', f, `warped-program-${f}`);
				const b = await still(doc, f, `warped-render-${f}`);
				const s = ssim(luma(a), luma(b), W, H);
				console.info(`[title-text] warped frame ${f}: SSIM ${s.toFixed(4)}, max diff ${maxDiff(a, b)}`);
				expect(s).toBeGreaterThan(0.98);
			}
		});

		it('the warp changes the picture, and the bend animates', async () => {
			const flat = await still(build({ warp: false }), 30, 'unwarped-30');
			const a = await still(build(), 0, 'bend-0');
			const b = await still(build(), 60, 'bend-60');
			expect(ssim(luma(flat), luma(b), W, H)).toBeLessThan(0.97);
			expect(ssim(luma(a), luma(b), W, H)).toBeLessThan(0.97);
		});

		it('a text animator on vertical text: Program against a real render', async () => {
			const doc = build({ warp: false, animator: true });
			for (const f of [0, 30]) {
				const a = await programFrame('animated', f, `animator-program-${f}`);
				const b = await still(doc, f, `animator-render-${f}`);
				const s = ssim(luma(a), luma(b), W, H);
				console.info(`[title-text] animator frame ${f}: SSIM ${s.toFixed(4)}, max diff ${maxDiff(a, b)}`);
				expect(s).toBeGreaterThan(0.98);
			}
			// The animator's vertical path draws the same columns as the plain block once it has settled.
			const rest = await still(build({ warp: false }), 60, 'plain-60');
			const moved = await still(doc, 60, 'animator-60');
			expect(ssim(luma(rest), luma(moved), W, H)).toBeGreaterThan(0.9);
		});

		it('a rim stays one outline across letters of different runs (TL-093)', async () => {
			const ids = createCounterIdSource(1);
			const project = createEmptyProject({ ids, name: 'rim', preset: 'hd-720p-30' });
			const seqId = Object.keys(project.sequences)[0]!;
			const { document, result } = applyTransaction(
				project,
				{
					label: 't',
					origin: 'user',
					sequenceId: seqId,
					commands: [
						{ type: 'sequence.updateSettings', sequenceId: seqId, settings: { width: W, height: H } },
						{
							type: 'clip.addText',
							at: 0,
							duration: 30,
							track: 'V1',
							content: {
								text: 'HH',
								style: { sizePx: 140, fill: [1, 1, 1, 1], align: 'center', weight: 700 },
								runs: [{ from: 1, to: 2, style: { sizePx: 110, italic: true } }],
							},
							box: { width: 400, height: 200, autoSize: 'none' },
							ref: '$t',
						},
						{
							type: 'look.apply',
							clipIds: ['$t'],
							look: {
								name: 'Rim',
								recipe: {
									palette: { face: [1, 1, 0, 1], keyline: [0, 0, 1, 1] },
									layers: [
										{ type: 'rim', params: { width: 20, paint: { kind: 'role', role: 'keyline' } } },
										{ type: 'face', params: { paint: { kind: 'role', role: 'face' } } },
									],
								},
							},
						},
					],
				},
				{ ids, now: () => '2026-11-02T10:00:00.000Z', revision: 0, registries: defaultRegistries() },
			);
			if (!result.ok) throw new Error(JSON.stringify(result.errors));
			const doc = buildRenderSnapshot(document, seqId, { resolveMedia: () => null, resolveFont: () => null });
			const r = await still(doc, 10, 'rim-runs');
			// Along the row through the title, from the first lit pixel to the last there is no background.
			const y = Math.round(H / 2);
			const lit = (x: number) => {
				const i = (y * W + x) * 3;
				return r.data[i]! + r.data[i + 1]! + r.data[i + 2]! > 60;
			};
			const xs = Array.from({ length: W }, (_, x) => x).filter(lit);
			expect(xs.length).toBeGreaterThan(40);
			expect(xs.length).toBe(xs[xs.length - 1]! - xs[0]! + 1);
		});

		it('the warp holds at another resolution (TL-034)', async () => {
			const a = await still(build(), 45, 'res-100');
			const b = await still(build({ scale: 2 }), 45, 'res-200');
			const down = resampleLuma(luma(b), W * 2, H * 2, W, H);
			const s = ssim(luma(a), down, W, H);
			console.info(`[title-text] warped 200 % against 100 %: SSIM ${s.toFixed(4)}`);
			expect(s).toBeGreaterThan(0.93);
		});
	},
);
