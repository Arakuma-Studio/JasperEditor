// Apply Style and Style Check at the engine (spec 15 EA-012, EA-013, EA-041): `POST /api/projects/:id/style/apply`
// (dry run: per-stage counts, missing roles, export cost, nothing stored; propose: an `apply-style` job — a real
// cleanup analysis child job, subtitles, kits with whooshes from a real indexed kit, punch-ins, Ken Burns — storing
// ONE proposal of feature `edit-automation`), an agent's accept as ONE transaction, the export planner's route equal
// to the dry run's cost class, Reroll through the refresher, refusals, the embedded-feature policy, and Style Check.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	type ApplyStyleResult,
	ApplyStyleResultSchema,
	type EngineJob,
	type EnvelopeJson,
	ProposalRefreshResponseSchema,
	StyleCheckResponseSchema,
} from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	loadProject,
	type MediaAsset,
	makeEnvelope,
	type ProjectDocument,
	type Proposal,
	projectStyleRecipes,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planExport } from '../src/export/planner.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, editorCookie, makeApp, TEST_HOST, tempAppdir } from './helpers.ts';
import { PACK, writeWav } from './sound-fixtures.ts';

const ENV_KEYS = [
	'JASPER_SOUND_STARTER_DIR',
	'JASPER_SOUND_SYNTH_VARIANTS',
	'JASPER_SOUND_AUTO_INDEX',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const HOST = { host: TEST_HOST };
const TOKEN = 'tok_styl_0123456789abcdef012345';
const KEY = 'key_styl_0123456789abcdef012345';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'style-agent' };
const EDITOR_H = { ...HOST, cookie: editorCookie(TOKEN, KEY) };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

type App = Awaited<ReturnType<typeof makeApp>>;
let app: App;

function makeKit(dir: string): string {
	const files: [string, 'whoosh' | 'hit', number, string][] = [
		['whoosh_a.wav', 'whoosh', 0.5, 'Air whoosh'],
		['whoosh_b.wav', 'whoosh', 0.7, 'Fast whoosh'],
		['whoosh_c.wav', 'whoosh', 1.2, 'Long whoosh'],
	];
	files.forEach(([file, shape, sec], i) => {
		writeWav(join(dir, file), shape, sec, i + 1);
	});
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			version: 1,
			packs: [PACK],
			sounds: files.map(([file, , , title]) => ({
				file,
				title,
				types: ['whoosh'],
				tags: ['test'],
				author: 'Test Author',
				license: 'CC0-1.0',
				sourceUrl: 'https://example.invalid/sounds',
				packId: PACK.id,
			})),
		}),
	);
	return dir;
}

let fp = 0;
/** A camera file with picture and sound (probe only: not in the engine store, so the voice is planned at word timings). */
function camera(seconds: number): Omit<MediaAsset, 'id'> {
	fp++;
	return {
		kind: 'video',
		fingerprint: `q1:${(0xabc000 + fp).toString(16).padStart(64, '0')}`,
		originalName: `cam-${fp}.mp4`,
		sizeBytes: 1000,
		container: 'mov,mp4',
		probe: {
			durationFlicks: Math.round(seconds * FLICKS_PER_SECOND),
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: 'h264',
					width: 1920,
					height: 1080,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: 30, den: 1 },
					pixelFormat: 'yuv420p',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
					browserDecodable: true,
				},
				{ index: 1, type: 'audio', codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo' },
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: `mk_cam${fp}` }],
		derivation: null,
		importedAt: '2026-10-26T00:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
}

let projects = 0;
/**
 * A saved talking-head edit: jump cuts of `lengths` frames from one camera file (picture + sound), a transcript with
 * a word every 12 frames of source and a 1.2 s pause in the middle of every other clip (the cleanup cuts it).
 */
function seed(lengths: number[]) {
	const ids = createCounterIdSource(5);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Style', preset: 'hd-1080p-30' });
	doc = { ...doc, projectId: `prj_S${(++projects).toString().padStart(15, '0')}` };
	const seqId = Object.keys(doc.sequences)[0]!;
	const F = flicksPerFrame(doc.sequences[seqId]!.settings.frameRate);
	const words: { text: string; start: number; end: number }[] = [];
	let src = 0;
	const places: Record<string, unknown>[] = [];
	let at = 0;
	lengths.forEach((len, i) => {
		const pause =
			i % 2 === 0 && len >= 90 ? { from: Math.floor(len / 2) - 18, to: Math.floor(len / 2) + 18 } : null;
		for (let f = 0; f + 9 <= len; f += 12) {
			if (pause && f + 9 > pause.from && f < pause.to) continue;
			words.push({
				text: words.length % 7 === 6 ? '¡genial!' : `palabra${words.length}`,
				start: (src + f) * F,
				end: (src + f + 9) * F,
			});
		}
		places.push({
			type: 'clip.place',
			source: { mediaId: '$cam' },
			at,
			tracks: { video: 'V1', audio: 'A1' },
			sourceRange: { in: { flicks: src * F }, out: { flicks: (src + len) * F } },
		});
		at += len;
		src += len + 30;
	});
	const r = applyTransaction(
		doc,
		{
			label: 'seed',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'media.register', asset: camera(3600), ref: '$cam' },
				{ type: 'transcript.create', mediaId: '$cam', language: 'es', origin: 'manual', words },
				...places,
			],
		},
		{ ids, now: () => '2026-10-26T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	doc = r.document;
	const file = appdirPaths(app.appdir).projectFile(doc.projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(makeEnvelope(doc, { revision: 3, savedAt: '2026-10-26T00:00:00.000Z', platform: 'test' })),
	);
	return { projectId: doc.projectId, seqId, total: at, file };
}

/** The user's own edit of the saved project (headless), as the next revision. */
function userEdit(file: string, seqId: string, commands: unknown[]) {
	const env = JSON.parse(readFileSync(file, 'utf8')) as EnvelopeJson;
	const { document: doc } = loadProject(env);
	const r = applyTransaction(
		doc,
		{ label: 'user edit', origin: 'user', sequenceId: seqId, commands },
		{
			ids: createCounterIdSource(900),
			now: () => '2026-10-26T01:00:00.000Z',
			revision: env.revision,
			registries: defaultRegistries(),
		},
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope(r.document, {
				revision: env.revision + 1,
				savedAt: '2026-10-26T01:00:00.000Z',
				platform: 'test',
			}),
		),
	);
}

const post = (u: string, body: unknown, headers: Record<string, string> = AGENT_H) =>
	app.inject({ method: 'POST', url: u, headers: json(headers), payload: JSON.stringify(body) });
const styleUrl = (projectId: string, what: 'apply' | 'check') => `/api/projects/${projectId}/style/${what}`;

async function savedDoc(projectId: string): Promise<{ doc: ProjectDocument; revision: number }> {
	const r = await post('/api/agent/query', { projectId, query: 'doc.get', args: {} }, EDITOR_H);
	const b = r.json() as { result: ProjectDocument; revision: number };
	return { doc: b.result, revision: b.revision };
}
async function proposeStyle(
	projectId: string,
	body: unknown,
	headers: Record<string, string> = AGENT_H,
): Promise<ApplyStyleResult> {
	const r = await post(styleUrl(projectId, 'apply'), body, headers);
	expect(r.statusCode, r.body).toBe(202);
	const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	expect(job.kind).toBe('apply-style');
	return ApplyStyleResultSchema.parse(job.result);
}
async function getProposal(projectId: string, id: string): Promise<Proposal> {
	const r = await app.inject({
		method: 'GET',
		url: `/api/projects/${projectId}/proposals/${id}`,
		headers: AGENT_H,
	});
	expect(r.statusCode, r.body).toBe(200);
	return (r.json() as { proposal: Proposal }).proposal;
}

const CAPS = { native: true, remotionLocal: 'ready' as const, fframes: 'ready' as const, mgMasters: true };
async function exportPath(doc: ProjectDocument, seqId: string) {
	const core = coreServices(app);
	const plan = await planExport(
		{
			envelope: makeEnvelope(doc, {
				revision: 1,
				savedAt: '2026-10-26T00:00:00.000Z',
				platform: 'test',
			}) as never,
			sequenceId: seqId,
			settings: {
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
				},
				audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
				engine: 'auto',
			} as never,
		},
		{
			registry: core.registry,
			fonts: core.fonts,
			capabilities: CAPS,
			extensions: core.exports.nativeExtensions.all(),
		},
	);
	return plan.plan;
}

const LENGTHS = [150, 90, 180, 120, 150, 210, 90, 160];

describe('Apply Style (real engine, indexed kit, cleanup analysis)', { timeout: 600_000 }, () => {
	beforeAll(async () => {
		process.env.JASPER_SOUND_STARTER_DIR = makeKit(tempAppdir('jasper-style-kit-'));
		process.env.JASPER_SOUND_SYNTH_VARIANTS = '1';
		process.env.JASPER_SOUND_AUTO_INDEX = '0';
		app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
		const r = await post('/api/sounds/index', {}, EDITOR_H);
		expect(r.statusCode, r.body).toBe(202);
		const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	}, 600_000);
	afterAll(async () => {
		await closeApps();
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
	});

	it('dry run: every stage reported (cleanup cuts, subtitles, kits with whooshes, missing roles), nothing stored', async () => {
		const { projectId, seqId } = seed(LENGTHS);
		const before = await savedDoc(projectId);
		const r = await post(styleUrl(projectId, 'apply'), {
			sequenceId: seqId,
			mode: 'dryRun',
			recipeId: 'builtin:fast-long-form',
			seed: 2,
		});
		expect(r.statusCode, r.body).toBe(200);
		const d = ApplyStyleResultSchema.parse(r.json());
		const by = Object.fromEntries(d.stages.map((s) => [s.stage, s]));
		expect(by.cleanup).toMatchObject({ status: 'planned' });
		expect(by.cleanup!.count).toBeGreaterThan(0);
		expect(by.cleanup!.warnings.map((w) => w.code)).toContain('W_VOICE_NOT_ANALYSED');
		expect(by.subtitles).toMatchObject({ status: 'planned', cost: 'hybrid' });
		expect(by['decorate-cuts']).toMatchObject({ status: 'planned', cost: 'remotion' });
		expect(by['decorate-cuts']!.sfx).toMatchObject({ type: 'whoosh' });
		expect(by['decorate-cuts']!.sfx!.available).toBeGreaterThan(0);
		expect(by.music).toMatchObject({ status: 'skipped' });
		expect(by.music!.reason).toMatch(/no bin named “Music”/);
		expect(d.warnings.map((w) => w.code)).toContain('W_ROLE_MISSING');
		expect(d.cost).toBe('remotion');
		expect(d.proposalId).toBeNull();
		expect(d.budget.fits).toBe(true);
		const after = await savedDoc(projectId);
		expect(after.revision).toBe(before.revision);
		const list = await app.inject({
			method: 'GET',
			url: `/api/projects/${projectId}/proposals`,
			headers: AGENT_H,
		});
		expect((list.json() as { proposals: unknown[] }).proposals).toEqual([]);
	});

	it('propose → ONE proposal; an agent accepts it as ONE transaction; the export route is the dry run’s cost class', async () => {
		const { projectId, seqId, total } = seed(LENGTHS);
		const res = await proposeStyle(projectId, {
			sequenceId: seqId,
			recipeId: 'builtin:fast-long-form',
			seed: 2,
		});
		expect(res.proposalId).toBeTruthy();
		expect(res.invalid).toEqual([]);
		const p = await getProposal(projectId, res.proposalId!);
		expect(p.feature).toBe('edit-automation');
		expect(p.title).toBe('Apply Style: Fast Long-form');
		const groups = new Set(p.items.map((it) => (it.meta as { group?: string }).group).filter(Boolean));
		expect([...groups]).toEqual(
			expect.arrayContaining(['cleanup', 'subtitles', 'cut-kits', 'punch-ins', 'ken-burns']),
		);
		const before = await savedDoc(projectId);
		const acc = await post(`/api/projects/${projectId}/proposals/${p.id}/accept`, { itemIds: 'all' });
		expect(acc.statusCode, acc.body).toBe(200);
		const after = await savedDoc(projectId);
		expect(after.revision).toBe(before.revision + 1);
		const seq = after.doc.sequences[seqId]!;
		const v1 = seq.videoTracks[0]!.id;
		const aroll = Object.values(seq.clips).filter((c) => c.trackId === v1);
		const end = Math.max(...aroll.map((c) => c.start + c.duration));
		expect(end).toBeLessThan(total);
		expect(Object.keys((seq as { captionGroups?: object }).captionGroups ?? {})).toHaveLength(1);
		expect(seq.videoTracks.map((t) => t.name)).toEqual(expect.arrayContaining(['FX', 'Subtitles']));
		expect(projectStyleRecipes(after.doc).active).toBe('builtin:fast-long-form');
		expect((await exportPath(after.doc, seqId)).path).toBe(res.cost);
		// Style Check on the result: kits on target, dead air unmeasured (no voice analysis of these files)
		const ck = await post(styleUrl(projectId, 'check'), { sequenceId: seqId });
		expect(ck.statusCode, ck.body).toBe(200);
		const c = StyleCheckResponseSchema.parse(ck.json());
		const m = Object.fromEntries(c.metrics.map((x) => [x.id, x]));
		expect(c.recipe.id).toBe('builtin:fast-long-form');
		// every planned kit is found on its cut (a cut close to another one lies under that one's kit: covered too)
		const kits = res.stages.find((x) => x.stage === 'decorate-cuts')!;
		expect(m.kitCoverage!.count).toBeGreaterThanOrEqual(kits.count);
		expect(m.kitCoverage!.of).toBe(kits.summary!.considered);
		expect(m.subtitleOnCut!.status).not.toBe('unchecked');
		expect(m.deadAirPerMinute!.status).toBe('unmeasured');
	});

	it('Reroll of a decoration re-plans it through the Apply Style refresher; a stale cleanup means run it again', async () => {
		const { projectId, seqId } = seed(LENGTHS);
		const res = await proposeStyle(
			projectId,
			{ sequenceId: seqId, recipeId: 'builtin:fast-long-form', seed: 3, passes: { subtitles: false } },
			EDITOR_H,
		);
		const p = await getProposal(projectId, res.proposalId!);
		const kit = p.items.find((it) => (it.meta as { kind?: string }).kind === 'kit')!;
		const seed0 = (kit.meta as { seed: number }).seed;
		const rr = await post(
			`/api/projects/${projectId}/proposals/${p.id}/refresh`,
			{ itemIds: [kit.id], reroll: true },
			EDITOR_H,
		);
		expect(rr.statusCode, rr.body).toBe(200);
		const out = ProposalRefreshResponseSchema.parse(rr.json());
		const k2 = out.proposal.items.find((it) => it.id === kit.id)!;
		expect(k2.state).toBe('pending');
		expect((k2.meta as { seed: number }).seed).toBe(seed0 + 1);
		const rc = await post(
			`/api/projects/${projectId}/proposals/${p.id}/refresh`,
			{ itemIds: ['cleanup'] },
			EDITOR_H,
		);
		expect(rc.statusCode, rc.body).toBe(200);
		const c = ProposalRefreshResponseSchema.parse(rc.json()).proposal.items.find(
			(it) => it.id === 'cleanup',
		)!;
		expect(c.state).toBe('invalid');
		expect(c.reason).toMatch(/Apply Style again/);
	});

	it('refusals: unknown recipe, no active recipe, newer recipe, bad stage names, unknown sequence', async () => {
		const { projectId, seqId } = seed([90, 90, 90]);
		const unknown = await post(styleUrl(projectId, 'apply'), {
			mode: 'dryRun',
			recipeId: 'rcp_0000000000000000',
		});
		expect(unknown.statusCode).toBe(404);
		const none = await post(styleUrl(projectId, 'apply'), { mode: 'dryRun' });
		expect(none.statusCode).toBe(400);
		expect(none.body).toMatch(/active recipe/);
		const newer = await post(styleUrl(projectId, 'apply'), {
			mode: 'dryRun',
			recipe: { format: 'jasper-style-recipe', version: 4, id: 'rcp_0000000000000001', name: 'x' },
		});
		expect(newer.statusCode).toBe(409);
		const bad = await post(styleUrl(projectId, 'apply'), {
			mode: 'dryRun',
			recipeId: 'builtin:clean',
			passes: { nope: true },
		});
		expect(bad.statusCode).toBe(400);
		const seq = await post(styleUrl(projectId, 'apply'), {
			mode: 'dryRun',
			recipeId: 'builtin:clean',
			sequenceId: 'seq_0000000000000099',
		});
		expect(seq.statusCode).toBe(404);
		const ok = await post(styleUrl(projectId, 'check'), {
			sequenceId: seqId,
			recipeId: 'builtin:clean',
			deadAir: false,
		});
		expect(ok.statusCode, ok.body).toBe(200);
	});

	it('an agent may not accept a combined proposal whose cleanup the project keeps for the user', async () => {
		const { projectId, seqId, file } = seed(LENGTHS);
		const res = await proposeStyle(projectId, {
			sequenceId: seqId,
			recipeId: 'builtin:clean',
			passes: { subtitles: false },
		});
		expect(res.proposalId).toBeTruthy();
		userEdit(file, seqId, [
			{ type: 'project.updateSettings', settings: { agentProposals: { 'transcript-cleanup': false } } },
		]);
		const acc = await post(`/api/projects/${projectId}/proposals/${res.proposalId}/accept`, {
			itemIds: 'all',
		});
		expect(acc.statusCode).toBe(403);
		expect(acc.body).toMatch(/transcript cleanup/);
	});
});
