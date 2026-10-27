// Fix Transcript end to end with REAL Whisper models (spec 17 SC-090, SC-103/104 at the engine; gated like
// speech-model.e2e: the models in JASPER_SPEECH_MODELS_DIR or target/speech-models, or SPEECH_E2E=1, which downloads
// them through the engine's pinned, verified catalogue).
//
// On the public-domain LJ fixture (fixtures/speech/lj-composite.flac): the engine transcribes it; the project gets
// that transcript with 10 words corrupted by typical confusions ("block" → "black") and the TRUE text attached as the
// script. The `transcript-fix` job (propose) must offer exactly the corrections, each decided by the audio, with the
// script word's times within 100 ms of the true word's; accepting applies them (transcript words restored); the same
// accept transaction applied in an editor session is undone exactly. A second project with the true transcript and a
// corrupted script must offer nothing.
// `TRANSCRIPT_FIX_BENCH=1` (run under the bench lock) also measures the whole job per speech minute with the largest
// installed model (`FIX_BENCH` lines; SC-037 integration figure in the wp-note).
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	type EngineJob,
	mediaRegisterCommand,
	type RegisteredMedia,
	type TranscriptFixResult,
	TranscriptFixResultSchema,
	type TranscriptionResult,
} from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import {
	applyTransaction,
	cleanupNorm,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	loadProject,
	makeEnvelope,
	type ProjectDocument,
	type Proposal,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/processing/models.ts';
import { SpeechModelStore } from '../src/speech/models.ts';
import { coreServices } from '../src/tools/services.ts';
import { transcriptFixAcceptExtension } from '../src/transcript-fix/run.ts';
import { closeApps, JSON_H, makeApp, ROOT, register, type TestApp, until } from './helpers.ts';

const CACHE = process.env.JASPER_SPEECH_MODELS_DIR ?? join(ROOT, 'target', 'speech-models');
const store = new SpeechModelStore(CACHE, loadCatalog({}).speech);
const MODEL = 'whisper-tiny.en';
const enabled = process.env.SPEECH_E2E === '1' || (await store.installed(store.entry(MODEL)!));
const TURBO = 'whisper-large-v3-turbo';
const BENCH = process.env.TRANSCRIPT_FIX_BENCH === '1';
const benchModel = (await store.installed(store.entry(TURBO)!)) ? TURBO : MODEL;
const MODELS = [...new Set([MODEL, ...(BENCH ? [benchModel] : [])])];

const FIXTURE = join(ROOT, 'fixtures', 'speech', 'lj-composite.flac');
type Truth = { utterances: Array<{ text: string; start: number; end: number }>; durationSeconds: number };
const truth = JSON.parse(readFileSync(FIXTURE.replace(/\.flac$/, '.json'), 'utf8')) as Truth;
const SPEECH_MINUTES = truth.utterances.reduce((n, u) => n + (u.end - u.start), 0) / 60;
const H = { host: '127.0.0.1:47900' };
const F = FLICKS_PER_SECOND;

/** Typical recognition confusions of words of the fixture (the same list as speech-score.e2e). */
const CONFUSIONS: Array<[string, string]> = [
	['block', 'black'],
	['prisoners', 'prisons'],
	['slept', 'slapped'],
	['wall', 'war'],
	['egg', 'leg'],
	['carton', 'cartoon'],
	['topic', 'tropic'],
	['yeast', 'east'],
	['stock', 'stack'],
	['forged', 'forget'],
];

type Word = { text: string; start: number; end: number; confidence: number | null };
let app: TestApp;
let reg: RegisteredMedia;
const transcripts = new Map<string, Word[]>();

async function waitJob(id: string, timeoutMs = 900_000): Promise<EngineJob> {
	return until(
		async () => {
			const j = (await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: H })).json() as EngineJob;
			return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : null;
		},
		timeoutMs,
		200,
	);
}

function swapWord(text: string, to: string): string {
	return text.replace(/[A-Za-z']+/, (m) => (m[0] === m[0]!.toUpperCase() ? to[0]!.toUpperCase() + to.slice(1) : to));
}

/** The transcript with the confusions applied (first occurrence of each), and the corrupted indices. */
function corrupt(words: Word[]): { words: Word[]; at: Map<number, [string, string]> } {
	const at = new Map<number, [string, string]>();
	const out = words.map((w) => ({ ...w }));
	for (const pair of CONFUSIONS) {
		const i = words.findIndex((w) => cleanupNorm(w.text) === pair[0]);
		if (i < 0) continue;
		at.set(i, pair);
		out[i] = { ...out[i]!, text: swapWord(out[i]!.text, pair[1]) };
	}
	return { words: out, at };
}

/** The script: the words' text, a line per sentence. */
function scriptOf(words: Word[]): string {
	return words
		.map((w) => w.text)
		.join(' ')
		.replace(/([.!?]) /g, '$1\n');
}

let projects = 0;
/** A saved project: the media on A1 with `words` as its transcript (made by `model`) and `script` attached. */
function seed(words: Word[], script: string, model = MODEL) {
	const ids = createCounterIdSource(11);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Fix e2e', preset: 'hd-1080p-30' });
	doc = { ...doc, projectId: `prj_E${(++projects).toString().padStart(15, '0')}` };
	const seqId = Object.keys(doc.sequences)[0]!;
	const r = applyTransaction(
		doc,
		{
			label: 'seed',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				mediaRegisterCommand(reg, '$a', '$ai', 'lj'),
				{ type: 'transcript.create', mediaId: '$a', language: 'en', origin: 'whisper-local', words },
				{ type: 'clip.place', source: { mediaId: '$a' }, at: 0, tracks: { audio: 'A1' }, video: false, audio: true },
				{ type: 'cleanup.configure', sequenceId: seqId, script: { name: 'Script', text: script } },
			] as never[],
		},
		{ ids, now: () => '2026-10-27T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	doc = r.document;
	// the model that made the transcript scores it (transcript.create takes no model: set as transcription does)
	doc = {
		...doc,
		transcripts: Object.fromEntries(Object.entries(doc.transcripts).map(([k, t]) => [k, { ...t, model }])),
	};
	const file = appdirPaths(app.appdir).projectFile(doc.projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(makeEnvelope(doc, { revision: 3, savedAt: '2026-10-27T00:00:00.000Z', platform: 'test' })),
	);
	return { projectId: doc.projectId, seqId, file, doc };
}

async function fix(s: ReturnType<typeof seed>): Promise<TranscriptFixResult> {
	const r = await app.inject({
		method: 'POST',
		url: `/api/projects/${s.projectId}/sequences/${s.seqId}/transcript-fix`,
		headers: JSON_H,
		payload: { mode: 'propose', device: 'cpu', sources: ['script'] },
	});
	expect(r.statusCode, r.body).toBe(202);
	const done = await waitJob((r.json() as EngineJob).id);
	expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
	return TranscriptFixResultSchema.parse(done.result);
}

describe.skipIf(!enabled)('Fix Transcript with a real Whisper model (spec 17 SC-090)', () => {
	beforeAll(async () => {
		if (!(await store.installed(store.entry(MODEL)!))) await store.install(MODEL);
		app = await makeApp({ totalSlots: 8 });
		const dir = join(app.appdir, 'models', 'speech');
		mkdirSync(dir, { recursive: true });
		for (const id of MODELS) if (!existsSync(join(dir, id))) symlinkSync(join(CACHE, id), join(dir, id), 'dir');
		reg = await register(app, FIXTURE);
		for (const m of MODELS) {
			const r = await app.inject({
				method: 'POST',
				url: `/api/media/${reg.mediaKey}/transcribe`,
				headers: JSON_H,
				payload: { model: m, language: 'en', device: 'cpu' },
			});
			expect(r.statusCode, r.body).toBe(202);
			const done = await waitJob((r.json() as EngineJob).id);
			expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
			transcripts.set(
				m,
				(done.result as TranscriptionResult).words.map((w) => ({
					text: w.text,
					start: w.start,
					end: w.end,
					confidence: w.confidence ?? null,
				})),
			);
		}
	}, 1_800_000);

	afterAll(async () => {
		await closeApps();
	});

	it('a corrupted transcript with the true text as the script: exactly the corrections, accepted, undone', async () => {
		const truthWords = transcripts.get(MODEL)!;
		const { words, at } = corrupt(truthWords);
		expect(at.size).toBeGreaterThanOrEqual(8);
		const s = seed(words, scriptOf(truthWords));
		const res = await fix(s);
		const rep = res.report;
		console.log(
			`FIX_E2E ${JSON.stringify({ model: MODEL, corrupted: at.size, byGroup: rep.candidates.byGroup, skipped: rep.skipped, alignedShare: rep.perMedia[0]!.alignment?.alignedShare, timings: rep.timings })}`,
		);
		expect(rep.device).toMatchObject({ encoder: 'cpu', decoder: 'cpu' });
		expect(res.proposalId).toBeTruthy();
		const p = (
			(await app.inject({ method: 'GET', url: `/api/projects/${s.projectId}/proposals/${res.proposalId}`, headers: H })).json() as {
				proposal: Proposal;
			}
		).proposal;
		// every item restores one corrupted word, none touches anything else
		const restored = new Set<number>();
		for (const it of p.items) {
			const m = it.meta as { asr: string[]; group: string; deltaTok: number | null };
			const cmd = it.commands[0] as { edits: { expect: string[]; words: Word[] }[] };
			const e = cmd.edits[0]!;
			expect(m.group, it.label).toBe('fix');
			expect(e.expect).toHaveLength(1);
			const idx = [...at.keys()].find((i) => words[i]!.text === e.expect[0] && !restored.has(i));
			expect(idx, `${it.label} is not one of the corruptions`).toBeDefined();
			restored.add(idx!);
			expect(e.words.map((w) => w.text)).toEqual([truthWords[idx!]!.text]);
			const t = truthWords[idx!]!;
			expect(Math.abs(e.words[0]!.start - t.start) / F, `${it.label} start`).toBeLessThanOrEqual(0.1);
			expect(Math.abs(e.words[0]!.end - t.end) / F, `${it.label} end`).toBeLessThanOrEqual(0.1);
			expect(e.words[0]!.confidence).toBeGreaterThan(0);
		}
		expect(restored.size).toBe(at.size);
		// accept: the transcript is the true one again
		const before = loadProject(JSON.parse(readFileSync(s.file, 'utf8'))).document;
		const acc = await app.inject({
			method: 'POST',
			url: `/api/projects/${s.projectId}/proposals/${p.id}/accept`,
			headers: JSON_H,
			payload: { itemIds: 'all' },
		});
		expect(acc.statusCode, acc.body).toBe(200);
		const after = loadProject(JSON.parse(readFileSync(s.file, 'utf8'))).document;
		expect(Object.values(after.transcripts)[0]!.words.map((w) => w.text)).toEqual(truthWords.map((w) => w.text));
		// the same accept in an editor session is ONE undo step that restores the document exactly
		const ids = createCounterIdSource(500);
		const session = new EditorSession({
			projectId: before.projectId,
			document: before,
			ctx: { ids, now: () => '2026-10-27T10:00:00.000Z', registries: defaultRegistries() },
		});
		const ext = transcriptFixAcceptExtension({ doc: before, proposal: p, itemIds: p.items.map((i) => i.id) });
		const committed = structuredClone(session.getCommitted());
		const r = session.apply({
			label: ext.label,
			origin: 'user',
			sequenceId: s.seqId,
			commands: [...p.items.flatMap((i) => i.commands), ...ext.commands] as never[],
		});
		expect(r.ok, JSON.stringify(r)).toBe(true);
		expect(ext.label).toBe(`Fix transcript: ${p.items.length} fixes`);
		expect(Object.values(session.getCommitted().transcripts)[0]!.words.map((w) => w.text)).toEqual(
			truthWords.map((w) => w.text),
		);
		expect(session.undo().ok).toBe(true);
		expect(session.getCommitted()).toEqual(committed);
	}, 900_000);

	it('the true transcript with a corrupted script: nothing is applied', async () => {
		const truthWords = transcripts.get(MODEL)!;
		const { words: corrupted } = corrupt(truthWords);
		const s = seed(truthWords, scriptOf(corrupted));
		const res = await fix(s);
		console.log(`FIX_E2E_SCRIPT ${JSON.stringify({ byGroup: res.report.candidates.byGroup })}`);
		expect(res.report.candidates.total).toBeGreaterThanOrEqual(8);
		expect(res.report.candidates.byGroup.fix ?? 0).toBe(0);
		expect(res.report.candidates.byGroup.spelling ?? 0).toBe(0);
		expect(res.proposalId === null || res.itemCount === (res.report.candidates.byGroup.maybe ?? 0)).toBe(true);
	}, 900_000);

	it.skipIf(!BENCH)('cost per speech minute (SC-037, whole job)', async () => {
		const truthWords = transcripts.get(benchModel)!;
		const { words } = corrupt(truthWords);
		const runs: number[] = [];
		let last: TranscriptFixResult | null = null;
		for (let k = 0; k < 3; k++) {
			const s = seed(words, scriptOf(truthWords), benchModel);
			const t0 = Date.now();
			last = await fix(s);
			runs.push((Date.now() - t0) / 1000);
		}
		runs.sort((a, b) => a - b);
		const median = runs[1]!;
		console.log(
			`FIX_BENCH ${JSON.stringify({
				model: benchModel,
				runsSec: runs,
				medianSec: median,
				speechMinutes: Math.round(SPEECH_MINUTES * 1000) / 1000,
				perSpeechMinuteSec: Math.round((median / SPEECH_MINUTES) * 10) / 10,
				windows: last!.report.perMedia[0]!.windows,
				readings: last!.report.perMedia[0]!.readings,
				timings: last!.report.timings,
				device: last!.report.device,
				slots: coreServices(app).queue.totalSlots,
			})}`,
		);
	}, 1_800_000);
});
