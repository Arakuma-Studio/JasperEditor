// Effect points travel by arc length in layer pixels (docs/wp-notes/spatial-points.md). An independently known
// quarter-circle midpoint detects a missing non-square layer metric even if preview and export share that defect.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testResultsDir } from '@jasper/testkit/env';
import { decodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningEngine } from '../src/index.ts';
import { tempAppdir } from './temp.ts';

const enabled = process.env.REMOTION_E2E === '1';
let engineApi: typeof import('../src/index.ts');
let services: typeof import('../src/tools/services.ts');
let helpers: typeof import('./helpers.ts');
let project: typeof import('@jasper/project');
if (enabled)
	[engineApi, services, helpers, project] = await Promise.all([
		import('../src/index.ts'),
		import('../src/tools/services.ts'),
		import('./helpers.ts'),
		import('@jasper/project'),
	]);

const W = 1280;
const H = 720;
// Radius240 around(640,360). At half the pixel arc a symmetric quarter-circle Bézier is at45°.
const SAMPLES = [
	[0, [400, 360]],
	[15, [470.294372515, 190.294372515]],
	[30, [640, 120]],
] as const;

function decodeFrames(file: string): Buffer[] {
	const r = spawnSync(
		'ffmpeg',
		[
			'-v',
			'error',
			'-i',
			file,
			'-vf',
			`select=${SAMPLES.map(([f]) => `eq(n\\,${f})`).join('+')}`,
			'-fps_mode',
			'passthrough',
			'-frames:v',
			String(SAMPLES.length),
			'-pix_fmt',
			'rgb24',
			'-f',
			'rawvideo',
			'pipe:1',
		],
		{ maxBuffer: 1 << 28 },
	);
	expect(r.status, r.stderr.toString()).toBe(0);
	const stride = W * H * 3;
	expect(r.stdout.length).toBe(stride * SAMPLES.length);
	return SAMPLES.map((_, i) => r.stdout.subarray(i * stride, (i + 1) * stride));
}

function within(rgb: Uint8Array, rgba: Uint8Array, tol: number): number {
	expect(rgb.length * 4).toBe(rgba.length * 3);
	let n = 0;
	for (let i = 0; i < rgb.length; i++)
		if (Math.abs(rgb[i]! - rgba[Math.floor(i / 3) * 4 + (i % 3)]!) <= tol) n++;
	return n / rgb.length;
}

/** Centroid, in pixel centres, of the orange square on black. */
function centroid(rgb: Uint8Array): [number, number] {
	let sx = 0;
	let sy = 0;
	let n = 0;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 3;
			if (rgb[i]! > 128 && rgb[i + 2]! < 100) {
				sx += x + 0.5;
				sy += y + 0.5;
				n++;
			}
		}
	return n ? [sx / n, sy / n] : [Number.NaN, Number.NaN];
}

describe.runIf(enabled)('effect point motion paths: real preview/export positions (REMOTION_E2E=1)', () => {
	let engine: RunningEngine;
	let browser: import('../src/remotion/service.ts').SharedRenderBrowser;
	beforeAll(async () => {
		engine = await engineApi.startEngine({
			appdir: tempAppdir('jasper-spatial-points-'),
			port: Number(process.env.JASPER_E2E_PORT ?? 0),
			// Socket-rendering harness; authentication is owned by server/security suites.
			insecure: true,
			dev: true,
			env: {
				PATH: process.env.PATH,
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
	}, 600_000);
	afterAll(async () => {
		try {
			await browser?.close();
		} finally {
			await engine?.stop();
		}
	});

	it('a curved Transform exports at independently known pixel-distance positions and matches the Program composition', async () => {
		const d = new helpers.DocBuilder('hd-720p-30');
		d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 31, track: 'V1', color: [1, 0.55, 0, 1], ref: '$s' },
			{ type: 'effect.add', target: { clipId: '$s' }, effectId: 'jasper.transform', ref: '$fx' },
			{ type: 'param.set', target: ['effect', '$fx', 'scaleHeight'], value: 12 },
			{
				type: 'keyframe.add',
				target: ['effect', '$fx', 'position'],
				value: [0.3125, 0.5],
				at: { sequenceFrame: 0 },
				interpolation: 'linear',
				spatial: { mode: 'bezier', inTangent: [0, 0], outTangent: [0, -0.1840949166102645] },
			},
			{
				type: 'keyframe.add',
				target: ['effect', '$fx', 'position'],
				value: [0.5, 1 / 6],
				at: { sequenceFrame: 30 },
				interpolation: 'linear',
				spatial: { mode: 'bezier', inTangent: [-0.1035533905932738, 0], outTangent: [0, 0] },
			},
		]);
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...helpers.JSON_H, host: `127.0.0.1:${engine.port}` },
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: {
					sequenceId: d.seqId,
					range: { type: 'entire' },
					container: 'mov',
					engine: 'auto',
					video: {
						codec: 'prores',
						proresProfile: '4444',
						width: W,
						height: H,
						frameRate: { num: 30, den: 1 },
						scaling: 'fit',
						quality: { mode: 'crf', value: 10 },
						encoderSpeed: 'fast',
					},
				},
			},
		});
		expect(r.statusCode, r.body).toBe(202);
		const svc = services.coreServices(engine.app);
		const done = await svc.queue.wait(r.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		expect(done.result).toMatchObject({ renderPath: 'hybrid' });
		const out = (await svc.exports.outputFile(done.id))!;
		const video = decodeFrames(out);
		browser = await svc.remotion.openSharedBrowser();
		const doc = project.buildRenderSnapshot(d.doc, d.seqId, {
			resolveFont: () => null,
			resolveMedia: () => null,
		});
		const dir = tempAppdir('jasper-spatial-ref-');
		const artifacts = testResultsDir('spatial-points');
		mkdirSync(artifacts, { recursive: true });
		copyFileSync(out, join(artifacts, 'curve.mov'));
		for (const [i, [frame, want]] of SAMPLES.entries()) {
			const reference = join(dir, `${frame}.png`);
			await svc.remotion.renderStill({
				inputProps: { doc, options: { isPreview: false, useProxies: false, transparentBackground: false } },
				output: reference,
				frame,
				signal: new AbortController().signal,
				browser,
			});
			copyFileSync(reference, join(artifacts, `${frame}.program.png`));
			const image = decodePng(readFileSync(reference));
			expect([image.width, image.height]).toEqual([W, H]);
			const got = centroid(video[i]!);
			const error = Math.hypot(got[0] - want[0], got[1] - want[1]);
			const share = within(video[i]!, image.data, 3);
			console.info(
				`[spatial points] f${frame} centroid ${got.join(',')} error ${error.toFixed(3)}px; parity ${share.toFixed(6)}`,
			);
			expect(error, `frame ${frame} centroid ${got.join(',')}`).toBeLessThan(1);
			expect(share, `frame ${frame}`).toBeGreaterThanOrEqual(0.99);
		}
	}, 1_800_000);
});
