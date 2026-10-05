// @vitest-environment node
// Visual gallery of the example GPU transitions over real footage (wave-2 transition framework): renders a few
// frames of each example between a testsrc2 video (A) and a red still (B) with @remotion/renderer and writes the
// PNGs (TRANSITION_GALLERY=<dir>) for a human look. Asserts only that the frames differ from both sides mid-way.
// Gated by REMOTION_E2E=1 and TRANSITION_GALLERY.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.TRANSITION_GALLERY;
const enabled = process.env.REMOTION_E2E === '1' && !!out;

describe.runIf(enabled)(
	'GPU transition gallery (REMOTION_E2E=1, TRANSITION_GALLERY=<dir>)',
	{ timeout: 600_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};

		beforeAll(async () => {
			media = await startFxMedia('transition-gallery-');
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, '..', 'src', 'remotion-entry.ts') });
			renderer = await import('@remotion/renderer');
			mkdirSync(out!, { recursive: true });
		}, 300_000);
		afterAll(() => media?.close());

		const doc = (effectId: string, params?: Record<string, unknown>): Command[] => [
			{
				type: 'media.register',
				ref: '$m',
				asset: fxAsset(media, 'video', media.video, FX_W, FX_H),
			} as Command,
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
				tracks: { video: 'V1' },
			} as unknown as Command,
			{ type: 'media.register', ref: '$s', asset: fxAsset(media, 'image', 'red.png', 200, 200) } as Command,
			{
				type: 'clip.place',
				source: { mediaId: '$s' },
				at: 30,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
				tracks: { video: 'V1' },
				scaling: 'fill',
			} as unknown as Command,
			{
				type: 'transition.add',
				trackId: 'V1',
				at: 30,
				effectId,
				duration: 20,
				...(params ? { params } : {}),
			} as Command,
		];

		for (const [effectId, params] of [
			['jasper.push', { borderWidth: 6, borderColor: [1, 1, 1, 1] }],
			['jasper.cross-zoom', undefined],
			['jasper.iris-round', { borderWidth: 8, borderColor: [1, 1, 0, 1], center: [0.3, 0.4] }],
			['jasper.s.dissolve-luma', undefined],
		] as const)
			it(effectId, async () => {
				const frames: Buffer[] = [];
				for (const f of [22, 27, 30, 33, 38]) {
					const inputProps = {
						doc: fxSnapshot(doc(effectId, params as Record<string, unknown> | undefined)),
						options: { isPreview: false, useProxies: false, transparentBackground: false },
					};
					const composition = await renderer.selectComposition({
						serveUrl,
						id: SEQUENCE_COMPOSITION_ID,
						inputProps,
						...browser,
					});
					const file = join(media.dir, `${effectId}-${f}.png`);
					await renderer.renderStill({
						composition,
						serveUrl,
						inputProps,
						frame: f,
						output: file,
						...browser,
					});
					copyFileSync(file, join(out!, `${effectId}-${f}.png`));
					frames.push(
						execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']),
					);
				}
				const diff = (a: Buffer, b: Buffer) => {
					let d = 0;
					for (let i = 0; i < a.length; i += 31) d += Math.abs(a[i]! - b[i]!);
					return d;
				};
				expect(diff(frames[0]!, frames[4]!)).toBeGreaterThan(0);
			});
	},
);
