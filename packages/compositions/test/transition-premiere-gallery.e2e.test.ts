// @vitest-environment node
// This gallery only checks that middle frames differ from before and after; inspect the PNGs for visual quality.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Command, TRANSITION_SPECS } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.PREMIERE_GALLERY;
const enabled = process.env.REMOTION_E2E === '1' && !!out;
const CUT = 30;
const SPAN = 20;

/** The Premiere family (ids `jasper.*` that are GPU transitions, not `jasper.s.*`). */
const IDS = (process.env.PREMIERE_GALLERY_IDS?.split(',') ??
	TRANSITION_SPECS.filter((s) => s.gpu && !s.id.startsWith('jasper.s.')).map((s) => s.id)) as string[];

describe.runIf(enabled)(
	'Premiere transition gallery (REMOTION_E2E=1, PREMIERE_GALLERY=<dir>)',
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
			media = await startFxMedia('premiere-gallery-');
			execFileSync('ffmpeg', [
				'-v',
				'error',
				'-y',
				'-f',
				'lavfi',
				'-i',
				`mandelbrot=s=${FX_W}x${FX_H}:r=30:start_scale=1.2:end_scale=0.05`,
				'-t',
				'2',
				'-pix_fmt',
				'yuv420p',
				'-c:v',
				'libx264',
				join(media.dir, 'b.mp4'),
			]);
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, '..', 'src', 'remotion-entry.ts') });
			renderer = await import('@remotion/renderer');
			mkdirSync(out!, { recursive: true });
		}, 600_000);
		afterAll(() => media?.close());

		/** Clip k (0-based) of the sequence: alternately A and B, 30 frames each, with 15-frame handles. */
		const doc = (): Command[] => {
			const cmds: Command[] = [
				{
					type: 'media.register',
					ref: '$a',
					asset: fxAsset(media, 'video', media.video, FX_W, FX_H),
				} as Command,
				{ type: 'media.register', ref: '$b', asset: fxAsset(media, 'video', 'b.mp4', FX_W, FX_H) } as Command,
			];
			for (let k = 0; k <= IDS.length; k++)
				cmds.push({
					type: 'clip.place',
					source: { mediaId: k % 2 ? '$b' : '$a' },
					at: k * CUT,
					sourceRange: { in: { seconds: 0.5 }, out: { seconds: 1.5 } },
					tracks: { video: 'V1' },
				} as unknown as Command);
			for (const [k, effectId] of IDS.entries())
				cmds.push({
					type: 'transition.add',
					trackId: 'V1',
					at: (k + 1) * CUT,
					effectId,
					duration: SPAN,
					...(TRANSITION_SPECS.find((s) => s.id === effectId)?.params.some((p) => p.name === 'borderWidth')
						? { params: { borderWidth: 4, borderColor: [1, 1, 1, 1] } }
						: {}),
				} as Command);
			return cmds;
		};

		it('renders 25 / 50 / 75 % of every transition', async () => {
			const inputProps = {
				doc: fxSnapshot(doc()),
				options: { isPreview: false, useProxies: false, transparentBackground: false },
			};
			const composition = await renderer.selectComposition({
				serveUrl,
				id: SEQUENCE_COMPOSITION_ID,
				inputProps,
				...browser,
			});
			const raw = (file: string) =>
				execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
			const diff = (a: Buffer, b: Buffer) => {
				let d = 0;
				for (let i = 0; i < a.length; i += 31) d += Math.abs(a[i]! - b[i]!);
				return d;
			};
			const flat: string[] = [];
			for (const [k, id] of IDS.entries()) {
				const cut = (k + 1) * CUT;
				// Span cut − 10 … cut + 9; linear progress (i + 1) / 21.
				const frames: Buffer[] = [];
				for (const [tag, f] of [
					['25', cut - 6],
					['50', cut],
					['75', cut + 5],
				] as const) {
					const file = join(out!, `${id.replace(/^jasper\./, '')}-${tag}.png`);
					await renderer.renderStill({
						composition,
						serveUrl,
						inputProps,
						frame: f,
						output: file,
						...browser,
					});
					frames.push(raw(file));
				}
				if (!(diff(frames[0]!, frames[1]!) > 0 && diff(frames[1]!, frames[2]!) > 0)) flat.push(id);
			}
			expect(flat).toEqual([]);
		});
	},
);
