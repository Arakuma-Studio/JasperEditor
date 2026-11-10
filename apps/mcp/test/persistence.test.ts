// get_project and transaction results say whether the editor's live revision reached the project file, so an agent
// sees unsaved work (a conflict pausing autosave in the window) without diffing files.
import type { EngineClient } from '@jasper/engine-client';
import { createCounterIdSource, createEmptyProject } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const doc = createEmptyProject({ ids: createCounterIdSource(7), name: 'Live', preset: 'hd-1080p-30' });
	const paused = { state: 'paused-conflict', savedRevision: 40 };
	const client = {
		agentQuery: async () => ({ result: doc, revision: 63, via: 'session', persistence: paused }),
		agentTx: async () => ({
			result: {
				ok: true,
				revision: 64,
				refs: {},
				created: [],
				changed: [],
				deleted: [],
				warnings: [],
				results: [],
			},
			appliedBy: 'session',
			persistence: { state: 'pending', savedRevision: 63 },
		}),
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	const { server } = createJasperMcpServer({ link, agentName: 'persistence-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const mcp = new Client({ name: 'persistence-test', version: '1' });
	await mcp.connect(y);
	open.push(mcp);
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await mcp.callTool({ name, arguments: args })) as CallToolResult;
		return JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;
	};
	return { call, projectId: doc.projectId };
}

describe('saved revision next to the live one', () => {
	it('get_project and apply_commands report savedRevision and persistence', async () => {
		const { call, projectId } = await connect();
		expect(await call('get_project', { projectId })).toMatchObject({
			revision: 63,
			savedRevision: 40,
			persistence: 'paused-conflict',
		});
		expect(
			await call('apply_commands', {
				projectId,
				label: 'Marker',
				commands: [{ type: 'marker.add', frame: 1 }],
			}),
		).toMatchObject({ revision: 64, savedRevision: 63, persistence: 'pending' });
	});
});
