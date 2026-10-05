// @vitest-environment node
// "Sapphire other stylize" family on the Remotion render path (REMOTION_E2E=1): bundles the production root (with the
// test registry, which contains every catalogue effect), renders a still of a picture through each of the 17 effects
// with @remotion/renderer in headless Chrome (WebGL2 via ANGLE/SwiftShader), and S_PixelMosh on a zooming video (its
// time samples decoded for their own frames). Checks that each effect changed the picture, deterministically.
// FX_SSO_IMAGE=<photo> renders that picture (else an ffmpeg test pattern); FX_SSO_STILLS=<dir> copies the stills there
// (contact sheet: docs/screenshots/fx/sapphire-stylize-other/). Needs ffmpeg on PATH.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

const EFFECTS: { id: string; params?: Record<string, unknown> }[] = [
	{ id: 'jasper.s.band-pass' },
	{ id: 'jasper.s.color-fuse', params: { lut1Strength: 1, lut2: 'faded', lut2Strength: 0.5 } },
	{ id: 'jasper.s.dog-vision' },
	{ id: 'jasper.s.mosaic' },
	{ id: 'jasper.s.pixel-sort' },
	{ id: 'jasper.s.prism-lens' },
	{ id: 'jasper.s.pseudo-color' },
	{ id: 'jasper.s.psyko-blobs' },
	{ id: 'jasper.s.psyko-stripes' },
	{ id: 'jasper.s.roman-tile' },
	{ id: 'jasper.s.solarize' },
	{ id: 'jasper.s.strip-slide' },
	{ id: 'jasper.s.zebrafy' },
	{ id: 'jasper.s.zebrafy-color' },
	{ id: 'jasper.s.z-fog-exponential', params: { fogColor: [0.75, 0.8, 0.9, 1] } },
	{ id: 'jasper.s.z-fog-linear', params: { fogColor: [0.75, 0.8, 0.9, 1] } },
];

describe.runIf(enabled)(
	'Sapphire other-stylize effects in Remotion renders (REMOTION_E2E=1)',
	{ timeout: 600_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};
		const out = process.env.FX_SSO_STILLS;

		beforeAll(async () => {
			media = await startFxMedia('fx-sso-');
			const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
			const fit = `scale=${FX_W}:${FX_H}:force_original_aspect_ratio=increase,crop=${FX_W}:${FX_H}`;
			const image = process.env.FX_SSO_IMAGE;
			if (image) ff(['-i', image, '-vf', fit, '-frames:v', '1', join(media.dir, 'picture.png')]);
			else
				ff([
					'-f',
					'lavfi',
					'-i',
					`testsrc2=s=${FX_W}x${FX_H}`,
					'-frames:v',
					'1',
					join(media.dir, 'picture.png'),
				]);
			// A 2 s push-in on the picture (the datamosh needs motion).
			ff([
				'-loop',
				'1',
				'-i',
				join(media.dir, 'picture.png'),
				'-vf',
				`zoompan=z='1+0.012*on':d=60:s=${FX_W}x${FX_H}:fps=30`,
				'-frames:v',
				'60',
				'-pix_fmt',
				'yuv420p',
				'-c:v',
				'libx264',
				join(media.dir, 'zoom.mp4'),
			]);
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			if (out) mkdirSync(out, { recursive: true });
			console.info(`[fx-sso] stills in ${media.dir}`);
		}, 600_000);

		afterAll(() => {
			media?.close();
		});

		const picture = (): Command[] => [
			{
				type: 'media.register',
				ref: '$m',
				asset: fxAsset(media, 'image', 'picture.png', FX_W, FX_H),
			} as unknown as Command,
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				at: 0,
				tracks: { video: 'V1' },
				ref: '$c',
			} as unknown as Command,
		];
		const zoomVideo = (): Command[] => [
			{
				type: 'media.register',
				ref: '$m',
				asset: fxAsset(media, 'video', 'zoom.mp4', FX_W, FX_H),
			} as unknown as Command,
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
				tracks: { video: 'V1' },
				ref: '$c',
			} as unknown as Command,
		];

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
			const output = join(media.dir, `${name}.png`);
			await renderer.renderStill({ composition, serveUrl, inputProps, frame, output, ...browser });
			if (out) copyFileSync(output, join(out, `${name}.png`));
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
			for (let i = 0; i < a.length; i += 7) {
				d += Math.abs(a[i]! - b[i]!);
				n++;
			}
			return d / n;
		};

		it('every effect renders and changes the picture', async () => {
			const plain = await still(picture(), 0, '_original');
			for (const e of EFFECTS) {
				const raw = await still(
					[...picture(), fxCmd.effect(e.id, e.params)],
					0,
					e.id.replace('jasper.s.', ''),
				);
				expect([e.id, meanDiff(raw, plain) > 2]).toEqual([e.id, true]);
			}
		});

		it('S_PixelMosh: the held frame moshed by the zoom, deterministic across renders', async () => {
			const params = { frameInterval: 30, varyFrameInterval: 0 };
			const plain = await still(zoomVideo(), 20, 'zoom-20');
			const a = await still([...zoomVideo(), fxCmd.effect('jasper.s.pixel-mosh', params)], 20, 'pixel-mosh');
			const b = await still(
				[...zoomVideo(), fxCmd.effect('jasper.s.pixel-mosh', params)],
				20,
				'pixel-mosh-again',
			);
			expect(meanDiff(a, plain)).toBeGreaterThan(4); // not the current frame
			expect(meanDiff(a, b)).toBeLessThan(0.5); // same pixels on a re-render
			const hold = await still(
				[...zoomVideo(), fxCmd.effect('jasper.s.pixel-mosh', { ...params, useFlowWarp: false })],
				20,
				'pixel-mosh-off',
			);
			expect(meanDiff(hold, plain)).toBeLessThan(1); // Use Flow Warp off = the source
		});
	},
);
