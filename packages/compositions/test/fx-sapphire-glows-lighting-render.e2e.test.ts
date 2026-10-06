// @vitest-environment node
// Sapphire Glows + Lighting on the Remotion render path: bundles the PRODUCTION entry (the family is in the default
// registry), renders stills of every effect of the family on a still image (a generated test card: every effect must
// change it) and of the main ones on a decoded video frame (ffmpeg testsrc2, 640×360), deterministically; plus a padded drop shadow on a still drawn outside its
// box and a time-dependent effect (S_Flashbulbs) differing between frames. Stills are kept in the temp dir printed
// at start (visual review). Gated by REMOTION_E2E=1 (bundling ≈ 30 s, each still ≈ 1–5 s); needs ffmpeg on PATH.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { FX_FAMILIES } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
const FAMILY = FX_FAMILIES.find((f) => f.file === 'sapphire-glows-lighting')!.effects;

type Rgb = [number, number, number];

describe.runIf(enabled)(
	'Sapphire Glows + Lighting in Remotion renders (REMOTION_E2E=1)',
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
			media = await startFxMedia('fx-sgl-render-');
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, '..', 'src', 'remotion-entry.ts') });
			renderer = await import('@remotion/renderer');
			// A test card: dark blue background, a white "light", a mid-grey and a red box (lights, darks, edges).
			execFileSync('ffmpeg', [
				'-v',
				'error',
				'-y',
				'-f',
				'lavfi',
				'-i',
				'color=c=0x182040:s=320x180',
				'-vf',
				'drawbox=x=40:y=40:w=40:h=40:color=white:t=fill,drawbox=x=130:y=60:w=60:h=80:color=0x808080:t=fill,drawbox=x=230:y=30:w=50:h=50:color=red:t=fill',
				'-frames:v',
				'1',
				join(media.dir, 'card.png'),
			]);
			console.info(`[fx-sgl-render] stills in ${media.dir}`);
		}, 600_000);

		afterAll(() => {
			media?.close();
		});

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
			await renderer.renderStill({
				composition,
				serveUrl,
				inputProps,
				frame,
				output,
				timeoutInMilliseconds: 180_000,
				...browser,
			});
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
		/** The test card as a full-frame-ish image clip. */
		const card = (): Command[] => [
			{
				type: 'media.register',
				ref: '$m',
				asset: fxAsset(media, 'image', 'card.png', 320, 180),
			} as unknown as Command,
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				at: 0,
				tracks: { video: 'V1' },
				ref: '$c',
			} as unknown as Command,
		];
		/** Largest channel difference over a sampled grid. */
		const maxDiff = (a: Buffer, b: Buffer) => {
			let d = 0;
			for (let i = 0; i < a.length; i += 5) d = Math.max(d, Math.abs(a[i]! - b[i]!));
			return d;
		};
		const diff = (a: Buffer, b: Buffer) => {
			let d = 0;
			for (let i = 0; i < a.length; i += 7) d += Math.abs(a[i]! - b[i]!);
			return d / (a.length / 7);
		};

		it('every effect of the family renders on a still image (test card) and changes it', async () => {
			const plain = await still(fxSnapshot(card()), 0, 'card-plain');
			const unchanged: string[] = [];
			for (const spec of FAMILY) {
				// Random generators get enough events; the drop shadow gets a colour that shows on the dark frame.
				const params: Record<string, unknown> =
					spec.id === 'jasper.s.flashbulbs'
						? { flashes: 12 }
						: spec.id === 'jasper.s.drop-shadow'
							? { shadowColor: [0, 1, 0, 1] }
							: {};
				const raw = await still(
					fxSnapshot([...card(), fxCmd.effect(spec.id, params)]),
					0,
					spec.id.replace('jasper.s.', 'card-'),
				);
				if (maxDiff(raw, plain) < 24) unchanged.push(spec.id);
			}
			expect(unchanged).toEqual([]);
		});

		it('glows, rays, flares, glints and bokeh on a decoded video frame', async () => {
			const plain = await still(fxSnapshot(fxCmd.video(media)), 10, 'video-plain');
			const unchanged: string[] = [];
			for (const id of [
				'jasper.s.glow',
				'jasper.s.rays',
				'jasper.s.lens-flare',
				'jasper.s.glint',
				'jasper.s.bokeh-lights',
			]) {
				const raw = await still(
					fxSnapshot([...fxCmd.video(media), fxCmd.effect(id)]),
					10,
					id.replace('jasper.s.', 'video-'),
				);
				if (diff(raw, plain) < 0.5) unchanged.push(id);
			}
			expect(unchanged).toEqual([]);
		});

		it('renders deterministically (S_GlowNoise, S_BokehLights twice → same pixels)', async () => {
			for (const id of ['jasper.s.glow-noise', 'jasper.s.bokeh-lights']) {
				const a = await still(fxSnapshot([...fxCmd.video(media), fxCmd.effect(id)]), 12, `${id}-a`);
				const b = await still(fxSnapshot([...fxCmd.video(media), fxCmd.effect(id)]), 12, `${id}-b`);
				expect(diff(a, b)).toBeLessThan(0.2);
			}
		});

		it('S_DropShadow on a still is drawn outside the layer box', async () => {
			const raw = await still(
				fxSnapshot([
					...fxCmd.still(media),
					fxCmd.effect('jasper.s.drop-shadow', { shadowColor: [0, 1, 0, 1], shadowBlur: 0, shift: [0.2, 0] }),
				]),
				0,
				'still-drop-shadow',
			);
			// 200×200 red still centred (x 220…420); the shadow is shifted 0.2 × 200 = 40 px right: x 420…460.
			expect(at(raw, 440, FX_H / 2)[1]).toBeGreaterThan(200);
			expect(at(raw, FX_W / 2, FX_H / 2)[0]).toBeGreaterThan(200);
		});

		it('S_Flashbulbs (time-dependent) differs between frames', async () => {
			// On a still image (the source does not change between frames; only the flashes do).
			const doc = fxSnapshot([
				...fxCmd.still(media),
				fxCmd.effect('jasper.s.flashbulbs', { flashes: 12, flashSize: 3 }),
			]);
			const a = await still(doc, 4, 'flash-4');
			const b = await still(doc, 5, 'flash-5');
			expect(diff(a, b)).toBeGreaterThan(0.5);
		});
	},
);
