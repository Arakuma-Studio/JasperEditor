// @vitest-environment node
// The Sapphire film / grain / damage family on the Remotion render path (REMOTION_E2E=1): bundles the compositions
// (fx-render/entry.ts — the production registry, which contains the family), renders stills of a video clip with the
// effects in headless Chrome (WebGL2 through ANGLE/SwiftShader, as the engine's render browser) and checks that
// (1) S_FilmDamage changes between consecutive frames but is identical when a frame is rendered twice
// (deterministic across render pages), (2) S_DigitalDamage's freeze shows the held (earlier) frame through its time
// sample, (3) every effect of the family renders. FX_FILM_STILLS=<dir> [FX_FILM_IMAGE=<jpg>] also writes stills of
// every effect on that picture (frames 10–12) for a visual check. Needs ffmpeg on PATH.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

const FAMILY = [
	'film-effect',
	'film-damage',
	'film-burn',
	'vignette',
	'bleach-bypass',
	'grain',
	'grain-static',
	'ultra-grain',
	'diffuse',
	'vintage-color-2strip',
	'vintage-color-3strip',
	'scan-lines',
	'scan-lines-mono',
	'vhs-damage',
	'tv-damage',
	'jpeg-damage',
	'digital-damage',
	'grunge',
];

describe.runIf(enabled)(
	'Sapphire film / grain / damage in Remotion renders (REMOTION_E2E=1)',
	{ timeout: 900_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};

		beforeAll(async () => {
			media = await startFxMedia('fx-film-');
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
		}, 600_000);

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
		const diff = (a: Buffer, b: Buffer) => {
			let d = 0;
			for (let i = 0; i < a.length; i += 3) d += Math.abs(a[i]! - b[i]!);
			return d / (a.length / 3);
		};
		const video = (effect: string, params?: Record<string, unknown>) =>
			fxSnapshot([...fxCmd.video(media, 2), fxCmd.effect(`jasper.s.${effect}`, params)]);

		it('S_FilmDamage: animated per frame, identical when a frame is rendered again', async () => {
			const a = await still(video('film-damage'), 10, join(media.dir, 'fd-10a.png'));
			const b = await still(video('film-damage'), 10, join(media.dir, 'fd-10b.png'));
			const c = await still(video('film-damage'), 11, join(media.dir, 'fd-11.png'));
			const plain = await still(fxSnapshot(fxCmd.video(media, 2)), 10, join(media.dir, 'plain-10.png'));
			expect(diff(a, b)).toBe(0);
			expect(diff(a, plain)).toBeGreaterThan(1);
			expect(diff(a, c)).toBeGreaterThan(diff(plain, plain) + 1);
			expect(a.length).toBe(FX_W * FX_H * 3);
		});

		it('S_DigitalDamage freeze shows the held frame (time sample)', async () => {
			const frozen = {
				freezeAlways: 1,
				freezeThreshold: 0,
				freezeQuality: 1,
				freezeSaturation: 1,
				freezeErrs: 0,
				freezeFrames: 10,
				intensity: 10,
				shift: false,
				brightsNoise: false,
				pixelate: false,
				blockNoise: false,
				invert: false,
				flow: false,
			};
			const held = await still(fxSnapshot(fxCmd.video(media, 2)), 20, join(media.dir, 'v-20.png'));
			const now = await still(fxSnapshot(fxCmd.video(media, 2)), 27, join(media.dir, 'v-27.png'));
			const dd = await still(video('digital-damage', frozen), 27, join(media.dir, 'dd-27.png'));
			expect(diff(held, now)).toBeGreaterThan(5);
			expect(diff(dd, held)).toBeLessThan(diff(dd, now));
		});

		it('every effect of the family renders (frame 10)', async () => {
			const plain = await still(fxSnapshot(fxCmd.video(media, 2)), 10, join(media.dir, 'p.png'));
			for (const e of FAMILY) {
				const raw = await still(video(e), 10, join(media.dir, `${e}.png`));
				expect(raw.length, e).toBe(plain.length);
			}
		});

		const stills = process.env.FX_FILM_STILLS;
		it.runIf(!!stills)('writes stills of every effect on a picture (FX_FILM_STILLS)', async () => {
			const dir = stills!;
			mkdirSync(dir, { recursive: true });
			const img = process.env.FX_FILM_IMAGE;
			let base: ReturnType<typeof fxCmd.video>;
			if (img) {
				copyFileSync(img, join(media.dir, 'photo.png'));
				base = [
					{ type: 'media.register', ref: '$m', asset: fxAsset(media, 'image', 'photo.png', 640, 360) },
					{ type: 'clip.place', source: { mediaId: '$m' }, at: 0, tracks: { video: 'V1' }, ref: '$c' },
				] as unknown as ReturnType<typeof fxCmd.video>;
			} else base = fxCmd.video(media, 2);
			const frames = (process.env.FX_FILM_FRAMES ?? '10,11,12').split(',').map(Number);
			const only = process.env.FX_FILM_ONLY?.split(',');
			for (const e of FAMILY) {
				if (only && !only.includes(e)) continue;
				for (const f of frames) {
					const doc = fxSnapshot([...base, fxCmd.effect(`jasper.s.${e}`)]);
					await still(doc, f, join(dir, `${e}-${f}.png`));
				}
			}
		});
	},
);
