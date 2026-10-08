// @vitest-environment node
// Documentation contact sheets (wp fixups): renders effect families and the Sapphire-style dissolves with
// @remotion/renderer (the export path) over procedural pictures from scripts/docs/gallery-scenes.mjs — ffmpeg lavfi
// sources only, no photographs — and writes labelled contact sheets into docs/screenshots (each sheet's
// `.attribution` sidecar names this file). They replace sheets that were removed because they showed third-party
// photographs (ATTRIBUTION.md). Every effect / transition is rendered at its defaults on a 2 s clip panning over
// the picture (frame 15); transitions at progress 0.25 / 0.5 / 0.75. Asserts each still rendered at full size.
// Gated by REMOTION_E2E=1 and DOCS_GALLERY=1; DOCS_GALLERY_ONLY=<sheet ids, comma-separated> limits the run.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Command, defaultRegistries, TRANSITION_SPECS } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sceneA, sceneB } from '../../../scripts/docs/gallery-scenes.mjs';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const enabled = process.env.REMOTION_E2E === '1' && process.env.DOCS_GALLERY === '1';
const only = (process.env.DOCS_GALLERY_ONLY ?? '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

type Sheet = { id: string; out: string; labels: string[]; kind: 'effect' | 'transition'; cols: number };

const SHEETS: Sheet[] = [
	{
		id: 'premiere-adjust-color-keying',
		out: 'docs/screenshots/fx/premiere-adjust-color-keying/contact-sheet.png',
		kind: 'effect',
		cols: 8,
		labels: [
			'Auto Color',
			'Auto Contrast',
			'Auto Levels',
			'Convolution Kernel',
			'Extract',
			'Levels',
			'Lighting Effects',
			'ProcAmp',
			'Camera Blur',
			'Channel Blur',
			'Compound Blur',
			'Directional Blur',
			'Reduce Interlace Flicker',
			'Sharpen',
			'Unsharp Mask',
			'Arithmetic',
			'Blend',
			'Calculations',
			'Compound Arithmetic',
			'Invert',
			'Set Matte',
			'Solid Composite',
			'Change Color',
			'Change to Color',
			'Channel Mixer',
			'Color Balance',
			'Color Balance (HLS)',
			'Equalize',
			'Leave Color',
			'Tint',
			'Video Limiter',
			'Color Balance (RGB)',
			'Color Pass',
			'Color Replace',
			'Gamma Correction',
			'Ultra Key',
			'Alpha Adjust',
			'Color Key',
			'Difference Matte',
			'Image Matte Key',
			'Luma Key',
			'Non Red Key',
			'Remove Matte',
			'Track Matte Key',
			'Basic 3D',
			'Bevel Alpha',
			'Bevel Edges',
			'Drop Shadow',
			'Radial Shadow',
			'Edge Feather',
			'Transform',
			'Cineon Converter',
		],
	},
	{
		id: 'sapphire-film-grain',
		out: 'docs/screenshots/fx/sapphire-film-grain/contact-sheet.png',
		kind: 'effect',
		cols: 6,
		labels: [
			'S_FilmEffect',
			'S_FilmDamage',
			'S_FilmBurn',
			'S_Vignette',
			'S_BleachBypass',
			'S_Grain',
			'S_GrainStatic',
			'S_UltraGrain',
			'S_Diffuse',
			'S_VintageColor2Strip',
			'S_VintageColor3Strip',
			'S_ScanLines',
			'S_ScanLinesMono',
			'S_VHSDamage',
			'S_TVDamage',
			'S_JpegDamage',
			'S_DigitalDamage',
			'S_Grunge',
		],
	},
	{
		id: 'sapphire-paint-kaleido-edges',
		out: 'docs/screenshots/fx/sapphire-paint-kaleido-edges/contact-sheet.png',
		kind: 'effect',
		cols: 6,
		labels: [
			'S_AutoPaint',
			'S_Sketch',
			'S_Etching',
			'S_Brush:Oil',
			'S_Brush:Chalk',
			'S_Crosshatch',
			'S_Cartoon',
			'S_CartoonPaint',
			'S_Posterize',
			'S_HalfTone',
			'S_HalfToneColor',
			'S_HalfToneRings',
			'S_Kaleido:Triangles',
			'S_Kaleido:Squares',
			'S_Kaleido:Diamonds',
			'S_Kaleido:Oct',
			'S_KaleidoPolar',
			'S_KaleidoRadial',
			'S_FlysEyeCircles',
			'S_FlysEyeHex',
			'S_FlysEyeRect',
			'S_TileScramble',
			'S_EdgeDetect',
			'S_EdgeDetectDouble',
			'S_EdgesInDirection',
			'S_EdgeColorize',
			'S_Emboss',
			'S_EmbossShiny',
			'S_EmbossDistort',
			'S_EmbossGlass',
		],
	},
	{
		id: 'sapphire-render-textures',
		out: 'docs/screenshots/fx/sapphire-render-textures/contact-sheet.png',
		kind: 'effect',
		cols: 6,
		labels: [
			'S_Zap',
			'S_UltraZap',
			'S_ZapTo',
			'S_ZapFrom',
			'S_Gradient',
			'S_GradientMulti',
			'S_GradientRadial',
			'S_Grid',
			'S_Shape',
			'S_Aurora',
			'S_LaserBeam',
			'S_MuzzleFlash',
			'S_Luna',
			'S_NightSky',
			'S_Caustics',
			'S_Dust',
			'S_Sparkles',
			'S_SparklesColor',
		],
	},
	{
		id: 'sapphire-stylize-other',
		out: 'docs/screenshots/fx/sapphire-stylize-other/contact-sheet.png',
		kind: 'effect',
		cols: 6,
		labels: [
			'S_BandPass',
			'S_ColorFuse',
			'S_DogVision',
			'S_Mosaic',
			'S_PixelMosh',
			'S_PixelSort',
			'S_PrismLens',
			'S_PseudoColor',
			'S_PsykoBlobs',
			'S_PsykoStripes',
			'S_RomanTile',
			'S_Solarize',
			'S_StripSlide',
			'S_Zebrafy',
			'S_ZebrafyColor',
			'S_ZFogExponential',
			'S_ZFogLinear',
		],
	},
	{
		id: 'sapphire-dissolves',
		out: 'docs/screenshots/transitions/sapphire-dissolves/contact-sheet.jpg',
		kind: 'transition',
		cols: 6,
		labels: TRANSITION_SPECS.filter((t) => t.id.startsWith('jasper.s.dissolve')).map((t) => t.label),
	},
];

// A 23-frame centred transition at the cut (frame 30) spans frames 19…41; frame f has progress (f − 18) / 24.
const TRANSITION_FRAMES = [24, 30, 36];
const TILE_W = 256;
const TILE_H = 144;

describe.runIf(enabled)(
	'documentation contact sheets (REMOTION_E2E=1, DOCS_GALLERY=1)',
	{ timeout: 3_600_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};
		const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
		let video = 'scene.mp4';

		beforeAll(async () => {
			media = await startFxMedia('docs-gallery-');
			sceneA(join(media.dir, 'scene.png'));
			sceneB(join(media.dir, 'scene-b.png'));
			// Side A moves (time effects, transitions): a slow push-in over the picture, 2 s at 30 fps.
			const pan = [
				...['-loop', '1', '-i', join(media.dir, 'scene.png'), '-t', '2', '-r', '30'],
				...[
					'-vf',
					`scale=${FX_W * 2}:${FX_H * 2},zoompan=z='1+0.002*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${FX_W}x${FX_H}:fps=30`,
				],
			];
			try {
				ff([...pan, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', join(media.dir, video)]);
			} catch {
				video = 'scene.webm';
				ff([...pan, '-c:v', 'libvpx-vp9', join(media.dir, video)]);
			}
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, '..', 'src', 'remotion-entry.ts') });
			renderer = await import('@remotion/renderer');
		}, 600_000);
		afterAll(() => media?.close());

		const sideA = (): Command[] => [
			{ type: 'media.register', ref: '$m', asset: fxAsset(media, 'video', video, FX_W, FX_H) } as Command,
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
				tracks: { video: 'V1' },
				ref: '$c',
			} as unknown as Command,
		];
		const effectDoc = (effectId: string): Command[] => [...sideA(), fxCmd.effect(effectId, {})];
		const transitionDoc = (effectId: string): Command[] => [
			...sideA(),
			{
				type: 'media.register',
				ref: '$s',
				asset: fxAsset(media, 'image', 'scene-b.png', FX_W, FX_H),
			} as Command,
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

		async function still(commands: Command[], frame: number, name: string): Promise<string> {
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
			const output = join(media.dir, `${name}.png`);
			await renderer.renderStill({
				composition,
				serveUrl,
				inputProps,
				frame,
				output,
				timeoutInMilliseconds: 240_000,
				...browser,
			});
			const raw = execFileSync(
				'ffmpeg',
				['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
				{
					maxBuffer: 1 << 26,
				},
			);
			expect(raw.length, name).toBe(FX_W * FX_H * 3);
			return output;
		}

		/** Labelled grid of TILE_W×TILE_H tiles; `labels[i]` is drawn on tile i (null = no label). */
		function sheet(tiles: { file: string; label: string | null }[], cols: number, out: string) {
			const rows = Math.ceil(tiles.length / cols);
			const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '');
			const parts = tiles.map(
				(t, i) =>
					`[${i}]scale=${TILE_W}:${TILE_H}${t.label ? `,drawtext=text='${esc(t.label)}':x=4:y=4:fontsize=13:fontcolor=white:box=1:boxcolor=black@0.6` : ''}[t${i}]`,
			);
			for (let i = tiles.length; i < rows * cols; i++)
				parts.push(`color=c=0x202020:s=${TILE_W}x${TILE_H}:d=1[t${i}]`);
			const layout = Array.from(
				{ length: rows * cols },
				(_, i) => `${(i % cols) * TILE_W}_${Math.floor(i / cols) * TILE_H}`,
			).join('|');
			const stack = `${Array.from({ length: rows * cols }, (_, i) => `[t${i}]`).join('')}xstack=inputs=${rows * cols}:layout=${layout}`;
			const tail = out.endsWith('.png')
				? `${stack},split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=sierra2_4a`
				: stack;
			mkdirSync(dirname(out), { recursive: true });
			ff([
				...tiles.flatMap((t) => ['-i', t.file]),
				'-filter_complex',
				`${parts.join(';')};${tail}`,
				...(out.endsWith('.jpg') ? ['-q:v', '4'] : []),
				'-frames:v',
				'1',
				out,
			]);
			expect(statSync(out).size).toBeGreaterThan(10_000);
		}

		const effects = defaultRegistries().effects.list();
		for (const s of SHEETS.filter((x) => only.length === 0 || only.includes(x.id)))
			it(s.id, async () => {
				const tiles: { file: string; label: string | null }[] = [];
				if (s.kind === 'effect') {
					tiles.push({ file: await still(sideA(), 15, `${s.id}-source`), label: 'Source' });
					for (const label of s.labels) {
						const spec = effects.find((e) => e.label === label);
						expect(spec, `no effect labelled ${label}`).toBeTruthy();
						tiles.push({ file: await still(effectDoc(spec!.id), 15, `${s.id}-${spec!.id}`), label });
					}
				} else {
					for (const label of s.labels) {
						const spec = TRANSITION_SPECS.find((t) => t.label === label)!;
						for (const [k, f] of TRANSITION_FRAMES.entries())
							tiles.push({
								file: await still(transitionDoc(spec.id), f, `${s.id}-${spec.id}-${f}`),
								label: k === 0 ? label.replace(/^S_/, '') : null,
							});
					}
				}
				expect(tiles.length).toBeGreaterThan(s.labels.length);
				sheet(tiles, s.cols, join(repo, s.out));
			});
	},
);
