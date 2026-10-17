// Phase 5 verification, follow-ups (d) and (e): the last full Sound Check report per sequence outlives the job and the
// engine (`SoundCheckReportStore`, `POST /api/sound-design/check/last`, stale-marked against the live document), bounded
// and never crashing on a damaged file; and the visual route's sound-effects / bed peaks the sync strip draws.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type EngineJob,
	SoundCheckLastResponseSchema,
	type SoundCheckResult,
	SoundCheckResultSchema,
	SoundVisualResponseSchema,
} from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import { makeEnvelope, type ProjectDocument } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SoundCheckReportStore } from '../src/sound-design/report-store.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, makeApp, type TestApp } from './helpers.ts';
import { buildCheckDoc, type FixtureMedia, registerCheckMedia } from './sound-check-fixture.ts';

const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_kept_0123456789abcdef0123';
const KEY = 'key_kept_0123456789abcdef0123';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'kept-agent' };
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

let app: TestApp;
let appdir: string;
let media: FixtureMedia;
let projects = 0;

function seed(doc: ProjectDocument): string {
	const projectId = `prj_kept${(++projects).toString().padStart(12, '0')}`;
	const file = appdirPaths(appdir).projectFile(projectId);
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
const post = (url: string, body: unknown, headers: Record<string, string> = AGENT_H) =>
	app.inject({ method: 'POST', url, headers: json(headers), payload: JSON.stringify(body) });

/** A fake but schema-valid result (the store does not care what the report says). */
function fakeResult(projectId: string, sequenceId: string, pad = 0): SoundCheckResult {
	return SoundCheckResultSchema.parse({
		projectId,
		sequenceId,
		stored: false,
		revision: 1,
		report: {
			version: 1,
			projectId,
			sequenceId,
			revision: 1,
			mixHash: 'm',
			inputsHash: 'i',
			preset: { id: 'web', label: 'Web', integratedLufs: -14, truePeakDb: -1, source: 'x' },
			range: { start: 0, end: 30 },
			rangeTimecode: { start: '00:00:00:00', end: '00:00:01:00' },
			wholeSequence: true,
			fps: { num: 30, den: 1 },
			durationSec: 1,
			verdict: 'pass',
			counts: {},
			issues: [],
			events: [],
			listen: [],
			loudness: {
				integratedLufs: -14,
				truePeakDb: -1,
				samplePeakDb: -1,
				lra: 1,
				maxMomentaryLufs: -10,
				maxShortTermLufs: -12,
				measurable: true,
				normalization: { enabled: true, targetLufs: -14, truePeakDb: -1, gainDb: 0 },
				limiterMaxGrDb: 0,
				before: { integratedLufs: -14, truePeakDb: -1, samplePeakDb: -1 },
			},
			curves: {
				hopSec: 0.01,
				startSec: 0,
				points: pad,
				window: 'momentary',
				mix: new Array(pad).fill(-20),
				bed: [],
				sfx: [],
				music: [],
				dialogue: [],
				ambience: [],
				limiterGrDb: [],
			},
			speech: { seconds: 0, segments: [] },
			stems: {},
			warnings: [],
			timings: {},
		},
	});
}

beforeAll(async () => {
	appdir = mkdtempSync(join(tmpdir(), 'jasper-kept-appdir-'));
	app = await makeApp({ appdir, dev: false, token: TOKEN, editorKey: KEY });
	media = await registerCheckMedia(app, mkdtempSync(join(tmpdir(), 'jasper-kept-')), TOKEN);
}, 180_000);
afterAll(async () => {
	await closeApps();
});

describe('SoundCheckReportStore', () => {
	it('keeps the last report per sequence (the newer replaces it), bounded per project, atomic', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-kept-store-'));
		const logs: string[] = [];
		const store = new SoundCheckReportStore({
			projectDir: (pid) => join(dir, pid),
			perProject: 3,
			log: (m) => logs.push(m),
		});
		expect(await store.get('prj_a', 'seq_1')).toBeNull();
		expect(await store.save('prj_a', fakeResult('prj_a', 'seq_1'), 'job_1')).toBe(true);
		expect(await store.save('prj_a', fakeResult('prj_a', 'seq_1'), 'job_2')).toBe(true);
		expect((await store.get('prj_a', 'seq_1'))!.jobId).toBe('job_2');
		// at most 3 sequences: the least recently written goes
		for (const s of ['seq_2', 'seq_3', 'seq_4']) {
			await new Promise((r) => setTimeout(r, 15));
			expect(await store.save('prj_a', fakeResult('prj_a', s), `job_${s}`)).toBe(true);
		}
		const files = readdirSync(join(dir, 'prj_a', 'sound-check')).sort();
		expect(files).toEqual(['seq_2.json', 'seq_3.json', 'seq_4.json']);
		expect(await store.get('prj_a', 'seq_1')).toBeNull();
		// no temp files are left behind
		expect(files.every((f) => !f.startsWith('.'))).toBe(true);
		// a sequence id that is not a document id is never a file name
		expect(await store.save('prj_a', fakeResult('prj_a', '../evil'), 'job_x')).toBe(false);
		expect(await store.get('prj_a', '../evil')).toBeNull();
		// over the size bound: not kept, logged, never thrown
		const small = new SoundCheckReportStore({
			projectDir: (pid) => join(dir, pid),
			maxBytes: 2000,
			log: (m) => logs.push(m),
		});
		expect(await small.save('prj_b', fakeResult('prj_b', 'seq_1', 400), 'job_big')).toBe(false);
		expect(logs.some((l) => l.includes('not kept'))).toBe(true);
		expect(existsSync(join(dir, 'prj_b', 'sound-check', 'seq_1.json'))).toBe(false);
	});

	it('a damaged or foreign file is moved aside with a warning, never a crash', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-kept-store-'));
		const logs: string[] = [];
		const store = new SoundCheckReportStore({
			projectDir: (pid) => join(dir, pid),
			log: (m) => logs.push(m),
		});
		const folder = join(dir, 'prj_a', 'sound-check');
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, 'seq_1.json'), '{not json');
		expect(await store.get('prj_a', 'seq_1')).toBeNull();
		writeFileSync(
			join(folder, 'seq_2.json'),
			JSON.stringify({ version: 1, savedAt: 'x', jobId: null, result: {} }),
		);
		expect(await store.get('prj_a', 'seq_2')).toBeNull();
		// another sequence's report under this name
		await store.save('prj_a', fakeResult('prj_a', 'seq_3'), 'job_3');
		writeFileSync(
			join(folder, 'seq_4.json'),
			JSON.stringify({ version: 1, savedAt: 'x', jobId: null, result: fakeResult('prj_a', 'seq_3') }),
		);
		expect(await store.get('prj_a', 'seq_4')).toBeNull();
		const names = readdirSync(folder);
		expect(names.filter((n) => n.includes('.corrupt-'))).toHaveLength(3);
		expect(logs.filter((l) => l.includes('moved aside'))).toHaveLength(3);
		expect(await store.get('prj_a', 'seq_3')).not.toBeNull();
	});
});

describe('the last report on a real engine', { timeout: 600_000 }, () => {
	it('is kept per sequence, survives an engine restart, and is stale after an edit; 404 when never checked', async () => {
		const fx = buildCheckDoc(media);
		const projectId = seed(fx.doc());
		// never checked
		const none = await post('/api/sound-design/check/last', { projectId });
		expect(none.statusCode, none.body).toBe(404);
		expect((none.json() as { code: string }).code).toBe('SOUND_CHECK_NOT_FOUND');
		// a check (stored as the editor does)
		const r = await post('/api/sound-design/check', { projectId, store: true }, EDITOR_H);
		expect(r.statusCode, r.body).toBe(202);
		const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		const result = SoundCheckResultSchema.parse(job.result);
		const kept = SoundCheckLastResponseSchema.parse(
			(await post('/api/sound-design/check/last', { projectId })).json(),
		);
		expect(kept).toMatchObject({
			projectId,
			sequenceId: result.sequenceId,
			jobId: job.id,
			state: 'current',
			reasons: [],
		});
		expect(kept.result.report).toEqual(result.report);
		// the engine restarts on the same appdir and has forgotten the job (its journal keeps the newest 500 finished
		// jobs for 7 days: a busy session's stills push a check out): the report is still there
		await closeApps();
		rmSync(appdirPaths(appdir).jobsJournal, { force: true });
		app = await makeApp({ appdir, dev: false, token: TOKEN, editorKey: KEY });
		expect(coreServices(app).queue.get(job.id)).toBeFalsy();
		const after = SoundCheckLastResponseSchema.parse(
			(await post('/api/sound-design/check/last', { projectId, sequenceId: result.sequenceId })).json(),
		);
		expect(after).toMatchObject({ jobId: job.id, state: 'current' });
		expect(after.result.report.issues).toEqual(result.report.issues);
		// an edit of the mix: stale (mix); an unknown sequence: 404
		const tx = await post(
			'/api/agent/tx',
			{
				projectId,
				transaction: {
					label: 'Gain',
					origin: { agent: 'x' },
					commands: [{ type: 'audio.setGain', clipIds: [fx.ids.music], mode: 'adjust', db: 2 }],
				},
			},
			EDITOR_H,
		);
		expect(tx.statusCode, tx.body).toBe(200);
		const stale = SoundCheckLastResponseSchema.parse(
			(await post('/api/sound-design/check/last', { projectId })).json(),
		);
		expect(stale).toMatchObject({ state: 'stale', reasons: ['mix'] });
		const unknown = await post('/api/sound-design/check/last', { projectId, sequenceId: 'seq_nope' });
		expect(unknown.statusCode).toBe(404);
		// strict arguments
		const bad = await post('/api/sound-design/check/last', { projectId, extra: 1 });
		expect(bad.statusCode).toBe(400);
	});

	it('the visual route gives the sound-effects and bed peaks: the hit is in the sfx peaks, not in the bed', async () => {
		const fx = buildCheckDoc(media);
		const projectId = seed(fx.doc());
		const v = await post('/api/sound-design/visual', { projectId, range: { start: 0, end: 120 } });
		expect(v.statusCode, v.body).toBe(200);
		const vis = SoundVisualResponseSchema.parse(v.json());
		expect(vis.stemPeakDb).toBeDefined();
		const { sfx, bed } = vis.stemPeakDb!;
		expect(sfx).toHaveLength(vis.points);
		expect(bed).toHaveLength(vis.points);
		// the hit aligned at 1 s (hop 100): loud in the sfx peaks; the sfx stem is near silent before it
		const around = (a: number[], i: number) => Math.max(...a.slice(Math.max(0, i - 3), i + 4));
		expect(around(sfx, 100)).toBeGreaterThan(-30);
		expect(around(sfx, 100)).toBeGreaterThan(Math.max(...sfx.slice(40, 60)) + 20);
		// every mix peak is at least as loud as each stem's (the stems sum to the mix)
		for (let i = 0; i < vis.points; i += 10) {
			expect(vis.waveformPeakDb[i]! + 6.1).toBeGreaterThanOrEqual(Math.max(sfx[i]!, bed[i]!));
		}
	});
});
