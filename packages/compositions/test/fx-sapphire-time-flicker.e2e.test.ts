// @vitest-environment node
// Sapphire Time + Flicker family on the Remotion render path (REMOTION_E2E=1): renders consecutive stills of every
// effect of the family on a test scene (a moving box over testsrc2, a cut at frame 30 to SMPTE bars with another
// moving box, plus a flickering copy for the flicker tools), checks representative behaviour (freeze frame, reverse,
// determinism of a recursive effect under out-of-order renders, flicker removal) and, with FX_CONTACT_SHEET=<png>,
// writes a contact sheet of all effects (docs/screenshots/fx/sapphire-time-flicker/). Needs Chrome + ffmpeg.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

/** The scene (2 s, 30 fps): moving white box over testsrc2, a hard cut at frame 30 to bars + a moving red disc. */
function makeScene(dir: string) {
	const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
	const s = `s=${FX_W}x${FX_H}:r=30`;
	const a = (d: number) =>
		`testsrc2=${s}:d=${d}[a0];color=c=white:s=90x90:r=30:d=${d}[a1];[a0][a1]overlay=x='60+t*300':y=130:eval=frame`;
	const b = `smptehdbars=${s}:d=1[b0];color=c=red:s=70x70:r=30:d=1[b1];[b0][b1]overlay=x='450-t*300':y=200:eval=frame`;
	const out = ['-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-g', '1'];
	ff([
		'-filter_complex',
		`${a(1)}[a];${b}[b];[a][b]concat=n=2:v=1[v]`,
		'-map',
		'[v]',
		...out,
		join(dir, 'scene.mp4'),
	]);
	// Same motion, brightness flickering frame to frame.
	const flicker = "eq=brightness='0.12*sin(n*2.1)+0.05*sin(n*5.3)':eval=frame";
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

/** Every effect of the family with the settings shown on the contact sheet and the frames rendered. */
const SHEET: { id: string; params?: Record<string, unknown>; video?: string; frames: number[] }[] = [
	{ id: 'jasper.s.cut-to-dissolve', params: { cutPoint: 30, dissolveLength: 12 }, frames: [26, 30, 34] },
	{ id: 'jasper.s.feedback', frames: [12, 13, 14] },
	{ id: 'jasper.s.feedback-bubble', params: { combineNew: 'max' }, frames: [12, 13, 14] },
	{ id: 'jasper.s.feedback-distort', frames: [12, 13, 14] },
	{ id: 'jasper.s.field-remove', params: { show: 'motionMatte' }, frames: [10, 11, 12] },
	{ id: 'jasper.s.freeze-frame', frames: [10, 12, 14] },
	{ id: 'jasper.s.get-frame', params: { getFrame: 12.5, interpFrames: true }, frames: [0, 10, 20] },
	{ id: 'jasper.s.jitter-frames', frames: [10, 11, 12] },
	{ id: 'jasper.s.motion-detect', params: { delayFrames: 2, brightness: 3 }, frames: [10, 11, 12] },
	{ id: 'jasper.s.nearest-color', params: { matchColor: [1, 1, 1, 1], steps: 8 }, frames: [10, 12, 14] },
	{ id: 'jasper.s.random-edits', params: { editFrameLength: 6 }, frames: [10, 11, 12] },
	{ id: 'jasper.s.repair-frames', params: { firstBadFrame: 11, badFrameCount: 2 }, frames: [10, 11, 12] },
	{ id: 'jasper.s.retime', params: { speed: 0.4 }, frames: [20, 21, 22] },
	{ id: 'jasper.s.reverse-clip', frames: [10, 11, 12] },
	{ id: 'jasper.s.reverse-edits', frames: [10, 11, 12] },
	{ id: 'jasper.s.time-average', params: { aveOverFrames: 8 }, frames: [10, 12, 14] },
	{ id: 'jasper.s.time-displace', frames: [10, 12, 14] },
	{ id: 'jasper.s.time-slice', params: { sliceNumber: 8 }, frames: [10, 12, 14] },
	{ id: 'jasper.s.time-warp-rgb', params: { redShiftFrames: 3, blueShiftFrames: -3 }, frames: [10, 12, 14] },
	{ id: 'jasper.s.trails', params: { combineNew: 'max', prevBrightness: 0.85 }, frames: [12, 13, 14] },
	{ id: 'jasper.s.trails-diffuse', params: { combineNew: 'max' }, frames: [12, 13, 14] },
	{ id: 'jasper.s.flicker', params: { amplitude: 0.5 }, frames: [10, 11, 12] },
	{ id: 'jasper.s.flicker-match', params: { match: { mediaId: '$m2' } }, frames: [10, 11, 12] },
	{ id: 'jasper.s.flicker-match-color', params: { match: { mediaId: '$m2' } }, frames: [10, 11, 12] },
	{ id: 'jasper.s.flicker-match-matte', params: { match: { mediaId: '$m2' } }, frames: [10, 11, 12] },
	{ id: 'jasper.s.flicker-mch-matte-color', params: { match: { mediaId: '$m2' } }, frames: [10, 11, 12] },
	{ id: 'jasper.s.flicker-remove', video: 'flicker.mp4', frames: [10, 11, 12] },
	{ id: 'jasper.s.flicker-remove-color', video: 'flicker.mp4', frames: [10, 11, 12] },
	{ id: 'jasper.s.flicker-remove-matte', video: 'flicker.mp4', frames: [10, 11, 12] },
	{ id: 'jasper.s.flicker-rm-matte-color', video: 'flicker.mp4', frames: [10, 11, 12] },
];

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

		it('renders every effect of the family (contact sheet with FX_CONTACT_SHEET)', async () => {
			const rows: string[] = [];
			for (const e of SHEET) {
				const tag = e.id.replace('jasper.s.', '');
				const files: string[] = [];
				for (const f of e.frames) {
					const raw = await still(
						clip(media, e.video ?? 'scene.mp4', [{ id: e.id, params: e.params }]),
						f,
						`sheet-${tag}-${f}`,
					);
					expect(raw.length).toBe(FX_W * FX_H * 3);
					files.push(join(media.dir, `sheet-${tag}-${f}.png`));
				}
				rows.push(tag);
				// One row: the frames side by side at 1/3 size, labelled.
				execFileSync('ffmpeg', [
					'-v',
					'error',
					'-y',
					...files.flatMap((p) => ['-i', p]),
					'-filter_complex',
					`${files.map((_, i) => `[${i}:v]scale=213:120[s${i}]`).join(';')};${files.map((_, i) => `[s${i}]`).join('')}hstack=inputs=${files.length},drawtext=text='S_${tag} ${e.frames.join(' ')}':x=4:y=4:fontsize=13:fontcolor=yellow:box=1:boxcolor=black@0.6[v]`,
					'-map',
					'[v]',
					join(media.dir, `row-${tag}.png`),
				]);
			}
			const out = process.env.FX_CONTACT_SHEET;
			if (out) {
				mkdirSync(dirname(out), { recursive: true });
				const inputs = rows.flatMap((r) => ['-i', join(media.dir, `row-${r}.png`)]);
				// Two columns of rows.
				const half = Math.ceil(rows.length / 2);
				const col = (from: number, to: number, name: string) =>
					`${rows
						.slice(from, to)
						.map((_, i) => `[${from + i}:v]`)
						.join('')}vstack=inputs=${to - from}${to - from < half ? `,pad=iw:${half * 120}` : ''}[${name}]`;
				execFileSync('ffmpeg', [
					'-v',
					'error',
					'-y',
					...inputs,
					'-filter_complex',
					`${col(0, half, 'l')};${col(half, rows.length, 'r')};[l][r]hstack=inputs=2,format=rgb24[v]`,
					'-map',
					'[v]',
					'-compression_level',
					'9',
					out,
				]);
			}
		});
	},
);
