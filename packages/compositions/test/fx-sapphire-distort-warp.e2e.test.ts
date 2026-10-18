// @vitest-environment node
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

const EFFECTS: [string, Record<string, unknown>?][] = [
	['jasper.s.distort'],
	['jasper.s.distort-blur'],
	['jasper.s.distort-chroma'],
	['jasper.s.distort-rgb'],
	['jasper.s.infinite-zoom'],
	['jasper.s.parallax-strips'],
	['jasper.s.shake'],
	['jasper.s.stretch-frame-edges'],
	['jasper.s.warp-bubble'],
	['jasper.s.warp-bubble2'],
	['jasper.s.warp-chroma'],
	['jasper.s.warp-corner-pin'],
	['jasper.s.warp-drops', { amplitude: 3 }],
	['jasper.s.warp-fish-eye'],
	['jasper.s.warp-magnify'],
	['jasper.s.warp-perspective'],
	['jasper.s.warp-polar'],
	['jasper.s.warp-puddle'],
	['jasper.s.warp-puff'],
	['jasper.s.warp-repeat'],
	['jasper.s.warp-transform', { rotate: 12, swivel: 25, scale: [0.85, 0.85] }],
	['jasper.s.warp-vortex'],
	['jasper.s.warp-waves'],
	['jasper.s.warp-waves2'],
];

describe.runIf(enabled)(
	'Sapphire Distort effects in Remotion renders (REMOTION_E2E=1)',
	{ timeout: 600_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};
		const keep = process.env.DW_E2E_OUT;

		beforeAll(async () => {
			media = await startFxMedia('fx-dw-');
			execFileSync('ffmpeg', [
				'-v',
				'error',
				'-y',
				'-f',
				'lavfi',
				'-i',
				`mandelbrot=s=${FX_W}x${FX_H}:start_scale=0.6:end_scale=0.6:maxiter=200`,
				'-f',
				'lavfi',
				'-i',
				`testsrc2=s=${FX_W}x${FX_H}`,
				'-filter_complex',
				'[0:v]hue=s=1.4[m];[1:v]crop=200:120:220:120[t];[m][t]overlay=40:200,drawgrid=w=40:h=40:t=1:c=white@0.45',
				'-frames:v',
				'1',
				join(media.dir, 'picture.png'),
			]);
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			if (keep) mkdirSync(keep, { recursive: true });
			console.info(`[fx-dw] stills in ${media.dir}`);
		}, 300_000);

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

		async function still(doc: ReturnType<typeof fxSnapshot>, frame: number, name: string): Promise<Buffer> {
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
		const mean = (a: Buffer) => {
			let s = 0;
			for (let i = 0; i < a.length; i += 7) s += a[i]!;
			return s / (a.length / 7);
		};

		it('every effect of the family renders on a full-frame picture', async () => {
			const plain = await still(fxSnapshot(picture()), 10, '00-source');
			for (const [id, params] of EFFECTS) {
				const raw = await still(
					fxSnapshot([...picture(), fxCmd.effect(id, params)]),
					10,
					id.replace('jasper.s.', ''),
				);
				expect(mean(raw), id).toBeGreaterThan(10);
				expect(diff(raw, plain), id).toBeGreaterThan(0.5);
			}
		});

		it('a warp moves a small still outside its box (padding), into the sequence frame', async () => {
			// The 200×200 red still is centred (x 220…420); shifted by half its width it covers x 320…520.
			const raw = await still(
				fxSnapshot([...fxCmd.still(media), fxCmd.effect('jasper.s.warp-transform', { shift: [0.5, 0] })]),
				0,
				'small-still-shift',
			);
			const at = (x: number, y: number) => {
				const i = (y * FX_W + x) * 3;
				return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
			};
			expect(at(470, FX_H / 2)[0]).toBeGreaterThan(230); // beyond the original box: red
			expect(at(260, FX_H / 2)[0]).toBeLessThan(20); // vacated: the black sequence background
		});

		it('S_Shake over video: deterministic across renders, different between frames', async () => {
			const doc = (seed: number) =>
				fxSnapshot([...fxCmd.video(media), fxCmd.effect('jasper.s.shake', { amplitude: 3, seed })]);
			const a = await still(doc(0), 12, 'shake-12a');
			const b = await still(doc(0), 12, 'shake-12b');
			const c = await still(doc(0), 13, 'shake-13');
			const s = await still(doc(7), 12, 'shake-12-seed7');
			expect(diff(a, b)).toBe(0);
			expect(diff(a, c)).toBeGreaterThan(1);
			expect(diff(a, s)).toBeGreaterThan(1);
		});
	},
);
