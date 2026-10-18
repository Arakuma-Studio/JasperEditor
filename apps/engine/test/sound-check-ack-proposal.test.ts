// Spec 12 §4 P6-E4 (acknowledged findings) and P6-E5 (check a proposal before review) on a real engine with generated
// media (wp-note "Phase 6 → WP-E2"):
//   - an agent acknowledges a warning (ENDING of a mix cut at a loud frame): the re-check leaves it out of the verdict,
//     counts it and lists it as acknowledged; editing what plays there brings it back, "acknowledged before the
//     change"; an agent acknowledging an error is E_APPROVAL_REQUIRED; the user (editor) may (LICENSE error → pass);
//   - a proposal whose items fix a seeded MASKED and place a sound that repeats its neighbour: the proposal check
//     reports exactly that, each with its item; the revision, the stored summary and the kept report are unchanged; the
//     result is deterministic; the summary is stored on the proposal (`report.check`, event `checked`); stale and
//     invalid items are skipped and listed; typed refusals.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type EngineJob,
	type EventEnvelope,
	ProposalCreateResponseSchema,
	type SoundCheckResult,
	SoundCheckResultSchema,
} from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import { makeEnvelope, type ProjectDocument, type Proposal, soundAcknowledgementsOf } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentService } from '../src/agent/service.ts';
import type { Broadcaster } from '../src/events/broadcaster.ts';
import { soundCheckDelta } from '../src/sound-design/check-proposal.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, makeApp, type TestApp } from './helpers.ts';
import { buildCheckDoc, type FixtureMedia, registerCheckMedia } from './sound-check-fixture.ts';

const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_ackp_0123456789abcdef0123';
const KEY = 'key_ackp_0123456789abcdef0123';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'ack-agent' };
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

let app: TestApp;
let media: FixtureMedia;
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
				{ revision: 3, savedAt: '2026-10-18T00:00:00.000Z', platform: 'test' },
			),
		),
	);
	return projectId;
}
async function post(url: string, body: unknown, headers: Record<string, string> = AGENT_H) {
	return app.inject({ method: 'POST', url, headers: json(headers), payload: JSON.stringify(body) });
}
async function saved(projectId: string): Promise<{ doc: ProjectDocument; revision: number }> {
	const r = await post('/api/agent/query', { projectId, query: 'doc.get', args: {} }, EDITOR_H);
	const b = r.json() as { result: ProjectDocument; revision: number };
	return { doc: b.result, revision: b.revision };
}
async function check(body: Record<string, unknown>, headers: Record<string, string> = AGENT_H) {
	const r = await post('/api/sound-design/check', body, headers);
	expect(r.statusCode, r.body).toBe(202);
	const job: EngineJob = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return { job, result: SoundCheckResultSchema.parse(job.result) as SoundCheckResult };
}
async function tx(projectId: string, commands: unknown[], headers: Record<string, string>) {
	const r = await post(
		'/api/agent/tx',
		{ projectId, transaction: { label: 'test', origin: { agent: 'ack-agent' }, commands } },
		headers,
	);
	expect(r.statusCode, r.body).toBe(200);
	return (r.json() as { result: { ok: boolean; errors?: { code: string; message: string }[] } }).result;
}
/** An edit as the user's own (the editor's session applies the panel's edits with origin user). */
async function userTx(projectId: string, commands: unknown[]) {
	const agent = app.jasper.services.agent as AgentService;
	const out = await agent.transact(
		projectId,
		{ label: 'Acknowledge Sound Check Finding', origin: { agent: 'editor' }, commands },
		{ preApproved: true, asUser: true },
	);
	return out.result as { ok: boolean };
}
const describeIssues = (r: SoundCheckResult) =>
	r.report.issues.map((i) => `${i.severity} ${i.id} ${i.message.text}`).join('\n');
const ackOf = (i: SoundCheckResult['report']['issues'][number], reason: string) => ({
	type: 'soundDesign.acknowledgeIssue',
	key: i.id,
	code: i.code,
	severity: i.severity,
	reason,
	target: {
		...(i.clipIds?.length ? { clipIds: i.clipIds } : {}),
		...(i.cueId ? { cueId: i.cueId } : {}),
		...(!i.clipIds?.length && !i.cueId && i.frame !== undefined ? { frame: i.frame } : {}),
	},
	message: i.message.text,
});

beforeAll(async () => {
	app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
	media = await registerCheckMedia(app, mkdtempSync(join(tmpdir(), 'jasper-ackp-')), TOKEN);
}, 180_000);
afterAll(async () => {
	await closeApps();
});

describe('acknowledged findings (P6-E4, real engine)', { timeout: 600_000 }, () => {
	it('an agent acknowledges a warning: left out of the verdict, counted, listed; an edit there brings it back', async () => {
		const fx = buildCheckDoc(media, { ending: 'cut' });
		const projectId = seed(fx.doc());
		const first = (await check({ projectId })).result;
		const ending = first.report.issues.find((i) => i.code === 'ENDING');
		expect(ending, describeIssues(first)).toBeDefined();
		expect(first.report.verdict, describeIssues(first)).toBe('warn');
		const warnings = first.report.issues.filter((i) => i.severity === 'warning');
		expect(warnings.map((i) => i.code), describeIssues(first)).toEqual(['ENDING']);
		const r = await tx(projectId, [ackOf(ending!, 'The cut to black is the joke: it ends on the hit')], AGENT_H);
		expect(r.ok, JSON.stringify(r.errors)).toBe(true);
		const acked = soundAcknowledgementsOf((await saved(projectId)).doc.sequences[first.sequenceId])[ending!.id]!;
		expect(acked).toMatchObject({ by: 'agent', agent: 'ack-agent', code: 'ENDING', target: { frame: ending!.frame } });
		const again = (await check({ projectId })).result;
		expect(again.report.verdict, describeIssues(again)).toBe('pass');
		expect(again.report.counts.acknowledged).toBe(1);
		expect(again.report.counts.ENDING).toBeUndefined();
		expect(again.report.counts.warning).toBeUndefined();
		const listed = again.report.issues.find((i) => i.id === ending!.id)!;
		expect(listed.acknowledged).toMatchObject({
			reason: 'The cut to black is the joke: it ends on the hit',
			by: 'agent',
			active: true,
		});
		expect(again.report.acknowledgements).toEqual({ count: 1, unmatched: [] });
		// no listen-here "worst" for an acknowledged finding; the fix is not one "Fix all safe" would take
		expect(again.report.listen.find((l) => l.slot === 'worst')).toBeUndefined();
		// the music under the end changes: the finding is back, "acknowledged before the change"
		const e = await tx(projectId, [{ type: 'audio.setGain', clipIds: [fx.ids.music], mode: 'adjust', db: -1 }], EDITOR_H);
		expect(e.ok).toBe(true);
		const back = (await check({ projectId })).result;
		expect(back.report.verdict).toBe('warn');
		expect(back.report.counts.ENDING).toBe(1);
		expect(back.report.counts.acknowledged).toBeUndefined();
		expect(back.report.issues.find((i) => i.id === ending!.id)!.acknowledged).toMatchObject({
			active: false,
			why: 'changed',
		});
	});

	it('an agent acknowledging an error is E_APPROVAL_REQUIRED; the user acknowledges it and the verdict passes', async () => {
		const fx = buildCheckDoc(media, { clickLicense: 'CC-BY-NC-4.0' });
		const projectId = seed(fx.doc());
		const first = (await check({ projectId })).result;
		const lic = first.report.issues.find((i) => i.code === 'LICENSE' && i.severity === 'error');
		expect(lic, describeIssues(first)).toBeDefined();
		expect(first.report.verdict).toBe('fail');
		const before = await saved(projectId);
		const refused = await tx(projectId, [ackOf(lic!, 'We licensed it separately')], AGENT_H);
		expect(refused.ok).toBe(false);
		expect(refused.errors![0]!.code).toBe('E_APPROVAL_REQUIRED');
		expect((await saved(projectId)).revision).toBe(before.revision);
		// lying about the severity does not help an agent: the check does not honour it for an error
		const lied = await tx(projectId, [{ ...ackOf(lic!, 'fine'), severity: 'warning' }], AGENT_H);
		expect(lied.ok).toBe(true);
		const still = (await check({ projectId })).result;
		expect(still.report.verdict).toBe('fail');
		expect(still.report.issues.find((i) => i.id === lic!.id)!.acknowledged).toMatchObject({
			active: false,
			why: 'needs-user',
		});
		// the user's own edit (what the Sound Check panel applies, origin user): accepted, the check leaves the error out
		const user = await userTx(projectId, [ackOf(lic!, 'Licensed separately for this film (contract 2026-114)')]);
		expect(user.ok, JSON.stringify(user)).toBe(true);
		const ok = (await check({ projectId })).result;
		expect(ok.report.issues.find((i) => i.id === lic!.id)!.acknowledged).toMatchObject({
			by: 'user',
			active: true,
		});
		expect(ok.report.verdict, describeIssues(ok)).not.toBe('fail');
		expect(ok.report.counts.error).toBeUndefined();
	});
});

/** The masked fixture (music +14 dB, the click 12 dB down), its kept check, and a proposal (gain fix + a repeat). */
async function maskedProposal() {
	const fx = buildCheckDoc(media);
	fx.b.tx([{ type: 'soundDesign.applyGains', gains: { [fx.ids.clipB]: -30 } }]);
	const projectId = seed(fx.doc());
	const { job: baseJob, result: base } = await check({ projectId, store: true }, EDITOR_H);
	const masked = base.report.issues.find((i) => i.code === 'MASKED' && i.clipIds?.[0] === fx.ids.clipB);
	expect(masked?.fix?.commands, describeIssues(base)).toBeDefined();
	const draft = {
		feature: 'sound-design',
		title: 'Fixes and a repeat',
		sequenceId: fx.b.seqId,
		items: [
			{ id: 'gain', label: 'Lift the click', commands: masked!.fix!.commands },
			{
				id: 'rep',
				label: 'Another hit right after the first',
				commands: [
					{ type: 'soundCue.add', cues: [{ frame: 60, kind: 'cut', weight: 'support', source: 'agent', ref: '$q' }] },
					{
						type: 'soundDesign.place',
						cueId: '$q',
						layers: [{ mediaId: fx.ids.hitMedia, role: 'support', align: 'peak', ref: '$h' }],
					},
				],
			},
			{ id: 'bad', label: 'On a track that does not exist', commands: [{ type: 'track.update', trackId: 'A9', patch: { mute: true } }] },
			{
				id: 'name',
				label: 'Name the last hit',
				commands: [{ type: 'clip.update', clipId: fx.ids.clipC, patch: { name: 'The last hit' } }],
			},
		],
	};
	const r = await post(`/api/projects/${projectId}/proposals`, draft, AGENT_H);
	expect(r.statusCode, r.body).toBe(200);
	const proposal = ProposalCreateResponseSchema.parse(r.json()).proposal as Proposal;
	expect(proposal.items.map((i) => i.state)).toEqual(['pending', 'pending', 'invalid', 'pending']);
	return { fx, projectId, base, baseJob, masked: masked!, proposal };
}

describe('Sound Check of a proposal (P6-E5, real engine)', { timeout: 900_000 }, () => {
	it('fixes the MASKED and introduces the REPEAT, each with its item; nothing committed; deterministic; stored on the proposal', async () => {
		const { fx, projectId, base, baseJob, masked, proposal } = await maskedProposal();
		const before = await saved(projectId);
		const ev: EventEnvelope[] = [];
		(app.jasper.services.events as Broadcaster).subscribe((e) => {
			if (e.type === 'proposal.changed') ev.push(e);
		});
		const { job, result } = await check({ projectId, proposalId: proposal.id });
		const p = result.proposal!;
		expect(p.proposalId).toBe(proposal.id);
		expect(p.base).toBe('kept');
		expect(p.baseJobId).toBe(baseJob.id);
		expect(p.itemIds).toEqual(['gain', 'rep', 'name']);
		expect(p.skipped).toEqual([{ itemId: 'bad', state: 'invalid', reason: expect.stringMatching(/A9/) }]);
		const fixedCodes = [...new Set(p.delta.fixed.map((f) => f.code))].sort();
		const introducedCodes = [...new Set(p.delta.introduced.map((f) => f.code))].sort();
		const text = JSON.stringify(p.delta, null, 1);
		expect(fixedCodes, text).toEqual(['MASKED']);
		expect(introducedCodes, text).toEqual(['REPEAT']);
		expect(p.delta.fixed.find((f) => f.key === masked.id)).toMatchObject({ itemId: 'gain', itemIds: ['gain'] });
		const rep = p.delta.introduced[0]!;
		expect(rep.itemId).toBe('rep');
		expect(rep.clipIds).toContain(fx.ids.clipA);
		expect(p.delta.counts.MASKED).toEqual({ before: base.report.counts.MASKED, after: (base.report.counts.MASKED ?? 0) - 1 });
		expect(p.delta.counts.REPEAT).toEqual({ before: 0, after: 1 });
		expect(p.delta.items).toEqual([
			{ itemId: 'gain', fixes: [masked.id], introduces: [] },
			{ itemId: 'rep', fixes: [], introduces: [rep.key] },
		]);
		expect(p.delta.verdict.before).toBe(base.report.verdict);
		// nothing committed: the revision, the stored summary, the kept report
		const after = await saved(projectId);
		expect(after.revision).toBe(before.revision);
		expect(after.doc).toEqual(before.doc);
		expect(result.stored).toBe(false);
		const last = await post('/api/sound-design/check/last', { projectId }, AGENT_H);
		expect((last.json() as { jobId: string }).jobId).toBe(baseJob.id);
		// stored on the proposal; announced
		const got = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/proposals/${proposal.id}`, headers: AGENT_H });
		const stored = (got.json() as { proposal: Proposal }).proposal;
		expect((stored.report as { check: Record<string, unknown> }).check).toMatchObject({
			jobId: job.id,
			proposalId: proposal.id,
			sequenceId: fx.b.seqId,
			delta: { fixedCount: p.delta.fixedCount, introducedCount: 1 },
		});
		expect(stored.updatedAt).toBe(proposal.updatedAt);
		expect(ev.map((e) => (e.payload as { change: string }).change)).toContain('checked');
		// deterministic: the same delta again
		const again = (await check({ projectId, proposalId: proposal.id })).result;
		expect(again.proposal!.delta).toEqual(p.delta);
		expect(again.report.issues.map((i) => i.id)).toEqual(result.report.issues.map((i) => i.id));
		// only the gain item: the MASKED fixed, nothing introduced
		const one = (await check({ projectId, proposalId: proposal.id, itemIds: ['gain'] })).result.proposal!;
		expect(one.itemIds).toEqual(['gain']);
		expect(one.delta.introducedCount).toBe(0);
		expect(one.delta.fixed.map((f) => f.key)).toContain(masked.id);
	});

	it('invalid and stale items are skipped and listed; a fresh base when the kept report is stale; typed refusals', async () => {
		const { fx, projectId, proposal } = await maskedProposal();
		// the kept report goes stale (an edit of the mix): the base is run
		const e = await tx(projectId, [{ type: 'audio.setGain', clipIds: [fx.ids.clipA], mode: 'adjust', db: -0.5 }], EDITOR_H);
		expect(e.ok).toBe(true);
		const { job, result } = await check({ projectId, proposalId: proposal.id, itemIds: ['gain', 'bad'] });
		expect(result.proposal!.base).toBe('run');
		expect(result.proposal!.baseJobId).toBe(job.id);
		expect(result.proposal!.itemIds).toEqual(['gain']);
		expect(result.proposal!.skipped).toEqual([{ itemId: 'bad', state: 'invalid', reason: expect.stringMatching(/A9/) }]);
		// a stale item (the clip it names moved since): skipped with why
		const m = await tx(projectId, [{ type: 'clip.move', clipIds: [fx.ids.clipC], deltaFrames: 5 }], EDITOR_H);
		expect(m.ok, JSON.stringify(m.errors)).toBe(true);
		const st = (await check({ projectId, proposalId: proposal.id })).result.proposal!;
		expect(st.skipped.find((s) => s.itemId === 'name'), JSON.stringify(st.skipped)).toMatchObject({
			state: 'stale',
			reason: expect.stringMatching(/moved/),
		});
		expect(st.itemIds).not.toContain('name');
		// refusals
		const code = async (body: Record<string, unknown>) => {
			const r = await post('/api/sound-design/check', body);
			return `${r.statusCode} ${(r.json() as { code?: string }).code}`;
		};
		expect(await code({ projectId, proposalId: 'prp_0000000000000000' })).toBe('404 PROPOSAL_NOT_FOUND');
		expect(await code({ projectId, proposalId: proposal.id, store: true })).toBe('400 VALIDATION_FAILED');
		expect(await code({ projectId, itemIds: ['gain'] })).toBe('400 VALIDATION_FAILED');
		expect(await code({ projectId, proposalId: proposal.id, itemIds: ['nope'] })).toBe('404 NOT_FOUND');
		expect(await code({ projectId, proposalId: 'prp_x' })).toBe('400 VALIDATION_FAILED');
		expect(await code({ projectId, proposalId: proposal.id, sequenceId: 'seq_nope' })).toBe('400 VALIDATION_FAILED');
	});
});

describe('soundCheckDelta (pure)', () => {
	const f = (id: string, code: string, severity: 'error' | 'warning' | 'info', clipIds?: string[], cueId?: string) => ({
		id,
		code: code as never,
		severity,
		message: { key: id, params: [], text: id },
		...(clipIds ? { clipIds } : {}),
		...(cueId ? { cueId } : {}),
	});
	it('fixed / introduced by key, attributed to the items that touched their clips or cue; counts before / after', () => {
		const before = [f('MASKED:c1', 'MASKED', 'warning', ['c1']), f('LOUDNESS:mix', 'LOUDNESS', 'error')];
		const after = [f('LOUDNESS:mix', 'LOUDNESS', 'error'), f('REPEAT:c2', 'REPEAT', 'warning', ['c0', 'c2']), f('COVERAGE:k', 'COVERAGE', 'warning', undefined, 'q1')];
		const d = soundCheckDelta(
			before,
			after,
			[
				{ itemId: 'a', touched: new Set(['c1']) },
				{ itemId: 'b', touched: new Set(['c2', 'q1']) },
				{ itemId: 'c', touched: new Set(['c9']) },
			],
			{ before: 'fail', after: 'fail' },
		);
		expect(d.fixed.map((x) => [x.key, x.itemId, x.itemIds])).toEqual([['MASKED:c1', 'a', ['a']]]);
		expect(d.introduced.map((x) => [x.key, x.itemId])).toEqual([
			['REPEAT:c2', 'b'],
			['COVERAGE:k', 'b'],
		]);
		expect(d.counts).toEqual({
			COVERAGE: { before: 0, after: 1 },
			LOUDNESS: { before: 1, after: 1 },
			MASKED: { before: 1, after: 0 },
			REPEAT: { before: 0, after: 1 },
			error: { before: 1, after: 1 },
			warning: { before: 1, after: 2 },
		});
		expect(d.items).toEqual([
			{ itemId: 'a', fixes: ['MASKED:c1'], introduces: [] },
			{ itemId: 'b', fixes: [], introduces: ['REPEAT:c2', 'COVERAGE:k'] },
		]);
		expect([d.fixedCount, d.introducedCount]).toEqual([1, 2]);
		// a finding no item names (the whole mix): no item
		const g = soundCheckDelta([], [f('TRUE_PEAK:mix', 'TRUE_PEAK', 'error')], [{ itemId: 'a', touched: new Set(['c1']) }], {
			before: 'pass',
			after: 'fail',
		});
		expect(g.introduced[0]).toMatchObject({ itemId: null, itemIds: [] });
		expect(g.items).toEqual([]);
	});
});
