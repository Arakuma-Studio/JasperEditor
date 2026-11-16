// HEVC footage in browser-drawn renders (REMOTION_E2E=1). The headless render browser has no HEVC decoder (Chrome
// decodes HEVC only through platform hardware decoders), so a video layer the browser draws — a GPU effect baked by
// the layer bake, the Remotion path, a Program still — reads the original's frames through FFmpeg, by their
// timestamps for variable-frame-rate media. Every path must show the frames the native export shows.
//
// Fixtures: scripts/fixtures/hevc.mjs (libkvazaar from the LGPL build, or a working hevc_nvenc). Without such an
// encoder the fixtures are not made and this file says so instead of running.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import { buildRenderSnapshot, mediaDecodeHints } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, fixture, JSON_H, register, tempAppdir } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);
const W = 640;
const H = 360;
const FIXTURES = ['vfr-code-hevc.mp4', 'frame-code-hevc.mp4'];
const haveFixtures = FIXTURES.every((n) => existsSync(fixture(n)));

function decode(file: string, frame?: number): Buffer {
	const r = spawnSync(
		'ffmpeg',
		[
			...['-v', 'error', '-i', file],
			...(frame !== undefined ? ['-vf', `select=eq(n\\,${frame})`] : []),
			...['-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
		],
		{ maxBuffer: 1 << 28 },
	);
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	return r.stdout;
}

/** The 6-bit frame code burned into the fixtures (white 60 px boxes at y = 40, x = 40 + 70·bit). */
function frameCode(rgb: Uint8Array): number {
	let n = 0;
	for (let b = 0; b < 6; b++) {
		const i = (70 * W + 70 + 70 * b) * 3;
		if (rgb[i]! + rgb[i + 1]! + rgb[i + 2]! > 3 * 160) n |= 1 << b;
	}
	return n;
}

function within(a: Uint8Array, b: Uint8Array, tol: number): number {
	expect(a.length).toBe(b.length);
	let n = 0;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) <= tol) n++;
	return n / a.length;
}

describe.runIf(enabled && !haveFixtures)('HEVC in browser-drawn renders (REMOTION_E2E=1)', () => {
	it.skip(`needs ${FIXTURES.join(', ')}: run \`JASPER_FFMPEG=vendor/ffmpeg-lgpl/<platform>/ffmpeg pnpm fixtures\` (libkvazaar) or use an FFmpeg with a working hevc_nvenc`, () => {});
});

describe.runIf(enabled && haveFixtures)('HEVC in browser-drawn renders (REMOTION_E2E=1)', () => {
	let engine: RunningEngine;
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });

	beforeAll(async () => {
		engine = await startEngine({
			appdir: tempAppdir('jasper-hevc-e2e-'),
			port: PORT,
			// These tests drive the engine itself, not its authentication (server.test.ts, security-hardening.test.ts).
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
		await engine?.stop();
	});

	const queue = () => coreServices(engine.app).queue;
	const wait = (id: string): Promise<EngineJob> => queue().wait(id);

	const settings = (seqId: string, engineName: 'auto' | 'native' | 'remotion') => ({
		sequenceId: seqId,
		range: { type: 'entire' },
		container: 'mov',
		engine: engineName,
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

	async function exportDoc(d: DocBuilder, engineName: 'auto' | 'native' | 'remotion') {
		const s = settings(d.seqId, engineName);
		const plan = (
			await engine.app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: { ...JSON_H, ...hostH() },
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
			})
		).json() as { path: string; blockers: unknown[] };
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
		});
		expect(r.statusCode, r.body).toBeLessThan(300);
		const done = await wait(r.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		return { plan, done, out: (await coreServices(engine.app).exports.outputFile(done.id))! };
	}

	async function still(d: DocBuilder, frame: number): Promise<Buffer> {
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, frame },
		});
		expect(r.statusCode, r.body).toBeLessThan(300);
		const done = await wait(r.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		return decode(join(coreServices(engine.app).config.paths.rendersDir, done.id, 'output.png'));
	}

	/** A Remotion still of the whole sequence with the media handles an engine render gets. */
	async function remotionStill(d: DocBuilder, frame: number): Promise<Buffer> {
		const svc = coreServices(engine.app);
		const doc = buildRenderSnapshot(d.doc, d.seqId, {
			resolveFont: () => null,
			resolveMedia: (asset) => {
				const key = asset.locators.find((l) => l.type === 'engine-store')?.key;
				if (!key) throw new Error(`Missing engine-store locator for ${asset.id}`);
				return {
					url: svc.signer.signUrl(`http://127.0.0.1:${engine.port}`, `/media/${encodeURIComponent(key)}`),
					proxyUrl: null,
					kind: asset.kind,
					width: W,
					height: H,
					durationFlicks: asset.probe.durationFlicks,
					hasAudio: false,
					rotation: 0,
					...mediaDecodeHints(asset.probe, 'render'),
				};
			},
		});
		const ref = join(tempAppdir('jasper-hevc-ref-'), 'ref.png');
		await svc.remotion.renderStill({
			inputProps: { doc, options: { isPreview: false, useProxies: false, transparentBackground: false } },
			output: ref,
			frame,
			signal: new AbortController().signal,
		});
		return decode(ref);
	}

	/** VFR HEVC on frames 0–44, constant-rate HEVC on 45–89; `fx` adds a GPU effect to both (layer bake). */
	async function hevcDoc(fx: boolean): Promise<DocBuilder> {
		const vfr = await register(engine.app, fixture('vfr-code-hevc.mp4'), hostH());
		const cfr = await register(engine.app, fixture('frame-code-hevc.mp4'), hostH());
		const d = new DocBuilder('hd-720p-30');
		d.tx([{ type: 'sequence.updateSettings', settings: { width: W, height: H } }]);
		const a = d.tx([
			{
				type: 'clip.place',
				source: { mediaId: d.addMedia(vfr) },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 1.5 } },
				matchSequence: 'keep',
				ref: '$a',
			},
		]).refs.$a!;
		const b = d.tx([
			{
				type: 'clip.place',
				source: { mediaId: d.addMedia(cfr) },
				at: 45,
				sourceRange: { in: { seconds: 0.5 }, out: { seconds: 2 } },
				matchSequence: 'keep',
				ref: '$b',
			},
		]).refs.$b!;
		if (fx)
			d.tx([
				{ type: 'effect.add', target: { clipId: a }, effectId: 'jasper.bevel-edges' },
				{ type: 'effect.add', target: { clipId: b }, effectId: 'jasper.bevel-edges' },
			]);
		return d;
	}

	it('the Remotion path, a hybrid bake under a GPU effect and stills show the native frames of HEVC media', async () => {
		const plain = await hevcDoc(false);
		const native = await exportDoc(plain, 'native');
		expect(native.plan.path).toBe('native');
		const remotion = await exportDoc(plain, 'remotion');
		expect(remotion.plan.path).toBe('remotion');

		// Independent oracle: VFR frame n of vfr-code-hevc.mp4 is at n/30 + 0.01·(n mod 3) s, and a sequence frame shows
		// the last source frame at or before its time; frame-code-hevc.mp4 is constant-rate (frame n at n/30 s).
		const vfrFrameAt = (t: number) => {
			let n = 0;
			while (n + 1 < 64 && (n + 1) / 30 + 0.01 * ((n + 1) % 3) <= t + 1e-6) n++;
			return n;
		};
		const frames = Array.from({ length: 90 }, (_, f) => f);
		const expected = frames.map((f) => (f < 45 ? vfrFrameAt(f / 30) : 15 + (f - 45)));
		expect(frames.map((f) => frameCode(decode(native.out, f)))).toEqual(expected);
		expect(frames.map((f) => frameCode(decode(remotion.out, f)))).toEqual(expected);
		const shares = [0, 22, 44, 45, 70, 89].map((f) =>
			within(decode(remotion.out, f), decode(native.out, f), 3),
		);
		console.info(
			`[hevc-browser] Remotion vs native, share within 3/255: ${shares.map((x) => x.toFixed(4)).join(' ')}`,
		);
		for (const x of shares) expect(x).toBeGreaterThanOrEqual(0.99);

		const withFx = await hevcDoc(true);
		const hybrid = await exportDoc(withFx, 'auto');
		expect(hybrid.plan.path).toBe('hybrid');
		expect(frames.map((f) => frameCode(decode(hybrid.out, f)))).toEqual(expected);
		for (const f of [10, 60]) {
			const ref = await remotionStill(withFx, f);
			expect(within(decode(hybrid.out, f), ref, 3)).toBeGreaterThanOrEqual(0.99);
			const s = await still(withFx, f);
			expect(frameCode(s)).toBe(expected[f]);
			expect(within(s, ref, 3)).toBeGreaterThan(0.995);
		}
	}, 1_800_000);
});
