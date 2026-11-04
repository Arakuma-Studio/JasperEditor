// Media range view routes (spec 18 AF-VIEW-002; docs/wp-notes/agent-footage-view.md): frames of a registered media at
// file times — the exact frame (read back from frame-code.mp4's burned-in code), scaled during decode to fit the box
// with the display aspect (rotation), clamped to the media, bounded and validated, local protocols only — and the 10 ms
// levels / voice classes of a media range (analysed now, byte-identical to the voice analysis of the same samples, or
// read from the cached analysis) and of a sequence's mix. Unknown, offline, picture-less and sound-less media, bad
// bodies and unauthenticated requests are coded errors; a cancelled decode stops at once.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type MediaFramesResponse,
	RANGE_AUDIO_CLASSES,
	RANGE_AUDIO_FRAME_SEC,
	RANGE_AUDIO_LEVEL_MIN_DB,
	RANGE_AUDIO_LEVEL_STEP_DB,
	type RangeAudioResponse,
	type RegisteredMedia,
} from '@jasper/api';
import {
	classifyVoiceFrames,
	encodeWav,
	VOICE_HOP,
	VOICE_LEVEL_MIN_DB,
	VOICE_LEVEL_STEP_DB,
	VOICE_SAMPLE_RATE,
	voiceFeatures,
} from '@jasper/audio-dsp';
import { VOICE_CLASSES } from '@jasper/project';
import { decodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frameStart, mediaRangeAudio, pngSize, StreamingVoiceFeatures } from '../src/media/range-view.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	TEST_FFMPEG,
	type TestApp,
} from './helpers.ts';

const SR = 16_000;
let app: TestApp;
let dir = '';
let frameCode: RegisteredMedia;
let speech: RegisteredMedia;
let speechSignal: Float32Array;

/** Voiced tones 0–1.2 s of every 2 s, a −70 dBFS noise floor between them (silences of 0.8 s). */
function programme(seconds: number): Float32Array {
	const x = new Float32Array(seconds * SR);
	let s = 7;
	const rnd = () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return (s / 2 ** 32) * 2 - 1;
	};
	for (let i = 0; i < x.length; i++) {
		const t = i / SR;
		x[i] = rnd() * 10 ** (-70 / 20);
		if (t % 2 < 1.2)
			for (let h = 1; h < 12; h++) x[i]! += (0.08 / h) * Math.sin((2 * Math.PI * 140 * h * i) / SR);
	}
	return x;
}

const post = (url: string, payload: unknown, headers: Record<string, string> = JSON_H) =>
	app.inject({ method: 'POST', url, headers, payload: payload as never });

/** The 6-bit frame number burned into frame-code.mp4, read from a frame scaled by `k`. */
function readCode(png: string, k: number): number {
	const img = decodePng(Buffer.from(png, 'base64'));
	let n = 0;
	for (let b = 0; b < 6; b++) {
		const x = Math.round((70 + 70 * b) * k);
		const y = Math.round(70 * k);
		const lum = img.data[(y * img.width + x) * 4]!;
		if (lum > 128) n |= 1 << b;
	}
	return n;
}

beforeAll(async () => {
	ensureFixtures();
	dir = mkdtempSync(join(tmpdir(), 'jasper-range-view-'));
	app = await makeApp();
	frameCode = await register(app, fixture('frame-code.mp4'));
	speechSignal = programme(10);
	const wav = join(dir, 'speech.wav');
	writeFileSync(wav, encodeWav([speechSignal], SR, 'f32'));
	speech = await register(app, wav);
}, 60_000);

afterAll(async () => {
	await closeApps();
	if (dir) rmSync(dir, { recursive: true, force: true });
}, 30_000);

describe('POST /api/media/:mediaKey/frames', () => {
	it('returns the exact frame at each time, scaled to the box during decode', async () => {
		const r = await post(`/api/media/${frameCode.mediaKey}/frames`, {
			times: [10.5 / 30, 33.5 / 30, 0],
			width: 960,
		});
		expect(r.statusCode, r.body).toBe(200);
		const body = r.json() as MediaFramesResponse;
		expect(body.frames).toHaveLength(3);
		const codes = body.frames.map((f) => {
			if (!('png' in f)) throw new Error(JSON.stringify(f));
			expect([f.width, f.height]).toEqual([960, 540]);
			expect(pngSize(Buffer.from(f.png, 'base64'))).toEqual({ width: 960, height: 540 });
			return readCode(f.png, 0.5);
		});
		expect(codes).toEqual([10, 33, 0]);
	});

	it('fits the display aspect inside width × height and never enlarges', async () => {
		const small = (
			await post(`/api/media/${frameCode.mediaKey}/frames`, { times: [1], width: 200, height: 100 })
		).json().frames[0];
		expect([small.width, small.height]).toEqual([178, 100]);
		const rot = await register(app, fixture('phone-rot90.mp4'));
		const portrait = (
			await post(`/api/media/${rot.mediaKey}/frames`, { times: [0.5], width: 400, height: 400 })
		).json().frames[0];
		expect(portrait.height).toBe(400);
		expect(portrait.width).toBeLessThan(portrait.height);
		const still = await register(app, fixture('still.png'));
		const s = (await post(`/api/media/${still.mediaKey}/frames`, { times: [0, 5], width: 960 })).json()
			.frames;
		expect(s.map((f: { width: number }) => f.width)).toEqual([960, 960]);
	});

	it('clamps times past the end to the last frames', async () => {
		const r = (await post(`/api/media/${frameCode.mediaKey}/frames`, { times: [100], width: 320 })).json();
		const f = r.frames[0];
		expect(f.png, JSON.stringify(f)).toBeTruthy();
		expect(f.time).toBe(100);
		expect(f.at).toBeLessThanOrEqual(r.durationSec);
		expect(readCode(f.png, 1 / 6)).toBeGreaterThanOrEqual(48);
	});

	it('refuses bad bodies, unknown, offline and picture-less media with coded errors', async () => {
		const url = `/api/media/${frameCode.mediaKey}/frames`;
		const bad = [
			{ times: [], width: 320 },
			{ times: Array.from({ length: 17 }, (_, i) => i / 10), width: 320 },
			{ times: [0], width: 961 },
			{ times: [0], width: 320, height: 2000 },
			{ times: [-1], width: 320 },
			{ times: [Number.NaN], width: 320 },
			{ times: [0], width: 320, extra: 1 },
		];
		for (const b of bad) {
			const r = await post(url, b);
			expect(r.statusCode, JSON.stringify(b)).toBe(400);
			expect(r.json().code).toBe('VALIDATION_FAILED');
		}
		const unknown = await post('/api/media/mk_doesnotexist0/frames', { times: [0], width: 320 });
		expect([unknown.statusCode, unknown.json().code]).toEqual([404, 'ASSET_NOT_FOUND']);
		const audioOnly = await post(`/api/media/${speech.mediaKey}/frames`, { times: [0], width: 320 });
		expect([audioOnly.statusCode, audioOnly.json().code]).toEqual([422, 'NO_VIDEO']);
		// its own content (a copy of a registered file would be the same media key)
		const gone = join(dir, 'gone.mp4');
		const g = spawnSync(TEST_FFMPEG, [
			...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10:duration=1'],
			...['-c:v', 'mpeg4', gone],
		]);
		expect(g.status, String(g.stderr)).toBe(0);
		const reg = await register(app, gone);
		rmSync(gone);
		const offline = await post(`/api/media/${reg.mediaKey}/frames`, { times: [0], width: 320 });
		expect([offline.statusCode, offline.json().code]).toEqual([409, 'MEDIA_OFFLINE']);
	});

	it('needs authentication', async () => {
		const secured = await makeApp({ token: 'secret-token-0123456789' });
		const reg = await register(secured, fixture('frame-code.mp4'), {
			authorization: 'Bearer secret-token-0123456789',
		});
		const anon = await secured.inject({
			method: 'POST',
			url: `/api/media/${reg.mediaKey}/frames`,
			headers: JSON_H,
			payload: { times: [0], width: 320 },
		});
		expect(anon.statusCode).toBe(401);
		const authed = await secured.inject({
			method: 'POST',
			url: `/api/media/${reg.mediaKey}/frames`,
			headers: { ...JSON_H, authorization: 'Bearer secret-token-0123456789' },
			payload: { times: [0], width: 320 },
		});
		expect(authed.statusCode, authed.body).toBe(200);
	});

	it('seeks to the start of the frame shown at a time (never the next frame)', () => {
		expect(frameStart(10.5 / 30, 30)).toBe(Math.floor((10 / 30) * 1e6) / 1e6);
		expect(frameStart(2 / 3, 30)).toBeLessThanOrEqual(2 / 3);
		expect(frameStart(20 / 30, 30)).toBeGreaterThan(19.9 / 30);
		expect(frameStart(1.234, null)).toBe(1.234);
	});
});

describe('range audio', () => {
	const u8 = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

	it('analyses a media range like the voice analysis of the same samples (lead-in included)', async () => {
		const r = await post(`/api/media/${speech.mediaKey}/range-audio`, { start: 2, end: 6 });
		expect(r.statusCode, r.body).toBe(200);
		const a = r.json() as RangeAudioResponse;
		expect(a.source).toBe('range');
		expect([a.start, a.end, a.frameCount, a.frameSec]).toEqual([2, 6, 400, 0.01]);
		const whole = voiceFeatures(speechSignal);
		expect(Buffer.from(u8(a.level))).toEqual(Buffer.from(whole.level.subarray(200, 600)));
		const classes = u8(a.classes);
		// tones 2.0–3.2 and 4.0–5.2 are speech, 3.2–4.0 and 5.2–6.0 are not
		expect(classes[50]).toBe(2);
		expect(classes[160]).not.toBe(2);
		expect(classes[250]).toBe(2);
		expect(classes[360]).not.toBe(2);
		expect(a.levels!.speechThresholdDb).toBeGreaterThan(a.levels!.floorDb);
	});

	it('clamps to the media and reads the cached voice analysis when there is one', async () => {
		const clamped = (await post(`/api/media/${speech.mediaKey}/range-audio`, { start: 9, end: 50 })).json();
		expect([clamped.start, clamped.end, clamped.frameCount]).toEqual([9, 10, 100]);
		const outside = await post(`/api/media/${speech.mediaKey}/range-audio`, { start: 20, end: 30 });
		expect([outside.statusCode, outside.json().code]).toEqual([422, 'EMPTY_RANGE']);
		const job = await post(`/api/media/${speech.mediaKey}/voice-analysis?wait=1`, {});
		expect(job.statusCode, job.body).toBeLessThan(300);
		const cached = (await post(`/api/media/${speech.mediaKey}/range-audio`, { start: 2, end: 6 })).json();
		expect(cached.source).toBe('voice-analysis');
		const whole = classifyVoiceFrames(voiceFeatures(speechSignal));
		expect(Buffer.from(u8(cached.classes))).toEqual(Buffer.from(whole.classes.subarray(200, 600)));
	});

	it('refuses media without audio, reversed and over-long ranges', async () => {
		const box = await register(app, fixture('frame-code.mp4'));
		const r = await post(`/api/media/${box.mediaKey}/range-audio`, { start: 0, end: 1 });
		expect([r.statusCode, r.json().code]).toEqual([422, 'NO_AUDIO']);
		for (const b of [
			{ start: 3, end: 2 },
			{ start: 0, end: 1801 },
			{ start: 0, end: 1, streamIndex: -1 },
		]) {
			const x = await post(`/api/media/${speech.mediaKey}/range-audio`, b);
			expect(x.statusCode, JSON.stringify(b)).toBe(400);
		}
	});

	it('stops decoding when cancelled', async () => {
		const long = join(dir, 'long.wav');
		const g = spawnSync(TEST_FFMPEG, [
			...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:r=16000:d=1500'],
			...['-ac', '1', '-c:a', 'pcm_s16le', long],
		]);
		expect(g.status, String(g.stderr)).toBe(0);
		const reg = await register(app, long);
		const core = coreServices(app);
		const ac = new AbortController();
		const t0 = Date.now();
		setTimeout(() => ac.abort(), 100);
		await expect(
			mediaRangeAudio({
				ff: core.ffmpeg,
				path: long,
				record: core.registry.get(reg.mediaKey)!,
				start: 0,
				end: 1500,
				signal: ac.signal,
			}),
		).rejects.toMatchObject({ code: 'CANCELLED' });
		expect(Date.now() - t0).toBeLessThan(5000);
		// over a real connection: the decoder runs while the client waits and is gone soon after it hangs up
		await app.listen({ host: '127.0.0.1', port: 0 });
		const port = (app.server.address() as AddressInfo).port;
		const decoders = () =>
			spawnSync('pgrep', ['-f', '--', long], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
		const req = request({
			host: '127.0.0.1',
			port,
			method: 'POST',
			path: `/api/media/${reg.mediaKey}/range-audio`,
			headers: JSON_H,
		});
		req.on('error', () => {});
		req.end(JSON.stringify({ start: 0, end: 1500 }));
		const until = async (cond: () => boolean, ms: number) => {
			const end = Date.now() + ms;
			while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
			return cond();
		};
		expect(await until(() => decoders().length > 0, 10_000)).toBe(true);
		req.destroy();
		// the whole range takes ≈ 12 s to analyse; the decoder must be gone long before (measured 0.3–0.9 s)
		expect(await until(() => decoders().length === 0, 2000)).toBe(true);
	}, 60_000);

	it('describes the bytes with the voice analysis constants', () => {
		expect([RANGE_AUDIO_LEVEL_MIN_DB, RANGE_AUDIO_LEVEL_STEP_DB]).toEqual([
			VOICE_LEVEL_MIN_DB,
			VOICE_LEVEL_STEP_DB,
		]);
		expect(RANGE_AUDIO_CLASSES).toEqual(VOICE_CLASSES);
		expect(RANGE_AUDIO_FRAME_SEC).toBe(VOICE_HOP / VOICE_SAMPLE_RATE);
	});

	it('streams in any split to the same planes', () => {
		const x = speechSignal.subarray(0, 3 * SR);
		const whole = voiceFeatures(x);
		const s = new StreamingVoiceFeatures(whole.level.length, 0);
		for (let i = 0; i < x.length; i += 777) s.push(x.slice(i, i + 777));
		const p = s.finish();
		expect(Buffer.from(p.level)).toEqual(Buffer.from(whole.level));
		expect(Buffer.from(p.voicing)).toEqual(Buffer.from(whole.voicing));
		expect(Buffer.from(p.flatness)).toEqual(Buffer.from(whole.flatness));
	});

	it('analyses a sequence mix over a range', async () => {
		const b = new DocBuilder();
		const id = b.addMedia(speech);
		b.tx([{ type: 'clip.place', source: { mediaId: id }, at: 30, tracks: { audio: 'A1' } }]);
		const r = await post('/api/sequence-range-audio', {
			envelope: b.envelope(),
			sequenceId: b.seqId,
			startFrame: 0,
			endFrame: 150,
		});
		expect(r.statusCode, r.body).toBe(200);
		const a = r.json() as RangeAudioResponse;
		expect([a.source, a.start, a.end, a.frameCount]).toEqual(['mix', 0, 5, 500]);
		const classes = u8(a.classes);
		// nothing plays before 1 s; the clip's first tone plays 1.0–2.2 s
		expect(classes[50]).not.toBe(2);
		expect(classes[150]).toBe(2);
		expect(classes[260]).not.toBe(2);
		const long = await post('/api/sequence-range-audio', {
			envelope: b.envelope(),
			sequenceId: b.seqId,
			startFrame: 0,
			endFrame: 30 * 601,
		});
		// clamped to the sequence (11 s) first
		expect(long.statusCode, long.body).toBe(200);
		const missing = await post('/api/sequence-range-audio', {
			envelope: b.envelope(),
			sequenceId: 'seq_nope',
			startFrame: 0,
			endFrame: 30,
		});
		expect([missing.statusCode, missing.json().code]).toEqual([404, 'SEQUENCE_NOT_FOUND']);
		b.tx([{ type: 'clip.addSolid', at: 0, duration: 30 * 601, track: 'V1', color: [0, 0, 0, 1] }]);
		const tooLong = await post('/api/sequence-range-audio', {
			envelope: b.envelope(),
			sequenceId: b.seqId,
			startFrame: 0,
			endFrame: 30 * 601,
		});
		expect([tooLong.statusCode, tooLong.json().code]).toEqual([400, 'RANGE_TOO_LONG']);
	}, 60_000);
});
