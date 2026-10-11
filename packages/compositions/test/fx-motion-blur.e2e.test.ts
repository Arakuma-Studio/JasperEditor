// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

const key = (ref: string, param: string, frames: number, value: unknown): Command =>
	({ type: 'keyframe.add', target: ['effect', ref, param], at: { frames }, value }) as Command;

describe.runIf(enabled)(
	'adaptive shutter motion blur in Remotion renders (REMOTION_E2E=1)',
	{ timeout: 900_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};
		const keep = process.env.MB_E2E_OUT;

		beforeAll(async () => {
			media = await startFxMedia('fx-mb-');
			const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
			ff([
				'-f',
				'lavfi',
				'-i',
				`mandelbrot=s=${FX_W}x${FX_H}:start_scale=0.6:end_scale=0.6:maxiter=200`,
				'-f',
				'lavfi',
				'-i',
				`testsrc2=s=${FX_W}x${FX_H}`,
				'-filter_complex',
				'[0:v]eq=saturation=1.4[m];[1:v]crop=200:120:220:120[t];[m][t]overlay=40:200,drawgrid=w=40:h=40:t=2:c=white@0.8',
				'-frames:v',
				'1',
				join(media.dir, 'picture.png'),
			]);
			// Transition sides: two slowly zooming clips (as the transition galleries use).
			const fit = `scale=${FX_W * 1.25}:${FX_H * 1.25}:force_original_aspect_ratio=increase,crop=${FX_W * 1.25}:${FX_H * 1.25}`;
			ff(['-i', join(media.dir, 'picture.png'), '-vf', fit, '-frames:v', '1', join(media.dir, 'a.png')]);
			ff([
				'-f',
				'lavfi',
				'-i',
				`testsrc2=s=${FX_W}x${FX_H}`,
				'-vf',
				`drawgrid=w=40:h=40:t=2:c=white@0.8,${fit}`,
				'-frames:v',
				'1',
				join(media.dir, 'b.png'),
			]);
			for (const [src, dst] of [
				['a.png', 'a.mp4'],
				['b.png', 'b.mp4'],
			] as const)
				ff([
					'-loop',
					'1',
					'-i',
					join(media.dir, src),
					'-vf',
					`zoompan=z='1.1+0.001*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=60:s=${FX_W}x${FX_H}:fps=30`,
					'-frames:v',
					'60',
					'-pix_fmt',
					'yuv420p',
					'-c:v',
					'libx264',
					join(media.dir, dst),
				]);
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			if (keep) mkdirSync(keep, { recursive: true });
			console.info(`[fx-mb] stills in ${media.dir}`);
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
		const effect = (effectId: string, ref: string, params: Record<string, unknown>): Command =>
			({ type: 'effect.add', target: { clipId: '$c' }, effectId, params, ref }) as unknown as Command;
		const twoClips = (effectId: string, params?: Record<string, unknown>): Command[] => [
			{ type: 'media.register', ref: '$a', asset: fxAsset(media, 'video', 'a.mp4', FX_W, FX_H) } as Command,
			{
				type: 'clip.place',
				source: { mediaId: '$a' },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
				tracks: { video: 'V1' },
			} as unknown as Command,
			{ type: 'media.register', ref: '$b', asset: fxAsset(media, 'video', 'b.mp4', FX_W, FX_H) } as Command,
			{
				type: 'clip.place',
				source: { mediaId: '$b' },
				at: 30,
				sourceRange: { in: { seconds: 0.5 }, out: { seconds: 1.5 } },
				tracks: { video: 'V1' },
			} as unknown as Command,
			{
				type: 'transition.add',
				trackId: 'V1',
				at: 30,
				effectId,
				duration: 19,
				...(params ? { params } : {}),
			} as Command,
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
			if (keep) copyFileSync(output, join(keep, `${name}.png`));
			return execFileSync(
				'ffmpeg',
				['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
				{
					maxBuffer: 1 << 26,
				},
			);
		}
		const diff = (a: Buffer, b: Buffer) => {
			let d = 0;
			for (let i = 0; i < a.length; i += 7) d += Math.abs(a[i]! - b[i]!);
			return d / (a.length / 7);
		};

		const SHAKE = { style: 'twitchy', amplitude: 5, frequency: 12, stillness: 0, xRandAmp: 1, yRandAmp: 0.5 };
		const shake = (blur: boolean) => [
			...picture(),
			effect('jasper.s.shake', '$s', { ...SHAKE, motionBlur: blur }),
		];
		const pin = (blur: boolean) => [
			...picture(),
			effect('jasper.s.warp-corner-pin', '$p', { motionBlur: blur, moBlurLength: 1 }),
			key('$p', 'topLeft', 0, [-0.3, 0.2]),
			key('$p', 'topRight', 0, [0.25, 0.25]),
			key('$p', 'bottomLeft', 0, [-0.3, 0.8]),
			key('$p', 'bottomRight', 0, [0.25, 0.75]),
			key('$p', 'topLeft', 6, [0.75, 0.25]),
			key('$p', 'topRight', 6, [1.3, 0.2]),
			key('$p', 'bottomLeft', 6, [0.75, 0.75]),
			key('$p', 'bottomRight', 6, [1.3, 0.8]),
		];
		const transform = (angle: number) => [
			...picture(),
			effect('jasper.transform', '$t', { useCompShutterAngle: false, shutterAngle: angle, scaleHeight: 60 }),
			key('$t', 'position', 0, [0.15, 0.5]),
			key('$t', 'position', 6, [0.85, 0.5]),
			key('$t', 'rotation', 0, 0),
			key('$t', 'rotation', 6, 90),
		];

		it('S_Shake (Twitchy, high amplitude): blurred, deterministic, independent of the frame order', async () => {
			const a = await still(shake(true), 29, 'shake-twitchy-29');
			await still(shake(true), 11, 'shake-twitchy-11');
			await still(shake(false), 29, 'shake-twitchy-29-off');
			const b = await still(shake(true), 29, 'shake-twitchy-29-again');
			expect(diff(a, b)).toBe(0);
		});

		it('S_WarpCornerPin with a fast keyframed move', async () => {
			const on = await still(pin(true), 3, 'corner-pin-fast-3');
			await still(pin(true), 2, 'corner-pin-fast-2');
			const off = await still(pin(false), 3, 'corner-pin-fast-3-off');
			expect(diff(on, off)).toBeGreaterThan(0.5);
		});

		it('Transform with a 180° shutter (keyframed position and rotation)', async () => {
			const on = await still(transform(180), 3, 'transform-180-3');
			await still(transform(180), 2, 'transform-180-2');
			const off = await still(transform(0), 3, 'transform-180-3-off');
			expect(diff(on, off)).toBeGreaterThan(0.5);
		});

		it('Travel Motion (Film Impact-style slide) and S_SwishPan', async () => {
			for (const f of [27, 30, 33]) await still(twoClips('jasper.travel-motion'), f, `travel-motion-${f}`);
			for (const f of [27, 30, 33]) await still(twoClips('jasper.s.swish-pan'), f, `swish-pan-${f}`);
			const a = await still(twoClips('jasper.travel-motion', { blur: 100 }), 30, 'travel-motion-30-blur100');
			const b = await still(twoClips('jasper.travel-motion', { blur: 0 }), 30, 'travel-motion-30-blur0');
			expect(diff(a, b)).toBeGreaterThan(0.5);
		});
	},
);
