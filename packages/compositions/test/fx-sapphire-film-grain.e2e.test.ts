// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { type FxMedia, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

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
	},
);
