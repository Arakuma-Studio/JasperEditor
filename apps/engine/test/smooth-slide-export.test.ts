// Real encoded Smooth Slide spans must match the Program composition on both export paths (AGENTS §4,
// docs/wp-notes/smooth-slide.md). Flat contrasting inputs isolate span timing/compositing from incidental JPEG
// texture loss; literal GL tests and Player parity own detailed effect geometry and image-source behavior.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningEngine } from '../src/index.ts';
import type { DocBuilder } from './helpers.ts';
import { tempAppdir } from './temp.ts';

const enabled = process.env.REMOTION_E2E === '1';
let engineApi: typeof import('../src/index.ts');
let services: typeof import('../src/tools/services.ts');
let helpers: typeof import('./helpers.ts');
let project: typeof import('@jasper/project');
// Disabled opt-in files keep their explicit skipped case without initializing the full engine.
if (enabled)
	[engineApi, services, helpers, project] = await Promise.all([
		import('../src/index.ts'),
		import('../src/tools/services.ts'),
		import('./helpers.ts'),
		import('@jasper/project'),
	]);

const W = 1280;
const H = 720;
const FRAMES = [5, 20, 32, 35, 39, 40, 44, 47, 50, 54, 57, 70, 78];
const HEAVY = {
	direction: 'left',
	animation: 'easeInOutQuad',
	dolly: 0.8,
	reflection: true,
	blurriness: 10,
	falloff: 0.2,
	aspect: 1,
	motionBlur: 'high',
	shutterAngle: 360,
	edgeSmoothing: 'low',
};
const settings = (sequenceId: string, engine: 'auto' | 'remotion') => ({
	sequenceId,
	range: { type: 'entire' },
	container: 'mov',
	engine,
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
});

/** Decode each selected video frame exactly once, in chronological order. */
function decodeFrames(file: string): Buffer[] {
	const r = spawnSync(
		'ffmpeg',
		[
			'-v',
			'error',
			'-i',
			file,
			'-vf',
			`select=${FRAMES.map((f) => `eq(n\\,${f})`).join('+')}`,
			'-fps_mode',
			'passthrough',
			'-frames:v',
			String(FRAMES.length),
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
	expect(r.stdout.length).toBe(stride * FRAMES.length);
	return FRAMES.map((_, i) => r.stdout.subarray(i * stride, (i + 1) * stride));
}

/** RGB video against opaque RGBA PNG: same fixed per-channel bounds on both output paths. */
function compare(rgb: Uint8Array, rgba: Uint8Array, tol: number): { share: number; mean: number } {
	expect(rgb.length * 4).toBe(rgba.length * 3);
	let n = 0;
	let sum = 0;
	for (let i = 0; i < rgb.length; i++) {
		const d = Math.abs(rgb[i]! - rgba[Math.floor(i / 3) * 4 + (i % 3)]!);
		if (d <= tol) n++;
		sum += d;
	}
	return { share: n / rgb.length, mean: sum / rgb.length };
}

describe.runIf(enabled)('Smooth Slide encoded spans match the Program composition (REMOTION_E2E=1)', () => {
	let engine: RunningEngine;
	let browser: import('../src/remotion/service.ts').SharedRenderBrowser;
	let referenceDir: string;
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });
	beforeAll(async () => {
		referenceDir = tempAppdir('jasper-slide-ref-');
		engine = await engineApi.startEngine({
			appdir: tempAppdir('jasper-smooth-slide-'),
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

	async function exportDoc(d: DocBuilder, engineName: 'auto' | 'remotion') {
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...helpers.JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, engineName) },
		});
		expect(r.statusCode, r.body).toBe(202);
		const done = await services.coreServices(engine.app).queue.wait(r.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		return { done, out: (await services.coreServices(engine.app).exports.outputFile(done.id))! };
	}

	async function still(d: DocBuilder, frame: number): Promise<Uint8Array> {
		const doc = project.buildRenderSnapshot(d.doc, d.seqId, {
			resolveFont: () => null,
			resolveMedia: () => null,
		});
		const output = join(referenceDir, `${frame}.png`);
		await services.coreServices(engine.app).remotion.renderStill({
			inputProps: { doc, options: { isPreview: false, useProxies: false, transparentBackground: false } },
			output,
			frame,
			signal: new AbortController().signal,
			browser,
		});
		const image = decodePng(readFileSync(output));
		expect([image.width, image.height]).toEqual([W, H]);
		return image.data;
	}

	it('hybrid and Remotion MOVs preserve a two-sided heavy Slide and a one-sided upper-track head', async () => {
		const d = new helpers.DocBuilder('hd-720p-30');
		d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 40, track: 'V1', color: [1, 0, 0, 1] },
			{ type: 'clip.addSolid', at: 40, duration: 40, track: 'V1', color: [0, 0, 1, 1] },
			{
				type: 'transition.add',
				trackId: 'V1',
				at: 40,
				effectId: 'jasper.smooth-slide',
				duration: 16,
				params: HEAVY,
			},
			{ type: 'track.add', kind: 'video', count: 1 },
			{ type: 'clip.addSolid', at: 50, duration: 25, track: 'V2', color: [0.9, 0.6, 0.1, 1], ref: '$s' },
			{ type: 'param.set', target: ['clip', '$s', 'transform', 'scale'], value: 40 },
			{
				type: 'transition.add',
				clipId: '$s',
				edge: 'in',
				effectId: 'jasper.smooth-slide',
				duration: 10,
				params: { direction: 'down', animation: 'easeOutCubic', motionBlur: 'medium', edgeSmoothing: 'high' },
			},
		]);
		const hybrid = await exportDoc(d, 'auto');
		expect(hybrid.done.result).toMatchObject({ renderPath: 'hybrid' });
		const remotion = await exportDoc(d, 'remotion');
		expect(remotion.done.result).toMatchObject({ renderPath: 'remotion' });
		const hFrames = decodeFrames(hybrid.out);
		const rFrames = decodeFrames(remotion.out);
		browser = await services.coreServices(engine.app).remotion.openSharedBrowser();
		const lines: string[] = [];
		for (const [i, frame] of FRAMES.entries()) {
			const reference = await still(d, frame);
			const h = compare(hFrames[i]!, reference, 3);
			const r = compare(rFrames[i]!, reference, 3);
			lines.push(
				`f${frame} hybrid ${h.share.toFixed(4)}/${h.mean.toFixed(3)} remotion ${r.share.toFixed(4)}/${r.mean.toFixed(3)}`,
			);
			expect(h.share, `hybrid frame ${frame}`).toBeGreaterThanOrEqual(0.99);
			expect(r.share, `Remotion frame ${frame}`).toBeGreaterThanOrEqual(0.99);
		}
		const line = `[smooth slide parity] share within 3/255 / mean |Δ|: ${lines.join('; ')}`;
		console.info(line);
		appendFileSync(join(tmpdir(), 'smooth-slide-export.txt'), `${new Date().toISOString()} ${line}\n`);
	}, 3_600_000);
});
