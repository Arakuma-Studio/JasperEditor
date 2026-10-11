// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

type Rgb = [number, number, number];
type Shot = {
	name: string;
	label: string;
	layer: 'scene' | 'fg';
	effect?: string;
	params?: Record<string, unknown>;
};

const bg = { mediaId: '$bg' };
const SHOTS: Shot[] = [
	{ name: 'plain-scene', label: 'source (scene)', layer: 'scene' },
	{
		name: 'channel-switcher',
		label: 'S_ChannelSwitcher',
		layer: 'scene',
		effect: 'jasper.s.channel-switcher',
		params: { redFrom: 'blue', blueFrom: 'red' },
	},
	{
		name: 'clamp-chroma',
		label: 'S_ClampChroma 0.15',
		layer: 'scene',
		effect: 'jasper.s.clamp-chroma',
		params: { clampChroma: 0.15 },
	},
	{ name: 'duo-tone', label: 'S_DuoTone', layer: 'scene', effect: 'jasper.s.duo-tone' },
	{ name: 'gamma', label: 'S_Gamma 2.2', layer: 'scene', effect: 'jasper.s.gamma', params: { gamma: 2.2 } },
	{
		name: 'hotspots',
		label: 'S_Hotspots',
		layer: 'scene',
		effect: 'jasper.s.hotspots',
		params: { threshold: 0.75, blurInput: 0.01 },
	},
	{
		name: 'hue-sat-bright',
		label: 'S_HueSatBright',
		layer: 'scene',
		effect: 'jasper.s.hue-sat-bright',
		params: { hueShift: 0.33, saturation: 1.5 },
	},
	{ name: 'invert', label: 'S_Invert', layer: 'scene', effect: 'jasper.s.invert' },
	{
		name: 'invert-mask',
		label: 'S_Invert + Mask',
		layer: 'scene',
		effect: 'jasper.s.invert',
		params: { mask: { mediaId: '$mask' } },
	},
	{ name: 'monochrome', label: 'S_Monochrome', layer: 'scene', effect: 'jasper.s.monochrome' },
	{
		name: 'ocio',
		label: 'S_OCIOTransform sRGB>ACEScct',
		layer: 'scene',
		effect: 'jasper.s.ocio-transform',
		params: { from: 'srgb', to: 'acescct' },
	},
	{
		name: 'quad-tone',
		label: 'S_QuadTone',
		layer: 'scene',
		effect: 'jasper.s.quad-tone',
		params: {
			color3: [1, 0.95, 0.6, 1],
			color2: [0.9, 0.4, 0.3, 1],
			color1: [0.3, 0.2, 0.5, 1],
			color0: [0.05, 0.05, 0.15, 1],
		},
	},
	{ name: 'threshold', label: 'S_Threshold', layer: 'scene', effect: 'jasper.s.threshold' },
	{
		name: 'tint',
		label: 'S_Tint',
		layer: 'scene',
		effect: 'jasper.s.tint',
		params: { tintLights: [1, 0.85, 0.6, 1], tintDarks: [0.1, 0.05, 0.2, 1], sourceSaturation: 0 },
	},
	{
		name: 'tri-tone',
		label: 'S_TriTone',
		layer: 'scene',
		effect: 'jasper.s.tri-tone',
		params: { color1: [0.8, 0.3, 0.1, 1] },
	},
	{
		name: 'show-bad-colors',
		label: 'S_ShowBadColors',
		layer: 'scene',
		effect: 'jasper.s.show-bad-colors',
		params: { max: 0.9, minLuma: 0.08 },
	},
	{ name: 'plain-fg', label: 'source (fg with alpha)', layer: 'fg' },
	{
		name: 'edge-flash',
		label: 'S_EdgeFlash',
		layer: 'fg',
		effect: 'jasper.s.edge-flash',
		params: { background: bg, flashWidth: 0.1, fgFlashAmp: 1.5, bgFlashAmp: 1.5 },
	},
	{
		name: 'layer',
		label: 'S_Layer Overlay',
		layer: 'fg',
		effect: 'jasper.s.layer',
		params: { background: bg, effect: 'overlay' },
	},
	{
		name: 'math-ops',
		label: 'S_MathOps Difference',
		layer: 'fg',
		effect: 'jasper.s.math-ops',
		params: { sourceB: bg, operation: 'difference', opacity: 'allOpaque' },
	},
	{
		name: 'matte-ops',
		label: 'S_MatteOps shrink+noise',
		layer: 'fg',
		effect: 'jasper.s.matte-ops',
		params: { shrinkGrow: -12, edgeSoftness: 6, noiseAmplitude: 1, noiseWidth: 0.05, frequency: 12 },
	},
	{
		name: 'matte-ops-comp',
		label: 'S_MatteOpsComp grow',
		layer: 'fg',
		effect: 'jasper.s.matte-ops-comp',
		params: { background: bg, shrinkGrow: 10, edgeSoftness: 20 },
	},
	{
		name: 'z-comp',
		label: 'S_ZComp',
		layer: 'scene',
		effect: 'jasper.s.z-comp',
		params: { sourceB: bg, depthA: { mediaId: '$depthA' }, depthB: { mediaId: '$depthB' }, antiAlias: 0.1 },
	},
];

describe.runIf(enabled)(
	'sapphire-adjust-composite in Remotion renders (REMOTION_E2E=1)',
	{ timeout: 600_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};
		const raws = new Map<string, Buffer>();

		beforeAll(async () => {
			media = await startFxMedia('fx-sac-');
			const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
			const size = `${FX_W}x${FX_H}`;
			// Scene: colourful gradients, a bright soft sun, SMPTE bars and a grey ramp (a stand-in for a photo with a
			// full tonal range). Foreground: the scene inside a soft-edged circle (alpha). Background: a radial gradient.
			ff([
				...[
					'-f',
					'lavfi',
					'-i',
					`gradients=s=${size}:c0=0x0b132b:c1=0x3a86ff:c2=0xffbe0b:c3=0xfb5607:c4=0xff006e:c5=0x8ac926:n=6:x0=0:y0=0:x1=640:y1=360:seed=3`,
				],
				...['-f', 'lavfi', '-i', 'smptebars=s=200x112', '-f', 'lavfi', '-i', 'color=black:s=640x36'],
				...['-f', 'lavfi', '-i', 'color=white:s=90x90', '-filter_complex'],
				"[2:v]format=gray,geq=lum='X*255/W',format=rgb24[ramp];[3:v]format=rgba,geq=r=255:g=250:b=235:a='clip((44-hypot(X-45,Y-45))*40,0,255)'[sun];[0:v][1:v]overlay=420:20[a];[a][ramp]overlay=0:324[b];[b][sun]overlay=90:40",
				...['-frames:v', '1', join(media.dir, 'scene.png')],
			]);
			ff([
				...['-i', join(media.dir, 'scene.png'), '-frames:v', '1'],
				...[
					'-vf',
					"format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip((130-hypot(X-320,Y-180))*64,0,255)'",
				],
				join(media.dir, 'fg.png'),
			]);
			ff([
				...[
					'-f',
					'lavfi',
					'-i',
					`gradients=s=${size}:c0=0x264653:c1=0x2a9d8f:c2=0xe9c46a:c3=0xf4a261:c4=0xe76f51:n=5:type=radial:x0=320:y0=180:x1=0:y1=0:seed=9`,
				],
				...['-frames:v', '1', join(media.dir, 'bg.png')],
			]);
			// Masks / depth maps: a radial mask, a horizontal ramp (Depth A) and mid grey (Depth B).
			const gray = (expr: string, name: string) =>
				ff([
					'-f',
					'lavfi',
					'-i',
					`color=black:s=${size}`,
					'-frames:v',
					'1',
					'-vf',
					`format=gray,geq=lum='${expr}'`,
					join(media.dir, name),
				]);
			gray('clip((200-hypot(X-320,Y-180))*2,0,255)', 'mask.png');
			gray('X*255/W', 'depthA.png');
			gray('128', 'depthB.png');
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			console.info(`[fx-sac] stills in ${media.dir}`);
		}, 300_000);

		afterAll(() => {
			media?.close();
		});

		const image = (ref: string, name: string): Command =>
			({
				type: 'media.register',
				ref,
				asset: fxAsset(media, 'image', name, FX_W, FX_H),
			}) as unknown as Command;

		async function render(shot: Shot): Promise<Buffer> {
			const layer = [
				image('$m', shot.layer === 'scene' ? 'scene.png' : 'fg.png'),
				{
					type: 'clip.place',
					source: { mediaId: '$m' },
					at: 0,
					tracks: { video: 'V1' },
					ref: '$c',
				} as unknown as Command,
			];
			const doc = fxSnapshot([
				image('$bg', 'bg.png'),
				image('$mask', 'mask.png'),
				image('$depthA', 'depthA.png'),
				image('$depthB', 'depthB.png'),
				...layer,
				...(shot.effect ? [fxCmd.effect(shot.effect, shot.params)] : []),
			]);
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
			const output = join(media.dir, `${shot.name}.png`);
			await renderer.renderStill({ composition, serveUrl, inputProps, frame: 2, output, ...browser });
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
		const meanDiff = (a: Buffer, b: Buffer) => {
			let d = 0;
			let n = 0;
			for (let i = 0; i < a.length; i += 31, n++) d += Math.abs(a[i]! - b[i]!);
			return d / n;
		};

		it('renders every effect of the family', async () => {
			for (const s of SHOTS) raws.set(s.name, await render(s));
			const video = raws.get('plain-scene')!;
			const fg = raws.get('plain-fg')!;
			for (const s of SHOTS.filter((x) => x.effect)) {
				const d = meanDiff(raws.get(s.name)!, s.layer === 'scene' ? video : fg);
				expect(d, `${s.label} changes the picture`).toBeGreaterThan(2);
			}
			const inv = raws.get('invert')!;
			let worst = 0;
			for (let y = 20; y < FX_H; y += 40)
				for (let x = 20; x < FX_W; x += 40) {
					const p = at(video, x, y);
					const q = at(inv, x, y);
					for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(q[k]! + p[k]! - 255));
				}
			expect(worst).toBeLessThan(12);
			// The mask keeps the source outside its circle (corner) and inverts inside (centre).
			const masked = raws.get('invert-mask')!;
			expect(at(masked, 5, 5).every((v, k) => Math.abs(v - at(video, 5, 5)[k]!) < 12)).toBe(true);
			expect(at(masked, 320, 180).every((v, k) => Math.abs(v + at(video, 320, 180)[k]! - 255) < 12)).toBe(
				true,
			);
			// Composites show the Background outside the foreground circle.
			const back = at(raws.get('matte-ops-comp')!, 5, 5);
			const bgDirect = at(raws.get('layer')!, 5, 5); // Overlay with no foreground there = the background
			expect(back.every((v, k) => Math.abs(v - bgDirect[k]!) < 12)).toBe(true);
		});

		it.runIf(!!process.env.FX_CONTACT_SHEET)('writes the contact sheet', () => {
			const out = process.env.FX_CONTACT_SHEET!;
			mkdirSync(dirname(out), { recursive: true });
			const cols = 6;
			const w = 256;
			const h = 144;
			const inputs = SHOTS.flatMap((s) => ['-i', join(media.dir, `${s.name}.png`)]);
			const esc = (t: string) => t.replace(/[:\\']/g, (c) => `\\${c}`);
			const cells = SHOTS.map(
				(s, i) =>
					`[${i}:v]scale=${w}:${h},drawtext=fontfile=${FONT}:text='${esc(s.label)}':x=4:y=4:fontsize=13:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=3[c${i}]`,
			);
			const layout = SHOTS.map((_, i) => `${(i % cols) * w}_${Math.floor(i / cols) * h}`).join('|');
			const filter = `${cells.join(';')};${SHOTS.map((_, i) => `[c${i}]`).join('')}xstack=inputs=${SHOTS.length}:layout=${layout}:fill=black,split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=bayer`;
			execFileSync('ffmpeg', [
				'-v',
				'error',
				'-y',
				...inputs,
				'-filter_complex',
				filter,
				'-frames:v',
				'1',
				out,
			]);
			expect(existsSync(out)).toBe(true);
		});
	},
);
