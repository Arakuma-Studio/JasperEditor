// @vitest-environment node
// An adjustment layer's effects (Transform here) see the composite of the layers below as it is, at any output size:
// stills at another width than the sequence's (`render_frame`, exports) render with Remotion `scale`, where Chrome's
// HTML-in-Canvas capture of the scope drew the video canvases below at 1/scale (a zoom into the top-left corner).
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { diffImages, formatDiff, Tolerance, writePng } from '@jasper/testkit/golden';
import type { Rgba8 } from '@jasper/testkit/image';
import { decodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { type FxMedia, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

describe.runIf(enabled)('Transform on an adjustment layer (REMOTION_E2E=1)', { timeout: 300_000 }, () => {
	let media: FxMedia;
	let serveUrl: string;
	let renderer: typeof import('@remotion/renderer');
	const browserExecutable =
		process.env.JASPER_BROWSER_EXECUTABLE ??
		(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
	const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};
	const out = process.env.ADJUSTMENT_TRANSFORM_OUT;

	beforeAll(async () => {
		media = await startFxMedia('adjustment-transform-');
		const { bundle } = await import('@remotion/bundler');
		serveUrl = await bundle({ entryPoint: join(here, '..', 'src', 'remotion-entry.ts') });
		renderer = await import('@remotion/renderer');
		if (out) mkdirSync(out, { recursive: true });
	}, 300_000);

	afterAll(() => media?.close());

	async function still(commands: Command[], scale: number, name: string): Promise<Rgba8> {
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
		await renderer.renderStill({ composition, serveUrl, inputProps, frame: 5, output, scale, ...browser });
		const img = decodePng(readFileSync(output));
		if (out) writePng(join(out, `${name}.png`), img);
		return img;
	}

	const transform = (target: string, params: Record<string, unknown>): Command =>
		({ type: 'effect.add', target: { clipId: target }, effectId: 'jasper.transform', params }) as Command;
	const adjustment: Command = {
		type: 'clip.addAdjustment',
		at: 0,
		duration: 30,
		track: 'V2',
		ref: '$a',
	} as Command;

	it.each([0.5, 1.5])(
		'identity on an adjustment layer leaves the frame unchanged (scale %s)',
		async (scale) => {
			const plain = await still(fxCmd.video(media), scale, `plain-${scale}`);
			const adjusted = await still(
				[...fxCmd.video(media), adjustment, transform('$a', {})],
				scale,
				`identity-${scale}`,
			);
			const d = diffImages(plain, adjusted);
			expect(Tolerance.accepts(Tolerance.BROWSER, d), formatDiff(d)).toBe(true);
		},
	);

	it('scaled about an anchor equals the same Transform on the footage clip', async () => {
		const params = { anchorPoint: [0.5, 0.38], position: [0.5, 0.38], scaleHeight: 180 };
		const onClip = await still([...fxCmd.video(media), transform('$c', params)], 0.5, 'scaled-clip');
		const onAdjustment = await still(
			[...fxCmd.video(media), adjustment, transform('$a', params)],
			0.5,
			'scaled-adjustment',
		);
		const d = diffImages(onClip, onAdjustment);
		expect(Tolerance.accepts(Tolerance.BROWSER, d), formatDiff(d)).toBe(true);
	});
});
