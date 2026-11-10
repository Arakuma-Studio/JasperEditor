// Parallel picture segments of a native export (apps/engine/src/export/segments.ts; docs/wp-notes/export-performance.md):
// a range split at a cut (inside a cross dissolve) and mid-clip, with a sub-pixel keyframed still and a solid crossing
// both boundaries, renders the same picture as one graph — ProRes (intra: every frame encoded on its own) decodes to
// identical frames, H.264 within the repo's SSIM 0.98 (the encoder starts each segment with a key frame, so its
// quality differs there) —, with the exact frame count, continuous timestamps, a key frame at each
// segment start and the same sound; a failing segment fails the job with its own error and stops the others; a
// cancelled export stops every segment and leaves no scratch files.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ExportResultSchema } from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import { compareVideos } from '@jasper/testkit/oracle';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
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
	type TestApp,
} from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp({ totalSlots: 8 });
}, 180_000);
afterAll(closeApps);
afterEach(() => {
	delete process.env.JASPER_EXPORT_SEGMENTS;
	delete process.env.JASPER_EXPORT_SEGMENT_MIN_SEC;
});

const FRAMES = 150;

/** V1: clip-a | cross dissolve at 60 | clip-b | frame-code; V2: a still moving sub-pixel over 10…140; V3: a solid. */
async function doc() {
	const a = await register(app, fixture('clip-a.mp4'));
	const b = await register(app, fixture('clip-b.mp4'));
	const code = await register(app, fixture('frame-code.mp4'));
	const still = await register(app, fixture('still.png'));
	const tone = await register(app, fixture('tone.wav'));
	const d = new DocBuilder('hd-720p-30');
	const [ma, mb, mc, ms, mt] = [a, b, code, still, tone].map((m) => d.addMedia(m));
	const place = (
		media: string,
		at: number,
		inF: number,
		outF: number,
		extra: Record<string, unknown> = {},
	) => ({
		type: 'clip.place',
		source: { mediaId: media },
		at,
		sourceRange: { in: { sourceFrames: inF }, out: { sourceFrames: outF } },
		...extra,
	});
	const placed = d.tx([
		place(ma!, 0, 0, 60),
		place(mb!, 60, 10, 60),
		place(mc!, 120, 0, 30),
		{ type: 'transition.add', trackId: 'V1', at: 60, effectId: 'jasper.cross-dissolve', duration: 10 },
		{
			type: 'clip.place',
			source: { mediaId: ms! },
			at: 10,
			tracks: { video: 'V2' },
			sourceRange: { in: { seconds: 0 }, out: { seconds: 130 / 30 } },
			ref: '$s',
		},
		{ type: 'clip.addSolid', at: 30, duration: 100, track: 'V3', color: [0.2, 0.4, 1, 1], ref: '$solid' },
		{
			type: 'clip.place',
			source: { mediaId: mt! },
			at: 0,
			tracks: { audio: 'A2' },
			sourceRange: { in: { seconds: 0 }, out: { seconds: 5 } },
		},
	]);
	const s = placed.refs.$s!;
	const solid = placed.refs.$solid!;
	d.tx([
		{ type: 'param.set', target: ['clip', s, 'transform', 'scale'], value: 30 },
		{
			type: 'keyframe.add',
			target: ['clip', s, 'transform', 'position'],
			at: { sequenceFrame: 10 },
			value: [200.3, 150.7],
		},
		{
			type: 'keyframe.add',
			target: ['clip', s, 'transform', 'position'],
			at: { sequenceFrame: 139 },
			value: [1050.6, 560.2],
		},
		{ type: 'param.set', target: ['clip', solid, 'transform', 'scale'], value: 20 },
		{ type: 'param.set', target: ['clip', solid, 'transform', 'position'], value: [900, 200] },
	]);
	return d;
}

const settings = (d: DocBuilder, video: Record<string, unknown>, container: string) => ({
	sequenceId: d.seqId,
	range: { type: 'entire' },
	container,
	engine: 'native',
	video: {
		width: 640,
		height: 360,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 23 },
		encoderSpeed: 'fast',
		...video,
	},
	audio: { codec: container === 'mov' ? 'pcm' : 'aac', sampleRate: 48000, channels: 2 },
});

async function start(d: DocBuilder, s: ReturnType<typeof settings>): Promise<string> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
	});
	expect(r.statusCode, r.body).toBe(202);
	return r.json().id as string;
}

async function exportWith(d: DocBuilder, s: ReturnType<typeof settings>, segments: string) {
	process.env.JASPER_EXPORT_SEGMENTS = segments;
	process.env.JASPER_EXPORT_SEGMENT_MIN_SEC = '0.5';
	const id = await start(d, s);
	const done = await coreServices(app).queue.wait(id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	const file = (await coreServices(app).exports.outputFile(id))!;
	return { id, file, result: ExportResultSchema.parse(done.result) };
}

const probe = (file: string, args: string[]) =>
	spawnSync('ffprobe', ['-v', 'error', ...args, '-of', 'json', file], { encoding: 'utf8' });

/** Decoded frame hashes of a stream (`v` or `a`). */
function frameHashes(file: string, stream: 'v' | 'a'): string[] {
	const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', `0:${stream}:0`, '-f', 'framemd5', '-'], {
		encoding: 'utf8',
		maxBuffer: 64 << 20,
	});
	return r.stdout
		.split('\n')
		.filter((l) => l && !l.startsWith('#'))
		.map((l) => l.split(',').at(-1)!.trim());
}

describe('parallel picture segments (native)', { timeout: 600_000 }, () => {
	it('ProRes: three segments decode to the frames of one graph, with the same sound', async () => {
		const d = await doc();
		const s = settings(d, { codec: 'prores' }, 'mov');
		const one = await exportWith(d, s, '1');
		const three = await exportWith(d, s, '3');
		expect(one.result.pipeline).toMatchObject({ segments: 1 });
		expect(three.result.pipeline).toMatchObject({ segments: 3, composite: 'cpu' });
		expect(three.result.timings!.phases.join).toBeDefined();
		expect(three.result.frames).toBe(FRAMES);
		const ref = frameHashes(one.file, 'v');
		expect(ref).toHaveLength(FRAMES);
		expect(frameHashes(three.file, 'v')).toEqual(ref);
		expect(frameHashes(three.file, 'a')).toEqual(frameHashes(one.file, 'a'));
		// the job's scratch (segment files) is gone
		expect(existsSync(join(appdirPaths(app.appdir).tmpDir, three.id))).toBe(false);
	});

	it('H.264: one picture (SSIM ≥ 0.98), exact frames, continuous timestamps, a key frame at each segment start', async () => {
		const d = await doc();
		const s = settings(d, { codec: 'h264' }, 'mp4');
		const plan = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
		});
		process.env.JASPER_EXPORT_SEGMENTS = '3';
		process.env.JASPER_EXPORT_SEGMENT_MIN_SEC = '0.5';
		const planned = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
		});
		expect(plan.json().pipeline).toMatchObject({ segments: 1 });
		expect(planned.json().pipeline).toMatchObject({ segments: 3 });
		const one = await exportWith(d, s, '1');
		const three = await exportWith(d, s, '3');
		expect(three.result.pipeline).toMatchObject({ segments: 3 });
		const q = compareVideos(one.file, three.file);
		expect(q.frames).toHaveLength(FRAMES);
		console.info(
			`segments vs one graph (H.264): SSIM min ${Math.min(...q.frames.map((f) => f.ssim))}, all ${q.ssim}`,
		);
		for (const [f, v] of q.frames.entries()) expect(v.ssim, `frame ${f}`).toBeGreaterThanOrEqual(0.98);
		const frames = JSON.parse(
			probe(three.file, ['-select_streams', 'v:0', '-show_entries', 'frame=pts,key_frame,pict_type']).stdout,
		).frames as { pts: number; key_frame: number }[];
		expect(frames).toHaveLength(FRAMES);
		const step = frames[1]!.pts - frames[0]!.pts;
		expect(frames[0]!.pts).toBe(0);
		for (let i = 1; i < frames.length; i++)
			expect(frames[i]!.pts - frames[i - 1]!.pts, `pts step ${i}`).toBe(step);
		// boundaries: 50 moves to the cut at 60 (within a quarter segment), 100 stays mid-clip
		expect(frames[60]!.key_frame).toBe(1);
		expect(frames[100]!.key_frame).toBe(1);
		const stream = JSON.parse(
			probe(three.file, [
				'-show_entries',
				'stream=codec_type,codec_name,color_space,color_primaries,color_transfer,duration',
			]).stdout,
		).streams as Record<string, string>[];
		expect(stream.find((x) => x.codec_type === 'video')).toMatchObject({
			codec_name: 'h264',
			color_space: 'bt709',
			color_primaries: 'bt709',
			color_transfer: 'bt709',
		});
		expect(Number(stream.find((x) => x.codec_type === 'audio')!.duration)).toBeCloseTo(5, 1);
		expect(frameHashes(three.file, 'a')).toEqual(frameHashes(one.file, 'a'));
	});

	it('a failing segment fails the export with its ffmpeg error and stops the other segments', async () => {
		const d = await doc();
		const core = coreServices(app);
		const run = core.ffmpeg.run;
		const stopped: boolean[] = [];
		core.ffmpeg.run = (args, options = {}) => {
			const out = args.at(-1) ?? '';
			if (/segment-1\.mp4$/.test(out))
				return Promise.reject(new Error('ffmpeg exited 1: segment two exploded'));
			if (/segment-\d\.mp4$/.test(out))
				return run.call(core.ffmpeg, args, options).finally(() => stopped.push(!!options.signal?.aborted));
			return run.call(core.ffmpeg, args, options);
		};
		onTestFinished(() => {
			core.ffmpeg.run = run;
		});
		process.env.JASPER_EXPORT_SEGMENTS = '3';
		process.env.JASPER_EXPORT_SEGMENT_MIN_SEC = '0.5';
		const id = await start(d, settings(d, { codec: 'h264' }, 'mp4'));
		const done = await core.queue.wait(id);
		expect(done.state).toBe('failed');
		expect(done.error?.message).toMatch(/segment two exploded/);
		expect(stopped).toHaveLength(2);
		expect(existsSync(join(appdirPaths(app.appdir).tmpDir, id))).toBe(false);
	});

	it('cancelling stops every segment and removes the scratch files', async () => {
		const d = await doc();
		const core = coreServices(app);
		const run = core.ffmpeg.run;
		const signals: AbortSignal[] = [];
		let began!: () => void;
		const encoding = new Promise<void>((resolve) => {
			began = resolve;
		});
		core.ffmpeg.run = (args, options = {}) => {
			if (!/segment-\d\.mp4$/.test(args.at(-1) ?? '')) return run.call(core.ffmpeg, args, options);
			signals.push(options.signal!);
			if (signals.length === 3) began();
			return run.call(core.ffmpeg, args, options);
		};
		onTestFinished(() => {
			core.ffmpeg.run = run;
		});
		process.env.JASPER_EXPORT_SEGMENTS = '3';
		process.env.JASPER_EXPORT_SEGMENT_MIN_SEC = '0.5';
		const id = await start(d, settings(d, { codec: 'h264' }, 'mp4'));
		expect(await Promise.race([encoding.then(() => true), core.queue.wait(id).then(() => false)])).toBe(true);
		const cancel = await app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: H });
		expect(cancel.statusCode, cancel.body).toBeLessThan(300);
		const done = await core.queue.wait(id);
		expect(done.state).toBe('cancelled');
		expect(signals.every((s) => s.aborted)).toBe(true);
		expect(existsSync(join(appdirPaths(app.appdir).tmpDir, id))).toBe(false);
		expect(await core.exports.outputFile(id)).toBeNull();
	});
});
