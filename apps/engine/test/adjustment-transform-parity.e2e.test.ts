// Transform and S_Shake (with colour effects: Tint, Hue/Saturation, Black & White) on adjustment layers: the native path
// (blend/adjust.ts) against the Program preview's renderer. Each scene is rendered by the engine's still route (it
// must plan `native`) and by Remotion (the compositions the Player draws: the adjustment scope's canvas chain runs the
// shaders and colour runs on the composite below), compared per pixel.
// REMOTION_E2E=1 requires FFmpeg and a Chrome with HTML-in-Canvas (JASPER_BROWSER_EXECUTABLE).
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
/** As golden-parity: 8-bit graphs and our kernel vs Chrome's GL sampling differ by a few levels. */
const PARITY: Tolerance = { minPsnr: 45, maxAbs: 32, p99: 3 };
/**
 * Where the Transform draws the composite's edge inside the frame (rotation, zoom out), the shader's hard box test and
 * the kernel's ½ px coverage ramp (the lowered layers' documented difference, docs/wp-notes/auto-subtitles.md) differ
 * on the pixels the edge crosses: those pixels (`edge`) are left out of the comparison (their count and the
 * all-pixel figures are logged), every other pixel must be within PARITY.
 */
type Pose = { anchor: [number, number]; position: [number, number]; scale: number; rotation: number };

type Cmd = Record<string, unknown>;
type Scene = { name: string; frame: number; tolerance: Tolerance; commands: Cmd[]; edge?: Pose };
const TF = (params: Record<string, unknown>): Cmd => ({
	type: 'effect.add',
	target: { clipId: '$a' },
	effectId: 'jasper.transform',
	params,
	ref: '$tf',
});
const key = (param: string, frame: number, value: unknown): Cmd => ({
	type: 'keyframe.add',
	target: ['effect', '$tf', param],
	at: { sequenceFrame: frame },
	value,
	interpolation: 'linear',
});
const POSE: Pose = { anchor: [0.6, 0.4], position: [0.5, 0.55], scale: 150, rotation: 8 };
const STATIC = TF({
	anchorPoint: POSE.anchor,
	position: POSE.position,
	scaleHeight: POSE.scale,
	rotation: POSE.rotation,
});
const ZOOM_OUT: Pose = { anchor: [0.5, 0.5], position: [0.45, 0.5], scale: 70, rotation: -12 };
const BLURRED = { useCompShutterAngle: false, shutterAngle: 360 };
const FX = (effectId: string, params: Record<string, unknown>, ref: string): Cmd => ({
	type: 'effect.add',
	target: { clipId: '$a' },
	effectId,
	params,
	ref,
});
const fxKey = (ref: string, param: string, frame: number, value: unknown): Cmd => ({
	type: 'keyframe.add',
	target: ['effect', ref, param],
	at: { sequenceFrame: frame },
	value,
	interpolation: 'linear',
});
/** S19's "edgy shake" (ASSEMBLY_S9_S23): fast, low amplitude, Reflect wrap. */
const S19_SHAKE = {
	amplitude: 0.4,
	frequency: 30,
	xRandAmp: 0.052,
	yRandAmp: 0.052,
	tiltRandAmp: 0.1,
	seed: 0,
	motionBlur: false,
	wrapX: 'reflect',
	wrapY: 'reflect',
};
/** A strong shake (tens of px of move, a degree of tilt): wide reflections at the frame edges. */
const STRONG_SHAKE = {
	...S19_SHAKE,
	amplitude: 3,
	frequency: 4,
	xRandAmp: 0.3,
	yRandAmp: 0.3,
	tiltRandAmp: 1,
};

const SCENES: Scene[] = [
	{ name: 'static', frame: 10, tolerance: PARITY, edge: POSE, commands: [STATIC] },
	{
		name: 'opacity-crop-after',
		frame: 10,
		tolerance: PARITY,
		edge: POSE,
		commands: [
			STATIC,
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.crop', params: { right: 25 } },
			{ type: 'param.set', target: ['clip', '$a', 'opacity'], value: 70 },
		],
	},
	{
		name: 'zoom-out',
		frame: 10,
		tolerance: PARITY,
		edge: ZOOM_OUT,
		commands: [TF({ scaleHeight: ZOOM_OUT.scale, rotation: ZOOM_OUT.rotation, position: ZOOM_OUT.position })],
	},
	{
		name: 'blend-screen',
		frame: 10,
		tolerance: PARITY,
		edge: POSE,
		commands: [STATIC, { type: 'clip.update', clipId: '$a', patch: { blendMode: 'screen' } }],
	},
	{
		name: 'keyframed-blur',
		frame: 6,
		tolerance: PARITY,
		commands: [
			TF({ anchorPoint: [0.62, 0.32], position: [0.62, 0.32], ...BLURRED }),
			key('scaleHeight', 0, 100),
			key('scaleHeight', 12, 190),
			key('position', 0, [0.62, 0.32]),
			key('position', 12, [0.5, 0.5]),
		],
	},
	{
		// The S5 punch-in's shape (100 → 180 % in 7 frames, then slower): many taps on the first frames.
		name: 'punch-in-blur',
		frame: 3,
		tolerance: PARITY,
		commands: [
			TF({ anchorPoint: [0.79, 0.52], position: [0.79, 0.52], ...BLURRED }),
			key('scaleHeight', 0, 100),
			key('scaleHeight', 7, 180),
			key('scaleHeight', 29, 215),
			key('position', 0, [0.79, 0.52]),
			key('position', 7, [0.66, 0.5]),
		],
	},
	{
		// 100 → 400 % in 3 frames: more travel than the shutter's taps (capped: the shader jitters its taps per pixel,
		// the kernel takes the strata centres).
		name: 'capped-blur',
		frame: 1,
		tolerance: PARITY,
		commands: [
			TF({ anchorPoint: [0.62, 0.32], position: [0.62, 0.32], ...BLURRED }),
			key('scaleHeight', 0, 100),
			key('scaleHeight', 3, 400),
		],
	},
	// S_Shake and colour effects (Tint, Hue/Saturation, Black & White) on adjustment layers.
	{
		name: 's19-shake-tint',
		frame: 15,
		tolerance: PARITY,
		commands: [
			FX('jasper.s.shake', S19_SHAKE, '$sh'),
			FX('jasper.tint', { amountToTint: 0 }, '$ti'),
			fxKey('$ti', 'amountToTint', 0, 0),
			fxKey('$ti', 'amountToTint', 29, 100),
		],
	},
	{
		name: 'shake-reflect-strong',
		frame: 7,
		tolerance: PARITY,
		commands: [FX('jasper.s.shake', STRONG_SHAKE, '$sh')],
	},
	{
		name: 'shake-no-wrap',
		frame: 7,
		tolerance: PARITY,
		commands: [FX('jasper.s.shake', { ...STRONG_SHAKE, wrapX: 'no', wrapY: 'no' }, '$sh')],
	},
	{
		name: 'tint-keyframed-colours',
		frame: 10,
		tolerance: PARITY,
		commands: [
			FX(
				'jasper.tint',
				{ mapBlackTo: [0.1, 0.05, 0.3, 1], mapWhiteTo: [1, 0.9, 0.6, 1], amountToTint: 0 },
				'$ti',
			),
			fxKey('$ti', 'amountToTint', 0, 0),
			fxKey('$ti', 'amountToTint', 20, 100),
		],
	},
	{
		name: 'shake-zoom-desaturate',
		frame: 12,
		tolerance: PARITY,
		commands: [
			FX('jasper.s.shake', { ...STRONG_SHAKE, amplitude: 1, wrapX: 'no', wrapY: 'no' }, '$sh'),
			TF({ scaleHeight: 130 }),
			FX('jasper.hue-saturation', { saturation: -60 }, '$hs'),
		],
	},
	{
		name: 'shake-black-white-opacity',
		frame: 12,
		tolerance: PARITY,
		commands: [
			FX('jasper.s.shake', STRONG_SHAKE, '$sh'),
			FX('jasper.black-white', { amount: 0 }, '$bw'),
			fxKey('$bw', 'amount', 0, 0),
			fxKey('$bw', 'amount', 24, 100),
			{ type: 'param.set', target: ['clip', '$a', 'opacity'], value: 80 },
		],
	},
];

/**
 * The pixels the Transform's picture edge crosses: the output pixel centre maps back (src = anchor + (R·S)⁻¹ · (out −
 * position)) to within one output pixel of the composite's border.
 */
function edgePixels(pose: Pose, W: number, H: number): boolean[] {
	const s = pose.scale / 100;
	const t = (pose.rotation * Math.PI) / 180;
	const out: boolean[] = [];
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const dx = x + 0.5 - pose.position[0] * W;
			const dy = y + 0.5 - pose.position[1] * H;
			const u = pose.anchor[0] * W + (Math.cos(t) * dx + Math.sin(t) * dy) / s;
			const v = pose.anchor[1] * H + (-Math.sin(t) * dx + Math.cos(t) * dy) / s;
			out.push(Math.min(Math.abs(u), Math.abs(W - u), Math.abs(v), Math.abs(H - v)) * s < 1);
		}
	return out;
}

/** Copies `from`'s pixels into `img` where `mask` is set. */
function withPixels(img: Rgba8, from: Rgba8, mask: readonly boolean[]): Rgba8 {
	const data = img.data.slice();
	mask.forEach((m, i) => {
		if (m) data.set(from.data.subarray(i * 4, i * 4 + 4), i * 4);
	});
	return { ...img, data };
}

/**
 * A frame as an export delivers it: over black, opaque. The native still is opaque already; Remotion leaves what a
 * zoomed-out Transform uncovers transparent, which every video encode of that path turns into black.
 */
function onBlack(img: Rgba8): Rgba8 {
	const data = new Uint8Array(img.data.length);
	for (let i = 0; i < data.length; i += 4) {
		const a = img.data[i + 3]!;
		for (let k = 0; k < 3; k++) data[i + k] = Math.round((img.data[i + k]! * a) / 255);
		data[i + 3] = 255;
	}
	return { ...img, data };
}

describe.runIf(enabled)(
	'Transform on adjustment layers: native export = preview renderer (REMOTION_E2E=1)',
	{ timeout: 1_800_000 },
	() => {
		let engine: RunningEngine;
		let browser: import('../src/remotion/service.ts').SharedRenderBrowser;
		let card: Awaited<ReturnType<typeof register>>;
		let tile: Awaited<ReturnType<typeof register>>;
		const host = () => ({ host: `127.0.0.1:${engine.port}` });

		beforeAll(async () => {
			engine = await engineApi.startEngine({
				appdir: tempAppdir('jasper-adj-tf-parity-'),
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
			const dir = tempAppdir('jasper-adj-tf-parity-media-');
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

		/** The card on V1, the tile at 60 % on V2 (a composite of two layers), the adjustment layer on V3 (frames 0–30). */
		function build(scene: Scene): DocBuilder {
			const d = new helpers.DocBuilder();
			d.tx([{ type: 'sequence.updateSettings', settings: { width: golden.GW, height: golden.GH } }]);
			const c = d.addMedia(card);
			const t = d.addMedia(tile);
			d.tx([
				{ type: 'clip.place', source: { mediaId: c }, at: 0, tracks: { video: 'V1' } },
				{ type: 'track.add', kind: 'video', count: 2 },
				{ type: 'clip.place', source: { mediaId: t }, at: 0, tracks: { video: 'V2' }, ref: '$t' },
				{ type: 'param.set', target: ['clip', '$t', 'transform', 'scale'], value: 60 },
				{ type: 'param.set', target: ['clip', '$t', 'transform', 'position'], value: [90, 60] },
				{ type: 'clip.addAdjustment', at: 0, duration: 30, track: 'V3', ref: '$a' },
				...scene.commands,
			]);
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
					const k = asset.locators.find((locator) => locator.type === 'engine-store')?.key;
					if (!k) throw new Error(`Missing engine-store locator for ${asset.id}`);
					return {
						url: svc.signer.signUrl(`http://127.0.0.1:${engine.port}`, `/media/${encodeURIComponent(k)}`),
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
			const out = join(tempAppdir('jasper-adj-tf-parity-'), 'remotion.png');
			await svc.remotion.renderStill({
				inputProps: { doc, options: { isPreview: false, useProxies: false, transparentBackground: false } },
				output: out,
				frame,
				signal: new AbortController().signal,
				browser,
			});
			return decodePng(readFileSync(out));
		}

		for (const scene of SCENES)
			it(`${scene.name}: export = Remotion`, async () => {
				const d = build(scene);
				const exp = await exportStill(d, scene.frame);
				expect(exp.path).toBe('native');
				const rem = onBlack(await remotionStill(d, scene.frame));
				const got = onBlack(exp.img);
				const edge = scene.edge ? edgePixels(scene.edge, golden.GW, golden.GH) : null;
				const diff = diffImages(edge ? withPixels(got, rem, edge) : got, rem);
				const all = diffImages(got, rem);
				const line = `[adjustment transform parity] ${scene.name} (${exp.path}): export vs Remotion ${formatDiff(diff)}${edge ? ` off the picture edge; ${edge.filter(Boolean).length} edge pixels, all pixels ${formatDiff(all)}` : ''}`;
				console.info(line);
				const dir = testResultsDir('adjustment-transform');
				mkdirSync(dir, { recursive: true });
				appendFileSync(join(dir, 'parity.txt'), `${new Date().toISOString()} ${line}\n`);
				writeFileSync(join(dir, `${scene.name}.export.png`), encodePng(exp.img));
				writeFileSync(join(dir, `${scene.name}.remotion.png`), encodePng(rem));
				expect(Tolerance.accepts(scene.tolerance, diff), `${scene.name}: ${formatDiff(diff)}`).toBe(true);
			});
	},
);
