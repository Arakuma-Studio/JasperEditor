// Crop in stack order and Edge Feather: the export paths against the Program preview's renderer (schema v8,
// docs/wp-notes/crop-order.md). Each scene is rendered by the engine's still route (native, or hybrid when a
// browser-only effect sends the layer to the layer bake) and by Remotion (the compositions the Player draws), compared
// per pixel. The native crop test owns differential checks against the independently pinned Program feather profile. REMOTION_E2E=1 requires
// FFmpeg and Chrome (JASPER_BROWSER_EXECUTABLE for a Chrome with HTML-in-Canvas: adjustment layers).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
/** As golden-parity: 8-bit filter graphs vs Chrome compositing differ by a few levels at edges. */
const PARITY: Tolerance = { minPsnr: 45, maxAbs: 32, p99: 3 };

type Cmd = Record<string, unknown>;
type Scene = {
	name: string;
	/** Commands after the card on V1 (`$bg`); the overlay tile is placed on V2 as `$t` unless `noOverlay`. */
	commands: Cmd[];
	noOverlay?: boolean;
	/** Expected export path (native unless a browser-only effect bakes the layer). */
	path?: 'native' | 'hybrid';
	frame?: number;
};
const fx = (effectId: string, params: Record<string, unknown> = {}, target = '$t', ref?: string): Cmd => ({
	type: 'effect.add',
	target: { clipId: target },
	effectId,
	params,
	...(ref ? { ref } : {}),
});
const MIRROR = { reflectionCenter: [0.5, 0.5], reflectionAngle: 0 };

const SCENARIOS: Scene[][] = [
	[
		{
			name: 'crop-then-flip',
			commands: [fx('jasper.crop', { left: 30, top: 10 }), fx('jasper.flip-horizontal')],
		},
		{
			name: 'flip-then-crop',
			commands: [fx('jasper.flip-horizontal'), fx('jasper.crop', { left: 30, top: 10 })],
		},
	],
	[
		{
			name: 'feather',
			commands: [fx('jasper.crop', { left: 10, top: 12, right: 15, bottom: 20, feather: 18 })],
		},
	],
	[
		{
			name: 'feather-then-flip',
			commands: [fx('jasper.crop', { left: 25, bottom: 10, feather: 24 }), fx('jasper.flip-horizontal')],
		},
	],
	[
		{
			name: 'feather-keyframed',
			frame: 15,
			commands: [
				fx('jasper.crop', { left: 20 }, '$t', '$c'),
				{ type: 'keyframe.add', target: ['effect', '$c', 'feather'], at: { sequenceFrame: 0 }, value: 0 },
				{ type: 'keyframe.add', target: ['effect', '$c', 'feather'], at: { sequenceFrame: 30 }, value: 40 },
			],
		},
	],
	[
		{
			name: 'feather-subpixel',
			commands: [
				{ type: 'param.set', target: ['clip', '$t', 'transform', 'scale'], value: 73.3 },
				{ type: 'param.set', target: ['clip', '$t', 'transform', 'rotation'], value: 7 },
				fx('jasper.crop', { left: 10, right: 10, top: 10, bottom: 10, feather: 30 }),
			],
		},
	],
	[
		{
			name: 'mirror-then-crop',
			path: 'hybrid',
			commands: [fx('jasper.mirror', MIRROR), fx('jasper.crop', { left: 30 })],
		},
		{
			name: 'crop-then-mirror',
			path: 'hybrid',
			commands: [fx('jasper.crop', { left: 30 }), fx('jasper.mirror', MIRROR)],
		},
	],
	[
		{
			name: 'crop-then-blur',
			path: 'hybrid',
			commands: [fx('jasper.crop', { left: 30 }), fx('jasper.gaussian-blur', { radius: 8 })],
		},
		{
			name: 'blur-then-crop',
			path: 'hybrid',
			commands: [fx('jasper.gaussian-blur', { radius: 8 }), fx('jasper.crop', { left: 30 })],
		},
	],
	[
		{
			name: 'adjustment-feather',
			noOverlay: true,
			commands: [
				{ type: 'track.add', kind: 'video', count: 1 },
				{ type: 'clip.addAdjustment', at: 0, duration: 30, track: 'V2', ref: '$a' },
				fx('jasper.black-white', {}, '$a'),
				fx('jasper.crop', { left: 20, top: 15, right: 30, feather: 40 }, '$a'),
				fx('jasper.flip-vertical', {}, '$a'),
			],
		},
	],
];

describe.runIf(enabled)(
	'Crop order and Edge Feather: export = preview renderer (REMOTION_E2E=1)',
	{
		timeout: 1_800_000,
	},
	() => {
		let engine: RunningEngine;
		let browser: import('../src/remotion/service.ts').SharedRenderBrowser;
		let card: Awaited<ReturnType<typeof register>>;
		let tile: Awaited<ReturnType<typeof register>>;
		const host = () => ({ host: `127.0.0.1:${engine.port}` });

		beforeAll(async () => {
			engine = await engineApi.startEngine({
				appdir: tempAppdir('jasper-crop-parity-'),
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
			const dir = tempAppdir('jasper-crop-parity-media-');
			writeFileSync(join(dir, 'card.png'), encodePng(golden.goldenCard()));
			writeFileSync(join(dir, 'tile.png'), encodePng(golden.goldenTile()));
			card = await helpers.register(engine.app, join(dir, 'card.png'), host());
			tile = await helpers.register(engine.app, join(dir, 'tile.png'), host());
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
			const c = d.addMedia(card);
			const t = d.addMedia(tile);
			const refs: Record<string, string> = {};
			Object.assign(
				refs,
				d.tx([{ type: 'clip.place', source: { mediaId: c }, at: 0, tracks: { video: 'V1' }, ref: '$bg' }])
					.refs,
			);
			if (!scene.noOverlay)
				Object.assign(
					refs,
					d.tx([
						{ type: 'track.add', kind: 'video', count: 1 },
						{ type: 'clip.place', source: { mediaId: t }, at: 0, tracks: { video: 'V2' }, ref: '$t' },
					]).refs,
				);
			const sub = (v: unknown): unknown =>
				typeof v === 'string' && refs[v]
					? refs[v]
					: Array.isArray(v)
						? v.map(sub)
						: v && typeof v === 'object'
							? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]))
							: v;
			// Effect refs ($c, $a) resolve inside one transaction.
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
			return {
				img: decodePng(output.rawPayload),
				path: (done.result as { renderPath: string }).renderPath,
			};
		}

		async function remotionStill(d: DocBuilder, frame: number): Promise<Rgba8> {
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
						// Both media are golden.GW × golden.GH stills.
						width: golden.GW,
						height: golden.GH,
						durationFlicks: null,
						hasAudio: false,
						rotation: 0,
					};
				},
			});
			const out = join(tempAppdir('jasper-crop-parity-'), 'remotion.png');
			await svc.remotion.renderStill({
				inputProps: { doc, options: { isPreview: false, useProxies: false, transparentBackground: false } },
				output: out,
				frame,
				signal: new AbortController().signal,
				browser,
			});
			return decodePng(readFileSync(out));
		}

		for (const scenes of SCENARIOS)
			it(`${scenes.map((scene) => scene.name).join(' / ')}: export = Remotion`, async () => {
				const rendered: Rgba8[] = [];
				for (const scene of scenes) {
					const d = build(scene);
					const frame = scene.frame ?? 10;
					const exp = await exportStill(d, frame);
					expect(exp.path).toBe(scene.path ?? 'native');
					const rem = await remotionStill(d, frame);
					rendered.push(rem);
					const diff = diffImages(exp.img, rem);
					const line = `[crop parity] ${scene.name} (${exp.path}): export vs Remotion ${formatDiff(diff)}`;
					console.info(line);
					mkdirSync(testResultsDir('crop-order'), { recursive: true });
					appendFileSync(
						join(testResultsDir('crop-order'), 'parity.txt'),
						`${new Date().toISOString()} ${line}\n`,
					);
					writeFileSync(join(testResultsDir('crop-order'), `${scene.name}.export.png`), encodePng(exp.img));
					writeFileSync(join(testResultsDir('crop-order'), `${scene.name}.remotion.png`), encodePng(rem));
					expect(Tolerance.accepts(PARITY, diff), `${scene.name}: ${formatDiff(diff)}`).toBe(true);
				}
				if (rendered.length === 2) {
					const difference = diffImages(rendered[0]!, rendered[1]!);
					expect(difference.maxAbs, formatDiff(difference)).toBeGreaterThan(64);
				}
			});
	},
);
