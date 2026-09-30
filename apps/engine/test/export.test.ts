// Export planner and native export (ARCHITECTURE §9.5, S04 §11–§12, QA-005).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RenderPlanSchema } from '@jasper/api';
import { buildRenderSnapshot, FLICKS_PER_SECOND } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNativeGraph } from '../src/export/native.ts';
import { nativeBlockers } from '../src/export/planner.ts';
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
	until,
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
		colorTags: 'rec709',
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
	d.tx([{ type: 'clip.place', source: { mediaId: a }, at: 0, ref: '$a' }]);
	const placed = d.tx([
		{ type: 'clip.place', source: { mediaId: s }, at: 30, tracks: { video: 'V2' }, ref: '$s' },
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
	it('plans native for a media-only sequence and returns a valid RenderPlan', async () => {
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
			segments: [{ startFrame: 0, endFrame: 300, mode: 'native', graphicsGroups: [] }],
		});
		expect(plan.planId).toMatch(/^pln_/);
		expect(plan.estimate.seconds).toBeGreaterThan(0);
		// Deterministic (S04:RP-011).
		const again = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(again.json().planId).toBe(plan.planId);
	});

	it('chooses remotion for a sequence with a text clip, with a blocker message; forcing native is refused', async () => {
		const clipA = await register(app, fixture('clip-a.mp4'));
		const d = new DocBuilder();
		const a = d.addMedia(clipA);
		d.tx([{ type: 'clip.place', source: { mediaId: a }, at: 0 }]);
		const t = d.tx([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'Title' }, ref: '$t' },
		]);
		const textId = t.refs.$t!;
		const r = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		const plan = RenderPlanSchema.parse(r.json());
		expect(plan.path).toBe('remotion');
		expect(plan.audio.mode).toBe('remotion');
		expect(plan.blockers).toEqual([
			{
				itemId: textId,
				path: 'native',
				reason: expect.stringMatching(/text layer .*requires graphics rendering/),
			},
		]);
		expect(plan.segments[0]!.graphicsGroups[0]).toMatchObject({ engine: 'remotion' });

		const forced = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: settings(d.seqId, { engine: 'native' }),
			},
		});
		expect(forced.statusCode).toBe(409);
		expect(forced.json()).toMatchObject({
			code: 'PATH_NOT_ELIGIBLE',
			detail: { blockers: [expect.objectContaining({ itemId: textId })] },
		});
	});

	it('reports offline media, keyframed motion and motion graphics without fframes', async () => {
		const d = new DocBuilder();
		const clipB = await register(app, fixture('clip-b.mp4'));
		const b = d.addMedia({
			...clipB,
			locators: [{ type: 'engine-store', engineId: 'x', key: 'mk_ffffffffffffffffffffffff' }],
		});
		const placed = d.tx([{ type: 'clip.place', source: { mediaId: b }, at: 0, ref: '$b' }]);
		d.tx([
			{
				type: 'param.setAnimated',
				target: ['clip', placed.refs.$b!, 'opacity'],
				animated: true,
				at: { sequenceFrame: 0 },
			},
		]);
		d.tx([
			{
				type: 'param.set',
				target: ['clip', placed.refs.$b!, 'opacity'],
				value: 50,
				at: { sequenceFrame: 10 },
			},
		]);
		const plan = (
			await coreServices(app).exports.plan({
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: settings(d.seqId) as never,
			})
		).plan;
		expect(plan.path).toBe('remotion');
		expect(plan.blockers.map((x) => x.reason).join('\n')).toMatch(/animated opacity/);
		const mgClip = { ...planned0(), kind: 'motion-graphic' as const, name: 'LT' };
		expect(
			nativeBlockers(mgClip, {
				native: true,
				remotionLocal: 'ready',
				fframes: 'unavailable',
				mgMasters: false,
			}),
		).toEqual(['motion graphic "LT" needs the fframes renderer, which is unavailable']);
		expect(
			nativeBlockers(mgClip, { native: true, remotionLocal: 'ready', fframes: 'ready', mgMasters: true }),
		).toEqual([]);
		expect(plan.warnings.map((w) => w.code)).toContain('OFFLINE_MEDIA');
	});
});

describe('native export (S03:ENG-030, S04:RN-021/022, QA-005)', () => {
	it('exports a 2-track sequence to an mp4 whose frame count equals the range length', async () => {
		const { d } = await twoTrackDoc();
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
			frames: 300,
			renderPath: 'native',
		});
		expect(events).toContain('export.finished');

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
		expect(Number(v.nb_read_frames)).toBe(300);
		expect(a).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 });
		expect(Number(a.duration)).toBeCloseTo(10, 1);

		// Geometry: the blue solid (10 %, centred at 480,200 → 192×108 at 384,146) sits on clip-a's green bar
		// for frames < 60 only.
		const isBlue = (p: number[]) => p[2]! > 200 && p[1]! < 80 && p[0]! < 80;
		const isGreen = (p: number[]) => p[1]! > 150 && p[0]! < 80 && p[2]! < 80;
		expect(isBlue(pixel(file, 10, 480, 200))).toBe(true);
		expect(isBlue(pixel(file, 10, 386, 148))).toBe(true); // inside the top-left corner
		expect(isGreen(pixel(file, 10, 380, 142))).toBe(true); // just outside it
		expect(isGreen(pixel(file, 10, 600, 200))).toBe(true);
		expect(isGreen(pixel(file, 90, 480, 200))).toBe(true); // the solid ended at frame 60
		// The still (50 %, top-left 920,490): its red first bar starts at x=920.
		const stillRed = pixel(file, 90, 930, 700);
		expect(stillRed[0]).toBeGreaterThan(200);
		expect(stillRed[1]).toBeLessThan(60);

		// Download with Range (S04:MS-002).
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
	}, 120_000);

	it('places the scaled still exactly where the layer matrix says (filtergraph)', async () => {
		const { d, stillClip } = await twoTrackDoc();
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		const g = buildNativeGraph({
			snapshot: planned.snapshot,
			output: planned.output,
			outputFile: '/tmp/x.mp4',
			sources: { media: (id) => planned.media[id] ?? null, mgMaster: () => null },
			threads: 2,
		});
		// 1920×1080 still at 50 % → 960×540, centred at (1400, 760) → top-left (920, 490).
		expect(g.filter).toContain('scale=960:540');
		expect(g.filter).toMatch(/overlay=x=920:y=490:.*enable='between\(t,0\.983333,5\.983333\)'/);
		// Input seeking + a still looped for its duration + audio mixed without normalization.
		expect(g.args).toEqual(expect.arrayContaining(['-loop', '1']));
		expect(g.filter).toMatch(/\[a0\]anull,apad=whole_len=\d+/); // one audio clip: no amix needed
		expect(g.filter).toContain('[vout]');
		expect(planned.snapshot.videoTracks[1]!.clips[0]!.clipId).toBe(stillClip);
	});

	it('honors speed with setpts/atempo and seeks sources at the clip in-point', async () => {
		const clipA = await register(app, fixture('clip-a.mp4'));
		const d = new DocBuilder();
		const a = d.addMedia(clipA);
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId: a },
				sourceRange: { in: { seconds: 2 }, out: { seconds: 4 } },
				at: 0,
			},
		]);
		const snapshot = buildRenderSnapshot(d.doc, d.seqId, {
			resolveMedia: () => ({
				url: '/x',
				proxyUrl: null,
				kind: 'video',
				width: 1920,
				height: 1080,
				durationFlicks: 10 * FLICKS_PER_SECOND,
				hasAudio: true,
				rotation: 0,
			}),
			resolveFont: () => null,
		});
		for (const t of snapshot.videoTracks) for (const c of t.clips) c.speed = { ...c.speed, rate: 2 };
		for (const c of snapshot.audioClips) c.speed = { ...c.speed, rate: 2 };
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		const g = buildNativeGraph({
			snapshot,
			output: { ...planned.output, frames: 60, durationSec: 2 },
			outputFile: '/tmp/y.mp4',
			sources: { media: () => Object.values(planned.media)[0]!, mgMaster: () => null },
			threads: 1,
		});
		expect(g.inputs[0]!.slice(0, 2)).toEqual(['-ss', '2.000000']);
		expect(g.filter).toContain('setpts=(PTS-STARTPTS)/2');
		expect(g.filter).toContain('atempo=2');
		expect(g.filter).toContain('atrim=end_sample=96000');
	});

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

	it('lists the export in the jobs API and 404s unknown render outputs', async () => {
		await until(
			async () => (await app.inject({ method: 'GET', url: '/api/jobs', headers: H })).json().jobs.length > 0,
		);
		expect(
			(await app.inject({ method: 'GET', url: '/renders/job_0000000000000000/output', headers: H }))
				.statusCode,
		).toBe(404);
		expect(
			(await app.inject({ method: 'GET', url: '/renders/..%2F..%2Fetc/output', headers: H })).statusCode,
		).toBe(404);
	});
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

/** A static, native-capable visual clip for classification tests. */
function planned0() {
	const anim = <T>(value: T) => ({ value, keyframes: [] });
	return {
		clipId: 'clp_X',
		kind: 'video' as const,
		trackId: 'trk_V',
		name: 'X',
		start: 0,
		duration: 10,
		sourceIn: 0,
		speed: { rate: 1, reverse: false, maintainPitch: true },
		source: { mediaId: 'med_X' },
		transform: {
			position: anim<[number, number]>([960, 540]),
			anchor: anim<[number, number]>([960, 540]),
			scale: anim(100),
			scaleWidth: anim(100),
			uniformScale: true,
			rotation: anim(0),
			flipH: false,
			flipV: false,
		},
		opacity: anim(100),
		blendMode: 'normal' as const,
		effects: [],
		intrinsicBox: { width: 1920, height: 1080 },
		engine: 'native' as const,
		bounded: true,
	};
}
