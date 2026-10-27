// Rebalance SFX levels (spec 12 §2.4, §2.10 `rebalance_sfx`, P4-R2; wp-note "Phase 4 → WP4.1b") on a real engine with
// generated media (music bed A1, untranscribed dialogue A2, a hero hit, a support hit 0.1 s after it, a click under the
// speech, a click with a hand-set gain): apply = ONE transaction "Rebalance SFX Levels" with `sfx.level {by: 'solver'}`;
// every event reaches its target lift or says what limited it (P4 done-when); idempotent; user gains kept unless asked;
// propose = a proposal (agents may not accept it; the editor applies it); typed refusals before a job starts.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EngineJob, type SfxRebalanceResult, SfxRebalanceResultSchema } from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import {
	type AudioClip,
	type ClipSfx,
	isSetupItem,
	makeEnvelope,
	type ProjectDocument,
	type Proposal,
} from '@jasper/project';
import { describeFuzz, jsonTarget } from '@jasper/testkit/fuzz';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentService } from '../src/agent/service.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, register, type TestApp } from './helpers.ts';
import { provenance, writeBedFixture } from './sound-bed-fixture.ts';

const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_rebal_0123456789abcdef012';
const KEY = 'key_rebal_0123456789abcdef012';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'mix-agent' };
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

type SfxClip = AudioClip & { sfx?: ClipSfx };
let app: TestApp;
let base: { doc: ProjectDocument; ids: Record<string, string> };

async function buildDoc(a: TestApp) {
	const files = writeBedFixture(mkdtempSync(join(tmpdir(), 'jasper-rebal-')));
	const b = new DocBuilder('hd-1080p-30', 500);
	const music = b.addMedia(await register(a, files.music, { authorization: `Bearer ${TOKEN}` }));
	const speech = b.addMedia(await register(a, files.speech, { authorization: `Bearer ${TOKEN}` }));
	const hit = b.addMedia(await register(a, files.hit, { authorization: `Bearer ${TOKEN}` }));
	const click = b.addMedia(await register(a, files.click, { authorization: `Bearer ${TOKEN}` }));
	const ids: Record<string, string> = {};
	const r = b.tx([
		{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{ type: 'clip.place', source: { mediaId: speech }, at: 0, tracks: { audio: 'A2' }, ref: '$s' },
		{ type: 'media.setLibraryInfo', mediaId: hit, library: provenance('hit') },
		{ type: 'media.setLibraryInfo', mediaId: click, library: provenance('click') },
	]);
	b.tx([
		{ type: 'essentialSound.setType', clipIds: [r.refs.$m!], audioType: 'music' },
		{ type: 'essentialSound.setType', clipIds: [r.refs.$s!], audioType: 'dialogue' },
	]);
	const place = (frame: number, mediaId: string, role: string, key: string, extra: object = {}) => {
		ids[key] = b.tx([
			{ type: 'soundDesign.place', frame, layers: [{ mediaId, role, align: 'peak', ref: '$x', ...extra }] },
		]).refs.$x!;
	};
	place(30, hit, 'hero', 'hero');
	place(33, hit, 'support', 'shadowed', { rate: 0.98, gainOffsetDb: 0.6 });
	place(150, click, 'support', 'inSpeech');
	place(270, click, 'support', 'userGain', { gainDb: -6 });
	ids.music = r.refs.$m!;
	return { doc: b.doc, ids };
}

let projects = 0;
function seed(doc: ProjectDocument): string {
	const projectId = `prj_${(++projects).toString().padStart(16, '0')}`;
	const file = appdirPaths(app.appdir).projectFile(projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope(
				{ ...doc, projectId },
				{ revision: 3, savedAt: '2026-10-16T00:00:00.000Z', platform: 'test' },
			),
		),
	);
	return projectId;
}
async function saved(projectId: string): Promise<{ doc: ProjectDocument; revision: number }> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/agent/query',
		headers: json(EDITOR_H),
		payload: JSON.stringify({ projectId, query: 'doc.get', args: {} }),
	});
	const b = r.json() as { result: ProjectDocument; revision: number };
	return { doc: b.result, revision: b.revision };
}
async function rebalance(body: unknown, headers: Record<string, string> = AGENT_H) {
	return app.inject({
		method: 'POST',
		url: '/api/sound-design/rebalance',
		headers: json(headers),
		payload: JSON.stringify(body),
	});
}
async function run(
	body: unknown,
	headers: Record<string, string> = AGENT_H,
): Promise<{ job: EngineJob; result: SfxRebalanceResult }> {
	const r = await rebalance(body, headers);
	expect(r.statusCode, r.body).toBe(202);
	const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return { job, result: SfxRebalanceResultSchema.parse(job.result) };
}

beforeAll(async () => {
	app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
	base = await buildDoc(app);
}, 120_000);
afterAll(closeApps);

describe('POST /api/sound-design/rebalance (real engine)', { timeout: 300_000 }, () => {
	it('apply: one transaction; every event reaches its target lift or says what limited it; idempotent', async () => {
		const projectId = seed(base.doc);
		const { ids } = base;
		const before = await saved(projectId);
		const { job, result } = await run({ projectId, mode: 'apply' }, EDITOR_H);
		expect(job.origin).toEqual({ type: 'user' });
		expect(result.applied).toBe(true);
		const after = await saved(projectId);
		expect(after.revision).toBe(before.revision + 1);
		expect(result.revision).toBe(after.revision);
		const rep = result.report;
		// the hand-set gain is kept
		expect(rep.skipped).toEqual([{ clipId: ids.userGain, code: 'USER_GAIN', reason: expect.any(String) }]);
		expect(rep.events.map((e) => e.clipId).sort()).toEqual([ids.hero, ids.shadowed, ids.inSpeech].sort());
		const seq = after.doc.sequences[Object.keys(after.doc.sequences)[0]!]!;
		for (const e of rep.events) {
			// P4 done-when: the target lift is reached, or a limitedBy reason says why not
			if (e.achievedLiftDb !== null && e.achievedLiftDb < e.targetLiftDb - 0.05)
				expect(e.limitedBy.length, `${e.title}: ${e.reason}`).toBeGreaterThan(0);
			const clip = seq.clips[e.clipId] as SfxClip;
			expect(clip.gainDb).toBe(e.gainDb);
			expect(clip.sfx!.level).toMatchObject({ by: 'solver', gainDb: e.gainDb, limitedBy: e.limitedBy });
			expect(e.reason.startsWith(`${e.gainDb < 0 ? '−' : e.gainDb > 0 ? '+' : ''}`)).toBe(true);
		}
		const byId = new Map(rep.events.map((e) => [e.clipId, e]));
		// the click under the speech is held by the dialogue guard, named by its track
		const inSpeech = byId.get(ids.inSpeech!)!;
		expect(inSpeech.speech).toBe(true);
		expect(inSpeech.limitedBy).toContain('dialogue');
		expect(inSpeech.reason).toMatch(/limited by .*dialogue A2/);
		// the support right after the hero is shadowed (× 0.6)
		expect(byId.get(ids.shadowed!)!.limitedBy).toContain('hero-shadow');
		// its variation offset survives in the solver level
		expect((seq.clips[ids.shadowed!] as SfxClip).sfx!.level).toMatchObject({ offsetDb: 0.6 });
		expect(rep.levels).toMatchObject({
			delivery: 'web',
			programLufs: -14,
			truePeakCeilingDb: -1,
			clusters: 2,
		});
		expect(rep.levels.clusterSeconds).toBeLessThan(5);
		expect(rep.counts).toMatchObject({ solved: 3, skipped: 1 });
		// again: nothing to change (no transaction)
		const again = await run({ projectId, mode: 'apply' }, EDITOR_H);
		expect(again.result.applied).toBe(false);
		expect(again.result.report.events.map((e) => e.gainDb)).toEqual(rep.events.map((e) => e.gainDb));
		expect((await saved(projectId)).revision).toBe(after.revision);
		// userGains replace: the hand-set click is solved too (an agent applies: "Agent: Rebalance SFX Levels")
		const all = await run({ projectId, mode: 'apply', userGains: 'replace', clipIds: undefined });
		expect(all.job.origin).toEqual({ type: 'agent', agentRunId: 'mix-agent' });
		expect(all.result.report.events.map((e) => e.clipId)).toContain(ids.userGain);
		expect(all.result.report.skipped).toEqual([]);
	});

	it('propose: a proposal with one item per changed clip; agents may not accept; the editor applies it', async () => {
		const projectId = seed(base.doc);
		const before = await saved(projectId);
		const { result } = await run({ projectId, delivery: 'broadcast-r128' });
		expect(result.mode).toBe('propose');
		expect(result.applied).toBe(false);
		expect(result.proposalId).toMatch(/^prp_/);
		expect(result.report.levels).toMatchObject({ delivery: 'broadcast-r128', programLufs: -23 });
		expect((await saved(projectId)).revision).toBe(before.revision);
		const g = await app.inject({
			method: 'GET',
			url: `/api/projects/${projectId}/proposals/${result.proposalId}`,
			headers: AGENT_H,
		});
		const p = (g.json() as { proposal: Proposal }).proposal;
		expect(p.items.length).toBe(result.report.events.length);
		expect(p.items.every((i) => !isSetupItem(i) && i.state === 'pending')).toBe(true);
		expect(p.items[0]!.commands[0]).toMatchObject({ type: 'soundDesign.applyGains' });
		expect(String((p.items[0]!.meta as { why: string }).why)).toMatch(/ dB/);
		const refused = await app.inject({
			method: 'POST',
			url: `/api/projects/${projectId}/proposals/${p.id}/accept`,
			headers: json(AGENT_H),
			payload: JSON.stringify({ itemIds: 'all' }),
		});
		expect(refused.statusCode).toBe(403);
		const ok = await app.inject({
			method: 'POST',
			url: `/api/projects/${projectId}/proposals/${p.id}/accept`,
			headers: json(EDITOR_H),
			payload: JSON.stringify({ itemIds: 'all' }),
		});
		expect(ok.statusCode, ok.body).toBe(200);
		const after = await saved(projectId);
		expect(after.revision).toBe(before.revision + 1);
		const seq = after.doc.sequences[Object.keys(after.doc.sequences)[0]!]!;
		for (const e of result.report.events) expect((seq.clips[e.clipId] as SfxClip).gainDb).toBe(e.gainDb);
	});

	it('an edit while the job runs: CONFLICT (retryable), nothing applied by the job', async () => {
		const { ids } = base;
		/** Applies a transaction as the editor (the user's concurrent edit). */
		const edit = async (projectId: string, commands: unknown[]) => {
			const r = await app.inject({
				method: 'POST',
				url: '/api/agent/tx',
				headers: json(EDITOR_H),
				payload: JSON.stringify({ projectId, transaction: { label: 'User edit', origin: 'user', commands } }),
			});
			expect(r.statusCode, r.body).toBe(200);
			expect((r.json() as { result: { ok: boolean } }).result.ok, r.body).toBe(true);
		};
		const failed = async (projectId: string) => {
			const r = await rebalance({ projectId, mode: 'apply' }, EDITOR_H);
			expect(r.statusCode, r.body).toBe(202);
			return coreServices(app).queue.wait((r.json() as EngineJob).id);
		};
		const sfxGains = (doc: ProjectDocument) => {
			const seq = doc.sequences[Object.keys(doc.sequences)[0]!]!;
			return Object.fromEntries(
				[ids.hero, ids.shadowed, ids.inSpeech, ids.userGain].map((id) => [
					id,
					(seq.clips[id!] as SfxClip).gainDb,
				]),
			);
		};
		const projectId = seed(base.doc);
		const before = await saved(projectId);
		const agent = app.jasper.services.agent as AgentService;
		const transact = agent.transact.bind(agent);
		// The job has measured and checked the old bed when its real transaction reaches the agent boundary.
		// The user's edit touches only music; optimistic fast-forward alone would allow stale SFX gains through.
		const race = vi.spyOn(agent, 'transact').mockImplementationOnce(async (...args) => {
			race.mockRestore();
			await edit(projectId, [{ type: 'audio.setGain', clipIds: [ids.music], mode: 'adjust', db: 6 }]);
			return transact(...args);
		});
		try {
			const job = await failed(projectId);
			expect(job.state, JSON.stringify(job.result)).toBe('failed');
			expect(job.error).toMatchObject({ code: 'CONFLICT', retryable: true });
			const after = await saved(projectId);
			expect(after.revision).toBe(before.revision + 1);
			expect(sfxGains(after.doc)).toEqual(sfxGains(before.doc));
		} finally {
			race.mockRestore();
		}
	});

	it('autoGain: Essential Sound ▸ Auto gain on hands the named clips back in the rebalance transaction (one undo step)', async () => {
		// WP6.5b (WP6.5a item 7k): two clips with Auto gain off — one the solve measures, one it cannot (disabled: not in
		// the mix) — named with autoGain: ONE transaction; both lose the mark; the measured one takes its solved gain, the
		// other its recorded level. Before, the editor made a second "Auto Gain On" transaction for the second clip.
		const { ids } = base;
		const doc = structuredClone(base.doc) as ProjectDocument;
		const seq0 = doc.sequences[Object.keys(doc.sequences)[0]!]!;
		const hero = seq0.clips[ids.hero!] as SfxClip;
		const off = seq0.clips[ids.shadowed!] as SfxClip & { enabled?: boolean };
		(hero.sfx!.level as { manual?: boolean }).manual = true;
		(off.sfx!.level as { manual?: boolean }).manual = true;
		off.enabled = false;
		const recorded = off.sfx!.level!.gainDb;
		const projectId = seed(doc);
		const before = await saved(projectId);
		const { result } = await run(
			{ projectId, mode: 'apply', clipIds: [ids.hero, ids.shadowed], autoGain: true },
			EDITOR_H,
		);
		expect(result.applied).toBe(true);
		expect(result.autoGain?.clipIds.sort()).toEqual([ids.hero, ids.shadowed].sort());
		expect(result.report.skipped.map((x) => [x.clipId, x.code])).toEqual([[ids.shadowed, 'NOT_IN_MIX']]);
		const after = await saved(projectId);
		expect(after.revision).toBe(before.revision + 1);
		const seq = after.doc.sequences[seq0.id]!;
		const h = seq.clips[ids.hero!] as SfxClip;
		const o = seq.clips[ids.shadowed!] as SfxClip;
		const ev = result.report.events.find((e) => e.clipId === ids.hero)!;
		expect(h.gainDb).toBe(ev.gainDb);
		expect(h.sfx!.level).toMatchObject({ by: 'solver', gainDb: ev.gainDb });
		expect((h.sfx!.level as { manual?: boolean }).manual).toBeUndefined();
		expect((o.sfx!.level as { manual?: boolean }).manual).toBeUndefined();
		expect(o.gainDb).toBe(recorded);
		// only the named clips' marks: nothing to hand back → no transaction when nothing changes
		const again = await run({ projectId, mode: 'apply', clipIds: [ids.shadowed], autoGain: true }, EDITOR_H);
		expect(again.result.applied).toBe(false);
		expect(again.result.autoGain).toEqual({ clipIds: [] });
		expect((await saved(projectId)).revision).toBe(after.revision);
		// refused unless apply mode with named clips
		for (const body of [
			{ projectId, autoGain: true, clipIds: [ids.hero] },
			{ projectId, autoGain: true, mode: 'apply' },
			{ projectId, autoGain: false, mode: 'apply', clipIds: [ids.hero] },
		]) {
			const r = await rebalance(body);
			expect([r.statusCode, (r.json() as { code: string }).code], JSON.stringify(body)).toEqual([
				400,
				'VALIDATION_FAILED',
			]);
		}
	});

	it('explicit clip ids and a range; typed refusals before a job starts', async () => {
		const projectId = seed(base.doc);
		const { ids } = base;
		const one = await run({ projectId, clipIds: [ids.userGain], mode: 'apply' });
		expect(one.result.report.events.map((e) => e.clipId)).toEqual([ids.userGain]);
		const ranged = await run({ projectId, range: { start: 120, end: 200 } });
		expect(ranged.result.report.events.map((e) => e.clipId)).toEqual([ids.inSpeech]);
		const code = async (body: unknown) => {
			const r = await rebalance(body);
			return [r.statusCode, (r.json() as { code: string }).code];
		};
		expect(await code({ projectId, clipIds: ['clp_0000000000nothere'] })).toEqual([404, 'CLIP_NOT_FOUND']);
		expect(await code({ projectId, clipIds: [ids.music] })).toEqual([400, 'NOT_SFX']);
		expect(await code({ projectId, sequenceId: 'seq_000000000000none' })).toEqual([
			404,
			'SEQUENCE_NOT_FOUND',
		]);
		expect(await code({ projectId: 'prj_9999999999999999' })).toEqual([404, 'PROJECT_NOT_FOUND']);
		expect(await code({ projectId, mode: 'yolo' })).toEqual([400, 'VALIDATION_FAILED']);
		expect(await code({ projectId, range: { start: 50, end: 10 } })).toEqual([400, 'VALIDATION_FAILED']);
		expect(await code({ projectId, extra: 1 })).toEqual([400, 'VALIDATION_FAILED']);
	});
});

// Mutated rebalance requests against a stored project with real media: a typed answer, never a 5xx; a started job ends
// succeeded (with a result of the schema) or failed with a code, never stuck.
let fuzzProject: string | null = null;
async function fuzzPost(body: unknown) {
	if (!fuzzProject) fuzzProject = seed(base.doc);
	const b =
		body &&
		typeof body === 'object' &&
		!Array.isArray(body) &&
		(body as { projectId?: unknown }).projectId === 'FUZZ'
			? { ...(body as object), projectId: fuzzProject }
			: body;
	const r = await rebalance(b, EDITOR_H);
	if (r.statusCode >= 500) throw new Error(`${r.statusCode} ${r.body.slice(0, 300)}`);
	if (r.statusCode === 202) {
		const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
		if (job.state === 'succeeded') SfxRebalanceResultSchema.parse(job.result);
		else if (job.state !== 'failed' || typeof job.error?.code !== 'string')
			throw new Error(`job ${job.state}: ${JSON.stringify(job.error)}`);
	}
}
describeFuzz(
	'POST /api/sound-design/rebalance',
	[
		jsonTarget(
			'rebalance request',
			[
				{ projectId: 'FUZZ', mode: 'propose', range: { start: 0, end: 60 } },
				{ projectId: 'FUZZ', mode: 'apply', userGains: 'replace', delivery: 'podcast' },
				{ projectId: 'FUZZ', clipIds: ['clp_0000000000000001'], label: 'x' },
			],
			fuzzPost,
			undefined,
			{ iterations: 20, properties: 6, slowMs: 30_000 },
		),
	],
	600_000,
);
