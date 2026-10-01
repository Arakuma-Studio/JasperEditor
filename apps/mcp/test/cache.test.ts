// Media cache tools (M3, S04:CA-019): get_cache_usage summarises the engine's usage in MB per kind; clean_cache
// forwards the mode and kinds and reports what was freed. The engine is a fetch stub (the routes are tested in
// apps/engine/test/cache.test.ts).
import type { CacheGcReport, CacheUsage } from '@jasper/api';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { FixedEngineLink } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const MB = 1024 * 1024;

const USAGE: CacheUsage = {
	location: '/tmp/app',
	totalBytes: 300 * MB,
	inUseBytes: 100 * MB,
	referencedBytes: 150 * MB,
	unusedBytes: 50 * MB,
	maxTotalBytes: 25 * 1024 * MB,
	automaticBudget: true,
	freeDiskBytes: 1000 * MB,
	kinds: [
		{
			kind: 'luts',
			label: 'Colour LUTs',
			description: '',
			entries: 12,
			bytes: 12 * MB,
			inUseBytes: 0,
			referencedBytes: 2 * MB,
			unusedBytes: 10 * MB,
			maxBytes: null,
			maxAgeDays: 30,
			defaultMaxAgeDays: 30,
			oldestAccess: null,
		},
		{
			kind: 'warp',
			label: 'Warped layers',
			description: '',
			entries: 0,
			bytes: 0,
			inUseBytes: 0,
			referencedBytes: 0,
			unusedBytes: 0,
			maxBytes: null,
			maxAgeDays: 30,
			defaultMaxAgeDays: 30,
			oldestAccess: null,
		},
	],
	other: [],
	settings: { autoClean: true, maxTotalBytes: null, maxAgeDays: 30, kinds: {} },
	lastGc: null,
	scannedAt: '2026-10-01T00:00:00.000Z',
};

async function connect() {
	const calls: { method: string; url: string; body: unknown }[] = [];
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		const path = new URL(url).pathname;
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method: init?.method ?? 'GET', url: path, body });
		const json = (b: unknown) =>
			new Response(JSON.stringify(b), { status: 200, headers: { 'x-jasper-api': '1' } });
		if (path === '/api/cache') return json(USAGE);
		if (path === '/api/cache/clean')
			return json({
				at: '2026-10-01T00:00:00.000Z',
				mode: body.mode,
				removedEntries: 10,
				removedBytes: 10 * MB,
				removedOrphans: 1,
				keptInUse: 0,
				keptReferenced: 2,
				failed: 0,
				byKind: { luts: { entries: 10, bytes: 10 * MB } },
			} satisfies CacheGcReport);
		return new Response('{}', { status: 404 });
	}) as unknown as typeof fetch;
	const { server } = createJasperMcpServer({
		link: new FixedEngineLink('http://127.0.0.1:9', null, fetchImpl),
		agentName: 'cache-test',
	});
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'cache-test', version: '1' });
	await client.connect(b);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
		const text = (r.content[0] as { text: string }).text;
		return { r, json: r.isError ? null : JSON.parse(text), text };
	};
	return { client, call, calls };
}

describe('media cache MCP tools (S04:CA-019)', () => {
	it('get_cache_usage reports MB per kind (only kinds with entries)', async () => {
		const { client, call } = await connect();
		const { json } = await call('get_cache_usage');
		expect(json).toMatchObject({
			totalMB: 300,
			inUseMB: 100,
			referencedMB: 150,
			unusedMB: 50,
			budgetMB: 25600,
			automaticBudget: true,
			lastCleaned: null,
		});
		expect(json.kinds).toEqual([
			{
				kind: 'luts',
				label: 'Colour LUTs',
				entries: 12,
				sizeMB: 12,
				inUseMB: 0,
				referencedMB: 2,
				unusedMB: 10,
				maxAgeDays: 30,
			},
		]);
		const tools = (await client.listTools()).tools;
		expect(tools.find((t) => t.name === 'get_cache_usage')?.annotations?.readOnlyHint).toBe(true);
		expect(tools.find((t) => t.name === 'clean_cache')?.annotations?.destructiveHint).toBe(true);
		await client.close();
	});

	it('clean_cache forwards mode and kinds; bad modes and kinds are rejected', async () => {
		const { client, call, calls } = await connect();
		const { json } = await call('clean_cache', { mode: 'unused', kinds: ['luts'] });
		expect(calls.at(-1)).toEqual({
			method: 'POST',
			url: '/api/cache/clean',
			body: { mode: 'unused', kinds: ['luts'] },
		});
		expect(json).toEqual({
			removedEntries: 10,
			removedMB: 10,
			removedTemporaryFiles: 1,
			keptInUse: 0,
			keptReferenced: 2,
			failed: 0,
			byKind: { luts: { entries: 10, removedMB: 10 } },
		});
		const bad = await call('clean_cache', { mode: 'everything' });
		expect(bad.r.isError).toBe(true);
		const badKind = await call('clean_cache', { mode: 'all', kinds: ['projects'] });
		expect(badKind.r.isError).toBe(true);
		expect(calls.filter((c) => c.url === '/api/cache/clean')).toHaveLength(1);
		await client.close();
	});
});
