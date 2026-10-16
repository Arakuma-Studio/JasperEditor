// Proposal routes (spec 12 §2.5, §2.8, P3-R2): create (validated by dry run), list / get / revalidate, accept (one
// transaction, headless or live in the editor; all-or-nothing or partial; expected revision; stale items), the
// policy gate for agents vs the editor window, destructive items, reject / reopen / note / select / delete, events,
// the 50-proposal limit, concurrency, and deletion with the project.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	AGENT_NAME_HEADER,
	type EnvelopeJson,
	type EventEnvelope,
	ProposalAcceptResponseSchema,
	ProposalCreateResponseSchema,
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
	type TransactionResult,
} from '@jasper/project';
import { afterAll, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import type { Broadcaster } from '../src/events/broadcaster.ts';
import { closeApps, makeApp } from './helpers.ts';

afterAll(closeApps);

const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_proposals_0123456789abcdef';
const KEY = 'key_proposals_0123456789abcdef';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, [AGENT_NAME_HEADER]: 'sound-agent' };
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

type App = Awaited<ReturnType<typeof makeApp>>;
const MARKER = 'mrk_00000000000000M1';

function seed(app: App, opts: { agentsMayApply?: boolean } = {}) {
	const ids = createCounterIdSource(5);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Proposals', preset: 'hd-1080p-30' });
	const seqId = Object.keys(doc.sequences)[0]!;
	const r = applyTransaction(
		doc,
		{
			label: 'seed',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'marker.add', frame: 100, name: 'Hit', id: MARKER },
				...(opts.agentsMayApply ? [{ type: 'soundDesign.setSettings', agentsMayApply: true }] : []),
			],
		},
		{ ids, now: () => '2026-10-01T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	doc = r.document;
	const file = appdirPaths(app.appdir).projectFile(doc.projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(makeEnvelope(doc, { revision: 3, savedAt: '2026-10-01T00:00:00.000Z', platform: 'test' })),
	);
	return { projectId: doc.projectId, seqId, file };
}

function saved(file: string): { doc: ProjectDocument; revision: number } {
	const env = JSON.parse(readFileSync(file, 'utf8')) as EnvelopeJson;
	return { doc: loadProject(env).document, revision: env.revision };
}

function events(app: App) {
	const out: EventEnvelope[] = [];
	(app.jasper.services.events as Broadcaster).subscribe((e) => {
		if (e.type === 'proposal.changed') out.push(e);
	});
	return out;
}

const cue = (frame: number) => ({
	type: 'soundCue.add',
	cues: [{ frame, kind: 'cut', weight: 'support', source: 'agent', types: ['hit'] }],
});
function draft(seqId: string, extra: Record<string, unknown> = {}) {
	return {
		feature: 'sound-design',
		title: 'Sound pass',
		summary: 'four items',
		sequenceId: seqId,
		items: [
			{ id: 'cut', label: 'Hit on the cut', group: 'hero', commands: [cue(30)], meta: { why: 'cut' } },
			{
				id: 'mk',
				label: 'Rename the hit',
				commands: [{ type: 'marker.update', markerId: MARKER, name: 'Boom' }],
			},
			{
				id: 'trk',
				label: 'SFX track',
				commands: [{ type: 'track.add', kind: 'audio', name: 'SFX 1', ref: '$sfx' }],
			},
			{
				id: 'mute',
				label: 'Mute it',
				requires: ['trk'],
				commands: [{ type: 'track.update', trackId: '$sfx', patch: { mute: true } }],
				alternatives: [
					{
						label: 'Solo instead',
						commands: [{ type: 'track.update', trackId: '$sfx', patch: { solo: true } }],
					},
				],
			},
		],
		...extra,
	};
}

/** The user's own edit of the saved (headless) project, e.g. what undoing an accept leaves: saved as the next revision. */
function userEdit(file: string, seqId: string, commands: unknown[]) {
	const { doc, revision } = saved(file);
	const r = applyTransaction(
		doc,
		{ label: 'user edit', origin: 'user', sequenceId: seqId, commands },
		{
			ids: createCounterIdSource(900),
			now: () => '2026-10-02T00:00:00.000Z',
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
				savedAt: '2026-10-02T00:00:00.000Z',
				platform: 'test',
			}),
		),
	);
}

const base = (projectId: string) => `/api/projects/${projectId}/proposals`;
async function post(app: App, url: string, payload: unknown, headers: Record<string, string> = HOST) {
	return app.inject({ method: 'POST', url, headers: json(headers), payload: JSON.stringify(payload) });
}
async function create(app: App, projectId: string, d: unknown, headers: Record<string, string> = HOST) {
	const r = await post(app, base(projectId), d, headers);
	if (r.statusCode !== 200) throw new Error(r.body);
	return ProposalCreateResponseSchema.parse(r.json()).proposal as Proposal;
}
async function agentTx(
	app: App,
	projectId: string,
	commands: unknown[],
	headers: Record<string, string> = HOST,
) {
	const r = await post(
		app,
		'/api/agent/tx',
		{ projectId, transaction: { label: 'User edit', origin: { agent: 'other' }, commands } },
		headers,
	);
	expect(r.statusCode).toBe(200);
	return r.json() as { result: TransactionResult };
}

describe('proposal routes (headless)', () => {
	it('creates a proposal validated against the live document; lists, gets, and publishes proposal.changed', async () => {
		const app = await makeApp();
		const { projectId, seqId, file } = seed(app);
		const ev = events(app);
		const before = readFileSync(file, 'utf8');
		const r = await post(app, base(projectId), draft(seqId, { report: { events: 4 } }));
		expect(r.statusCode).toBe(200);
		const body = ProposalCreateResponseSchema.parse(r.json());
		const p = body.proposal;
		expect(p.id).toMatch(/^prp_[0-9A-Z]{16}$/);
		expect(p.author).toBe('user'); // an unsecured test engine treats every client as the editor
		expect(p.items.map((i) => i.state)).toEqual(['pending', 'pending', 'pending', 'pending']);
		expect(p.items[1]!.anchors).toEqual({ [MARKER]: 'marker:100:0' });
		expect(p.baseRevision).toBe(3);
		expect(body.revision).toBe(3);
		expect(body.evicted).toEqual([]);
		expect(Date.parse(body.expiresAt) - Date.parse(p.updatedAt)).toBe(30 * 86_400_000);
		expect(readFileSync(file, 'utf8')).toBe(before); // nothing applied
		expect(ev.map((e) => [e.type, (e.payload as { change: string }).change, e.projectId])).toEqual([
			['proposal.changed', 'created', projectId],
		]);
		const list = await app.inject({ method: 'GET', url: base(projectId), headers: HOST });
		expect(list.statusCode).toBe(200);
		expect(list.json()).toMatchObject({
			proposals: [
				{ id: p.id, itemCount: 4, counts: { pending: 4 }, decided: false, feature: 'sound-design' },
			],
			warnings: [],
		});
		const got = await app.inject({ method: 'GET', url: `${base(projectId)}/${p.id}`, headers: HOST });
		expect(got.json()).toMatchObject({ proposal: { id: p.id, report: { events: 4 } }, revision: null });
	});

	it('stores failing items invalid with the reason; refuses malformed drafts with typed errors', async () => {
		const app = await makeApp();
		const { projectId, seqId } = seed(app);
		const p = await create(app, projectId, {
			feature: 'sound-design',
			title: 'T',
			sequenceId: seqId,
			items: [
				{ id: 'a', label: 'A', commands: [{ type: 'track.update', trackId: 'A9', patch: { mute: true } }] },
				{ id: 'b', label: 'B', commands: [cue(5)], requires: ['a'] },
			],
		});
		expect(p.items.map((i) => [i.state, i.reason?.slice(0, 11)])).toEqual([
			['invalid', 'E_NOT_FOUND'],
			['invalid', 'requires it'],
		]);
		const bad = [
			[{ title: 'x', items: [] }, 400],
			[
				{
					...draft(seqId),
					items: [{ id: 'a', label: 'A', commands: [{ type: 'marker.add', frame: 1, frme: 2 }] }],
				},
				400,
			],
			[{ ...draft(seqId), sequenceId: 'seq_00000000000NOPE1' }, 400],
			[{ ...draft(seqId), extra: 1 }, 400],
			['nope', 400],
		] as const;
		for (const [d, status] of bad) {
			const r = await post(app, base(projectId), d);
			expect(r.statusCode, JSON.stringify(d)).toBe(status);
			expect(r.json().code).toBe('VALIDATION_FAILED');
		}
		const unknown = await post(app, base('prj_0000000000000NOPE'), draft(seqId));
		expect([unknown.statusCode, unknown.json().code]).toEqual([404, 'PROJECT_NOT_FOUND']);
		const badId = await app.inject({ method: 'GET', url: `${base(projectId)}/..%2F..%2Fx`, headers: HOST });
		expect([badId.statusCode, badId.json().code]).toEqual([404, 'PROPOSAL_NOT_FOUND']);
		const missing = await app.inject({
			method: 'GET',
			url: `${base(projectId)}/prp_0000000000000000`,
			headers: HOST,
		});
		expect(missing.statusCode).toBe(404);
	});

	it('accepts everything as ONE transaction (revision + 1, saved), records the decisions and refs', async () => {
		const app = await makeApp();
		const { projectId, seqId, file } = seed(app);
		const ev = events(app);
		const p = await create(app, projectId, draft(seqId));
		const r = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: 'all' });
		expect(r.statusCode, r.body).toBe(200);
		const body = ProposalAcceptResponseSchema.parse(r.json());
		expect(body.applied).toEqual(['cut', 'mk', 'trk', 'mute']);
		expect(body.appliedBy).toBe('headless');
		expect(body.revision).toBe(4);
		expect(body.result?.ok).toBe(true);
		const { doc, revision } = saved(file);
		expect(revision).toBe(4);
		const seq = doc.sequences[seqId]!;
		expect(seq.markers.find((m) => m.id === MARKER)!.name).toBe('Boom');
		expect(
			Object.values(
				(seq as { soundDesign?: { cues: Record<string, { frame: number }> } }).soundDesign!.cues,
			).map((c) => c.frame),
		).toEqual([30]);
		const sfx = seq.audioTracks.find((t) => t.name === 'SFX 1')!;
		expect(sfx.mute).toBe(true);
		expect(body.proposal.items.every((i) => i.state === 'accepted')).toBe(true);
		expect(body.proposal.items[2]!.applied).toMatchObject({ revision: 4, refs: { $sfx: sfx.id } });
		const change = ev.at(-1)!.payload as {
			change: string;
			itemIds: string[];
			revision: number;
			counts: object;
		};
		expect(change).toMatchObject({ change: 'accepted', revision: 4, counts: { accepted: 4, pending: 0 } });
		// accepting again applies nothing
		const again = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['cut'] });
		expect(again.json()).toMatchObject({ applied: [], skipped: ['cut'], result: null });
		expect(saved(file).revision).toBe(4);
	});

	it('partial accept applies the rest and reports stale items; all-or-nothing refuses (409 PROPOSAL_STALE)', async () => {
		const app = await makeApp();
		const { projectId, seqId, file } = seed(app);
		const p = await create(app, projectId, draft(seqId));
		// the user moves the marker the "mk" item is anchored to
		await agentTx(app, projectId, [{ type: 'marker.update', markerId: MARKER, frame: 120 }]);
		const strict = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: 'all' });
		expect(strict.statusCode).toBe(409);
		expect(strict.json()).toMatchObject({
			code: 'PROPOSAL_STALE',
			detail: {
				code: 'E_PROPOSAL_STALE',
				stale: [
					{
						itemId: 'mk',
						reason: 'The marker “Hit” at 00:00:03:10 moved to 00:00:04:00',
						problem: { type: 'anchor', id: MARKER, entity: 'marker', change: 'frame', at: 100, to: 120 },
					},
				],
			},
		});
		expect(saved(file).revision).toBe(4); // nothing applied
		const stored = await app.inject({ method: 'GET', url: `${base(projectId)}/${p.id}`, headers: HOST });
		expect(stored.json().proposal.items[1].state).toBe('stale');
		const partial = await post(app, `${base(projectId)}/${p.id}/accept`, {
			itemIds: ['mute', 'mk'],
			partial: true,
		});
		expect(partial.statusCode, partial.body).toBe(200);
		expect(partial.json()).toMatchObject({
			applied: ['trk', 'mute'],
			added: ['trk'],
			stale: [{ itemId: 'mk' }],
			revision: 5,
		});
		expect(partial.json().result.ok).toBe(true);
		// moved back: the item is pending again on revalidation and can be accepted
		await agentTx(app, projectId, [{ type: 'marker.update', markerId: MARKER, frame: 100 }]);
		const rv = await app.inject({
			method: 'GET',
			url: `${base(projectId)}/${p.id}?revalidate=1`,
			headers: HOST,
		});
		expect(rv.json()).toMatchObject({ revision: 6 });
		expect(rv.json().proposal.items.map((i: { state: string }) => i.state)).toEqual([
			'pending',
			'pending',
			'accepted',
			'accepted',
		]);
		const rest = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: 'all' });
		expect(rest.json()).toMatchObject({ applied: ['cut', 'mk'], revision: 7 });
		const bad = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['zz'] });
		expect([bad.statusCode, bad.json().detail.code]).toEqual([404, 'E_NOT_FOUND']);
	});

	it('expectedRevision: ahead → 409; behind with a conflicting edit → 409 REVISION_CONFLICT; behind otherwise fast-forwards', async () => {
		const app = await makeApp();
		const { projectId, seqId, file } = seed(app);
		const p = await create(app, projectId, {
			feature: 'sound-design',
			title: 'T',
			sequenceId: seqId,
			items: [
				{
					id: 'a2',
					label: 'Name A2',
					commands: [{ type: 'track.update', trackId: 'A2', patch: { name: 'Music' } }],
				},
				{ id: 'm', label: 'Marker', commands: [{ type: 'marker.add', frame: 7, name: 'x' }] },
			],
		});
		const ahead = await post(app, `${base(projectId)}/${p.id}/accept`, {
			itemIds: 'all',
			expectedRevision: 99,
		});
		expect([ahead.statusCode, ahead.json().code, ahead.json().detail.code]).toEqual([
			409,
			'REVISION_CONFLICT',
			'E_REVISION_MISMATCH',
		]);
		// someone renames A2 after the reviewer looked at revision 3
		await agentTx(app, projectId, [{ type: 'track.update', trackId: 'A2', patch: { name: 'Dialogue' } }]);
		const conflict = await post(app, `${base(projectId)}/${p.id}/accept`, {
			itemIds: ['a2'],
			expectedRevision: 3,
		});
		expect([conflict.statusCode, conflict.json().code, conflict.json().detail.code]).toEqual([
			409,
			'REVISION_CONFLICT',
			'E_REVISION_MISMATCH',
		]);
		expect(saved(file).revision).toBe(4);
		const ff = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['m'], expectedRevision: 3 });
		expect(ff.statusCode, ff.body).toBe(200);
		expect(ff.json().revision).toBe(5);
	});

	it('reject, note, select (validated on the document), reopen and delete; each publishes proposal.changed', async () => {
		const app = await makeApp();
		const { projectId, seqId, file } = seed(app);
		const ev = events(app);
		const p = await create(app, projectId, draft(seqId));
		const url = `${base(projectId)}/${p.id}`;
		const before = readFileSync(file, 'utf8');
		const rj = await post(app, `${url}/reject`, { itemIds: ['cut'] });
		expect(rj.json()).toMatchObject({ changed: ['cut'] });
		expect(readFileSync(file, 'utf8')).toBe(before); // rejecting leaves the document identical
		const note = await post(app, `${url}/note`, { itemId: 'cut', note: 'too early' });
		expect(note.json().proposal.items[0]).toMatchObject({ state: 'rejected', note: 'too early' });
		const sel = await post(app, `${url}/select`, { itemId: 'mute', alternative: 1 });
		expect(sel.statusCode, sel.body).toBe(200);
		expect(sel.json().proposal.items[3].selectedAlternative).toBe(1);
		expect((await post(app, `${url}/select`, { itemId: 'mute', alternative: 2 })).statusCode).toBe(400);
		expect((await post(app, `${url}/select`, { itemId: 'zz', alternative: 0 })).statusCode).toBe(404);
		expect((await post(app, `${url}/note`, { itemId: 'cut', note: 'x'.repeat(5000) })).statusCode).toBe(400);
		expect((await post(app, `${url}/reject`, { itemIds: [] })).statusCode).toBe(400);
		const acc = await post(app, `${url}/accept`, { itemIds: ['mute'] });
		expect(acc.json()).toMatchObject({ applied: ['trk', 'mute'] });
		const sfx = saved(file).doc.sequences[seqId]!.audioTracks.find((t) => t.name === 'SFX 1')!;
		expect([sfx.solo, sfx.mute]).toEqual([true, false]); // the selected alternative
		const noReject = await post(app, `${url}/reject`, { itemIds: ['mute'] });
		expect([noReject.statusCode, noReject.json().detail.code]).toEqual([400, 'E_INVALID_PARAM']);
		// While the accept is in the document its items cannot be reopened (accepting them again would apply them twice).
		const accepted = acc.json().proposal as Proposal;
		expect(accepted, acc.body).toBeDefined();
		expect(accepted.items[2]!.applied?.created).toContain(accepted.items[2]!.applied!.refs.$sfx);
		const held = await post(app, `${url}/reopen`, { itemIds: 'all' });
		expect([held.statusCode, held.json().code, held.json().detail.code]).toEqual([
			409,
			'PROPOSAL_STILL_APPLIED',
			'E_STILL_APPLIED',
		]);
		// After the accept is undone (here: what it created is gone), the review reopens with the note and the
		// selection intact.
		userEdit(file, seqId, [{ type: 'track.remove', trackIds: [accepted.items[2]!.applied!.refs.$sfx] }]);
		const re = await post(app, `${url}/reopen`, { itemIds: 'all' });
		expect(re.json().proposal.items.map((i: { state: string }) => i.state)).toEqual([
			'pending',
			'pending',
			'pending',
			'pending',
		]);
		expect(re.json().proposal.items[0].note).toBe('too early');
		expect(re.json().proposal.items[3].selectedAlternative).toBe(1);
		const del = await app.inject({ method: 'DELETE', url, headers: HOST });
		expect(del.json()).toEqual({ proposalId: p.id, deleted: true });
		expect((await app.inject({ method: 'DELETE', url, headers: HOST })).statusCode).toBe(404);
		expect(ev.map((e) => (e.payload as { change: string }).change)).toEqual([
			'created',
			'rejected',
			'noted',
			'selected',
			'accepted',
			'reopened',
			'deleted',
		]);
	});

	it('reopen of an applied item: agents are refused; the editor only once the accept is out of the document', async () => {
		const app = await secured();
		const { projectId, seqId, file } = seed(app);
		const p = await create(app, projectId, draft(seqId), AGENT_H);
		const url = `${base(projectId)}/${p.id}`;
		const acc = await post(app, `${url}/accept`, { itemIds: ['mute'] }, EDITOR_H);
		expect(acc.statusCode, acc.body).toBe(200);
		const trackId = (acc.json().proposal as Proposal).items[2]!.applied!.refs.$sfx!;
		// an agent never reopens (an applied item, nor a decision of the user's), never notes or chooses alternatives
		const agentReopen = await post(app, `${url}/reopen`, { itemIds: ['trk'] }, AGENT_H);
		expect([agentReopen.statusCode, agentReopen.json().detail.code]).toEqual([403, 'E_APPROVAL_REQUIRED']);
		const agentAll = await post(app, `${url}/reopen`, { itemIds: 'all' }, AGENT_H);
		expect(agentAll.statusCode).toBe(403);
		const agentNote = await post(app, `${url}/note`, { itemId: 'cut', note: 'mine' }, AGENT_H);
		expect([agentNote.statusCode, agentNote.json().detail.code]).toEqual([403, 'E_APPROVAL_REQUIRED']);
		const agentSelect = await post(app, `${url}/select`, { itemId: 'mute', alternative: 1 }, AGENT_H);
		expect([agentSelect.statusCode, agentSelect.json().detail.code]).toEqual([403, 'E_APPROVAL_REQUIRED']);
		// the editor while the track is still there: refused, nothing changes
		const held = await post(app, `${url}/reopen`, { itemIds: ['trk', 'mute'] }, EDITOR_H);
		expect([held.statusCode, held.json().detail.code]).toEqual([409, 'E_STILL_APPLIED']);
		const still = await app.inject({ method: 'GET', url, headers: EDITOR_H });
		expect((still.json().proposal as Proposal).items.map((i) => i.state)).toEqual([
			'pending',
			'pending',
			'accepted',
			'accepted',
		]);
		// an agent may withdraw its undecided items (reject); the user reopens them
		expect((await post(app, `${url}/reject`, { itemIds: ['cut'] }, AGENT_H)).statusCode).toBe(200);
		expect((await post(app, `${url}/reopen`, { itemIds: ['cut'] }, AGENT_H)).statusCode).toBe(403);
		expect((await post(app, `${url}/reopen`, { itemIds: ['cut'] }, EDITOR_H)).statusCode).toBe(200);
		// the accept undone (the track it created is gone): the editor reopens it
		userEdit(file, seqId, [{ type: 'track.remove', trackIds: [trackId] }]);
		const re = await post(app, `${url}/reopen`, { itemIds: ['trk', 'mute'] }, EDITOR_H);
		expect(re.statusCode, re.body).toBe(200);
		expect((re.json().proposal as Proposal).items.map((i) => i.state)).toEqual([
			'pending',
			'pending',
			'pending',
			'pending',
		]);
		// accepting again applies it once more (it is out of the document, so no duplicate)
		const again = await post(app, `${url}/accept`, { itemIds: ['mute'] }, EDITOR_H);
		expect(again.json().applied).toEqual(['trk', 'mute']);
		// `applied` (the editor's Redo) is refused when the document does not have what the accept created
		const re2 = await post(app, `${url}/reopen`, { itemIds: ['trk'] }, EDITOR_H);
		expect(re2.statusCode).toBe(409);
	});

	it('keeps at most 50 proposals: refuses while all are under review, then evicts the oldest decided one', async () => {
		const app = await makeApp();
		const { projectId, seqId } = seed(app);
		const small = {
			feature: 'sound-design',
			title: 'P',
			sequenceId: seqId,
			items: [{ id: 'a', label: 'A', commands: [cue(3)] }],
		};
		const made: Proposal[] = [];
		for (let i = 0; i < 50; i++) made.push(await create(app, projectId, small));
		const full = await post(app, base(projectId), small);
		expect([full.statusCode, full.json().code, full.json().detail.code]).toEqual([
			409,
			'PROPOSAL_LIMIT',
			'E_PROPOSAL_LIMIT',
		]);
		await post(app, `${base(projectId)}/${made[7]!.id}/reject`, { itemIds: 'all' });
		const next = await post(app, base(projectId), small);
		expect(next.statusCode).toBe(200);
		expect(next.json().evicted).toEqual([made[7]!.id]);
	}, 120_000);

	it('deletes proposals with the project', async () => {
		const app = await makeApp();
		const { projectId, seqId } = seed(app);
		await create(app, projectId, draft(seqId));
		const dir = appdirPaths(app.appdir).projectProposalsDir(projectId);
		expect(() => readFileSync(join(dir, '..', 'project.jasper'))).not.toThrow();
		const r = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: HOST });
		expect(r.statusCode).toBe(200);
		const list = await app.inject({ method: 'GET', url: base(projectId), headers: HOST });
		expect(list.statusCode).toBe(404);
	});

	it('concurrent accepts of the same items apply once; an accept racing an edit never loses either', async () => {
		const app = await makeApp();
		const { projectId, seqId, file } = seed(app);
		const p = await create(app, projectId, draft(seqId));
		const [a, b] = await Promise.all([
			post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['trk', 'mute'] }),
			post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['trk', 'mute'] }),
		]);
		const applied = [a.json().applied, b.json().applied].sort((x, y) => y.length - x.length);
		expect(applied).toEqual([['trk', 'mute'], []]);
		expect(saved(file).doc.sequences[seqId]!.audioTracks.filter((t) => t.name === 'SFX 1')).toHaveLength(1);
		const [acc, edit] = await Promise.all([
			post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['cut'] }),
			agentTx(app, projectId, [{ type: 'marker.add', frame: 300, name: 'Edit' }]),
		]);
		expect(acc.statusCode, acc.body).toBe(200);
		expect(edit.result.ok).toBe(true);
		const seq = saved(file).doc.sequences[seqId]!;
		expect(seq.markers.some((m) => m.name === 'Edit')).toBe(true);
		expect(Object.keys((seq as { soundDesign?: { cues: object } }).soundDesign!.cues)).toHaveLength(1);
		expect(saved(file).revision).toBe(6);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Policy gate: agents vs the editor window (security review AGT-2/3), live and headless.

type Msg = Record<string, unknown>;
/** A stand-in for the editor window's session: answers doc.get and applies relayed transactions. */
async function liveEditor(app: App, projectId: string, file: string, headers: Record<string, string>) {
	let { doc, revision } = saved(file);
	const ids = createCounterIdSource(9000);
	const ws: WebSocket = await app.injectWS('/agent', { headers });
	const txs: Msg[] = [];
	const cards: { approvalId: string; answerKey: string }[] = [];
	let welcome: () => void = () => {};
	const welcomed = new Promise<void>((r) => {
		welcome = r;
	});
	ws.on('message', (d) => {
		const m = JSON.parse(String(d)) as Msg;
		if (m.type === 'welcome') welcome();
		if (m.type === 'event' && m.event === 'agent.approval.requested') cards.push(m.payload as never);
		if (m.type !== 'request') return;
		const payload = m.payload as {
			query?: string;
			transaction?: Record<string, unknown>;
			approved?: boolean;
			asUser?: boolean;
		};
		if (m.kind === 'query') {
			ws.send(JSON.stringify({ type: 'response', id: m.id, result: { result: doc, revision } }));
			return;
		}
		txs.push(payload as Msg);
		const t = payload.transaction!;
		const r = applyTransaction(
			doc,
			{ ...t, ...(payload.asUser ? { origin: 'user' } : {}) },
			{
				ids,
				now: () => '2026-10-16T00:00:00.000Z',
				revision,
				registries: defaultRegistries(),
			},
		);
		if (r.result.ok && r.document !== doc) {
			doc = r.document;
			revision = r.result.revision;
		}
		ws.send(JSON.stringify({ type: 'response', id: m.id, result: r.result }));
	});
	ws.send(JSON.stringify({ type: 'hello', projectId, sessionId: 'ses_live', leaseId: 'lease_live' }));
	await welcomed;
	const answer = (card: { approvalId: string; answerKey: string }, decision: 'approved' | 'denied') =>
		ws.send(
			JSON.stringify({
				type: 'event',
				event: 'agent.approval.resolve',
				payload: { approvalId: card.approvalId, decision, answerKey: card.answerKey },
			}),
		);
	return {
		ws,
		txs,
		cards,
		answer,
		get doc() {
			return doc;
		},
	};
}

const secured = () => makeApp({ dev: false, token: TOKEN, editorKey: KEY });
const until = async (pred: () => boolean, ms = 5000) => {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error('timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
};

describe('accept policy: agents vs the editor window', () => {
	it('refuses an agent with 403 APPROVAL_REQUIRED unless the sequence allows agents; the editor needs nothing extra', async () => {
		const app = await secured();
		const { projectId, seqId, file } = seed(app);
		const p = await create(app, projectId, draft(seqId), AGENT_H);
		expect(p.author).toEqual({ agent: 'sound-agent' });
		// an agent cannot claim to be the user
		const forged = await create(app, projectId, { ...draft(seqId), author: 'user' }, AGENT_H);
		expect(forged.author).toEqual({ agent: 'sound-agent' });
		const refused = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: 'all' }, AGENT_H);
		expect(refused.statusCode).toBe(403);
		expect(refused.json()).toMatchObject({
			code: 'APPROVAL_REQUIRED',
			detail: { code: 'E_APPROVAL_REQUIRED', feature: 'sound-design' },
		});
		expect(saved(file).revision).toBe(3);
		// the agent cannot grant itself the permission headlessly either (soundDesign.setSettings agentsMayApply)
		const grant = await agentTx(
			app,
			projectId,
			[{ type: 'soundDesign.setSettings', agentsMayApply: true }],
			AGENT_H,
		);
		expect(grant.result).toMatchObject({ ok: false, errors: [{ code: 'E_APPROVAL_DENIED' }] });
		// the editor window accepts (as the user's own edit)
		const ok = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['cut'] }, EDITOR_H);
		expect(ok.statusCode, ok.body).toBe(200);
		expect(saved(file).revision).toBe(4);
	});

	it('applied (a Redo of an undone accept): the editor records it, an agent is refused, nothing is applied', async () => {
		const app = await secured();
		const { projectId, seqId, file } = seed(app);
		const p = await create(app, projectId, draft(seqId), AGENT_H);
		const seen = events(app);
		const url = `${base(projectId)}/${p.id}/applied`;
		const body = { itemIds: ['trk', 'mute'], revision: 9, refs: { $sfx: 'trk_0000000000000099' } };
		const refused = await post(app, url, body, AGENT_H);
		expect(refused.statusCode).toBe(403);
		expect(refused.json()).toMatchObject({
			code: 'APPROVAL_REQUIRED',
			detail: { code: 'E_APPROVAL_REQUIRED' },
		});
		expect((await post(app, url, { ...body, itemIds: ['nope'] }, EDITOR_H)).statusCode).toBe(404);
		expect((await post(app, url, { ...body, refs: { $sfx: '../etc' } }, EDITOR_H)).json()).toMatchObject({
			code: 'VALIDATION_FAILED',
		});
		expect((await post(app, url, { ...body, extra: 1 }, EDITOR_H)).statusCode).toBe(400);
		// the Redo must have put back what the accept created: else nothing is recorded
		const absent = await post(app, url, { ...body, created: ['trk_0000000000000099'] }, EDITOR_H);
		expect([absent.statusCode, absent.json().code, absent.json().detail.code]).toEqual([
			409,
			'PROPOSAL_NOT_APPLIED',
			'E_NOT_APPLIED',
		]);
		const ok = await post(app, url, body, EDITOR_H);
		expect(ok.statusCode, ok.body).toBe(200);
		const out = ok.json() as { proposal: Proposal; changed: string[] };
		expect(out.changed).toEqual(['trk', 'mute']);
		const trk = out.proposal.items.find((i) => i.id === 'trk')!;
		expect(trk).toMatchObject({
			state: 'accepted',
			applied: { revision: 9, refs: { $sfx: 'trk_0000000000000099' } },
		});
		expect(saved(file).revision).toBe(3);
		expect(seen.at(-1)?.payload).toMatchObject({ change: 'accepted', itemIds: ['trk', 'mute'], revision: 9 });
		// again: already accepted items are left alone
		const again = await post(app, url, body, EDITOR_H);
		expect((again.json() as { changed: string[] }).changed).toEqual([]);
		// a later item requiring `trk` composes with the recorded ref
		const reopened = await post(app, `${base(projectId)}/${p.id}/reopen`, { itemIds: ['mute'] }, EDITOR_H);
		expect(reopened.statusCode).toBe(200);
	});

	it('an agent polling a proposal (wait_for_proposal) is announced and listed as waiting; the editor and revalidating reads are not', async () => {
		const app = await secured();
		const { projectId, seqId } = seed(app);
		const p = await create(app, projectId, draft(seqId), AGENT_H);
		const ev = events(app);
		const read = (h: Record<string, string>, q = '') =>
			app.inject({ method: 'GET', url: `${base(projectId)}/${p.id}${q}`, headers: h });
		const listed = async () =>
			(
				(await app.inject({ method: 'GET', url: base(projectId), headers: EDITOR_H })).json() as {
					proposals: { id: string; waiting?: unknown }[];
				}
			).proposals.find((x) => x.id === p.id)?.waiting ?? null;
		// the editor's own reads and an agent's get_proposal (revalidating) are not a wait
		for (let i = 0; i < 3; i++) expect((await read(EDITOR_H)).statusCode).toBe(200);
		for (let i = 0; i < 3; i++) expect((await read(AGENT_H, '?revalidate=1')).statusCode).toBe(200);
		expect(await listed()).toBeNull();
		expect(ev.filter((e) => (e.payload as { change: string }).change === 'waiting')).toEqual([]);
		// one plain read: not yet; the second (a poll) → waiting, announced once
		await read(AGENT_H);
		expect(await listed()).toBeNull();
		await read(AGENT_H);
		await read(AGENT_H);
		const waiting = await listed();
		expect(waiting).toMatchObject({ agent: 'sound-agent' });
		expect(Date.parse((waiting as { since: string }).since)).toBeGreaterThan(0);
		const w = ev.filter((e) => (e.payload as { change: string }).change === 'waiting');
		expect(w.map((e) => e.payload)).toEqual([{ projectId, proposalId: p.id, change: 'waiting', waiting }]);
		// deleting it ends the wait without an announcement
		await app.inject({ method: 'DELETE', url: `${base(projectId)}/${p.id}`, headers: EDITOR_H });
		expect(ev.filter((e) => (e.payload as { change: string }).change === 'waiting')).toHaveLength(1);
	});

	it('lets an agent accept where agentsMayApply is on; other features keep refusing', async () => {
		const app = await secured();
		const { projectId, seqId, file } = seed(app, { agentsMayApply: true });
		const p = await create(app, projectId, draft(seqId), AGENT_H);
		const ok = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['cut'] }, AGENT_H);
		expect(ok.statusCode, ok.body).toBe(200);
		expect(saved(file).revision).toBe(4);
		const other = await create(app, projectId, { ...draft(seqId), feature: 'color-pass' }, AGENT_H);
		const refused = await post(app, `${base(projectId)}/${other.id}/accept`, { itemIds: ['cut'] }, AGENT_H);
		expect([refused.statusCode, refused.json().detail.code]).toEqual([403, 'E_APPROVAL_REQUIRED']);
		const byEditor = await post(app, `${base(projectId)}/${other.id}/accept`, { itemIds: ['cut'] }, EDITOR_H);
		expect(byEditor.statusCode).toBe(200);
	});

	it('destructive items: an allowed agent still needs the approval card (headless → APPROVAL_DENIED); the editor does not', async () => {
		const app = await secured();
		const { projectId, seqId, file } = seed(app, { agentsMayApply: true });
		const destructive = {
			feature: 'sound-design',
			title: 'Clean up',
			sequenceId: seqId,
			items: [{ id: 'rm', label: 'Remove A3', commands: [{ type: 'track.remove', trackIds: ['A3'] }] }],
		};
		const p = await create(app, projectId, destructive, AGENT_H);
		const headless = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: 'all' }, AGENT_H);
		expect([headless.statusCode, headless.json().code, headless.json().detail.code]).toEqual([
			403,
			'APPROVAL_DENIED',
			'E_APPROVAL_DENIED',
		]);
		expect(saved(file).revision).toBe(3);
		const stillPending = await app.inject({
			method: 'GET',
			url: `${base(projectId)}/${p.id}`,
			headers: AGENT_H,
		});
		expect(stillPending.json().proposal.items[0].state).toBe('pending');
		const byEditor = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: 'all' }, EDITOR_H);
		expect(byEditor.statusCode, byEditor.body).toBe(200);
		expect(saved(file).doc.sequences[seqId]!.audioTracks).toHaveLength(2);
	});

	it("live: accept goes to the open editor as ONE transaction; the editor's accept is the user's, an agent's waits for the card", async () => {
		const app = await secured();
		const { projectId, seqId, file } = seed(app, { agentsMayApply: true });
		const editor = await liveEditor(app, projectId, file, EDITOR_H);
		const p = await create(app, projectId, draft(seqId), AGENT_H);
		// the editor's own accept: relayed pre-approved as the user's edit, one History entry
		const mine = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['mute'] }, EDITOR_H);
		expect(mine.statusCode, mine.body).toBe(200);
		expect(mine.json()).toMatchObject({ appliedBy: 'session', applied: ['trk', 'mute'], revision: 4 });
		expect(editor.txs).toHaveLength(1);
		expect(editor.txs[0]).toMatchObject({
			approved: true,
			asUser: true,
			transaction: { label: 'Accept Sound pass (2 of 4)' },
		});
		expect(editor.doc.sequences[seqId]!.audioTracks.at(-1)!.mute).toBe(true);
		// an allowed agent's accept is relayed as the agent's
		const theirs = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['cut'] }, AGENT_H);
		expect(theirs.statusCode, theirs.body).toBe(200);
		expect(editor.txs[1]).toMatchObject({
			approved: false,
			transaction: { origin: { agent: 'sound-agent', runId: p.id } },
		});
		expect(editor.txs[1]!.asUser).toBeUndefined();
		// a destructive proposal accepted by the agent shows the card; denied → 403, approved → applied
		const rm = await create(
			app,
			projectId,
			{
				feature: 'sound-design',
				title: 'Remove',
				sequenceId: seqId,
				items: [{ id: 'rm', label: 'Remove A3', commands: [{ type: 'track.remove', trackIds: ['A3'] }] }],
			},
			AGENT_H,
		);
		const denied = post(app, `${base(projectId)}/${rm.id}/accept`, { itemIds: 'all' }, AGENT_H);
		await until(() => editor.cards.length === 1);
		editor.answer(editor.cards[0]!, 'denied');
		const d = await denied;
		expect([d.statusCode, d.json().code]).toEqual([403, 'APPROVAL_DENIED']);
		const tracksBefore = editor.doc.sequences[seqId]!.audioTracks.length;
		const approved = post(app, `${base(projectId)}/${rm.id}/accept`, { itemIds: 'all' }, AGENT_H);
		await until(() => editor.cards.length === 2);
		editor.answer(editor.cards[1]!, 'approved');
		const a = await approved;
		expect(a.statusCode, a.body).toBe(200);
		expect(editor.txs.at(-1)).toMatchObject({ approved: true });
		expect(editor.doc.sequences[seqId]!.audioTracks).toHaveLength(tracksBefore - 1);
		editor.ws.terminate();
	});
});
