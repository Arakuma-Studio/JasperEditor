// Saved versions, save a copy and recovery journals over MCP (process workstream, D-39).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { EngineLink } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

type Req = { method: string; path: string; body: unknown };

async function connect(route: (r: Req) => [number, unknown]) {
	const requests: Req[] = [];
	const fetchImpl = (async (input: string, init: RequestInit = {}) => {
		const url = new URL(String(input));
		const req = {
			method: (init.method ?? 'GET').toUpperCase(),
			path: url.pathname,
			body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
		};
		requests.push(req);
		const [status, body] = route(req);
		return new Response(JSON.stringify(body), { status, headers: { 'x-jasper-api': '1' } });
	}) as typeof fetch;
	const { server } = createJasperMcpServer({
		link: new EngineLink({ url: 'http://127.0.0.1:9', fetch: fetchImpl, log: () => {} }),
		agentName: 'versions-test',
	});
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'versions-test', version: '1' });
	await client.connect(b);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
		const text = (r.content[0] as { text: string }).text;
		return { r, json: JSON.parse(text) };
	};
	return { client, call, requests };
}

const P = 'prj_0000000000000001';

describe('version tools', () => {
	it('lists versions with their kind and restores as a copy or in place', async () => {
		const { client, call, requests } = await connect((r) => {
			if (r.path === `/api/projects/${P}/versions`)
				return [
					200,
					{
						versions: [
							{
								versionId: '2026-10-07T10-00-00-000Z',
								savedAt: 'x',
								revision: 3,
								sizeBytes: 4096,
								kind: 'auto',
							},
							{
								versionId: 'schema-v4-backup',
								savedAt: 'y',
								revision: 1,
								sizeBytes: 100,
								kind: 'schema-backup',
								schemaVersion: 4,
							},
						],
					},
				];
			if (r.path.endsWith('/restore')) {
				const body = r.body as { mode: string };
				if (body.mode === 'replace')
					return [409, { code: 'LEASE_HELD', message: 'open in an editor', retryable: false }];
				return [200, { projectId: 'prj_0000000000000002', revision: 0, keptAs: null }];
			}
			return [404, { code: 'NOT_FOUND', message: 'nope', retryable: false }];
		});
		const list = await call('list_project_versions', { projectId: P });
		expect(list.json.versions).toEqual([
			{
				versionId: '2026-10-07T10-00-00-000Z',
				savedAt: 'x',
				revision: 3,
				kind: 'auto',
				what: 'auto-saved',
				sizeKB: 4,
			},
			expect.objectContaining({ versionId: 'schema-v4-backup', kind: 'schema-backup', schemaVersion: 4 }),
		]);
		const copy = await call('restore_project_version', {
			projectId: P,
			versionId: 'schema-v4-backup',
			name: 'Old',
		});
		expect(copy.json).toMatchObject({ projectId: 'prj_0000000000000002' });
		expect(requests.at(-1)?.body).toEqual({ mode: 'copy', name: 'Old' });
		const replace = await call('restore_project_version', {
			projectId: P,
			versionId: '2026-10-07T10-00-00-000Z',
			mode: 'replace',
		});
		expect(replace.r.isError).toBe(true);
		expect(replace.json.error).toMatchObject({ code: 'LEASE_HELD' });
		expect(replace.json.error.hint).toMatch(/File ▸ Project Versions/);
		const tools = (await client.listTools()).tools.map((t) => t.name);
		for (const t of [
			'list_project_versions',
			'restore_project_version',
			'save_project_copy',
			'list_unsaved_changes',
		])
			expect(tools).toContain(t);
	});

	it('reports recoverable unsaved changes without acting on them', async () => {
		const { call, requests } = await connect((r) =>
			r.path === `/api/projects/${P}/recovery`
				? [
						200,
						{
							candidates: [
								{
									sessionId: 'ses_a',
									projectId: P,
									projectName: 'Film',
									baseRevision: 2,
									revision: 9,
									startedAt: 'a',
									savedAt: 'b',
									changes: ['Trim'],
									changeCount: 1,
									sizeBytes: 10,
									projectRevision: 2,
								},
							],
						},
					]
				: [404, { code: 'NOT_FOUND', message: 'nope', retryable: false }],
		);
		const { json } = await call('list_unsaved_changes', { projectId: P });
		expect(json.unsaved).toEqual([
			{ sessionId: 'ses_a', savedAt: 'b', changeCount: 1, changes: ['Trim'], savedAgainSince: false },
		]);
		expect(json.next).toMatch(/Recover/);
		expect(requests.every((r) => r.method === 'GET')).toBe(true);
	});
});
