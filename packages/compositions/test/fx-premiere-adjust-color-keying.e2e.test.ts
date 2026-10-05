// @vitest-environment node
// The fx family premiere-adjust-color-keying on the Remotion render path (REMOTION_E2E=1): bundles the compositions
// (the default registry includes the family), renders stills with @remotion/renderer in headless Chrome and checks
// pixels — Drop Shadow into the padding with Premiere's direction convention, Ultra Key on a green solid, the
// analysis passes of Auto Levels / Equalize on video, a media-param matte (Track Matte Key) and Basic 3D.
// PACG_PHOTOS=<dir with Girl_in_front_of_a_g.jpg, market0157.jpg> also renders photo stills for a visual check
// (written next to the other stills; the test logs the directory).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

type Rgb = [number, number, number];

describe.runIf(enabled)(
	'fx family premiere-adjust-color-keying in Remotion renders',
	{ timeout: 240_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};

		beforeAll(async () => {
			media = await startFxMedia('fx-pacg-');
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			console.info(`[fx-pacg] stills in ${media.dir}`);
		}, 300_000);

		afterAll(() => {
			media?.close();
		});

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
			return execFileSync(
				'ffmpeg',
				['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
				{
					maxBuffer: 1 << 26,
				},
			);
		}
		const at = (raw: Buffer, x: number, y: number): Rgb => {
			const i = (Math.round(y) * FX_W + Math.round(x)) * 3;
			return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
		};
		const close = (a: Rgb, b: Rgb, tol: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
		const maxDiff = (a: Buffer, b: Buffer) => {
			let d = 0;
			for (let i = 0; i < a.length; i += 97) d = Math.max(d, Math.abs(a[i]! - b[i]!));
			return d;
		};

		it('Drop Shadow: Premiere direction 90° casts to the right, into the padding', async () => {
			const raw = await still(
				[
					...fxCmd.still(media),
					fxCmd.effect('jasper.drop-shadow', {
						shadowColor: [0, 1, 0, 1],
						opacity: 100,
						direction: 90,
						distance: 40,
					}),
				],
				0,
				'drop-shadow',
			);
			// the 200×200 still is centred (x 220…420); the shadow covers x 420…460
			expect(close(at(raw, FX_W / 2, FX_H / 2), [255, 0, 0], 12)).toBe(true);
			expect(close(at(raw, 440, FX_H / 2), [0, 255, 0], 12)).toBe(true);
			expect(close(at(raw, 200, FX_H / 2), [0, 0, 0], 12)).toBe(true);
		});

		it('Ultra Key removes a green solid; a red one stays', async () => {
			const key = { keyColor: [0.1, 0.8, 0.2, 1] };
			const green = await still(
				[...fxCmd.solid([0.1, 0.8, 0.2, 1]), fxCmd.effect('jasper.ultra-key', key)],
				3,
				'ultra-key-green',
			);
			expect(close(at(green, FX_W / 2, FX_H / 2), [0, 0, 0], 8)).toBe(true);
			const red = await still(
				[...fxCmd.solid([0.8, 0.1, 0.1, 1]), fxCmd.effect('jasper.ultra-key', key)],
				3,
				'ultra-key-red',
			);
			expect(close(at(red, FX_W / 2, FX_H / 2), [204, 26, 26], 10)).toBe(true);
		});

		it('Auto Levels restores a darkened frame (analysis passes); Basic 3D turns it', async () => {
			const plain = await still(fxCmd.video(media), 10, 'video-plain');
			const dark = fxCmd.effect('jasper.levels', { whiteOutput: 110 });
			const darkened = await still([...fxCmd.video(media), dark], 10, 'levels-dark');
			expect(maxDiff(darkened, plain)).toBeGreaterThan(100);
			const restored = await still(
				[...fxCmd.video(media), dark, fxCmd.effect('jasper.auto-levels')],
				10,
				'auto-levels',
			);
			expect(maxDiff(restored, plain)).toBeLessThan(40);
			const turned = await still(
				[...fxCmd.video(media), fxCmd.effect('jasper.basic-3d', { swivel: 40 })],
				10,
				'basic-3d',
			);
			expect(maxDiff(turned, plain)).toBeGreaterThan(30);
		});

		it('Track Matte Key: an opaque matte keeps the frame, reversed it hides it', async () => {
			const plain = await still(fxCmd.video(media), 10, 'video-plain-2');
			const matte = (reverse: boolean): Command[] => [
				{
					type: 'media.register',
					ref: '$matte',
					asset: fxAsset(media, 'image', 'red.png', 200, 200),
				} as unknown as Command,
				...fxCmd.video(media),
				fxCmd.effect('jasper.track-matte-key', { matte: { mediaId: '$matte' }, reverse }),
			];
			expect(maxDiff(await still(matte(false), 10, 'track-matte'), plain)).toBeLessThan(16);
			const hidden = await still(matte(true), 10, 'track-matte-reverse');
			expect(close(at(hidden, FX_W / 2, FX_H / 2), [0, 0, 0], 8)).toBe(true);
		});

		it.runIf(!!process.env.PACG_PHOTOS)('photo stills for a visual check (PACG_PHOTOS)', async () => {
			const dir = process.env.PACG_PHOTOS!;
			const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
			ff(['-i', join(dir, 'Girl_in_front_of_a_g.jpg'), '-vf', 'scale=240:360', join(media.dir, 'girl.png')]);
			ff(['-i', join(dir, 'market0157.jpg'), '-vf', 'scale=480:332', join(media.dir, 'market.png')]);
			const photo = (name: string, w: number, h: number): Command[] => [
				{
					type: 'media.register',
					ref: '$p',
					asset: fxAsset(media, 'image', name, w, h),
				} as unknown as Command,
				{
					type: 'clip.place',
					source: { mediaId: '$p' },
					at: 0,
					tracks: { video: 'V1' },
					ref: '$c',
				} as unknown as Command,
			];
			const shots: [string, Command[]][] = [
				[
					'photo-ultra-key',
					[
						...photo('girl.png', 240, 360),
						fxCmd.effect('jasper.ultra-key', { keyColor: [0.36, 0.9, 0.45, 1] }),
					],
				],
				['photo-lighting', [...photo('market.png', 480, 332), fxCmd.effect('jasper.lighting-effects')]],
				[
					'photo-camera-blur',
					[...photo('market.png', 480, 332), fxCmd.effect('jasper.camera-blur', { percentBlur: 40 })],
				],
				['photo-auto-color', [...photo('market.png', 480, 332), fxCmd.effect('jasper.auto-color')]],
				[
					'photo-leave-color',
					[
						...photo('market.png', 480, 332),
						fxCmd.effect('jasper.leave-color', {
							amountToDecolor: 100,
							colorToLeave: [0.95, 0.4, 0.35, 1],
							tolerance: 20,
							edgeSoftness: 10,
							matchColors: 'hue',
						}),
					],
				],
				[
					'photo-basic-3d',
					[
						...photo('market.png', 480, 332),
						fxCmd.effect('jasper.basic-3d', { swivel: 30, tilt: -15, specularHighlight: true }),
					],
				],
			];
			for (const [name, cmds] of shots) await still(cmds, 0, name);
		});
	},
);
