// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

const ALL = [
	'auto-paint',
	'sketch',
	'etching',
	'brush-oil',
	'brush-chalk',
	'crosshatch',
	'cartoon',
	'cartoon-paint',
	'posterize',
	'half-tone',
	'half-tone-color',
	'half-tone-rings',
	'kaleido-triangles',
	'kaleido-squares',
	'kaleido-diamonds',
	'kaleido-oct',
	'kaleido-polar',
	'kaleido-radial',
	'flys-eye-circles',
	'flys-eye-hex',
	'flys-eye-rect',
	'tile-scramble',
	'edge-detect',
	'edge-detect-double',
	'edges-in-direction',
	'edge-colorize',
	'emboss',
	'emboss-shiny',
	'emboss-distort',
	'emboss-glass',
];

describe.runIf(enabled)(
	'sapphire-paint-kaleido-edges in Remotion renders (REMOTION_E2E=1)',
	{ timeout: 600_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};

		beforeAll(async () => {
			media = await startFxMedia('fx-pke-');
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			console.info(`[fx-pke] stills in ${media.dir}`);
		}, 300_000);

		afterAll(() => {
			media?.close();
		});

		async function still(doc: ReturnType<typeof fxSnapshot>, frame: number, output: string): Promise<Buffer> {
			const inputProps = {
				doc,
				options: { isPreview: false, useProxies: false, transparentBackground: false },
			};
			const composition = await renderer.selectComposition({
				serveUrl,
				id: SEQUENCE_COMPOSITION_ID,
				inputProps,
				...browser,
			});
			await renderer.renderStill({ composition, serveUrl, inputProps, frame, output, ...browser });
			return execFileSync(
				'ffmpeg',
				['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
				{
					maxBuffer: 1 << 26,
				},
			);
		}
		const meanDiff = (a: Buffer, b: Buffer) => {
			let d = 0;
			let n = 0;
			for (let i = 0; i < a.length; i += 31) {
				d += Math.abs(a[i]! - b[i]!);
				n++;
			}
			return d / n;
		};

		it('representative effects of each group transform a decoded video frame, deterministically', async () => {
			const plain = await still(fxSnapshot(fxCmd.video(media)), 10, join(media.dir, 'plain.png'));
			for (const id of ['half-tone', 'kaleido-squares', 'edge-detect', 'emboss', 'auto-paint']) {
				const doc = fxSnapshot([...fxCmd.video(media), fxCmd.effect(`jasper.s.${id}`)]);
				const a = await still(doc, 10, join(media.dir, `${id}.png`));
				const b = await still(doc, 10, join(media.dir, `${id}-again.png`));
				expect(meanDiff(a, plain), id).toBeGreaterThan(4);
				expect(meanDiff(a, b), id).toBeLessThan(0.5);
			}
			const id0 = await still(
				fxSnapshot([...fxCmd.video(media), fxCmd.effect('jasper.s.kaleido-squares', { kaleidoAmount: 0 })]),
				10,
				join(media.dir, 'kaleido-0.png'),
			);
			expect(meanDiff(id0, plain)).toBeLessThan(3);
			expect(plain.length).toBe(FX_W * FX_H * 3);
		});

		it.runIf(!!process.env.FX_PKE_IMAGE && !!process.env.FX_PKE_OUT)(
			'renders the whole family on FX_PKE_IMAGE',
			async () => {
				const src = process.env.FX_PKE_IMAGE!;
				const out = process.env.FX_PKE_OUT!;
				mkdirSync(out, { recursive: true });
				const name = basename(src);
				copyFileSync(src, join(media.dir, name));
				const image = (): Command[] => [
					{
						type: 'media.register',
						ref: '$m',
						asset: fxAsset(media, 'image', name, 640, 360),
					} as unknown as Command,
					{
						type: 'clip.place',
						source: { mediaId: '$m' },
						at: 0,
						tracks: { video: 'V1' },
						ref: '$c',
					} as unknown as Command,
				];
				await still(fxSnapshot(image()), 0, join(out, 'original.png'));
				for (const id of ALL)
					await still(fxSnapshot([...image(), fxCmd.effect(`jasper.s.${id}`)]), 0, join(out, `${id}.png`));
			},
		);
	},
);
