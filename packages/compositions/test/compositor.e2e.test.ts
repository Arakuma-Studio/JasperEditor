// @vitest-environment node
// compositor: stacks whose canvas scopes used to nest (CANVAS_NESTED) are drawn by the flat compositor (fx/flat.tsx).
// Every combination that failed before renders here on the Remotion path against values computed independently from
// the formulas (`blendPixel` = the native kernel, Invert = 1 − c, the BT.1886 / sRGB curves for linear light, the CPU
// 3D reference). Gated by REMOTION_E2E=1; needs ffmpeg on PATH.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blendPixel, type Command, type Rgba } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
type Rgb = [number, number, number];

const solid = (track: string, color: Rgba, ref: string, at = 0, duration = 30): Command =>
	({ type: 'clip.addSolid', at, duration, track, color, ref }) as Command;
const mode = (ref: string, blendMode: string): Command =>
	({ type: 'clip.update', clipId: ref, patch: { blendMode } }) as Command;
const adjustment = (track: string, ref: string, at = 0, duration = 30): Command =>
	({ type: 'clip.addAdjustment', at, duration, track, ref }) as Command;
const effect = (ref: string, effectId: string): Command =>
	({ type: 'effect.add', target: { clipId: ref }, effectId }) as Command;

/** `layers` composited bottom → top with `blendPixel` over opaque black, as 8-bit RGB. */
export function expectedRgb(layers: { c: Rgba; mode: string }[], post?: (c: Rgba) => Rgba): Rgb {
	let dst: Rgba = [0, 0, 0, 1];
	for (const l of layers) dst = blendPixel(l.mode, dst, l.c, 0);
	if (post) dst = post(dst);
	return [Math.round(dst[0] * 255), Math.round(dst[1] * 255), Math.round(dst[2] * 255)];
}
const invert = (c: Rgba): Rgba => [1 - c[0], 1 - c[1], 1 - c[2], c[3]];

describe.runIf(enabled)('flat compositor in Remotion renders (REMOTION_E2E=1)', { timeout: 300_000 }, () => {
	let media: FxMedia;
	let serveUrl: string;
	let renderer: typeof import('@remotion/renderer');
	const browserExecutable =
		process.env.JASPER_BROWSER_EXECUTABLE ??
		(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
	const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};

	beforeAll(async () => {
		media = await startFxMedia('compositor-');
		const { bundle } = await import('@remotion/bundler');
		serveUrl = await bundle({ entryPoint: join(here, '..', 'src', 'remotion-entry.ts') });
		renderer = await import('@remotion/renderer');
	}, 300_000);
	afterAll(() => media?.close());

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
		return execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
			maxBuffer: 1 << 26,
		});
	}
	const at = (raw: Buffer, x: number, y: number): Rgb => {
		const i = (Math.round(y) * FX_W + Math.round(x)) * 3;
		return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
	};
	const near = (a: Rgb, b: Rgb, tol = 4) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

	const base: Rgba = [0.8, 0.4, 0.2, 1];
	const mid: Rgba = [0.3, 0.6, 0.9, 1];
	const top: Rgba = [0.5, 0.5, 0.25, 1];

	it('an adjustment layer with GPU effects over a GL blend-mode track', async () => {
		const raw = await still(
			[
				solid('V1', base, '$a'),
				solid('V2', mid, '$b'),
				mode('$b', 'linear-burn'),
				adjustment('V3', '$adj'),
				effect('$adj', 'jasper.invert'),
			],
			5,
			'adjust-over-blend',
		);
		const want = expectedRgb(
			[
				{ c: base, mode: 'normal' },
				{ c: mid, mode: 'linear-burn' },
			],
			invert,
		);
		const got = at(raw, FX_W / 2, FX_H / 2);
		expect(near(got, want), `centre ${got} want ${want}`).toBe(true);
	});

	it('a GL blend-mode track over an adjustment layer with GPU effects', async () => {
		const raw = await still(
			[
				solid('V1', base, '$a'),
				adjustment('V2', '$adj'),
				effect('$adj', 'jasper.invert'),
				solid('V3', top, '$t'),
				mode('$t', 'color-dodge'),
			],
			5,
			'blend-over-adjust',
		);
		let dst = invert(base);
		dst = blendPixel('color-dodge', dst, top, 0);
		const want: Rgb = [Math.round(dst[0] * 255), Math.round(dst[1] * 255), Math.round(dst[2] * 255)];
		const got = at(raw, FX_W / 2, FX_H / 2);
		expect(near(got, want), `centre ${got} want ${want}`).toBe(true);
	});
});
