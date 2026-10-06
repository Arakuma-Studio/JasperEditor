// @vitest-environment node
// Visual gallery of the Sapphire wipes (family sapphire-wipes-other) over footage: renders frames at progress ≈ 0.25,
// 0.5 and 0.75 of each S_Wipe* between a testsrc2 video (A) and a colourful still (B, ffmpeg's mandelbrot) with
// @remotion/renderer, writes the PNGs to SAPPHIRE_WIPES_GALLERY=<dir> for a human look, and asserts that every
// mid-way frame differs from both sides. Gated by REMOTION_E2E=1 and SAPPHIRE_WIPES_GALLERY.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Command, TRANSITION_FAMILIES } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.SAPPHIRE_WIPES_GALLERY;
const enabled = process.env.REMOTION_E2E === '1' && !!out;
const WIPES = TRANSITION_FAMILIES.find((f) => f.file === 'sapphire-wipes-other')?.transitions ?? [];
/** SAPPHIRE_WIPES_ONLY=Clock,Star renders a subset. */
const ONLY = process.env.SAPPHIRE_WIPES_ONLY?.split(',');

/** Showcase params (borders and glows on some, so they get looked at too). */
const SHOWCASE: Record<string, Record<string, unknown>> = {
	'jasper.s.wipe-line': { borderWidth: 6, borderGlow: 1.2, glowWidth: 14 },
	'jasper.s.wipe-circle': { borderWidth: 5, edgeSoftness: 4 },
	'jasper.s.wipe-clock': { borderWidth: 4, borderColor: [1, 1, 1, 1] },
	'jasper.s.wipe-star': { wipeDirection: 'starOut', borderWidth: 4, borderGlow: 1, glowWidth: 10 },
	'jasper.s.wipe-rectangle': { borderWidth: 6, angle: 15 },
	'jasper.s.wipe-cells': { borderWidth: 3 },
	'jasper.s.wipe-blobs': { borderGlow: 1.5, glowWidth: 8, edgeSoftness: 2 },
	'jasper.s.wipe-tiles': { borderWidth: 2, borderColor: [1, 1, 1, 1] },
	'jasper.s.wipe-flux': { borderWidth: 3 },
	'jasper.s.wipe-wedge': { borderWidth: 4 },
};

describe.runIf(enabled)(
	'Sapphire wipes gallery (REMOTION_E2E=1, SAPPHIRE_WIPES_GALLERY=<dir>)',
	{ timeout: 3_600_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};

		beforeAll(async () => {
			media = await startFxMedia('sapphire-wipes-gallery-');
			execFileSync('ffmpeg', [
				'-v',
				'error',
				'-y',
				'-f',
				'lavfi',
				'-i',
				`mandelbrot=s=${FX_W}x${FX_H}:start_scale=1.6`,
				'-frames:v',
				'1',
				join(media.dir, 'b.png'),
			]);
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
			{ type: 'media.register', ref: '$s', asset: fxAsset(media, 'image', 'b.png', FX_W, FX_H) } as Command,
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

		// A 20-frame transition centred on the cut at 30 spans frames 20…39: progress (i + 1) / 21.
		const FRAMES = [24, 30, 35];
		for (const spec of WIPES.filter((s) => !ONLY || ONLY.some((o) => s.label.includes(o))))
			it(spec.label, async () => {
				const inputProps = {
					doc: fxSnapshot(doc(spec.id, SHOWCASE[spec.id])),
					options: { isPreview: false, useProxies: false, transparentBackground: false },
				};
				const composition = await renderer.selectComposition({
					serveUrl,
					id: SEQUENCE_COMPOSITION_ID,
					inputProps,
					...browser,
				});
				const raw: Buffer[] = [];
				for (const f of [18, ...FRAMES, 41]) {
					const file = join(media.dir, `${spec.label}-${f}.png`);
					await renderer.renderStill({
						composition,
						serveUrl,
						inputProps,
						frame: f,
						output: file,
						...browser,
					});
					if (FRAMES.includes(f)) copyFileSync(file, join(out!, `${spec.label}-${f}.png`));
					raw.push(
						execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']),
					);
				}
				const diff = (a: Buffer, b: Buffer) => {
					let d = 0;
					for (let i = 0; i < a.length; i += 31) d += Math.abs(a[i]! - b[i]!);
					return d;
				};
				const [a, , mid, , b] = raw;
				expect(diff(mid!, a!)).toBeGreaterThan(0);
				expect(diff(mid!, b!)).toBeGreaterThan(0);
			});
	},
);
