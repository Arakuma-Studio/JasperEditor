// Spec 17 SC-091: list_glossary / save_glossary_entry / remove_glossary_entry against a fake engine that applies the
// glossary's real merge rules (@jasper/project): read-only listing with filters, idempotent save, the user's approval
// for remove (a denial is reported, never retried), read-only and limit refusals as tool errors, strict arguments.
import { EngineError } from '@jasper/engine-client';
import { type GlossaryEntry, glossaryIdFrom, upsertGlossaryEntry } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const NOW = '2026-10-27T10:00:00.000Z';

function fakeEngine() {
	let n = 0;
	const state = {
		revision: 0,
		readOnly: false,
		approve: false,
		entries: [] as GlossaryEntry[],
		calls: [] as string[],
	};
	const ctx = () => ({ now: NOW, newId: () => glossaryIdFrom(Array.from({ length: 16 }, (_, i) => (i === 15 ? ++n : 0))) });
	const client = {
		listGlossary: async () => {
			state.calls.push('list');
			return {
				revision: state.revision,
				readOnly: state.readOnly,
				repairs: state.readOnly ? ['the glossary was written by a newer JasperEditor (version 2); it is read-only here'] : [],
				limits: { maxEntries: 2000, maxSpellings: 20, maxChars: 64 },
				entries: structuredClone(state.entries),
			};
		},
		saveGlossaryEntry: async (req: { from: string[]; to: string; lang?: string }) => {
			state.calls.push(`save ${JSON.stringify(req)}`);
			if (state.readOnly)
				throw new EngineError('GLOSSARY_READ_ONLY', 'The glossary was written by a newer JasperEditor', { status: 409 });
			try {
				const u = upsertGlossaryEntry(state.entries, req, ctx());
				if (u.changed) {
					state.entries = u.entries;
					state.revision++;
				}
				return { revision: state.revision, created: u.created, changed: u.changed, entry: u.entry };
			} catch (e) {
				const err = e as { code: string; message: string };
				throw new EngineError(err.code, err.message, { status: err.code === 'GLOSSARY_LIMIT' ? 409 : 400 });
			}
		},
		removeGlossaryEntry: async (entryId: string) => {
			state.calls.push(`remove ${entryId}`);
			if (!state.approve)
				throw new EngineError('APPROVAL_DENIED', 'Delete glossary entry needs the user', {
					status: 403,
					detail: { code: 'E_APPROVAL_DENIED' },
				});
			if (!state.entries.some((e) => e.id === entryId))
				throw new EngineError('GLOSSARY_NOT_FOUND', `Glossary entry not found: ${entryId}`, { status: 404 });
			state.entries = state.entries.filter((e) => e.id !== entryId);
			state.revision++;
			return { ok: true as const, removed: entryId, revision: state.revision };
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as never,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, state };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'glossary-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'glossary-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
		const text = (r.content[0] as { text: string }).text;
		return { r, json: JSON.parse(text) };
	};
	return { engine, call, client };
}

describe('glossary MCP tools (spec 17 SC-091)', () => {
	it('annotations: list is read-only, save idempotent, remove destructive', async () => {
		const { client } = await connect();
		const tools = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
		expect(tools.list_glossary).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
		expect(tools.save_glossary_entry).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(tools.remove_glossary_entry).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
	});

	it('save merges by right spelling and is idempotent; list filters by text and language', async () => {
		const { call, engine } = await connect();
		const a = await call('save_glossary_entry', { to: 'NovaPlay Studio', from: ['nova play studio'], lang: 'es' });
		expect(a.r.isError, JSON.stringify(a.json)).toBeFalsy();
		expect(a.json).toMatchObject({ created: true, changed: true, entry: { to: 'NovaPlay Studio', count: 0 } });
		const again = await call('save_glossary_entry', { to: 'NovaPlay Studio', from: ['nova play studio'], lang: 'es' });
		expect(again.json).toMatchObject({ created: false, changed: false });
		const merged = await call('save_glossary_entry', { to: 'NovaPlay Studio', from: ['novaplei estudio'], lang: 'es' });
		expect(merged.json.entry.from).toEqual(['nova play studio', 'novaplei estudio']);
		await call('save_glossary_entry', { to: 'Glimmerbox', from: ['glimer box'] });
		expect(engine.state.revision).toBe(3);
		const all = await call('list_glossary');
		expect(all.json).toMatchObject({ readOnly: false, total: 2 });
		expect(all.json.repairs).toBeUndefined();
		expect((await call('list_glossary', { query: 'NOVAPLEI' })).json.entries.map((e: { to: string }) => e.to)).toEqual([
			'NovaPlay Studio',
		]);
		// lang "en": entries for any language and for English only
		expect((await call('list_glossary', { lang: 'en' })).json.entries.map((e: { to: string }) => e.to)).toEqual([
			'Glimmerbox',
		]);
	});

	it('remove needs the user: a denial is a tool error, an approval removes', async () => {
		const { call, engine } = await connect();
		const saved = await call('save_glossary_entry', { to: 'Pixelforge', from: ['pixel forge'] });
		const entryId = saved.json.entry.entryId as string;
		const denied = await call('remove_glossary_entry', { entryId });
		expect(denied.r.isError).toBe(true);
		expect(denied.json.error.code).toBe('E_APPROVAL_DENIED');
		expect(denied.json.error.hint).toMatch(/Do not retry/);
		expect(engine.state.entries).toHaveLength(1);
		engine.state.approve = true;
		const ok = await call('remove_glossary_entry', { entryId });
		expect(ok.json).toMatchObject({ ok: true, removed: entryId });
		const missing = await call('remove_glossary_entry', { entryId });
		expect(missing.json.error.code).toBe('E_NOT_FOUND');
	});

	it('read-only glossary, limits and bad arguments are tool errors', async () => {
		const { call, engine } = await connect();
		const tooMany = await call('save_glossary_entry', {
			to: 'Glimmerbox',
			from: Array.from({ length: 21 }, (_, i) => `g${i}`),
		});
		expect(tooMany.json.error.code).toBe('E_INVALID_ARGUMENT');
		const blank = await call('save_glossary_entry', { to: '   ', from: [] });
		expect(blank.json.error.code).toBe('E_INVALID_PARAM');
		const unknown = await call('save_glossary_entry', { to: 'X1', from: [], force: true });
		expect(unknown.json.error.code).toBe('E_UNKNOWN_ARGUMENT');
		engine.state.readOnly = true;
		const ro = await call('save_glossary_entry', { to: 'Glimmerbox', from: [] });
		expect(ro.json.error.code).toBe('E_READ_ONLY');
		const list = await call('list_glossary');
		expect(list.json).toMatchObject({ readOnly: true, repairs: [expect.stringContaining('read-only')] });
	});
});
