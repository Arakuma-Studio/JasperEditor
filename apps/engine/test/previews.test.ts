// Workstream `previews` (docs/wp-notes/previews.md): render previews through the engine — segment files named by
// content hash, frame-exact I-frame-only H.264, atomic writes, status for the render bar, skip when nothing changed,
// ripple keeps them valid, Render Audio, Delete Render Files, cancellation, offline media, the cache registry.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PreviewRenderResult, PreviewStatus } from '@jasper/api';
import { audioPreviewSegments, flicksPerFrame, type ProjectDocument, previewSegments } from '@jasper/project';
import { probeFrames as oracleProbeFrames } from '@jasper/testkit/oracle';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { entryOfPath, scanAppdir } from '../src/cache/layout.ts';
import { previewFormatKey } from '../src/previews/service.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	type TestApp,
} from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 180_000);
afterAll(closeApps);

const F30 = flicksPerFrame({ num: 30, den: 1 });
const SETTINGS = { format: 'h264-iframe', size: 'full', quality: 'standard' } as const;

/** The 6-bit frame number burnt into frame-code.mp4 (see export.test.ts). */
function frameCode(file: string, frame: number): number {
	const r = spawnSync('ffmpeg', [
		...['-v', 'error', '-i', file],
		...['-vf', `select=eq(n\\,${frame}),format=rgb24,crop=420:1:40:70`],
		...['-frames:v', '1', '-f', 'rawvideo', '-'],
	]);
	let code = 0;
	for (let b = 0; b < 6; b++) if (r.stdout[(30 + 70 * b) * 3]! > 127) code |= 1 << b;
	return code;
}

function probeFrames(file: string): { pictTypes: string[]; codec: string; width: number; audio: boolean } {
	const s = spawnSync('ffprobe', [
		...['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width', '-of', 'json', file],
	]);
	const streams = (
		JSON.parse(s.stdout.toString()) as {
			streams: { codec_type: string; codec_name: string; width?: number }[];
		}
	).streams;
	const v = streams.find((x) => x.codec_type === 'video')!;
	return {
		// JSON (testkit): ffprobe's CSV puts frame side data (x264's "User Data Unregistered" SEI with a libx264 build,
		// e.g. CI's apt ffmpeg) on the same line as the picture type.
		pictTypes: oracleProbeFrames(file, 'v:0').map((f) => f.pictType ?? '?'),
		codec: v.codec_name,
		width: v.width ?? 0,
		audio: streams.some((x) => x.codec_type === 'audio'),
	};
}

async function build(): Promise<DocBuilder> {
	const coded = await register(app, fixture('frame-code.mp4'));
	const clipA = await register(app, fixture('clip-a.mp4'));
	const d = new DocBuilder();
	const m = d.addMedia(coded);
	const a = d.addMedia(clipA);
	d.tx([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at: 0,
			video: true,
			audio: false,
			sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 40 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 40,
			sourceRange: { in: { flicks: 0 }, out: { flicks: 20 * F30 } },
			ref: '$b',
		},
	]);
	const blurred = Object.values(d.doc.sequences[d.seqId]!.clips).find(
		(c) => c.kind === 'video' && c.start === 40,
	)!;
	// Scaled (yellow: plays live) and drawn natively (unit tests have no headless browser listening).
	d.tx([{ type: 'param.set', target: ['clip', blurred.id, 'transform', 'scale'], value: 50 }]);
	return d;
}

const render = (d: DocBuilder, mode: string, extra: Record<string, unknown> = {}) =>
	app.inject({
		method: 'POST',
		url: '/api/previews/render?wait=1',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, mode, ...extra },
	});

async function status(video: string[], audio: string[] = []): Promise<PreviewStatus> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/previews/status',
		headers: JSON_H,
		payload: { settings: SETTINGS, video, audio },
	});
	expect(r.statusCode, r.body).toBe(200);
	return r.json() as PreviewStatus;
}

const dirOf = () => join(app.appdir, 'cache', 'previews', previewFormatKey(SETTINGS));

describe('render previews', () => {
	it('renders every segment as a frame-exact I-frame-only file named by its hash; status turns them green', async () => {
		const d = await build();
		const segs = previewSegments(d.doc, d.seqId);
		expect(segs.map((s) => [s.startFrame, s.frames])).toEqual([
			[0, 40],
			[40, 20],
		]);
		expect(segs[0]!.need).toBe('none');
		expect(segs[1]!.need).not.toBe('none');
		const before = await status(segs.map((s) => s.hash));
		expect(before.video).toEqual([]);

		const r = await render(d, 'all');
		expect(r.statusCode, r.body).toBe(200);
		const job = r.json() as { state: string; result: PreviewRenderResult; error?: unknown };
		expect(job.error).toBeUndefined();
		expect(job.state).toBe('succeeded');
		expect(job.result.rendered.map((x) => x.hash).sort()).toEqual(segs.map((s) => s.hash).sort());
		expect(job.result.frames).toBe(60);

		const files = readdirSync(dirOf()).sort();
		expect(files).toEqual(segs.map((s) => `${s.hash}.mp4`).sort());
		const first = join(dirOf(), `${segs[0]!.hash}.mp4`);
		const p = probeFrames(first);
		expect(p.codec).toBe('h264');
		expect(p.width).toBe(1920);
		expect(p.audio).toBe(false);
		expect(p.pictTypes).toHaveLength(40);
		expect(p.pictTypes.every((t) => t === 'I')).toBe(true);
		for (const n of [0, 1, 17, 39]) expect(frameCode(first, n)).toBe(n);

		const after = await status(segs.map((s) => s.hash));
		expect(after.video.sort()).toEqual(segs.map((s) => s.hash).sort());
		expect(after.videoUrl).toMatch(/^\/renders\/previews\/[0-9a-f]{16}\/\{hash\}\.mp4$/);

		// served with byte ranges
		const url = after.videoUrl.replace('{hash}', segs[0]!.hash);
		const ranged = await app.inject({ method: 'GET', url, headers: { ...JSON_H, range: 'bytes=0-99' } });
		expect(ranged.statusCode).toBe(206);
		expect(ranged.rawPayload.length).toBe(100);
		expect(
			(await app.inject({ method: 'GET', url: url.replace(/[0-9a-f]{32}/, 'f'.repeat(32)), headers: JSON_H }))
				.statusCode,
		).toBe(404);

		// nothing changed: nothing to render
		const again = await render(d, 'all');
		expect(again.statusCode).toBe(200);
		expect(again.json()).toEqual({ job: null, existing: 2 });

		// a ripple keeps the hashes: every preview stays valid
		const ids = d.clipIds();
		d.tx([{ type: 'clip.move', clipIds: ids, deltaFrames: 25 }]);
		const moved = previewSegments(d.doc, d.seqId);
		expect((await status(moved.map((s) => s.hash))).video).toHaveLength(2);
		// no partial files are left behind
		expect(readdirSync(dirOf()).some((f) => f.includes('.part.'))).toBe(false);
	}, 300_000);

	it('Render Effects In to Out renders only the segments that need it; Render Selection the selected clips', async () => {
		const d = await build();
		await app.inject({
			method: 'POST',
			url: '/api/previews/delete',
			headers: JSON_H,
			payload: { all: true },
		});
		const segs = previewSegments(d.doc, d.seqId);
		const r = await render(d, 'effects');
		const job = r.json() as { result: PreviewRenderResult };
		expect(job.result.rendered.map((x) => x.hash)).toEqual([segs[1]!.hash]);
		await app.inject({
			method: 'POST',
			url: '/api/previews/delete',
			headers: JSON_H,
			payload: { all: true },
		});
		const first = Object.values(d.doc.sequences[d.seqId]!.clips).find(
			(c) => c.kind === 'video' && c.start === 0,
		)!;
		const sel = (await render(d, 'selection', { clipIds: [first.id] })).json() as {
			result: PreviewRenderResult;
		};
		expect(sel.result.rendered.map((x) => x.hash)).toEqual([segs[0]!.hash]);
		// In/Out limits the range
		await app.inject({
			method: 'POST',
			url: '/api/previews/delete',
			headers: JSON_H,
			payload: { all: true },
		});
		const ranged = (await render(d, 'all', { range: { start: 45, end: 50 } })).json() as {
			result: PreviewRenderResult;
		};
		expect(ranged.result.rendered.map((x) => x.hash)).toEqual([segs[1]!.hash]);
	}, 300_000);

	it('Render Audio writes float WAVs of the audio segments; Delete Render Files removes them', async () => {
		const d = await build();
		const segs = audioPreviewSegments(d.doc, d.seqId);
		expect(segs.length).toBeGreaterThan(0);
		const r = await render(d, 'audio');
		const job = r.json() as { state: string; result: PreviewRenderResult };
		expect(job.state).toBe('succeeded');
		expect(job.result.paths.mix).toBe(segs.length);
		const st = await status(
			[],
			segs.map((s) => s.hash),
		);
		expect(st.audio.sort()).toEqual(segs.map((s) => s.hash).sort());
		const wav = join(dirOf(), `${segs[0]!.hash}.wav`);
		const probe = spawnSync('ffprobe', [
			...['-v', 'error', '-show_entries', 'stream=codec_name,channels,sample_rate,duration_ts'],
			...['-of', 'json', wav],
		]);
		const s0 = (JSON.parse(probe.stdout.toString()) as { streams: Record<string, unknown>[] }).streams[0]!;
		expect(s0.codec_name).toBe('pcm_f32le');
		expect(s0.channels).toBe(2);
		expect(Number(s0.sample_rate)).toBe(48000);
		expect(Number(s0.duration_ts)).toBe((segs[0]!.frames * 48000) / 30);

		const del = await app.inject({
			method: 'POST',
			url: '/api/previews/delete',
			headers: JSON_H,
			payload: { hashes: [segs[0]!.hash] },
		});
		expect(del.json().deleted).toBe(1);
		expect(existsSync(wav)).toBe(false);
		expect((await status([], [segs[0]!.hash])).audio).toEqual([]);
	}, 300_000);

	it('skips segments with offline media (the file would keep the offline card after relinking)', async () => {
		const d = await build();
		const doc = structuredClone(d.doc) as ProjectDocument;
		for (const m of Object.values(doc.media))
			(m as { locators: unknown[] }).locators = [
				{ type: 'engine-store', engineId: 'local', key: 'mk_missing' },
			];
		d.doc = doc;
		await app.inject({
			method: 'POST',
			url: '/api/previews/delete',
			headers: JSON_H,
			payload: { all: true },
		});
		const job = (await render(d, 'all')).json() as { state: string; result: PreviewRenderResult };
		expect(job.state).toBe('succeeded');
		expect(job.result.rendered).toEqual([]);
		expect(job.result.skipped.length).toBe(2);
		expect(job.result.skipped[0]!.reason).toMatch(/offline/i);
	}, 300_000);

	it('a cancelled render leaves no files that look valid', async () => {
		const d = await build();
		await app.inject({
			method: 'POST',
			url: '/api/previews/delete',
			headers: JSON_H,
			payload: { all: true },
		});
		const start = await app.inject({
			method: 'POST',
			url: '/api/previews/render',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, mode: 'all' },
		});
		expect(start.statusCode, start.body).toBe(202);
		const id = start.json().id as string;
		const q = coreServices(app).queue;
		await new Promise((r) => setTimeout(r, 400));
		q.cancel(id);
		const done = await q.wait(id);
		expect(['cancelled', 'succeeded']).toContain(done.state);
		const names = existsSync(dirOf()) ? readdirSync(dirOf()) : [];
		expect(names.some((f) => f.includes('.part.'))).toBe(false);
		for (const n of names) expect(n).toMatch(/^[0-9a-f]{32}\.mp4$/);
	}, 300_000);
});

describe('Export ▸ Use Previews', () => {
	it('takes the rendered segments from their files and renders the rest; frame-exact, one encode', async () => {
		const d = await build();
		await app.inject({
			method: 'POST',
			url: '/api/previews/delete',
			headers: JSON_H,
			payload: { all: true },
		});
		const segs = previewSegments(d.doc, d.seqId);
		// render only the first segment
		const r = await render(d, 'all', { range: { start: 0, end: 40 } });
		expect((r.json() as { result: PreviewRenderResult }).result.rendered.map((x) => x.hash)).toEqual([
			segs[0]!.hash,
		]);
		const settings = {
			sequenceId: d.seqId,
			range: { type: 'entire' },
			container: 'mp4',
			video: {
				codec: 'h264',
				width: 1920,
				height: 1080,
				frameRate: { num: 30, den: 1 },
				scaling: 'fit',
				quality: { mode: 'crf', value: 18 },
				encoderSpeed: 'fast',
			},
			audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
			engine: 'auto',
			usePreviews: true,
		};
		const plan = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
		});
		const p = plan.json() as {
			warnings: { code: string; message: string }[];
			segments: { startFrame: number; endFrame: number }[];
		};
		expect(p.warnings.find((w) => w.code === 'USING_PREVIEWS')?.message).toMatch(/^40 of 60 frames/);
		expect(p.segments.map((x) => [x.startFrame, x.endFrame])).toEqual([
			[0, 40],
			[40, 60],
		]);
		// The export holds the preview files it reads (cache entries) for the job, like every other cached input.
		const acquired = vi.spyOn(coreServices(app).cache, 'acquireForJob');
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
		});
		expect(start.statusCode, start.body).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error).toBeUndefined();
		expect(
			acquired.mock.calls.some(([job, path]) => job === start.json().id && path.includes(segs[0]!.hash)),
		).toBe(true);
		acquired.mockRestore();
		const file = (await coreServices(app).exports.outputFile(start.json().id))!;
		const count = Number(
			spawnSync('ffprobe', [
				'-v',
				'error',
				'-count_frames',
				'-select_streams',
				'v:0',
				'-show_entries',
				'stream=nb_read_frames',
				'-of',
				'csv=p=0',
				file,
			])
				.stdout.toString()
				.trim(),
		);
		expect(count).toBe(60);
		for (const n of [0, 20, 39]) expect(frameCode(file, n)).toBe(n);
		// without previews of a different format nothing is used, and the plan says why
		const halfDoc = structuredClone(d.doc) as ProjectDocument;
		(halfDoc.sequences[d.seqId] as { previews?: unknown }).previews = {
			format: 'h264-iframe',
			size: 'half',
			quality: 'standard',
		};
		d.doc = halfDoc;
		const half = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
		});
		expect(
			(half.json() as { warnings: { code: string; message: string }[] }).warnings.find(
				(w) => w.code === 'PREVIEWS_UNUSED',
			)?.message,
		).toMatch(/half size/);
	}, 300_000);
});

describe('previews in the cache registry', () => {
	it('maps preview files to entries and partials to orphans', async () => {
		const root = '/x/appdir';
		const fmt = 'a'.repeat(16);
		const h = 'b'.repeat(32);
		expect(entryOfPath(root, `${root}/cache/previews/${fmt}/${h}.mp4`)).toEqual({
			id: `previews:${fmt}/${h}.mp4`,
			kind: 'previews',
			key: `${fmt}/${h}.mp4`,
		});
		expect(entryOfPath(root, `${root}/cache/previews/${fmt}/${h}.part.mp4`)).toBeNull();
		const d = await build();
		await render(d, 'effects');
		const scan = await scanAppdir(app.appdir);
		expect(scan.entries.some((e) => e.kind === 'previews')).toBe(true);
		const usage = await app.inject({ method: 'GET', url: '/api/cache', headers: JSON_H });
		expect(usage.statusCode, usage.body).toBe(200);
		expect(JSON.stringify(usage.json())).toContain('previews');
	}, 300_000);
});
