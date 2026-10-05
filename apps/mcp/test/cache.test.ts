// S04:CA-019: the MCP protocol reports cache bytes in MB and exposes safe tool annotations.
import type { CacheUsage } from '@jasper/api';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { EngineLink } from '../src/link.ts';
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
	],
	other: [],
	settings: {
		autoClean: true,
		maxTotalBytes: null,
		maxAgeDays: 30,
		kinds: {},
		logs: { maxAgeDays: 30, maxBytes: 256 * MB },
		location: null,
	},
	lastGc: null,
	scannedAt: '2026-10-01T00:00:00.000Z',
};

async function connect() {
	const fetchImpl = (async () =>
		new Response(JSON.stringify(USAGE), { status: 200, headers: { 'x-jasper-api': '1' } })) as typeof fetch;
	const { server } = createJasperMcpServer({
		link: new EngineLink({ url: 'http://127.0.0.1:9', fetch: fetchImpl, log: () => {} }),
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
	return { client, call };
}

describe('media cache MCP tools (S04:CA-019)', () => {
	it('get_cache_usage reports MB and safe tool annotations', async () => {
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
		expect(json.kinds.find((kind: { kind: string }) => kind.kind === 'luts')).toMatchObject({
			sizeMB: 12,
			referencedMB: 2,
			unusedMB: 10,
		});
		const tools = (await client.listTools()).tools;
		expect(tools.find((t) => t.name === 'get_cache_usage')?.annotations?.readOnlyHint).toBe(true);
		expect(tools.find((t) => t.name === 'clean_cache')?.annotations?.destructiveHint).toBe(true);
		await client.close();
	});
});
