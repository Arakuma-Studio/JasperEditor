// The accept journal (WP6.5b item 13): an accept writes an intent record before its transaction and removes it after
// the proposal's states are written; an engine that stopped in between (a crash, a lost relay answer) reconciles the
// intent with the document when the proposal is next read: applied → the items are recorded accepted (with the refs
// and created ids of what is there), not applied → the intent is rolled back and the items stay as they were. Either
// way an item is never applied twice.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { type EnvelopeJson, ProposalCreateResponseSchema } from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	createPresetIdSource,
	defaultRegistries,
	loadProject,
	makeEnvelope,
	type ProjectDocument,
	type Proposal,
} from '@jasper/project';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import type { AgentService } from '../src/agent/service.ts';
import {
	AcceptIntentSchema,
	idsWithBodies,
	prepareIntent,
	reconcileEvidence,
} from '../src/proposals/journal.ts';
import type { ProposalService } from '../src/proposals/service.ts';
import { closeApps, makeApp } from './helpers.ts';

afterAll(closeApps);

const TIMEOUT = 30_000 * Math.max(1, Math.ceil(loadavg()[0]! / Math.max(1, cpus().length)));
const HOST = { host: '127.0.0.1:47900' };
const json = { ...HOST, 'content-type': 'application/json' };
type App = Awaited<ReturnType<typeof makeApp>>;

function seed(app: App) {
	const ids = createCounterIdSource(5);
	const doc: ProjectDocument = createEmptyProject({ ids, name: 'Journal', preset: 'hd-1080p-30' });
	const seqId = Object.keys(doc.sequences)[0]!;
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

const draft = (seqId: string) => ({
	feature: 'sound-design',
	title: 'Journal pass',
	sequenceId: seqId,
	items: [
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
		},
		{ id: 'm1', label: 'Marker', commands: [{ type: 'marker.add', frame: 40, name: 'Hit' }] },
	],
});

const base = (projectId: string) => `/api/projects/${projectId}/proposals`;
const post = (app: App, url: string, payload: unknown) =>
	app.inject({ method: 'POST', url, headers: json, payload: JSON.stringify(payload) });
async function create(app: App, projectId: string, d: unknown): Promise<Proposal> {
	const r = await post(app, base(projectId), d);
	if (r.statusCode !== 200) throw new Error(r.body);
	return ProposalCreateResponseSchema.parse(r.json()).proposal as Proposal;
}
async function get(app: App, projectId: string, id: string): Promise<Proposal> {
	const r = await app.inject({ method: 'GET', url: `${base(projectId)}/${id}`, headers: HOST });
	expect(r.statusCode, r.body).toBe(200);
	return r.json().proposal as Proposal;
}
const states = (p: Proposal) => Object.fromEntries(p.items.map((i) => [i.id, i.state]));
const sfxTracks = (file: string, seqId: string) =>
	saved(file).doc.sequences[seqId]!.audioTracks.filter((t) => t.name === 'SFX 1');
const intentFiles = (app: App, projectId: string) => {
	const dir = appdirPaths(app.appdir).projectProposalsDir(projectId);
	return existsSync(dir) ? readdirSync(dir).filter((n) => n.includes('intent')) : [];
};
const proposals = (app: App) => app.jasper.services.proposals as ProposalService;

/** The engine "stops" (the app closes) and starts again on the same appdir. */
async function restart(app: App): Promise<App> {
	await app.close();
	return makeApp({ appdir: app.appdir });
}

describe('accept journal: a crash between the transaction and the state write', { timeout: TIMEOUT }, () => {
	it('headless: the transaction was saved, the states were not → after a restart the items are accepted, never applied twice', async () => {
		let app = await makeApp();
		const { projectId, seqId, file } = seed(app);
		const p = await create(app, projectId, draft(seqId));
		// the kill point: the write of the accepted states never happens (the engine dies right after the transaction)
		const store = proposals(app).store;
		const put = store.put.bind(store);
		let killed = false;
		store.put = async (pid, next) => {
			if (!killed && next.items.some((i) => i.state === 'accepted')) {
				killed = true;
				throw new Error('engine killed after the transaction');
			}
			return put(pid, next);
		};
		const r = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['mute'] });
		expect(killed).toBe(true);
		expect(r.statusCode).toBeGreaterThanOrEqual(500);
		expect(saved(file).revision).toBe(4); // the transaction is in the saved project
		expect(sfxTracks(file, seqId)).toHaveLength(1);

		app = await restart(app);
		const list = await app.inject({ method: 'GET', url: base(projectId), headers: HOST });
		expect(list.statusCode, list.body).toBe(200);
		expect(list.json().proposals[0].counts).toMatchObject({ accepted: 2, pending: 1 });
		const after = await get(app, projectId, p.id);
		expect(states(after)).toEqual({ trk: 'accepted', mute: 'accepted', m1: 'pending' });
		const track = sfxTracks(file, seqId)[0]!;
		expect(after.items[0]!.applied).toMatchObject({ refs: { $sfx: track.id } });
		expect(after.items[0]!.applied!.created).toContain(track.id);
		expect(intentFiles(app, projectId)).toEqual([]);
		// accepting everything now applies only the marker: the track is not added a second time
		const again = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: 'all' });
		expect(again.statusCode, again.body).toBe(200);
		expect(again.json().applied).toEqual(['m1']);
		expect(sfxTracks(file, seqId)).toHaveLength(1);
		// and the reopen guard knows what the recovered accept created
		const reopen = await post(app, `${base(projectId)}/${p.id}/reopen`, { itemIds: ['trk'] });
		expect([reopen.statusCode, reopen.json().code]).toEqual([409, 'PROPOSAL_STILL_APPLIED']);
	});

	it('headless: the engine stopped before the transaction → the intent is rolled back; the items apply once', async () => {
		let app = await makeApp();
		const { projectId, seqId, file } = seed(app);
		const p = await create(app, projectId, draft(seqId));
		const agent = app.jasper.services.agent as AgentService;
		const transact = agent.transact.bind(agent);
		let killed = false;
		agent.transact = async (...args) => {
			if (!killed) {
				killed = true;
				throw new Error('engine killed before the transaction');
			}
			return transact(...args);
		};
		const r = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['mute'] });
		expect(r.statusCode).toBeGreaterThanOrEqual(500);
		expect(saved(file).revision).toBe(3);

		app = await restart(app);
		const after = await get(app, projectId, p.id);
		expect(states(after)).toEqual({ trk: 'pending', mute: 'pending', m1: 'pending' });
		expect(intentFiles(app, projectId)).toEqual([]);
		const again = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['mute'] });
		expect(again.statusCode, again.body).toBe(200);
		expect(again.json().applied).toEqual(['trk', 'mute']);
		expect(sfxTracks(file, seqId)).toHaveLength(1);
		expect(saved(file).revision).toBe(4);
	});
});

type Msg = Record<string, unknown>;

/**
 * An editor window's session: answers doc.get and applies relayed transactions with the ids the engine sends (as the
 * agent bridge does). `dropAnswer`: it applies the next transaction and disconnects without answering; `ignoreTx`: it
 * disconnects as a transaction reaches it, without applying it.
 */
async function editorWindow(app: App, projectId: string, start: { doc: ProjectDocument; revision: number }) {
	let { doc, revision } = start;
	const ids = createCounterIdSource(9000);
	const ws: WebSocket = await app.injectWS('/agent', { headers: HOST });
	const state = { dropAnswer: false, ignoreTx: false, txs: 0 };
	let welcome: () => void = () => {};
	const welcomed = new Promise<void>((r) => {
		welcome = r;
	});
	ws.on('message', (d) => {
		const m = JSON.parse(String(d)) as Msg;
		if (m.type === 'welcome') welcome();
		if (m.type !== 'request') return;
		const payload = m.payload as { transaction?: Record<string, unknown>; asUser?: boolean; ids?: string[] };
		if (m.kind === 'query') {
			ws.send(JSON.stringify({ type: 'response', id: m.id, result: { result: doc, revision } }));
			return;
		}
		state.txs++;
		if (state.ignoreTx) {
			ws.terminate();
			return;
		}
		const r = applyTransaction(
			doc,
			{ ...payload.transaction, ...(payload.asUser ? { origin: 'user' } : {}) },
			{
				ids: payload.ids ? createPresetIdSource(payload.ids, ids) : ids,
				now: () => '2026-10-16T00:00:00.000Z',
				revision,
				registries: defaultRegistries(),
			},
		);
		if (r.result.ok && r.document !== doc) {
			doc = r.document;
			revision = r.result.revision;
		}
		if (state.dropAnswer) {
			ws.terminate();
			return;
		}
		ws.send(JSON.stringify({ type: 'response', id: m.id, result: r.result }));
	});
	ws.send(JSON.stringify({ type: 'hello', projectId, sessionId: 'ses_journal', leaseId: 'lease_journal' }));
	await welcomed;
	return {
		ws,
		state,
		get doc() {
			return doc;
		},
		get revision() {
			return revision;
		},
	};
}

describe('accept journal: a lost relay answer', { timeout: TIMEOUT }, () => {
	it('the editor applied the accept and disconnected before answering → pending while it is away, accepted once it is back', async () => {
		const app = await makeApp();
		const { projectId, seqId, file } = seed(app);
		// the editor window holds the project's lease (it may come back with edits it has not saved)
		const lease = await post(app, `/api/projects/${projectId}/lease`, {
			sessionId: '00000000-0000-4000-8000-0000000000aa',
		});
		expect(lease.statusCode, lease.body).toBe(200);
		const editor = await editorWindow(app, projectId, saved(file));
		const p = await create(app, projectId, draft(seqId));
		editor.state.dropAnswer = true;
		const r = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['mute'] });
		expect([r.statusCode, r.json().code]).toEqual([409, 'NO_SESSION']);
		expect(editor.state.txs).toBe(1);
		const applied = editor.doc;
		expect(applied.sequences[seqId]!.audioTracks.filter((t) => t.name === 'SFX 1')).toHaveLength(1);
		expect(intentFiles(app, projectId)).toHaveLength(1);
		// away: the saved project does not have it, the window may still: nothing is decided, accepting again waits
		expect(states(await get(app, projectId, p.id))).toEqual({
			trk: 'pending',
			mute: 'pending',
			m1: 'pending',
		});
		const again = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['mute'] });
		expect([again.statusCode, again.json().code, again.json().detail?.retryable]).toEqual([
			409,
			'NO_SESSION',
			true,
		]);
		expect(intentFiles(app, projectId)).toHaveLength(1);
		// the window is back with the accept in its document
		const back = await editorWindow(app, projectId, { doc: applied, revision: editor.revision });
		const after = await get(app, projectId, p.id);
		expect(states(after)).toEqual({ trk: 'accepted', mute: 'accepted', m1: 'pending' });
		const track = applied.sequences[seqId]!.audioTracks.find((t) => t.name === 'SFX 1')!;
		expect(after.items[0]!.applied!.refs).toEqual({ $sfx: track.id });
		expect(intentFiles(app, projectId)).toEqual([]);
		const all = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: 'all' });
		expect(all.statusCode, all.body).toBe(200);
		expect(all.json().applied).toEqual(['m1']);
		expect(back.doc.sequences[seqId]!.audioTracks.filter((t) => t.name === 'SFX 1')).toHaveLength(1);
		back.ws.terminate();
	});

	it('the editor did not apply it and the window is gone (its lease expired) → rolled back from the saved project', async () => {
		const app = await makeApp();
		const { projectId, seqId, file } = seed(app);
		const editor = await editorWindow(app, projectId, saved(file));
		const p = await create(app, projectId, draft(seqId));
		// the window disconnects as the transaction reaches it (it never applies it); no lease is held
		editor.state.ignoreTx = true;
		const r = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['mute'] });
		expect([r.statusCode, r.json().code]).toEqual([409, 'NO_SESSION']);
		expect(intentFiles(app, projectId)).toHaveLength(1);
		const after = await get(app, projectId, p.id);
		expect(states(after)).toEqual({ trk: 'pending', mute: 'pending', m1: 'pending' });
		expect(intentFiles(app, projectId)).toEqual([]);
		expect(sfxTracks(file, seqId)).toHaveLength(0);
		// accepting again (headless now) applies the items once
		const again = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: ['mute'] });
		expect(again.statusCode, again.body).toBe(200);
		expect(again.json()).toMatchObject({ applied: ['trk', 'mute'], appliedBy: 'headless' });
		expect(sfxTracks(file, seqId)).toHaveLength(1);
	});
});

describe('accept journal: evidence and hostile intent files', { timeout: TIMEOUT }, () => {
	const REG = defaultRegistries();
	const docWithTrack = () => {
		const ids = createCounterIdSource(50);
		const doc = createEmptyProject({ ids, name: 'J', preset: 'hd-1080p-30' });
		const seqId = Object.keys(doc.sequences)[0]!;
		const r = applyTransaction(
			doc,
			{
				label: 'seed',
				origin: 'user',
				sequenceId: seqId,
				commands: [{ type: 'track.add', kind: 'audio', name: 'Fx' }],
			},
			{ ids, now: () => 't', revision: 0, registries: REG },
		);
		const track = r.document.sequences[seqId]!.audioTracks.at(-1)!;
		return { doc: r.document, seqId, trackId: track.id, ids };
	};
	const meta = (registries = REG) => ({
		acceptId: 'acc_0000000000000001',
		projectId: 'prj_0000000000000001',
		proposalId: 'prp_0000000000000001',
		itemIds: ['a'],
		revision: 1,
		via: 'headless' as const,
		at: '2026-10-17T00:00:00.000Z',
		registries,
	});

	it('creates nothing: the fingerprints of what it changes tell applied / not applied / changed since', () => {
		const { doc, seqId, trackId, ids } = docWithTrack();
		const tx = {
			label: 'Accept',
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'track.update', trackId, patch: { mute: true } }],
		};
		const intent = prepareIntent(doc, tx, meta());
		expect(intent.dryRun).toBe('ok');
		expect(intent.created).toEqual([]);
		expect(intent.changes.map((c) => c.id)).toContain(trackId);
		expect(AcceptIntentSchema.safeParse(intent).success).toBe(true);
		expect(reconcileEvidence(doc, intent).applied).toBe(false);
		const ctx = { ids, now: () => 't', revision: 1, registries: REG };
		const applied = applyTransaction(doc, tx, ctx).document;
		expect(reconcileEvidence(applied, intent)).toEqual({ applied: true, created: [], refs: {} });
		const later = applyTransaction(
			applied,
			{
				label: 'user',
				origin: 'user',
				sequenceId: seqId,
				commands: [{ type: 'track.update', trackId, patch: { name: 'Renamed' } }],
			},
			{ ...ctx, revision: 2 },
		).document;
		expect(reconcileEvidence(later, intent).applied).toBe(false);
	});

	it('creates something: its journalled ids decide, whatever prefix the live transaction gave them', () => {
		const { doc, seqId } = docWithTrack();
		const tx = {
			label: 'Accept',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'track.add', kind: 'audio', name: 'SFX 1', ref: '$t' },
				{ type: 'marker.add', frame: 9 },
			],
		};
		const intent = prepareIntent(doc, tx, meta());
		expect(intent.ids.length).toBeGreaterThanOrEqual(2);
		expect(intent.created).toHaveLength(2);
		expect(intent.refs.$t).toBe(`trk_${intent.ids[0]}`);
		expect(reconcileEvidence(doc, intent).applied).toBe(false);
		// the live document had changed: the live transaction took the bodies in another order (marker first)
		const live = applyTransaction(
			doc,
			{ ...tx, commands: [tx.commands[1]!, tx.commands[0]!] },
			{
				ids: createPresetIdSource(intent.ids, createCounterIdSource(1)),
				now: () => 't',
				revision: 1,
				registries: REG,
			},
		).document;
		const ev = reconcileEvidence(live, intent);
		expect(ev.applied).toBe(true);
		if (ev.applied) expect(ev.created.sort()).toEqual(idsWithBodies(live, intent.ids).sort());
		expect(createPresetIdSource(['bad', intent.ids[0]!], createCounterIdSource(7)).next('clp')).toBe(
			`clp_${intent.ids[0]}`,
		);
	});

	it('an unreadable intent file is moved aside with a warning; nothing crashes and nothing is recorded', async () => {
		const app = await makeApp();
		const { projectId, seqId } = seed(app);
		const p = await create(app, projectId, draft(seqId));
		const dir = appdirPaths(app.appdir).projectProposalsDir(projectId);
		const samples = fc.sample(
			fc.oneof(
				fc.string(),
				fc.jsonValue().map((v) => JSON.stringify(v)),
				fc
					.record({ version: fc.constant(1), proposalId: fc.constant(p.id), ids: fc.array(fc.string()) })
					.map((v) => JSON.stringify(v)),
			),
			{ numRuns: 25, seed: 13 },
		);
		for (const text of samples) {
			writeFileSync(join(dir, `${p.id}.accept-intent`), text);
			const list = await app.inject({ method: 'GET', url: base(projectId), headers: HOST });
			expect(list.statusCode, list.body).toBe(200);
			expect(states(await get(app, projectId, p.id))).toEqual({
				trk: 'pending',
				mute: 'pending',
				m1: 'pending',
			});
			expect(existsSync(join(dir, `${p.id}.accept-intent`))).toBe(false);
		}
		expect(readdirSync(dir).filter((n) => n.includes('.accept-intent.corrupt-')).length).toBeGreaterThan(0);
		// the proposal still accepts normally
		const r = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: 'all' });
		expect(r.statusCode, r.body).toBe(200);
	});
});
