import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectManagerResult } from '@jasper/api';
import { loadProject, makeEnvelope, type ProjectDocument } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
	TEST_FFPROBE,
	type TestApp,
} from './helpers.ts';

let app: TestApp;
const FFMPEG = TEST_FFMPEG;
const FFPROBE = TEST_FFPROBE;
const out = mkdtempSync(join(tmpdir(), 'jasper-pm-'));

beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 120_000);
afterAll(closeApps);

async function project(): Promise<DocBuilder> {
	const coded = await register(app, fixture('frame-code.mp4'));
	const other = await register(app, fixture('clip-b.mp4'));
	const d = new DocBuilder();
	const m = d.addMedia(coded);
	d.addMedia(other);
	d.tx([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at: 0,
			audio: false,
			sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 60 } },
		},
		{ type: 'sequence.create', name: 'Unused' },
	]);
	return d;
}

async function still(env: unknown, sequenceId: string, frame: number): Promise<string> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/stills',
		headers: JSON_H,
		payload: { envelope: env, sequenceId, frame },
	});
	expect(r.statusCode, r.body).toBe(202);
	const done = await coreServices(app).queue.wait(r.json().id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	const png = await app.inject({ method: 'GET', url: `/renders/${r.json().id}/output`, headers: H });
	const f = join(out, `s-${r.json().id}.png`);
	writeFileSync(f, png.rawPayload);
	return f;
}

/** The 6-bit frame number burnt into frame-code.mp4 (as smart-render.test.ts reads it). */
function frameCode(file: string): number {
	const r = spawnSync(FFMPEG, [
		'-v',
		'error',
		'-i',
		file,
		'-vf',
		'format=rgb24,crop=420:1:40:70',
		'-frames:v',
		'1',
		'-f',
		'rawvideo',
		'-',
	]);
	let code = 0;
	for (let b = 0; b < 6; b++) if (r.stdout[(30 + 70 * b) * 3]! > 127) code |= 1 << b;
	return code;
}

async function runPm(d: DocBuilder, options: Record<string, unknown>): Promise<ProjectManagerResult> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/project-manager',
		headers: JSON_H,
		payload: { envelope: d.envelope(), options },
	});
	expect(r.statusCode, r.body).toBe(202);
	const done = await coreServices(app).queue.wait(r.json().id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	return done.result as ProjectManagerResult;
}

describe('Project Manager', () => {
	it('estimates the disk space without writing', async () => {
		const d = await project();
		const r = await app.inject({
			method: 'POST',
			url: '/api/project-manager/plan',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				options: {
					destination: join(out, 'plan'),
					mode: 'consolidate',
					sequenceIds: [d.seqId],
					handlesFrames: 5,
				},
			},
		});
		expect(r.statusCode, r.body).toBe(200);
		const e = r.json();
		expect(e.droppedSequences).toBe(1);
		expect(e.droppedItems).toBe(1);
		expect(e.files).toHaveLength(1);
		expect(e.files[0].action).toBe('trim');
		expect(e.resultBytes).toBeLessThan(e.originalBytes);
		expect(existsSync(join(out, 'plan'))).toBe(false);
	});

	it('consolidates the used part with handles; the copy shows the same frames from its own file', async () => {
		const d = await project();
		const dest = join(out, 'consolidated');
		const res = await runPm(d, {
			destination: dest,
			mode: 'consolidate',
			sequenceIds: [d.seqId],
			handlesFrames: 5,
			projectName: 'Trimmed',
		});
		expect(res.droppedSequences).toBe(1);
		expect(res.droppedItems).toBe(1);
		expect(res.files).toHaveLength(1);
		expect(res.files[0]!.action).toBe('trim');
		const file = res.files[0]!.to!;
		const frames = Number(
			spawnSync(FFPROBE, [
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
		expect(frames).toBe(39); // source frames 25..63: 30 used + 5 handles before, the 4 frames the file has after
		expect(existsSync(res.projectFile)).toBe(true);
		const copy = loadProject(JSON.parse(readFileSync(res.projectFile, 'utf8'))).document as ProjectDocument;
		expect(copy.projectId).toBe(res.projectId);
		expect(Object.keys(copy.sequences)).toHaveLength(1);
		expect(Object.values(copy.items).filter((i) => i.kind === 'media')).toHaveLength(1);
		const seqId = Object.keys(copy.sequences)[0]!;
		const a = await still(d.envelope(), d.seqId, 12);
		const b = await still(
			makeEnvelope(copy, { revision: 1, savedAt: '2026-10-08T00:00:00Z', platform: 'test' }),
			seqId,
			12,
		);
		expect(frameCode(a)).toBe(42);
		expect(frameCode(b)).toBe(42);
		const g = await app.inject({ method: 'GET', url: `/api/projects/${res.projectId}`, headers: H });
		expect(g.statusCode).toBe(200);
	}, 300_000);

	it('collects whole files (same bytes) and refuses to overwrite an existing copy', async () => {
		const d = await project();
		const dest = join(out, 'collected');
		const res = await runPm(d, {
			destination: dest,
			mode: 'collect',
			excludeUnused: false,
			includePreviews: true,
		});
		expect(res.files.every((f) => f.action === 'copy')).toBe(true);
		expect(res.files).toHaveLength(2);
		for (const f of res.files) expect(statSync(f.to!).size).toBe(statSync(f.from!).size);
		const again = await app.inject({
			method: 'POST',
			url: '/api/project-manager',
			headers: JSON_H,
			payload: { envelope: d.envelope(), options: { destination: dest, mode: 'collect' } },
		});
		expect(again.statusCode).toBe(409);
		const rel = await app.inject({
			method: 'POST',
			url: '/api/project-manager',
			headers: JSON_H,
			payload: { envelope: d.envelope(), options: { destination: 'rel', mode: 'collect' } },
		});
		expect(rel.statusCode).toBe(400);
	}, 300_000);
});
