// @vitest-environment node
// Sapphire Render family on the Remotion render path (REMOTION_E2E=1): bundles the compositions (production root +
// registry, via fx-render/entry.ts), renders stills of a video clip with S_Zap / S_UltraZap / S_Sparkles and a solid
// with S_Gradient, and checks the pixels: lightning is drawn, re-rendering a frame is identical (deterministic),
// another frame differs (animated), Zap Only is black away from the bolt. `FX_E2E_PHOTO=<jpg>` renders on that photo
// instead of the test video; `FX_E2E_OUT=<dir>` keeps the stills (contact sheets). Needs Chrome + ffmpeg.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

describe.runIf(enabled)(
	'Sapphire Render effects in Remotion renders (REMOTION_E2E=1)',
	{ timeout: 600_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};
		const outDir = process.env.FX_E2E_OUT;

		beforeAll(async () => {
			media = await startFxMedia('fx-srt-');
			if (process.env.FX_E2E_PHOTO)
				execFileSync('ffmpeg', [
					'-v',
					'error',
					'-y',
					'-i',
					process.env.FX_E2E_PHOTO,
					'-vf',
					`scale=${FX_W}:${FX_H}`,
					join(media.dir, 'photo.png'),
				]);
			if (outDir) mkdirSync(outDir, { recursive: true });
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
		}, 600_000);

		afterAll(() => {
			media?.close();
		});

		/** The clip under test: the photo (FX_E2E_PHOTO) as a still, else the 640×360 test video. */
		const clip = (): Command[] =>
			process.env.FX_E2E_PHOTO
				? [
						{
							type: 'media.register',
							ref: '$m',
							asset: fxAsset(media, 'image', 'photo.png', FX_W, FX_H),
						} as unknown as Command,
						{
							type: 'clip.place',
							source: { mediaId: '$m' },
							at: 0,
							tracks: { video: 'V1' },
							ref: '$c',
						} as unknown as Command,
					]
				: fxCmd.video(media, 2);

		async function still(commands: Command[], frame: number, name: string): Promise<Buffer> {
			const inputProps = {
				doc: fxSnapshot(commands),
				options: { isPreview: false, useProxies: false, transparentBackground: false },
			};
			const composition = await renderer.selectComposition({
				serveUrl,
				id: SEQUENCE_COMPOSITION_ID,
				inputProps,
				...browser,
			});
			const output = join(outDir ?? media.dir, `${name}.png`);
			await renderer.renderStill({ composition, serveUrl, inputProps, frame, output, ...browser });
			return execFileSync(
				'ffmpeg',
				['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
				{
					maxBuffer: 1 << 26,
				},
			);
		}
		const maxDiff = (a: Buffer, b: Buffer) => {
			let d = 0;
			for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i]! - b[i]!));
			return d;
		};
		/** Count of near-white pixels (the bolt cores). */
		const whites = (raw: Buffer) => {
			let n = 0;
			for (let i = 0; i < raw.length; i += 3)
				if (raw[i]! > 235 && raw[i + 1]! > 235 && raw[i + 2]! > 235) n++;
			return n;
		};

		it('S_Zap: lightning over the clip, identical on re-render, animated between frames', async () => {
			const fx = (frame: number, name: string) =>
				still([...clip(), fxCmd.effect('jasper.s.zap')], frame, name);
			const plain = await still(clip(), 3, 'plain-f3');
			const a = await fx(3, 'zap-f3');
			const b = await fx(3, 'zap-f3-again');
			const c = await fx(9, 'zap-f9');
			expect(maxDiff(a, b)).toBe(0);
			expect(maxDiff(a, c)).toBeGreaterThan(60);
			expect(whites(a)).toBeGreaterThan(whites(plain) + 150);
		});

		it('S_Zap ▸ Zap Only: black away from the bolt', async () => {
			const raw = await still(
				[...clip(), fxCmd.effect('jasper.s.zap', { combine: 'only' })],
				3,
				'zap-only-f3',
			);
			const at = (x: number, y: number) => raw[(y * FX_W + x) * 3]!;
			expect(at(10, FX_H - 10)).toBeLessThan(30);
		});

		it('S_UltraZap and S_Sparkles render (extra stills for the contact sheet)', async () => {
			const plain = await still(clip(), 6, 'plain-f6');
			const u = await still([...clip(), fxCmd.effect('jasper.s.ultra-zap')], 6, 'ultra-zap-f6');
			const s = await still(
				[...clip(), fxCmd.effect('jasper.s.sparkles', { frequency: 12 })],
				6,
				'sparkles-f6',
			);
			expect(maxDiff(u, plain)).toBeGreaterThan(100);
			expect(maxDiff(s, plain)).toBeGreaterThan(60);
		});

		it('S_Gradient on a solid: white at the top, black at the bottom (Grad Only)', async () => {
			const raw = await still(
				[...fxCmd.solid([0, 0, 1, 1]), fxCmd.effect('jasper.s.gradient')],
				2,
				'gradient-f2',
			);
			const at = (x: number, y: number) => raw[(y * FX_W + x) * 3 + 1]!;
			expect(at(FX_W / 2, 4)).toBeGreaterThan(220);
			expect(at(FX_W / 2, FX_H - 4)).toBeLessThan(30);
		});
	},
);
