// Spec 18 AF-BRF-004: get_brief / set_brief / list_agent_notes / add_agent_note against an in-process engine stand-in
// that applies agent transactions (origin kept, as the engine relays it) with the real command system. Notes are signed
// with the MCP client's name; no tool removes notes, and project.removeAgentNote through apply_commands needs approval.
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	approvalReasons,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	normalizeAgentTransaction,
	type ProjectDocument,
	runAgentQuery,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const P = 'prj_brief';
const registries = defaultRegistries();

function fakeEngine(preset = 'vertical-1080x1920-30') {
	const ids = createCounterIdSource(31);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Brief', preset });
	let revision = 0;
	const txs: Record<string, unknown>[] = [];
	const apply = (raw: Record<string, unknown>) => {
		const tx = normalizeAgentTransaction(raw);
		const r = applyTransaction(doc, tx as never, {
			ids,
			now: () => '2026-10-31T09:00:00.000Z',
			revision,
			registries,
		});
		if (r.result.ok && !tx.dryRun) {
			txs.push(tx);
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const client = {
		agentQuery: async (req: { query: string; args?: unknown }) => ({
			result: runAgentQuery({ doc, revision, effects: registries.effects }, req.query, req.args ?? {}),
			revision,
			via: 'headless',
		}),
		agentTx: async (req: { transaction: Record<string, unknown> }) => ({
			result: apply(req.transaction),
			appliedBy: 'headless',
		}),
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, doc: () => doc, txs };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON read loosely by the assertions
type Json = Record<string, any>;

async function connect(preset?: string) {
	const engine = fakeEngine(preset);
	const { server } = createJasperMcpServer({ link: engine.link });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'codex-cli', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: { projectId: P, ...args } })) as CallToolResult;
		const text = (r.content[0] as { text: string }).text;
		let json: Json = {};
		try {
			json = JSON.parse(text);
		} catch {}
		return { r, text, json };
	};
	const ok = async (name: string, args: Record<string, unknown> = {}) => {
		const out = await call(name, args);
		expect(out.r.isError, `${name}: ${out.text}`).toBeFalsy();
		return out.json;
	};
	const fail = async (name: string, args: Record<string, unknown> = {}) => {
		const out = await call(name, args);
		expect(out.r.isError, `${name} should fail: ${out.text}`).toBe(true);
		return out.json.error as { code: string; message: string; hint?: string };
	};
	return { engine, client, ok, fail };
}

describe('brief tools (AF-BRF-004)', () => {
	it('get_brief reads nothing at first; set_brief merges fields, clears one with null, and clear removes it', async () => {
		const { engine, ok } = await connect();
		const seqId = Object.keys(engine.doc().sequences)[0]!;
		expect(await ok('get_brief')).toMatchObject({
			sequenceId: seqId,
			brief: null,
			sequenceFrame: { width: 1080, height: 1920, aspect: '9:16' },
			agentNotes: 0,
		});
		const set = await ok('set_brief', {
			text: 'A 30 s TikTok teaser',
			platform: 'tiktok',
			targetDurationSec: 30,
		});
		expect(set).toMatchObject({ ok: true, results: [{ brief: { platform: 'tiktok' } }] });
		expect(engine.txs.at(-1)).toMatchObject({ label: 'Edit Brief', origin: { agent: 'codex-cli' } });
		expect(await ok('get_brief', { sequenceId: seqId })).toMatchObject({
			brief: { text: 'A 30 s TikTok teaser', platform: 'tiktok', targetDurationSec: 30 },
			platform: { id: 'tiktok', name: 'TikTok', aspect: '9:16', form: 'short' },
			aspectMatches: true,
		});
		await ok('set_brief', { platform: 'youtube', targetDurationSec: null });
		const after = await ok('get_brief');
		expect(after.brief).toEqual({ text: 'A 30 s TikTok teaser', platform: 'youtube' });
		expect(after.aspectMatches).toBe(false);
		await ok('set_brief', { clear: true });
		expect((await ok('get_brief')).brief).toBeNull();
	});

	it('refuses bad platforms, aspects and lengths, empty calls, clear with fields and unknown sequences', async () => {
		const { fail } = await connect();
		expect((await fail('set_brief', { platform: 'myspace' })).code).toBeDefined();
		expect((await fail('set_brief', { aspect: '4:3' })).code).toBeDefined();
		expect((await fail('set_brief', { targetDurationSec: 0 })).code).toBeDefined();
		expect((await fail('set_brief', {})).code).toBe('E_INVALID_PARAM');
		expect((await fail('set_brief', { clear: true, text: 'x' })).code).toBe('E_INVALID_PARAM');
		expect((await fail('get_brief', { sequenceId: 'seq_nope' })).code).toBe('E_NOT_FOUND');
	});

	it('add_agent_note signs with the client name; list_agent_notes lists oldest first, limit takes the newest', async () => {
		const { engine, ok, fail } = await connect();
		const a = await ok('add_agent_note', { text: 'Take 3 of the intro has the cleanest audio' });
		expect(a.results[0]).toMatchObject({ author: 'codex-cli', at: '2026-10-31T09:00:00.000Z' });
		await ok('add_agent_note', { text: 'Ask about the music licence' });
		const list = await ok('list_agent_notes');
		expect(list.total).toBe(2);
		expect(list.max).toBe(500);
		expect(list.notes.map((n: Json) => [n.author, n.text])).toEqual([
			['codex-cli', 'Take 3 of the intro has the cleanest audio'],
			['codex-cli', 'Ask about the music licence'],
		]);
		expect((await ok('list_agent_notes', { limit: 1 })).notes.map((n: Json) => n.text)).toEqual([
			'Ask about the music licence',
		]);
		expect((await ok('get_brief')).agentNotes).toBe(2);
		expect((await fail('add_agent_note', { text: '' })).code).toBeDefined();
		expect((await fail('add_agent_note', { text: 'x', author: 'me' })).code).toBeDefined();
		expect(engine.txs.map((t) => t.label)).toEqual(['Add Agent Note', 'Add Agent Note']);
	});

	it('exposes no tool that removes notes, and removing one by command needs the user approval', async () => {
		const { client } = await connect();
		const names = (await client.listTools()).tools.map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining(['get_brief', 'set_brief', 'list_agent_notes', 'add_agent_note']),
		);
		expect(names.filter((n) => /agent_note/.test(n)).sort()).toEqual(['add_agent_note', 'list_agent_notes']);
		expect(
			approvalReasons({ commands: [{ type: 'project.removeAgentNote', noteId: 'agn_0000000000000001' }] }),
		).toHaveLength(1);
	});
});
