// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

type Rgb = [number, number, number];

describe.runIf(enabled)(
	'GPU shader effects in Remotion renders (REMOTION_E2E=1)',
	{ timeout: 180_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		let puppeteerInstance: Awaited<ReturnType<typeof renderer.openBrowser>> | undefined;
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};

		beforeAll(async () => {
			media = await startFxMedia('fx-render-');
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			puppeteerInstance = await renderer.openBrowser('chrome', browser);
			console.info(`[fx-render] stills in ${media.dir}`);
		}, 300_000);

		afterAll(async () => {
			try {
				await puppeteerInstance?.close({ silent: true });
			} finally {
				media?.close();
			}
		});

		async function still(doc: ReturnType<typeof fxSnapshot>, frame: number, name: string): Promise<Buffer> {
			const inputProps = {
				doc,
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
		const at = (raw: Buffer, x: number, y: number): Rgb => {
			const i = (Math.round(y) * FX_W + Math.round(x)) * 3;
			return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
		};
		const close = (a: Rgb, b: Rgb, tol: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

		it('solid + generator: the gradient fills the layer', async () => {
			const raw = await still(
				fxSnapshot([...fxCmd.solid([0, 0, 1, 1]), fxCmd.effect('test.s.gradient')]),
				3,
				'solid-gradient',
			);
			expect(at(raw, 4, FX_H / 2)[0]).toBeLessThan(20);
			expect(at(raw, FX_W - 4, FX_H / 2)[0]).toBeGreaterThan(235);
			expect(Math.abs(at(raw, FX_W / 2, FX_H / 2)[0] - 128)).toBeLessThan(16);
		});

		it('still + drop shadow: the shadow is drawn outside the layer box (padding)', async () => {
			const shadow = { shadowColor: [0, 1, 0, 1], opacity: 100, direction: 0, distance: 40, softness: 0 };
			const raw = await still(
				fxSnapshot([...fxCmd.still(media), fxCmd.effect('test.drop-shadow', shadow)]),
				0,
				'still-shadow',
			);
			// The 200×200 still is centred: x 220…420. The shadow (offset 40 px right) covers x 420…460.
			expect(close(at(raw, FX_W / 2, FX_H / 2), [255, 0, 0], 12)).toBe(true);
			expect(close(at(raw, 440, FX_H / 2), [0, 255, 0], 12)).toBe(true);
			expect(close(at(raw, 200, FX_H / 2), [0, 0, 0], 12)).toBe(true);
		});

		it('video + half-opacity generator: the decoded frame goes through the chain upright', async () => {
			const plain = await still(fxSnapshot(fxCmd.video(media)), 10, 'video-plain');
			const black = { startColor: [0, 0, 0, 1], endColor: [0, 0, 0, 1], opacity: 50 };
			const fx = await still(
				fxSnapshot([...fxCmd.video(media), fxCmd.effect('test.s.gradient', black)]),
				10,
				'video-gradient',
			);
			// A black gradient at 50 % halves the frame: compare a grid of samples (also catches a flipped frame).
			let worst = 0;
			for (let y = 20; y < FX_H; y += 40)
				for (let x = 20; x < FX_W; x += 40) {
					const p = at(plain, x, y);
					const q = at(fx, x, y);
					for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(q[k]! - p[k]! / 2));
				}
			expect(worst).toBeLessThan(12);
		});

		it('time remap: a freeze frame shows the source at the frozen frame', async () => {
			const frame5 = await still(fxSnapshot(fxCmd.video(media, 2)), 5, 'video-5');
			const frame25 = await still(fxSnapshot(fxCmd.video(media, 2)), 25, 'video-25');
			const frozen = await still(
				fxSnapshot([...fxCmd.video(media, 2), fxCmd.effect('test.s.freeze-frame', { at: 5 })]),
				25,
				'video-frozen',
			);
			const diff = (a: Buffer, b: Buffer) => {
				let d = 0;
				for (let i = 0; i < a.length; i += 97) d = Math.max(d, Math.abs(a[i]! - b[i]!));
				return d;
			};
			expect(diff(frame5, frame25)).toBeGreaterThan(40);
			expect(diff(frozen, frame5)).toBeLessThan(16);
		});

		it('time samples: an earlier frame is decoded for its own frame (deterministic)', async () => {
			const frame7 = await still(fxSnapshot(fxCmd.video(media, 2)), 7, 'video-7');
			const echo = await still(
				fxSnapshot([...fxCmd.video(media, 2), fxCmd.effect('test.s.echo-only', { offset: -3 })]),
				10,
				'video-echo',
			);
			let d = 0;
			for (let i = 0; i < echo.length; i += 97) d = Math.max(d, Math.abs(echo[i]! - frame7[i]!));
			expect(d).toBeLessThan(16);
		});

		it('time samples compose with remaps: an echo below a freeze shows the frozen picture', async () => {
			const frame5 = await still(fxSnapshot(fxCmd.video(media, 2)), 5, 'video-5b');
			const frame2 = await still(fxSnapshot(fxCmd.video(media, 2)), 2, 'video-2');
			const echoOfFrozen = await still(
				fxSnapshot([
					...fxCmd.video(media, 2),
					fxCmd.effect('test.s.freeze-frame', { at: 5 }),
					fxCmd.effect('test.s.echo-only', { offset: -3 }),
				]),
				25,
				'video-freeze-echo',
			);
			const diff = (a: Buffer, b: Buffer) => {
				let d = 0;
				for (let i = 0; i < a.length; i += 97) d = Math.max(d, Math.abs(a[i]! - b[i]!));
				return d;
			};
			expect(diff(frame2, frame5)).toBeGreaterThan(40);
			expect(diff(echoOfFrozen, frame5)).toBeLessThan(16);
		});

		it('params at sub-frame times: Transform Shutter Angle motion-blurs keyframed motion', async () => {
			// The 200×200 red still sits at x 220…420; at frame 5 the Transform has it centred, moving 20 px/frame.
			const sharp = await still(
				fxSnapshot([...fxCmd.still(media), ...fxCmd.movingTransform(true)]),
				5,
				'tf-sharp',
			);
			const blurred = await still(
				fxSnapshot([...fxCmd.still(media), ...fxCmd.movingTransform(false)]),
				5,
				'tf-blurred',
			);
			expect(at(sharp, 222, FX_H / 2)[0]).toBeGreaterThan(235);
			// 360° shutter = ±10 px around x: at 2 px inside the edge ≈ 60 % coverage.
			expect(Math.abs(at(blurred, 222, FX_H / 2)[0] - 153)).toBeLessThan(30);
			expect(at(blurred, FX_W / 2, FX_H / 2)[0]).toBeGreaterThan(235);
		});

		it('shape (DOM layer, HTML-in-Canvas) + drop shadow', async () => {
			const shadow = { shadowColor: [0, 1, 0, 1], opacity: 100, direction: 90, distance: 30, softness: 0 };
			const raw = await still(
				fxSnapshot([...fxCmd.shape(), fxCmd.effect('test.drop-shadow', shadow)]),
				2,
				'shape-shadow',
			);
			// 100×100 white square centred (y 130…230); its shadow 30 px lower covers y 230…260.
			expect(close(at(raw, FX_W / 2, FX_H / 2), [255, 255, 255], 12)).toBe(true);
			expect(close(at(raw, FX_W / 2, 245), [0, 255, 0], 16)).toBe(true);
			expect(close(at(raw, FX_W / 2, 110), [0, 0, 0], 12)).toBe(true);
		});
	},
);
