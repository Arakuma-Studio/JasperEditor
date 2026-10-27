// Proposals for new features (spec 15 §2.1, EA-001…EA-004) at the engine: the three workflow features' agent accept
// (Project Settings ▸ Agent Proposals, default on; off → 403 APPROVAL_REQUIRED; an agent cannot turn it back on;
// destructive items still need the approval card), the features listing, 413 PROPOSAL_TOO_LARGE with the range that
// fits, and "Refresh proposal" through a registered producer (stale items re-planned, nothing applied).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import {
	AGENT_NAME_HEADER,
	type EnvelopeJson,
	ProposalCreateResponseSchema,
	ProposalFeaturesResponseSchema,
	ProposalRefreshResponseSchema,
} from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	loadProject,
	makeEnvelope,
	type ProjectDocument,
	type Proposal,
} from '@jasper/project';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProposalService } from '../src/proposals/service.ts';
import { closeApps, makeApp } from './helpers.ts';

afterAll(closeApps);

const TIMEOUT = 20_000 * Math.max(1, Math.ceil(loadavg()[0]! / Math.max(1, cpus().length)));
const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_features_0123456789abcdefg';
const KEY = 'key_features_0123456789abcdefg';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, [AGENT_NAME_HEADER]: 'auto-agent' };
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });
type App = Awaited<ReturnType<typeof makeApp>>;

/** V1: two solids meeting at frame 60 (one cut), saved at revision 3. */
function seed(app: App, extra: unknown[] = []) {
	const ids = createCounterIdSource(5);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Automation', preset: 'hd-1080p-30' });
	const seqId = Object.keys(doc.sequences)[0]!;
	const r = applyTransaction(
		doc,
		{
			label: 'seed',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
				{ type: 'clip.addSolid', at: 60, duration: 60, track: 'V1', color: [0, 0, 1, 1], ref: '$b' },
				...extra,
			],
		},
		{ ids, now: () => '2026-10-25T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	doc = r.document;
	const file = appdirPaths(app.appdir).projectFile(doc.projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(makeEnvelope(doc, { revision: 3, savedAt: '2026-10-25T00:00:00.000Z', platform: 'test' })),
	);
	const seq = doc.sequences[seqId]!;
	const [a, b] = Object.values(seq.clips).sort((x, y) => x.start - y.start);
	return { projectId: doc.projectId, seqId, file, a: a!, b: b!, v1: a!.trackId };
}

function saved(file: string): { doc: ProjectDocument; revision: number } {
	const env = JSON.parse(readFileSync(file, 'utf8')) as EnvelopeJson;
	return { doc: loadProject(env).document, revision: env.revision };
}
/** The user's own edit of the saved project (headless), as the next revision. */
function userEdit(file: string, seqId: string, commands: unknown[]) {
	const { doc, revision } = saved(file);
	const r = applyTransaction(
		doc,
		{ label: 'user edit', origin: 'user', sequenceId: seqId, commands },
		{
			ids: createCounterIdSource(900),
			now: () => '2026-10-25T01:00:00.000Z',
			revision,
			registries: defaultRegistries(),
		},
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope(r.document, {
				revision: revision + 1,
				savedAt: '2026-10-25T01:00:00.000Z',
				platform: 'test',
			}),
		),
	);
}

const base = (projectId: string) => `/api/projects/${projectId}/proposals`;
const post = (app: App, url: string, payload: unknown, headers: Record<string, string> = HOST) =>
	app.inject({ method: 'POST', url, headers: json(headers), payload: JSON.stringify(payload) });
async function create(app: App, projectId: string, d: unknown, headers: Record<string, string>) {
	const r = await post(app, base(projectId), d, headers);
	if (r.statusCode !== 200) throw new Error(r.body);
	return ProposalCreateResponseSchema.parse(r.json()).proposal as Proposal;
}

const kit = (id: string, v1: string, frame: number, clipIds: string[]) => ({
	id,
	label: `Kit at ${frame}`,
	meta: { group: 'cut-kits', frame, anchorOn: { clips: clipIds, cuts: [{ trackId: v1, frame }] } },
	commands: [
		{
			type: 'clip.addAdjustmentBatch',
			trackId: 'V2',
			items: [
				{
					start: frame - 10,
					length: 20,
					effects: [
						{
							effectId: 'jasper.gaussian-blur',
							keyframes: {
								radius: [
									{ frame: 0, value: 0 },
									{ frame: 10, value: 40 },
									{ frame: 20, value: 0 },
								],
							},
						},
					],
				},
			],
		},
	],
});
const automation = (seqId: string, items: unknown[]) => ({
	feature: 'edit-automation',
	title: 'Decorate Cuts',
	sequenceId: seqId,
	items,
	report: { params: { kit: 'blur' } },
});
const secured = () => makeApp({ dev: false, token: TOKEN, editorKey: KEY });

describe('workflow features: agent accept (EA-001)', { timeout: TIMEOUT }, () => {
	it('an agent applies an edit-automation proposal by default (one Agent History step); off → refused', async () => {
		const app = await secured();
		const { projectId, seqId, file, a, b, v1 } = seed(app);
		const p = await create(app, projectId, automation(seqId, [kit('k60', v1, 60, [a.id, b.id])]), AGENT_H);
		expect(p.items[0]!.state).toBe('pending');
		const ok = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: 'all' }, AGENT_H);
		expect(ok.statusCode, ok.body).toBe(200);
		const after = saved(file);
		expect(after.revision).toBe(4);
		const adj = Object.values(after.doc.sequences[seqId]!.clips).filter((c) => c.kind === 'adjustment');
		expect(adj.map((c) => [c.start, c.duration])).toEqual([[50, 20]]);
		// the user turns it off: refused, with the setting named
		userEdit(file, seqId, [
			{ type: 'project.updateSettings', settings: { agentProposals: { 'edit-automation': false } } },
		]);
		const q = await create(app, projectId, automation(seqId, [kit('k2', v1, 60, [])]), AGENT_H);
		const refused = await post(app, `${base(projectId)}/${q.id}/accept`, { itemIds: 'all' }, AGENT_H);
		expect(refused.statusCode).toBe(403);
		expect(refused.json()).toMatchObject({
			code: 'APPROVAL_REQUIRED',
			detail: { code: 'E_APPROVAL_REQUIRED', feature: 'edit-automation' },
		});
		// the agent cannot turn it back on headlessly (approval needed → denied without an editor)
		const grant = await post(
			app,
			'/api/agent/tx',
			{
				projectId,
				transaction: {
					label: 'grant',
					commands: [
						{ type: 'project.updateSettings', settings: { agentProposals: { 'edit-automation': true } } },
					],
				},
			},
			AGENT_H,
		);
		expect(grant.json().result).toMatchObject({ ok: false, errors: [{ code: 'E_APPROVAL_DENIED' }] });
		// the editor applies it as the user's own edit
		const byEditor = await post(app, `${base(projectId)}/${q.id}/accept`, { itemIds: 'all' }, EDITOR_H);
		expect(byEditor.statusCode, byEditor.body).toBe(200);
	});

	it('lists the features with this project’s agent-accept state and whether they refresh', async () => {
		const app = await secured();
		const { projectId, seqId, file } = seed(app);
		userEdit(file, seqId, [
			{ type: 'project.updateSettings', settings: { agentProposals: { subtitles: false } } },
		]);
		const r = await app.inject({
			method: 'GET',
			url: `/api/projects/${projectId}/proposal-features`,
			headers: AGENT_H,
		});
		expect(r.statusCode, r.body).toBe(200);
		const { features } = ProposalFeaturesResponseSchema.parse(r.json());
		const by = Object.fromEntries(features.map((f) => [f.id, f]));
		expect(by['sound-design']!.agentAccept).toEqual({
			setting: 'sound-sequence',
			sequences: { [seqId]: false },
		});
		expect(by['edit-automation']!.agentAccept).toEqual({
			setting: 'project',
			allowed: true,
			default: true,
			explicit: false,
		});
		expect(by.subtitles!.agentAccept).toEqual({
			setting: 'project',
			allowed: false,
			default: true,
			explicit: true,
		});
		expect(by['transcript-cleanup']!.groups.map((g) => g.id)).toContain('retakes');
		// Editing automation (EA-020…EA-022) and Fix Transcript (SC-062) each provide a refresher.
		expect(by['edit-automation']!.refreshable).toBe(true);
		expect(by['transcript-correction']!.refreshable).toBe(true);
		const svc = app.jasper.services.proposals as ProposalService;
		// without its refresher the feature is not refreshable
		svc.registerRefresher('edit-automation', () => ({ items: [] }))();
		const none = ProposalFeaturesResponseSchema.parse(
			(
				await app.inject({
					method: 'GET',
					url: `/api/projects/${projectId}/proposal-features`,
					headers: AGENT_H,
				})
			).json(),
		);
		expect(none.features.find((f) => f.id === 'edit-automation')!.refreshable).toBe(false);
		const off = svc.registerRefresher('edit-automation', () => ({ items: [] }));
		const again = ProposalFeaturesResponseSchema.parse(
			(
				await app.inject({
					method: 'GET',
					url: `/api/projects/${projectId}/proposal-features`,
					headers: AGENT_H,
				})
			).json(),
		);
		expect(again.features.find((f) => f.id === 'edit-automation')!.refreshable).toBe(true);
		off();
	});
});

describe('E_TOO_LARGE (EA-004)', { timeout: TIMEOUT }, () => {
	it('refuses an over-cap draft with 413 PROPOSAL_TOO_LARGE naming what fits; nothing is stored', async () => {
		const app = await secured();
		const { projectId, seqId } = seed(app);
		const items = Array.from({ length: 11 }, (_, i) => ({
			id: `m${i}`,
			label: `Markers ${i}`,
			meta: { frame: i * 100 },
			commands: Array.from({ length: 500 }, (_, k) => ({ type: 'marker.add', frame: i * 100 + k })),
		}));
		const r = await post(
			app,
			base(projectId),
			{ feature: 'edit-automation', title: 'Huge', sequenceId: seqId, items },
			AGENT_H,
		);
		expect(r.statusCode).toBe(413);
		expect(r.json()).toMatchObject({
			code: 'PROPOSAL_TOO_LARGE',
			detail: { code: 'E_TOO_LARGE', fit: 10, suggestedRange: { start: 0, end: 1000 } },
		});
		const list = await app.inject({ method: 'GET', url: base(projectId), headers: AGENT_H });
		expect(list.json().proposals).toEqual([]);
	});
});

describe('Refresh proposal (EA-003)', { timeout: TIMEOUT }, () => {
	it('stale kit items are re-planned by the producer on the moved cut; nothing is applied', async () => {
		const app = await secured();
		const { projectId, seqId, file, a, b, v1 } = seed(app);
		const p = await create(
			app,
			projectId,
			automation(seqId, [
				kit('k60', v1, 60, [a.id, b.id]),
				{ id: 'mk', label: 'Marker', commands: [{ type: 'marker.add', frame: 5 }] },
			]),
			AGENT_H,
		);
		// no producer (the built-in one taken off): refused with a reason
		const svc = app.jasper.services.proposals as ProposalService;
		svc.registerRefresher('edit-automation', () => ({ items: [] }))();
		const none = await post(app, `${base(projectId)}/${p.id}/refresh`, { itemIds: 'stale' }, EDITOR_H);
		expect([none.statusCode, none.json().code, none.json().detail.code]).toEqual([
			409,
			'PROPOSAL_NOT_REFRESHABLE',
			'E_NOT_REFRESHABLE',
		]);
		// the user trims A and slides B: the cut moves to 50
		userEdit(file, seqId, [
			{ type: 'clip.trim', clipId: a.id, edge: 'out', deltaFrames: -10 },
			{ type: 'clip.move', clipIds: [b.id], deltaFrames: -10 },
		]);
		const calls: string[][] = [];
		svc.registerRefresher('edit-automation', ({ itemIds, doc, proposal }) => {
			calls.push(itemIds);
			expect((proposal.report as { params: unknown }).params).toEqual({ kit: 'blur' });
			const seq = doc.sequences[seqId]!;
			const [ca, cb] = Object.values(seq.clips)
				.filter((c) => c.trackId === v1)
				.sort((x, y) => x.start - y.start);
			const cut = ca!.start + ca!.duration;
			return { items: itemIds.map((id) => kit(id, v1, cut, [ca!.id, cb!.id])) };
		});
		const before = saved(file).revision;
		const r = await post(app, `${base(projectId)}/${p.id}/refresh`, { itemIds: 'stale' }, EDITOR_H);
		expect(r.statusCode, r.body).toBe(200);
		const out = ProposalRefreshResponseSchema.parse(r.json());
		expect(calls).toEqual([['k60']]);
		expect(out.refreshed).toEqual(['k60']);
		expect(out.stale).toEqual([]);
		const k = out.proposal.items.find((i) => i.id === 'k60')!;
		expect(k.state).toBe('pending');
		expect((k.meta as { frame: number }).frame).toBe(50);
		expect(saved(file).revision).toBe(before); // nothing applied
		// a decided item is never replaced
		await post(app, `${base(projectId)}/${p.id}/reject`, { itemIds: ['mk'] }, EDITOR_H);
		const decided = await post(app, `${base(projectId)}/${p.id}/refresh`, { itemIds: ['mk'] }, EDITOR_H);
		expect(decided.statusCode).toBe(400);
		// the re-planned item applies where the cut is now
		const ok = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['k60'] }, AGENT_H);
		expect(ok.statusCode, ok.body).toBe(200);
		const adj = Object.values(saved(file).doc.sequences[seqId]!.clips).filter((c) => c.kind === 'adjustment');
		expect(adj.map((c) => c.start)).toEqual([40]);
	});

	it('a producer that throws or returns junk is reported, never fatal', async () => {
		const app = await secured();
		const { projectId, seqId, file, a, b, v1 } = seed(app);
		const p = await create(app, projectId, automation(seqId, [kit('k60', v1, 60, [a.id, b.id])]), AGENT_H);
		userEdit(file, seqId, [{ type: 'clip.move', clipIds: [b.id], deltaFrames: 30 }]);
		const svc = app.jasper.services.proposals as ProposalService;
		const off = svc.registerRefresher('edit-automation', () => {
			throw new Error('planner exploded');
		});
		const r = await post(app, `${base(projectId)}/${p.id}/refresh`, { itemIds: 'stale' }, EDITOR_H);
		expect([r.statusCode, r.json().detail.code]).toEqual([422, 'E_REFRESH_FAILED']);
		off();
		svc.registerRefresher('edit-automation', () => ({ items: 'nope' }) as never);
		const junk = await post(app, `${base(projectId)}/${p.id}/refresh`, { itemIds: 'stale' }, EDITOR_H);
		expect([junk.statusCode, junk.json().detail.code]).toEqual([422, 'E_SCHEMA']);
		const bad = await post(app, `${base(projectId)}/${p.id}/refresh`, { itemIds: 'everything' }, EDITOR_H);
		expect(bad.statusCode).toBe(400);
	});
});

describe('per-item default selection (spec 17 SC-060 / SC-061)', { timeout: TIMEOUT }, () => {
	const fix = (id: string, frame: number, group: string, selected?: boolean) => ({
		id,
		label: `Fix ${id}`,
		meta: { group },
		...(selected !== undefined ? { selected } : {}),
		commands: [{ type: 'marker.add', frame, name: id }],
	});
	const markers = (file: string, seqId: string) =>
		saved(file)
			.doc.sequences[seqId]!.markers.map((m) => m.name)
			.sort();

	it('"all" takes selected items; an agent never takes the maybe group; named ids take any', async () => {
		const app = await secured();
		const { projectId, seqId, file } = seed(app);
		const draft = {
			feature: 'transcript-correction',
			title: 'Fix transcript',
			sequenceId: seqId,
			items: [
				fix('f1', 10, 'fix'),
				fix('s1', 20, 'spelling'),
				fix('m1', 30, 'maybe', false),
				// a maybe item stored selected (a caller set it): still never in an agent's "all"
				fix('m2', 40, 'maybe', true),
			],
		};
		const p = await create(app, projectId, draft, AGENT_H);
		// stored only when false (absent = selected)
		expect(p.items.map((it) => it.selected)).toEqual([undefined, undefined, false, undefined]);
		const r = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: 'all' }, AGENT_H);
		expect(r.statusCode, r.body).toBe(200);
		expect(r.json().applied).toEqual(['f1', 's1']);
		expect(markers(file, seqId)).toEqual(['f1', 's1']);
		// the agent names a Maybe item: applied
		const named = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['m1'] }, AGENT_H);
		expect(named.json().applied).toEqual(['m1']);
		// the editor's "all" takes the selected ones (m2), not the unselected
		const q = await create(
			app,
			projectId,
			{ ...draft, items: draft.items.map((x) => ({ ...x, id: `q${x.id}` })) },
			AGENT_H,
		);
		const ed = await post(app, `${base(projectId)}/${q.id}/accept`, { itemIds: 'all' }, EDITOR_H);
		expect(ed.statusCode, ed.body).toBe(200);
		expect(ed.json().applied).toEqual(['qf1', 'qs1', 'qm2']);
	});
});
