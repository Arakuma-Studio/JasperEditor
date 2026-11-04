// Compare native and Remotion stills and committed goldens; generated cards avoid external fixture assets.
// JASPER_BLESS=1 replaces golden images. REMOTION_E2E=1 requires FFmpeg and Chrome.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRenderSnapshot } from '@jasper/project';
import { testResultsDir } from '@jasper/testkit/env';
import { diffImages, expectGolden, formatDiff, Tolerance } from '@jasper/testkit/golden';
import type { Rgba8 } from '@jasper/testkit/image';
import { oraclesAvailable } from '@jasper/testkit/oracle';
import { decodePng, encodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GH, GW, goldenCard, goldenTile } from '../../../packages/compositions/test/golden/scenes.ts';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, JSON_H, register, tempAppdir } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDENS = join(here, 'goldens', 'native');
const enabled = process.env.REMOTION_E2E === '1' && oraclesAvailable('ffmpeg', 'ffprobe');
/**
 * Native (ffmpeg filter graphs, 8-bit) against Remotion (Chrome compositing): filtering, rounding and edge
 * antialiasing differ by a few levels; a feature one path drops or misplaces moves far more.
 */
const PARITY: Tolerance = { minPsnr: 45, maxAbs: 32, p99: 3 };

type Cmd = Record<string, unknown>;
type Scene = { name: string; commands(card: string, tile: string): Cmd[] };
const set = (target: unknown[], value: unknown): Cmd => ({ type: 'param.set', target, value });
const overlay = (tile: string, extra: Cmd[] = []): Cmd[] => [
	{ type: 'track.add', kind: 'video', count: 1 },
	{ type: 'clip.place', source: { mediaId: tile }, at: 0, tracks: { video: 'V2' }, ref: '$t' },
	...extra,
];

const SCENES: Scene[] = [
	{
		name: 'transform-opacity',
		commands: (_c, tile) =>
			overlay(tile, [
				set(['clip', '$t', 'transform', 'scale'], 55),
				set(['clip', '$t', 'transform', 'rotation'], 25),
				set(['clip', '$t', 'transform', 'position'], [GW * 0.6, GH * 0.55]),
				set(['clip', '$t', 'opacity'], 65),
			]),
	},
	{
		name: 'crop',
		commands: (_c, tile) =>
			overlay(tile, [
				{ type: 'effect.add', target: { clipId: '$t' }, effectId: 'jasper.crop', ref: '$c' },
				set(['effect', '$c', 'left'], 12),
				set(['effect', '$c', 'right'], 20),
				set(['effect', '$c', 'top'], 10),
				set(['effect', '$c', 'bottom'], 25),
			]),
	},
	{
		name: 'blend-screen',
		commands: (_c, tile) =>
			overlay(tile, [
				set(['clip', '$t', 'transform', 'scale'], 60),
				{ type: 'clip.update', clipId: '$t', patch: { blendMode: 'screen' } },
			]),
	},
	{
		name: 'blend-linear-burn',
		commands: (_c, tile) =>
			overlay(tile, [
				set(['clip', '$t', 'transform', 'scale'], 60),
				set(['clip', '$t', 'opacity'], 80),
				{ type: 'clip.update', clipId: '$t', patch: { blendMode: 'linear-burn' } },
			]),
	},
	{
		name: 'colour-run',
		commands: () => [
			{ type: 'effect.add', target: { clipId: '$bg' }, effectId: 'jasper.brightness-contrast', ref: '$b' },
			set(['effect', '$b', 'brightness'], 15),
			set(['effect', '$b', 'contrast'], 30),
			{ type: 'effect.add', target: { clipId: '$bg' }, effectId: 'jasper.hue-saturation', ref: '$h' },
			set(['effect', '$h', 'hue'], 60),
			set(['effect', '$h', 'saturation'], -30),
		],
	},
];

describe.runIf(enabled)('native vs Remotion on golden scenes (REMOTION_E2E=1)', { timeout: 900_000 }, () => {
	let engine: RunningEngine;
	let card: Awaited<ReturnType<typeof register>>;
	let tile: Awaited<ReturnType<typeof register>>;
	const host = () => ({ host: `127.0.0.1:${engine.port}` });

	beforeAll(async () => {
		engine = await startEngine({
			appdir: tempAppdir('jasper-golden-parity-'),
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
		const dir = mkdtempSync(join(tmpdir(), 'jasper-golden-parity-media-'));
		writeFileSync(join(dir, 'card.png'), encodePng(goldenCard()));
		writeFileSync(join(dir, 'tile.png'), encodePng(goldenTile()));
		card = await register(engine.app, join(dir, 'card.png'), host());
		tile = await register(engine.app, join(dir, 'tile.png'), host());
	}, 900_000);
	afterAll(async () => {
		await engine?.stop();
	});

	function build(scene: Scene): DocBuilder {
		const d = new DocBuilder();
		d.tx([{ type: 'sequence.updateSettings', settings: { width: GW, height: GH } }]);
		const c = d.addMedia(card);
		const t = d.addMedia(tile);
		const r = d.tx([
			{ type: 'clip.place', source: { mediaId: c }, at: 0, tracks: { video: 'V1' }, ref: '$bg' },
		]);
		const sub = (v: unknown): unknown =>
			v === '$bg'
				? r.refs.$bg
				: Array.isArray(v)
					? v.map(sub)
					: v && typeof v === 'object'
						? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]))
						: v;
		d.tx(scene.commands(c, t).map((x) => sub(x)) as unknown[]);
		return d;
	}

	async function nativeStill(d: DocBuilder): Promise<Rgba8> {
		const svc = coreServices(engine.app);
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: { ...JSON_H, ...host() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, frame: 10 },
		});
		expect(r.statusCode, r.body).toBeLessThan(300);
		const done = await svc.queue.wait(r.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		expect(done.result, 'the scene must render on the native path').toMatchObject({ renderPath: 'native' });
		return decodePng(readFileSync(join(svc.config.paths.rendersDir, done.id, 'output.png')));
	}

	async function remotionStill(d: DocBuilder): Promise<Rgba8> {
		const svc = coreServices(engine.app);
		const doc = buildRenderSnapshot(d.doc, d.seqId, {
			resolveFont: () => null,
			resolveMedia: (asset) => {
				const key = asset.locators.find((locator) => locator.type === 'engine-store')?.key;
				if (!key) throw new Error(`Missing engine-store locator for ${asset.id}`);
				return {
					url: svc.signer.signUrl(`http://127.0.0.1:${engine.port}`, `/media/${encodeURIComponent(key)}`),
					proxyUrl: null,
					kind: asset.kind,
					width: GW,
					height: GH,
					durationFlicks: null,
					hasAudio: false,
					rotation: 0,
				};
			},
		});
		const out = join(mkdtempSync(join(tmpdir(), 'jasper-golden-parity-')), 'remotion.png');
		await svc.remotion.renderStill({
			inputProps: {
				doc,
				options: { isPreview: false, useProxies: false, transparentBackground: false },
			},
			output: out,
			frame: 10,
			signal: new AbortController().signal,
		});
		return decodePng(readFileSync(out));
	}

	for (const scene of SCENES)
		it(`${scene.name}: native = Remotion, native = golden`, async () => {
			const d = build(scene);
			const native = await nativeStill(d);
			const remotion = await remotionStill(d);
			expect([native.width, native.height]).toEqual([GW, GH]);
			const diff = diffImages(native, remotion);
			const line = `[golden parity] ${scene.name}: native vs Remotion ${formatDiff(diff)}`;
			console.info(line);
			mkdirSync(testResultsDir('golden'), { recursive: true });
			appendFileSync(join(testResultsDir('golden'), 'parity.txt'), `${new Date().toISOString()} ${line}\n`);
			expect(Tolerance.accepts(PARITY, diff), `${scene.name}: ${formatDiff(diff)}`).toBe(true);
			expectGolden(join(GOLDENS, `${scene.name}.png`), native, Tolerance.RENDER);
		});
});
