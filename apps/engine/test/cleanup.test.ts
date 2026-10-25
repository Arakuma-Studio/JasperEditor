// The `cleanup-analysis` job and the cleanup preset library (spec 14; docs/wp-notes/transcript-cleanup.md "Engine"):
// the engine's analysis of a sequence equals the pure `analyzeSequenceCleanup` over the pure voice analysis of the
// same samples; voice analyses are computed once and then read from the cache; media without one can be planned in
// word mode; refusals become job errors; presets are stored atomically, survive a restart, keep unreadable entries
// aside, and feed the analysis.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type CleanupAnalysisJobResult,
	CleanupAnalysisFileSchema,
	CleanupAnalysisJobResultSchema,
	CleanupPresetLibraryResponseSchema,
	type EngineJob,
} from '@jasper/api';
import { encodeWav, voiceFeatures } from '@jasper/audio-dsp';
import { analyzeSequenceCleanup, buildVoiceAnalysis, CleanupPresetSchema } from '@jasper/project';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeApps, DocBuilder, H, JSON_H, makeApp, register, TEST_FFMPEG, type TestApp } from './helpers.ts';

const HAVE_FFMPEG = spawnSync(TEST_FFMPEG, ['-version'], { encoding: 'utf8' }).status === 0;
const SR = 16_000;
const FPS = 705_600_000;
const PROJECT = 'prj_0000000000000001';

let dir = '';
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'jasper-cleanup-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(closeApps);

/** Voiced-tone "words" over a −64 dBFS floor; the second sentence repeats the first (a retake) after a pause. */
function recording(seed = 3) {
	let s = seed >>> 0 || 1;
	const rnd = () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 2 ** 32;
	};
	const sentences = [
		'hoy vamos a crear un juego',
		'hoy vamos a crear un juego de carreras',
		'eh',
		'primero diseñé la carretera',
	];
	const words: Array<{ text: string; start: number; end: number; confidence: number }> = [];
	const spans: Array<[number, number]> = [];
	let t = 0.8;
	for (const line of sentences) {
		for (const w of line.split(' ')) {
			const d = Math.min(0.5, 0.12 + 0.05 * w.length);
			spans.push([t, t + d]);
			words.push({ text: w, start: Math.round((t + 0.02) * FPS), end: Math.round((t + d + 0.03) * FPS), confidence: 0.9 });
			t += d + 0.05;
		}
		t += 1.2;
	}
	const n = Math.round((t + 1) * SR);
	const x = new Float32Array(n);
	for (let i = 0; i < n; i++) x[i] = (rnd() * 2 - 1) * 0.0011;
	for (const [a, b] of spans) {
		const i0 = Math.round(a * SR);
		const i1 = Math.round(b * SR);
		for (let i = i0; i < i1 + 0.2 * SR && i < n; i++) {
			const env = i < i0 + 320 ? (i - i0) / 320 : i < i1 ? 1 : Math.exp(-(i - i1) / (0.07 * SR));
			let v = 0;
			for (let k = 1; k <= 8; k++) v += Math.sin((2 * Math.PI * 140 * k * (i - i0)) / SR) / k;
			x[i]! += 0.06 * env * v;
		}
	}
	return { x, words };
}

async function analyze(app: TestApp, body: unknown, wait = true) {
	return app.inject({
		method: 'POST',
		url: `/api/cleanup/analyze${wait ? '?wait=1' : ''}`,
		headers: JSON_H,
		payload: JSON.stringify(body),
	});
}

function resultOf(job: EngineJob): CleanupAnalysisJobResult {
	expect(job.kind).toBe('cleanup-analysis');
	expect(job.state).toBe('succeeded');
	return CleanupAnalysisJobResultSchema.parse(job.result);
}

async function sequenceWith(app: TestApp, name: string) {
	const rec = recording();
	const f = join(dir, name);
	writeFileSync(f, encodeWav([rec.x], SR, 'f32'));
	const m = await register(app, f);
	const b = new DocBuilder();
	const mediaId = b.addMedia(m);
	b.tx([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { audio: ['A1'] }, mode: 'overwrite' }]);
	b.tx([{ type: 'transcript.create', mediaId, language: 'es', origin: 'manual', words: rec.words }]);
	return { rec, m, b, mediaId };
}

describe.skipIf(!HAVE_FFMPEG)('cleanup-analysis job', () => {
	it('equals the pure analysis of the same samples; voice analysis computed once, then cached', async () => {
		const app = await makeApp();
		const { rec, m, b, mediaId } = await sequenceWith(app, 'talk.wav');
		const r = await analyze(app, { projectId: PROJECT, document: b.envelope() });
		expect(r.statusCode).toBe(200);
		const res = resultOf(r.json() as EngineJob);
		expect(res.voice).toEqual({ cached: [], analysed: [mediaId], missing: [] });
		expect(res.findings).toBeGreaterThan(0);
		expect(res.byKind.retake ?? res.byKind.restart).toBeGreaterThan(0);
		const g = await app.inject({ method: 'GET', url: res.url, headers: H });
		expect(g.statusCode).toBe(200);
		const file = CleanupAnalysisFileSchema.parse(g.json());
		expect(file.analysisId).toBe(res.analysisId);
		expect(file.revision).toBe(-1);
		const voice = buildVoiceAnalysis({
			fingerprint: m.fingerprint,
			stream: 0,
			samples: rec.x.length,
			planes: voiceFeatures(rec.x),
		});
		const doc = b.doc;
		const pure = analyzeSequenceCleanup({ doc, seq: doc.sequences[b.seqId]!, voice: () => voice });
		expect(file.analysis).toEqual(JSON.parse(JSON.stringify(pure)));
		expect(res.stats).toEqual(file.analysis.plan.stats);
		// again: the voice analysis comes from the cache
		const again = resultOf((await analyze(app, { projectId: PROJECT, document: b.envelope() })).json() as EngineJob);
		expect(again.voice.cached).toEqual([mediaId]);
		expect(again.voice.analysed).toEqual([]);
	});

	it('plans media without a voice analysis in word mode when asked not to analyse', async () => {
		const app = await makeApp();
		const { b, mediaId } = await sequenceWith(app, 'talk2.wav');
		const res = resultOf(
			(await analyze(app, { projectId: PROJECT, document: b.envelope(), analyzeVoice: false })).json() as EngineJob,
		);
		expect(res.voice.missing).toEqual([{ mediaId, reason: expect.stringContaining('no voice analysis') }]);
		const file = CleanupAnalysisFileSchema.parse((await app.inject({ method: 'GET', url: res.url, headers: H })).json());
		expect(file.analysis.media[0]!.edgeMode).toBe('word');
		expect(file.analysis.media[0]!.voice).toBe(false);
	});

	it('refuses bad requests and unknown sequences; unknown analyses are 404', async () => {
		const app = await makeApp();
		const { b } = await sequenceWith(app, 'talk3.wav');
		expect((await analyze(app, { projectId: PROJECT, bogus: 1 })).statusCode).toBe(400);
		const bad = await analyze(app, { projectId: PROJECT, document: b.envelope(), sequenceId: 'seq_nope' });
		expect(bad.statusCode).toBe(422);
		expect(bad.json()).toMatchObject({ code: 'SEQUENCE_NOT_FOUND' });
		const missing = await app.inject({ method: 'GET', url: '/api/cleanup/analyses/cla_nope', headers: H });
		expect(missing.statusCode).toBe(404);
		expect(missing.json()).toMatchObject({ code: 'CLEANUP_ANALYSIS_NOT_FOUND' });
	});
});

describe('cleanup presets', () => {
	it('creates, lists, updates and deletes user presets; built-ins are read-only; survives a restart', async () => {
		const app = await makeApp();
		const list0 = CleanupPresetLibraryResponseSchema.parse(
			(await app.inject({ method: 'GET', url: '/api/cleanup-presets', headers: H })).json(),
		);
		expect(list0).toEqual({ revision: 0, presets: [] });
		const c = await app.inject({
			method: 'POST',
			url: '/api/cleanup-presets',
			headers: JSON_H,
			payload: { name: 'Mi estilo', basedOn: 'builtin.fast', settings: { gaps: { maxGapS: 0.2 } } },
		});
		expect(c.statusCode).toBe(201);
		const p = CleanupPresetSchema.parse(c.json());
		expect(p.id).toMatch(/^cup_[0-9A-Z]{16}$/);
		const u = await app.inject({
			method: 'PUT',
			url: `/api/cleanup-presets/${p.id}`,
			headers: JSON_H,
			payload: { name: 'Mi estilo 2' },
		});
		expect(u.json().name).toBe('Mi estilo 2');
		expect(u.json().settings).toEqual({ gaps: { maxGapS: 0.2 } });
		const ro = await app.inject({ method: 'PUT', url: '/api/cleanup-presets/builtin.fast', headers: JSON_H, payload: { name: 'x' } });
		expect(ro.statusCode).toBe(404);
		const bad = await app.inject({
			method: 'POST',
			url: '/api/cleanup-presets',
			headers: JSON_H,
			payload: { name: 'x', settings: { gaps: { maxGapS: -1 } } },
		});
		expect(bad.statusCode).toBe(400);
		const file = join(app.appdir, 'presets', 'cleanup-presets.json');
		expect(JSON.parse(readFileSync(file, 'utf8')).revision).toBe(2);
		await closeApps();
		const app2 = await makeApp({ appdir: app.appdir });
		const list = CleanupPresetLibraryResponseSchema.parse(
			(await app2.inject({ method: 'GET', url: '/api/cleanup-presets', headers: H })).json(),
		);
		expect(list.presets.map((x) => x.name)).toEqual(['Mi estilo 2']);
		const d = await app2.inject({ method: 'DELETE', url: `/api/cleanup-presets/${p.id}`, headers: H });
		expect(d.json()).toEqual({ ok: true, removed: p.id });
		expect((await app2.inject({ method: 'GET', url: '/api/cleanup-presets', headers: H })).json().presets).toEqual([]);
	});

	it('keeps unreadable entries aside and moves an unreadable file away', async () => {
		const app0 = await makeApp();
		const appdir = app0.appdir;
		await closeApps();
		const file = join(appdir, 'presets', 'cleanup-presets.json');
		mkdirSync(join(appdir, 'presets'), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({
				format: 'jasper-cleanup-preset-library',
				version: 1,
				revision: 4,
				presets: [
					{ id: 'cup_AAAAAAAAAAAAAAAA', name: 'ok', settings: {} },
					{ id: 'cup_BBBBBBBBBBBBBBBB', name: 'bad', settings: { gaps: { maxGapS: 'x' } } },
				],
			}),
		);
		const app = await makeApp({ appdir });
		const list = (await app.inject({ method: 'GET', url: '/api/cleanup-presets', headers: H })).json();
		expect(list.revision).toBe(4);
		expect(list.presets.map((x: { name: string }) => x.name)).toEqual(['ok']);
		await app.inject({ method: 'POST', url: '/api/cleanup-presets', headers: JSON_H, payload: { name: 'n', settings: {} } });
		const saved = JSON.parse(readFileSync(file, 'utf8'));
		expect(saved.invalid).toHaveLength(1);
		await closeApps();
		writeFileSync(file, '{not json');
		const app3 = await makeApp({ appdir });
		expect((await app3.inject({ method: 'GET', url: '/api/cleanup-presets', headers: H })).json().presets).toEqual([]);
		expect(readdirSync(join(appdir, 'presets')).some((f) => f.startsWith('cleanup-presets.json.corrupt-'))).toBe(true);
		expect(existsSync(file)).toBe(false);
	});

	it.skipIf(!HAVE_FFMPEG)('a user preset drives the analysis', async () => {
		const app = await makeApp();
		const { b } = await sequenceWith(app, 'talk4.wav');
		const p = (
			await app.inject({
				method: 'POST',
				url: '/api/cleanup-presets',
				headers: JSON_H,
				payload: { name: 'calm', basedOn: 'builtin.natural', settings: { joins: { fadeMs: 7 } } },
			})
		).json();
		const res = resultOf((await analyze(app, { projectId: PROJECT, document: b.envelope(), presetId: p.id })).json() as EngineJob);
		const file = CleanupAnalysisFileSchema.parse((await app.inject({ method: 'GET', url: res.url, headers: H })).json());
		expect(file.analysis.settings.joins.fadeMs).toBe(7);
		expect(file.analysis.settings.edges.mode).toBe('speech');
		const nope = await analyze(app, { projectId: PROJECT, document: b.envelope(), presetId: 'cup_ZZZZZZZZZZZZZZZZ' });
		expect(nope.statusCode).toBe(422);
		expect(nope.json()).toMatchObject({ code: 'PRESET_NOT_FOUND' });
	});
});
