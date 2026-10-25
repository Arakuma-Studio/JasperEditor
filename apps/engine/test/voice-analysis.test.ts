// The `voice-analysis` job and routes (spec 14 TC-001; docs/wp-notes/transcript-cleanup.md "Voice analysis"): the
// engine's analysis of a stream is byte-identical to the pure analysis of the same samples (in-thread and on worker
// threads), it is cached as a media derivative (a second request decodes nothing; a damaged file is a miss and is
// replaced), streams are chosen by container index, requests are validated, cancel stops the job without a file, and
// decoder, offline-media and worker failures become job errors while the engine keeps serving. Real speech (the LJ
// Speech public-domain fixture) is speech inside its utterances and not between them.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EngineJob, type VoiceAnalysisJobResult, VoiceAnalysisJobResultSchema } from '@jasper/api';
import { encodeWav, VOICE_HOP, voiceFeatures } from '@jasper/audio-dsp';
import { buildVoiceAnalysis, decodeVoiceAnalysis, encodeVoiceAnalysis } from '@jasper/project';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { entryOfPath } from '../src/cache/layout.ts';
import { fingerprintHex } from '../src/media/fingerprint.ts';
import { closeApps, H, JSON_H, makeApp, ROOT, register, TEST_FFMPEG, type TestApp, until } from './helpers.ts';

const HAVE_FFMPEG = spawnSync(TEST_FFMPEG, ['-version'], { encoding: 'utf8' }).status === 0;
const SR = 16_000;
const LJ = join(ROOT, 'fixtures', 'speech', 'lj-composite.flac');

let dir = '';

/** A speech-like programme: a −68 dBFS floor, voiced tones of several pitches, a breath-like burst, pauses. */
function programme(seconds: number, seed = 1): Float32Array {
	const n = seconds * SR;
	const x = new Float32Array(n);
	let s = seed >>> 0 || 1;
	const rnd = () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return (s / 2 ** 32) * 2 - 1;
	};
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		x[i] = rnd() * 10 ** (-68 / 20) * Math.sqrt(3);
		const cycle = t % 4;
		const f0 = 110 + 40 * Math.floor(t / 4 % 4);
		if (cycle < 1.6) for (let h = 1; f0 * h < 3000; h++) x[i]! += (0.08 / h) * Math.sin((2 * Math.PI * f0 * h * i) / SR);
		else if (cycle > 2.2 && cycle < 2.6) x[i]! += rnd() * 0.004;
	}
	return x;
}

function writeWav(name: string, x: Float32Array): string {
	const f = join(dir, name);
	writeFileSync(f, encodeWav([x], SR, 'f32'));
	return f;
}

function ff(args: string[]): void {
	const r = spawnSync(TEST_FFMPEG, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

async function post(app: TestApp, key: string, body: unknown = {}, wait = true) {
	return app.inject({
		method: 'POST',
		url: `/api/media/${key}/voice-analysis${wait ? '?wait=1' : ''}`,
		headers: JSON_H,
		payload: JSON.stringify(body),
	});
}

async function getFile(app: TestApp, key: string, streamIndex?: number) {
	return app.inject({
		method: 'GET',
		url: `/api/media/${key}/voice-analysis${streamIndex === undefined ? '' : `?streamIndex=${streamIndex}`}`,
		headers: H,
	});
}

function resultOf(job: EngineJob): VoiceAnalysisJobResult {
	expect(job.kind).toBe('voice-analysis');
	expect(job.state).toBe('succeeded');
	return VoiceAnalysisJobResultSchema.parse(job.result);
}

function cacheFiles(app: TestApp, fingerprint: string): string[] {
	const d = join(app.appdir, 'cache', fingerprintHex(fingerprint));
	return existsSync(d) ? readdirSync(d).filter((f) => f.startsWith('voice-analysis-')) : [];
}

/** The pure analysis of a 16 kHz mono file's samples (what the engine must produce for it). */
function expected(x: Float32Array, fingerprint: string, stream: number): Uint8Array {
	return encodeVoiceAnalysis(buildVoiceAnalysis({ fingerprint, stream, samples: x.length, planes: voiceFeatures(x) }));
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'jasper-voice-'));
});
afterAll(async () => {
	await closeApps();
	rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!HAVE_FFMPEG)('voice-analysis job and routes', () => {
	let app: TestApp;
	beforeAll(async () => {
		app = await makeApp();
	});

	it('analyses a stream exactly like the pure analysis of its samples and caches it', async () => {
		const x = programme(30);
		const m = await register(app, writeWav('prog.wav', x));
		const r = await post(app, m.mediaKey);
		expect(r.statusCode, r.body).toBe(200);
		const res = resultOf(r.json() as EngineJob);
		expect(res).toMatchObject({
			mediaKey: m.mediaKey,
			streamIndex: 0,
			cached: false,
			frameCount: 3000,
			durationSeconds: 30,
			url: `/api/media/${m.mediaKey}/voice-analysis?streamIndex=0`,
		});
		expect(res.seconds.speech + res.seconds.breath + res.seconds.silence).toBeCloseTo(30, 6);
		expect(res.seconds.speech).toBeGreaterThan(11);
		expect(res.seconds.breath).toBeGreaterThan(2);
		const g = await getFile(app, m.mediaKey, 0);
		expect(g.statusCode).toBe(200);
		expect(g.headers['content-type']).toBe('application/octet-stream');
		const bytes = new Uint8Array(g.rawPayload);
		expect(bytes.length).toBe(res.bytes);
		expect(Buffer.from(bytes).equals(Buffer.from(expected(x, m.fingerprint, 0)))).toBe(true);
		// the default stream is the first audio stream
		expect((await getFile(app, m.mediaKey)).rawPayload.equals(g.rawPayload)).toBe(true);

		// cached: nothing decoded
		const again = resultOf((await post(app, m.mediaKey, { streamIndex: 0 })).json() as EngineJob);
		expect(again).toMatchObject({ cached: true, elapsedMs: 0, frameCount: 3000 });

		// a media-cache derivative of the file's fingerprint
		const files = cacheFiles(app, m.fingerprint);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^voice-analysis-[0-9a-f]{12}\.bin$/);
		const abs = join(app.appdir, 'cache', fingerprintHex(m.fingerprint), files[0]!);
		expect(entryOfPath(app.appdir, abs)).toMatchObject({ kind: 'media-cache' });
	});

	it('treats a damaged cache file as a miss and replaces it', async () => {
		const x = programme(8, 7);
		const m = await register(app, writeWav('damaged.wav', x));
		resultOf((await post(app, m.mediaKey)).json() as EngineJob);
		const file = join(app.appdir, 'cache', fingerprintHex(m.fingerprint), cacheFiles(app, m.fingerprint)[0]!);
		const b = readFileSync(file);
		b[b.length - 10]! ^= 0x55;
		writeFileSync(file, b);
		const g = await getFile(app, m.mediaKey);
		expect(g.statusCode).toBe(404);
		expect(g.json()).toMatchObject({ code: 'VOICE_ANALYSIS_NOT_FOUND' });
		const res = resultOf((await post(app, m.mediaKey)).json() as EngineJob);
		expect(res.cached).toBe(false);
		const ok = decodeVoiceAnalysis(new Uint8Array((await getFile(app, m.mediaKey)).rawPayload));
		expect(ok.ok).toBe(true);
		expect(Buffer.from(readFileSync(file)).equals(Buffer.from(expected(x, m.fingerprint, 0)))).toBe(true);
	});

	it('analyses the chosen stream of a multi-stream file (48 kHz stereo FLAC in Matroska)', async () => {
		const voice = writeWav('voice16.wav', programme(6, 3));
		const out = join(dir, 'two.mkv');
		ff([
			...['-i', voice, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=6'],
			...['-map', '0:a', '-map', '1:a', '-c:a', 'flac', '-ac', '2', '-ar', '48000', out],
		]);
		const m = await register(app, out);
		const audio = m.probe.streams.filter((s) => s.type === 'audio').map((s) => s.index);
		expect(audio).toHaveLength(2);
		const a = resultOf((await post(app, m.mediaKey, { streamIndex: audio[0] })).json() as EngineJob);
		const b = resultOf((await post(app, m.mediaKey, { streamIndex: audio[1] })).json() as EngineJob);
		expect(a.streamIndex).toBe(audio[0]);
		expect(b.streamIndex).toBe(audio[1]);
		expect(a.seconds.speech).toBeGreaterThan(1.5);
		// the second stream is digital silence: no levels, only silence
		expect(b).toMatchObject({ floorDb: null, speechDb: null, speechThresholdDb: null });
		expect(b.seconds.silence).toBeCloseTo(b.durationSeconds, 1);
		// the 48 kHz stream is resampled to 16 kHz: 6 s = 600 frames
		expect(a.frameCount).toBe(600);
		expect(cacheFiles(app, m.fingerprint)).toHaveLength(2);
		const fb = decodeVoiceAnalysis(new Uint8Array((await getFile(app, m.mediaKey, audio[1])).rawPayload), {
			stream: audio[1],
		});
		expect(fb.ok).toBe(true);
	});

	it('validates requests', async () => {
		const m = await register(app, writeWav('valid.wav', programme(2)));
		const png = join(dir, 'still.png');
		ff(['-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-frames:v', '1', png]);
		const still = await register(app, png);
		const cases: Array<[Promise<{ statusCode: number; json(): unknown }>, number, string]> = [
			[post(app, 'mk_000000000000000000000000'), 404, 'ASSET_NOT_FOUND'],
			[post(app, 'nope'), 404, 'ASSET_NOT_FOUND'],
			[post(app, m.mediaKey, { streamIndex: 5 }), 400, 'VALIDATION_FAILED'],
			[post(app, m.mediaKey, { streamIndex: -1 }), 400, 'VALIDATION_FAILED'],
			[post(app, m.mediaKey, { streamIndex: 0, extra: true }), 400, 'VALIDATION_FAILED'],
			[post(app, still.mediaKey), 422, 'UNSUPPORTED_MEDIA'],
			[getFile(app, m.mediaKey, 3), 400, 'VALIDATION_FAILED'],
			[
				app.inject({ method: 'GET', url: `/api/media/${m.mediaKey}/voice-analysis?streamIndex=x`, headers: H }),
				400,
				'VALIDATION_FAILED',
			],
			[getFile(app, 'mk_000000000000000000000000'), 404, 'ASSET_NOT_FOUND'],
			[getFile(app, m.mediaKey), 404, 'VOICE_ANALYSIS_NOT_FOUND'],
		];
		for (const [p, status, code] of cases) {
			const r = await p;
			expect(r.statusCode, JSON.stringify(r.json())).toBe(status);
			expect(r.json()).toMatchObject({ code });
		}
	});

	it('cancels a running analysis: no file, the next request works', async () => {
		const long = join(dir, 'long.flac');
		ff(['-f', 'lavfi', '-i', 'sine=f=150:sample_rate=16000:d=1500', '-c:a', 'flac', long]);
		const m = await register(app, long);
		const job = (await post(app, m.mediaKey, {}, false)).json() as EngineJob;
		await until(async () => {
			const j = (await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: H })).json() as EngineJob;
			return j.state === 'running' && (j.progress ?? 0) > 0 ? j : null;
		}, 60_000);
		await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: H });
		const done = await until(async () => {
			const j = (await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: H })).json() as EngineJob;
			return ['cancelled', 'failed', 'succeeded'].includes(j.state) ? j : null;
		}, 20_000);
		expect(done.state).toBe('cancelled');
		expect(cacheFiles(app, m.fingerprint)).toEqual([]);
		const short = await register(app, writeWav('after-cancel.wav', programme(3, 9)));
		expect(resultOf((await post(app, short.mediaKey)).json() as EngineJob).frameCount).toBe(300);
	}, 120_000);

	it('turns a decoder failure and offline media into job errors', async () => {
		const f = writeWav('broken.wav', programme(4, 5));
		const m = await register(app, f);
		const st = statSync(f);
		// same size and mtime (still "online"), but no longer audio
		writeFileSync(f, Buffer.alloc(st.size, 0x5a));
		utimesSync(f, st.atime, st.mtime);
		const r = await post(app, m.mediaKey);
		expect(r.statusCode).toBe(422);
		expect(r.json()).toMatchObject({ code: 'TOOL_FAILED' });
		expect(cacheFiles(app, m.fingerprint)).toEqual([]);
		rmSync(f);
		const off = await post(app, m.mediaKey);
		expect(off.statusCode).toBe(422);
		expect(off.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
		expect((await app.inject({ method: 'GET', url: '/health', headers: H })).statusCode).toBe(200);
	});

	it('real speech (LJ Speech, public domain) is speech inside the utterances and not between them', async () => {
		const truth = JSON.parse(readFileSync(LJ.replace(/\.flac$/, '.json'), 'utf8')) as {
			utterances: Array<{ start: number; end: number }>;
		};
		const m = await register(app, LJ);
		resultOf((await post(app, m.mediaKey)).json() as EngineJob);
		const d = decodeVoiceAnalysis(new Uint8Array((await getFile(app, m.mediaKey)).rawPayload));
		if (!d.ok) throw new Error(d.error);
		const a = d.analysis;
		let inside = 0;
		let insideSpeech = 0;
		let outside = 0;
		let outsideSpeech = 0;
		const fps = SR / VOICE_HOP;
		for (let k = 0; k < a.frameCount; k++) {
			const t = k / fps;
			const u = truth.utterances.find((x) => t >= x.start - 0.15 && t < x.end + 0.15);
			const core = truth.utterances.some((x) => t >= x.start + 0.1 && t < x.end - 0.1);
			if (core) {
				inside++;
				if (a.classes[k] === 2) insideSpeech++;
			} else if (!u) {
				outside++;
				if (a.classes[k] === 2) outsideSpeech++;
			}
		}
		// speech has its own short pauses: most, not all, of an utterance is speech
		expect(insideSpeech / inside).toBeGreaterThan(0.7);
		expect(outsideSpeech / Math.max(1, outside)).toBeLessThan(0.02);
	});
});

describe.skipIf(!HAVE_FFMPEG)('voice-analysis on worker threads', () => {
	const saved = process.env.JASPER_VOICE_WORKER;
	afterEach(() => {
		if (saved === undefined) delete process.env.JASPER_VOICE_WORKER;
		else process.env.JASPER_VOICE_WORKER = saved;
	});

	it('gives the same bytes as the pure analysis (bundled worker)', async () => {
		const out = join(dir, 'voice-worker.mjs');
		await build({
			entryPoints: [join(ROOT, 'apps', 'engine', 'src', 'voice', 'worker.ts')],
			outfile: out,
			bundle: true,
			platform: 'node',
			format: 'esm',
			target: 'node20',
			logLevel: 'silent',
		});
		process.env.JASPER_VOICE_WORKER = out;
		const app = await makeApp({ totalSlots: 4 });
		// 65 s: several blocks on several workers, a partial last block
		const x = programme(65, 11);
		const m = await register(app, writeWav('threads.wav', x));
		const res = resultOf((await post(app, m.mediaKey)).json() as EngineJob);
		expect(res.frameCount).toBe(6500);
		const g = await getFile(app, m.mediaKey);
		expect(Buffer.from(g.rawPayload).equals(Buffer.from(expected(x, m.fingerprint, 0)))).toBe(true);
	}, 120_000);

	it('a worker that dies fails the job (VOICE_ANALYSIS_FAILED), writes nothing and the engine keeps serving', async () => {
		const crash = join(dir, 'crash-worker.mjs');
		writeFileSync(
			crash,
			"import { parentPort } from 'node:worker_threads';\nparentPort.on('message', () => process.exit(3));\nparentPort.postMessage({ id: 0, ready: true });\n",
		);
		process.env.JASPER_VOICE_WORKER = crash;
		const app = await makeApp();
		const m = await register(app, writeWav('crash.wav', programme(25, 2)));
		const r = await post(app, m.mediaKey);
		expect(r.statusCode).toBe(422);
		expect(r.json()).toMatchObject({ code: 'VOICE_ANALYSIS_FAILED' });
		expect(cacheFiles(app, m.fingerprint)).toEqual([]);
		expect((await app.inject({ method: 'GET', url: '/health', headers: H })).statusCode).toBe(200);
		const job = (r.json() as { detail?: { jobId?: string } }).detail?.jobId;
		const j = (await app.inject({ method: 'GET', url: `/api/jobs/${job}`, headers: H })).json() as EngineJob;
		expect(j).toMatchObject({ state: 'failed', error: { code: 'VOICE_ANALYSIS_FAILED', retryable: true } });
	});

	it('a worker module that cannot start means in-thread analysis (same bytes)', async () => {
		process.env.JASPER_VOICE_WORKER = join(dir, 'missing-worker.mjs');
		const app = await makeApp();
		const x = programme(12, 4);
		const m = await register(app, writeWav('fallback.wav', x));
		resultOf((await post(app, m.mediaKey)).json() as EngineJob);
		const g = await getFile(app, m.mediaKey);
		expect(Buffer.from(g.rawPayload).equals(Buffer.from(expected(x, m.fingerprint, 0)))).toBe(true);
	});
});
