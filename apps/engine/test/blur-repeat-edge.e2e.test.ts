// Gaussian Blur with Repeat Edge Pixels keeps the frame edges at full brightness on every path: a full-frame flat
// colour blurred on a clip and through an adjustment layer (at full opacity, and at 70 % as in the usual blur-in
// recipe) is rendered by the engine's still route (the layer bake) and by Remotion as an export and as the Program
// preview draws it; edge pixels must equal the centre, and the export must equal the Remotion stills. Chrome ignores
// feGaussianBlur's `edgeMode`, so before the canvas chain drew these blurs the border fell to about half brightness.
// REMOTION_E2E=1 requires FFmpeg and Chrome (JASPER_BROWSER_EXECUTABLE for a Chrome with HTML-in-Canvas).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testResultsDir } from '@jasper/testkit/env';
import { diffImages, formatDiff, Tolerance } from '@jasper/testkit/golden';
import type { Rgba8 } from '@jasper/testkit/image';
import { oraclesAvailable } from '@jasper/testkit/oracle';
import { decodePng, encodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningEngine } from '../src/index.ts';
import type { DocBuilder, register } from './helpers.ts';
import { tempAppdir } from './temp.ts';

const enabled = process.env.REMOTION_E2E === '1' && oraclesAvailable('ffmpeg', 'ffprobe');
let engineApi: typeof import('../src/index.ts');
let services: typeof import('../src/tools/services.ts');
let helpers: typeof import('./helpers.ts');
let project: typeof import('@jasper/project');
let golden: typeof import('../../../packages/compositions/test/golden/scenes.ts');
if (enabled)
	[engineApi, services, helpers, project, golden] = await Promise.all([
		import('../src/index.ts'),
		import('../src/tools/services.ts'),
		import('./helpers.ts'),
		import('@jasper/project'),
		import('../../../packages/compositions/test/golden/scenes.ts'),
	]);
/** As crop-order parity: 8-bit filter graphs vs Chrome compositing differ by a few levels. */
const PARITY: Tolerance = { minPsnr: 45, maxAbs: 32, p99: 3 };
/** Edge vs centre of a blurred flat colour (8-bit rounding of the blur sums). */
const FLAT_TOL = 2;
const COLOR = [0.55, 0.25, 0.76, 1];

type Cmd = Record<string, unknown>;
const blur = (target: string, radius = 12): Cmd => ({
	type: 'effect.add',
	target: { clipId: target },
	effectId: 'jasper.gaussian-blur',
	params: { radius, repeatEdge: true },
});
const adjustment = (opacity: number): Cmd[] => [
	{ type: 'track.add', kind: 'video', count: 1 },
	{ type: 'clip.addAdjustment', at: 0, duration: 30, track: 'V2', ref: '$a' },
	...(opacity < 100 ? [{ type: 'param.set', target: ['clip', '$a', 'opacity'], value: opacity }] : []),
	blur('$a'),
];
type Scene = { name: string; card?: boolean; commands: Cmd[] };
const SCENES: Scene[] = [
	{ name: 'clip', commands: [blur('$bg')] },
	{ name: 'adjustment', commands: adjustment(100) },
	{ name: 'adjustment-70', commands: adjustment(70) },
	// Not flat: the clamp itself (edge pixels weighted by the kernel's outside part) agrees between the paths.
	{ name: 'card-clip', card: true, commands: [blur('$bg', 9)] },
];

const at = (img: Rgba8, x: number, y: number) => [
	...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4),
];

describe.runIf(enabled)(
	'Gaussian Blur Repeat Edge Pixels: flat edges on every path (REMOTION_E2E=1)',
	{ timeout: 1_800_000 },
	() => {
		let engine: RunningEngine;
		let browser: import('../src/remotion/service.ts').SharedRenderBrowser;
		let card: Awaited<ReturnType<typeof register>>;
		const host = () => ({ host: `127.0.0.1:${engine.port}` });

		beforeAll(async () => {
			engine = await engineApi.startEngine({
				appdir: tempAppdir('jasper-blur-edge-'),
				port: 0,
				// These tests drive the engine itself, not its authentication (server.test.ts, security-hardening.test.ts).
				insecure: true,
				dev: true,
				env: {
					PATH: process.env.PATH,
					...(process.env.JASPER_BROWSER_EXECUTABLE
						? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
						: {}),
				},
			});
			const dir = tempAppdir('jasper-blur-edge-media-');
			writeFileSync(join(dir, 'card.png'), encodePng(golden.goldenCard()));
			card = await helpers.register(engine.app, join(dir, 'card.png'), host());
			browser = await services.coreServices(engine.app).remotion.openSharedBrowser();
		}, 900_000);
		afterAll(async () => {
			try {
				await browser?.close();
			} finally {
				await engine?.stop();
			}
		});

		function build(scene: Scene): DocBuilder {
			const d = new helpers.DocBuilder();
			d.tx([{ type: 'sequence.updateSettings', settings: { width: golden.GW, height: golden.GH } }]);
			const base = scene.card
				? {
						type: 'clip.place',
						source: { mediaId: d.addMedia(card) },
						at: 0,
						tracks: { video: 'V1' },
						ref: '$bg',
					}
				: { type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: COLOR, ref: '$bg' };
			const refs = d.tx([base]).refs;
			const sub = (v: unknown): unknown =>
				typeof v === 'string' && refs[v]
					? refs[v]
					: Array.isArray(v)
						? v.map(sub)
						: v && typeof v === 'object'
							? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]))
							: v;
			d.tx(scene.commands.map((x) => sub(x)) as unknown[]);
			return d;
		}

		async function exportStill(d: DocBuilder, frame: number): Promise<{ img: Rgba8; path: string }> {
			const svc = services.coreServices(engine.app);
			const r = await engine.app.inject({
				method: 'POST',
				url: '/api/stills',
				headers: { ...helpers.JSON_H, ...host() },
				payload: { envelope: d.envelope(), sequenceId: d.seqId, frame },
			});
			expect(r.statusCode, r.body).toBe(202);
			const done = await svc.queue.wait(r.json().id);
			expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
			const output = await engine.app.inject({
				method: 'GET',
				url: `/renders/${done.id}/output`,
				headers: host(),
			});
			expect(output.statusCode, output.body).toBe(200);
			return { img: decodePng(output.rawPayload), path: (done.result as { renderPath: string }).renderPath };
		}

		async function remotionStill(d: DocBuilder, frame: number, isPreview: boolean): Promise<Rgba8> {
			const svc = services.coreServices(engine.app);
			const doc = project.buildRenderSnapshot(d.doc, d.seqId, {
				resolveFont: () => null,
				resolveMedia: (asset) => {
					const key = asset.locators.find((locator) => locator.type === 'engine-store')?.key;
					if (!key) throw new Error(`Missing engine-store locator for ${asset.id}`);
					return {
						url: svc.signer.signUrl(`http://127.0.0.1:${engine.port}`, `/media/${encodeURIComponent(key)}`),
						proxyUrl: null,
						kind: asset.kind,
						width: golden.GW,
						height: golden.GH,
						durationFlicks: null,
						hasAudio: false,
						rotation: 0,
					};
				},
			});
			const out = join(tempAppdir('jasper-blur-edge-'), 'remotion.png');
			await svc.remotion.renderStill({
				inputProps: { doc, options: { isPreview, useProxies: false, transparentBackground: false } },
				output: out,
				frame,
				signal: new AbortController().signal,
				browser,
			});
			return decodePng(readFileSync(out));
		}

		for (const scene of SCENES)
			it(`${scene.name}: edges kept, export = Remotion = preview`, async () => {
				const d = build(scene);
				const exp = await exportStill(d, 10);
				const renders: [string, Rgba8][] = [
					[`export (${exp.path})`, exp.img],
					['remotion', await remotionStill(d, 10, false)],
					['preview', await remotionStill(d, 10, true)],
				];
				const dir = testResultsDir('blur-repeat-edge');
				mkdirSync(dir, { recursive: true });
				for (const [name, img] of renders) {
					writeFileSync(join(dir, `${scene.name}.${name.split(' ')[0]}.png`), encodePng(img));
					const W = img.width;
					const H = img.height;
					const centre = at(img, W >> 1, H >> 1);
					const edges = { left: at(img, 0, H >> 1), top: at(img, W >> 1, 0), corner: at(img, 0, 0) };
					console.info(`[blur edge] ${scene.name} ${name}: centre ${centre} ${JSON.stringify(edges)}`);
					if (scene.card) continue;
					for (const [side, px] of Object.entries(edges))
						for (let c = 0; c < 4; c++)
							expect(
								Math.abs(px[c]! - centre[c]!),
								`${scene.name} ${name} ${side} ${px} vs ${centre}`,
							).toBeLessThanOrEqual(FLAT_TOL);
				}
				for (const [name, img] of renders.slice(1)) {
					const diff = diffImages(exp.img, img);
					console.info(`[blur edge] ${scene.name}: export vs ${name} ${formatDiff(diff)}`);
					expect(Tolerance.accepts(PARITY, diff), `${scene.name} vs ${name}: ${formatDiff(diff)}`).toBe(true);
				}
			});
	},
);
