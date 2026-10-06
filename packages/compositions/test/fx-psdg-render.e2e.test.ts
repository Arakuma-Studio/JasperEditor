// @vitest-environment node
// The premiere-stylize-distort-generate family on the Remotion render path (REMOTION_E2E=1): bundles the
// compositions (production registry: the family is registered by default), renders one still per effect with
// representative settings over a picture (PSDG_PHOTO=<640×360 png> if set, else frame 10 of the testsrc2 video) with
// @remotion/renderer in headless Chrome (WebGL2 via ANGLE/SwiftShader), and checks each still rendered and changed
// the picture. PSDG_SHEET=<file.png> also writes a labelled contact sheet of every still (ffmpeg xstack + drawtext).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

/** [label, effect id, params, frame] — the family's contact sheet. */
export const PSDG_SHOWCASE: [string, string, Record<string, unknown>, number?][] = [
	[
		'Lens Distortion',
		'jasper.lens-distortion',
		{ curvature: 60, fillAlpha: true, fillColor: [0.05, 0.05, 0.1, 1] },
	],
	['Magnify', 'jasper.magnify', { magnification: 250, center: [0.42, 0.62], size: 80, feather: 6 }],
	['Mirror', 'jasper.mirror', {}],
	['Offset', 'jasper.offset', { shiftCenterTo: [0.25, 0.4] }],
	['Spherize', 'jasper.spherize', { radius: 150, centerOfSphere: [0.45, 0.55] }],
	['Turbulent Displace', 'jasper.turbulent-displace', { amount: 60, complexity: 2 }],
	['Twirl', 'jasper.twirl', { angle: 200 }],
	['Wave Warp', 'jasper.wave-warp', { waveHeight: 14, waveWidth: 70 }],
	['4-Color Gradient', 'jasper.4-color-gradient', { blendingMode: 'overlay', opacity: 80 }],
	['Cell Pattern', 'jasper.cell-pattern', { cellPattern: 'crystals' }],
	['Checkerboard', 'jasper.checkerboard', { blendingMode: 'normal', opacity: 40, width: 40 }],
	['Circle', 'jasper.circle', { radius: 120, featherOuter: 40, blendingMode: 'stencilAlpha' }],
	['Ellipse', 'jasper.ellipse', { width: 400, height: 200, compositeOnOriginal: true }],
	[
		'Eyedropper Fill',
		'jasper.eyedropper-fill',
		{ samplePoint: [0.6, 0.6], sampleRadius: 20, blendWithOriginal: 50 },
	],
	['Grid', 'jasper.grid', { blendingMode: 'normal', sizeFrom: 'widthSlider', width: 40, border: 2 }],
	[
		'Ramp',
		'jasper.ramp',
		{ rampShape: 'radial', startOfRamp: [0.5, 0.5], endOfRamp: [1, 1], blendWithOriginal: 40 },
	],
	['Lens Flare', 'jasper.lens-flare', { flareCenter: [0.3, 0.25] }],
	['Lightning', 'jasper.lightning', { startPoint: [0.15, 0.1], endPoint: [0.7, 0.9], width: 6 }, 12],
	['Paint Bucket', 'jasper.paint-bucket', { fillPoint: [0.1, 0.2], tolerance: 40 }],
	['Write-on', 'jasper.write-on', { brushSize: 40, color: [1, 0.2, 0.2, 1] }],
	['Dust & Scratches', 'jasper.dust-and-scratches', { radius: 3, threshold: 20 }],
	['Median', 'jasper.median', { radius: 8 }],
	['Noise', 'jasper.noise', { amount: 30 }],
	['Noise Alpha', 'jasper.noise-alpha', { amount: 60 }],
	['Noise HLS', 'jasper.noise-hls', { noise: 'grain', grainSize: 2, lightness: 30, saturation: 30 }],
	['Noise HLS Auto', 'jasper.noise-hls-auto', { lightness: 30 }],
	['Alpha Glow', 'jasper.alpha-glow', { glow: 30, useEndColor: true, endColor: [1, 0.3, 0, 1] }],
	['Brush Strokes', 'jasper.brush-strokes', { brushSize: 3, strokeLength: 14 }],
	['Color Emboss', 'jasper.color-emboss', { relief: 3, contrast: 200 }],
	['Emboss', 'jasper.emboss', { relief: 3, contrast: 200 }],
	['Find Edges', 'jasper.find-edges', {}],
	['Mosaic', 'jasper.mosaic', { horizontalBlocks: 48, verticalBlocks: 27 }],
	['Posterize', 'jasper.posterize', { level: 4 }],
	['Replicate', 'jasper.replicate', { count: 3 }],
	['Roughen Edges', 'jasper.roughen-edges', { edgeType: 'roughenColor', border: 30 }],
	['Solarize', 'jasper.solarize', { threshold: 50 }],
	['Strobe Light', 'jasper.strobe-light', { blendWithOriginal: 50, strobeColor: [0.6, 0.8, 1, 1] }],
	['Texturize', 'jasper.texturize', {}],
	['Threshold', 'jasper.threshold', {}],
	['Echo', 'jasper.echo', { numberOfEchoes: 4, echoTime: -0.1, startingIntensity: 0.5, decay: 0.7 }, 10],
	['Posterize Time', 'jasper.posterize-time', { frameRate: 6 }, 10],
	['Clip Name', 'jasper.clip-name', { name: 'A001_C003_launch' }],
	['Timecode', 'jasper.timecode', {}, 10],
	['Simple Text', 'jasper.simple-text', { text: 'Premiere Simple Text' }],
	['Block Dissolve', 'jasper.block-dissolve', { completion: 45, blockWidth: 16, blockHeight: 16 }],
	['Gradient Wipe', 'jasper.gradient-wipe', { completion: 40, softness: 20 }],
	['Linear Wipe', 'jasper.linear-wipe', { completion: 40, feather: 40 }],
	['Radial Wipe', 'jasper.radial-wipe', { completion: 30, feather: 10 }],
	['Venetian Blinds', 'jasper.venetian-blinds', { completion: 40, width: 30 }],
	['Vignette', 'jasper.vignette', { amount: -3 }],
	['Glow', 'jasper.glow', { threshold: 50, radius: 50, intensity: 1.5 }],
];

/**
 * Effects that leave this picture unchanged with the showcase settings: Texturize needs a texture; Posterize Time and
 * Echo only show on moving pictures; Alpha Glow glows around the alpha edge, which a full-frame opaque layer has only
 * at the frame border (its glow lies outside the frame).
 */
const UNCHANGED = new Set(['jasper.texturize', 'jasper.posterize-time', 'jasper.echo', 'jasper.alpha-glow']);

describe.runIf(enabled)(
	'Premiere stylize/distort/generate in Remotion renders (REMOTION_E2E=1)',
	{ timeout: 1_800_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		let base: Command[];
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};

		beforeAll(async () => {
			media = await startFxMedia('fx-psdg-render-');
			const photo = process.env.PSDG_PHOTO;
			if (photo && existsSync(photo)) {
				copyFileSync(photo, join(media.dir, 'photo.png'));
				base = [
					{
						type: 'media.register',
						ref: '$m',
						asset: fxAsset(media, 'image', 'photo.png', FX_W, FX_H),
					} as unknown as Command,
					{
						type: 'clip.place',
						source: { mediaId: '$m' },
						at: 0,
						tracks: { video: 'V1' },
						ref: '$c',
					} as unknown as Command,
				];
			} else base = fxCmd.video(media, 2);
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			console.info(`[fx-psdg-render] stills in ${media.dir}`);
		}, 600_000);

		afterAll(() => {
			media?.close();
		});

		async function still(
			commands: Command[],
			frame: number,
			name: string,
		): Promise<{ file: string; raw: Buffer }> {
			const inputProps = {
				doc: fxSnapshot(commands),
				options: { isPreview: false, useProxies: false, transparentBackground: false },
			};
			const composition = await renderer.selectComposition({
				serveUrl,
				id: SEQUENCE_COMPOSITION_ID,
				inputProps,
				...browser,
			});
			const file = join(media.dir, `${name}.png`);
			await renderer.renderStill({ composition, serveUrl, inputProps, frame, output: file, ...browser });
			const raw = execFileSync(
				'ffmpeg',
				['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
				{
					maxBuffer: 1 << 26,
				},
			);
			return { file, raw };
		}
		const diff = (a: Buffer, b: Buffer) => {
			let d = 0;
			for (let i = 0; i < a.length; i += 7) d = Math.max(d, Math.abs(a[i]! - b[i]!));
			return d;
		};

		it('renders every effect of the family over the picture', async () => {
			const plain = new Map<number, Buffer>();
			const files: [string, string][] = [];
			const failures: string[] = [];
			for (const [label, id, params, frame = 0] of PSDG_SHOWCASE) {
				if (!plain.has(frame)) plain.set(frame, (await still(base, frame, `plain-${frame}`)).raw);
				const name = id.replace('jasper.', '');
				try {
					const r = await still([...base, fxCmd.effect(id, params)], frame, name);
					files.push([label, r.file]);
					const d = diff(r.raw, plain.get(frame)!);
					if (!UNCHANGED.has(id) && d < 12) failures.push(`${id}: no visible change (max diff ${d})`);
				} catch (e) {
					failures.push(`${id}: ${(e as Error).message.split('\n')[0]}`);
				}
			}
			const sheet = process.env.PSDG_SHEET;
			if (sheet) writeSheet(files, sheet);
			expect(failures).toEqual([]);
		});
	},
);

/** A labelled contact sheet (8 columns of 240×135 thumbnails) with ffmpeg. */
function writeSheet(files: [string, string][], out: string) {
	const cols = 8;
	const w = 240;
	const h = 135;
	const label = 18;
	const inputs = files.flatMap(([, f]) => ['-i', f]);
	const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
	const esc = (s: string) =>
		s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
	const cells = files.map(
		([name], i) =>
			`[${i}:v]scale=${w}:${h},pad=${w}:${h + label}:0:0:0x1d1d1d,drawtext=fontfile=${font}:text='${esc(name)}':fontcolor=0xdddddd:fontsize=12:x=4:y=${h + 3}[c${i}]`,
	);
	const layout = files.map((_, i) => `${(i % cols) * w}_${Math.floor(i / cols) * (h + label)}`).join('|');
	const filter = `${cells.join(';')};${files.map((_, i) => `[c${i}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=0x1d1d1d[out]`;
	execFileSync('ffmpeg', [
		'-v',
		'error',
		'-y',
		...inputs,
		'-filter_complex',
		filter,
		'-map',
		'[out]',
		'-frames:v',
		'1',
		out,
	]);
}
