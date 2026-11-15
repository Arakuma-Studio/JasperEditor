// A crashing measurement worker fails the job, never hangs it (wp-note WP6.5b item 7): the engine is started with
// `JASPER_SD_MEASURE_WORKER` pointing at a worker that starts and then exits on its first request; a rebalance job
// fails with MEASURE_FAILED (retryable) and nothing is applied; the next job gets a new worker (and fails the same
// way), the engine keeps answering.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import { makeEnvelope, type ProjectDocument } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	editorCookie,
	makeApp,
	register,
	TEST_HOST,
	type TestApp,
} from './helpers.ts';
import { provenance, writeBedFixture } from './sound-bed-fixture.ts';

const HOST = { host: TEST_HOST };
const TOKEN = 'tok_crash_0123456789abcdef012';
const KEY = 'key_crash_0123456789abcdef012';
const EDITOR_H = { ...HOST, cookie: editorCookie(TOKEN, KEY) };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

let app: TestApp;
let doc: ProjectDocument;
let previous: string | undefined;

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'jasper-sd-crash-'));
	const worker = join(dir, 'crash-worker.mjs');
	writeFileSync(
		worker,
		[
			"import { parentPort } from 'node:worker_threads';",
			'parentPort.on("message", () => process.exit(3));',
			'parentPort.postMessage({ id: 0, ready: true });',
		].join('\n'),
	);
	previous = process.env.JASPER_SD_MEASURE_WORKER;
	process.env.JASPER_SD_MEASURE_WORKER = worker;
	app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
	const files = writeBedFixture(dir);
	const b = new DocBuilder('hd-1080p-30', 300);
	const auth = { authorization: `Bearer ${TOKEN}` };
	const music = b.addMedia(await register(app, files.music, auth));
	const hit = b.addMedia(await register(app, files.hit, auth));
	b.tx([
		{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
		{ type: 'media.setLibraryInfo', mediaId: hit, library: provenance('hit') },
		{ type: 'soundDesign.place', frame: 30, layers: [{ mediaId: hit, role: 'hero', align: 'peak' }] },
	]);
	doc = b.doc;
}, 180_000);
afterAll(async () => {
	await closeApps();
	if (previous === undefined) delete process.env.JASPER_SD_MEASURE_WORKER;
	else process.env.JASPER_SD_MEASURE_WORKER = previous;
});

function seed(n: number): string {
	const projectId = `prj_${(7700 + n).toString().padStart(16, '0')}`;
	const file = appdirPaths(app.appdir).projectFile(projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope(
				{ ...doc, projectId },
				{ revision: 3, savedAt: '2026-10-17T00:00:00.000Z', platform: 'test' },
			),
		),
	);
	return projectId;
}

describe('a crashing measurement worker', { timeout: 300_000 }, () => {
	it('fails the rebalance job with MEASURE_FAILED (retryable); nothing applied; the engine keeps working', async () => {
		for (const n of [1, 2]) {
			const projectId = seed(n);
			const r = await app.inject({
				method: 'POST',
				url: '/api/sound-design/rebalance',
				headers: json(EDITOR_H),
				payload: JSON.stringify({ projectId, mode: 'apply' }),
			});
			expect(r.statusCode, r.body).toBe(202);
			const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
			expect(job.state).toBe('failed');
			expect(job.error).toMatchObject({ code: 'MEASURE_FAILED', retryable: true });
			expect(job.error?.message).toMatch(/measurement worker stopped/);
			const q = await app.inject({
				method: 'POST',
				url: '/api/agent/query',
				headers: json(EDITOR_H),
				payload: JSON.stringify({ projectId, query: 'doc.get', args: {} }),
			});
			expect((q.json() as { revision: number }).revision).toBe(3);
		}
	});
});
