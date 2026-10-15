// @vitest-environment node
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
type Shot = {
	name: string;
	layer: 'scene' | 'fg' | 'bg';
	effect?: string;
	params?: Record<string, unknown>;
};

const SHOTS: Shot[] = [
	{ name: 'plain-scene', layer: 'scene' },
	{ name: 'plain-bg', layer: 'bg' },
	{
		name: 'invert-mask',
		layer: 'scene',
		effect: 'jasper.s.invert',
		params: { mask: { mediaId: '$mask' } },
	},
	{
		name: 'layer',
		layer: 'fg',
		effect: 'jasper.s.layer',
		params: { background: { mediaId: '$bg' }, effect: 'overlay' },
	},
	{
		name: 'matte-ops-comp',
		layer: 'fg',
		effect: 'jasper.s.matte-ops-comp',
		params: { background: { mediaId: '$bg' }, shrinkGrow: 10, edgeSoftness: 20 },
	},
];

describe.runIf(enabled)(
	'sapphire-adjust-composite in Remotion renders (REMOTION_E2E=1)',
	{ timeout: 600_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};
		const raws = new Map<string, Buffer>();

		beforeAll(async () => {
			media = await startFxMedia('fx-sac-');
			const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
			const size = `${FX_W}x${FX_H}`;
			// Scene: colourful gradients, a bright soft sun, SMPTE bars and a grey ramp (a stand-in for a photo with a
			// full tonal range). Foreground: the scene inside a soft-edged circle (alpha). Background: a radial gradient.
			ff([
				...[
					'-f',
					'lavfi',
					'-i',
					`gradients=s=${size}:c0=0x0b132b:c1=0x3a86ff:c2=0xffbe0b:c3=0xfb5607:c4=0xff006e:c5=0x8ac926:n=6:x0=0:y0=0:x1=640:y1=360:seed=3`,
				],
				...['-f', 'lavfi', '-i', 'smptebars=s=200x112', '-f', 'lavfi', '-i', 'color=black:s=640x36'],
				...['-f', 'lavfi', '-i', 'color=white:s=90x90', '-filter_complex'],
				"[2:v]format=gray,geq=lum='X*255/W',format=rgb24[ramp];[3:v]format=rgba,geq=r=255:g=250:b=235:a='clip((44-hypot(X-45,Y-45))*40,0,255)'[sun];[0:v][1:v]overlay=420:20[a];[a][ramp]overlay=0:324[b];[b][sun]overlay=90:40",
				...['-frames:v', '1', join(media.dir, 'scene.png')],
			]);
			ff([
				...['-i', join(media.dir, 'scene.png'), '-frames:v', '1'],
				...[
					'-vf',
					"format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip((130-hypot(X-320,Y-180))*64,0,255)'",
				],
				join(media.dir, 'fg.png'),
			]);
			ff([
				...[
					'-f',
					'lavfi',
					'-i',
					`gradients=s=${size}:c0=0x264653:c1=0x2a9d8f:c2=0xe9c46a:c3=0xf4a261:c4=0xe76f51:n=5:type=radial:x0=320:y0=180:x1=0:y1=0:seed=9`,
				],
				...['-frames:v', '1', join(media.dir, 'bg.png')],
			]);
			// A radial auxiliary mask preserves the source outside its circle.
			const gray = (expr: string, name: string) =>
				ff([
					'-f',
					'lavfi',
					'-i',
					`color=black:s=${size}`,
					'-frames:v',
					'1',
					'-vf',
					`format=gray,geq=lum='${expr}'`,
					join(media.dir, name),
				]);
			gray('clip((200-hypot(X-320,Y-180))*2,0,255)', 'mask.png');
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			console.info(`[fx-sac] stills in ${media.dir}`);
		}, 300_000);

		afterAll(() => {
			media?.close();
		});

		const image = (ref: string, name: string): Command =>
			({
				type: 'media.register',
				ref,
				asset: fxAsset(media, 'image', name, FX_W, FX_H),
			}) as unknown as Command;

		async function render(shot: Shot): Promise<Buffer> {
			const layer = [
				image('$m', `${shot.layer}.png`),
				{
					type: 'clip.place',
					source: { mediaId: '$m' },
					at: 0,
					tracks: { video: 'V1' },
					ref: '$c',
				} as unknown as Command,
			];
			const doc = fxSnapshot([
				image('$bg', 'bg.png'),
				image('$mask', 'mask.png'),
				...layer,
				...(shot.effect ? [fxCmd.effect(shot.effect, shot.params)] : []),
			]);
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
			const output = join(media.dir, `${shot.name}.png`);
			await renderer.renderStill({ composition, serveUrl, inputProps, frame: 2, output, ...browser });
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
		it('media masks preserve outside pixels and composites reveal their background', async () => {
			for (const shot of SHOTS) raws.set(shot.name, await render(shot));
			const video = raws.get('plain-scene')!;
			// The mask keeps the source outside its circle (corner) and inverts inside (centre).
			const masked = raws.get('invert-mask')!;
			expect(at(masked, 5, 5).every((v, k) => Math.abs(v - at(video, 5, 5)[k]!) < 12)).toBe(true);
			expect(at(masked, 320, 180).every((v, k) => Math.abs(v + at(video, 320, 180)[k]! - 255) < 12)).toBe(
				true,
			);
			// Composites show the Background outside the foreground circle.
			const bgDirect = at(raws.get('plain-bg')!, 5, 5);
			expect(Math.max(...bgDirect)).toBeGreaterThan(50);
			for (const name of ['matte-ops-comp', 'layer']) {
				const back = at(raws.get(name)!, 5, 5);
				expect(
					back.every((v, k) => Math.abs(v - bgDirect[k]!) < 12),
					name,
				).toBe(true);
			}
		});
	},
);
