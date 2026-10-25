// pp-wma-preview: playback audio of audio the browser cannot decode (WMA, AC-3…). The engine probes WMA / AC-3 as not
// browser-decodable, makes a 32-bit float WAV per audio stream with the usual derivative lifecycle (progress, failure,
// cancel, cache reuse), the WAV is sample for sample FFmpeg's decode of the original (what previews play = what the
// export reads), and exports keep decoding the original — on the same sample timeline (sample-exact decode).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type EngineJob, PlaybackAudioHeaderSchema } from '@jasper/api';
import { FLICKS_PER_SECOND } from '@jasper/project';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

/** Independent RIFF wire check; the HTTP payload, rather than the derivative's own header parser, is the oracle. */
function wavSamples(buf: Buffer): { channels: number; sampleRate: number; data: Buffer } {
	expect(buf.toString('latin1', 0, 4)).toBe('RIFF');
	expect(buf.toString('latin1', 8, 12)).toBe('WAVE');
	let channels = 0;
	let sampleRate = 0;
	for (let at = 12; at + 8 <= buf.length; ) {
		const chunk = buf.toString('latin1', at, at + 4);
		const bytes = buf.readUInt32LE(at + 4);
		const body = at + 8;
		if (chunk === 'fmt ') {
			const tag = buf.readUInt16LE(body);
			expect(tag === 3 || (tag === 0xfffe && buf.readUInt16LE(body + 24) === 3)).toBe(true);
			channels = buf.readUInt16LE(body + 2);
			sampleRate = buf.readUInt32LE(body + 4);
			expect(buf.readUInt16LE(body + 14)).toBe(32);
		} else if (chunk === 'data') {
			return { channels, sampleRate, data: buf.subarray(body, body + bytes) };
		}
		at = body + bytes + (bytes & 1);
	}
	throw new Error('Missing WAV data chunk');
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
	it('WAV and AAC registration need no playback derivative, even when one is requested', async () => {
		const tone = await register(app, fixture('tone.wav'));
		const clip = await register(app, fixture('clip-a.mp4'));
		for (const m of [tone, clip]) {
			const s = await statusOf(m.mediaKey);
			expect(s.derivatives['playback-audio']).toMatchObject({ state: 'none' });
			const request = await app.inject({
				method: 'POST',
				url: `/api/media/${m.mediaKey}/derivatives`,
				headers: JSON_H,
				payload: { kinds: ['playback-audio'] },
			});
			expect(request.statusCode, request.body).toBe(200);
			expect(request.json().jobs).toEqual([]);
		}
	});
});

describe('the playback audio', () => {
	it('of a WMA: queued at registration, a float WAV that is FFmpeg’s decode of the original sample for sample', async () => {
		const m = await register(app, WMA);
		expect(m).toMatchObject({ kind: 'audio', browserPlayable: 'no', container: 'asf' });
		expect(m.probe.streams).toEqual([
			expect.objectContaining({ type: 'audio', codec: 'wmav2', sampleRate: 44100, channels: 2 }),
		]);
		const s = await settled(m.mediaKey);
		const d = s.derivatives['playback-audio']!;
		expect(d.state, d.error).toBe('ready');
		const header = PlaybackAudioHeaderSchema.parse(
			(await app.inject({ method: 'GET', url: d.url!, headers: H })).json(),
		);
		expect(header.codec).toBe('pcm_f32le');
		expect(header.streams).toHaveLength(1);
		const st = header.streams[0]!;
		expect(st).toMatchObject({ index: 0, sampleRate: 44100, channels: 2 });

		// served as audio/wav with ranges (mediabunny's UrlSource reads by range)
		const head = await app.inject({ method: 'GET', url: st.url, headers: { ...H, range: 'bytes=0-11' } });
		expect(head.statusCode).toBe(206);
		expect(head.headers['content-type']).toContain('audio/wav');
		expect(head.rawPayload.toString('latin1', 0, 4)).toBe('RIFF');
		expect(
			(await app.inject({ method: 'GET', url: `/media/${m.mediaKey}/playback-audio/7.wav`, headers: H }))
				.statusCode,
		).toBe(404);

		const audio = await app.inject({ method: 'GET', url: st.url, headers: H });
		expect(audio.statusCode).toBe(200);
		const wav = wavSamples(audio.rawPayload);
		const ref = ffDecode(WMA);
		expect(wav.sampleRate).toBe(44100);
		expect(wav.channels).toBe(2);
		expect(st.frames).toBe(ref.length / 2);
		// bit-exact: no resampling, no dither, no encoder delay, nothing clipped
		expect(wav.data.equals(Buffer.from(ref.buffer))).toBe(true);
	}, 90_000);

	it('of an AC-3 video: the 5.1 stream at its own rate and channel count, equal to FFmpeg’s decode', async () => {
		const m = await register(app, AC3);
		expect(m.kind).toBe('video');
		expect(m.probe.streams.find((s) => s.type === 'video')).toMatchObject({ browserDecodable: true });
		expect(m.probe.streams.find((s) => s.type === 'audio')).toMatchObject({ codec: 'ac3', channels: 6 });
		expect(m.browserPlayable).toBe('unknown');
		const s = await settled(m.mediaKey);
		expect(s.derivatives['playback-audio']!.state, s.derivatives['playback-audio']!.error).toBe('ready');
		const header = PlaybackAudioHeaderSchema.parse(
			(await app.inject({ method: 'GET', url: s.derivatives['playback-audio']!.url!, headers: H })).json(),
		);
		expect(header.streams).toEqual([expect.objectContaining({ index: 1, sampleRate: 48000, channels: 6 })]);
		const audio = await app.inject({ method: 'GET', url: header.streams[0]!.url, headers: H });
		expect(audio.statusCode).toBe(200);
		const wav = wavSamples(audio.rawPayload);
		expect(wav).toMatchObject({ channels: 6, sampleRate: 48000 });
		const reference = ffDecode(AC3, '0:1');
		expect(header.streams[0]!.frames).toBe(reference.length / 6);
		expect(wav.data.equals(Buffer.from(reference.buffer))).toBe(true);
	}, 90_000);

	it('is reused: asking again completes at once, and a copy of the same file shares it', async () => {
		const m = await register(app, WMA);
		await settled(m.mediaKey);
		const core = coreServices(app);
		const rec = core.registry.get(m.mediaKey)!;
		const p = core.derivatives.paths(rec.fingerprint, 'playback-audio');
		const before = statSync(p.main).mtimeMs;
		const requested = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/derivatives`,
			headers: JSON_H,
			payload: { kinds: ['playback-audio'] },
		});
		expect(requested.statusCode, requested.body).toBe(200);
		const job = (requested.json() as { jobs: EngineJob[] }).jobs[0]!;
		expect((await core.queue.wait(job.id)).state).toBe('succeeded');
		const copy = join(dir, 'same-content.wma');
		copyFileSync(WMA, copy);
		const again = await register(app, copy);
		expect((await settled(again.mediaKey)).derivatives['playback-audio']!.state).toBe('ready');
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
		expect(d.error).toBeTruthy();
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

	it('cancelling leaves no published or partial files and no failed derivative', async () => {
		const core = coreServices(app);
		let started!: () => void;
		const running = new Promise<void>((r) => {
			started = r;
		});
		const src = freshWma('cancel.wma', 587);
		interceptPlaybackRun(
			src,
			(_args, opts) =>
				new Promise((_, reject) => {
					started();
					opts?.signal?.addEventListener('abort', () => {
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
		const rec = core.registry.get(m.mediaKey)!;
		const p = core.derivatives.paths(rec.fingerprint, 'playback-audio');
		expect(existsSync(p.main)).toBe(false);
		expect(partialsIn(p.main)).toEqual([]);
		const st = (await statusOf(m.mediaKey)).derivatives['playback-audio']!;
		expect(st.state).not.toBe('failed');
	}, 90_000);
});

describe('exports read the original, on the playback audio’s sample timeline', () => {
	it('a native export decodes the WMA itself and lines up with the preview’s samples (lag 0, residual ≤ −50 dB)', async () => {
		const core = coreServices(app);
		const m = await register(app, WMA);
		await settled(m.mediaKey);
		const rec = core.registry.get(m.mediaKey)!;
		const cache = core.derivatives.paths(rec.fingerprint, 'playback-audio');
		const wavFile = join(dir, 'preview-reference.wav');
		copyFileSync(join(cache.dir!, '0.wav'), wavFile);
		// Cache GC may remove playback copies; exports must still decode the original.
		rmSync(cache.main);
		rmSync(cache.dir!, { recursive: true });
		const d = new DocBuilder('hd-1080p-30', 900);
		const mediaId = d.addMedia(m);
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 3.5 } },
				at: 0,
				tracks: { audio: 'A1' },
			},
		]);
		const clipId = d.clipIds()[0]!;
		d.tx([{ type: 'clip.trim', clipId, edge: 'in', deltaFrames: 15 }]); // In point 0.5 s
		expect(d.doc.sequences[d.seqId]!.clips[clipId]!.sourceIn).toBe(0.5 * FLICKS_PER_SECOND);
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
		const out = (await core.exports.outputFile(job.id))!;
		const exported = ffDecode(out);
		// Trim moves the clip's start to 0.5 s but preserves its authored 3.5 s sequence end.
		expect(exported.length).toBe(3.5 * 48000 * 2);
		// the preview's samples (the playback WAV from the In point) at the export rate, with the export's resampler
		const r = spawnSync(
			TEST_FFMPEG,
			[
				'-v',
				'error',
				'-i',
				wavFile,
				'-af',
				'aresample=48000:resampler=soxr:precision=28:cheby=1',
				'-f',
				'f32le',
				'-',
			],
			{ maxBuffer: 1 << 26 },
		);
		expect(r.status, r.stderr.toString()).toBe(0);
		const preview = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
		// 2.5 s from 0.1 s into the clip; both channels; the lag that matches best must be 0 and the rest ≤ −50 dB
		const SR = 48000;
		const n = Math.round(2.5 * SR);
		const e0 = Math.round((0.5 + 0.1) * SR);
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
