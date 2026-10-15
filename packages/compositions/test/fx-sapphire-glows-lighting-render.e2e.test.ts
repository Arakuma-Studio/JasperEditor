// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

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
		const diff = (a: Buffer, b: Buffer) => {
			let d = 0;
			for (let i = 0; i < a.length; i += 7) d += Math.abs(a[i]! - b[i]!);
			return d / (a.length / 7);
		};

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
