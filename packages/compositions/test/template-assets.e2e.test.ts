// @vitest-environment node
// social-comment §7.8 in real Remotion renders (REMOTION_E2E=1): a template that declares a font and emoji (the test-only
// asset probe, added to the bundle by module aliases) renders deterministically — renderStill per frame equals
// renderFrames at concurrency 1 and 3, byte for byte — draws the emoji images and the declared font (another font
// file changes the glyphs), and fails the render instead of substituting when the font or an emoji is unavailable.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMgRegistry, emojiKey, MG_CATALOG, templateAssetOptions } from '@jasper/mg-templates';
import {
	applyTransaction,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type RenderSnapshot,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { PROBE_DEF } from './template-assets-e2e/probe-def.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
const W = 640;
const H = 360;
const FRAMES = 30;
const INTER = join(here, '../../../native/mg/crates/jasper-mg-templates/media');
const registry = createMgRegistry([...MG_CATALOG, PROBE_DEF]);

/** A solid-colour RGBA PNG (the fixture "emoji pack" image). */
function png(size: number, rgba: [number, number, number, number]): Buffer {
	const dir = mkdtempSync(join(tmpdir(), 'probe-png-'));
	const out = join(dir, 'e.png');
	const hex = rgba
		.slice(0, 3)
		.map((v) => v.toString(16).padStart(2, '0'))
		.join('');
	execFileSync('ffmpeg', [
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		`color=c=0x${hex}:s=${size}x${size}`,
		'-frames:v',
		'1',
		out,
	]);
	return readFileSync(out);
}

function snapshotOf(base: string, o: { font?: string; emoji?: boolean } = {}): RenderSnapshot {
	const ids = createCounterIdSource(1);
	const project = createEmptyProject({ ids, name: 'assets', preset: 'hd-720p-30' });
	const seqId = Object.keys(project.sequences)[0]!;
	const { document, result } = applyTransaction(
		project,
		{
			label: 'probe',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'sequence.updateSettings', sequenceId: seqId, settings: { width: W, height: H } } as Command,
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration: FRAMES,
					track: 'V1',
					template: { id: 'asset-probe', version: 1 },
					params: { title: 'Ag \u{1F600}' },
				} as unknown as Command,
			],
		},
		{ ids, now: () => '2026-10-25T10:00:00.000Z', revision: 0, registries: defaultRegistries(registry) },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return buildRenderSnapshot(document, seqId, {
		resolveMedia: () => null,
		resolveFont: () => null,
		templateAssets: templateAssetOptions(registry, {
			font: () => `${base}/${o.font ?? 'bold.ttf'}`,
			emoji: (_pack, g) => (o.emoji === false ? null : `${base}/emoji/${emojiKey(g)}.png`),
		}),
	});
}

describe.runIf(enabled)(
	'template fonts and emoji in Remotion renders (REMOTION_E2E=1)',
	{ timeout: 900_000 },
	() => {
		let server: Server;
		let base = '';
		let serveUrl = '';
		let renderer: typeof import('@remotion/renderer');
		const work = enabled ? mkdtempSync(join(tmpdir(), 'jasper-template-assets-')) : '';
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};

		beforeAll(async () => {
			const files: Record<string, { type: string; body: Buffer }> = {
				'bold.ttf': { type: 'font/ttf', body: readFileSync(join(INTER, 'Inter_24pt-Bold.ttf')) },
				'regular.ttf': { type: 'font/ttf', body: readFileSync(join(INTER, 'Inter_24pt-Regular.ttf')) },
				'emoji/1f600.png': { type: 'image/png', body: png(72, [255, 0, 0, 255]) },
			};
			server = createServer((req, res) => {
				const f = files[(req.url ?? '/').split('?')[0]!.slice(1)];
				if (!f) return void res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }).end();
				res.writeHead(200, { 'Content-Type': f.type, 'Access-Control-Allow-Origin': '*' }).end(f.body);
			});
			await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
			base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({
				entryPoint: join(here, 'template-assets-e2e', 'entry.ts'),
				webpackOverride: (config) => ({
					...config,
					resolve: {
						...config.resolve,
						alias: {
							...(config.resolve?.alias as Record<string, string> | undefined),
							'@jasper/mg-templates$': join(here, 'template-assets-e2e', 'mg-templates.ts'),
							'@jasper/motion/templates$': join(here, 'template-assets-e2e', 'motion-templates.tsx'),
						},
					},
				}),
			});
			renderer = await import('@remotion/renderer');
			console.info(`[template-assets] artifacts in ${work}`);
		}, 600_000);
		afterAll(() => server?.close());

		const props = (doc: RenderSnapshot) => ({
			doc,
			options: { isPreview: false, useProxies: false, transparentBackground: false },
		});
		const select = (doc: RenderSnapshot) =>
			renderer.selectComposition({
				serveUrl,
				id: SEQUENCE_COMPOSITION_ID,
				inputProps: props(doc),
				...browser,
			});

		async function still(doc: RenderSnapshot, frame: number): Promise<Buffer> {
			const composition = await select(doc);
			const { buffer } = await renderer.renderStill({
				composition,
				serveUrl,
				inputProps: props(doc),
				frame,
				imageFormat: 'png',
				output: null,
				...browser,
			});
			return buffer!;
		}

		async function frames(doc: RenderSnapshot, concurrency: number): Promise<Buffer[]> {
			const composition = await select(doc);
			const out: Buffer[] = [];
			await renderer.renderFrames({
				composition,
				serveUrl,
				inputProps: props(doc),
				outputDir: null,
				imageFormat: 'png',
				concurrency,
				onStart: () => {},
				onFrameUpdate: () => {},
				onFrameBuffer: (b: Buffer, f: number) => {
					out[f] = b;
				},
				...browser,
			});
			return out;
		}

		const rgb = (pngBytes: Buffer): Buffer =>
			execFileSync(
				'ffmpeg',
				['-v', 'error', '-f', 'png_pipe', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
				{
					input: pngBytes,
					maxBuffer: 1 << 26,
				},
			);
		const count = (raw: Buffer, pred: (r: number, g: number, b: number) => boolean) => {
			let n = 0;
			for (let i = 0; i < raw.length; i += 3) if (pred(raw[i]!, raw[i + 1]!, raw[i + 2]!)) n++;
			return n;
		};

		it('renders deterministically with the declared font and the emoji images', async () => {
			const doc = snapshotOf(base);
			expect(doc.fonts).toEqual([
				expect.objectContaining({ fontId: 'template:Probe Sans', weight: 700, url: `${base}/bold.ttf` }),
			]);
			const pick = [0, 7, 15, 29];
			const stills: Buffer[] = [];
			for (const f of pick) {
				stills.push(await still(doc, f));
				writeFileSync(join(work, `still-${f}.png`), stills.at(-1)!);
			}
			const c1 = await frames(doc, 1);
			const c3 = await frames(doc, 3);
			const differ = pick.filter((f, i) => !c1[f]!.equals(stills[i]!) || !c3[f]!.equals(stills[i]!));
			expect(differ).toEqual([]);
			expect(stills[0]!.equals(stills[3]!)).toBe(false);
			// the emoji: a 96 px red square (pack image scaled), the text: black glyphs
			const raw = rgb(stills[1]!);
			const red = count(raw, (r, g, b) => r > 200 && g < 60 && b < 60);
			expect(red).toBeGreaterThan(80 * 80);
			const ink = count(raw, (r, g, b) => r < 60 && g < 60 && b < 60);
			expect(ink).toBeGreaterThan(500);
			// another file for the same declared face changes the glyphs: the template draws with the declared font
			const regular = rgb(await still(snapshotOf(base, { font: 'regular.ttf' }), 7));
			const inkRegular = count(regular, (r, g, b) => r < 60 && g < 60 && b < 60);
			console.info(`[template-assets] ink bold ${ink} px, regular ${inkRegular} px, emoji ${red} px`);
			expect(Math.abs(ink - inkRegular) / ink).toBeGreaterThan(0.1);
		});

		it('fails the render instead of substituting a missing font or emoji', async () => {
			await expect(still(snapshotOf(base, { emoji: false }), 5)).rejects.toThrow(/not available/);
			await expect(still(snapshotOf(base, { font: 'missing.ttf' }), 5)).rejects.toThrow(/not available/);
		});
	},
);
