// Delivered loudness of real exports (wp-note sound-design "Fix: lossy-codec true-peak headroom and loudness
// convergence"; AGENTS §4): a loud, bright mix exported to AAC (MP4) and Opus (WebM), representing
// the Web (−14 / −1), Podcast (−16 / −1) and EBU R 128 (−23 / −1) targets. The oracle is ffmpeg's own `ebur128`
// (peak=true) on the FILE: its true peak never passes the target and its integrated loudness lands within ±0.5 LU (or
// the result says the ceiling prevents it, with a warning). The result reports the limiter ceiling, the codec headroom,
// the passes and the corrections, measured on the decoded file. PCM exports of a mix that needs no limiting are the
// one-pass delivery sample for sample (24-bit).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { ExportResult } from '@jasper/api';
import { measureLoudness } from '@jasper/audio-dsp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	JSON_H,
	makeApp,
	register,
	TEST_FFMPEG,
	type TestApp,
	tempAppdir,
} from './helpers.ts';
import { loudMix, quietMix, writeMixWav } from './loud-fixture.ts';

let app: TestApp;
let dir: string;
let loudWav: string;
let quietWav: string;
beforeAll(async () => {
	app = await makeApp();
	dir = tempAppdir('jasper-lossy-tp-');
	loudWav = writeMixWav(join(dir, 'loud.wav'), loudMix(10));
	quietWav = writeMixWav(join(dir, 'quiet.wav'), quietMix(4));
}, 120_000);
afterAll(closeApps);

type Audio = NonNullable<ExportResult['audioLoudness']>;

async function exportOf(
	d: DocBuilder,
	audio: Record<string, unknown>,
	container: 'mp4' | 'webm' | 'mov',
): Promise<{ file: string; result: ExportResult; plan: Record<string, unknown> }> {
	const settings = {
		sequenceId: d.seqId,
		range: { type: 'entire' },
		container,
		video: {
			codec: container === 'webm' ? 'vp9' : container === 'mov' ? 'prores' : 'h264',
			width: 320,
			height: 180,
			frameRate: { num: 30, den: 1 },
			scaling: 'fit',
			quality: { mode: 'crf', value: container === 'webm' ? 40 : 30 },
			encoderSpeed: 'fast',
			...(container === 'mov' ? { proresProfile: 'hq' } : {}),
		},
		audio: { sampleRate: 48000, channels: 2, ...audio },
		engine: 'native',
	};
	const planned = await app.inject({
		method: 'POST',
		url: '/api/exports/plan',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
	});
	expect(planned.statusCode, planned.body).toBe(200);
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
	});
	expect(start.statusCode, start.body).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	return {
		file: (await coreServices(app).exports.outputFile(start.json().id))!,
		result: done.result as ExportResult,
		plan: planned.json() as Record<string, unknown>,
	};
}

/** ffmpeg's EBU R 128 meter (true peak 4× oversampled) on the file's audio: the oracle. */
function ebur128(file: string): { I: number; TP: number } {
	const r = spawnSync(
		TEST_FFMPEG,
		[
			'-hide_banner',
			'-nostats',
			'-i',
			file,
			'-vn',
			'-filter_complex',
			'ebur128=peak=true',
			'-f',
			'null',
			'-',
		],
		{ encoding: 'utf8' },
	);
	const s = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
	return {
		I: Number(/I:\s+(-?[\d.]+) LUFS/.exec(s)?.[1]),
		TP: Number(/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/.exec(s)?.[1]),
	};
}

async function docOf(file: string): Promise<DocBuilder> {
	const d = new DocBuilder();
	const m = d.addMedia(await register(app, file));
	d.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' } }]);
	return d;
}

// Each delivery target and container has a real mux/decode check. Bit-rate/headroom boundaries are owned by
// audio-deliver.test.ts; repeating every target × bit rate here exercises the same delivery path.
// Headroom literals: sound-design wp-note's codec table (dB below the −1 dBTP delivery target).
const DELIVERIES = [
	['web', -14, -1, 'aac', 128, 'mp4', 1.5],
	['podcast', -16, -1, 'opus', 160, 'webm', 0.5],
	['broadcast-r128', -23, -1, 'aac', 320, 'mp4', 0.5],
] as const;

describe('lossy exports meet the delivery target on the decoded file', { timeout: 1_800_000 }, () => {
	for (const [preset, lufs, tp, codec, kbps, container, headroom] of DELIVERIES)
		it(`${preset} (${lufs} LUFS / ${tp} dBTP) → ${codec} ${kbps} kb/s`, async () => {
			const d = await docOf(loudWav);
			const { file, result, plan } = await exportOf(
				d,
				{ codec, bitrateKbps: kbps, normalize: { targetLufs: lufs, truePeakDb: tp } },
				container,
			);
			const ff = ebur128(file);
			const a = result.audioLoudness as Audio;

			// the plan says the ceiling in front of the encoder
			const pn = (plan.audio as { normalize?: { limiterCeilingDb?: number; codecHeadroomDb?: number } })
				.normalize;
			expect(pn?.codecHeadroomDb).toBe(headroom);
			expect(pn?.limiterCeilingDb).toBe(tp - headroom);
			// the file itself (ffmpeg's meter): never over the true-peak target …
			expect(ff.TP, JSON.stringify({ ff, a })).toBeLessThanOrEqual(tp);
			// … and on the loudness target, unless the result says the ceiling prevents it (with a warning)
			if (a.ceilingLimited) expect(result.warnings?.map((w) => w.code)).toContain('AUDIO_LOUDNESS_CEILING');
			else expect(Math.abs(ff.I - lufs), JSON.stringify({ ff, a })).toBeLessThanOrEqual(0.5);
			// the result reports the decoded file, the ceiling and how it got there
			expect(a.measuredOn).toBe('decoded-file');
			expect(a.truePeakMet).toBe(true);
			expect(a.targetLufs).toBe(lufs);
			expect(a.truePeakTargetDbtp).toBe(tp);
			expect(a.codecHeadroomDb).toBe(headroom);
			expect(a.limiterCeilingDbtp).toBeLessThanOrEqual(tp - headroom);
			expect(a.encodePasses).toBeGreaterThanOrEqual(1);
			expect(Math.abs(a.truePeakDbtp! - ff.TP)).toBeLessThanOrEqual(0.15);
			expect(Math.abs(a.integratedLufs! - ff.I)).toBeLessThanOrEqual(0.1);
			expect(result.warnings?.map((w) => w.code) ?? []).not.toContain('AUDIO_TRUE_PEAK_OVER');
		});
});

describe('PCM exports', { timeout: 600_000 }, () => {
	it('a mix that needs no limiting is the one-pass delivery sample for sample (24-bit MOV)', async () => {
		const d = await docOf(quietWav);
		const { file, result } = await exportOf(
			d,
			{ codec: 'pcm', normalize: { targetLufs: -16, truePeakDb: -1 } },
			'mov',
		);
		const a = result.audioLoudness as Audio;
		expect(a.measuredOn).toBe('pcm');
		expect(a.loudnessPasses).toBe(1);
		expect(a.encodePasses).toBe(0);
		expect(a.limiterCeilingDbtp).toBe(-1);
		// With an idle limiter the output is only source × gain, then 24-bit quantisation.
		const src = quietMix(4);
		const before = measureLoudness(src, 48000);
		const g = 10 ** ((-16 - before.integrated) / 20);
		const ref = src.map((c) => Float32Array.from(c, (v) => v * g));
		const r = spawnSync(TEST_FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 's32le', '-'], {
			maxBuffer: 256 << 20,
		});
		const all = new Int32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
		expect(all.length).toBe(ref[0]!.length * 2);
		const n = ref[0]!.length;
		let maxLsb = 0;
		for (let i = 0; i < n; i++)
			for (let c = 0; c < 2; c++) {
				const got = all[i * 2 + c]! / 2 ** 31;
				maxLsb = Math.max(maxLsb, Math.abs(got - ref[c]![i]!) * 2 ** 23);
			}
		// 24-bit quantisation of the same float samples: at most half an LSB (rounding), 1 with dither-free truncation
		expect(maxLsb).toBeLessThanOrEqual(1);
		expect(Math.abs(a.integratedLufs! + 16)).toBeLessThanOrEqual(0.01);
	});
});
