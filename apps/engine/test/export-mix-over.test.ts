// A mix over full scale exported without loudness normalisation (reported: a voice mix at +4.75 dBTP exported to AAC
// read −0.13 dBTP in the file, with no word that the mix had gone in over full scale). The export path hands the encoder
// the float mix (nothing clips before it: wp-note sound-design "Fix: overs without normalisation"); ffmpeg's AAC encoder
// turns the frames around an over down and an integer file clips it, so the file's own true peak cannot say it.
// The export says it (AUDIO_MIX_OVER: the peak, where the worst over is, the fix), records it for verify_export (row
// `pre-encode-peak`), and the plan of a one-path export says its frames are all on that path (`paths`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportResult, ExportVerifyResult } from '@jasper/api';
import { decodeWav } from '@jasper/audio-dsp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, type TestApp, tempAppdir } from './helpers.ts';
import { writeMixWav } from './loud-fixture.ts';

const SR = 48_000;
/** The worst over: the crest of a 100 ms raised-cosine burst of a 200 Hz tone, at +4.75 dBTP. */
const OVER_AT = 1.55;
const OVER_DBTP = 4.75;

let app: TestApp;
let d: DocBuilder;
beforeAll(async () => {
	app = await makeApp();
	const dir = tempAppdir('jasper-mix-over-');
	// 3 s of a 200 Hz tone at −6 dBFS with one burst up to +4.75 dBTP (a 200 Hz sine's true peak is its sample peak)
	const peak = 10 ** (OVER_DBTP / 20);
	const x = Float32Array.from({ length: 3 * SR }, (_, i) => {
		const t = i / SR;
		const u = (t - (OVER_AT - 0.05)) / 0.1;
		const burst = u > 0 && u < 1 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * u) : 0;
		return (0.5 + (peak - 0.5) * burst) * Math.sin(2 * Math.PI * 200 * t);
	});
	d = new DocBuilder();
	const m = d.addMedia(await register(app, writeMixWav(join(dir, 'over.wav'), [x, x])));
	d.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' } }]);
}, 120_000);
afterAll(closeApps);

async function exportOf(over: Record<string, unknown>): Promise<{
	id: string;
	result: ExportResult;
	plan: { paths?: unknown };
}> {
	const settings = {
		sequenceId: d.seqId,
		range: { type: 'entire' },
		engine: 'native',
		...over,
	};
	const body = { envelope: d.envelope(), sequenceId: d.seqId, settings };
	const planned = await app.inject({
		method: 'POST',
		url: '/api/exports/plan',
		headers: JSON_H,
		payload: body,
	});
	expect(planned.statusCode, planned.body).toBe(200);
	const start = await app.inject({ method: 'POST', url: '/api/exports', headers: JSON_H, payload: body });
	expect(start.statusCode, start.body).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	return { id: start.json().id, result: done.result as ExportResult, plan: planned.json() };
}

async function verify(id: string): Promise<ExportVerifyResult> {
	const r = await app.inject({
		method: 'POST',
		url: `/api/exports/${id}/verify`,
		headers: JSON_H,
		payload: {},
	});
	expect(r.statusCode, r.body).toBe(202);
	const job = await coreServices(app).queue.wait(r.json().id);
	expect(job.error, JSON.stringify(job.error)).toBeUndefined();
	return job.result as ExportVerifyResult;
}

/** The warning and the verify row name the peak and the worst over's place (30 fps: 1.55 s is 00:00:01:16). */
function expectFlagged(result: ExportResult, rows: ExportVerifyResult['rows']): void {
	const w = result.warnings?.find((x) => x.code === 'AUDIO_MIX_OVER');
	expect(w, JSON.stringify(result.warnings)).toBeDefined();
	expect(w!.params?.truePeakDbtp).toBeCloseTo(OVER_DBTP, 1);
	expect(Math.abs((w!.params?.atSec as number) - OVER_AT)).toBeLessThan(0.01);
	expect(w!.params?.timecode).toBe('00:00:01:16');
	expect(w!.message).toMatch(/normalisation/);
	const row = rows.find((r) => r.id === 'pre-encode-peak');
	expect(row, JSON.stringify(rows)).toMatchObject({ status: 'fail', expected: 0, at: { frame: 46 } });
	expect(row!.measured as number).toBeCloseTo(OVER_DBTP, 1);
}

describe('a mix over full scale without normalisation', { timeout: 600_000 }, () => {
	it('AAC in MP4: warned with the peak and its time, flagged by verify; the plan says its paths', async () => {
		const { id, result, plan } = await exportOf({
			container: 'mp4',
			video: {
				codec: 'h264',
				width: 320,
				height: 180,
				frameRate: { num: 30, den: 1 },
				scaling: 'fit',
				quality: { mode: 'crf', value: 30 },
				encoderSpeed: 'fast',
			},
			audio: { codec: 'aac', bitrateKbps: 128, sampleRate: SR, channels: 2, normalize: null },
		});
		expect(plan.paths).toEqual({ native: 90, remotion: 0, spans: 0 });
		expect(result.audioLoudness?.pcm?.truePeakDbtp).toBeCloseTo(OVER_DBTP, 1);
		expectFlagged(result, (await verify(id)).rows);
	});

	it('24-bit WAV: warned and flagged the same way', async () => {
		const { id, result } = await exportOf({
			container: 'wav',
			audio: { codec: 'pcm', bitDepth: 24, sampleRate: SR, channels: 2, normalize: null },
		});
		expectFlagged(result, (await verify(id)).rows);
	});

	it('32-bit float WAV: the overs stay in the file (samples over 1.0), no clip warning, verify passes them', async () => {
		const { id, result } = await exportOf({
			container: 'wav',
			audio: { codec: 'pcm', bitDepth: 32, sampleRate: SR, channels: 2, normalize: null },
		});
		expect(result.audioCodec).toBe('pcm_f32le');
		const wav = decodeWav(readFileSync((await coreServices(app).exports.outputFile(id))!));
		expect(wav.float).toBe(true);
		expect(wav.bitsPerSample).toBe(32);
		const peak = Math.max(...wav.channels.map((c) => c.reduce((m, x) => Math.max(m, Math.abs(x)), 0)));
		expect(20 * Math.log10(peak)).toBeCloseTo(OVER_DBTP, 1);
		expect((result.warnings ?? []).map((w) => w.code)).not.toContain('AUDIO_MIX_OVER');
		const { rows } = await verify(id);
		expect(rows.find((r) => r.id === 'pre-encode-peak')).toBeUndefined();
		expect(rows.find((r) => r.id === 'streams')?.status, JSON.stringify(rows)).toBe('pass');
		const tp = rows.find((r) => r.id === 'true-peak');
		expect(tp?.status, JSON.stringify(tp)).toBe('pass');
		expect(tp!.measured as number).toBeCloseTo(OVER_DBTP, 1);
		expect(tp!.message).toMatch(/32-bit float/);
	});
});
