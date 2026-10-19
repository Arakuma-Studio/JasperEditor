// Preview vs export loudness (wp-note sound-design "Fix: preview loudness parity, codec-aware Sound Check, delivery
// speed"): the Program monitor's mix graph (MixGraph with the real AudioWorklet limiter, rendered offline in headless
// Chrome — the Phase 0 preview oracle harness, packages/compositions/test/audio-oracle) normalises the loud fixture with
// the stored analysis's converged delivery and must land within 0.2 LU of the PCM export of the same sequence (24-bit
// MOV, measured by ffmpeg's ebur128 and by our meter). Before the fix the preview applied the one-pass gain
// (target − measured): on this heavily limited mix ≈ 0.7 LU under the export — the test shows that gap too.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AudioAnalyzeResult, ExportResult } from '@jasper/api';
import { measureLoudness } from '@jasper/audio-dsp';
import { buildRenderSnapshot, type RenderAudioMix, type RenderSnapshot, spanOf } from '@jasper/project';
import { bundleForBrowser, findChrome } from '@jasper/testkit/browser';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, TEST_FFMPEG, type TestApp } from './helpers.ts';
import { loudMix, writeMixWav } from './loud-fixture.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ORACLE = join(here, '..', '..', '..', 'packages', 'compositions', 'test', 'audio-oracle', 'entry.ts');
const WORKLET = join(here, '..', '..', '..', 'packages', 'compositions', 'src', 'audio', 'worklet.ts');
const CHROME = findChrome();
const SR = 48_000;
const SECONDS = 10;
/** The clip starts at frame 3 (0.1 s): the early-scheduled source plays whole (as the Phase 0 oracle). */
const AT = 3;

/** ffmpeg's EBU R 128 meter on a file's audio (the export oracle). */
function ebur128(file: string): { I: number; TP: number } {
	const r = spawnSync(
		TEST_FFMPEG,
		['-hide_banner', '-nostats', '-i', file, '-vn', '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'],
		{ encoding: 'utf8' },
	);
	const s = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
	return {
		I: Number(/I:\s+(-?[\d.]+) LUFS/.exec(s)?.[1]),
		TP: Number(/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/.exec(s)?.[1]),
	};
}

/** The file's audio decoded to float stereo at 48 kHz. */
function decode(file: string): Float32Array[] {
	const r = spawnSync(TEST_FFMPEG, ['-v', 'error', '-i', file, '-vn', '-f', 'f32le', '-ac', '2', '-ar', '48000', '-'], {
		maxBuffer: 1 << 28,
	});
	const f = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
	const n = f.length / 2;
	const out = [new Float32Array(n), new Float32Array(n)];
	for (let i = 0; i < n; i++) {
		out[0]![i] = f[2 * i]!;
		out[1]![i] = f[2 * i + 1]!;
	}
	return out;
}

describe.runIf(!!CHROME)('preview loudness = PCM export loudness (headless Chrome)', { timeout: 900_000 }, () => {
	let app: TestApp;
	let browser: Browser;
	let page: Page;
	let workletUrl: string;
	let wav: string;
	const mix = loudMix(SECONDS, SR);

	beforeAll(async () => {
		app = await makeApp();
		const dir = mkdtempSync(join(tmpdir(), 'jasper-preview-parity-'));
		wav = writeMixWav(join(dir, 'loud.wav'), mix);
		const [entry, worklet] = await Promise.all([bundleForBrowser(ORACLE), bundleForBrowser(WORKLET)]);
		browser = await chromium.launch({
			executablePath: CHROME ?? undefined,
			args: ['--autoplay-policy=no-user-gesture-required'],
		});
		page = await browser.newPage();
		// a secure origin for AudioWorklet
		await page.route('http://localhost/oracle', (r) =>
			r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }),
		);
		await page.goto('http://localhost/oracle');
		await page.addScriptTag({ content: entry });
		workletUrl = await page.evaluate(
			(code) => URL.createObjectURL(new Blob([code], { type: 'text/javascript' })),
			worklet,
		);
	}, 300_000);

	afterAll(async () => {
		await browser?.close();
		await closeApps();
	});

	function snapshotOf(d: DocBuilder): RenderSnapshot {
		return buildRenderSnapshot(d.doc, d.seqId, {
			resolveMedia: (a) => ({
				url: a.id,
				proxyUrl: null,
				kind: a.kind,
				width: null,
				height: null,
				durationFlicks: a.probe.durationFlicks,
				hasAudio: true,
				rotation: 0,
			}),
			resolveFont: () => null,
		});
	}

	/** The Program monitor's mix of the snapshot (with `loudness` as given), as Chrome renders it. */
	async function preview(snap: RenderSnapshot, loudness: RenderAudioMix['loudness']): Promise<Float32Array[]> {
		const fps = snap.settings.fps;
		const clip = snap.audioClips[0]!;
		const data = [Array.from(mix[0]!), Array.from(mix[1]!)];
		const out = (await page.evaluate(
			(spec) =>
				(window as unknown as { __mix: { render: (s: unknown) => Promise<unknown> } }).__mix.render(spec),
			{
				workletUrl,
				mix: { ...snap.audioMix!, loudness },
				clips: [{ clip, data, s0: spanOf(clip, fps, SR)[0], volume: 10 ** ((clip.gainDb + clip.volumeDb.value) / 20) }],
				fps,
				length: Math.round((SECONDS + 0.3) * SR),
			},
		)) as { channels: number[][] };
		return out.channels.map((c) => Float32Array.from(c));
	}

	it('plays the converged delivery gain: within 0.2 LU of the PCM export (the one-pass gain was ≈ 0.7 LU under)', async () => {
		const d = new DocBuilder();
		const m = d.addMedia(await register(app, wav));
		d.tx([
			{ type: 'clip.place', source: { mediaId: m }, at: AT, tracks: { audio: 'A1' } },
			{ type: 'mixer.setLoudness', enabled: true, targetLufs: -14, truePeakDb: -1 },
		]);
		// the analysis the editor's Analyze stores: the mix and the export's converged delivery for the Mix target
		const a = await app.inject({
			method: 'POST',
			url: '/api/audio/analyze?wait=1',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, scope: { type: 'sequence' } },
		});
		expect(a.statusCode, a.body).toBe(200);
		const r = a.json().result as AudioAnalyzeResult;
		expect(r.delivery).toBeDefined();
		const delivery = r.delivery!;
		const onePass = -14 - r.loudness.integratedLufs!;
		expect(delivery).toMatchObject({ targetLufs: -14, truePeakDbtp: -1, limiterCeilingDbtp: -1, ceilingLimited: false });
		// the limiter works hard on this mix: the converged gain pushes over the one-pass gain
		expect(delivery.gainDb).toBeGreaterThan(onePass + 0.5);
		expect(Math.abs(delivery.deliveredLufs! + 14)).toBeLessThanOrEqual(0.1);
		d.tx([
			{
				type: 'mixer.setLoudness',
				analysis: {
					integratedLufs: r.loudness.integratedLufs,
					truePeakDbtp: r.loudness.truePeakDbtp,
					lra: r.loudness.lra,
					mixHash: r.mixHash,
					analyzedAt: new Date().toISOString(),
					delivery,
				},
			},
		]);
		const snap = snapshotOf(d);
		// the render snapshot (the Program monitor's mix) carries the converged gain and the PCM ceiling
		expect(snap.audioMix!.loudness).toEqual({ gainDb: delivery.gainDb, truePeakDb: -1 });

		// the PCM export of the same sequence (its normalisation from the Mix)
		const settings = {
			sequenceId: d.seqId,
			range: { type: 'entire' },
			container: 'mov',
			video: {
				codec: 'prores',
				width: 320,
				height: 180,
				frameRate: { num: 30, den: 1 },
				scaling: 'fit',
				quality: { mode: 'crf', value: 30 },
				encoderSpeed: 'fast',
				proresProfile: 'hq',
			},
			audio: { codec: 'pcm', sampleRate: 48000, channels: 2 },
			engine: 'native',
		};
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
		});
		expect(start.statusCode, start.body).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error, JSON.stringify(done.error)).toBeUndefined();
		const file = (await coreServices(app).exports.outputFile(start.json().id))!;
		const exp = ebur128(file);
		const expOurs = measureLoudness(decode(file), SR);
		const res = done.result as ExportResult;

		const now = measureLoudness(await preview(snap, snap.audioMix!.loudness), SR);
		const before = measureLoudness(await preview(snap, { gainDb: onePass, truePeakDb: -1 }), SR);
		console.log(
			'preview-parity',
			JSON.stringify({
				analysis: r.loudness.integratedLufs,
				onePassGainDb: onePass,
				convergedGainDb: delivery.gainDb,
				passes: delivery.passes,
				exportFfmpeg: exp,
				exportOurs: { I: expOurs.integrated, TP: expOurs.truePeakDb },
				exportGainDb: res.audioLoudness?.normalizedGainDb,
				preview: { I: now.integrated, TP: now.truePeakDb },
				previewOnePass: { I: before.integrated, TP: before.truePeakDb },
			}),
		);
		// the export: on target, its gain is the one the analysis stored
		expect(Math.abs(exp.I + 14)).toBeLessThanOrEqual(0.2);
		expect(res.audioLoudness?.normalizedGainDb).toBeCloseTo(delivery.gainDb, 1);
		// the preview: within 0.2 LU of the export (both meters), its true peak under the ceiling
		expect(Math.abs(now.integrated - exp.I)).toBeLessThanOrEqual(0.2);
		expect(Math.abs(now.integrated - expOurs.integrated)).toBeLessThanOrEqual(0.2);
		expect(now.truePeakDb).toBeLessThanOrEqual(-1 + 0.1);
		// before the fix: the one-pass gain played the loud mix clearly under the export
		expect(expOurs.integrated - before.integrated).toBeGreaterThan(0.4);
	});
});
