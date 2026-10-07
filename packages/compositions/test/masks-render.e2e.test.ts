// @vitest-environment node
// wp masks on the Remotion render path (the preview's code, rendered by @remotion/renderer in headless Chrome as the
// engine's export and layer bakes do): Opacity masks against the CPU coverage definition (the native export
// kernel's: preview/export parity), a masked effect, and Track Matte Key reading a hidden track (alpha, luma,
// reverse). Gated by REMOTION_E2E=1; needs ffmpeg on PATH.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Command, rasterizeMasks, rectPath, resolveSceneAt } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
type Rgb = [number, number, number];

describe.runIf(enabled)(
	'masks and track mattes in Remotion renders (REMOTION_E2E=1)',
	{ timeout: 180_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};

		beforeAll(async () => {
			media = await startFxMedia('masks-render-');
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
		}, 300_000);
		afterAll(() => media?.close());

		async function still(doc: ReturnType<typeof fxSnapshot>, frame: number, name: string): Promise<Buffer> {
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

		const plateAndCard = (extra: Command[]): Command[] => [
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0, 0, 0.5, 1] } as Command,
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [1, 1, 1, 1], ref: '$c' } as Command,
			...extra,
		];

		it('Opacity masks: every pixel equals the CPU coverage (the native kernel’s) within 2/255', async () => {
			const doc = fxSnapshot(
				plateAndCard([
					{
						type: 'mask.add',
						clipId: '$c',
						shape: 'ellipse',
						feather: 24,
						expansion: 6,
						ref: '$a',
					} as Command,
					{
						type: 'mask.add',
						clipId: '$c',
						shape: 'polygon',
						mode: 'subtract',
						feather: 0,
						ref: '$b',
					} as Command,
					{
						type: 'param.set',
						target: ['mask', '$b', 'path'],
						value: rectPath(0.5, 0.3, 0.8, 0.6),
					} as Command,
				]),
			);
			const raw = await still(doc, 3, 'opacity-masks');
			const layer = resolveSceneAt(doc, 3).find((l) => l.clip.kind === 'solid' && l.trackIndex === 1)!;
			const cov = rasterizeMasks(layer.props.masks, FX_W, FX_H, (q) => [q[0] * FX_W, q[1] * FX_H], 1)!;
			let worst = 0;
			for (let y = 0; y < FX_H; y++)
				for (let x = 0; x < FX_W; x++) {
					const a = cov[y * FX_W + x]!;
					const want: Rgb = [255 * a, 255 * a, 128 * (1 - a) + 255 * a];
					const got = at(raw, x, y);
					for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(got[k]! - want[k]!));
				}
			expect(worst).toBeLessThanOrEqual(2);
		});

		it('a masked effect applies inside its mask only', async () => {
			const doc = fxSnapshot(
				plateAndCard([
					{
						type: 'effect.add',
						target: { clipId: '$c' },
						effectId: 'test.s.gradient',
						params: { startColor: [1, 0, 0, 1], endColor: [1, 0, 0, 1] },
						ref: '$fx',
					} as Command,
					{ type: 'mask.add', effectId: '$fx', shape: 'polygon', feather: 0, ref: '$m' } as Command,
					{ type: 'param.set', target: ['mask', '$m', 'path'], value: rectPath(0, 0, 0.5, 1) } as Command,
				]),
			);
			const raw = await still(doc, 0, 'masked-effect');
			const left = at(raw, FX_W * 0.25, FX_H / 2);
			const right = at(raw, FX_W * 0.75, FX_H / 2);
			expect(left[0]).toBeGreaterThan(240);
			expect(left[1]).toBeLessThan(20);
			expect(right).toEqual([255, 255, 255]);
		});

		it('Track Matte Key reads a hidden track: alpha, luma and reverse', async () => {
			const build = (opts: { compositeUsing?: string; reverse?: boolean }) =>
				fxSnapshot((p) => {
					const seq = Object.values(p.sequences)[0]!;
					const v3 = seq.videoTracks[2]!.id;
					return [
						{
							type: 'clip.addSolid',
							at: 0,
							duration: 30,
							track: 'V1',
							color: [1, 0, 0, 1],
							ref: '$fill',
						} as Command,
						{
							type: 'effect.add',
							target: { clipId: '$fill' },
							effectId: 'jasper.track-matte-key',
							params: { matteTrack: v3, ...opts },
						} as Command,
						// The matte: a grey (50 %) rectangle shape on V3, hidden.
						{
							type: 'clip.addShape',
							at: 0,
							duration: 30,
							track: 'V3',
							shape: { type: 'rect', size: [200, 100], fill: [0.5, 0.5, 0.5, 1] },
						} as Command,
						{ type: 'track.update', trackId: v3, patch: { output: false } } as Command,
					];
				});
			const alpha = await still(build({}), 2, 'tmk-alpha');
			// Inside the centred 200×100 rect: the red fill; outside: the black background. The hidden track is not drawn.
			expect(at(alpha, FX_W / 2, FX_H / 2)[0]).toBeGreaterThan(245);
			expect(at(alpha, 20, 20)).toEqual([0, 0, 0]);
			const luma = await still(build({ compositeUsing: 'matteLuma' }), 2, 'tmk-luma');
			expect(Math.abs(at(luma, FX_W / 2, FX_H / 2)[0] - 128)).toBeLessThan(10);
			const rev = await still(build({ reverse: true }), 2, 'tmk-reverse');
			expect(at(rev, FX_W / 2, FX_H / 2)).toEqual([0, 0, 0]);
			expect(at(rev, 20, 20)[0]).toBeGreaterThan(245);
		});
	},
);
