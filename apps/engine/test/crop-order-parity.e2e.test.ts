// Crop in stack order and Edge Feather: the export paths against the Program preview's renderer (schema v8,
// docs/wp-notes/crop-order.md). Each scene is rendered by the engine's still route (native, or hybrid when a
// browser-only effect sends the layer to the layer bake) and by Remotion (the compositions the Player draws), compared
// per pixel; feathered scenes are also checked against the shared profile (`cropCoverageAt`). REMOTION_E2E=1 requires
// FFmpeg and Chrome (JASPER_BROWSER_EXECUTABLE for a Chrome with HTML-in-Canvas: adjustment layers).
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRenderSnapshot, cropCoverageAt } from '@jasper/project';
import { testResultsDir } from '@jasper/testkit/env';
import { diffImages, formatDiff, Tolerance } from '@jasper/testkit/golden';
import type { Rgba8 } from '@jasper/testkit/image';
import { oraclesAvailable } from '@jasper/testkit/oracle';
import { decodePng, encodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GH, GW, goldenCard, goldenTile } from '../../../packages/compositions/test/golden/scenes.ts';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, JSON_H, register, tempAppdir, until } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1' && oraclesAvailable('ffmpeg', 'ffprobe');
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
	/** Optional analytic oracle of the frame (rgb), compared to both renders within 3/255. */
	oracle?: (x: number, y: number, tile: Rgba8, card: Rgba8) => [number, number, number];
};
const fx = (effectId: string, params: Record<string, unknown> = {}, target = '$t', ref?: string): Cmd => ({
	type: 'effect.add',
	target: { clipId: target },
	effectId,
	params,
	...(ref ? { ref } : {}),
});
const MIRROR = { reflectionCenter: [0.5, 0.5], reflectionAngle: 0 };

/** The tile drawn at 100 % in the frame centre (Motion default) over the card, alpha `a`. */
function overCard(tile: Rgba8, card: Rgba8, x: number, y: number, a: number, tx = x, ty = y) {
	const ox = Math.round((GW - tile.width) / 2);
	const oy = Math.round((GH - tile.height) / 2);
	const ci = (y * card.width + x) * 4;
	const u = tx - ox;
	const v = ty - oy;
	if (u < 0 || v < 0 || u >= tile.width || v >= tile.height) return [0, 1, 2].map((k) => card.data[ci + k]!);
	const ti = (v * tile.width + u) * 4;
	return [0, 1, 2].map((k) => Math.round(card.data[ci + k]! * (1 - a) + tile.data[ti + k]! * a));
}

const SCENES: Scene[] = [
	{ name: 'crop-then-flip', commands: [fx('jasper.crop', { left: 30, top: 10 }), fx('jasper.flip-horizontal')] },
	{ name: 'flip-then-crop', commands: [fx('jasper.flip-horizontal'), fx('jasper.crop', { left: 30, top: 10 })] },
	{
		name: 'feather',
		commands: [fx('jasper.crop', { left: 10, top: 12, right: 15, bottom: 20, feather: 18 })],
		oracle: (x, y, tile, card) => {
			const ox = Math.round((GW - tile.width) / 2);
			const oy = Math.round((GH - tile.height) / 2);
			const k = cropCoverageAt(x - ox + 0.5, y - oy + 0.5, tile.width, tile.height, [0.1, 0.12, 0.15, 0.2], 18);
			return overCard(tile, card, x, y, k) as [number, number, number];
		},
	},
	{
		name: 'feather-then-flip',
		commands: [fx('jasper.crop', { left: 25, bottom: 10, feather: 24 }), fx('jasper.flip-horizontal')],
		oracle: (x, y, tile, card) => {
			const ox = Math.round((GW - tile.width) / 2);
			const oy = Math.round((GH - tile.height) / 2);
			const u = tile.width - 1 - (x - ox);
			const k = cropCoverageAt(u + 0.5, y - oy + 0.5, tile.width, tile.height, [0.25, 0, 0, 0.1], 24);
			return overCard(tile, card, x, y, k, ox + u, y) as [number, number, number];
		},
	},
	{
		name: 'feather-keyframed',
		frame: 15,
		commands: [
			fx('jasper.crop', { left: 20 }, '$t', '$c'),
			{ type: 'keyframe.add', target: ['effect', '$c', 'feather'], at: { sequenceFrame: 0 }, value: 0 },
			{ type: 'keyframe.add', target: ['effect', '$c', 'feather'], at: { sequenceFrame: 30 }, value: 40 },
		],
	},
	{
		name: 'feather-subpixel',
		commands: [
			{ type: 'param.set', target: ['clip', '$t', 'transform', 'scale'], value: 73.3 },
			{ type: 'param.set', target: ['clip', '$t', 'transform', 'rotation'], value: 7 },
			fx('jasper.crop', { left: 10, right: 10, top: 10, bottom: 10, feather: 30 }),
		],
	},
	// Browser-only effects: the export bakes the layer through the compositions (hybrid).
	{ name: 'mirror-then-crop', path: 'hybrid', commands: [fx('jasper.mirror', MIRROR), fx('jasper.crop', { left: 30 })] },
	{ name: 'crop-then-mirror', path: 'hybrid', commands: [fx('jasper.crop', { left: 30 }), fx('jasper.mirror', MIRROR)] },
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
];

describe.runIf(enabled)('Crop order and Edge Feather: export = preview renderer (REMOTION_E2E=1)', {
	timeout: 1_800_000,
}, () => {
	let engine: RunningEngine;
	let card: Awaited<ReturnType<typeof register>>;
	let tile: Awaited<ReturnType<typeof register>>;
	const host = () => ({ host: `127.0.0.1:${engine.port}` });
	const results: Record<string, Rgba8> = {};

	beforeAll(async () => {
		engine = await startEngine({
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
		const dir = mkdtempSync(join(tmpdir(), 'jasper-crop-parity-media-'));
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
		const refs: Record<string, string> = {};
		Object.assign(
			refs,
			d.tx([{ type: 'clip.place', source: { mediaId: c }, at: 0, tracks: { video: 'V1' }, ref: '$bg' }]).refs,
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
		const svc = coreServices(engine.app);
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: { ...JSON_H, ...host() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, frame },
		});
		expect(r.statusCode, r.body).toBeLessThan(300);
		await until(
			() => ['succeeded', 'failed'].includes(svc.queue.get(r.json().id)?.state ?? ''),
			900_000,
			100,
		);
		const done = svc.queue.get(r.json().id)!;
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		return {
			img: decodePng(readFileSync(join(svc.config.paths.rendersDir, done.id, 'output.png'))),
			path: (done.result as { renderPath: string }).renderPath,
		};
	}

	async function remotionStill(d: DocBuilder, frame: number): Promise<Rgba8> {
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
					// Both media are GW × GH stills.
					width: GW,
					height: GH,
					durationFlicks: null,
					hasAudio: false,
					rotation: 0,
				};
			},
		});
		const out = join(mkdtempSync(join(tmpdir(), 'jasper-crop-parity-')), 'remotion.png');
		await svc.remotion.renderStill({
			inputProps: { doc, options: { isPreview: false, useProxies: false, transparentBackground: false } },
			output: out,
			frame,
			signal: new AbortController().signal,
		});
		return decodePng(readFileSync(out));
	}

	function oracleDiff(img: Rgba8, oracle: NonNullable<Scene['oracle']>): { worst: number; bad: number } {
		const t = goldenTile();
		const c = goldenCard();
		let worst = 0;
		let bad = 0;
		for (let y = 0; y < GH; y++)
			for (let x = 0; x < GW; x++) {
				const e = oracle(x, y, t, c);
				const i = (y * GW + x) * 4;
				const d = Math.max(...[0, 1, 2].map((k) => Math.abs(img.data[i + k]! - e[k]!)));
				worst = Math.max(worst, d);
				if (d > 3) bad++;
			}
		return { worst, bad };
	}

	for (const scene of SCENES)
		it(`${scene.name}: export = Remotion`, async () => {
			const d = build(scene);
			const frame = scene.frame ?? 10;
			const exp = await exportStill(d, frame);
			expect(exp.path).toBe(scene.path ?? 'native');
			const rem = await remotionStill(d, frame);
			results[scene.name] = rem;
			const diff = diffImages(exp.img, rem);
			const line = `[crop parity] ${scene.name} (${exp.path}): export vs Remotion ${formatDiff(diff)}`;
			console.info(line);
			mkdirSync(testResultsDir('crop-order'), { recursive: true });
			appendFileSync(join(testResultsDir('crop-order'), 'parity.txt'), `${new Date().toISOString()} ${line}\n`);
			writeFileSync(join(testResultsDir('crop-order'), `${scene.name}.export.png`), encodePng(exp.img));
			writeFileSync(join(testResultsDir('crop-order'), `${scene.name}.remotion.png`), encodePng(rem));
			expect(Tolerance.accepts(PARITY, diff), `${scene.name}: ${formatDiff(diff)}`).toBe(true);
			if (scene.oracle) {
				for (const [who, img] of [
					['export', exp.img],
					['remotion', rem],
				] as const) {
					const o = oracleDiff(img, scene.oracle);
					console.info(`[crop parity] ${scene.name} ${who} vs profile: worst ${o.worst}, ${o.bad} px > 3`);
					expect(o.bad, `${scene.name} ${who} vs the profile (worst ${o.worst})`).toBe(0);
				}
			}
		});

	it('the stack order changes the picture (Crop → X differs from X → Crop)', () => {
		for (const [a, b] of [
			['crop-then-flip', 'flip-then-crop'],
			['mirror-then-crop', 'crop-then-mirror'],
			['crop-then-blur', 'blur-then-crop'],
		] as const) {
			const A = results[a];
			const B = results[b];
			if (!A || !B) throw new Error(`missing renders of ${a} / ${b}`);
			const d = diffImages(A, B);
			expect(d.maxAbs, `${a} vs ${b}: ${formatDiff(d)}`).toBeGreaterThan(64);
		}
	});
});
