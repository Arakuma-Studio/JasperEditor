// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FX_FAMILIES } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
const FAMILY = FX_FAMILIES.find((f) => f.file === 'sapphire-textures-clouds')?.effects ?? [];

describe.runIf(enabled)(
	'sapphire-textures-clouds in Remotion renders (REMOTION_E2E=1)',
	{ timeout: 1_800_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		const keep = process.env.STC_STILLS_DIR;
		const browserExecutable =
			process.env.JASPER_BROWSER_EXECUTABLE ??
			(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
		const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};

		beforeAll(async () => {
			media = await startFxMedia('fx-stc-');
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			if (keep) mkdirSync(keep, { recursive: true });
		}, 600_000);

		afterAll(() => {
			media?.close();
		});

		async function still(effectId: string, frame: number): Promise<Buffer> {
			const doc = fxSnapshot([...fxCmd.solid([0.2, 0.3, 0.4, 1]), fxCmd.effect(effectId)]);
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
			const name = `${effectId.replace('jasper.s.', '')}-f${frame}.png`;
			const output = join(media.dir, name);
			await renderer.renderStill({ composition, serveUrl, inputProps, frame, output, ...browser });
			if (keep) copyFileSync(output, join(keep, name));
			return execFileSync(
				'ffmpeg',
				['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
				{
					maxBuffer: 1 << 26,
				},
			);
		}
		const std = (raw: Buffer) => {
			let s = 0;
			let q = 0;
			for (const v of raw) {
				s += v;
				q += v * v;
			}
			const m = s / raw.length;
			return Math.sqrt(Math.max(0, q / raw.length - m * m));
		};
		const diff = (a: Buffer, b: Buffer) => {
			let d = 0;
			for (let i = 0; i < a.length; i += 7) d += Math.abs(a[i]! - b[i]!);
			return d / Math.ceil(a.length / 7);
		};

		it('every generator renders a textured frame', async () => {
			expect(FAMILY).toHaveLength(21);
			const flat: string[] = [];
			for (const s of FAMILY) {
				const raw = await still(s.id, 15);
				expect(raw.length).toBe(FX_W * FX_H);
				if (!(std(raw) > 4)) flat.push(`${s.id}: std ${std(raw).toFixed(2)}`);
			}
			expect(flat).toEqual([]);
		});

		it('animated clouds move between frames; a time-invariant texture does not', async () => {
			const a = await still('jasper.s.clouds-vortex', 5);
			const b = await still('jasper.s.clouds-vortex', 25);
			expect(diff(a, b)).toBeGreaterThan(3);
			const c = await still('jasper.s.texture-noise-emboss', 5);
			const d = await still('jasper.s.texture-noise-emboss', 25);
			expect(diff(c, d)).toBe(0);
		});
	},
);
