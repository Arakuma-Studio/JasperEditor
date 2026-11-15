// Spec 18 AF-PROP (engine): an agent's rough cut as a proposal. The `rough-cut` feature is listed with agent accept off
// by default (an agent's accept → 403 APPROVAL_REQUIRED until Project Settings ▸ Agent Proposals allows it); the
// editor applies it as ONE transaction; a conflicting user edit makes items stale; `allOrNothing` refuses a draft
// with any failing item (422 PROPOSAL_INVALID listing each failing index with its command error) and stores
// nothing; `expectedRevision` applies the fast-forward rule (S01:AGT-010) to every item.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import {
	AGENT_NAME_HEADER,
	type EnvelopeJson,
	ProposalCreateResponseSchema,
	ProposalFeaturesResponseSchema,
	ProposalResponseSchema,
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
	RoughCutInputSchema,
	roughCutDraft,
} from '@jasper/project';
import { afterAll, describe, expect, it } from 'vitest';
import { closeApps, editorCookie, makeApp, TEST_HOST } from './helpers.ts';

afterAll(closeApps);

const TIMEOUT = 20_000 * Math.max(1, Math.ceil(loadavg()[0]! / Math.max(1, cpus().length)));
const HOST = { host: TEST_HOST };
const TOKEN = 'tok_roughcut_0123456789abcdefg';
const KEY = 'key_roughcut_0123456789abcdefg';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, [AGENT_NAME_HEADER]: 'cut-agent' };
const EDITOR_H = { ...HOST, cookie: editorCookie(TOKEN, KEY) };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });
type App = Awaited<ReturnType<typeof makeApp>>;
const secured = () => makeApp({ dev: false, token: TOKEN, editorKey: KEY });

/** V1: A [0,60) B [60,120) C [120,180), saved at revision 3. */
function seed(app: App) {
	const ids = createCounterIdSource(5);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Rough', preset: 'hd-1080p-30' });
	const seqId = Object.keys(doc.sequences)[0]!;
	const r = applyTransaction(
		doc,
		{
			label: 'seed',
			origin: 'user',
			sequenceId: seqId,
			commands: [0, 60, 120].map((at, i) => ({
				type: 'clip.addSolid',
				at,
				duration: 60,
				track: 'V1',
				color: [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0, 1],
			})),
		},
		{ ids, now: () => '2026-10-31T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	doc = r.document;
	const file = appdirPaths(app.appdir).projectFile(doc.projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(makeEnvelope(doc, { revision: 3, savedAt: '2026-10-31T00:00:00.000Z', platform: 'test' })),
	);
	const [a, b, c] = Object.values(doc.sequences[seqId]!.clips).sort((x, y) => x.start - y.start);
	return { projectId: doc.projectId, seqId, file, a: a!, b: b!, c: c! };
}

function saved(file: string): { doc: ProjectDocument; revision: number } {
	const env = JSON.parse(readFileSync(file, 'utf8')) as EnvelopeJson;
	return { doc: loadProject(env).document, revision: env.revision };
}
function userEdit(file: string, seqId: string, commands: unknown[]) {
	const { doc, revision } = saved(file);
	const r = applyTransaction(
		doc,
		{ label: 'user edit', origin: 'user', sequenceId: seqId, commands },
		{
			ids: createCounterIdSource(900),
			now: () => '2026-10-31T01:00:00.000Z',
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
				savedAt: '2026-10-31T01:00:00.000Z',
				platform: 'test',
			}),
		),
	);
}

const base = (projectId: string) => `/api/projects/${projectId}/proposals`;
const post = (app: App, url: string, payload: unknown, headers: Record<string, string> = HOST) =>
	app.inject({ method: 'POST', url, headers: json(headers), payload: JSON.stringify(payload) });
const list = async (app: App, projectId: string) =>
	(await app.inject({ method: 'GET', url: base(projectId), headers: AGENT_H })).json().proposals as unknown[];

/** What `propose_edits` sends: the rough-cut draft, all-or-nothing. */
function roughCut(seqId: string, items: unknown[], extra: Record<string, unknown> = {}) {
	return {
		...roughCutDraft(
			RoughCutInputSchema.parse({
				sequenceId: seqId,
				title: 'Tight cut',
				strategy: 'Drop the weak middle take. Keep the opening and the ending.',
				items,
			}),
		),
		allOrNothing: true,
		...extra,
	};
}
async function create(app: App, projectId: string, draft: unknown) {
	const r = await post(app, base(projectId), draft, AGENT_H);
	if (r.statusCode !== 200) throw new Error(r.body);
	return ProposalCreateResponseSchema.parse(r.json()).proposal as Proposal;
}
const removeB = (b: string) => ({
	group: 'removed',
	beat: 'Middle take',
	quote: 'and then, uh, the thing',
	reason: 'Weaker read than the ending',
	commands: [{ type: 'clip.extract', clipIds: [b] }],
});
const trimA = (a: string, mode: 'ripple' | 'regular' = 'ripple') => ({
	group: 'selects',
	reason: 'Tighten the opening',
	commands: [{ type: 'clip.trim', clipId: a, edge: 'out', deltaFrames: -10, mode }],
});

describe('rough-cut proposals (AF-PROP)', { timeout: TIMEOUT }, () => {
	it('is listed with agent accept off by default', async () => {
		const app = await secured();
		const { projectId } = seed(app);
		const r = await app.inject({
			method: 'GET',
			url: `/api/projects/${projectId}/proposal-features`,
			headers: AGENT_H,
		});
		const f = ProposalFeaturesResponseSchema.parse(r.json()).features.find((x) => x.id === 'rough-cut');
		expect(f).toMatchObject({
			name: 'Rough cut',
			itemNoun: { one: '1 edit', other: '{0} edits' },
			agentAccept: { setting: 'project', allowed: false, default: false, explicit: false },
			producers: ['propose_edits'],
		});
		expect(f!.groups.map((g) => g.id)).toEqual([
			'selects',
			'removed',
			'retakes',
			'reorder',
			'b-roll',
			'other',
		]);
	});

	it('an agent may not apply its own cut by default; the editor applies it as one transaction', async () => {
		const app = await secured();
		const { projectId, seqId, file, a, b, c } = seed(app);
		const p = await create(app, projectId, roughCut(seqId, [removeB(b.id), trimA(a.id)]));
		expect(p.feature).toBe('rough-cut');
		expect(p.summary).toBe('Drop the weak middle take. Keep the opening and the ending.');
		expect(p.author).toEqual({ agent: 'cut-agent' });
		expect(p.items.map((i) => [i.id, i.state, i.group])).toEqual([
			['e0', 'pending', 'removed'],
			['e1', 'pending', 'selects'],
		]);
		const refused = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: 'all' }, AGENT_H);
		expect(refused.statusCode).toBe(403);
		expect(refused.json()).toMatchObject({
			code: 'APPROVAL_REQUIRED',
			detail: { code: 'E_APPROVAL_REQUIRED', feature: 'rough-cut' },
		});
		expect(refused.json().message).toMatch(/rough cut/);
		expect(saved(file).revision).toBe(3);
		// the user applies it: ONE transaction (revision 3 → 4; the editor's History shows one entry)
		const ok = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: 'all' }, EDITOR_H);
		expect(ok.statusCode, ok.body).toBe(200);
		expect(ok.json()).toMatchObject({
			applied: ['e0', 'e1'],
			revision: 4,
			result: { ok: true, revision: 4 },
		});
		const after = saved(file);
		expect(after.revision).toBe(4);
		const clips = Object.values(after.doc.sequences[seqId]!.clips).sort((x, y) => x.start - y.start);
		expect(clips.map((x) => [x.id, x.start, x.duration])).toEqual([
			[a.id, 0, 50],
			[c.id, 50, 60],
		]);
	});

	it('allowed in Project Settings ▸ Agent Proposals, an agent applies it', async () => {
		const app = await secured();
		const { projectId, seqId, file, b } = seed(app);
		userEdit(file, seqId, [
			{ type: 'project.updateSettings', settings: { agentProposals: { 'rough-cut': true } } },
		]);
		const p = await create(app, projectId, roughCut(seqId, [removeB(b.id)]));
		const ok = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: 'all' }, AGENT_H);
		expect(ok.statusCode, ok.body).toBe(200);
		expect(Object.keys(saved(file).doc.sequences[seqId]!.clips)).not.toContain(b.id);
	});

	it('a conflicting user edit makes the item stale; the accept is refused', async () => {
		const app = await secured();
		const { projectId, seqId, file, a, b } = seed(app);
		const p = await create(app, projectId, roughCut(seqId, [removeB(b.id), trimA(a.id)]));
		// the user trims B after the proposal was made
		userEdit(file, seqId, [{ type: 'clip.trim', clipId: b.id, edge: 'out', deltaFrames: -20 }]);
		const r = await app.inject({
			method: 'GET',
			url: `${base(projectId)}/${p.id}?revalidate=1`,
			headers: AGENT_H,
		});
		const now = ProposalResponseSchema.parse(r.json()).proposal;
		expect(now.items.map((i) => i.state)).toEqual(['stale', 'pending']);
		const refused = await post(app, `${base(projectId)}/${p.id}/accept`, { itemIds: 'all' }, EDITOR_H);
		expect([refused.statusCode, refused.json().code]).toEqual([409, 'PROPOSAL_STALE']);
		expect(saved(file).revision).toBe(4);
	});

	it('allOrNothing: one failing item refuses the whole draft, listing each failure; nothing is stored', async () => {
		const app = await secured();
		const { projectId, seqId, a, b } = seed(app);
		const draft = roughCut(seqId, [
			trimA(a.id),
			{
				group: 'removed',
				reason: 'Gone already',
				commands: [
					{ type: 'marker.add', frame: 1 },
					{ type: 'clip.extract', clipIds: ['clp_ZZZZZZZZZZZZZZZZ'] },
				],
			},
			removeB(b.id),
			{ ...removeB(b.id), reason: 'Twice' },
		]);
		const r = await post(app, base(projectId), draft, AGENT_H);
		expect(r.statusCode, r.body).toBe(422);
		expect(r.json()).toMatchObject({
			code: 'PROPOSAL_INVALID',
			detail: {
				code: 'E_PROPOSAL_INVALID',
				items: [
					{ index: 1, itemId: 'e1', code: 'E_NOT_FOUND', commandIndex: 1 },
					{ index: 3, itemId: 'e3', code: 'E_CONFLICT', commandIndex: null },
				],
			},
		});
		expect(r.json().message).toMatch(/2 of 4 items/);
		expect(await list(app, projectId)).toEqual([]);
		// a malformed command is the same refusal shape's sibling: 400, nothing stored
		const malformed = await post(
			app,
			base(projectId),
			roughCut(seqId, [{ group: 'other', reason: 'x', commands: [{ type: 'clip.nope' }] }]),
			AGENT_H,
		);
		expect(malformed.statusCode).toBe(400);
		expect(await list(app, projectId)).toEqual([]);
		// without allOrNothing (other producers) failing items are stored invalid, as before
		const { allOrNothing: _, ...lenient } = draft;
		const stored = await create(app, projectId, lenient);
		expect(stored.items.map((i) => i.state)).toEqual(['pending', 'invalid', 'pending', 'invalid']);
	});

	it('expectedRevision: items touching what changed since are refused (fast-forward rule)', async () => {
		const app = await secured();
		const { projectId, seqId, a, b } = seed(app);
		// the user's edit through the engine (the revision tracker sees it): B trimmed at revision 4
		const edit = await post(
			app,
			'/api/agent/tx',
			{
				projectId,
				transaction: {
					label: 'trim B',
					sequenceId: seqId,
					commands: [{ type: 'clip.trim', clipId: b.id, edge: 'out', deltaFrames: -10 }],
				},
			},
			AGENT_H,
		);
		expect(edit.json().result, edit.body).toMatchObject({ ok: true, revision: 4 });
		const stale = await post(
			app,
			base(projectId),
			roughCut(seqId, [trimA(a.id, 'regular'), removeB(b.id)], { expectedRevision: 3 }),
			AGENT_H,
		);
		expect(stale.statusCode, stale.body).toBe(422);
		expect(stale.json().detail.items).toEqual([
			expect.objectContaining({ index: 1, itemId: 'e1', code: 'E_REVISION_MISMATCH' }),
		]);
		// only A: nothing it touches changed since revision 3 → stored
		const ok = await create(
			app,
			projectId,
			roughCut(seqId, [trimA(a.id, 'regular')], { expectedRevision: 3 }),
		);
		expect(ok.items[0]!.state).toBe('pending');
		// ahead of the document: refused
		const ahead = await post(
			app,
			base(projectId),
			roughCut(seqId, [trimA(a.id)], { expectedRevision: 99 }),
			AGENT_H,
		);
		expect([ahead.statusCode, ahead.json().code]).toEqual([409, 'REVISION_CONFLICT']);
		expect(await list(app, projectId)).toHaveLength(1);
	});
});
