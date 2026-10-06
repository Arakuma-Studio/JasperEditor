// @vitest-environment node
// Sapphire Blur+Sharpen on the Remotion render path: every effect of the family is rendered as a still on a picture
// (with its media inputs — Z buffer, kernel, background, matte — registered as project media) through the
// production compositions bundle (fx-render/entry.ts) in headless Chrome, exactly like an export. Each still must
// differ from the unprocessed picture and keep its size; the depth-of-field still must stay sharp where the Z buffer
// is in focus. Optional: SBS_SCENE=<png 640×360> renders a custom picture, SBS_SHEET=<png> writes a labelled contact
// sheet of all stills (docs/screenshots/fx/sapphire-blur-sharpen/). Gated by REMOTION_E2E=1; needs ffmpeg on PATH.
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

/** Each effect with the settings that show its character (media inputs by name). */
const CASES: {
	id: string;
	label: string;
	params?: Record<string, unknown>;
	media?: Record<string, string>;
	frame?: number;
	/** Smallest mean change expected on the synthetic scene (default 0.3). */
	minDiff?: number;
}[] = [
	{
		id: 'jasper.s.advanced-defocus',
		label: 'S_AdvancedDefocus',
		params: { boostHighlights: 2, opticalVignette: 0.5 },
	},
	{ id: 'jasper.s.beauty', label: 'S_Beauty', params: { blurAmount: 0.04, glowBrightness: 0.3 } },
	{ id: 'jasper.s.blur', label: 'S_Blur' },
	{ id: 'jasper.s.blur-channels', label: 'S_BlurChannels', params: { blurAmount: 1 } },
	{ id: 'jasper.s.blur-chroma', label: 'S_BlurChroma', params: { blurChroma: 2, scaleChroma: 1.5 } },
	{ id: 'jasper.s.blur-directional', label: 'S_BlurDirectional', params: { bias: 0.9, blurAmount: 0.8 } },
	{ id: 'jasper.s.blur-mo-curves', label: 'S_BlurMoCurves', params: { zDist: 1.15, rotate: 6 } },
	{ id: 'jasper.s.blur-motion', label: 'S_BlurMotion', params: { toZDist: 0.88 } },
	{
		id: 'jasper.s.convolve',
		label: 'S_Convolve',
		params: { combine: 'screen', threshold: 0.85, brightness: 2 },
		media: { kernel: 'star.png' },
	},
	{
		id: 'jasper.s.convolve-comp',
		label: 'S_ConvolveComp',
		params: { sizeFront: 0, sizeBack: 2, matteUse: 'luma' },
		media: { kernel: 'disc.png', background: 'scene.png', matte: 'depth.png' },
	},
	// The synthetic scene is smooth, flat-shaded and grain-free, so Deband, EdgeAwareBlur and GrainRemove rightly change
	// little here (their characteristic checks are in fx-sapphire-blur-sharpen-gl.test.ts).
	{ id: 'jasper.s.deband', label: 'S_Deband', params: { edgeThreshold: 6 }, minDiff: 0.005 },
	{ id: 'jasper.s.defocus-prism', label: 'S_DefocusPrism', params: { useGamma: 1.5, boostHighlights: 2 } },
	{ id: 'jasper.s.edge-aware-blur', label: 'S_EdgeAwareBlur', params: { blurAmount: 0.8 }, minDiff: 0.02 },
	{ id: 'jasper.s.edge-blur', label: 'S_EdgeBlur', params: { blurWidth: 0.3, edgeWidth: 0.3 } },
	{ id: 'jasper.s.free-lens', label: 'S_FreeLens', params: { tiltX: 25, leakIntensity: 0.5 } },
	{ id: 'jasper.s.grain-remove', label: 'S_GrainRemove', minDiff: 0.1 },
	{ id: 'jasper.s.median', label: 'S_Median', params: { size: 3 } },
	{
		id: 'jasper.s.rack-defocus',
		label: 'S_RackDefocus',
		params: { shape: '6', useGamma: 2, boostHighlights: 1 },
	},
	{
		id: 'jasper.s.rack-df-comp',
		label: 'S_RackDfComp',
		params: { defocusForeground: 0, defocusBackground: 0.12, matteUse: 'luma', useGamma: 2 },
		media: { background: 'scene.png', matte: 'depth.png' },
	},
	{ id: 'jasper.s.sharpen', label: 'S_Sharpen', params: { sharpenAmp: 2 } },
	{ id: 'jasper.s.soft-focus', label: 'S_SoftFocus', params: { softWidth: 0.4 } },
	{ id: 'jasper.s.z-blur', label: 'S_ZBlur', params: { blurWidth: 0.5 }, media: { zBuffer: 'depth.png' } },
	{
		id: 'jasper.s.z-convolve',
		label: 'S_ZConvolve',
		params: { size: 1.5, useGamma: 2 },
		media: { kernel: 'disc.png', zBuffer: 'depth.png' },
	},
	{
		id: 'jasper.s.z-defocus',
		label: 'S_ZDefocus',
		params: { useGamma: 2, boostHighlights: 1 },
		media: { zBuffer: 'depth.png' },
	},
];

describe.runIf(enabled)(
	'Sapphire Blur+Sharpen in Remotion renders (REMOTION_E2E=1)',
	{ timeout: 900_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};
		const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

		beforeAll(async () => {
			media = await startFxMedia('fx-sbs-');
			const d = (name: string) => join(media.dir, name);
			// The picture: a custom scene, else a synthetic one (gradient, coloured point lights, shapes, a skin-tone oval).
			if (process.env.SBS_SCENE) copyFileSync(process.env.SBS_SCENE, d('scene.png'));
			else {
				const dots = Array.from({ length: 40 }, (_, i) => {
					const x = 340 + ((i * 97) % 290);
					const y = 10 + ((i * 53) % 340);
					const c = ['white', '0xffd080', '0x80c0ff', '0xff9090', '0xa0ffa0'][i % 5];
					return `drawbox=x=${x}:y=${y}:w=3:h=3:color=${c}:t=fill`;
				}).join(',');
				ff([
					'-f',
					'lavfi',
					'-i',
					`testsrc2=s=${FX_W}x${FX_H}`,
					'-vf',
					`drawbox=x=320:y=0:w=320:h=360:color=0x101828:t=fill,${dots},drawbox=x=60:y=60:w=200:h=240:color=0xc8906c:t=fill`,
					'-frames:v',
					'1',
					d('scene.png'),
				]);
			}
			// Z buffer: near (white) on the left → far (black) on the right; kernels.
			ff([
				'-f',
				'lavfi',
				'-i',
				`color=c=black:s=${FX_W}x${FX_H},format=gray`,
				'-vf',
				`geq=lum='clip(255*(1-(X-350)/200),0,255)'`,
				'-frames:v',
				'1',
				d('depth.png'),
			]);
			ff([
				'-f',
				'lavfi',
				'-i',
				'color=c=black:s=320x240,format=gray',
				'-vf',
				`geq=lum='255*lt(hypot(X-160,Y-120),12)'`,
				'-frames:v',
				'1',
				d('disc.png'),
			]);
			ff([
				'-f',
				'lavfi',
				'-i',
				'color=c=black:s=320x240,format=gray',
				'-vf',
				`geq=lum='255*max(max(lt(abs(X-160),1.5),lt(abs(Y-120),1.5)),max(lt(abs((X-160)-(Y-120)),1.5),lt(abs((X-160)+(Y-120)),1.5)))*max(0,1-hypot(X-160,Y-120)/110)'`,
				'-frames:v',
				'1',
				d('star.png'),
			]);
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			console.info(`[fx-sbs] stills in ${media.dir}`);
		}, 600_000);

		afterAll(() => {
			media?.close();
		});

		const asset = (name: string, w: number, h: number) => fxAsset(media, 'image', name, w, h);
		const size = (name: string): [number, number] =>
			name === 'disc.png' || name === 'star.png' ? [320, 240] : [FX_W, FX_H];

		function commands(c?: (typeof CASES)[number]): Command[] {
			const cmds: Command[] = [
				{ type: 'media.register', ref: '$m', asset: asset('scene.png', FX_W, FX_H) } as unknown as Command,
			];
			const params: Record<string, unknown> = { ...(c?.params ?? {}) };
			for (const [param, file] of Object.entries(c?.media ?? {})) {
				const ref = `$${param}`;
				cmds.push({ type: 'media.register', ref, asset: asset(file, ...size(file)) } as unknown as Command);
				params[param] = { mediaId: ref };
			}
			cmds.push({
				type: 'clip.place',
				source: { mediaId: '$m' },
				at: 0,
				tracks: { video: 'V1' },
				ref: '$c',
			} as unknown as Command);
			if (c) cmds.push(fxCmd.effect(c.id, params));
			return cmds;
		}

		async function still(
			c: (typeof CASES)[number] | undefined,
			name: string,
		): Promise<{ raw: Buffer; png: string }> {
			const inputProps = {
				doc: fxSnapshot(commands(c)),
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
				frame: c?.frame ?? 0,
				output,
				// Software GL (SwiftShader) on a loaded CI host: the depth-layered convolutions need more than 30 s.
				timeoutInMilliseconds: 240_000,
				...browser,
			});
			const raw = execFileSync(
				'ffmpeg',
				['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
				{ maxBuffer: 1 << 26 },
			);
			return { raw, png: output };
		}
		const meanDiff = (a: Buffer, b: Buffer) => {
			let d = 0;
			let n = 0;
			for (let i = 0; i < a.length; i += 31) {
				d += Math.abs(a[i]! - b[i]!);
				n++;
			}
			return d / n;
		};
		const at = (raw: Buffer, x: number, y: number) => raw[(y * FX_W + x) * 3]!;

		it('renders every effect of the family (each changes the picture)', async () => {
			const plain = await still(undefined, '00-source');
			expect(plain.raw.length).toBe(FX_W * FX_H * 3);
			const pngs: [string, string][] = [['Source', plain.png]];
			for (const c of CASES) {
				const s = await still(c, c.label);
				expect(s.raw.length, c.id).toBe(FX_W * FX_H * 3);
				expect(meanDiff(s.raw, plain.raw), c.id).toBeGreaterThan(c.minDiff ?? 0.3);
				pngs.push([c.label, s.png]);
			}
			if (process.env.SBS_SHEET) {
				// 5 × 5 labelled contact sheet of 256×144 tiles, palette-compressed PNG.
				const cols = 5;
				const rows = Math.ceil(pngs.length / cols);
				const parts = pngs.map(
					([label], i) =>
						`[${i}]scale=256:144,drawtext=text='${label}':x=4:y=4:fontsize=13:fontcolor=white:box=1:boxcolor=black@0.6[t${i}]`,
				);
				for (let i = pngs.length; i < rows * cols; i++) parts.push(`color=c=0x202020:s=256x144:d=1[t${i}]`);
				const layout = Array.from(
					{ length: rows * cols },
					(_, i) => `${(i % cols) * 256}_${Math.floor(i / cols) * 144}`,
				).join('|');
				const fc = `${parts.join(';')};${Array.from({ length: rows * cols }, (_, i) => `[t${i}]`).join('')}xstack=inputs=${rows * cols}:layout=${layout},split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=sierra2_4a`;
				ff([
					...pngs.flatMap(([, f]) => ['-i', f]),
					'-filter_complex',
					fc,
					'-frames:v',
					'1',
					process.env.SBS_SHEET,
				]);
			}
		});

		it('S_ZDefocus keeps the near (white) part of the Z buffer sharp and defocuses the far part', async () => {
			const plain = await still(undefined, 'z-source');
			const z = await still(
				CASES.find((c) => c.id === 'jasper.s.z-defocus'),
				'z-check',
			);
			// Left (near, in focus at Focal Depth 0): unchanged; right (far): changed.
			let near = 0;
			let far = 0;
			for (let y = 20; y < FX_H; y += 20) {
				for (let x = 10; x < 300; x += 20)
					near = Math.max(near, Math.abs(at(z.raw, x, y) - at(plain.raw, x, y)));
				for (let x = 600; x < FX_W; x += 7) far += Math.abs(at(z.raw, x, y) - at(plain.raw, x, y));
			}
			expect(near).toBeLessThan(24);
			expect(far).toBeGreaterThan(50);
		});
	},
);
