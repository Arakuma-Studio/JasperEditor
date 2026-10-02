// Source ranges on the engine (M3, wp-m3-inpoint, S07:PRC-015…019): a processed range holds exactly the source
// frames it says (frame-coded fixture), the result carries the range, the media registry records it, a clip
// swapped onto the ranged version exports on the native path showing the same source frames as on the
// original (and back), and a source-range sidecar next to a file registered by path is reported.
import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob, ProcessResult, RegisteredMedia } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
	until,
} from './helpers.ts';

const H = { host: '127.0.0.1:47900' };
let app: TestApp;
let dir: string;

/** The burned-in 6-bit frame number of `fixtures/media/frame-code.mp4` (1920×1080) at one frame of a file. */
function frameCode(file: string, frame: number): number {
	const r = spawnSync('ffmpeg', [
		...['-v', 'error', '-i', file],
		...['-vf', `select=eq(n\\,${frame}),scale=1920:1080,format=rgb24,crop=420:1:40:70`],
		...['-frames:v', '1', '-f', 'rawvideo', '-'],
	]);
	let code = 0;
	for (let b = 0; b < 6; b++) if (r.stdout[(30 + 70 * b) * 3]! > 127) code |= 1 << b;
	return code;
}

function frameCount(file: string): number {
	const r = spawnSync(
		'ffprobe',
		[
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
		],
		{ encoding: 'utf8' },
	);
	return Number(r.stdout.trim());
}

async function waitJob(id: string, timeoutMs = 240_000): Promise<EngineJob> {
	return until(
		async () => {
			const j = (await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: H })).json() as EngineJob;
			return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : null;
		},
		timeoutMs,
		200,
	);
}

const exportSettings = (seqId: string) => ({
	sequenceId: seqId,
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
		colorTags: 'rec709',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine: 'native',
});

async function exportCodes(d: DocBuilder, frames: number[]): Promise<number[]> {
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: exportSettings(d.seqId) },
	});
	expect(start.statusCode).toBe(202);
	const done = await waitJob(start.json().id);
	expect(done.error).toBeUndefined();
	expect((done.result as { renderPath: string }).renderPath).toBe('native');
	const file = (await coreServices(app).exports.outputFile(start.json().id))!;
	return frames.map((f) => frameCode(file, f));
}

beforeAll(async () => {
	ensureFixtures();
	dir = mkdtempSync(join(tmpdir(), 'jasper-range-'));
	app = await makeApp({ totalSlots: 8 });
}, 60_000);

afterAll(async () => {
	await closeApps();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

let codedMedia: RegisteredMedia;
const coded = () => codedMedia;

describe('ranged processing (S07:PRC-015)', () => {
	let coded: RegisteredMedia;
	let res: ProcessResult;
	const steps = [{ op: 'deblock', filter: 'weak' }];

	it('processes exactly the source frames [12, 48): result range, registry record, frame-exact content', async () => {
		coded = await register(app, fixture('frame-code.mp4'));
		codedMedia = coded;
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${coded.mediaKey}/process`,
			headers: JSON_H,
			payload: { steps, executor: 'local', range: { startFrame: 12, endFrame: 48 } },
		});
		expect(r.statusCode).toBe(200);
		const job = await waitJob((r.json() as EngineJob).id);
		expect(job.error).toBeUndefined();
		expect(job.title).toContain('frames 12–47');
		res = job.result as ProcessResult;
		expect(res.range).toEqual({ startFrame: 12, endFrame: 48 });
		expect(res.registered.originalName).toBe('frame-code [Deblocked · frames 12–47].mov');
		const index = JSON.parse(readFileSync(join(app.appdir, 'engine', 'media-index.json'), 'utf8'));
		const rec = index.items[res.registered.mediaKey];
		expect(rec.derivedFrom).toMatchObject({
			mediaKey: coded.mediaKey,
			range: { startFrame: 12, endFrame: 48 },
		});
		const out = rec.storage.path as string;
		expect(frameCount(out)).toBe(36);
		expect([0, 1, 17, 35].map((i) => frameCode(out, i))).toEqual([12, 13, 29, 47]);
	}, 300_000);

	it('a clip swapped onto the ranged version exports the same source frames on the native path, and back', async () => {
		const d = new DocBuilder('hd-1080p-30', 23);
		const original = d.addMedia(coded);
		const placed = d.tx([
			{
				type: 'clip.place',
				source: { mediaId: original },
				at: 0,
				sourceRange: { in: { sourceFrames: 20 }, out: { sourceFrames: 40 } },
				matchSequence: 'keep',
				ref: '$c',
			},
		]);
		const clipId = placed.refs.$c!;
		const frames = [0, 1, 9, 19];
		const before = await exportCodes(d, frames);
		expect(before).toEqual([20, 21, 29, 39]);
		const reg = res.registered;
		const derived = d.tx([
			{
				type: 'media.derive',
				fromMediaId: original,
				recipe: { op: 'process', steps },
				asset: {
					fingerprint: reg.fingerprint,
					originalName: reg.originalName,
					sizeBytes: reg.sizeBytes,
					container: reg.container,
					probe: reg.probe,
					locators: [{ type: 'engine-store', engineId: 'local', key: reg.mediaKey }],
					recipeVersion: res.recipeVersion,
					recipeHash: res.recipeHash,
				},
				range: res.range,
				replaceInClips: [clipId],
				ref: '$p',
			},
		]);
		const clip = () =>
			d.doc.sequences[d.seqId]!.clips[clipId] as unknown as {
				mediaId: string;
				sourceIn: number;
				start: number;
			};
		expect(clip().mediaId).toBe(derived.refs.$p);
		expect(clip().sourceIn).toBe(8 * 23_520_000);
		expect(clip().start).toBe(0);
		const plan = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: exportSettings(d.seqId) },
		});
		expect(plan.json()).toMatchObject({ path: 'native', blockers: [] });
		expect(await exportCodes(d, frames)).toEqual(before);
		d.tx([{ type: 'clip.replaceSource', clipId, mediaId: original }]);
		expect(clip().sourceIn).toBe(20 * 23_520_000);
		expect(await exportCodes(d, frames)).toEqual(before);
	}, 300_000);
});

describe('source-range sidecars (S07:PRC-019)', () => {
	it('reports the sidecar next to a file registered by path (trailer grade format)', async () => {
		const file = join(dir, 'T02.mp4');
		copyFileSync(fixture('frame-code.mp4'), file);
		writeFileSync(
			join(dir, 'T02.json'),
			JSON.stringify({
				id: 'T02',
				frames: 64,
				first_src_frame: 174,
				handles: [0, 8],
				spec: { src: 'raw/crudo.mp4' },
			}),
		);
		const reg = await register(app, file);
		expect(reg.sourceHint).toEqual({
			sidecar: 'T02.json',
			sourceName: 'crudo.mp4',
			firstFrame: 174,
			frames: 64,
			frameRate: null,
			handles: [0, 8],
		});
		// No sidecar → no hint.
		const plain = await register(app, fixture('clip-b.mp4'));
		expect(plain.sourceHint).toBeUndefined();
	}, 60_000);
});

describe('discarding an uncommitted media (S07:PRC-018, Replace Footage cancelled)', () => {
	const del = (key: string) => app.inject({ method: 'DELETE', url: `/api/media/${key}`, headers: H });

	it('deletes an engine-managed copy no project uses: file, record and derivatives', async () => {
		const src = join(dir, 'discard-me.mp4');
		copyFileSync(fixture('clip-b.mp4'), src);
		writeFileSync(src, Buffer.concat([readFileSync(src), Buffer.from('discard')])); // unique bytes
		const r = await app.inject({
			method: 'POST',
			url: '/api/media/register',
			headers: JSON_H,
			payload: { projectId: 'prj_0000000000000001', paths: [src], copyIntoProject: true },
		});
		const reg = (r.json() as { items: RegisteredMedia[] }).items[0]!;
		const managed = join(app.appdir, 'media', reg.mediaKey);
		expect(existsSync(managed)).toBe(true);
		const res = await del(reg.mediaKey);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ deleted: true, reason: 'deleted' });
		expect(existsSync(managed)).toBe(false);
		expect(existsSync(src)).toBe(true); // the user's file is untouched
		expect(
			(await app.inject({ method: 'GET', url: `/api/media/${reg.mediaKey}`, headers: H })).statusCode,
		).toBe(404);
	}, 120_000);

	it("never deletes the user's own files, processed versions or media a stored project uses", async () => {
		const byPath = await register(app, fixture('clip-a.mp4'));
		expect((await del(byPath.mediaKey)).json()).toEqual({ deleted: false, reason: 'not-managed' });
		expect(existsSync(fixture('clip-a.mp4'))).toBe(true);
		const usedSrc = join(dir, 'used.mp4');
		writeFileSync(usedSrc, Buffer.concat([readFileSync(fixture('clip-b.mp4')), Buffer.from('used')]));
		const r = await app.inject({
			method: 'POST',
			url: '/api/media/register',
			headers: JSON_H,
			payload: { projectId: 'prj_0000000000000001', paths: [usedSrc], copyIntoProject: true },
		});
		const used = (r.json() as { items: RegisteredMedia[] }).items[0]!;
		const pdir = join(app.appdir, 'projects', 'prj_00000000000000UU');
		mkdirSync(pdir, { recursive: true });
		writeFileSync(
			join(pdir, 'project.jasper'),
			JSON.stringify({ format: 'jasper-project', key: used.mediaKey }),
		);
		expect((await del(used.mediaKey)).json()).toEqual({ deleted: false, reason: 'in-use' });
		expect(existsSync(join(app.appdir, 'media', used.mediaKey))).toBe(true);
		const res = await app.inject({
			method: 'POST',
			url: `/api/media/${coded().mediaKey}/process`,
			headers: JSON_H,
			payload: {
				steps: [{ op: 'deblock', filter: 'weak' }],
				executor: 'local',
				range: { startFrame: 12, endFrame: 48 },
			},
		});
		const job = await waitJob((res.json() as EngineJob).id);
		expect((await del((job.result as ProcessResult).registered.mediaKey)).json()).toEqual({
			deleted: false,
			reason: 'derived',
		});
	}, 300_000);
});
