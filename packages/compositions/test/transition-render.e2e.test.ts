// @vitest-environment node
// GPU transitions on the Remotion render path (wave-2 transition framework): bundles the production root, renders
// stills with @remotion/renderer in headless Chrome (WebGL2 through ANGLE/SwiftShader, as the engine's render
// browser) and checks the pixels of the four example transitions: Push (two solids), Iris Round (two-sided and a
// one-sided fade-out to transparent), S_DissolveLuma (the luma of A decides where B shows: both sides in one
// shader), Cross Zoom, a video side (decoded frames through the side's chain) and a shape side (DOM layer captured
// through HTML-in-Canvas). The built-in Cross Dissolve keeps its ramps (no stage). Gated by REMOTION_E2E=1; needs
// ffmpeg on PATH. The stills stay in the printed directory (TRANSITION_RENDER_OUT=<dir> copies them there).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

type Rgb = [number, number, number];
const RED: [number, number, number, number] = [1, 0, 0, 1];
const BLUE: [number, number, number, number] = [0, 0, 1, 1];
const GREEN: [number, number, number, number] = [0, 1, 0, 1];

/** Two solids on V1 (A 0–30, B 30–60) with a transition at the cut. */
function solidsWith(effectId: string, a = RED, b = BLUE, extra: Record<string, unknown> = {}): Command[] {
	return [
		{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: a, ref: '$a' } as Command,
		{ type: 'clip.addSolid', at: 30, duration: 30, track: 'V1', color: b, ref: '$b' } as Command,
		{ type: 'transition.add', trackId: 'V1', at: 30, effectId, duration: 20, ...extra } as Command,
	];
}

describe.runIf(enabled)('GPU transitions in Remotion renders (REMOTION_E2E=1)', { timeout: 240_000 }, () => {
	let media: FxMedia;
	let serveUrl: string;
	let renderer: typeof import('@remotion/renderer');
	const browserExecutable =
		process.env.JASPER_BROWSER_EXECUTABLE ??
		(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
	const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};
	const copyTo = process.env.TRANSITION_RENDER_OUT;

	beforeAll(async () => {
		media = await startFxMedia('transition-render-');
		// A: left half white, right half black (the luma map of S_DissolveLuma).
		execFileSync('ffmpeg', [
			'-v',
			'error',
			'-y',
			'-f',
			'lavfi',
			'-i',
			`color=white:s=${FX_W / 2}x${FX_H}[l];color=black:s=${FX_W / 2}x${FX_H}[r];[l][r]hstack`,
			'-frames:v',
			'1',
			join(media.dir, 'halves.png'),
		]);
		const { bundle } = await import('@remotion/bundler');
		serveUrl = await bundle({ entryPoint: join(here, '..', 'src', 'remotion-entry.ts') });
		renderer = await import('@remotion/renderer');
		if (copyTo) mkdirSync(copyTo, { recursive: true });
		console.info(`[transition-render] stills in ${media.dir}`);
	}, 300_000);

	afterAll(() => {
		media?.close();
	});

	async function still(commands: Command[], frame: number, name: string): Promise<Buffer> {
		const doc = fxSnapshot(commands);
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
		const output = join(media.dir, `${name}.png`);
		await renderer.renderStill({ composition, serveUrl, inputProps, frame, output, ...browser });
		if (copyTo) copyFileSync(output, join(copyTo, `${name}.png`));
		return execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
			maxBuffer: 1 << 26,
		});
	}
	const at = (raw: Buffer, x: number, y: number): Rgb => {
		const i = (Math.round(y) * FX_W + Math.round(x)) * 3;
		return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
	};
	const close = (a: Rgb, b: Rgb, tol = 14) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

	it('Push: B enters from the left and pushes A out to the right', async () => {
		// Span 20…40; frame 30 = frame 10 of 20: p = 11 / 21 ≈ 0.52 → the seam at x ≈ 335.
		const raw = await still(solidsWith('jasper.push'), 30, 'push-30');
		expect(close(at(raw, 100, FX_H / 2), [0, 0, 255])).toBe(true);
		expect(close(at(raw, 540, FX_H / 2), [255, 0, 0])).toBe(true);
		const early = await still(solidsWith('jasper.push'), 21, 'push-21'); // p = 2 / 21
		expect(close(at(early, 30, FX_H / 2), [0, 0, 255])).toBe(true);
		expect(close(at(early, 200, FX_H / 2), [255, 0, 0])).toBe(true);
		// Direction + border (12 px white between the clips: A, the band and B move together by a frame + 12 px, so
		// A's trailing edge is at p · (H + 12) and the band just above it).
		const ns = await still(
			solidsWith('jasper.push', RED, BLUE, {
				params: { direction: 'northToSouth', borderWidth: 12, borderColor: [1, 1, 1, 1] },
			}),
			30,
			'push-north-border',
		);
		expect(close(at(ns, FX_W / 2, 60), [0, 0, 255])).toBe(true);
		expect(close(at(ns, FX_W / 2, 330), [255, 0, 0])).toBe(true);
		const seam = Math.round((11 / 21) * (FX_H + 12));
		expect(close(at(ns, FX_W / 2, seam - 6), [255, 255, 255], 30)).toBe(true);
		expect(close(at(ns, FX_W / 2, seam + 3), [255, 0, 0])).toBe(true);
		expect(close(at(ns, FX_W / 2, seam - 15), [0, 0, 255])).toBe(true);
	});

	it('Push: at progress 1 (the last frame of a fade at a tail) the border has left the far edge', async () => {
		// A alone, Push at its tail (span 10…30): the last frame is p = 1 → only the background (black) is left; the
		// border used to stay visible along the far (bottom) edge.
		const cmds: Command[] = [
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: RED, ref: '$a' } as Command,
			{
				type: 'transition.add',
				clipId: '$a',
				edge: 'out',
				effectId: 'jasper.push',
				duration: 20,
				params: { direction: 'northToSouth', borderWidth: 12, borderColor: [1, 1, 1, 1] },
			} as Command,
		];
		const last = await still(cmds, 29, 'push-border-last');
		for (const y of [FX_H - 1, FX_H - 6, FX_H - 11, FX_H / 2, 2])
			expect(close(at(last, FX_W / 2, y), [0, 0, 0]), `y = ${y}`).toBe(true);
		// The first frame of the span (p = 1 / 20) still shows the band right behind A's trailing edge.
		const first = await still(cmds, 10, 'push-border-first');
		expect(close(at(first, FX_W / 2, FX_H / 2), [255, 0, 0])).toBe(true);
	});

	it('Gradient Wipe: a Custom Gradient image replaces the built-in ramp (dark areas first)', async () => {
		const withImage: Command[] = [
			{
				type: 'media.register',
				ref: '$g',
				asset: fxAsset(media, 'image', 'halves.png', FX_W, FX_H),
			} as Command,
			...solidsWith('jasper.gradient-wipe', RED, BLUE, { params: { gradientImage: { mediaId: '$g' } } }),
		];
		// Frame 30: p = 11 / 21. Built-in Left to Right: the left half has switched. Custom (white | black): the
		// black right half switches first, the white left half is still A.
		const plain = await still(solidsWith('jasper.gradient-wipe'), 30, 'gradient-wipe-plain');
		expect(close(at(plain, 40, FX_H / 2), [0, 0, 255])).toBe(true);
		expect(close(at(plain, FX_W - 40, FX_H / 2), [255, 0, 0])).toBe(true);
		const custom = await still(withImage, 30, 'gradient-wipe-custom');
		expect(close(at(custom, 40, FX_H / 2), [255, 0, 0])).toBe(true);
		expect(close(at(custom, FX_W - 40, FX_H / 2), [0, 0, 255])).toBe(true);
	});

	it('Iris Round: B inside a growing circle; Reverse closes A instead', async () => {
		const raw = await still(solidsWith('jasper.iris-round'), 30, 'iris-30');
		expect(close(at(raw, FX_W / 2, FX_H / 2), [0, 0, 255])).toBe(true);
		expect(close(at(raw, 4, 4), [255, 0, 0])).toBe(true);
		const rev = await still(
			solidsWith('jasper.iris-round', RED, BLUE, { params: { reverse: true } }),
			36,
			'iris-rev',
		);
		// Reverse: A is the shrinking disc (p = 17 / 21 → the disc has 1 − p of the radius left).
		expect(close(at(rev, FX_W / 2, FX_H / 2), [255, 0, 0])).toBe(true);
		expect(close(at(rev, 4, 4), [0, 0, 255])).toBe(true);
	});

	it('one-sided: an iris at the tail of the last clip opens onto transparency (the black background)', async () => {
		const cmds: Command[] = [
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: RED, ref: '$a' } as Command,
			{
				type: 'transition.add',
				clipId: '$a',
				edge: 'out',
				effectId: 'jasper.iris-round',
				duration: 10,
			} as Command,
		];
		const raw = await still(cmds, 27, 'iris-fade-out'); // span 20…30: p = 8 / 10
		expect(close(at(raw, FX_W / 2, FX_H / 2), [0, 0, 0])).toBe(true);
		expect(close(at(raw, 2, 2), [255, 0, 0])).toBe(true);
	});

	it('S_DissolveLuma: the bright half of A switches to B first', async () => {
		const cmds: Command[] = [
			{
				type: 'media.register',
				ref: '$m',
				asset: fxAsset(media, 'image', 'halves.png', FX_W, FX_H),
			} as Command,
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
				tracks: { video: 'V1' },
				ref: '$a',
			} as unknown as Command,
			{ type: 'clip.addSolid', at: 30, duration: 30, track: 'V1', color: GREEN, ref: '$b' } as Command,
			{
				type: 'transition.add',
				trackId: 'V1',
				at: 30,
				effectId: 'jasper.s.dissolve-luma',
				duration: 20,
			} as Command,
		];
		const raw = await still(cmds, 30, 'luma-30');
		expect(close(at(raw, 100, FX_H / 2), [0, 255, 0])).toBe(true); // white → already B
		expect(close(at(raw, 540, FX_H / 2), [0, 0, 0])).toBe(true); // black → still A
	});

	it('Cross Zoom: mostly A early, B at the end', async () => {
		const early = await still(solidsWith('jasper.cross-zoom'), 22, 'cross-zoom-22');
		expect(close(at(early, FX_W / 2, FX_H / 2), [255, 0, 0])).toBe(true);
		const late = await still(solidsWith('jasper.cross-zoom'), 38, 'cross-zoom-38');
		expect(close(at(late, FX_W / 2, FX_H / 2), [0, 0, 255])).toBe(true);
	});

	it('a video side goes through its chain (upright decoded frames), a shape side through HTML-in-Canvas', async () => {
		const video: Command[] = [
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
				ref: '$a',
			} as unknown as Command,
			{ type: 'clip.addSolid', at: 30, duration: 30, track: 'V1', color: BLUE, ref: '$b' } as Command,
			{ type: 'transition.add', trackId: 'V1', at: 30, effectId: 'jasper.push', duration: 20 } as Command,
		];
		const plain = await still(video.slice(0, 2), 20, 'video-plain-20');
		// Frame 20 = first frame of the span: p = 1/21 — A (its own frame 20) is shifted right by 640/21 px.
		const pushed = await still(video, 20, 'video-push-20');
		const dx = FX_W / 21;
		let bad = 0;
		let n = 0;
		for (let y = 22; y < FX_H; y += 36)
			for (let x = 80; x < FX_W - 20; x += 36) {
				const p = at(pushed, x, y);
				const q = at(plain, x - dx, y);
				n++;
				if (!close(p, q, 40)) bad++;
			}
		// Upright, same frame, shifted (a few samples may sit on sharp testsrc2 edges).
		expect(bad / n).toBeLessThan(0.1);
		expect(close(at(pushed, 10, FX_H / 2), [0, 0, 255])).toBe(true);
		const shape: Command[] = [
			{
				type: 'clip.addShape',
				at: 0,
				duration: 30,
				track: 'V1',
				shape: { type: 'rect', size: [100, 100], fill: [1, 1, 1, 1] },
				ref: '$a',
			} as Command,
			{ type: 'clip.addSolid', at: 30, duration: 30, track: 'V1', color: BLUE, ref: '$b' } as Command,
			{ type: 'transition.add', trackId: 'V1', at: 30, effectId: 'jasper.push', duration: 20 } as Command,
		];
		const s = await still(shape, 30, 'shape-push-30');
		// The centred white square (x 270…370) moved right by p · 640 ≈ 335 px → x 605…640+.
		expect(close(at(s, 620, FX_H / 2), [255, 255, 255], 20)).toBe(true);
		expect(close(at(s, 320, FX_H / 2), [0, 0, 255])).toBe(true);
	});

	it('the built-in Cross Dissolve keeps its ramps (no stage)', async () => {
		const raw = await still(solidsWith('jasper.cross-dissolve'), 30, 'cross-dissolve-30');
		// Opaque solids: A stays opaque, B at 11/21 over it.
		const p = 11 / 21;
		expect(close(at(raw, FX_W / 2, FX_H / 2), [Math.round(255 * (1 - p)), 0, Math.round(255 * p)], 6)).toBe(
			true,
		);
	});
});
