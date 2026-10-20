import type { EngineClient } from '@jasper/engine-client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

it('ui_state preserves window measurements alongside the relay identity', async () => {
	const upstream = {
		agentUi: async () => ({
			result: {
				window: {
					width: 1280,
					height: 720,
					devicePixelRatio: 2,
					projectId: 'untrusted-project',
					sessionId: 'untrusted-session',
				},
			},
			window: { projectId: 'prj_editor', sessionId: 'ses_editor' },
		}),
	} satisfies Pick<EngineClient, 'agentUi'>;
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => upstream as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	const { server } = createJasperMcpServer({ link });
	const client = new Client({ name: 'ui-state-test', version: '1' });
	const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
	try {
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		const result = (await client.callTool({ name: 'ui_state', arguments: {} })) as CallToolResult;
		expect(result.isError).not.toBe(true);
		const text = result.content.find((content) => content.type === 'text');
		expect(JSON.parse(text?.text ?? 'null')).toMatchObject({
			window: {
				width: 1280,
				height: 720,
				devicePixelRatio: 2,
				projectId: 'prj_editor',
				sessionId: 'ses_editor',
			},
		});
	} finally {
		await client.close();
		await server.close();
	}
});
