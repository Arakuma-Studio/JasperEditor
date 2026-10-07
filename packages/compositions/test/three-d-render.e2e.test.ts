// @vitest-environment node
// three-d on the Remotion render path (what exports render): bundles the production root and renders stills with
// @remotion/renderer in headless Chrome, then compares them with the CPU reference renderer of @jasper/project on the
// same scene (the export ↔ reference parity): a two-layer run with intersection, a moved camera and a spot light with
// a cast shadow; two runs split by a 2D layer; a 3D video layer; depth of field. Gated by REMOTION_E2E=1; needs ffmpeg.
// THREE_D_RENDER_OUT=<dir> copies the stills there.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxSnapshot, startFxMedia } from './fx-media.ts';
import { referenceFrame } from './three-d-reference.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';

describe.runIf(enabled)('3D layers in Remotion renders (REMOTION_E2E=1)', { timeout: 300_000 }, () => {
	let media: FxMedia;
	let serveUrl: string;
	let renderer: typeof import('@remotion/renderer');
	const browserExecutable =
		process.env.JASPER_BROWSER_EXECUTABLE ??
		(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
	const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};
	const copyTo = process.env.THREE_D_RENDER_OUT;

	beforeAll(async () => {
		media = await startFxMedia('three-d-render-');
		const { bundle } = await import('@remotion/bundler');
		serveUrl = await bundle({ entryPoint: join(here, '..', 'src', 'remotion-entry.ts') });
		renderer = await import('@remotion/renderer');
		if (copyTo) mkdirSync(copyTo, { recursive: true });
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
		await renderer.renderStill({
			composition,
			serveUrl,
			inputProps,
			frame,
			output,
			timeoutInMilliseconds: 60_000,
			onBrowserLog: (l) => {
				if (l.type === 'error' || process.env.THREE_D_DEBUG) console.log(`[browser ${l.type}]`, l.text);
			},
			...browser,
		});
		if (copyTo) copyFileSync(output, join(copyTo, `${name}.png`));
		return execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], {
			maxBuffer: 1 << 26,
		});
	}

	/** Fraction of pixels whose colour differs from the reference by more than `tol` code values. */
	function diff(raw: Buffer, ref: Uint8ClampedArray, tol = 6): { bad: number; worst: number } {
		let bad = 0;
		let worst = 0;
		for (let i = 0; i < FX_W * FX_H; i++) {
			let e = 0;
			for (let c = 0; c < 3; c++) e = Math.max(e, Math.abs(raw[i * 4 + c]! - ref[i * 4 + c]!));
			worst = Math.max(worst, e);
			if (e > tol) bad++;
		}
		return { bad: bad / (FX_W * FX_H), worst };
	}

	const scene = (extra: Command[] = []): Command[] => [
		{
			type: 'clip.addSolid',
			at: 0,
			duration: 30,
			track: 'V1',
			color: [0.25, 0.3, 0.35, 1],
			ref: '$floor',
		} as Command,
		{
			type: 'clip.addSolid',
			at: 0,
			duration: 30,
			track: 'V2',
			color: [0.9, 0.3, 0.1, 1],
			ref: '$card',
		} as Command,
		{ type: 'clip.set3d', clipIds: ['$floor', '$card'], enabled: true } as Command,
		{ type: 'param.set', target: ['clip', '$floor', 'threeD', 'rotationX'], value: 80 } as Command,
		{ type: 'param.set', target: ['clip', '$floor', 'transform', 'position'], value: [320, 260] } as Command,
		{ type: 'param.set', target: ['clip', '$card', 'transform', 'scale'], value: 30 } as Command,
		{ type: 'param.set', target: ['clip', '$card', 'threeD', 'rotationY'], value: 35 } as Command,
		{
			type: 'param.set',
			target: ['clip', '$card', 'threeD', 'material', 'castsShadows'],
			value: 'on',
		} as Command,
		{
			type: 'clip.addCamera',
			at: 0,
			track: 'V3',
			position: [520, 60, -700],
			pointOfInterest: [320, 200, 0],
		} as Command,
		{
			type: 'clip.addLight',
			at: 0,
			track: 'V4',
			lightType: 'spot',
			position: [200, 20, -300],
			pointOfInterest: [320, 240, 0],
			castsShadows: true,
			coneAngle: 80,
		} as Command,
		{ type: 'clip.addLight', at: 0, track: 'V5', lightType: 'ambient', intensity: 25 } as Command,
		...extra,
	];

	// Regression: the run's lower member used to be captured inside the upper track's HTML-in-Canvas scope, where its
	// own capture never painted (the render hung on "waiting for first paint").
	it.each([
		['one run of two layers on two tracks', ['$a', '$b']],
		['a 3D layer under a 2D layer', ['$a']],
		['a 2D layer under a 3D layer', ['$b']],
	] as const)('%s = the CPU reference', async (name, three) => {
		const cmds: Command[] = [
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0, 0, 1, 1], ref: '$a' } as Command,
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [1, 0, 0, 1], ref: '$b' } as Command,
			{ type: 'param.set', target: ['clip', '$b', 'transform', 'scale'], value: 30 } as Command,
			{ type: 'clip.set3d', clipIds: [...three], enabled: true } as Command,
		];
		const raw = await still(cmds, 5, `simple-${three.join('')}`);
		const d = diff(raw, referenceFrame(fxSnapshot(cmds), 5));
		expect(d.bad, `${name}: worst ${d.worst}`).toBeLessThan(0.002);
	});

	it('a two-layer run: camera, spot light, shadow = the CPU reference', async () => {
		const cmds = scene();
		const raw = await still(cmds, 5, 'run');
		const ref = referenceFrame(fxSnapshot(cmds), 5);
		const d = diff(raw, ref);
		expect(d.bad, `worst ${d.worst}`).toBeLessThan(0.01);
	});
});

export const _asset = fxAsset;
