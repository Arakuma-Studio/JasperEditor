// Fix Transcript at the engine (spec 17 SC-055, SC-061…063, SC-073, SC-090; docs/wp-notes/script-correction.md
// "Fix job, API and MCP") with a fake speech scorer at the `SpeechService` boundary (deterministic log-probabilities
// per word): `POST /api/projects/:pid/sequences/:sid/transcript-fix` refusals (zod, no source, no transcript, no
// model, In–Out without marks), the dry run (no scoring, estimate), the proposal (groups, Maybe unselected, the patch
// report), accept (one transaction "Fix transcript: N fixes" remembering the rejected fixes), rejected fingerprints
// skipped / re-offered unselected, the reject listener, scope variants, the glossary source, refresh, cancellation,
// worker failure, a media whose audio is unavailable, E_LIMIT and dedupe. Invented English text only.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	type EngineJob,
	type EnvelopeJson,
	type SpeechScoreRequest,
	type SpeechScoreResult,
	type TranscriptFixResult,
	TranscriptFixResultSchema,
} from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	loadProject,
	makeEnvelope,
	type ProjectDocument,
	type Proposal,
} from '@jasper/project';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobError } from '../src/jobs/types.ts';
import { coreServices } from '../src/tools/services.ts';
import { transcriptFixAcceptExtension } from '../src/transcript-fix/run.ts';
import { closeApps, makeApp } from './helpers.ts';

const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_tfix_0123456789abcdef01234';
const KEY = 'key_tfix_0123456789abcdef01234';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'fix-agent' };
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });
const F = FLICKS_PER_SECOND;

type App = Awaited<ReturnType<typeof makeApp>>;
let app: App;

// ---------------------------------------------------------------------------------------------------------------
// The material: an invented script, and the recogniser's version of it (a join, a real error, a doubtful word, a
// right word the script words differently)

const SCRIPT = [
	'Welcome to Glimmerbox, the channel about editing.',
	'Today we test the timeline tools of Pixelforge.',
	'Here is a quick demo of the trim mode.',
	'Thanks for watching and see you soon.',
].join('\n');
const ASR = [
	'Welcome to glimmer box, the channel about editing.',
	'Today we tested the timeline tool of Pixelforge.',
	'Here is a quick demon of the trim mode.',
	'Thanks for watching and see you soon.',
];
/** Word log-probabilities of the fake scorer (default −1): what the audio "says". */
const LP: Record<string, number> = { demon: -6, demo: -1, test: -3, tested: -0.5, tool: -1, tools: -8 };
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Words 0.4 s long with 50 ms gaps; 1.5 s between sentences. Returns words and each sentence's [first, end) index. */
function asrWords() {
	const words: { text: string; start: number; end: number; confidence: number }[] = [];
	const sentences: Array<[number, number]> = [];
	let t = 0.5;
	for (const s of ASR) {
		const a = words.length;
		for (const w of s.split(' ')) {
			words.push({ text: w, start: Math.round(t * F), end: Math.round((t + 0.4) * F), confidence: 0.8 });
			t += 0.45;
		}
		sentences.push([a, words.length]);
		t += 1.5;
	}
	return { words, sentences, seconds: t + 1 };
}

const AUDIO = (key: string, seconds: number) => ({
	kind: 'audio' as const,
	fingerprint: `q1:${'7'.repeat(63)}${key.length % 10}`,
	originalName: 'voice.wav',
	sizeBytes: 1000,
	container: 'wav',
	probe: {
		durationFlicks: Math.round(seconds * F),
		startTimecode: null,
		streams: [
			{
				index: 0,
				type: 'audio' as const,
				codec: 'pcm_s16le',
				sampleRate: 48000,
				channels: 1,
				channelLayout: 'mono',
			},
		],
		rotationDegrees: 0 as const,
		hasAlpha: false,
		variableFrameRate: false,
	},
	locators: [{ type: 'engine-store' as const, engineId: 'local', key }],
	derivation: null,
	importedAt: '2026-10-27T00:00:00.000Z',
});

let projects = 0;
type Seeded = {
	projectId: string;
	seqId: string;
	file: string;
	doc: ProjectDocument;
	sentences: Array<[number, number]>;
};

/**
 * A saved project: one voice recording with its transcript on A1 (`clipSeconds`: only that much of it; default all),
 * the script attached unless `script: null`.
 */
function seed(o: { script?: string | null; clipSeconds?: number; inOut?: [number, number] } = {}): Seeded {
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Fix', preset: 'hd-1080p-30' });
	doc = { ...doc, projectId: `prj_T${(++projects).toString().padStart(15, '0')}` };
	const seqId = Object.keys(doc.sequences)[0]!;
	const { words, sentences, seconds } = asrWords();
	const clipSec = o.clipSeconds ?? seconds;
	const r = applyTransaction(
		doc,
		{
			label: 'seed',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'media.register', asset: AUDIO(`mk_voice${projects}`, seconds), ref: '$a' },
				{ type: 'transcript.create', mediaId: '$a', language: 'en', origin: 'whisper-local', words },
				{
					type: 'clip.place',
					source: { mediaId: '$a' },
					at: 0,
					tracks: { audio: 'A1' },
					video: false,
					audio: true,
					sourceRange: { in: { flicks: 0 }, out: { flicks: Math.round(clipSec * F) } },
				},
				...(o.script === null
					? []
					: [
							{
								type: 'cleanup.configure',
								sequenceId: seqId,
								script: { name: 'Script', text: o.script ?? SCRIPT },
							},
						]),
				...(o.inOut
					? [{ type: 'sequence.setInOut', sequenceId: seqId, in: o.inOut[0], out: o.inOut[1] }]
					: []),
			],
		},
		{ ids, now: () => '2026-10-27T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	doc = r.document;
	const file = appdirPaths(app.appdir).projectFile(doc.projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(makeEnvelope(doc, { revision: 3, savedAt: '2026-10-27T00:00:00.000Z', platform: 'test' })),
	);
	return { projectId: doc.projectId, seqId, file, doc, sentences };
}

const saved = (file: string) => loadProject(JSON.parse(readFileSync(file, 'utf8')) as EnvelopeJson).document;

// ---------------------------------------------------------------------------------------------------------------
// The fake scorer

type Fake = {
	calls: SpeechScoreRequest[];
	installed: boolean;
	mode: 'ok' | 'block' | 'fail' | 'offline';
	onScore?: (signal: AbortSignal) => void;
};
const fake: Fake = { calls: [], installed: true, mode: 'ok' };

const fakeSpeech = {
	models: {
		entries: [{ id: 'whisper-fake', multilingual: true }],
		entry: (id: string) => (id === 'whisper-fake' ? { id, multilingual: true } : null),
		defaultId: () => 'whisper-fake',
		installed: async () => fake.installed,
	},
	threads: () => 2,
	async score(
		req: SpeechScoreRequest,
		signal: AbortSignal,
		opts?: { onProgress?(f: number, s: string): void },
	): Promise<SpeechScoreResult> {
		fake.calls.push(req);
		fake.onScore?.(signal);
		if (fake.mode === 'fail')
			throw new JobError('SPEECH_SCORE_FAILED', 'jasper-speech crashed (exit 3)', false);
		if (fake.mode === 'offline')
			throw new JobError('MEDIA_OFFLINE', 'The media file is not available', false);
		if (fake.mode === 'block')
			await new Promise((_, reject) =>
				signal.addEventListener('abort', () => reject(new JobError('JOB_CANCELLED', 'Cancelled')), {
					once: true,
				}),
			);
		opts?.onProgress?.(0.5, 'Scoring');
		return {
			device: { encoder: 'cpu', decoder: 'cpu', label: 'CPU', threads: 2, fallbacks: [] },
			model: req.model ?? 'whisper-fake',
			windows: req.windows.map((w) => ({
				id: w.id,
				readings: w.readings.map((r) => {
					const step = (w.end - w.start) / r.words.length;
					const words = r.words.map((t, i) => ({
						text: t,
						tokens: 1,
						logprob: LP[norm(t)] ?? -1,
						probability: 0.9,
						start: Math.round(w.start + i * step),
						end: Math.round(w.start + (i + 1) * step),
					}));
					return {
						id: r.id,
						logprob: words.reduce((n, x) => n + x.logprob, 0),
						tokens: words.length + 1,
						words,
					};
				}),
			})),
			timings: {
				decodeMs: 100,
				loadMs: 900,
				scoreMs: 2000,
				encoderMs: 1500 * req.windows.length,
				decoderMs: 50 * req.windows.reduce((n, w) => n + w.readings.length, 0),
				encoderPasses: req.windows.length,
				decoderRuns: req.windows.length,
				readings: req.windows.reduce((n, w) => n + w.readings.length, 0),
				windowSec: 10,
			},
		};
	},
};

// ---------------------------------------------------------------------------------------------------------------

const post = (
	url: string,
	payload: unknown,
	headers: Record<string, string> = EDITOR_H as Record<string, string>,
) => app.inject({ method: 'POST', url, headers: json(headers), payload: payload as object });
const fixUrl = (s: Seeded) => `/api/projects/${s.projectId}/sequences/${s.seqId}/transcript-fix`;

async function runFix(
	s: Seeded,
	body: object,
	headers: Record<string, string> = EDITOR_H,
): Promise<{ job: EngineJob; result: TranscriptFixResult }> {
	const r = await post(fixUrl(s), body, headers);
	expect(r.statusCode, r.body).toBe(202);
	const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return { job, result: TranscriptFixResultSchema.parse(job.result) };
}

async function failedFix(s: Seeded, body: object) {
	const r = await post(fixUrl(s), body);
	expect(r.statusCode, r.body).toBe(202);
	return coreServices(app).queue.wait((r.json() as EngineJob).id);
}

async function proposal(s: Seeded, id: string): Promise<Proposal> {
	const r = await app.inject({
		method: 'GET',
		url: `/api/projects/${s.projectId}/proposals/${id}`,
		headers: EDITOR_H,
	});
	expect(r.statusCode, r.body).toBe(200);
	return (r.json() as { proposal: Proposal }).proposal;
}

const byLabel = (p: Proposal, prefix: string) => p.items.find((it) => it.label.startsWith(prefix));

beforeAll(async () => {
	app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
	app.jasper.services.speech = fakeSpeech;
});
afterAll(async () => closeApps());
beforeEach(() => {
	fake.calls = [];
	delete fake.onScore;
	fake.installed = true;
	fake.mode = 'ok';
});

describe('transcript-fix route refusals', () => {
	it('refuses unknown keys, bad enums and an unknown sequence at once', async () => {
		const s = seed();
		for (const body of [
			{ mode: 'propose', bogus: 1 },
			{ scope: 'everything' },
			{ sources: [] },
			{ sources: ['script', 'script'] },
		]) {
			const r = await post(fixUrl(s), body);
			expect(r.statusCode, JSON.stringify(body)).toBe(400);
		}
		const r = await post(`/api/projects/${s.projectId}/sequences/seq_nope/transcript-fix`, {});
		expect(r.statusCode).toBe(404);
		expect(r.json().details?.code ?? r.json().detail?.code ?? r.json().error?.details?.code).toBeDefined();
	});

	it('refuses without a source, a transcript, In–Out marks or (to propose) a speech model', async () => {
		const noScript = seed({ script: null });
		let r = await post(fixUrl(noScript), { mode: 'dryRun' });
		expect(r.statusCode, r.body).toBe(409);
		expect(r.body).toContain('E_NO_SOURCE');
		r = await post(fixUrl(seed()), { scope: 'inOut' });
		expect(r.statusCode, r.body).toBe(400);
		expect(r.body).toContain('E_INVALID_PARAM');
		const empty = seed({ clipSeconds: 0.2 }); // the clip plays no word
		r = await post(fixUrl(empty), { scope: 'used' });
		expect(r.statusCode, r.body).toBe(409);
		expect(r.body).toContain('E_NO_TRANSCRIPT');
		fake.installed = false;
		r = await post(fixUrl(seed()), { mode: 'propose' });
		expect(r.statusCode, r.body).toBe(409);
		expect(r.body).toContain('E_NO_SPEECH_MODEL');
		// the dry run still answers, saying why the audio check could not run
		const { result } = await runFix(seed(), { mode: 'dryRun' });
		expect(result.report.speech.model).toBeNull();
		expect(result.report.speech.problem).toMatch(/speech model/);
	});
});

describe('dry run', () => {
	it('aligns and finds candidates without scoring or storing anything, with an estimate', async () => {
		const s = seed();
		const { result } = await runFix(s, { mode: 'dryRun' });
		expect(fake.calls).toHaveLength(0);
		expect(result.proposalId).toBeNull();
		const rep = result.report;
		expect(rep.sourcesUsed).toEqual(['script']);
		expect(rep.perMedia).toHaveLength(1);
		expect(rep.perMedia[0]!.alignment!.alignedShare).toBeGreaterThan(0.7);
		expect(rep.candidates.byGroup.spelling).toBe(1); // glimmer box → Glimmerbox, no audio needed
		expect(rep.candidates.byGroup.pending).toBe(3); // tested, tool, demon: need the audio
		expect(rep.estimate).toMatchObject({ basis: 'reference', windows: expect.any(Number) });
		expect(rep.estimate!.seconds).toBeGreaterThan(0);
		expect(rep.estimate!.note).toMatch(/^≈/);
		expect(rep.decisions.find((d) => d.kind === 'join')).toMatchObject({ group: 'spelling', rule: 'join' });
		const list = await app.inject({
			method: 'GET',
			url: `/api/projects/${s.projectId}/proposals`,
			headers: EDITOR_H,
		});
		expect(list.json().proposals ?? []).toHaveLength(0);
	});
});

describe('propose, review, accept', () => {
	it('stores one proposal: fixes and spelling selected, Maybe unselected, kept candidates out', async () => {
		const s = seed();
		const { result } = await runFix(s, { mode: 'propose' });
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]!.mediaId).toBe(`mk_voice${projects}`); // the engine media key, not the project id
		expect(fake.calls[0]!.language).toBe('en');
		const rep = result.report;
		expect(rep.candidates.byGroup).toMatchObject({ fix: 1, spelling: 1, maybe: 1, keep: 1 });
		expect(rep.device).toMatchObject({ label: 'CPU' });
		expect(rep.patch.edits).toBe(3);
		expect(result.proposalId).toMatch(/^prp_/);
		const p = await proposal(s, result.proposalId!);
		expect(p.feature).toBe('transcript-correction');
		expect(p.items).toHaveLength(3);
		const demo = byLabel(p, 'demon')!;
		expect(demo.group).toBe('fix');
		expect(demo.selected).not.toBe(false);
		expect((demo.meta as { deltaTok: number }).deltaTok).toBeCloseTo(5);
		const maybe = byLabel(p, 'tested')!;
		expect(maybe.group).toBe('maybe');
		expect(maybe.selected).toBe(false);
		expect(byLabel(p, 'glimmer')!.group).toBe('spelling');
		expect(byLabel(p, 'tool')).toBeUndefined();
	});

	it('accept "all" applies the selected fixes in one step and remembers the rejected one; a re-run skips it', async () => {
		const s = seed();
		const { result } = await runFix(s, { mode: 'propose' });
		const p = await proposal(s, result.proposalId!);
		const join = byLabel(p, 'glimmer')!;
		let r = await post(`/api/projects/${s.projectId}/proposals/${p.id}/reject`, { itemIds: [join.id] });
		expect(r.statusCode, r.body).toBe(200);
		// a reject that leaves items to decide records nothing yet
		expect(saved(s.file).sequences[s.seqId]!.scriptFix).toBeUndefined();
		r = await post(`/api/projects/${s.projectId}/proposals/${p.id}/accept`, { itemIds: 'all' });
		expect(r.statusCode, r.body).toBe(200);
		expect(r.json().applied).toEqual([byLabel(p, 'demon')!.id]);
		const doc = saved(s.file);
		const words = Object.values(doc.transcripts)[0]!.words.map((w) => w.text);
		expect(words).toContain('demo');
		expect(words).not.toContain('demon');
		expect(words).toContain('tested'); // Maybe: left out of "all"
		expect(words).toContain('glimmer'); // rejected
		const fp = (join.meta as { fingerprint: string }).fingerprint;
		expect(doc.sequences[s.seqId]!.scriptFix?.rejected).toEqual([fp]);
		// the rejected fix is not offered again …
		const again = await runFix(s, { mode: 'dryRun' });
		expect(again.result.report.skipped.rejected).toBe(1);
		expect(again.result.report.decisions.find((d) => d.fingerprint === fp)).toBeUndefined();
		// … unless "Show rejected", unselected
		const shown = await runFix(s, { mode: 'propose', showRejected: true });
		const p2 = await proposal(s, shown.result.proposalId!);
		const back = p2.items.find((it) => (it.meta as { fingerprint: string }).fingerprint === fp)!;
		expect(back.selected).toBe(false);
	});

	it('an agent "all" never takes Maybe items; naming them does', async () => {
		const s = seed();
		const { result } = await runFix(s, { mode: 'propose' }, AGENT_H);
		const p = await proposal(s, result.proposalId!);
		const r = await post(
			`/api/projects/${s.projectId}/proposals/${p.id}/accept`,
			{ itemIds: 'all' },
			AGENT_H,
		);
		expect(r.statusCode, r.body).toBe(200);
		expect(r.json().applied).toHaveLength(2);
		const maybe = byLabel(p, 'tested')!;
		const r2 = await post(
			`/api/projects/${s.projectId}/proposals/${p.id}/accept`,
			{ itemIds: [maybe.id] },
			AGENT_H,
		);
		expect(r2.statusCode, r2.body).toBe(200);
		expect(Object.values(saved(s.file).transcripts)[0]!.words.map((w) => w.text)).toContain('test');
	});

	it('rejecting the last open items remembers them in one step', async () => {
		const s = seed();
		const { result } = await runFix(s, { mode: 'propose' });
		const r = await post(`/api/projects/${s.projectId}/proposals/${result.proposalId}/reject`, {
			itemIds: 'all',
		});
		expect(r.statusCode, r.body).toBe(200);
		expect(saved(s.file).sequences[s.seqId]!.scriptFix?.rejected).toHaveLength(3);
	});

	it('refresh re-plans a stale item for its media only', async () => {
		const s = seed();
		const { result } = await runFix(s, { mode: 'propose' });
		const p = await proposal(s, result.proposalId!);
		const demo = byLabel(p, 'demon')!;
		// the user capitalises the word by hand: same normalised words (same fingerprint), but `expect` no longer matches
		const env = JSON.parse(readFileSync(s.file, 'utf8')) as EnvelopeJson;
		const { document: doc } = loadProject(env);
		const t = Object.values(doc.transcripts)[0]!;
		const k = t.words.findIndex((w) => w.text === 'demon');
		const edited = applyTransaction(
			doc,
			{
				label: 'user edit',
				origin: 'user',
				commands: [
					{ type: 'transcript.editText', transcriptId: t.id, fromWord: k, toWord: k, text: 'Demon' },
				],
			},
			{
				ids: createCounterIdSource(900),
				now: () => '2026-10-27T01:00:00.000Z',
				revision: 3,
				registries: defaultRegistries(),
			},
		);
		expect(edited.result.ok).toBe(true);
		writeFileSync(
			s.file,
			JSON.stringify(
				makeEnvelope(edited.document, { revision: 4, savedAt: '2026-10-27T01:00:00.000Z', platform: 'test' }),
			),
		);
		fake.calls = [];
		const r = await post(`/api/projects/${s.projectId}/proposals/${p.id}/refresh`, { itemIds: 'stale' });
		expect(r.statusCode, r.body).toBe(200);
		const out = r.json() as { refreshed: string[]; dropped: string[]; proposal: Proposal };
		expect(out.refreshed).toEqual([demo.id]);
		// one audio check, of that recording's windows holding the item only
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]!.windows).toHaveLength(1);
		const again = out.proposal.items.find((it) => it.id === demo.id)!;
		expect(again.state).toBe('pending');
		const cmd = again.commands[0] as { edits: { expect: string[]; words: { text: string }[] }[] };
		expect(cmd.edits[0]!.expect).toEqual(['Demon']);
		expect(cmd.edits[0]!.words.map((w) => w.text)).toEqual(['Demo']);
	});
});

describe('scope, sources, failures', () => {
	it('scope "used" keeps only candidates the sequence plays; "inOut" those inside the marks', async () => {
		const { sentences, words } = asrWords();
		const end1 = words[sentences[1]![1] - 1]!.end / F + 0.6; // the clip ends after sentence 2
		const used = await runFix(seed({ clipSeconds: end1 }), { mode: 'dryRun', scope: 'used' });
		expect(used.result.report.skipped.scope).toBe(1); // demon is outside the clip
		expect(used.result.report.candidates.total).toBe(3);
		const s2 = words[sentences[2]![0]]!.start / F;
		const e2 = words[sentences[2]![1] - 1]!.end / F;
		const inOut = await runFix(seed({ inOut: [Math.floor(s2 * 30) - 3, Math.ceil(e2 * 30) + 3] }), {
			mode: 'dryRun',
			scope: 'inOut',
		});
		expect(inOut.result.report.candidates.total).toBe(1);
		expect(inOut.result.report.decisions[0]!.asr).toEqual(['demon']);
	});

	it('the personal glossary works without a script', async () => {
		const g = await post('/api/speech/glossary', { from: ['glimmer box'], to: 'Glimmerbox' });
		expect([200, 201]).toContain(g.statusCode);
		const { result } = await runFix(seed({ script: null }), { mode: 'propose', sources: ['glossary'] });
		expect(result.report.sourcesUsed).toEqual(['glossary']);
		expect(result.report.candidates.byKind.glossary).toBe(1);
		expect(result.itemCount).toBe(1);
		const id = (g.json() as { entry: { id: string } }).entry.id;
		const d = await app.inject({ method: 'DELETE', url: `/api/speech/glossary/${id}`, headers: EDITOR_H });
		expect(d.statusCode, d.body).toBe(200);
	});

	it('a worker failure fails the job with its code; an offline media leaves its candidates unscored', async () => {
		fake.mode = 'fail';
		const failed = await failedFix(seed(), { mode: 'propose' });
		expect(failed.state).toBe('failed');
		expect(failed.error?.code).toBe('SPEECH_SCORE_FAILED');
		fake.mode = 'offline';
		const { result } = await runFix(seed(), { mode: 'propose' });
		expect(result.report.perMedia[0]!.unscored?.code).toBe('MEDIA_OFFLINE');
		expect(result.report.candidates.byGroup).toMatchObject({ spelling: 1, keep: 3 });
		expect(result.report.warnings.map((w) => w.code)).toContain('W_UNSCORED');
		expect(result.itemCount).toBe(1);
	});

	it('cancelling stops the running audio check', async () => {
		fake.mode = 'block';
		const started = new Promise<AbortSignal>((resolve) => {
			fake.onScore = resolve;
		});
		const r = await post(fixUrl(seed()), { mode: 'propose' });
		const id = (r.json() as EngineJob).id;
		const q = coreServices(app).queue;
		const signal = await started;
		q.cancel(id);
		expect(signal.aborted).toBe(true);
		const done = await q.wait(id);
		expect(done.state).toBe('cancelled');
	});

	it('identical requests while the job runs return that job', async () => {
		fake.mode = 'block';
		const s = seed();
		const a = await post(fixUrl(s), { mode: 'propose' });
		const b = await post(fixUrl(s), { mode: 'propose' });
		const c = await post(fixUrl(s), { mode: 'propose', strictness: 'careful' });
		expect((a.json() as EngineJob).id).toBe((b.json() as EngineJob).id);
		expect((c.json() as EngineJob).id).not.toBe((a.json() as EngineJob).id);
		const q = coreServices(app).queue;
		for (const r of [a, c]) q.cancel((r.json() as EngineJob).id);
		for (const r of [a, c]) await q.wait((r.json() as EngineJob).id);
	});

	it('E_LIMIT from the aligner is the job error', async () => {
		const huge = Array.from({ length: 60_010 }, () => 'a').join(' ');
		const failed = await failedFix(seed({ script: huge }), { mode: 'dryRun' });
		expect(failed.state).toBe('failed');
		expect(failed.error?.code).toBe('E_LIMIT');
	});

	it('a measured run makes the next estimate "measured"', async () => {
		await runFix(seed(), { mode: 'propose' });
		const { result } = await runFix(seed(), { mode: 'dryRun' });
		expect(result.report.estimate?.basis).toBe('measured');
	});
});

describe('accept extension', () => {
	it('labels the step "Fix transcript: N fixes" and remembers rejected fixes not remembered yet', async () => {
		const s = seed();
		const { result } = await runFix(s, { mode: 'propose' });
		const p = await proposal(s, result.proposalId!);
		const [a, b, c] = p.items;
		const states = { ...p, items: [{ ...a!, state: 'rejected' as const }, b!, c!] };
		const out = transcriptFixAcceptExtension({ doc: s.doc, proposal: states, itemIds: [b!.id] });
		expect(out.label).toBe('Fix transcript: 1 fix');
		expect(out.commands).toEqual([
			{
				type: 'scriptFix.configure',
				sequenceId: s.seqId,
				reject: [(a!.meta as { fingerprint: string }).fingerprint],
			},
		]);
		const two = transcriptFixAcceptExtension({ doc: s.doc, proposal: p, itemIds: [b!.id, c!.id] });
		expect(two).toEqual({ label: 'Fix transcript: 2 fixes', commands: [] });
	});
});
