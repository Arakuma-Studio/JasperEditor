// @vitest-environment node
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

	// Capturing a 3D run member inside another HTML-in-Canvas scope prevents its own capture from painting.
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

	it("a 2D video below a 3D run is the run's backdrop (the camera tracker case)", async () => {
		const cmds: Command[] = [
			{
				type: 'media.register',
				ref: '$m',
				asset: fxAsset(media, 'video', media.video, FX_W, FX_H),
			} as unknown as Command,
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
				tracks: { video: 'V1' },
			} as unknown as Command,
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [1, 0, 0, 1], ref: '$s' } as Command,
			{ type: 'param.set', target: ['clip', '$s', 'transform', 'scale'], value: 20 } as Command,
			{ type: 'clip.set3d', clipIds: ['$s'], enabled: true } as Command,
			{ type: 'param.set', target: ['clip', '$s', 'threeD', 'rotationY'], value: 40 } as Command,
		];
		const raw = await still(cmds, 5, 'video-under-run');
		// testsrc2 is colourful everywhere: the corners (outside the card) are not black, the centre is the red card.
		const at = (x: number, y: number) => [0, 1, 2].map((c) => raw[(y * FX_W + x) * 4 + c]!);
		const corners = [at(20, 20), at(FX_W - 20, 20), at(20, FX_H - 20), at(FX_W - 20, FX_H - 20)];
		expect(corners.filter((c) => c[0]! + c[1]! + c[2]! > 60).length).toBeGreaterThanOrEqual(3);
		const mid = at(FX_W / 2, FX_H / 2);
		expect(mid[0]).toBeGreaterThan(180);
		expect(mid[1]).toBeLessThan(80);
	});

	it('Advanced 3D: the run renders lit with a shadow map, and extruded text shows its walls', async () => {
		const text = (depth: number): Command[] => [
			{ type: 'sequence.set3dRenderer', renderer: 'advanced' } as Command,
			{
				type: 'clip.addText',
				at: 0,
				duration: 30,
				track: 'V6',
				content: { text: 'O', style: { sizePx: 160 } },
				ref: '$t',
			} as Command,
			{ type: 'clip.set3d', clipIds: ['$t'], enabled: true } as Command,
			{ type: 'param.set', target: ['clip', '$t', 'threeD', 'rotationY'], value: 45 } as Command,
			{
				type: 'param.set',
				target: ['clip', '$t', 'threeD', 'geometry', 'extrusionDepth'],
				value: depth,
			} as Command,
		];
		const flat = await still(scene(text(0)), 5, 'advanced-flat');
		const ext = await still(scene(text(60)), 5, 'advanced-extruded');
		const classic = await still(scene(), 5, 'classic-run');
		let changed = 0;
		for (let i = 0; i < FX_W * FX_H; i++) {
			let e = 0;
			for (let c = 0; c < 3; c++) e = Math.max(e, Math.abs(flat[i * 4 + c]! - ext[i * 4 + c]!));
			if (e > 30) changed++;
		}
		expect(changed / (FX_W * FX_H)).toBeGreaterThan(0.002);
		const d = diff(flat, new Uint8ClampedArray(classic), 60);
		expect(d.bad).toBeLessThan(0.25);
	});
});

export const _asset = fxAsset;
