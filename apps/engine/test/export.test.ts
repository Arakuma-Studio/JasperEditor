import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExportResultSchema, RenderPlanSchema } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { frameCodes } from './frame-codes.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	H,
	JSON_H,
	makeApp,
	register,
	type TestApp,
} from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 180_000); // a clean checkout generates the fixture media first (ffmpeg, ~10–30 s)
afterAll(closeApps);

const settings = (seqId: string, extra: Record<string, unknown> = {}) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	video: {
		codec: 'h264',
		width: 1920,
		height: 1080,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 23 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine: 'auto',
	...extra,
});

function probe(file: string) {
	const r = spawnSync('ffprobe', [
		'-v',
		'error',
		'-count_frames',
		'-show_entries',
		'stream=codec_type,codec_name,width,height,nb_read_frames,pix_fmt,color_space,color_primaries,color_transfer,sample_rate,channels,duration',
		'-of',
		'json',
		file,
	]);
	return JSON.parse(r.stdout.toString()).streams as Record<string, string | number>[];
}

function pixel(file: string, frame: number, x: number, y: number): [number, number, number] {
	const r = spawnSync('ffmpeg', [
		'-v',
		'error',
		'-i',
		file,
		'-vf',
		`select=eq(n\\,${frame}),format=rgb24,crop=1:1:${x}:${y}`,
		'-frames:v',
		'1',
		'-f',
		'rawvideo',
		'-',
	]);
	const b = r.stdout;
	return [b[0]!, b[1]!, b[2]!];
}

/** clip-a on V1 (with linked A1), still.png on V2 at 50 % with an offset, a blue 10 % solid on V3. */
async function twoTrackDoc() {
	const clipA = await register(app, fixture('clip-a.mp4'));
	const still = await register(app, fixture('still.png'));
	const d = new DocBuilder();
	const a = d.addMedia(clipA);
	const s = d.addMedia(still);
	d.tx([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 90 } },
			ref: '$a',
		},
	]);
	const placed = d.tx([
		{
			type: 'clip.place',
			source: { mediaId: s },
			at: 30,
			tracks: { video: 'V2' },
			sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
			ref: '$s',
		},
		{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V3', color: [0, 0, 1, 1], ref: '$blue' },
	]);
	const stillClip = placed.refs.$s!;
	const blue = placed.refs.$blue!;
	d.tx([
		{ type: 'param.set', target: ['clip', stillClip, 'transform', 'scale'], value: 50 },
		{ type: 'param.set', target: ['clip', stillClip, 'transform', 'position'], value: [1400, 760] },
		{ type: 'param.set', target: ['clip', blue, 'transform', 'scale'], value: 10 },
		{ type: 'param.set', target: ['clip', blue, 'transform', 'position'], value: [480, 200] },
	]);
	return { d, stillClip, blue };
}

describe('planner (S04:RP-001/008/010)', () => {
	it('warns when an export refers to offline media', async () => {
		const d = new DocBuilder();
		const clip = await register(app, fixture('clip-b.mp4'));
		const offline = d.addMedia({
			...clip,
			locators: [{ type: 'engine-store', engineId: 'x', key: 'mk_ffffffffffffffffffffffff' }],
		});
		d.tx([{ type: 'clip.place', source: { mediaId: offline }, at: 0 }]);
		const response = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(response.statusCode).toBe(200);
		expect(RenderPlanSchema.parse(response.json()).warnings.map((warning) => warning.code)).toContain(
			'OFFLINE_MEDIA',
		);
	});
});

describe('native export (S03:ENG-030, S04:RN-021/022, QA-005)', () => {
	it('plans and exports a 2-track sequence with exact frames, tracks and output metadata', async () => {
		const { d } = await twoTrackDoc();
		const r = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(r.statusCode).toBe(200);
		const plan = RenderPlanSchema.parse(r.json());
		expect(plan).toMatchObject({
			path: 'native',
			blockers: [],
			audio: { mode: 'native-mix' },
			segments: [{ startFrame: 0, endFrame: 90, mode: 'native', graphicsGroups: [] }],
		});
		expect(plan.planId).toMatch(/^pln_/);
		expect(plan.estimate.seconds).toBeGreaterThan(0);
		// the expected composite pipeline: three layers on the CPU in one graph (a 3 s range is never split)
		expect(plan.pipeline).toMatchObject({ composite: 'cpu', segments: 1, overlays: 3 });
		const again = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(again.json().planId).toBe(plan.planId);
		const events: string[] = [];
		const off = coreServices(app).broadcaster.subscribe((e) => events.push(e.type));
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(start.statusCode).toBe(202);
		const job = start.json();
		expect(job).toMatchObject({ kind: 'export', priority: 'user' });
		const done = await coreServices(app).queue.wait(job.id);
		off();
		expect(done.error).toBeUndefined();
		expect(done.state).toBe('succeeded');
		const result = done.result as {
			downloadUrl: string;
			frames: number;
			byteSize: number;
			renderPath: string;
		};
		expect(result).toMatchObject({
			downloadUrl: `/renders/${job.id}/output`,
			frames: 90,
			renderPath: 'native',
		});
		expect(events).toContain('export.finished');
		// what ran, and where the time went
		const ran = ExportResultSchema.parse(done.result);
		expect(ran.pipeline).toMatchObject({ composite: 'cpu', segments: 1 });
		expect(ran.pipeline!.overlays).toBeGreaterThanOrEqual(2);
		for (const phase of ['audio', 'bake', 'plan', 'encode', 'frameCheck', 'finish'])
			expect(ran.timings!.phases[phase], phase).toBeDefined();
		expect(ran.timings!.phases.encode!.startMs).toBeGreaterThanOrEqual(ran.timings!.phases.plan!.startMs);

		const file = (await coreServices(app).exports.outputFile(job.id))!;
		const streams = probe(file);
		const v = streams.find((s) => s.codec_type === 'video')!;
		const a = streams.find((s) => s.codec_type === 'audio')!;
		expect(v).toMatchObject({
			codec_name: 'h264',
			width: 1920,
			height: 1080,
			pix_fmt: 'yuv420p',
			color_space: 'bt709',
			color_primaries: 'bt709',
			color_transfer: 'bt709',
		});
		expect(Number(v.nb_read_frames)).toBe(90);
		expect(a).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 });
		expect(Number(a.duration)).toBeCloseTo(3, 1);

		const isBlue = (p: number[]) => p[2]! > 200 && p[1]! < 80 && p[0]! < 80;
		const isGreen = (p: number[]) => p[1]! > 150 && p[0]! < 80 && p[2]! < 80;
		expect(isBlue(pixel(file, 10, 480, 200))).toBe(true);
		expect(isGreen(pixel(file, 70, 480, 200))).toBe(true);
		const stillRed = pixel(file, 70, 930, 700);
		expect(stillRed[0]).toBeGreaterThan(200);
		expect(stillRed[1]).toBeLessThan(60);

		const size = readFileSync(file).length;
		expect(result.byteSize).toBe(size);
		const dl = await app.inject({
			method: 'GET',
			url: result.downloadUrl,
			headers: { ...H, range: 'bytes=0-11' },
		});
		expect(dl.statusCode).toBe(206);
		expect(dl.headers['content-range']).toBe(`bytes 0-11/${size}`);
		expect(dl.rawPayload.subarray(4, 8).toString('latin1')).toBe('ftyp');
	}, 600_000);

	it('renders a still frame natively for media-only frames (POST /api/stills)', async () => {
		const { d } = await twoTrackDoc();
		const r = await app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, frame: 10, width: 960 },
		});
		expect(r.statusCode).toBe(202);
		const done = await coreServices(app).queue.wait(r.json().id);
		expect(done.state).toBe('succeeded');
		expect(done.result).toMatchObject({ url: `/renders/${r.json().id}/output`, renderPath: 'native' });
		const png = await app.inject({ method: 'GET', url: `/renders/${r.json().id}/output`, headers: H });
		expect(png.statusCode).toBe(200);
		expect(png.headers['content-type']).toBe('image/png');
		const f = join(mkdtempSync(join(tmpdir(), 'jasper-png-')), 'f.png');
		writeFileSync(f, png.rawPayload);
		const s = probe(f);
		expect(s[0]).toMatchObject({ codec_name: 'png', width: 960, height: 540 });
	}, 60_000);
});

describe('frame accuracy of the native path', () => {
	it('starts every clip on its exact frame, also when the start is not a round number of seconds', async () => {
		const coded = await register(app, fixture('frame-code.mp4'));
		const d = new DocBuilder();
		const m = d.addMedia(coded);
		const place = (at: number, inFrame: number, outFrame: number) => ({
			type: 'clip.place',
			source: { mediaId: m },
			at,
			sourceRange: { in: { sourceFrames: inFrame }, out: { sourceFrames: outFrame } },
			matchSequence: 'keep',
		});
		// Frame 10 is 0.333333… s and frame 40 is 1.333333… s: written as decimal seconds they are a hair
		// before the frame boundary, so decimal-seconds rounding must not move the clip start.
		d.tx([place(0, 0, 10), place(10, 20, 50), place(40, 5, 25)]);
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: settings(d.seqId, { engine: 'native' }),
			},
		});
		expect(start.statusCode).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error).toBeUndefined();
		expect(done.result).toMatchObject({ frames: 60, renderPath: 'native' });
		const file = (await coreServices(app).exports.outputFile(start.json().id))!;
		const want: [number, number][] = [
			[0, 0],
			[9, 9],
			[10, 20],
			[11, 21],
			[39, 49],
			[40, 5],
			[41, 6],
			[59, 24],
		];
		expect(
			frameCodes(
				file,
				want.map(([frame]) => frame),
			),
		).toEqual(want.map(([, code]) => code));
	}, 120_000);

	it('plays a trimmed clip at twice its source rate', async () => {
		const coded = await register(app, fixture('frame-code.mp4'));
		const d = new DocBuilder();
		const placed = d.tx([
			{
				type: 'clip.place',
				source: { mediaId: d.addMedia(coded) },
				at: 0,
				sourceRange: { in: { sourceFrames: 10 }, out: { sourceFrames: 50 } },
				matchSequence: 'keep',
				ref: '$speed',
			},
		]);
		d.tx([{ type: 'clip.setSpeed', clipIds: [placed.refs.$speed!], rate: 2, ripple: false }]);
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(start.statusCode).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.state).toBe('succeeded');
		const file = (await coreServices(app).exports.outputFile(start.json().id))!;
		expect(Number(probe(file).find((stream) => stream.codec_type === 'video')?.nb_read_frames)).toBe(20);
		expect(frameCodes(file, [0, 10, 19])).toEqual([10, 30, 48]);
	}, 120_000);

	async function exportedTone(rate: number, sourceSeconds: number): Promise<Int16Array> {
		const tone = await register(app, fixture('tone.wav'));
		const d = new DocBuilder();
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId: d.addMedia(tone) },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: sourceSeconds } },
				matchSequence: 'keep',
			},
		]);
		d.tx([{ type: 'clip.setSpeed', clipIds: d.clipIds(), rate, maintainPitch: true, ripple: false }]);
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(start.statusCode).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.state).toBe('succeeded');
		const file = (await coreServices(app).exports.outputFile(start.json().id))!;
		const decoded = spawnSync('ffmpeg', [
			'-v',
			'error',
			'-i',
			file,
			'-map',
			'0:a:0',
			'-ac',
			'1',
			'-ar',
			'48000',
			'-f',
			's16le',
			'-',
		]);
		expect(decoded.status).toBe(0);
		return new Int16Array(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.byteLength / 2);
	}
	function rms(samples: Int16Array, startSec: number): number {
		const from = Math.round(startSec * 48000);
		const window = samples.subarray(from, from + 1440);
		return Math.sqrt(window.reduce((sum, value) => sum + value * value, 0) / window.length);
	}
	function frequency(samples: Int16Array, startSec: number): number {
		const from = Math.round(startSec * 48000);
		const window = samples.subarray(from, from + 2400);
		let crossings = 0;
		for (let i = 1; i < window.length; i++) if (window[i - 1]! <= 0 && window[i]! > 0) crossings++;
		return crossings / (window.length / 48000);
	}

	it('time-stretches 4× audio while preserving its pitch', async () => {
		const samples = await exportedTone(4, 4);
		expect(samples.length / 48000).toBeCloseTo(1, 1);
		// The source's decay resets every 0.5 s; at 4× it resets near 0.125 s.
		expect(rms(samples, 0.12)).toBeGreaterThan(rms(samples, 0.08) * 2);
		expect(frequency(samples, 0.05)).toBeGreaterThan(900);
		expect(frequency(samples, 0.05)).toBeLessThan(1100);
	}, 120_000);

	it('time-stretches 0.25× audio across the slow-speed range', async () => {
		const samples = await exportedTone(0.25, 1);
		expect(samples.length / 48000).toBeCloseTo(4, 1);
		// The source's second beep begins at 0.5 s; at quarter speed it begins near 2 s.
		expect(rms(samples, 2.05)).toBeGreaterThan(rms(samples, 1.8) * 2);
		expect(frequency(samples, 0.2)).toBeGreaterThan(900);
		expect(frequency(samples, 0.2)).toBeLessThan(1100);
	}, 120_000);
});

describe('GPU transitions in the planner (transition framework)', () => {
	it('keeps the built-in transitions native and bakes only the span of a GPU transition (hybrid, D-35)', async () => {
		const plan = async (effectId: string) => {
			const d = new DocBuilder();
			d.tx([
				{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] },
				{ type: 'clip.addSolid', at: 30, duration: 30, track: 'V1', color: [0, 0, 1, 1] },
				{ type: 'transition.add', trackId: 'V1', at: 30, effectId, duration: 10 },
			]);
			const r = await app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: JSON_H,
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
			});
			expect(r.statusCode).toBe(200);
			return RenderPlanSchema.parse(r.json());
		};
		const native = await plan('jasper.cross-dissolve');
		expect(native.path).toBe('native');
		const gpu = await plan('jasper.iris-round');
		expect(gpu.path).toBe('hybrid');
		expect(gpu.blockers).toEqual([]);
		expect(gpu.segments[0]!.graphicsGroups).toEqual([
			expect.objectContaining({ engine: 'remotion', itemIds: [expect.stringMatching(/^trn_/)] }),
		]);
	});
});

describe('transitions on the native path (S01 §13)', () => {
	/**
	 * frame-code.mp4 twice on V1, cut at frame 20: A shows source frames 32…51 (bit 5 of the code is white),
	 * B shows 8…27 (bit 5 black). Both have media handles around the cut.
	 */
	async function cutDoc(effectId: string) {
		const coded = await register(app, fixture('frame-code.mp4'));
		const d = new DocBuilder();
		const m = d.addMedia(coded);
		const place = (at: number, inFrame: number, ref: string) => ({
			type: 'clip.place',
			source: { mediaId: m },
			at,
			sourceRange: { in: { sourceFrames: inFrame }, out: { sourceFrames: inFrame + 20 } },
			matchSequence: 'keep',
			ref,
		});
		d.tx([
			place(0, 32, '$a'),
			place(20, 8, '$b'),
			{ type: 'transition.add', clipId: '$b', edge: 'in', effectId, duration: 10 },
		]);
		return d;
	}
	async function exportNative(d: DocBuilder) {
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: settings(d.seqId, { engine: 'native' }),
			},
		});
		expect(start.statusCode).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error).toBeUndefined();
		expect(done.result).toMatchObject({ frames: 40, renderPath: 'native' });
		return (await coreServices(app).exports.outputFile(start.json().id))!;
	}
	const near = (got: number, want: number, tol = 7) =>
		Math.abs(got - want) <= tol || `${got} is not within ${tol} of ${want}`;

	it('cross-dissolves through the handles: frame i of d shows (i + 1) / (d + 1) of the incoming clip', async () => {
		const file = await exportNative(await cutDoc('jasper.cross-dissolve'));
		// Bit 5 of the frame code (x 390…450, y 40…100) is white in A and black in B.
		const bit5 = (frame: number) => pixel(file, frame, 420, 70)[0];
		expect(near(bit5(14), 255)).toBe(true);
		expect(near(bit5(15), 255 * (10 / 11))).toBe(true);
		expect(near(bit5(19), 255 * (6 / 11))).toBe(true);
		expect(near(bit5(20), 255 * (5 / 11))).toBe(true);
		expect(near(bit5(24), 255 * (1 / 11))).toBe(true);
		expect(near(bit5(25), 0)).toBe(true);
		expect(frameCodes(file, [14, 25])).toEqual([46, 13]);
	}, 120_000);

	it('dips to black: the outgoing clip ends on a black frame, the incoming one fades in', async () => {
		const file = await exportNative(await cutDoc('jasper.dip-to-black'));
		// Flat background of frame-code.mp4: RGB (32, 64, 128); sample the blue channel.
		const blue = (frame: number) => pixel(file, frame, 1000, 600)[2];
		expect(near(blue(14), 128)).toBe(true);
		expect(near(blue(15), 128 * (4 / 5))).toBe(true);
		expect(near(blue(17), 128 * (2 / 5))).toBe(true);
		expect(near(blue(19), 0)).toBe(true);
		expect(near(blue(20), 128 * (1 / 6))).toBe(true);
		expect(near(blue(24), 128 * (5 / 6))).toBe(true);
		expect(near(blue(25), 128)).toBe(true);
		expect(frameCodes(file, [25])[0]).toBe(13);
	}, 120_000);
});

describe('masters and bitrate', () => {
	it('exports a ProRes 422 HQ master with PCM audio', async () => {
		const coded = await register(app, fixture('frame-code.mp4'));
		const d = new DocBuilder();
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId: d.addMedia(coded) },
				at: 0,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 60 } },
				matchSequence: 'keep',
			},
		]);
		const video = (settings(d.seqId).video as Record<string, unknown>) ?? {};
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: settings(d.seqId, {
					container: 'mov',
					video: { ...video, codec: 'prores' },
					engine: 'native',
				}),
			},
		});
		expect(start.statusCode).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error).toBeUndefined();
		expect(done.result).toMatchObject({ frames: 60, container: 'mov', encoder: 'prores_ks' });
		const file = (await coreServices(app).exports.outputFile(start.json().id))!;
		expect(file.endsWith('output.mov')).toBe(true);
		const [v, a] = probe(file);
		expect(v).toMatchObject({ codec_name: 'prores', pix_fmt: 'yuv422p10le', color_space: 'bt709' });
		expect(a).toMatchObject({ codec_name: 'pcm_s16le', sample_rate: '48000' });
		expect(frameCodes(file, [40])[0]).toBe(40);
	}, 120_000);
});

describe('overlays with an alpha channel on the native path', () => {
	/** A red full-frame solid on V1; the ProRes 4444 overlay on V2 for frames 0–30, the VP9 WebM one after it. */
	async function overlayDoc() {
		const mov = await register(app, fixture('overlay-alpha.mov'));
		const webm = await register(app, fixture('overlay-alpha.webm'));
		const d = new DocBuilder();
		const m = d.addMedia(mov);
		const w = d.addMedia(webm);
		d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1] },
			{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { video: 'V2' }, matchSequence: 'keep' },
			{ type: 'clip.place', source: { mediaId: w }, at: 30, tracks: { video: 'V2' }, matchSequence: 'keep' },
		]);
		return { d, mov, webm };
	}

	it('preserves alpha when a trimmed VP8 overlay starts mid-file', async () => {
		const vp8 = await register(app, fixture('overlay-alpha-vp8.webm'));
		const d = new DocBuilder();
		d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 20, track: 'V1', color: [1, 0, 0, 1] },
			{
				type: 'clip.place',
				source: { mediaId: d.addMedia(vp8) },
				at: 0,
				tracks: { video: 'V2' },
				sourceRange: { in: { sourceFrames: 10 }, out: { sourceFrames: 30 } },
				matchSequence: 'keep',
			},
		]);
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: settings(d.seqId, { engine: 'native' }),
			},
		});
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error).toBeUndefined();
		const file = (await coreServices(app).exports.outputFile(start.json().id))!;
		const p = pixel(file, 5, 960, 540);
		expect(Math.abs(p[0] - 127) < 16 && Math.abs(p[1] - 128) < 16).toBe(true);
	}, 120_000);

	it('refuses the native path when the build has no libvpx decoder for an alpha WebM', async () => {
		const { d } = await overlayDoc();
		const core = coreServices(app);
		const { planExport } = await import('../src/export/planner.ts');
		const caps = {
			native: true,
			remotionLocal: 'ready' as const,
			fframes: 'unavailable' as const,
			mgMasters: false,
		};
		const plan = (decoders: string[]) =>
			planExport(
				{ envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) as never },
				{ registry: core.registry, fonts: core.fonts, capabilities: { ...caps, decoders } },
			);
		const without = await plan(['vp9', 'prores']);
		expect(without.plan.path).toBe('remotion');
		expect(without.plan.blockers.length).toBeGreaterThan(0);
		expect((await plan(['vp9', 'prores', 'libvpx-vp9'])).plan.path).toBe('native');
	});

	it('composites both overlays with their alpha (no black box, straight alpha, no colour shift)', async () => {
		const { d } = await overlayDoc();
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: settings(d.seqId, { engine: 'native' }),
			},
		});
		expect(start.statusCode).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error).toBeUndefined();
		expect(done.result).toMatchObject({ frames: 60, renderPath: 'native' });
		const file = (await coreServices(app).exports.outputFile(start.json().id))!;
		const near = (p: number[], want: number[], tol: number) =>
			p.every((v, i) => Math.abs(v - want[i]!) <= tol) || `${p} is not within ${tol} of ${want}`;
		for (const frame of [10, 45]) {
			expect(near(pixel(file, frame, 1700, 900), [255, 0, 0], 12)).toBe(true);
			// 50 % green over red: (R, G) ≈ (127, 128). A premultiplied/straight mix-up would give ≈ (191, 64)
			// or clip, a dropped alpha channel would give black.
			expect(near(pixel(file, frame, 960, 540), [127, 128, 0], 14)).toBe(true);
			expect(near(pixel(file, frame, 200, 200), [255, 255, 255], 8)).toBe(true);
		}
	}, 120_000);
});

describe('export destinations and render outputs', () => {
	it('copies to an absolute destination path without overwriting and rejects relative paths', async () => {
		const clipA = await register(app, fixture('clip-a.mp4'));
		const d = new DocBuilder();
		d.tx([{ type: 'clip.place', source: { mediaId: d.addMedia(clipA) }, at: 0 }]);
		const outDir = mkdtempSync(join(tmpdir(), 'jasper-dest-'));
		const dest = join(outDir, 'out.mp4');
		const body = (path: string) => ({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId, {
				range: { type: 'custom', startFrame: 0, endFrame: 15 },
				destination: { type: 'path', path },
			}),
		});
		const bad = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: body('relative/out.mp4'),
		});
		expect(bad.statusCode).toBe(400);
		expect(bad.json().code).toBe('VALIDATION_FAILED');
		writeFileSync(dest, 'existing');
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: body(dest),
		});
		expect(start.statusCode).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.state).toBe('succeeded');
		expect((done.result as { path: string }).path).toBe(join(outDir, 'out (2).mp4'));
		expect(readFileSync(dest, 'utf8')).toBe('existing');
		expect(probe(join(outDir, 'out (2).mp4')).find((x) => x.codec_type === 'video')?.nb_read_frames).toBe(
			'15',
		);
	}, 60_000);

	it('removes the stored request of an export that failed for good; sweeps stale requests (WP-3I)', async () => {
		const core = coreServices(app);
		const reqDir = join(core.config.paths.rendersDir, '.requests');
		mkdirSync(reqDir, { recursive: true });
		const file = join(reqDir, 'req_e2ebroken.json');
		writeFileSync(
			file,
			JSON.stringify({
				kind: 'export',
				request: {
					envelope: { revision: 1, document: { nope: true } },
					sequenceId: 'seq_missing',
					settings: {
						sequenceId: 'seq_missing',
						range: { type: 'entire' },
						container: 'mp4',
						engine: 'auto',
					},
				},
			}),
		);
		const job = core.queue.submit({
			kind: 'export',
			title: 'bad doc',
			priority: 'user',
			cpuSlots: 1,
			input: { request: file },
		});
		const done = await core.queue.wait(job.id);
		expect(done.state).toBe('failed');
		expect(done.error?.retryable).toBe(false);
		expect(existsSync(file)).toBe(false);

		const stale = join(reqDir, 'req_stale.json');
		const recent = join(reqDir, 'req_recent.json');
		writeFileSync(stale, '{}');
		writeFileSync(recent, '{}');
		const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
		utimesSync(stale, old, old);
		expect(await core.exports.sweepRequests()).toBe(1);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(recent)).toBe(true);
	});

	it('never serves the output of a render that has not succeeded', async () => {
		const core = coreServices(app);
		const job = core.queue.submit({
			kind: 'export',
			title: 'broken',
			priority: 'user',
			cpuSlots: 1,
			input: {},
		});
		const done = await core.queue.wait(job.id);
		expect(done.state).toBe('failed');
		const dir = join(core.config.paths.rendersDir, job.id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'output.mp4'), 'partial');
		expect(
			(await app.inject({ method: 'GET', url: `/renders/${job.id}/output`, headers: H })).statusCode,
		).toBe(404);
	});
});
