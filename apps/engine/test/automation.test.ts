// Editing automation at the engine (spec 15 EA-020…EA-022, EA-031…EA-033, EA-041): `POST
// /api/projects/:projectId/automation/:pass` — the dry run (nothing stored), the `edit-automation` job storing a
// proposal of feature `edit-automation` with the kits' whooshes placed through the sound-design system (a real indexed
// kit), an agent's accept as ONE transaction (kits on a new FX track, each whoosh exactly as long as its kit and centred
// on the cut), refusals, Refresh proposal / Reroll through the built-in refresher, punch-ins and Ken Burns as native
// Motion keys, and the export planner's route for each (kits: the Remotion path naming the effect; Motion keys: native).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	type AutomationPassResult,
	AutomationPassResultSchema,
	type EngineJob,
	type EnvelopeJson,
	ProposalRefreshResponseSchema,
} from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import {
	type AdjustmentClip,
	type AudioClip,
	applyTransaction,
	type ClipSfx,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	flicksPerFrame,
	loadProject,
	makeEnvelope,
	type ProjectDocument,
	type Proposal,
	soundCuesOf,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planExport } from '../src/export/planner.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, editorCookie, makeApp, TEST_HOST, tempAppdir } from './helpers.ts';
import { asset } from './sound-design-fixture.ts';
import { PACK, writeWav } from './sound-fixtures.ts';

const ENV_KEYS = [
	'JASPER_SOUND_STARTER_DIR',
	'JASPER_SOUND_SYNTH_VARIANTS',
	'JASPER_SOUND_AUTO_INDEX',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const HOST = { host: TEST_HOST };
const TOKEN = 'tok_auto_0123456789abcdef01234';
const KEY = 'key_auto_0123456789abcdef01234';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'auto-agent' };
const EDITOR_H = { ...HOST, cookie: editorCookie(TOKEN, KEY) };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

type App = Awaited<ReturnType<typeof makeApp>>;
let app: App;

/** Whooshes of several lengths (the ranking fits their run-up to the kit's) and a hit. */
function makeKit(dir: string): string {
	const files: [string, 'hit' | 'whoosh', number, string, string[]][] = [
		['whoosh_a.wav', 'whoosh', 0.5, 'Air whoosh', ['whoosh']],
		['whoosh_b.wav', 'whoosh', 0.7, 'Fast whoosh', ['whoosh']],
		['whoosh_c.wav', 'whoosh', 0.9, 'Wide whoosh', ['whoosh']],
		['whoosh_d.wav', 'whoosh', 1.2, 'Long whoosh', ['whoosh']],
		['hit_a.wav', 'hit', 0.5, 'Punch hit', ['hit']],
	];
	files.forEach(([file, shape, sec], i) => {
		writeWav(join(dir, file), shape, sec, i + 1);
	});
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			version: 1,
			packs: [PACK],
			sounds: files.map(([file, , , title, types]) => ({
				file,
				title,
				types,
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

let projects = 0;
/** A saved project (revision 3): V1 an A-roll of fake video clips of `lengths` frames alternating two sources. */
function seed(lengths: number[], preset = 'hd-1080p-30') {
	const ids = createCounterIdSource(5);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Automation', preset });
	doc = { ...doc, projectId: `prj_A${(++projects).toString().padStart(15, '0')}` };
	const seqId = Object.keys(doc.sequences)[0]!;
	const F = flicksPerFrame(doc.sequences[seqId]!.settings.frameRate);
	let at = 0;
	const r = applyTransaction(
		doc,
		{
			label: 'seed',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'media.register', asset: asset('video', 3600), ref: '$a' },
				{ type: 'media.register', asset: asset('video', 3600), ref: '$b' },
				...lengths.map((len, i) => {
					const c = {
						type: 'clip.place',
						source: { mediaId: i % 2 ? '$b' : '$a' },
						at,
						tracks: { video: 'V1' },
						video: true,
						audio: false,
						sourceRange: { in: { flicks: at * F }, out: { flicks: (at + len) * F } },
					};
					at += len;
					return c;
				}),
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
	const clips = Object.values(doc.sequences[seqId]!.clips).sort((x, y) => x.start - y.start);
	return { projectId: doc.projectId, seqId, clips, file };
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

const url = (projectId: string, pass: string) => `/api/projects/${projectId}/automation/${pass}`;
const post = (u: string, body: unknown, headers: Record<string, string> = AGENT_H) =>
	app.inject({ method: 'POST', url: u, headers: json(headers), payload: JSON.stringify(body) });

async function savedDoc(projectId: string): Promise<{ doc: ProjectDocument; revision: number }> {
	const r = await post('/api/agent/query', { projectId, query: 'doc.get', args: {} }, EDITOR_H);
	const b = r.json() as { result: ProjectDocument; revision: number };
	return { doc: b.result, revision: b.revision };
}
async function propose(projectId: string, pass: string, body: unknown, headers = AGENT_H) {
	const r = await post(url(projectId, pass), body, headers);
	expect(r.statusCode, r.body).toBe(202);
	const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	expect(job.kind).toBe('edit-automation');
	return { job, result: AutomationPassResultSchema.parse(job.result) as AutomationPassResult };
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
async function acceptAll(projectId: string, id: string, headers = AGENT_H) {
	const r = await post(`/api/projects/${projectId}/proposals/${id}/accept`, { itemIds: 'all' }, headers);
	expect(r.statusCode, r.body).toBe(200);
	return r.json();
}

const CAPS = { native: true, remotionLocal: 'ready' as const, fframes: 'ready' as const, mgMasters: true };
const exportSettings = (seqId: string) =>
	({
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
	}) as never;
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
			settings: exportSettings(seqId),
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

describe('editing automation passes (real engine, indexed kit)', { timeout: 600_000 }, () => {
	beforeAll(async () => {
		process.env.JASPER_SOUND_STARTER_DIR = makeKit(tempAppdir('jasper-auto-kit-'));
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

	it('dry run: counts, coverage, cost, budget and sounds — nothing stored', async () => {
		const { projectId, seqId } = seed([90, 90, 90, 90, 90]);
		const before = await savedDoc(projectId);
		const r = await post(url(projectId, 'decorate-cuts'), {
			sequenceId: seqId,
			mode: 'dryRun',
			params: { seed: 4 },
		});
		expect(r.statusCode, r.body).toBe(200);
		const out = AutomationPassResultSchema.parse(r.json());
		expect(out.summary).toMatchObject({ pass: 'decorate-cuts', count: 4, considered: 4, coverage: 1 });
		// the long-form kits' effects run on the native adjustment kernel (blend/adjust.ts)
		expect(out.summary.cost.class).toBe('native');
		expect(out.summary.track).toBe('new track FX');
		expect(out.sfx).toMatchObject({ enabled: true, type: 'whoosh', placed: 4 });
		expect(out.sfx!.available).toBeGreaterThanOrEqual(4);
		expect(out.budget.fits).toBe(true);
		expect(out.proposalId).toBeNull();
		const list = await app.inject({
			method: 'GET',
			url: `/api/projects/${projectId}/proposals`,
			headers: AGENT_H,
		});
		expect((list.json() as { proposals: unknown[] }).proposals).toEqual([]);
		expect((await savedDoc(projectId)).revision).toBe(before.revision);
	});

	it('refuses invalid parameters, unknown tracks, sequences and passes at once', async () => {
		const { projectId } = seed([90, 90]);
		const bad = await post(url(projectId, 'decorate-cuts'), { params: { covrage: 1 } });
		expect([bad.statusCode, bad.json().code]).toEqual([400, 'VALIDATION_FAILED']);
		expect(bad.json().message).toContain('covrage');
		const track = await post(url(projectId, 'punch-ins'), { params: { track: 'V9' } });
		expect(track.statusCode).toBe(404);
		const seq = await post(url(projectId, 'ken-burns'), { sequenceId: 'seq_nope' });
		expect(seq.statusCode).toBe(404);
		const pass = await post(url(projectId, 'confetti'), {});
		expect(pass.statusCode).toBe(404);
		const extra = await post(url(projectId, 'ken-burns'), { mode: 'apply' });
		expect(extra.statusCode).toBe(400);
	});

	it('proposes kits with centred whooshes; an agent accepts it as ONE transaction (default on)', async () => {
		const { projectId, seqId, clips } = seed([120, 120, 120, 120]);
		const before = await savedDoc(projectId);
		const { job, result } = await propose(projectId, 'decorate-cuts', {
			sequenceId: seqId,
			params: { seed: 9 },
		});
		expect(job.origin).toEqual({ type: 'agent', agentRunId: 'auto-agent' });
		expect(result.proposalId).toMatch(/^prp_/);
		expect(result.invalid).toEqual([]);
		expect(result.sfx).toMatchObject({ placed: 3, unsounded: 0 });
		const p = await getProposal(projectId, result.proposalId!);
		expect(p.feature).toBe('edit-automation');
		expect(p.title).toBe('Decorate Cuts');
		const kits = p.items.filter((it) => (it.meta as { kind?: string }).kind === 'kit');
		expect(kits.map((k) => k.id)).toEqual(['kit:120', 'kit:240', 'kit:360']);
		for (const k of kits) {
			const types = (k.commands as { type: string }[]).map((c) => c.type);
			expect(types.slice(0, 3)).toEqual(['clip.addAdjustmentBatch', 'soundCue.add', 'soundDesign.place']);
			expect(k.requires).toEqual(expect.arrayContaining(['fx-track']));
			expect(k.anchors).toBeDefined();
		}
		// nothing applied yet
		expect((await savedDoc(projectId)).revision).toBe(before.revision);
		await acceptAll(projectId, p.id);
		const after = await savedDoc(projectId);
		expect(after.revision).toBe(before.revision + 1);
		const seq = after.doc.sequences[seqId]!;
		const fx = seq.videoTracks.find((t) => t.name === 'FX')!;
		expect(fx).toBeDefined();
		const adj = Object.values(seq.clips).filter((c): c is AdjustmentClip => c.trackId === fx.id);
		const cues = soundCuesOf(seq);
		const F = flicksPerFrame(seq.settings.frameRate);
		for (const k of kits) {
			const m = k.meta as { frame: number; range: { start: number; end: number } };
			// the kit's clips cover exactly its range around the cut
			const mine = adj.filter((c) => c.start >= m.range.start && c.start < m.range.end);
			expect(Math.min(...mine.map((c) => c.start))).toBe(m.range.start);
			expect(Math.max(...mine.map((c) => c.start + c.duration))).toBe(m.range.end);
			// its whoosh: a cue on the cut, the clip trimmed to the kit, the peak on the cut
			const cue = cues.find((c) => c.frame === m.frame)!;
			expect(cue).toMatchObject({ kind: 'cut', types: ['whoosh'], align: 'peak' });
			expect(cue.anchor).toMatchObject({ type: 'edit' });
			const sfx = seq.clips[cue.placedClipIds![0]!] as AudioClip & { sfx: ClipSfx };
			expect(sfx.start).toBeGreaterThanOrEqual(m.range.start);
			expect(sfx.start + sfx.duration).toBeLessThanOrEqual(m.range.end);
			const peak = sfx.start * F + (sfx.sfx.placement.peakFlicks - sfx.sourceIn) / sfx.speed.rate;
			expect(Math.abs(peak - m.frame * F)).toBeLessThanOrEqual(F);
		}
		expect(clips.length).toBe(4);
		// the export planner keeps the kits native, as the dry run's cost class said
		const plan = await exportPath(after.doc, seqId);
		expect(plan.blockers).toEqual([]);
		expect(plan.path).toBe('native');
	});

	it('Refresh proposal re-plans a kit whose cut moved; Reroll draws it again with the next seed', async () => {
		const { projectId, seqId, clips, file } = seed([120, 120, 120]);
		const { result } = await propose(projectId, 'decorate-cuts', {
			sequenceId: seqId,
			params: { seed: 2, sfx: { enabled: false } },
		});
		const id = result.proposalId!;
		// the user trims the first clip and slides the rest: the cuts move 10 frames earlier
		userEdit(file, seqId, [
			{ type: 'clip.trim', clipId: clips[0]!.id, edge: 'out', deltaFrames: -10 },
			{ type: 'clip.move', clipIds: [clips[1]!.id, clips[2]!.id], deltaFrames: -10 },
		]);
		const r = await post(
			`/api/projects/${projectId}/proposals/${id}/refresh`,
			{ itemIds: 'stale' },
			EDITOR_H,
		);
		expect(r.statusCode, r.body).toBe(200);
		const out = ProposalRefreshResponseSchema.parse(r.json());
		expect(out.refreshed).toEqual(expect.arrayContaining(['kit:120', 'kit:240']));
		const k = out.proposal.items.find((it) => it.id === 'kit:120')!;
		expect(k.state).toBe('pending');
		expect((k.meta as { frame: number }).frame).toBe(110);
		const seed0 = (k.meta as { seed: number }).seed;
		const rr = await post(
			`/api/projects/${projectId}/proposals/${id}/refresh`,
			{ itemIds: ['kit:120'], reroll: true },
			EDITOR_H,
		);
		expect(rr.statusCode, rr.body).toBe(200);
		const k2 = ProposalRefreshResponseSchema.parse(rr.json()).proposal.items.find(
			(it) => it.id === 'kit:120',
		)!;
		expect((k2.meta as { seed: number }).seed).toBe(seed0 + 1);
		expect(k2.state).toBe('pending');
	});

	it('punch-ins and Ken Burns are Motion keys on the clips and export natively', async () => {
		const { projectId, seqId } = seed([90, 120, 150, 180, 40]);
		const punch = await propose(projectId, 'punch-ins', {
			sequenceId: seqId,
			params: { density: 1, sfx: { enabled: false } },
		});
		expect(punch.result.summary).toMatchObject({ count: 4, considered: 4 });
		expect(punch.result.summary.cost.class).toBe('native');
		await acceptAll(projectId, punch.result.proposalId!);
		const kb = await propose(projectId, 'ken-burns', { sequenceId: seqId, params: { share: 1 } });
		// the punched clips are left alone: only the 2-second clip that was too short for a punch-in remains
		expect(kb.result.summary.count).toBe(1);
		await acceptAll(projectId, kb.result.proposalId!);
		const { doc } = await savedDoc(projectId);
		const keyed = Object.values(doc.sequences[seqId]!.clips).filter(
			(c) =>
				((c as { transform?: { scale: { keyframes: unknown[] } } }).transform?.scale.keyframes.length ?? 0) >
				0,
		);
		expect(keyed).toHaveLength(5);
		const plan = await exportPath(doc, seqId);
		expect(plan.path).toBe('native');
	});

	it('an agent cannot accept when the project turned editing automation off', async () => {
		const { projectId, seqId, file } = seed([120, 120]);
		userEdit(file, seqId, [
			{ type: 'project.updateSettings', settings: { agentProposals: { 'edit-automation': false } } },
		]);
		const { result } = await propose(projectId, 'ken-burns', { sequenceId: seqId, params: { share: 1 } });
		const r = await post(`/api/projects/${projectId}/proposals/${result.proposalId}/accept`, {
			itemIds: 'all',
		});
		expect(r.statusCode).toBe(403);
		expect(r.json()).toMatchObject({ code: 'APPROVAL_REQUIRED' });
	});
});
