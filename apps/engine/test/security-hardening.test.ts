import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_INPUT_HEADER, AGENT_NAME_HEADER } from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import {
	builtinEffectPreset,
	createCounterIdSource,
	createEmptyProject,
	makeEnvelope,
} from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { AgentService } from '../src/agent/index.ts';
import { UrlSigner } from '../src/auth/signed-url.ts';
import { mgSandboxScope } from '../src/context.ts';
import { startEngine } from '../src/index.ts';
import { mgHostCsp } from '../src/routes/mg-bundles.ts';
import { isEditorRequest } from '../src/server.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, makeApp, tempAppdir } from './helpers.ts';

afterAll(closeApps);

const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_hardening_0123456789abcdef';
const KEY = 'key_hardening_0123456789abcdef';
/** What jasper-mcp, the CLI and every script that read runtime.json send: the token, nothing else. */
const AGENT = { ...HOST, authorization: `Bearer ${TOKEN}`, [AGENT_NAME_HEADER]: 'test-agent' };
/** What the editor window sends: the HttpOnly session and editor cookies. */
const EDITOR = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

type App = Awaited<ReturnType<typeof makeApp>>;
const secured = (opts: Parameters<typeof makeApp>[0] = {}) =>
	makeApp({ dev: false, token: TOKEN, editorKey: KEY, ...opts });
const agentService = (app: FastifyInstance) => app.jasper.services.agent as AgentService;

type Msg = Record<string, unknown>;
async function session(app: App, headers: Record<string, string>, projectId: string, id = 'ses_1') {
	const ws: WebSocket = await app.injectWS('/agent', { headers });
	const received: Msg[] = [];
	const waiters: { pred(m: Msg): boolean; resolve(m: Msg): void }[] = [];
	ws.on('message', (d) => {
		const m = JSON.parse(String(d)) as Msg;
		received.push(m);
		for (const w of [...waiters])
			if (w.pred(m)) {
				waiters.splice(waiters.indexOf(w), 1);
				w.resolve(m);
			}
	});
	const next = (pred: (m: Msg) => boolean) =>
		new Promise<Msg>((resolve) => {
			const hit = received.find(pred);
			if (hit) resolve(hit);
			else waiters.push({ pred, resolve });
		});
	ws.send(JSON.stringify({ type: 'hello', projectId, sessionId: id, leaseId: `lease_${id}` }));
	const welcome = await next((m) => m.type === 'welcome');
	const card = (after = 0) =>
		next(
			(m) => m.type === 'event' && m.event === 'agent.approval.requested' && received.indexOf(m) >= after,
		).then(
			(m) =>
				m.payload as { approvalId: string; answerKey: string; summary: string; label: string; agent: string },
		);
	const answer = (approvalId: string, decision: 'approved' | 'denied', answerKey?: string) =>
		ws.send(
			JSON.stringify({
				type: 'event',
				event: 'agent.approval.resolve',
				payload: { approvalId, decision, ...(answerKey !== undefined ? { answerKey } : {}) },
			}),
		);
	const auto = (decision: 'approved' | 'denied') =>
		ws.on('message', (d) => {
			const m = JSON.parse(String(d)) as Msg;
			if (m.type !== 'event' || m.event !== 'agent.approval.requested') return;
			const p = m.payload as { approvalId: string; answerKey: string };
			answer(p.approvalId, decision, p.answerKey);
		});
	const settle = async () => {
		const after = received.length;
		ws.send(JSON.stringify({ type: 'ping' }));
		await next((m) => m.type === 'pong' && received.indexOf(m) >= after);
	};
	return { ws, received, welcome, next, card, answer, auto, settle };
}

const cards = (s: { received: Msg[] }) =>
	s.received.filter((m) => m.type === 'event' && m.event === 'agent.approval.requested');

function seed(app: App, name = 'Hardening'): { projectId: string; file: string } {
	const doc = createEmptyProject({ ids: createCounterIdSource(5), name, preset: 'hd-1080p-30' });
	const file = appdirPaths(app.appdir).projectFile(doc.projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(makeEnvelope(doc, { revision: 3, savedAt: '2026-10-01T00:00:00.000Z', platform: 'test' })),
	);
	return { projectId: doc.projectId, file };
}

const destructiveTx = (projectId: string) => ({
	projectId,
	transaction: {
		label: 'Remove V3',
		origin: { agent: 'test-agent' },
		commands: [{ type: 'track.remove', trackIds: ['V3'] }],
	},
});
const postTx = (app: App, projectId: string, headers: Record<string, string> = AGENT) =>
	app.inject({
		method: 'POST',
		url: '/api/agent/tx',
		headers: json(headers),
		payload: destructiveTx(projectId),
	});

describe('AGT-2: the editor is told apart from everything else that holds the token', () => {
	it('classifies a request by the editor key cookie, never by the token', () => {
		const config = { token: TOKEN, editorKey: KEY, port: 47900 } as never;
		expect(isEditorRequest({ cookie: `jasper_editor_47900=${KEY}` }, config)).toBe(true);
		expect(isEditorRequest({ cookie: `a=b; jasper_editor=${KEY}` }, config)).toBe(true);
		// The token is what agents have: it proves nothing about being the editor.
		expect(isEditorRequest({ authorization: `Bearer ${TOKEN}` }, config)).toBe(false);
		expect(isEditorRequest({ cookie: `jasper_session_47900=${TOKEN}` }, config)).toBe(false);
		expect(isEditorRequest({ cookie: `jasper_editor_47900=${TOKEN}` }, config)).toBe(false);
		expect(isEditorRequest({ cookie: `jasper_editor_47900=${KEY}x` }, config)).toBe(false);
		expect(isEditorRequest({ cookie: 'jasper_editor_47900=' }, config)).toBe(false);
		// Another engine's cookie (same host, another port) is not this engine's.
		expect(isEditorRequest({ cookie: `jasper_editor_48000=${KEY}` }, config)).toBe(false);
		expect(isEditorRequest({ cookie: 'jasper_editor_47900=%E0%A4%A' }, config)).toBe(false);
		// The editor itself says when it acts on an agent's live-UI input.
		expect(isEditorRequest({ cookie: `jasper_editor_47900=${KEY}`, [AGENT_INPUT_HEADER]: '1' }, config)).toBe(
			false,
		);
	});

	it('tells an /agent connection whether it is the editor', async () => {
		const app = await secured();
		const { projectId } = seed(app);
		expect((await session(app, EDITOR, projectId)).welcome).toMatchObject({ editor: true });
		expect((await session(app, AGENT, projectId, 'ses_2')).welcome).toMatchObject({ editor: false });
		// The session cookie alone (a browser that was not paired as the editor) is not the editor either.
		const cookieOnly = { ...HOST, cookie: `jasper_session_47900=${TOKEN}` };
		expect((await session(app, cookieOnly, projectId, 'ses_3')).welcome).toMatchObject({ editor: false });
	});
});

describe('AGT-2: approval answers count only from the editor connection that was shown the card', () => {
	it('a token-holding connection gets no card and can neither approve nor deny, even with the approval id', async () => {
		const app = await secured();
		const { projectId } = seed(app);
		const events: { type: string; payload: unknown }[] = [];
		coreServices(app).broadcaster.subscribe((e) => events.push(e));
		const editor = await session(app, EDITOR, projectId, 'ses_editor');
		const rogue = await session(app, AGENT, projectId, 'ses_rogue');

		const pending = postTx(app, projectId);
		const card = await editor.card();
		await rogue.settle();
		expect(cards(rogue)).toEqual([]);

		const published = events.find((e) => e.type === 'agent.approval.requested');
		expect(published?.payload).toMatchObject({ approvalId: card.approvalId });
		expect(JSON.stringify(events)).not.toContain(card.answerKey);

		// Everything the rogue connection can try: no key, a guessed key, and even the real key (stolen somehow) —
		// the key is bound to the connection it was sent to.
		rogue.answer(card.approvalId, 'approved');
		rogue.answer(card.approvalId, 'approved', 'guess');
		rogue.answer(card.approvalId, 'approved', card.answerKey);
		rogue.answer(card.approvalId, 'denied', card.answerKey);
		await rogue.settle();
		expect(
			agentService(app)
				.approvals.pending()
				.map((a) => a.approvalId),
		).toEqual([card.approvalId]);

		editor.answer(card.approvalId, 'denied', card.answerKey);
		expect((await pending).json().result).toMatchObject({
			ok: false,
			errors: [{ code: 'E_APPROVAL_DENIED' }],
		});
		expect(agentService(app).approvals.pending()).toEqual([]);
	});

	it('the editor must present the key of that card: none, another card’s or another window’s do not count', async () => {
		const app = await secured();
		const { projectId } = seed(app);
		const a = await session(app, EDITOR, projectId, 'ses_a');
		const b = await session(app, EDITOR, projectId, 'ses_b');

		const first = postTx(app, projectId);
		const cardA1 = await a.card();
		const cardB1 = await b.card();
		expect(cardA1.approvalId).toBe(cardB1.approvalId);
		expect(cardA1.answerKey).not.toBe(cardB1.answerKey);

		const second = postTx(app, projectId);
		type Card = { approvalId: string; answerKey: string };
		const cardsOf = (w: { received: Msg[] }) => cards(w).map((m) => m.payload as Card);
		await vi.waitFor(() => expect([cardsOf(a).length, cardsOf(b).length]).toEqual([2, 2]));
		const otherA = cardsOf(a).find((c) => c.approvalId !== cardA1.approvalId)!;
		const otherB = cardsOf(b).find((c) => c.approvalId === otherA.approvalId)!;

		a.answer(cardA1.approvalId, 'approved');
		a.answer(cardA1.approvalId, 'approved', otherA.answerKey);
		a.answer(cardA1.approvalId, 'approved', cardB1.answerKey);
		await a.settle();
		expect(agentService(app).approvals.pending().length).toBe(2);

		a.answer(cardA1.approvalId, 'denied', cardA1.answerKey);
		b.answer(otherB.approvalId, 'denied', otherB.answerKey);
		for (const r of [await first, await second])
			expect(r.json().result).toMatchObject({ ok: false, errors: [{ code: 'E_APPROVAL_DENIED' }] });
		expect(a.received.filter((m) => m.event === 'agent.approval.resolved').length).toBe(2);
	});

	it('without an editor window the request is refused at once, whoever else is connected', async () => {
		const app = await secured();
		const { projectId } = seed(app);
		await session(app, AGENT, projectId, 'ses_rogue');
		const t0 = Date.now();
		const r = await postTx(app, projectId);
		expect(r.json().result).toMatchObject({ ok: false, errors: [{ code: 'E_APPROVAL_DENIED' }] });
		expect(r.json().result.errors[0].message).toMatch(/no editor window/);
		expect(Date.now() - t0).toBeLessThan(3000);
		expect(agentService(app).approvals.pending()).toEqual([]);
	});

	it('a window that opens the project while a request is pending is shown the card, with its own key', async () => {
		const app = await secured();
		const { projectId } = seed(app);
		const first = await session(app, EDITOR, projectId, 'ses_first');
		const pending = postTx(app, projectId);
		const card1 = await first.card();
		const late = await session(app, EDITOR, projectId, 'ses_late');
		const card2 = await late.card();
		expect(card2.approvalId).toBe(card1.approvalId);
		expect(card2.answerKey).not.toBe(card1.answerKey);
		late.answer(card2.approvalId, 'denied', card2.answerKey);
		expect((await pending).json().result).toMatchObject({ ok: false });
		await first.next((m) => m.event === 'agent.approval.resolved');
	});

	it('an approved request is relayed to the editor as approved; the answer came from a real card', async () => {
		const app = await secured();
		const { projectId } = seed(app);
		const editor = await session(app, EDITOR, projectId);
		const pending = postTx(app, projectId);
		const card = await editor.card();
		expect(card).toMatchObject({ label: 'Remove V3', agent: 'test-agent' });
		editor.answer(card.approvalId, 'approved', card.answerKey);
		const req = await editor.next((m) => m.type === 'request' && m.kind === 'tx');
		expect(req.payload).toMatchObject({ approved: true });
		editor.ws.send(
			JSON.stringify({
				type: 'response',
				id: req.id,
				result: {
					ok: true,
					revision: 4,
					refs: {},
					created: [],
					changed: [],
					deleted: ['trk'],
					warnings: [],
					results: [null],
				},
			}),
		);
		expect((await pending).json()).toMatchObject({ appliedBy: 'session', result: { ok: true } });
	});
});

describe('AGT-3: destructive operations outside transactions ask the user when an agent makes them', () => {
	const fadeIn = () => JSON.parse(JSON.stringify(builtinEffectPreset('builtin.fade-in')));
	const presets = async (app: App) =>
		(await app.inject({ method: 'GET', url: '/api/effect-presets', headers: EDITOR })).json() as {
			presets: { id: string; name: string }[];
			folders: { id: string }[];
		};
	async function savePreset(app: App, name: string, folderId?: string): Promise<string> {
		const r = await app.inject({
			method: 'POST',
			url: '/api/effect-presets',
			headers: json(AGENT),
			payload: { preset: { ...fadeIn(), name }, ...(folderId ? { folderId } : {}) },
		});
		expect(r.statusCode).toBe(201);
		return r.json().id as string;
	}

	it('an agent cannot delete a preset of the user’s library: refused without an editor, asked with one', async () => {
		const app = await secured();
		const { projectId } = seed(app);
		const id = await savePreset(app, 'Keep me');
		const del = (headers: Record<string, string>) =>
			app.inject({ method: 'DELETE', url: `/api/effect-presets/${id}`, headers });

		const refused = await del(AGENT);
		expect(refused.statusCode).toBe(403);
		expect(refused.json()).toMatchObject({ code: 'APPROVAL_DENIED', detail: { code: 'E_APPROVAL_DENIED' } });
		expect((await presets(app)).presets.map((p) => p.id)).toEqual([id]);

		const editor = await session(app, EDITOR, projectId);
		const denied = del(AGENT);
		const card = await editor.card();
		expect(card).toMatchObject({ label: 'Delete effect preset', agent: 'test-agent' });
		expect(card.summary).toContain('"Keep me"');
		editor.answer(card.approvalId, 'denied', card.answerKey);
		expect((await denied).statusCode).toBe(403);
		expect((await presets(app)).presets.length).toBe(1);

		const approved = del(AGENT);
		const card2 = await editor.card(editor.received.length);
		editor.answer(card2.approvalId, 'approved', card2.answerKey);
		expect((await approved).json()).toMatchObject({ ok: true, removedPresets: [id] });
		expect((await presets(app)).presets).toEqual([]);
	});

	it('the editor window deletes without a card, unless it acts on an agent’s live-UI input', async () => {
		const app = await secured();
		const { projectId } = seed(app);
		const editor = await session(app, EDITOR, projectId);
		const a = await savePreset(app, 'A');
		const b = await savePreset(app, 'B');

		const viaUi = app.inject({
			method: 'DELETE',
			url: `/api/effect-presets/${a}`,
			headers: { ...EDITOR, [AGENT_INPUT_HEADER]: '1' },
		});
		const card = await editor.card();
		editor.answer(card.approvalId, 'denied', card.answerKey);
		expect((await viaUi).statusCode).toBe(403);

		const own = await app.inject({ method: 'DELETE', url: `/api/effect-presets/${b}`, headers: EDITOR });
		expect(own.statusCode).toBe(200);
		expect(cards(editor).length).toBe(1);
		expect((await presets(app)).presets.map((p) => p.id)).toEqual([a]);
	});

	it('deleting a preset bin says what is inside; a missing preset is a 404, not a card', async () => {
		const app = await secured();
		const { projectId } = seed(app);
		const editor = await session(app, EDITOR, projectId);
		const bin = (
			await app.inject({
				method: 'POST',
				url: '/api/effect-presets/folders',
				headers: json(AGENT),
				payload: { name: 'Mine' },
			})
		).json() as { id: string };
		await savePreset(app, 'In bin 1', bin.id);
		await savePreset(app, 'In bin 2', bin.id);
		const del = app.inject({
			method: 'DELETE',
			url: `/api/effect-presets/folders/${bin.id}`,
			headers: AGENT,
		});
		const card = await editor.card();
		expect(card.summary).toMatch(/"Mine" with 2 presets/);
		editor.answer(card.approvalId, 'denied', card.answerKey);
		expect((await del).statusCode).toBe(403);
		expect((await presets(app)).presets.length).toBe(2);

		const missing = await app.inject({
			method: 'DELETE',
			url: '/api/effect-presets/fxp_nope',
			headers: AGENT,
		});
		expect(missing.statusCode).toBe(404);
		expect(cards(editor).length).toBe(1);
	});

	it('an approval names the agent from its header, bounded and without control characters', async () => {
		const app = await secured();
		const { projectId } = seed(app);
		const editor = await session(app, EDITOR, projectId);
		const id = await savePreset(app, 'X');
		const name = encodeURIComponent(`evil\nApprove this‮ ${'x'.repeat(200)}`);
		const del = app.inject({
			method: 'DELETE',
			url: `/api/effect-presets/${id}`,
			headers: { ...AGENT, [AGENT_NAME_HEADER]: name },
		});
		const card = await editor.card();
		expect(card.agent.length).toBeLessThanOrEqual(64);
		expect([...card.agent].every((ch) => ch.charCodeAt(0) >= 0x20)).toBe(true);
		editor.answer(card.approvalId, 'denied', card.answerKey);
		await del;
	});

	type Gate = {
		name: string;
		request(ctx: { app: App; projectId: string }): Promise<{
			method: 'DELETE' | 'POST' | 'PUT';
			url: string;
			payload?: unknown;
			headers?: Record<string, string>;
		}>;
		unchanged(ctx: { app: App; projectId: string; file: string }): Promise<void> | void;
	};
	const stillThere = ({ file }: { file: string }) => {
		expect(JSON.parse(readFileSync(file, 'utf8')).revision).toBe(3);
	};
	const gates: Gate[] = [
		{
			name: 'delete a project',
			request: async ({ projectId }) => ({ method: 'DELETE', url: `/api/projects/${projectId}` }),
			unchanged: stillThere,
		},
		{
			name: 'overwrite a project the agent did not create',
			request: async ({ app, projectId }) => {
				const cur = (
					await app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: AGENT })
				).json();
				const doc = createEmptyProject({
					ids: createCounterIdSource(77),
					name: 'Wiped',
					preset: 'hd-1080p-30',
				});
				return {
					method: 'PUT',
					url: `/api/projects/${projectId}`,
					headers: { 'if-match': String(cur.revision) },
					payload: makeEnvelope({ ...doc, projectId }, { revision: 4, savedAt: 'x', platform: 'agent' }),
				};
			},
			unchanged: stillThere,
		},
		{
			name: 'restore a version over a project',
			request: async ({ projectId }) => ({
				method: 'POST',
				url: `/api/projects/${projectId}/versions/2026-10-01T00-00-00-000Z/restore`,
				payload: { mode: 'replace' },
			}),
			unchanged: stillThere,
		},
		{
			name: 'discard a recovery journal',
			request: async ({ projectId }) => ({
				method: 'DELETE',
				url: `/api/projects/${projectId}/recovery/ses_0000000000000001`,
			}),
			unchanged: () => undefined,
		},
		{
			name: 'clean cache files that saved projects reference',
			request: async () => ({ method: 'POST', url: '/api/cache/clean', payload: { mode: 'all' } }),
			unchanged: () => undefined,
		},
		{
			name: 'move the media cache',
			request: async () => ({
				method: 'POST',
				url: '/api/cache/location',
				payload: { path: tempAppdir('jasper-cache-move-'), mode: 'fresh' },
			}),
			unchanged: () => undefined,
		},
		{
			name: 'change the cache budgets',
			request: async ({ app }) => ({
				method: 'PUT',
				url: '/api/cache/settings',
				payload: (await app.inject({ method: 'GET', url: '/api/cache/settings', headers: AGENT })).json(),
			}),
			unchanged: () => undefined,
		},
		{
			name: 'delete the render files of every project',
			request: async () => ({ method: 'POST', url: '/api/previews/delete', payload: { all: true } }),
			unchanged: () => undefined,
		},
		{
			name: 'keep fewer project versions',
			request: async () => ({ method: 'PUT', url: '/api/settings/gaps', payload: { keepVersions: 1 } }),
			unchanged: async ({ app }) => {
				const st = (await app.inject({ method: 'GET', url: '/api/settings/gaps', headers: AGENT })).json();
				expect(st.keepVersions).toBeGreaterThan(1);
			},
		},
		{
			name: 'change the processing settings (remote executor)',
			request: async () => ({ method: 'PUT', url: '/api/settings/processing', payload: { remote: null } }),
			unchanged: () => undefined,
		},
	];

	it.each(gates)('refuses an agent that wants to $name while no editor window is open', async (gate) => {
		const app = await secured();
		const { projectId, file } = seed(app);
		const ctx = { app, projectId, file };
		const req = await gate.request(ctx);
		const send = (headers: Record<string, string>) =>
			app.inject({
				method: req.method,
				url: req.url,
				headers: { ...(req.payload !== undefined ? json(headers) : headers), ...(req.headers ?? {}) },
				...(req.payload !== undefined ? { payload: req.payload as object } : {}),
			});
		const r = await send(AGENT);
		expect([r.statusCode, r.json().detail?.code], r.body).toEqual(
			gate.name.startsWith('change the processing') ? [409, 'E_NO_SESSION'] : [403, 'E_APPROVAL_DENIED'],
		);
		await gate.unchanged(ctx);

		const editor = await session(app, EDITOR, projectId);
		editor.auto('denied');
		const denied = await send(AGENT);
		expect([denied.statusCode, denied.json().detail?.code], denied.body).toEqual([403, 'E_APPROVAL_DENIED']);
		expect(cards(editor).length).toBe(1);
		expect((cards(editor)[0]!.payload as { kind: string }).kind).toBe('operation');
		await gate.unchanged(ctx);
	});

	it('what the automatic cleaning does itself needs no approval: clean unused, delete named render segments', async () => {
		const app = await secured();
		const unused = await app.inject({
			method: 'POST',
			url: '/api/cache/clean',
			headers: json(AGENT),
			payload: { mode: 'unused' },
		});
		expect(unused.statusCode).toBe(200);
		const range = await app.inject({
			method: 'POST',
			url: '/api/previews/delete',
			headers: json(AGENT),
			payload: { hashes: [] },
		});
		expect(range.statusCode).toBe(200);
		const more = await app.inject({
			method: 'PUT',
			url: '/api/settings/gaps',
			headers: json(AGENT),
			payload: { keepVersions: 500 },
		});
		expect(more.statusCode, more.body).toBe(200);
	});

	it('an agent may fill and delete a project it created; once the user has saved it, it asks', async () => {
		const app = await secured();
		const created = await app.inject({
			method: 'POST',
			url: '/api/projects',
			headers: json(AGENT),
			payload: { name: 'Agent copy', preset: 'hd-1080p-30' },
		});
		const projectId = created.json().projectId as string;
		const get = async () =>
			(await app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: AGENT })).json() as {
				revision: number;
				envelope: { document: Record<string, unknown> } & Record<string, unknown>;
			};
		const put = async (headers: Record<string, string>, name: string) => {
			const cur = await get();
			return app.inject({
				method: 'PUT',
				url: `/api/projects/${projectId}`,
				headers: { ...json(headers), 'if-match': String(cur.revision) },
				payload: {
					...cur.envelope,
					revision: cur.revision + 1,
					document: { ...cur.envelope.document, name },
				},
			});
		};
		expect((await put(AGENT, 'Filled')).statusCode).toBe(200);
		expect((await put(AGENT, 'Filled again')).statusCode).toBe(200);
		// The user opens it and saves: from here it is the user's work.
		expect((await put(EDITOR, 'Mine now')).statusCode).toBe(200);
		const refused = await put(AGENT, 'Overwritten');
		expect([refused.statusCode, refused.json().detail?.code]).toEqual([403, 'E_APPROVAL_DENIED']);
		expect((await get()).envelope.document.name).toBe('Mine now');
		const del = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: AGENT });
		expect(del.statusCode).toBe(403);

		// A project the agent created and nobody else touched is the agent's to remove.
		const own = (
			await app.inject({
				method: 'POST',
				url: '/api/projects',
				headers: json(AGENT),
				payload: { name: 'Scratch', preset: 'hd-1080p-30' },
			})
		).json().projectId as string;
		expect(
			(await app.inject({ method: 'DELETE', url: `/api/projects/${own}`, headers: AGENT })).statusCode,
		).toBe(200);
	});

	it('an agent cannot take a project away from the window that is editing it', async () => {
		const app = await secured();
		const { projectId } = seed(app);
		const lease = (headers: Record<string, string>, sessionId: string, takeOver?: boolean) =>
			app.inject({
				method: 'POST',
				url: `/api/projects/${projectId}/lease`,
				headers: json(headers),
				payload: { sessionId, ...(takeOver ? { takeOver } : {}) },
			});
		const held = (await lease(EDITOR, 'ses_user')).json() as { leaseId: string };
		const steal = await lease(AGENT, 'ses_agent', true);
		expect([steal.statusCode, steal.json().detail?.code]).toEqual([403, 'E_APPROVAL_DENIED']);
		const beat = await app.inject({
			method: 'POST',
			url: `/api/projects/${projectId}/lease/${held.leaseId}/heartbeat`,
			headers: EDITOR,
		});
		expect(beat.statusCode).toBe(200);
		expect((await lease(EDITOR, 'ses_user_2', true)).statusCode).toBe(200);
	});

	it('removing a downloaded model asks the user (speech and roto catalogues)', async () => {
		const app = await secured();
		for (const kind of ['speech', 'roto'] as const) {
			const list = (
				await app.inject({ method: 'GET', url: `/api/${kind}/models`, headers: AGENT })
			).json() as {
				models: { id: string }[];
			};
			const id = list.models[0]?.id;
			expect(id, `${kind} catalogue must offer a model`).toBeDefined();
			const r = await app.inject({ method: 'DELETE', url: `/api/${kind}/models/${id}`, headers: AGENT });
			expect([kind, r.statusCode, r.json().detail?.code]).toEqual([kind, 403, 'E_APPROVAL_DENIED']);
			const none = await app.inject({ method: 'DELETE', url: `/api/${kind}/models/nope`, headers: AGENT });
			expect(none.statusCode).toBe(404);
		}
	});
});

describe('DEV-1: an engine that listens always has a token', () => {
	const engines: Awaited<ReturnType<typeof startEngine>>[] = [];
	afterEach(async () => {
		for (const e of engines.splice(0)) await e.stop();
		vi.restoreAllMocks();
	});
	const start = async (opts: Partial<Parameters<typeof startEngine>[0]> = {}) => {
		const engine = await startEngine({ appdir: tempAppdir('jasper-dev1-'), port: 0, env: {}, ...opts });
		engines.push(engine);
		return engine;
	};
	const runtime = (appdir: string) =>
		JSON.parse(readFileSync(appdirPaths(appdir).runtimeFile, 'utf8')) as Record<string, unknown>;

	it('a dev engine started without a token makes one, requires it, and tells local tools where it is', async () => {
		const appdir = tempAppdir('jasper-dev1-');
		const engine = await start({ appdir, dev: true });
		expect(engine.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
		expect((await fetch(`${engine.url}/api/projects`)).status).toBe(401);
		expect(
			(await fetch(`${engine.url}/api/projects`, { headers: { authorization: 'Bearer nope' } })).status,
		).toBe(401);
		const ok = await fetch(`${engine.url}/api/projects`, {
			headers: { authorization: `Bearer ${engine.token}` },
		});
		expect(ok.status).toBe(200);

		// Discovery, like production: /health (public) names the runtime file, which is 0600 and holds the token.
		const health = (await (await fetch(`${engine.url}/health`)).json()) as { runtimeFile: string };
		expect(statSync(health.runtimeFile).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(health.runtimeFile, 'utf8')).token).toBe(engine.token);
	});

	it('every start has a new token; a token given by whoever starts the engine is used as is', async () => {
		const a = await start();
		const b = await start();
		expect(a.token).not.toBe(b.token);
		expect((await start({ token: 'given-token' })).token).toBe('given-token');
		expect((await start({ env: { JASPER_LOCAL_TOKEN: 'env-token' } })).token).toBe('env-token');
	});

	it('the editor key is never in the runtime file, the health answer or the engine’s output', async () => {
		const appdir = tempAppdir('jasper-dev1-');
		const logs: string[] = [];
		for (const level of ['log', 'warn', 'info'] as const)
			vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
		const engine = await start({ appdir, editorKey: KEY, token: TOKEN });
		const everything = [
			readFileSync(appdirPaths(appdir).runtimeFile, 'utf8'),
			await (await fetch(`${engine.url}/health`)).text(),
			await (
				await fetch(`${engine.url}/api/agent/mcp-info`, { headers: { authorization: `Bearer ${TOKEN}` } })
			).text(),
			await (
				await fetch(`${engine.url}/api/capabilities`, { headers: { authorization: `Bearer ${TOKEN}` } })
			).text(),
			logs.join('\n'),
		].join('\n');
		expect(everything).not.toContain(KEY);
		expect(engine.pairingUrl).toBeNull();
		expect(() => statSync(appdirPaths(appdir).devEditorKeyFile)).toThrowError(
			expect.objectContaining({ code: 'ENOENT' }),
		);
	});

	it('a dev engine keeps its editor key in a 0600 file next to the runtime file and reuses it', async () => {
		const appdir = tempAppdir('jasper-dev1-');
		const first = await start({ appdir, dev: true });
		const file = appdirPaths(appdir).devEditorKeyFile;
		const key = readFileSync(file, 'utf8').trim();
		expect(key).toMatch(/^[A-Za-z0-9_-]{40,}$/);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(key).not.toBe(first.token);
		expect(JSON.stringify(runtime(appdir))).not.toContain(key);
		await first.stop();
		engines.splice(engines.indexOf(first), 1);
		// `tsx watch` restarts the engine on every change: the page stays the editor.
		const second = await start({ appdir, dev: true });
		expect(readFileSync(file, 'utf8').trim()).toBe(key);
		expect(second.token).not.toBe(first.token);
		const asEditor = await fetch(`${second.url}/api/agent/mcp-info`, {
			headers: { authorization: `Bearer ${second.token}`, cookie: `jasper_editor_${second.port}=${key}` },
		});
		expect(asEditor.status).toBe(200);
	});

	it('JASPER_INSECURE_DEV=1 is the only way to listen without a token, and it says so loudly', async () => {
		const warnings: string[] = [];
		vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warnings.push(a.join(' ')));
		const engine = await start({ env: { JASPER_INSECURE_DEV: '1' } });
		expect(engine.token).toBeNull();
		expect((await fetch(`${engine.url}/api/projects`)).status).toBe(200);
		expect(warnings.join('\n')).toMatch(/JASPER_INSECURE_DEV is set: THIS ENGINE HAS NO TOKEN/);
		const tokened = await start({ env: { JASPER_INSECURE_DEV: '1', JASPER_LOCAL_TOKEN: 'still-required' } });
		expect((await fetch(`${tokened.url}/api/projects`)).status).toBe(401);
		expect((await start({ env: { JASPER_INSECURE_DEV: '0' } })).token).not.toBeNull();
	});

	it('pairing: the link of an engine that serves the web app makes a browser the editor; nothing else does', async () => {
		const webDir = tempAppdir('jasper-web-');
		writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>app</title>');
		const engine = await start({ webDir });
		expect(engine.pairingUrl).toMatch(new RegExp(`^${engine.url}/pair\\?key=`));

		const page = await fetch(`${engine.url}/`, {
			headers: { accept: 'text/html', 'sec-fetch-dest': 'document' },
		});
		expect(page.status).toBe(401);
		expect(await page.text()).toMatch(/not signed in/);
		expect(page.headers.get('set-cookie')).toBeNull();
		expect((await fetch(`${engine.url}/api/projects`)).status).toBe(401);

		for (const bad of ['', '?key=', '?key=wrong', `?key=${engine.token}`]) {
			const r = await fetch(`${engine.url}/pair${bad}`);
			expect([bad, r.status, r.headers.get('set-cookie')]).toEqual([bad, 401, null]);
		}

		const paired = await fetch(engine.pairingUrl!);
		expect(paired.status).toBe(200);
		expect(paired.headers.get('cache-control')).toBe('no-store');
		const cookies = paired.headers.getSetCookie();
		expect(cookies.length).toBe(2);
		for (const c of cookies) expect(c).toMatch(/; Path=\/; HttpOnly; SameSite=Strict$/);
		const jar = cookies.map((c) => c.split(';')[0]).join('; ');
		expect(jar).toContain(`jasper_session_${engine.port}=`);
		expect(jar).toContain(`jasper_editor_${engine.port}=`);
		const body = await paired.text();
		expect(body).not.toContain(engine.token!);
		expect(body).not.toMatch(/<script/i);
		expect((await fetch(`${engine.url}/api/projects`, { headers: { cookie: jar } })).status).toBe(200);
		const app = await fetch(`${engine.url}/`, { headers: { cookie: jar, accept: 'text/html' } });
		expect(await app.text()).toContain('<title>app</title>');
	});
});

describe('MG-1: bundle pages are served for a sandboxed iframe with an opaque origin', () => {
	/** A bundle directory registered with the service (no Remotion needed to serve it). */
	async function bundle(app: App): Promise<string> {
		const { mgBundleService } = await import('../src/routes/mg-bundles.ts');
		const svc = mgBundleService(app)!;
		const key = 'mk_0123456789abcdef01234567';
		const dir = join(svc.bundlesDir, 'h'.repeat(40));
		mkdirSync(join(dir, 'public'), { recursive: true });
		writeFileSync(
			join(dir, 'index.html'),
			'<!DOCTYPE html><html><head><title>x</title></head><body><script src="./bundle.js"></script></body></html>',
		);
		writeFileSync(join(dir, 'bundle.js'), 'window.stolen = document.cookie;');
		writeFileSync(join(dir, 'public', 'font.woff2'), 'font');
		vi.spyOn(svc, 'bundleDir').mockImplementation((k: string) => (k === key ? dir : null));
		return key;
	}
	afterEach(() => vi.restoreAllMocks());

	it('the host page redirects to a capability path; its policy sandboxes the document and scopes what it loads', async () => {
		const app = await secured();
		const key = await bundle(app);
		const redirect = await app.inject({
			method: 'GET',
			url: `/mg/bundles/${key}/index.html?jasper-host=1`,
			headers: EDITOR,
		});
		expect(redirect.statusCode).toBe(302);
		const location = String(redirect.headers.location);
		expect(location).toMatch(
			new RegExp(`^/mg/sandbox/[A-Za-z0-9_-]{43}/${key}/index\\.html\\?jasper-host=1$`),
		);
		// The redirect itself needs the session: the capability is not handed to whoever asks.
		expect(
			(await app.inject({ method: 'GET', url: `/mg/bundles/${key}/index.html?jasper-host=1`, headers: HOST }))
				.statusCode,
		).toBe(401);

		// The sandboxed page has an opaque origin: no cookie, `Origin: null`. The capability authorises it.
		const opaque = { ...HOST, origin: 'null' };
		const page = await app.inject({ method: 'GET', url: location, headers: opaque });
		expect(page.statusCode).toBe(200);
		expect(page.body).toContain('__jasperMgAgent');
		expect(page.headers['access-control-allow-origin']).toBe('*');
		const csp = String(page.headers['content-security-policy']);
		const base = `http://127.0.0.1:47900${location.split('index.html')[0]}`;
		expect(csp.split('; ')[0]).toBe('sandbox allow-scripts');
		expect(csp).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
		expect(csp).toContain(`default-src ${base} data: blob:`);
		expect(csp).toContain(`connect-src ${base} data: blob: https:`);
		expect(csp).not.toContain("'self'");
		expect(csp).not.toMatch(/\shttp:(\s|;|$)/);
		expect(csp).toContain("frame-src 'none'");
		expect(csp).toContain("form-action 'none'");
		expect(csp).toContain('frame-ancestors http://127.0.0.1:47900 http://localhost:47900');

		const prefix = location.split('index.html')[0]!;
		const js = await app.inject({ method: 'GET', url: `${prefix}bundle.js`, headers: opaque });
		expect([js.statusCode, js.headers['content-type']]).toEqual([200, 'text/javascript; charset=utf-8']);
		expect(js.headers['content-security-policy']).toBe(csp);
		const font = await app.inject({ method: 'GET', url: `${prefix}public/font.woff2`, headers: opaque });
		expect([font.statusCode, font.headers['access-control-allow-origin']]).toEqual([200, '*']);
		const preflight = await app.inject({
			method: 'OPTIONS',
			url: `${prefix}public/font.woff2`,
			headers: opaque,
		});
		expect(preflight.statusCode).toBe(204);
	});

	it('the capability is per bundle, read-only, and nothing outside the bundle is reachable through it', async () => {
		const app = await secured();
		const key = await bundle(app);
		const cap = coreServices(app).signer.capability(mgSandboxScope(key));
		const get = (url: string, method: 'GET' | 'POST' | 'DELETE' = 'GET') =>
			app.inject({ method, url, headers: { ...HOST, origin: 'null' } }).then((r) => r.statusCode);
		expect(await get(`/mg/sandbox/${cap}/${key}/bundle.js`)).toBe(200);
		expect(await get(`/mg/sandbox/${cap.slice(0, -1)}x/${key}/bundle.js`)).toBe(403);
		expect(await get(`/mg/sandbox/x/${key}/bundle.js`)).toBe(403);
		const other = coreServices(app).signer.capability(mgSandboxScope('mk_ffffffffffffffffffffffff'));
		expect(await get(`/mg/sandbox/${other}/${key}/bundle.js`)).toBe(403);
		expect(
			await get(`/mg/sandbox/${new UrlSigner('x').capability(mgSandboxScope(key))}/${key}/bundle.js`),
		).toBe(403);
		expect(await get(`/mg/sandbox/${cap}/${key}/bundle.js`, 'POST')).toBe(403);
		expect(await get(`/mg/sandbox/${cap}/${key}/bundle.js`, 'DELETE')).toBe(403);
		for (const p of [
			'..%2F..%2Fengine%2Fruntime.json',
			'%2e%2e/%2e%2e/engine/runtime.json',
			'..%5C..%5Cengine',
			'%00',
		])
			expect([403, 404], p).toContain(await get(`/mg/sandbox/${cap}/${key}/${p}`));
		expect(await get('/api/projects')).toBe(403);
		expect(await get(`/api/projects?cap=${cap}`)).toBe(403);
		expect((await app.inject({ method: 'GET', url: '/api/projects', headers: HOST })).statusCode).toBe(401);
	});

	it('under the address the editor knows, bundle files are inert data: no script runs with the editor’s origin', async () => {
		const app = await secured();
		const key = await bundle(app);
		for (const file of ['index.html', 'bundle.js']) {
			const r = await app.inject({ method: 'GET', url: `/mg/bundles/${key}/${file}`, headers: EDITOR });
			expect(r.statusCode).toBe(200);
			const csp = String(r.headers['content-security-policy']);
			expect(csp.split('; ')[0]).toBe('sandbox');
			expect(csp).toContain("default-src 'none'");
			expect(r.headers['x-content-type-options']).toBe('nosniff');
		}
	});

	it('mgHostCsp never widens: no ancestors means nobody may frame the page', () => {
		const csp = mgHostCsp({ base: 'http://127.0.0.1:1/mg/sandbox/c/k/', ancestors: [] });
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain('base-uri http://127.0.0.1:1/mg/sandbox/c/k/');
	});
});
