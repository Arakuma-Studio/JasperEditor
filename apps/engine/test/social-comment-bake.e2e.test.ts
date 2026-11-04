// social-comment@1 end to end through the engine (REMOTION_E2E=1; design §7.8 and §8 "determinism-render and layer-bake
// e2e … including an emoji-bearing case"): the REAL template — a TikTok comment with word reveal, the like tick and an
// emoji — exported by the hybrid path (its layer baked by Chrome) and by the full Remotion path, with its declared
// assets resolved by the engine like in production: TikTok Sans from the bundled catalogue and the emoji images
// downloaded by the remote-asset service from a local fixture pack (`JASPER_REMOTE_MANIFEST`: never the real CDNs).
// Both exports must agree (≤ 3/255 on 99 % of the pixels, every compared frame), draw the pack's images, and a still
// must equal the export frame.
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import { applyTransaction, defaultRegistries } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, JSON_H, tempAppdir } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const W = 1280;
const H = 720;
const FRAMES = 60;

/** A solid-colour PNG (the fixture emoji pack's image: pure orange, easy to count). */
function png(size: number, hex: string): Buffer {
	const r = spawnSync(
		'ffmpeg',
		[
			'-v',
			'error',
			'-f',
			'lavfi',
			'-i',
			`color=c=0x${hex}:s=${size}x${size}`,
			'-frames:v',
			'1',
			'-f',
			'image2pipe',
			'-vcodec',
			'png',
			'-',
		],
		{ maxBuffer: 1 << 24 },
	);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	return r.stdout;
}

function decode(file: string, frame?: number): Buffer {
	const r = spawnSync(
		'ffmpeg',
		[
			'-v',
			'error',
			'-i',
			file,
			...(frame !== undefined ? ['-vf', `select=eq(n\\,${frame})`, '-frames:v', '1'] : ['-frames:v', '1']),
			'-pix_fmt',
			'rgb24',
			'-f',
			'rawvideo',
			'pipe:1',
		],
		{ maxBuffer: 1 << 28 },
	);
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	return r.stdout;
}

const within = (a: Buffer, b: Buffer, tol: number) => {
	expect(a.length).toBe(b.length);
	let n = 0;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) <= tol) n++;
	return n / a.length;
};
const orange = (raw: Buffer) => {
	let n = 0;
	for (let i = 0; i < raw.length; i += 3)
		if (raw[i]! > 230 && raw[i + 1]! > 110 && raw[i + 1]! < 150 && raw[i + 2]! < 30) n++;
	return n;
};

describe.runIf(enabled)(
	'social-comment@1 through the engine (REMOTION_E2E=1)',
	{ timeout: 1_800_000 },
	() => {
		let engine: RunningEngine;
		let server: Server;
		const requested: string[] = [];
		const hostH = () => ({ host: `127.0.0.1:${engine.port}` });

		beforeAll(async () => {
			const image = png(160, 'ff8000');
			server = createServer((req, res) => {
				const path = (req.url ?? '/').split('?')[0]!;
				requested.push(path);
				if (/^\/emoji\/[0-9a-f-]+\.png$/.test(path))
					return void res.writeHead(200, { 'Content-Type': 'image/png' }).end(image);
				res.writeHead(404).end();
			});
			await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const appdir = tempAppdir('jasper-social-e2e-');
			const manifest = join(appdir, 'fixture-manifest.json');
			writeFileSync(
				manifest,
				JSON.stringify({
					version: 1,
					fonts: [],
					images: [],
					emojiPacks: [
						{
							id: 'apple',
							name: 'Fixture pack',
							version: 'fixture-1',
							urlTemplate: `${base}/emoji/{cp}.png`,
							fe0f: 'keep',
							format: 'png',
							pixelSize: 160,
							licence: 'test fixture (generated solid colour)',
							attribution: null,
						},
					],
				}),
			);
			engine = await startEngine({
				appdir,
				port: 0,
				insecure: true,
				dev: true,
				env: {
					PATH: process.env.PATH,
					JASPER_REMOTE_MANIFEST: manifest,
					...(process.env.JASPER_BROWSER_EXECUTABLE
						? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
						: {}),
				},
			});
		}, 600_000);
		afterAll(async () => {
			await engine?.stop();
			server?.close();
		});

		const queue = () => coreServices(engine.app).queue;
		const children = (id: string) =>
			queue()
				.list({})
				.filter((j) => j.parentId === id);
		const wait = (id: string): Promise<EngineJob> => queue().wait(id);

		/** The real social-comment@1: a TikTok comment over a grey background, every extra on, an emoji in the text. */
		function doc(): DocBuilder {
			const d = new DocBuilder('hd-720p-30');
			const { document, result } = applyTransaction(
				d.doc,
				{
					label: 'comment',
					origin: 'user',
					sequenceId: d.seqId,
					commands: [
						{
							type: 'sequence.updateSettings',
							sequenceId: d.seqId,
							settings: { backgroundColor: [0.3, 0.32, 0.35, 1] },
						},
						{
							type: 'clip.addMotionGraphic',
							at: 0,
							duration: FRAMES,
							track: 'V1',
							template: { id: 'social-comment', version: 1 },
							params: {
								variant: 'tiktok-comment',
								displayName: 'Luna Park',
								text: 'This is ==so good== 😊 can you do ||part two||?',
								likes: 12_345,
								entrance: 'drop-bounce',
								wordReveal: true,
								likeTick: true,
							},
						},
					] as never,
				},
				{
					ids: d.ids,
					now: () => '2026-10-25T10:00:00.000Z',
					revision: 0,
					registries: defaultRegistries(mgRegistry),
				},
			);
			if (!result.ok) throw new Error(JSON.stringify(result.errors));
			d.doc = document;
			d.revision = result.revision;
			return d;
		}

		const settings = (seqId: string, engineName: 'auto' | 'remotion') => ({
			sequenceId: seqId,
			range: { type: 'entire' },
			container: 'mov',
			engine: engineName,
			video: {
				codec: 'prores',
				proresProfile: '4444',
				width: W,
				height: H,
				frameRate: { num: 30, den: 1 },
				scaling: 'fit',
				quality: { mode: 'crf', value: 10 },
				encoderSpeed: 'fast',
			},
		});

		async function exportDoc(d: DocBuilder, engineName: 'auto' | 'remotion') {
			const body = { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, engineName) };
			const plan = (
				await engine.app.inject({
					method: 'POST',
					url: '/api/exports/plan',
					headers: { ...JSON_H, ...hostH() },
					payload: body,
				})
			).json();
			const r = await engine.app.inject({
				method: 'POST',
				url: '/api/exports',
				headers: { ...JSON_H, ...hostH() },
				payload: body,
			});
			expect(r.statusCode, r.body).toBeLessThan(300);
			const done = await wait(r.json().id);
			const out = join(coreServices(engine.app).config.paths.rendersDir, done.id, 'output.mov');
			return { plan, done, out, bakes: children(done.id).filter((j) => j.kind === 'layer-bake') };
		}

		it('TikTok Sans resolves from the bundled catalogue (never a fallback)', () => {
			const fonts = coreServices(engine.app).fonts;
			for (const weight of [500, 600]) {
				const face = fonts.resolve('TikTok Sans', weight, false);
				expect(face, `TikTok Sans ${weight}`).toBeTruthy();
				expect(face!.fallback ?? false).toBe(false);
			}
		});

		it('hybrid (baked) and full Remotion exports agree, draw the pack emoji, and a still equals its export frame', async () => {
			const d = doc();
			const hybrid = await exportDoc(d, 'auto');
			expect(hybrid.done.state, JSON.stringify(hybrid.done.error)).toBe('succeeded');
			expect(hybrid.plan.blockers ?? []).toEqual([]);
			expect(hybrid.bakes.length).toBeGreaterThan(0);
			// the emoji came from the fixture pack through the remote-asset service (U+1F60A)
			expect(requested).toContain('/emoji/1f60a.png');
			const full = await exportDoc(d, 'remotion');
			expect(full.done.state, JSON.stringify(full.done.error)).toBe('succeeded');
			const shares: number[] = [];
			for (const f of [0, 8, 16, 24, 32, 45, FRAMES - 1]) {
				const a = decode(hybrid.out, f);
				shares.push(within(a, decode(full.out, f), 3));
			}
			const line = `[social-comment e2e] hybrid vs Remotion, share within 3/255 per frame: ${JSON.stringify(shares)}`;
			console.info(line);
			// Vitest hides the console of passing tests: the measurement also goes to <tmp>/social-comment-e2e.txt
			appendFileSync(join(tmpdir(), 'social-comment-e2e.txt'), `${line}\n`);
			for (const s of shares) expect(s).toBeGreaterThanOrEqual(0.99);
			// the hold frame shows the orange pack image (≈ 1.2 em × 1.2 em of the 14 px text at the card zoom)
			expect(orange(decode(hybrid.out, 45))).toBeGreaterThan(200);
			// a still of a hold frame is the export's frame
			const r = await engine.app.inject({
				method: 'POST',
				url: '/api/stills',
				headers: { ...JSON_H, ...hostH() },
				payload: { envelope: d.envelope(), sequenceId: d.seqId, frame: 45 },
			});
			const still = await wait(r.json().id);
			expect(still.state, JSON.stringify(still.error)).toBe('succeeded');
			const file = join(coreServices(engine.app).config.paths.rendersDir, still.id, 'output.png');
			expect(within(decode(file), decode(hybrid.out, 45), 3)).toBeGreaterThanOrEqual(0.99);
		});
	},
);
