// @vitest-environment node
// Track Matte Key over a new background with a soft matte (docs/wp-notes/track-matte-holdout.md): the plain key
// equals the CPU "over" of the plate (no compositing error: the halo is the old background inside the plate's edge
// pixels), Decontaminate Edges ▸ Clean Plate Track equals the matting-equation unmix, Estimate from Background
// brings the edge close to the true foreground, and the Program preview equals the export render.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { encodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxPixels, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

/** The soft edge: α = 1 left of x = 300, a 24 px linear ramp, 0 from x = 324. */
const EDGE0 = 300;
const EDGE_W = 24;
const alphaAt = (x: number) => Math.min(1, Math.max(0, 1 - (x + 0.5 - EDGE0) / EDGE_W));
const F = (y: number): number[] => [40, 200 - (60 * y) / FX_H, 90];
const B = (y: number): number[] => [220, 40 + (100 * y) / FX_H, 30];
/** The new background (V1 solid), exact 8-bit values. */
const N = [20, 60, 230];

type Plane = { plate: Uint8Array; matte: Uint8Array; clean: Uint8Array };

function planes(): Plane {
	const plate = new Uint8Array(FX_W * FX_H * 4);
	const matte = new Uint8Array(FX_W * FX_H * 4);
	const clean = new Uint8Array(FX_W * FX_H * 4);
	for (let y = 0; y < FX_H; y++)
		for (let x = 0; x < FX_W; x++) {
			const i = (y * FX_W + x) * 4;
			const a = alphaAt(x);
			const f = F(y);
			const b = B(y);
			for (let c = 0; c < 3; c++) {
				plate[i + c] = Math.round(a * f[c]! + (1 - a) * b[c]!);
				clean[i + c] = Math.round(b[c]!);
				matte[i + c] = 255;
			}
			plate[i + 3] = 255;
			clean[i + 3] = 255;
			matte[i + 3] = Math.round(a * 255);
		}
	return { plate, matte, clean };
}

describe.runIf(enabled)(
	'Track Matte Key hold-out over a new background (REMOTION_E2E=1)',
	{ timeout: 300_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const p = planes();

		beforeAll(async () => {
			media = await startFxMedia('track-matte-holdout-');
			for (const [name, data] of Object.entries(p))
				writeFileSync(join(media.dir, `${name}.png`), encodePng({ width: FX_W, height: FX_H, data }));
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
		}, 300_000);
		afterAll(() => media?.close());

		const image = (name: string, ref: string, alpha = false): Command => {
			const asset = fxAsset(media, 'image', `${name}.png`, FX_W, FX_H);
			if (alpha) (asset.probe as { hasAlpha: boolean }).hasAlpha = true;
			return { type: 'media.register', ref, asset } as unknown as Command;
		};
		const place = (mediaRef: string, track: string, ref?: string): Command =>
			({
				type: 'clip.place',
				source: { mediaId: mediaRef },
				at: 0,
				tracks: { video: track },
				...(ref ? { ref } : {}),
			}) as unknown as Command;

		/** V1 new background, V2 the plate with the key, V3 the matte and V4 the clean plate (both hidden). */
		const scene = (key: Record<string, unknown>) =>
			fxSnapshot((doc) => {
				const seq = Object.values(doc.sequences)[0]!;
				const v3 = seq.videoTracks[2]!.id;
				return [
					{ type: 'track.add', kind: 'video', ref: '$v4' } as Command,
					{
						type: 'clip.addSolid',
						at: 0,
						duration: 30,
						track: 'V1',
						color: [N[0]! / 255, N[1]! / 255, N[2]! / 255, 1],
					} as Command,
					image('plate', '$pm'),
					image('matte', '$mm', true),
					image('clean', '$cm'),
					place('$pm', 'V2', '$plate'),
					place('$mm', 'V3'),
					place('$cm', 'V4'),
					{
						type: 'effect.add',
						target: { clipId: '$plate' },
						effectId: 'jasper.track-matte-key',
						params: { matteTrack: v3, cleanPlateTrack: '$v4', ...key },
					} as Command,
					{ type: 'track.update', trackId: v3, patch: { output: false } } as Command,
					{ type: 'track.update', trackId: '$v4', patch: { output: false } } as Command,
				];
			});

		async function still(
			doc: ReturnType<typeof fxSnapshot>,
			name: string,
			isPreview = false,
		): Promise<Buffer> {
			const inputProps = { doc, options: { isPreview, useProxies: false, transparentBackground: false } };
			const composition = await renderer.selectComposition({
				serveUrl,
				id: SEQUENCE_COMPOSITION_ID,
				inputProps,
			});
			const output = join(media.dir, `${name}.png`);
			await renderer.renderStill({ composition, serveUrl, inputProps, frame: 2, output });
			const { readFileSync } = await import('node:fs');
			return fxPixels(readFileSync(output));
		}

		/** Max and mean |a − b| over the rows, in the soft edge band [x0, x1) (8-bit units). */
		function diff(raw: Buffer, want: (x: number, y: number) => number[], x0 = 0, x1 = FX_W) {
			let max = 0;
			let sum = 0;
			let n = 0;
			for (let y = 0; y < FX_H; y++)
				for (let x = x0; x < x1; x++) {
					const w = want(x, y);
					const i = (y * FX_W + x) * 3;
					for (let c = 0; c < 3; c++) {
						const d = Math.abs(raw[i + c]! - w[c]!);
						max = Math.max(max, d);
						sum += d;
						n++;
					}
				}
			return { max, mean: sum / n };
		}
		const px = (plane: Uint8Array, x: number, y: number) => {
			const i = (y * FX_W + x) * 4;
			return [plane[i]!, plane[i + 1]!, plane[i + 2]!, plane[i + 3]!];
		};
		const over = (fg: number[], a: number) => fg.map((v, c) => v + (1 - a) * N[c]!);
		/** The true foreground over N (what a perfect hold-out gives). */
		const truth = (x: number, y: number) =>
			over(
				F(y).map((v) => v * alphaAt(x)),
				alphaAt(x),
			);
		/** CPU reference of the plain key: the plate's pixel at the matte's alpha, over N. */
		const plainRef = (x: number, y: number) => {
			const a = px(p.matte, x, y)[3]! / 255;
			return over(
				px(p.plate, x, y)
					.slice(0, 3)
					.map((v) => v * a),
				a,
			);
		};
		/** CPU reference of the clean-plate unmix: αF = clamp(I − (1 − α)B, 0, α). */
		const cleanRef = (x: number, y: number) => {
			const a = px(p.matte, x, y)[3]! / 255;
			const I = px(p.plate, x, y);
			const b = px(p.clean, x, y);
			return over(
				[0, 1, 2].map((c) => Math.min(a * 255, Math.max(0, I[c]! - (1 - a) * b[c]!))),
				a,
			);
		};
		const band: [number, number] = [EDGE0 - 4, EDGE0 + EDGE_W + 4];

		it('the plain key equals the CPU over of the plate: the halo is the old background in the edge pixels', async () => {
			const raw = await still(scene({}), 'tmk-plain');
			const ref = diff(raw, plainRef);
			console.info(`plain vs CPU reference: max ${ref.max}, mean ${ref.mean.toFixed(3)}`);
			expect(ref.max).toBeLessThanOrEqual(2);
			// The halo itself: up to α(1 − α)·|B − F| off the true foreground in the edge.
			const halo = diff(raw, truth, ...band);
			console.info(`plain vs true foreground (edge band): max ${halo.max}, mean ${halo.mean.toFixed(2)}`);
			expect(halo.max).toBeGreaterThan(30);
		});

		it('Clean Plate Track unmixes the edge exactly; Estimate from Background comes close; preview = export', async () => {
			const clean = scene({ decontaminate: 'cleanPlate' });
			const raw = await still(clean, 'tmk-clean');
			const ref = diff(raw, cleanRef);
			const vsTruth = diff(raw, truth, ...band);
			console.info(
				`clean plate vs CPU unmix: max ${ref.max}, mean ${ref.mean.toFixed(3)}; vs true foreground (edge band): max ${vsTruth.max}, mean ${vsTruth.mean.toFixed(3)}`,
			);
			expect(ref.max).toBeLessThanOrEqual(2);
			expect(vsTruth.max).toBeLessThanOrEqual(3);
			const preview = await still(clean, 'tmk-clean-preview', true);
			const same = diff(preview, (x, y) => {
				const i = (y * FX_W + x) * 3;
				return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
			});
			console.info(`clean plate preview vs export: max ${same.max}, mean ${same.mean.toFixed(4)}`);
			expect(same.max).toBeLessThanOrEqual(1);

			const est = await still(scene({ decontaminate: 'estimate' }), 'tmk-estimate');
			const plain = diff(await still(scene({}), 'tmk-plain-2'), truth, ...band);
			const e = diff(est, truth, ...band);
			console.info(
				`estimate vs true foreground (edge band): max ${e.max}, mean ${e.mean.toFixed(2)} (plain: max ${plain.max}, mean ${plain.mean.toFixed(2)})`,
			);
			expect(e.mean).toBeLessThan(plain.mean / 4);
			// Outside the edge the estimate changes nothing.
			expect(diff(est, cleanRef, 0, EDGE0 - 1).max).toBeLessThanOrEqual(2);
			expect(diff(est, cleanRef, EDGE0 + EDGE_W + 1, FX_W).max).toBeLessThanOrEqual(2);
		});
	},
);
