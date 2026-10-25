// pp-wma-preview: playback audio of audio the browser cannot decode (WMA, AC-3…). The engine probes WMA / AC-3 as not
// browser-decodable, makes a 32-bit float WAV per audio stream with the usual derivative lifecycle (progress, failure,
// cancel, cache reuse), the WAV is sample for sample FFmpeg's decode of the original (what previews play = what the
// export reads), and exports keep decoding the original — on the same sample timeline (sample-exact decode).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type EngineJob, PlaybackAudioHeaderSchema } from '@jasper/api';
import { FLICKS_PER_SECOND } from '@jasper/project';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clipDecodeArgs, resamplerArgs } from '../src/audio/decode.ts';
import { readWavInfo } from '../src/derivatives/service.ts';
import { ToolError } from '../src/tools/process.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	H,
	JSON_H,
	makeApp,
	register,
	TEST_FFMPEG,
	type TestApp,
	tempAppdir,
	until,
} from './helpers.ts';

const WMA = fixture('legacy-wma.wma');
const AC3 = fixture('legacy-ac3.mkv');
let app: TestApp;
let dir: string;

beforeAll(async () => {
	ensureFixtures();
	if (!existsSync(WMA) || !existsSync(AC3)) {
		const script = fileURLToPath(new URL('../../../scripts/make-fixtures.mjs', import.meta.url));
		const r = spawnSync(process.execPath, [script], { stdio: 'inherit' });
		expect(r.status).toBe(0);
	}
	expect(existsSync(WMA), 'legacy-wma.wma needs an FFmpeg with the wmav2 encoder').toBe(true);
	expect(existsSync(AC3), 'legacy-ac3.mkv needs an FFmpeg with the ac3 encoder').toBe(true);
	app = await makeApp();
	dir = tempAppdir('jasper-wma-');
}, 180_000);
afterEach(() => vi.restoreAllMocks());
afterAll(closeApps);

/** FFmpeg's decode of one stream of a file, interleaved f32 (the export's reading of the original). */
function ffDecode(file: string, map = '0:a:0'): Float32Array {
	const r = spawnSync(TEST_FFMPEG, ['-v', 'error', '-i', file, '-map', map, '-f', 'f32le', '-'], {
		maxBuffer: 1 << 28,
	});
	expect(r.status, r.stderr?.toString()).toBe(0);
	return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4).slice();
}

/** The samples of a 32-bit float WAV read straight from its data chunk (what mediabunny's PCM decoder yields). */
async function wavSamples(file: string): Promise<{ channels: number; sampleRate: number; data: Float32Array }> {
	const info = await readWavInfo(file);
	expect(info).not.toBeNull();
	expect(info!.bitsPerSample).toBe(32);
	const buf = readFileSync(file);
	const at = buf.indexOf('data', 12, 'latin1') + 8;
	const bytes = info!.frames * info!.channels * 4;
	const data = new Float32Array(bytes / 4);
	for (let i = 0; i < data.length; i++) data[i] = buf.readFloatLE(at + i * 4);
	return { channels: info!.channels, sampleRate: info!.sampleRate, data };
}

const statusOf = async (key: string) =>
	(await app.inject({ method: 'GET', url: `/api/media/${key}`, headers: H })).json() as {
		derivatives: Record<string, { state: string; url?: string; error?: string; jobId?: string }>;
	};

const settled = (key: string) =>
	until(
		async () => {
			const s = await statusOf(key);
			const st = s.derivatives['playback-audio']!.state;
			return st === 'ready' || st === 'failed' ? s : null;
		},
		60_000,
		50,
	);

/** A WMA of its own content (own fingerprint, so its playback audio is made, not reused). */
function freshWma(name: string, hz: number): string {
	const out = join(dir, name);
	const r = spawnSync(TEST_FFMPEG, [
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		`sine=frequency=${hz}:sample_rate=44100:duration=2`,
		'-ac',
		'2',
		'-c:a',
		'wmav2',
		out,
	]);
	expect(r.status, r.stderr?.toString()).toBe(0);
	return out;
}

const partialsIn = (file: string) =>
	readdirSync(dirname(file)).filter((f) => f.startsWith('playback-audio-') && f.includes('.partial'));

type RunFn = ReturnType<typeof coreServices>['ffmpeg']['run'];
/**
 * Replaces FFmpeg runs of the playback audio of `file` with `fake` (once), every other run (posters, sprites of other
 * media still in the queue) goes to FFmpeg.
 */
function interceptPlaybackRun(file: string, fake: RunFn) {
	const ff = coreServices(app).ffmpeg;
	const real = ff.run.bind(ff);
	let used = false;
	return vi.spyOn(ff, 'run').mockImplementation((args, opts) => {
		if (!used && args.includes(file) && args.includes('pcm_f32le')) {
			used = true;
			return fake(args, opts);
		}
		return real(args, opts);
	});
}

describe('classification at registration', () => {
	it('WMA and an AC-3 video are not browser-decodable; WAV / AAC media need no playback audio', async () => {
		const wma = await register(app, WMA);
		expect(wma).toMatchObject({ kind: 'audio', browserPlayable: 'no' });
		expect(wma.container).toBe('asf');
		expect(wma.probe.streams).toEqual([
			expect.objectContaining({ type: 'audio', codec: 'wmav2', sampleRate: 44100, channels: 2 }),
		]);
		const mkv = await register(app, AC3);
		expect(mkv.kind).toBe('video');
		expect(mkv.probe.streams.find((s) => s.type === 'video')).toMatchObject({ browserDecodable: true });
		expect(mkv.probe.streams.find((s) => s.type === 'audio')).toMatchObject({ codec: 'ac3', channels: 6 });
		expect(mkv.browserPlayable).toBe('unknown');

		const tone = await register(app, fixture('tone.wav'));
		const clip = await register(app, fixture('clip-a.mp4'));
		for (const m of [tone, clip]) {
			const s = await statusOf(m.mediaKey);
			expect(s.derivatives['playback-audio']).toMatchObject({ state: 'none' });
			// not applicable: asking for it queues nothing
			const rec = coreServices(app).registry.get(m.mediaKey)!;
			expect(coreServices(app).derivatives.request(rec, ['playback-audio'])).toEqual([]);
		}
	});
});

describe('the playback audio', () => {
	it('of a WMA: queued at registration, a float WAV that is FFmpeg’s decode of the original sample for sample', async () => {
		const m = await register(app, WMA);
		const s = await settled(m.mediaKey);
		const d = s.derivatives['playback-audio']!;
		expect(d.state, d.error).toBe('ready');
		expect(d.url).toMatch(new RegExp(`^/media/${m.mediaKey}/playback-audio\\.json\\?v=[0-9a-f]{12}$`));
		const header = PlaybackAudioHeaderSchema.parse(
			(await app.inject({ method: 'GET', url: d.url!, headers: H })).json(),
		);
		expect(header.codec).toBe('pcm_f32le');
		expect(header.streams).toHaveLength(1);
		const st = header.streams[0]!;
		expect(st).toMatchObject({ index: 0, sampleRate: 44100, channels: 2 });
		expect(st.url).toBe(d.url!.replace('playback-audio.json', 'playback-audio/0.wav'));

		// served as audio/wav with ranges (mediabunny's UrlSource reads by range)
		const head = await app.inject({ method: 'GET', url: st.url, headers: { ...H, range: 'bytes=0-11' } });
		expect(head.statusCode).toBe(206);
		expect(head.headers['content-type']).toContain('audio/wav');
		expect(head.rawPayload.toString('latin1', 0, 4)).toBe('RIFF');
		expect(
			(await app.inject({ method: 'GET', url: `/media/${m.mediaKey}/playback-audio/7.wav`, headers: H }))
				.statusCode,
		).toBe(404);

		const rec = coreServices(app).registry.get(m.mediaKey)!;
		const file = join(coreServices(app).derivatives.paths(rec.fingerprint, 'playback-audio').dir!, '0.wav');
		const wav = await wavSamples(file);
		const ref = ffDecode(WMA);
		expect(wav.sampleRate).toBe(44100);
		expect(wav.channels).toBe(2);
		expect(st.frames).toBe(ref.length / 2);
		// bit-exact: no resampling, no dither, no encoder delay, nothing clipped
		expect(Buffer.from(wav.data.buffer).equals(Buffer.from(ref.buffer))).toBe(true);
	}, 90_000);

	it('of an AC-3 video: the 5.1 stream at its own rate and channel count, equal to FFmpeg’s decode', async () => {
		const m = await register(app, AC3);
		const s = await settled(m.mediaKey);
		expect(s.derivatives['playback-audio']!.state, s.derivatives['playback-audio']!.error).toBe('ready');
		const rec = coreServices(app).registry.get(m.mediaKey)!;
		const audio = rec.probe.streams.find((x) => x.type === 'audio')!;
		const file = join(
			coreServices(app).derivatives.paths(rec.fingerprint, 'playback-audio').dir!,
			`${audio.index}.wav`,
		);
		const wav = await wavSamples(file);
		expect(wav).toMatchObject({ channels: 6, sampleRate: 48000 });
		expect(Buffer.from(wav.data.buffer).equals(Buffer.from(ffDecode(AC3, `0:${audio.index}`).buffer))).toBe(
			true,
		);
	}, 90_000);

	it('is reused: asking again completes at once, and a copy of the same file shares it', async () => {
		const m = await register(app, WMA);
		await settled(m.mediaKey);
		const core = coreServices(app);
		const rec = core.registry.get(m.mediaKey)!;
		const p = core.derivatives.paths(rec.fingerprint, 'playback-audio');
		const before = statSync(p.main).mtimeMs;
		const run = vi.spyOn(core.ffmpeg, 'run');
		const playbackRuns = () => run.mock.calls.filter((c) => c[0].includes('pcm_f32le')).length;
		const [job] = core.derivatives.request(rec, ['playback-audio'], { priority: 'user' });
		expect((await core.queue.wait(job!.id)).state).toBe('succeeded');
		const copy = join(dir, 'same-content.wma');
		copyFileSync(WMA, copy);
		const again = await register(app, copy);
		expect((await settled(again.mediaKey)).derivatives['playback-audio']!.state).toBe('ready');
		expect(playbackRuns()).toBe(0);
		expect(statSync(p.main).mtimeMs).toBe(before);
	}, 90_000);

	it('fails visibly without leaving partial files, and a retry makes it', async () => {
		const core = coreServices(app);
		const src = freshWma('fails.wma', 523);
		const spy = interceptPlaybackRun(src, async () => {
			throw new ToolError('TOOL_FAILED', 'ffmpeg exited 1: Invalid data found when processing input');
		});
		const m = await register(app, src);
		const s = await settled(m.mediaKey);
		const d = s.derivatives['playback-audio']!;
		expect(d.state).toBe('failed');
		expect(d.error).toContain('Invalid data');
		const rec = core.registry.get(m.mediaKey)!;
		const p = core.derivatives.paths(rec.fingerprint, 'playback-audio');
		expect(existsSync(p.main)).toBe(false);
		expect(partialsIn(p.main)).toEqual([]);
		// a failed playback audio stays failed (no retry loop on every status request)…
		expect((await statusOf(m.mediaKey)).derivatives['playback-audio']!.state).toBe('failed');
		// …until asked again
		spy.mockRestore();
		const retry = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/derivatives`,
			headers: JSON_H,
			payload: { kinds: ['playback-audio'] },
		});
		expect(retry.statusCode).toBe(200);
		const job = (retry.json() as { jobs: EngineJob[] }).jobs[0]!;
		expect(job.kind).toBe('playback-audio');
		expect((await core.queue.wait(job.id)).state).toBe('succeeded');
		expect((await statusOf(m.mediaKey)).derivatives['playback-audio']!.state).toBe('ready');
	}, 90_000);

	it('is cancellable: the job ends cancelled, FFmpeg is stopped, nothing is left behind, it is not "failed"', async () => {
		const core = coreServices(app);
		let started!: () => void;
		const running = new Promise<void>((r) => {
			started = r;
		});
		let aborted = false;
		const src = freshWma('cancel.wma', 587);
		interceptPlaybackRun(
			src,
			(_args, opts) =>
				new Promise((_, reject) => {
					started();
					opts?.signal?.addEventListener('abort', () => {
						aborted = true;
						reject(new ToolError('JOB_CANCELLED', 'ffmpeg cancelled'));
					});
				}),
		);
		const m = await register(app, src);
		await running;
		const id = (await statusOf(m.mediaKey)).derivatives['playback-audio']!.jobId!;
		expect(id).toBeTruthy();
		core.queue.cancel(id);
		const done = await core.queue.wait(id);
		expect(done.state).toBe('cancelled');
		expect(aborted).toBe(true);
		const rec = core.registry.get(m.mediaKey)!;
		const p = core.derivatives.paths(rec.fingerprint, 'playback-audio');
		expect(existsSync(p.main)).toBe(false);
		expect(partialsIn(p.main)).toEqual([]);
		const st = (await statusOf(m.mediaKey)).derivatives['playback-audio']!;
		expect(st.state).not.toBe('failed');
	}, 90_000);
});

describe('exports read the original, on the playback audio’s sample timeline', () => {
	it('the sample-exact clip decode of the original equals the playback audio from the In point', async () => {
		const m = await register(app, WMA);
		await settled(m.mediaKey);
		const rec = coreServices(app).registry.get(m.mediaKey)!;
		const wav = await wavSamples(
			join(coreServices(app).derivatives.paths(rec.fingerprint, 'playback-audio').dir!, '0.wav'),
		);
		const stream = rec.probe.streams[0] as never;
		// a 1 s clip from 0.5 s, decoded at the stream's own rate (no resampling): sample n = playback sample 22050 + n
		const frames = 30;
		const { args } = clipDecodeArgs({
			clip: {
				start: 0,
				duration: frames,
				sourceIn: 0.5 * FLICKS_PER_SECOND,
				speed: { rate: 1, reverse: false, maintainPitch: true },
				channels: { streamIndex: 0, map: [] },
			} as never,
			path: WMA,
			stream,
			fps: { num: 30, den: 1 },
			sampleRate: 44100,
			offset: 0,
			length: 44100,
			soxr: false,
			sampleExact: true,
		});
		expect(args).not.toContain('-ss');
		const r = spawnSync(TEST_FFMPEG, ['-v', 'error', ...args], { maxBuffer: 1 << 26 });
		expect(r.status, r.stderr.toString()).toBe(0);
		const got = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
		expect(got.length).toBe(44100 * 2);
		const want = wav.data.subarray(22050 * 2, (22050 + 44100) * 2);
		let maxErr = 0;
		for (let i = 0; i < got.length; i++) maxErr = Math.max(maxErr, Math.abs(got[i]! - want[i]!));
		expect(maxErr).toBeLessThan(1e-6);
	}, 90_000);

	it('a native export decodes the WMA itself and lines up with the preview’s samples (lag 0, residual ≤ −50 dB)', async () => {
		const core = coreServices(app);
		const m = await register(app, WMA);
		await settled(m.mediaKey);
		const rec = core.registry.get(m.mediaKey)!;
		const wavFile = join(core.derivatives.paths(rec.fingerprint, 'playback-audio').dir!, '0.wav');
		const d = new DocBuilder('hd-1080p-30', 900);
		const mediaId = d.addMedia(m);
		d.tx([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { audio: 'A1' } }]);
		const clipId = d.clipIds()[0]!;
		d.tx([{ type: 'clip.trim', clipId, edge: 'in', deltaFrames: 15 }]); // In point 0.5 s
		const clip = d.doc.sequences[d.seqId]!.clips[clipId] as unknown as { sourceIn: number; start: number };
		expect(clip.sourceIn).toBe(0.5 * FLICKS_PER_SECOND);
		const clipStartSec = clip.start / 30;
		const spawn = vi.spyOn(core.ffmpeg, 'spawnRaw');
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: {
					sequenceId: d.seqId,
					destination: { type: 'download' },
					range: { type: 'entire' },
					container: 'mov',
					video: {
						codec: 'h264',
						width: 320,
						height: 180,
						frameRate: { num: 30, den: 1 },
						scaling: 'fit',
						quality: { mode: 'crf', value: 35 },
						encoderSpeed: 'fast',
					},
					audio: { codec: 'pcm', sampleRate: 48000, channels: 2 },
					engine: 'native',
				},
			},
		});
		expect(start.statusCode, start.body).toBe(202);
		const job = await core.queue.wait((start.json() as EngineJob).id);
		expect(job.error, JSON.stringify(job.error)).toBeUndefined();
		// the clip was decoded from the original file, sample-exactly, never from the playback copy
		const decodes = spawn.mock.calls.map((c) => c[0] as string[]).filter((a) => a.includes(WMA));
		expect(decodes.length).toBeGreaterThan(0);
		for (const a of decodes) {
			expect(a).not.toContain('-ss');
			expect(a.join(' ')).toContain('atrim=start_sample=22050');
		}
		expect(
			spawn.mock.calls.some((c) => (c[0] as string[]).some((x) => x.includes('playback-audio'))),
		).toBe(false);
		const out = (await core.exports.outputFile(job.id))!;
		const exported = ffDecode(out);
		// the preview's samples (the playback WAV from the In point) at the export rate, with the export's resampler
		const r = spawnSync(
			TEST_FFMPEG,
			['-v', 'error', '-i', wavFile, '-af', `aresample=48000:${resamplerArgs(true)}`, '-f', 'f32le', '-'],
			{ maxBuffer: 1 << 26 },
		);
		expect(r.status, r.stderr.toString()).toBe(0);
		const preview = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
		// 2.5 s from 0.1 s into the clip; both channels; the lag that matches best must be 0 and the rest ≤ −50 dB
		const SR = 48000;
		const n = Math.round(2.5 * SR);
		const e0 = Math.round((clipStartSec + 0.1) * SR);
		const p0 = Math.round((0.5 + 0.1) * SR);
		const fit = (lag: number) => {
			let ep = 0;
			let pp = 0;
			let ee = 0;
			for (let i = 0; i < n * 2; i++) {
				const e = exported[e0 * 2 + i]!;
				const p = preview[(p0 + lag) * 2 + i]!;
				ep += e * p;
				pp += p * p;
				ee += e * e;
			}
			const g = ep / pp;
			return { g, residualDb: 10 * Math.log10(Math.max(1e-30, ee - 2 * g * ep + g * g * pp) / ee) };
		};
		let best = { lag: 0, ...fit(0) };
		for (let lag = -24; lag <= 24; lag++) {
			const f = fit(lag);
			if (f.residualDb < best.residualDb) best = { lag, ...f };
		}
		expect(best.lag).toBe(0);
		expect(best.residualDb).toBeLessThan(-50);
		expect(best.g).toBeGreaterThan(0.5);
	}, 180_000);
});
