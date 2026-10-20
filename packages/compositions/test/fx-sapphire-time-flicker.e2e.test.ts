// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { BROWSER_VIDEO_ARGS } from '@jasper/testkit/fixture-video';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

function makeScene(dir: string) {
	const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
	const s = `s=${FX_W}x${FX_H}:r=30`;
	const a = (d: number) =>
		`testsrc2=${s}:d=${d}[a0];color=c=white:s=90x90:r=30:d=${d}[a1];[a0][a1]overlay=x='60+t*300':y=130:eval=frame`;
	const b = `smptehdbars=${s}:d=1[b0];color=c=red:s=70x70:r=30:d=1[b1];[b0][b1]overlay=x='450-t*300':y=200:eval=frame`;
	const out = ['-pix_fmt', 'yuv420p', ...BROWSER_VIDEO_ARGS, '-g', '1'];
	ff([
		'-filter_complex',
		`${a(1)}[a];${b}[b];[a][b]concat=n=2:v=1[v]`,
		'-map',
		'[v]',
		...out,
		join(dir, 'scene.mp4'),
	]);
	// Same motion, brightness flickering frame to frame.
	// (geq, not eq: eq is a GPL-only filter the LGPL build lacks; the same luma offset, frame by frame)
	const flicker =
		"geq=lum='clip(lum(X,Y)+255*(0.12*sin(N*2.1)+0.05*sin(N*5.3)),0,255)':cb='cb(X,Y)':cr='cr(X,Y)'";
	ff(['-filter_complex', `${a(2)},${flicker}[v]`, '-map', '[v]', ...out, join(dir, 'flicker.mp4')]);
}

const video = (m: FxMedia, name: string, ref: string): Command =>
	({ type: 'media.register', ref, asset: fxAsset(m, 'video', name, FX_W, FX_H) }) as unknown as Command;

function clip(
	m: FxMedia,
	name: string,
	effects: { id: string; params?: Record<string, unknown> }[],
): Command[] {
	return [
		video(m, name, '$m'),
		video(m, 'flicker.mp4', '$m2'),
		{
			type: 'clip.place',
			source: { mediaId: '$m' },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
			tracks: { video: 'V1' },
			ref: '$c',
		} as unknown as Command,
		...effects.map(
			(e) =>
				({
					type: 'effect.add',
					target: { clipId: '$c' },
					effectId: e.id,
					...(e.params ? { params: e.params } : {}),
				}) as Command,
		),
	];
}

describe.runIf(enabled)(
	'Sapphire Time + Flicker in Remotion renders (REMOTION_E2E=1)',
	{ timeout: 2_400_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		// One browser for every still (opening one per still dominates the run time).
		let puppeteerInstance:
			| Awaited<ReturnType<typeof import('@remotion/renderer')['openBrowser']>>
			| undefined;
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};

		beforeAll(async () => {
			media = await startFxMedia('fx-stf-');
			makeScene(media.dir);
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			puppeteerInstance = await renderer.openBrowser('chrome', browser);
			console.info(`[fx-stf] stills in ${media.dir}`);
		}, 300_000);

		afterAll(async () => {
			await puppeteerInstance?.close({ silent: true });
			media?.close();
		});

		async function still(commands: Command[], frame: number, name: string): Promise<Buffer> {
			const inputProps = {
				doc: fxSnapshot(commands),
				options: { isPreview: false, useProxies: false, transparentBackground: false },
			};
			const composition = await renderer.selectComposition({
				serveUrl,
				id: SEQUENCE_COMPOSITION_ID,
				inputProps,
				puppeteerInstance,
				...browser,
			});
			const output = join(media.dir, `${name}.png`);
			await renderer.renderStill({
				composition,
				serveUrl,
				inputProps,
				frame,
				output,
				puppeteerInstance,
				...browser,
			});
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
			for (let i = 0; i < a.length; i += 97) d = Math.max(d, Math.abs(a[i]! - b[i]!));
			return d;
		};
		const meanLuma = (raw: Buffer) => {
			let s = 0;
			let n = 0;
			for (let i = 0; i < raw.length; i += 3 * 31) {
				s += 0.2126 * raw[i]! + 0.7152 * raw[i + 1]! + 0.0722 * raw[i + 2]!;
				n++;
			}
			return s / n;
		};

		it('S_FreezeFrame holds the first frame of each group; S_ReverseClip plays backwards', async () => {
			const plain5 = await still(clip(media, 'scene.mp4', []), 5, 'plain-5');
			const plain9 = await still(clip(media, 'scene.mp4', []), 9, 'plain-9');
			const plain50 = await still(clip(media, 'scene.mp4', []), 50, 'plain-50');
			const frozen = await still(clip(media, 'scene.mp4', [{ id: 'jasper.s.freeze-frame' }]), 9, 'freeze-9');
			expect(diff(plain5, plain9)).toBeGreaterThan(40);
			expect(diff(frozen, plain5)).toBeLessThan(16);
			const reversed = await still(
				clip(media, 'scene.mp4', [{ id: 'jasper.s.reverse-clip', params: { swapFields: 'no' } }]),
				9,
				'reverse-9',
			);
			expect(diff(reversed, plain50)).toBeLessThan(16); // 60 − 1 − 9 = 50
		});

		it('S_Trails is deterministic under out-of-order renders', async () => {
			const fx = [{ id: 'jasper.s.trails', params: { combineNew: 'max' } }];
			const a = await still(clip(media, 'scene.mp4', fx), 14, 'trails-14a');
			await still(clip(media, 'scene.mp4', fx), 3, 'trails-3');
			const b = await still(clip(media, 'scene.mp4', fx), 14, 'trails-14b');
			expect(diff(a, b)).toBeLessThan(3);
			const plain = await still(clip(media, 'scene.mp4', []), 14, 'plain-14');
			expect(meanLuma(a)).toBeGreaterThan(meanLuma(plain) + 1); // the box leaves a bright trail
		});

		it('S_FlickerRemove flattens the frame-to-frame brightness of a flickering clip', async () => {
			const spread = async (fx: { id: string }[], tag: string) => {
				const l: number[] = [];
				for (const f of [8, 9, 10, 11, 12])
					l.push(meanLuma(await still(clip(media, 'flicker.mp4', fx), f, `${tag}-${f}`)));
				return Math.max(...l) - Math.min(...l);
			};
			const before = await spread([], 'flk');
			const after = await spread([{ id: 'jasper.s.flicker-remove' }], 'flkrm');
			expect(before).toBeGreaterThan(8);
			expect(after).toBeLessThan(before / 3);
		});
	},
);
