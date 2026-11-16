// Corner Pin motion blur on every export path (AGENTS §4, docs/wp-notes/corner-pin-motion-blur.md): the native warp
// stage's CPU kernel and the Remotion export must match the Program composition (Remotion stills, the GL step) frame
// by frame, on an unevenly tracked perspective pin (one key per frame: time-warped, jittered taps) at 360°.
import { execFileSync, spawnSync } from 'node:child_process';
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
const FRAMES = [3, 8, 12, 17, 22];
const settings = (sequenceId: string, engine: 'auto' | 'remotion') => ({
	sequenceId,
	range: { type: 'custom', startFrame: 0, endFrame: 26 },
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

/** A tracked screen: a perspective quad moving unevenly (up to ≈ 60 px per frame on screen), one key per frame. */
function trackedPin(f: number): Record<string, [number, number]> {
	const x = 0.03 * f + 0.09 * Math.sin(f / 2);
	const y = 0.03 * Math.cos(f / 3);
	return {
		topLeft: [0.1 + x, 0.1 + y],
		topRight: [0.8 + x, 0.2 + y],
		bottomRight: [0.85 + x, 0.9 + y],
		bottomLeft: [0.05 + x, 0.8 + y],
	};
}

function decodeFrames(file: string): Buffer[] {
	const r = spawnSync(
		'ffmpeg',
		[
			...['-v', 'error', '-i', file, '-vf', `select=${FRAMES.map((f) => `eq(n\\,${f})`).join('+')}`],
			...[
				'-fps_mode',
				'passthrough',
				'-frames:v',
				String(FRAMES.length),
				'-pix_fmt',
				'rgb24',
				'-f',
				'rawvideo',
			],
			'pipe:1',
		],
		{ maxBuffer: 1 << 28 },
	);
	expect(r.status, r.stderr.toString()).toBe(0);
	const stride = W * H * 3;
	expect(r.stdout.length).toBe(stride * FRAMES.length);
	return FRAMES.map((_, i) => r.stdout.subarray(i * stride, (i + 1) * stride));
}

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

describe.runIf(enabled)(
	'Corner Pin motion blur exports match the Program composition (REMOTION_E2E=1)',
	() => {
		let engine: RunningEngine;
		let browser: import('../src/remotion/service.ts').SharedRenderBrowser;
		let dir: string;
		const hostH = () => ({ host: `127.0.0.1:${engine.port}` });
		beforeAll(async () => {
			dir = tempAppdir('jasper-pin-blur-ref-');
			engine = await engineApi.startEngine({
				appdir: tempAppdir('jasper-pin-blur-'),
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
			const started = Date.now();
			const r = await engine.app.inject({
				method: 'POST',
				url: '/api/exports',
				headers: { ...helpers.JSON_H, ...hostH() },
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, engineName) },
			});
			expect(r.statusCode, r.body).toBe(202);
			const done = await services.coreServices(engine.app).queue.wait(r.json().id);
			expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
			const out = (await services.coreServices(engine.app).exports.outputFile(done.id))!;
			return { done, out, ms: Date.now() - started };
		}

		async function still(d: DocBuilder, frame: number): Promise<Uint8Array> {
			const svc = services.coreServices(engine.app);
			const doc = project.buildRenderSnapshot(d.doc, d.seqId, {
				resolveFont: () => null,
				resolveMedia: (asset) => {
					const k = asset.locators.find((locator) => locator.type === 'engine-store')?.key;
					if (!k) throw new Error(`Missing engine-store locator for ${asset.id}`);
					return {
						url: svc.signer.signUrl(`http://127.0.0.1:${engine.port}`, `/media/${encodeURIComponent(k)}`),
						proxyUrl: null,
						kind: asset.kind,
						width: 640,
						height: 360,
						durationFlicks: null,
						hasAudio: false,
						rotation: 0,
					};
				},
			});
			const output = join(dir, `${frame}.png`);
			await svc.remotion.renderStill({
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

		it('native and Remotion exports keep the smear of a tracked pin', async () => {
			const png = join(dir, 'screen.png');
			execFileSync('ffmpeg', [
				'-v',
				'error',
				'-y',
				'-f',
				'lavfi',
				'-i',
				'testsrc2=s=640x360',
				'-frames:v',
				'1',
				png,
			]);
			const d = new helpers.DocBuilder('hd-720p-30');
			const media = d.addMedia(await helpers.register(engine.app, png, hostH()));
			d.tx([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0.1, 0.1, 0.12, 1] }]);
			const placed = d.tx([
				{ type: 'clip.place', source: { mediaId: media }, at: 0, tracks: { video: 'V2' }, ref: '$c' },
			]);
			const clip = placed.refs.$c!;
			const fx = d.tx([
				{ type: 'param.set', target: ['clip', clip, 'transform', 'scale'], value: 150 },
				{
					type: 'effect.add',
					target: { clipId: clip },
					effectId: 'jasper.corner-pin',
					params: { useCompShutterAngle: false, shutterAngle: 360 },
					ref: '$fx',
				},
			]).refs.$fx!;
			d.tx(
				Array.from({ length: 27 }, (_, f) =>
					Object.entries(trackedPin(f)).map(([name, value]) => ({
						type: 'keyframe.add',
						target: ['effect', fx, name],
						at: { sequenceFrame: f },
						value,
					})),
				).flat(),
			);
			const native = await exportDoc(d, 'auto');
			expect(native.done.result).toMatchObject({ renderPath: 'native' });
			const remotion = await exportDoc(d, 'remotion');
			expect(remotion.done.result).toMatchObject({ renderPath: 'remotion' });
			const nFrames = decodeFrames(native.out);
			const rFrames = decodeFrames(remotion.out);
			browser = await services.coreServices(engine.app).remotion.openSharedBrowser();
			const lines: string[] = [];
			for (const [i, frame] of FRAMES.entries()) {
				const reference = await still(d, frame);
				const n = compare(nFrames[i]!, reference, 3);
				const r = compare(rFrames[i]!, reference, 3);
				lines.push(
					`f${frame} native ${n.share.toFixed(4)}/${n.mean.toFixed(3)} remotion ${r.share.toFixed(4)}/${r.mean.toFixed(3)}`,
				);
				expect(n.share, `native frame ${frame}`).toBeGreaterThanOrEqual(0.99);
				expect(r.share, `Remotion frame ${frame}`).toBeGreaterThanOrEqual(0.99);
			}
			// The compared frames are blurred: without the shutter the composition draws a visibly different frame.
			d.tx([{ type: 'param.set', target: ['effect', fx, 'shutterAngle'], value: 0 }]);
			const sharp = compare(nFrames[FRAMES.indexOf(12)]!, await still(d, 12), 3);
			lines.push(`f12 native vs shutter 0 ${sharp.share.toFixed(4)}/${sharp.mean.toFixed(3)}`);
			expect(sharp.share).toBeLessThan(0.97);
			const line = `[corner pin blur parity] share within 3/255 / mean |Δ|: ${lines.join('; ')}; export ms native ${native.ms} remotion ${remotion.ms}`;
			console.info(line);
			appendFileSync(join(tmpdir(), 'corner-pin-blur-export.txt'), `${new Date().toISOString()} ${line}\n`);
		}, 3_600_000);
	},
);
