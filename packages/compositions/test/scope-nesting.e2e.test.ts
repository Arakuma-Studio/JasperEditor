// @vitest-environment node
// Chrome cannot nest HTML-in-Canvas scopes. Consecutive tracks with GL blend modes must share one scope.
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

describe.runIf(enabled)('scope nesting in Remotion renders (REMOTION_E2E=1)', { timeout: 300_000 }, () => {
	let media: FxMedia;
	let serveUrl: string;
	let renderer: typeof import('@remotion/renderer');
	const browserExecutable =
		process.env.JASPER_BROWSER_EXECUTABLE ??
		(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
	const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};

	beforeAll(async () => {
		media = await startFxMedia('scope-nesting-');
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
	const expected = (layers: { c: Rgba; mode: string }[]): Rgb => {
		let dst: Rgba = [0, 0, 0, 1];
		for (const l of layers) dst = blendPixel(l.mode, dst, l.c, 0);
		return [Math.round(dst[0] * 255), Math.round(dst[1] * 255), Math.round(dst[2] * 255)];
	};
	const near = (a: Rgb, b: Rgb, tol = 4) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

	it('two tracks with GL blend modes (and a Normal track between them) render in one scope', async () => {
		const base: Rgba = [0.8, 0.4, 0.2, 1];
		const mid: Rgba = [0.3, 0.6, 0.9, 1];
		const top: Rgba = [0.5, 0.5, 0.25, 1];
		const normal: Rgba = [0.1, 0.9, 0.1, 1];
		const cmds: Command[] = [
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: base } as Command,
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: mid, ref: '$b' } as Command,
			{ type: 'clip.update', clipId: '$b', patch: { blendMode: 'linear-burn' } } as Command,
			// a small Normal layer on V3 (left quarter), then Color Dodge over the whole frame on V4
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V3', color: normal, ref: '$n' } as Command,
			{ type: 'param.set', target: ['clip', '$n', 'transform', 'scale'], value: 25 } as Command,
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V4', color: top, ref: '$t' } as Command,
			{ type: 'clip.update', clipId: '$t', patch: { blendMode: 'color-dodge' } } as Command,
		];
		const raw = await still(cmds, 5, 'two-gl-tracks');
		// a corner pixel: base · linear burn · color dodge (the Normal layer does not reach it)
		const corner = at(raw, 8, 8);
		expect(
			near(
				corner,
				expected([
					{ c: base, mode: 'normal' },
					{ c: mid, mode: 'linear-burn' },
					{ c: top, mode: 'color-dodge' },
				]),
			),
			`corner ${corner}`,
		).toBe(true);
		// the centre: the Normal layer between them, dodged by V4
		const centre = at(raw, FX_W / 2, FX_H / 2);
		expect(
			near(
				centre,
				expected([
					{ c: base, mode: 'normal' },
					{ c: mid, mode: 'linear-burn' },
					{ c: normal, mode: 'normal' },
					{ c: top, mode: 'color-dodge' },
				]),
			),
			`centre ${centre}`,
		).toBe(true);
	});
});
