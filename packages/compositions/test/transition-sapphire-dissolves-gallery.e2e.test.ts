// @vitest-environment node
// Visual gallery of the Sapphire-style dissolves (registry/transitions/sapphire-dissolves.ts) over footage: renders
// each dissolve at progress 0.25 / 0.5 / 0.75 with @remotion/renderer (the export path) and writes the PNGs to
// $SD_GALLERY for a human look. A is a video, B a still: by default a testsrc2 clip and a generated pattern; set
// SD_GALLERY_A (an image, panned into a 2 s clip) and SD_GALLERY_B (an image) to use real photographs. SD_GALLERY_IDS
// (comma-separated ids or labels) limits the run. Asserts that the middle frame differs from the quarter frames.
// Gated by REMOTION_E2E=1 and SD_GALLERY.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Command, TRANSITION_FAMILIES } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.SD_GALLERY;
const enabled = process.env.REMOTION_E2E === '1' && !!out;
const only = (process.env.SD_GALLERY_IDS ?? '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
const specs = (TRANSITION_FAMILIES.find((f) => f.file === 'sapphire-dissolves')?.transitions ?? []).filter(
	(s) => only.length === 0 || only.includes(s.id) || only.includes(s.label),
);

// A 23-frame centred transition at the cut (frame 30) spans frames 19…41; frame f has progress (f − 18) / 24.
const FRAMES = [
	[24, '025'],
	[30, '050'],
	[36, '075'],
] as const;

describe.runIf(enabled)('Sapphire dissolves gallery (REMOTION_E2E=1, SD_GALLERY=<dir>)', { timeout: 1_800_000 }, () => {
	let media: FxMedia;
	let serveUrl: string;
	let renderer: typeof import('@remotion/renderer');
	const browserExecutable =
		process.env.JASPER_BROWSER_EXECUTABLE ??
		(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
	const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};
	let videoA = '';

	beforeAll(async () => {
		media = await startFxMedia('sd-gallery-');
		const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
		const a = process.env.SD_GALLERY_A;
		videoA = media.video;
		if (a && existsSync(a)) {
			// A slow push-in over the photo, so side A moves.
			ff([
				...['-loop', '1', '-i', a, '-t', '2', '-r', '30'],
				...['-vf', `scale=${FX_W * 2}:${FX_H * 2}:force_original_aspect_ratio=increase,crop=${FX_W * 2}:${FX_H * 2},zoompan=z='1+0.002*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${FX_W}x${FX_H}:fps=30`],
				...['-pix_fmt', 'yuv420p', '-c:v', 'libx264', join(media.dir, 'a.mp4')],
			]);
			videoA = 'a.mp4';
		}
		const b = process.env.SD_GALLERY_B;
		if (b && existsSync(b))
			ff(['-i', b, '-vf', `scale=${FX_W}:${FX_H}:force_original_aspect_ratio=increase,crop=${FX_W}:${FX_H}`, join(media.dir, 'b.png')]);
		else ff(['-f', 'lavfi', '-i', `mandelbrot=s=${FX_W}x${FX_H}`, '-frames:v', '1', join(media.dir, 'b.png')]);
		const { bundle } = await import('@remotion/bundler');
		serveUrl = await bundle({ entryPoint: join(here, '..', 'src', 'remotion-entry.ts') });
		renderer = await import('@remotion/renderer');
		mkdirSync(out!, { recursive: true });
	}, 300_000);
	afterAll(() => media?.close());

	const doc = (effectId: string): Command[] => [
		{ type: 'media.register', ref: '$m', asset: fxAsset(media, 'video', videoA, FX_W, FX_H) } as Command,
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
		{ type: 'transition.add', trackId: 'V1', at: 30, effectId, duration: 23 } as Command,
	];

	for (const spec of specs)
		it(spec.label, async () => {
			const frames: Buffer[] = [];
			for (const [f, tag] of FRAMES) {
				const inputProps = {
					doc: fxSnapshot(doc(spec.id)),
					options: { isPreview: false, useProxies: false, transparentBackground: false },
				};
				const composition = await renderer.selectComposition({
					serveUrl,
					id: SEQUENCE_COMPOSITION_ID,
					inputProps,
					...browser,
				});
				const file = join(media.dir, `${spec.label}-${tag}.png`);
				await renderer.renderStill({ composition, serveUrl, inputProps, frame: f, output: file, ...browser });
				copyFileSync(file, join(out!, `${spec.label}-${tag}.png`));
				frames.push(
					execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']),
				);
			}
			const diff = (a: Buffer, b: Buffer) => {
				let d = 0;
				for (let i = 0; i < a.length; i += 31) d += Math.abs(a[i]! - b[i]!);
				return d;
			};
			expect(diff(frames[0]!, frames[2]!)).toBeGreaterThan(0);
		});
});
