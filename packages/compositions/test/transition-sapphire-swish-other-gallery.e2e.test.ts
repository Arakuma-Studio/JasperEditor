// @vitest-environment node
// This gallery only checks that middle frames differ from both sides; inspect the PNGs for visual quality.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { BROWSER_VIDEO_ARGS } from '@jasper/testkit/fixture-video';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.TRANSITION_SSO_GALLERY;
const enabled = process.env.REMOTION_E2E === '1' && !!out;
const only = process.env.TRANSITION_SSO_ONLY?.split(',');

const GALLERY: [string, string, Record<string, unknown>?][] = [
	['swish-pan', 'jasper.s.swish-pan'],
	['swish-3d', 'jasper.s.swish-3d'],
	[
		'swish-3d-swivel-chroma',
		'jasper.s.swish-3d',
		{ effect: 'chromaWarp', swivel: 60, rotate: 30, zDist: 0.7 },
	],
	['card-flip', 'jasper.s.card-flip'],
	['card-flip-shuffle', 'jasper.s.card-flip', { revolutions: 0, shift: 1.2 }],
	['film-burn-transition', 'jasper.s.film-burn-transition', { edges: true }],
	['film-roll', 'jasper.s.film-roll'],
	['flutter-cut', 'jasper.s.flutter-cut', { color1Frames: 1, fromStartFrames: 4 }],
	['hyper-pull', 'jasper.s.hyper-pull'],
	['hyper-push', 'jasper.s.hyper-push', { cameraShake: true }],
	[
		'mocha-whip',
		'jasper.s.mocha-whip',
		{ cutoutMask: 'ellipse', maskCenter: [0.5, 0.5], maskSize: [0.45, 0.6] },
	],
	['parallax-strips-transition', 'jasper.s.parallax-strips-transition'],
	['strip-slide-transition', 'jasper.s.strip-slide-transition'],
	['tv-channel-change', 'jasper.s.tv-channel-change'],
	['whip-lash', 'jasper.s.whip-lash'],
	['whip-lash-bounce-rgb', 'jasper.s.whip-lash', { whipOut: 'bounce', mixRgb: 1, rotate: 20 }],
];
/** Frames of the 19-frame span (start 21): progress (i + 1) / 20 = 0.25, 0.5, 0.75. */
const FRAMES = [25, 30, 35];

describe.runIf(enabled)(
	'Sapphire swish/other transition gallery (REMOTION_E2E=1, TRANSITION_SSO_GALLERY=<dir>)',
	{ timeout: 1_800_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};

		beforeAll(async () => {
			media = await startFxMedia('transition-sso-');
			const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
			const fit = `scale=${FX_W * 1.25}:${FX_H * 1.25}:force_original_aspect_ratio=increase,crop=${FX_W * 1.25}:${FX_H * 1.25}`;
			const picture = (env: string | undefined, lavfi: string, name: string) =>
				env
					? ff(['-i', env, '-vf', fit, '-frames:v', '1', join(media.dir, name)])
					: ff(['-f', 'lavfi', '-i', lavfi, '-vf', fit, '-frames:v', '1', join(media.dir, name)]);
			picture(process.env.SSO_IMAGE_A, `mandelbrot=s=${FX_W}x${FX_H}:start_scale=0.6`, 'a.png');
			picture(process.env.SSO_IMAGE_B, `testsrc2=s=${FX_W}x${FX_H}`, 'b.png');
			for (const [src, dst, dir] of [
				['a.png', 'a.mp4', '+'],
				['b.png', 'b.mp4', '-'],
			] as const)
				ff([
					'-loop',
					'1',
					'-i',
					join(media.dir, src),
					'-vf',
					`zoompan=z='1.1${dir}0.0015*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=60:s=${FX_W}x${FX_H}:fps=30`,
					'-frames:v',
					'60',
					'-pix_fmt',
					'yuv420p',
					...BROWSER_VIDEO_ARGS,
					join(media.dir, dst),
				]);
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, '..', 'src', 'remotion-entry.ts') });
			renderer = await import('@remotion/renderer');
			mkdirSync(out!, { recursive: true });
		}, 600_000);

		afterAll(() => {
			media?.close();
			const rows = GALLERY.filter(([n]) => !only || only.includes(n)).map(([n]) => n);
			const files = rows.flatMap((n) => FRAMES.map((f) => join(out!, `${n}-${f}.png`)));
			if (!files.every((f) => existsSync(f)) || files.length === 0) return;
			const inputs = files.flatMap((f) => ['-i', f]);
			const tiles = files.map((_, i) => `[${i}]scale=224:126[t${i}]`).join(';');
			const layout = files.map((_, i) => `${(i % 3) * 224}_${Math.floor(i / 3) * 126}`).join('|');
			try {
				execFileSync('ffmpeg', [
					'-v',
					'error',
					'-y',
					...inputs,
					'-filter_complex',
					`${tiles};${files.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${files.length}:layout=${layout}`,
					'-q:v',
					'5',
					join(out!, 'contact-sheet.jpg'),
				]);
			} catch (e) {
				console.warn(`[sso] contact sheet failed: ${(e as Error).message}`);
			}
		});

		const doc = (effectId: string, params?: Record<string, unknown>): Command[] => [
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

		for (const [name, effectId, params] of GALLERY)
			it.runIf(!only || only.includes(name))(name, async () => {
				const frames: Buffer[] = [];
				for (const f of [20, ...FRAMES, 40]) {
					const inputProps = {
						doc: fxSnapshot(doc(effectId, params)),
						options: { isPreview: false, useProxies: false, transparentBackground: false },
					};
					const composition = await renderer.selectComposition({
						serveUrl,
						id: SEQUENCE_COMPOSITION_ID,
						inputProps,
						...browser,
					});
					const file = join(media.dir, `${name}-${f}.png`);
					await renderer.renderStill({
						composition,
						serveUrl,
						inputProps,
						frame: f,
						output: file,
						...browser,
					});
					if (FRAMES.includes(f)) copyFileSync(file, join(out!, `${name}-${f}.png`));
					frames.push(
						execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']),
					);
				}
				const diff = (a: Buffer, b: Buffer) => {
					let d = 0;
					for (let i = 0; i < a.length; i += 31) d += Math.abs(a[i]! - b[i]!);
					return d;
				};
				expect(diff(frames[2]!, frames[0]!)).toBeGreaterThan(0);
				expect(diff(frames[2]!, frames[4]!)).toBeGreaterThan(0);
			});
	},
);
