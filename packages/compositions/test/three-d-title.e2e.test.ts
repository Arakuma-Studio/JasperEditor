// @vitest-environment node
// Spec 19 §9 end to end in real Chrome (REMOTION_E2E=1): a physical 3D title with an environment preset, tone mapping and
// a keyed material, in the Player (the Program monitor's path) and through Remotion renders. Program against export by
// SSIM and a razor cut. Refusals of missing HDRs and models are tested at the plan: apps/engine/test/three-d-hdr.test.ts.
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
} from '@jasper/project';
import { bundleForBrowser } from '@jasper/testkit/browser';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { type FxMedia, startFxMedia } from './fx-media.ts';
import { ssimRgb } from './title-look-harness.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
const W = 640;
const H = 360;
const OUT = process.env.THREE_D_E2E_OUT ?? join(here, '..', '..', '..', 'test-results', 'three-d-title-e2e');

type Opts = { split?: number };

function build(o: Opts = {}) {
	const ids = createCounterIdSource(1);
	const project = createEmptyProject({ ids, name: 'title3d', preset: 'hd-720p-30' });
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
	const first = step(project, [
		{ type: 'sequence.updateSettings', sequenceId: seqId, settings: { width: W, height: H } },
		{ type: 'sequence.set3dRenderer', renderer: 'advanced', toneMapping: 'aces' },
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [0.09, 0.12, 0.2, 1] },
		{
			type: 'clip.addText',
			at: 0,
			duration: 90,
			track: 'V2',
			content: { text: 'GOLD', style: { sizePx: 130, fill: [1, 1, 1, 1], align: 'center', weight: 700 } },
			box: { width: 560, height: 200, autoSize: 'none' },
			ref: '$t',
		},
		{ type: 'clip.set3d', clipIds: ['$t'], enabled: true },
		{
			type: 'clip.addLight',
			at: 0,
			duration: 90,
			track: 'V3',
			lightType: 'environment',
			environmentPreset: 'studio',
		},
	]);
	const t = first.result.refs.$t!;
	let doc = first.document;
	const band = step(doc, [{ type: 'threeD.addBand', clipId: t, width: 5, depth: 5 }]);
	doc = band.document;
	({ document: doc } = step(doc, [
		{ type: 'threeD.setSurface', clipIds: [t], preset: 'gold' },
		{ type: 'threeD.setGeometry', clipIds: [t], extrusionDepth: 24 },
		{ type: 'param.set', target: ['clip', t, 'threeD', 'rotationY'], value: -24 },
		{ type: 'param.set', target: ['clip', t, 'threeD', 'rotationX'], value: 10 },
		// A keyed material and a keyed camera-free rotation: neither depends on anything but the frame.
		{
			type: 'keyframe.add',
			target: ['clip', t, 'threeD', 'surface', 'base', 'roughness'],
			at: { frames: 0 },
			value: 8,
		},
		{
			type: 'keyframe.add',
			target: ['clip', t, 'threeD', 'surface', 'base', 'roughness'],
			at: { frames: 60 },
			value: 40,
		},
	]));
	if (o.split !== undefined)
		({ document: doc } = step(doc, [{ type: 'clip.split', at: o.split, clipIds: [t] }]));
	return buildRenderSnapshot(doc, seqId, { resolveMedia: () => null, resolveFont: () => null });
}

type Raw = { data: Buffer; w: number; h: number };
const decode = (png: Buffer | string): Raw => ({
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
	w: W,
	h: H,
});
const maxDiff = (a: Raw, b: Raw) => {
	let m = 0;
	for (let i = 0; i < a.data.length; i++) m = Math.max(m, Math.abs(a.data[i]! - b.data[i]!));
	return m;
};

describe.runIf(enabled && !!CHROME)('3D titles in real Chrome (REMOTION_E2E=1)', { timeout: 600_000 }, () => {
	let media: FxMedia;
	let serveUrl: string;
	let renderer: typeof import('@remotion/renderer');
	let puppeteerInstance: Awaited<ReturnType<typeof renderer.openBrowser>> | undefined;
	let browser: Browser;
	let page: Page;
	const remotionBrowser = { browserExecutable: CHROME, chromeMode: 'chrome-for-testing' as const };

	beforeAll(async () => {
		mkdirSync(OUT, { recursive: true });
		media = await startFxMedia('three-d-title-');
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
			`<!doctype html><html><body style="margin:0;background:#000"><script>window.__docs = ${JSON.stringify({ title: build() })};</script><script src="bundle.js"></script></body></html>`,
		);
		browser = await chromium.launch({
			executablePath: CHROME!,
			args: ['--enable-features=CanvasDrawElement', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
		});
		page = await browser.newPage({ viewport: { width: W, height: H } });
		page.on('pageerror', (e) => console.error(`[3d-title] page error: ${e.message}`));
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
		return decode(output);
	}

	async function programFrame(frame: number, name: string): Promise<Raw> {
		await page.evaluate((f) => {
			(window as never as { __fxPlayer: { seek(a: string, b: number): void } }).__fxPlayer.seek('title', f);
		}, frame);
		let prev = null as Buffer | null;
		for (let i = 0; i < 120; i++) {
			await page.waitForTimeout(500);
			const shot = await page.locator('#title').screenshot();
			if (prev?.equals(shot) && i > 3) break;
			prev = shot;
		}
		writeFileSync(join(OUT, `${name}.png`), prev!);
		return decode(prev!);
	}

	it.each([0, 45])('Program and export agree at frame %i', async (frame) => {
		const exported = await still(build(), frame, `export-${frame}`);
		const program = await programFrame(frame, `program-${frame}`);
		// Colour, not luma alone (AGENTS §4): the least SSIM of R, G and B.
		const s = ssimRgb(program.data, exported.data, W, H).min;
		console.info(
			`[3d-title] frame ${frame}: colour SSIM ${s.toFixed(4)}, max difference ${maxDiff(program, exported)}`,
		);
		expect(s).toBeGreaterThan(0.98);
		// It is gold, not a flat fallback: warm, and with highlights.
		let warm = 0;
		for (let i = 0; i < W * H; i++) {
			const [r, g, b] = [exported.data[i * 3]!, exported.data[i * 3 + 1]!, exported.data[i * 3 + 2]!];
			if (r > 120 && r > b * 1.6 && g > b) warm++;
		}
		expect(warm).toBeGreaterThan(1000);
	});

	it('a razor cut changes nothing', async () => {
		const whole = await still(build(), 45, 'whole');
		const cut = await still(build({ split: 30 }), 45, 'cut');
		expect(maxDiff(whole, cut)).toBeLessThanOrEqual(1);
	});
});
