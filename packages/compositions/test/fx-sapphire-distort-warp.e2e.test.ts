// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

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
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			if (keep) mkdirSync(keep, { recursive: true });
			console.info(`[fx-dw] stills in ${media.dir}`);
		}, 300_000);

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
	},
);
