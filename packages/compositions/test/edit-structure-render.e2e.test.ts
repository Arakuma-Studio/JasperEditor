// @vitest-environment node
// edit-structure on the Remotion render path: bundles the production root and renders stills with @remotion/renderer
// in headless Chrome, then checks pixels — a nested sequence (scaled nest clip, nested frame mapping, speed 2×), an
// adjustment layer (CSS filter mode; canvas mode with 50 % opacity and a crop region through HTML-in-Canvas over a
// video), Bars and Tone, the counting leader, and a frame hold of a moving video. Gated by REMOTION_E2E=1; needs
// ffmpeg on PATH. EDIT_STRUCTURE_RENDER_OUT=<dir> copies the stills there.
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

describe.runIf(enabled)('edit-structure in Remotion renders (REMOTION_E2E=1)', { timeout: 300_000 }, () => {
	let media: FxMedia;
	let serveUrl: string;
	let renderer: typeof import('@remotion/renderer');
	const browserExecutable =
		process.env.JASPER_BROWSER_EXECUTABLE ??
		(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
	const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};
	const copyTo = process.env.EDIT_STRUCTURE_RENDER_OUT;

	beforeAll(async () => {
		media = await startFxMedia('edit-structure-render-');
		const { bundle } = await import('@remotion/bundler');
		serveUrl = await bundle({ entryPoint: join(here, '..', 'src', 'remotion-entry.ts') });
		renderer = await import('@remotion/renderer');
		if (copyTo) mkdirSync(copyTo, { recursive: true });
		console.info(`[edit-structure-render] stills in ${media.dir}`);
	}, 300_000);

	afterAll(() => {
		media?.close();
	});

	async function still(commands: Command[], frame: number, name: string): Promise<Buffer> {
		const doc = fxSnapshot(commands);
		const inputProps = { doc, options: { isPreview: false, useProxies: false, transparentBackground: false } };
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
	const close = (a: Rgb, b: Rgb, tol = 12) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

	/** A nested sequence: red 0–30, blue 30–60, green 60–90 (each full frame). */
	const nested: Command[] = [
		{ type: 'sequence.create', name: 'Inner', settings: { width: FX_W, height: FX_H }, ref: '$s' } as Command,
		{ type: 'clip.addSolid', sequenceId: '$s', at: 0, duration: 30, track: 'V1', color: RED } as Command,
		{ type: 'clip.addSolid', sequenceId: '$s', at: 30, duration: 30, track: 'V1', color: BLUE } as Command,
		{ type: 'clip.addSolid', sequenceId: '$s', at: 60, duration: 30, track: 'V1', color: GREEN } as Command,
	];

	it('draws a nested sequence at the nested frame, scaled by the nest clip, at 2× speed', async () => {
		const cmds: Command[] = [
			...nested,
			{ type: 'clip.place', source: { sequenceId: '$s' }, at: 0, tracks: { video: 'V1' }, ref: '$n' } as Command,
			{ type: 'param.set', target: ['clip', '$n', 'transform', 'scale'], value: 50 } as Command,
		];
		const a = await still(cmds, 40, 'nest-40');
		expect(close(at(a, FX_W / 2, FX_H / 2), [0, 0, 255])).toBe(true); // nested frame 40 = blue
		expect(close(at(a, 10, 10), [0, 0, 0])).toBe(true); // outside the half-size picture: background
		expect(close(at(a, FX_W / 4 + 4, FX_H / 4 + 4), [0, 0, 255])).toBe(true);
		const fast: Command[] = [
			...nested,
			{ type: 'clip.place', source: { sequenceId: '$s' }, at: 0, tracks: { video: 'V1' }, ref: '$n' } as Command,
			{ type: 'clip.setSpeed', clipIds: ['$n'], rate: 2, ripple: false } as Command,
		];
		const b = await still(fast, 35, 'nest-fast-35'); // nested frame 70 = green
		expect(close(at(b, FX_W / 2, FX_H / 2), [0, 255, 0])).toBe(true);
	});

	it('applies an adjustment layer to the tracks below (CSS mode, then canvas mode with opacity and crop)', async () => {
		const base: Command[] = [
			{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0.5, 0, 1] } as Command,
			{ type: 'clip.addAdjustment', at: 0, duration: 60, track: 'V2', ref: '$a' } as Command,
		];
		// Invert-like check with Black & White (a colour op → canvas chain): orange → grey.
		const bw = await still(
			[...base, { type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.black-white' } as Command],
			10,
			'adjust-bw',
		);
		const g = at(bw, FX_W / 2, FX_H / 2);
		expect(Math.abs(g[0] - g[1]) < 6 && Math.abs(g[1] - g[2]) < 6, `grey ${g}`).toBe(true);
		const half = await still(
			[
				...base,
				{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.black-white' } as Command,
				{ type: 'param.set', target: ['clip', '$a', 'opacity'], value: 50 } as Command,
				{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.crop', params: { left: 50 } } as Command,
			],
			10,
			'adjust-half-crop',
		);
		// Left half (cropped away): the original orange; right half: halfway to grey.
		expect(close(at(half, FX_W / 4, FX_H / 2), [255, 128, 0])).toBe(true);
		const r = at(half, (3 * FX_W) / 4, FX_H / 2);
		expect(r[0]).toBeLessThan(245);
		expect(r[0]).toBeGreaterThan(g[0] + 10);
		expect(r[2]).toBeGreaterThan(5);
		// CSS mode (Gaussian Blur): the hard red/blue edge below gets soft.
		const blur = await still(
			[
				{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: RED } as Command,
				{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V2', color: BLUE, ref: '$b' } as Command,
				{ type: 'param.set', target: ['clip', '$b', 'transform', 'scale'], value: 50 } as Command,
				{ type: 'clip.addAdjustment', at: 0, duration: 60, track: 'V3', ref: '$a' } as Command,
				{
					type: 'effect.add',
					target: { clipId: '$a' },
					effectId: 'jasper.gaussian-blur',
					params: { radius: 20 },
				} as Command,
			],
			10,
			'adjust-blur',
		);
		const edge = at(blur, FX_W / 4, FX_H / 2);
		expect(edge[0]).toBeGreaterThan(40);
		expect(edge[2]).toBeGreaterThan(40);
	});

	it('draws Bars and Tone and the counting leader', async () => {
		const bars = await still(
			[
				{ type: 'synthetic.create', kind: 'bars-and-tone', ref: '$b' } as Command,
				{ type: 'clip.place', source: { syntheticId: '$b' }, at: 0 } as Command,
			],
			0,
			'bars',
		);
		expect(close(at(bars, 5, 20), [102, 102, 102], 4)).toBe(true); // 40 % grey side panel
		expect(close(at(bars, FX_W / 8 + 10, 20), [191, 191, 191], 4)).toBe(true); // 75 % white
		expect(close(at(bars, FX_W - 5, 230), [0, 0, 255], 4)).toBe(true); // 100 % blue
		const leader = await still(
			[
				{ type: 'synthetic.create', kind: 'counting-leader', ref: '$l' } as Command,
				{ type: 'clip.place', source: { syntheticId: '$l' }, at: 0 } as Command,
			],
			75, // 2.5 s: numeral 8, half swept
			'leader-75',
		);
		expect(close(at(leader, FX_W - 30, 30), [140, 140, 140], 6)).toBe(true); // swept (wipe colour)
		expect(close(at(leader, 30, FX_H - 30), [199, 199, 199], 6)).toBe(true); // background colour
	});

	it('holds a frame of a moving video', async () => {
		const video: Command[] = [
			{ type: 'media.register', ref: '$m', asset: fxAsset(media, 'video', media.video, FX_W, FX_H) } as unknown as Command,
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
				tracks: { video: 'V1' },
				ref: '$c',
			} as unknown as Command,
		];
		const moving10 = await still(video, 10, 'video-10');
		const moving40 = await still(video, 40, 'video-40');
		const held = [...video, { type: 'clip.addFrameHold', clipIds: ['$c'], at: 10 } as Command];
		const held40 = await still(held, 40, 'held-40');
		let diffMoving = 0;
		let diffHeld = 0;
		for (let i = 0; i < moving10.length; i += 97) {
			diffMoving += Math.abs(moving10[i]! - moving40[i]!);
			diffHeld += Math.abs(moving10[i]! - held40[i]!);
		}
		expect(diffMoving).toBeGreaterThan(diffHeld * 4);
	});
});
