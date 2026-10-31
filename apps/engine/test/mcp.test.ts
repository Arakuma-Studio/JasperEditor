import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';

const TOKEN = 'mcp-test-token';
let engine: RunningEngine;

beforeAll(async () => {
	const appdir = mkdtempSync(join(tmpdir(), 'jasper-engine-mcp-'));
	engine = await startEngine({
		appdir,
		port: 0,
		dev: false,
		token: TOKEN,
		env: { PATH: process.env.PATH },
	});
}, 60_000);
afterAll(async () => {
	await engine?.stop();
});

const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

describe('POST/GET/DELETE /mcp (Streamable HTTP)', () => {
	it('serves the jasper-mcp tools to an SDK client with the engine token', async () => {
		const client = new Client({ name: 'http-test', version: '1' });
		const transport = new StreamableHTTPClientTransport(new URL(`${engine.url}/mcp`), {
			requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
		});
		await client.connect(transport);
		expect(transport.sessionId).toBeTruthy();
		const created = (await client.callTool({
			name: 'create_project',
			arguments: { name: 'Over HTTP' },
		})) as CallToolResult;
		expect(created.isError, text(created)).toBeFalsy();
		const { projectId } = JSON.parse(text(created));
		// A session advertises the core toolset; add_marker is in "editing" (spec 18 AF-CTX-001/002).
		const listed = (await client.listTools()).tools.map((t) => t.name);
		expect(listed).toContain('enable_toolsets');
		expect(listed).not.toContain('add_marker');
		const enabled = (await client.callTool({
			name: 'enable_toolsets',
			arguments: { names: ['editing'] },
		})) as CallToolResult;
		expect(JSON.parse(text(enabled))).toMatchObject({ changed: true });
		expect((await client.listTools()).tools.map((t) => t.name)).toContain('add_marker');
		const marker = (await client.callTool({
			name: 'add_marker',
			arguments: { projectId, at: 15, name: 'HTTP marker' },
		})) as CallToolResult;
		expect(JSON.parse(text(marker))).toMatchObject({ ok: true, appliedBy: 'headless', revision: 1 });
		const doc = await fetch(`${engine.url}/api/projects/${projectId}`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		}).then((r) => r.json());
		expect(
			Object.values(doc.envelope.document.sequences as Record<string, { markers: unknown[] }>)[0]!.markers,
		).toEqual([expect.objectContaining({ name: 'HTTP marker' })]);
		await transport.terminateSession();
		await client.close();
	});

	it('requires the token and a known session', async () => {
		const init = {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
		};
		const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
		const noToken = await fetch(`${engine.url}/mcp`, { method: 'POST', headers, body: JSON.stringify(init) });
		expect(noToken.status).toBe(401);
		const auth = { ...headers, authorization: `Bearer ${TOKEN}` };
		const unknown = await fetch(`${engine.url}/mcp`, {
			method: 'POST',
			headers: { ...auth, 'mcp-session-id': 'nope' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
		});
		expect(unknown.status).toBe(404);
		const notInit = await fetch(`${engine.url}/mcp`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
		});
		expect(notInit.status).toBe(400);
		const get = await fetch(`${engine.url}/mcp`, { headers: auth });
		expect(get.status).toBe(400);
	});
});
