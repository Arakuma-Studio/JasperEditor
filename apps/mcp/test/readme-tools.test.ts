import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { EngineLink } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

it('README lists every MCP tool, and only those', async () => {
	const { server } = createJasperMcpServer({
		link: new EngineLink({
			url: 'http://127.0.0.1:9',
			fetch: (async () => new Response('{}')) as typeof fetch,
			log: () => {},
		}),
		agentName: 'readme-test',
	});
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'readme-test', version: '1' });
	await client.connect(b);
	const tools = (await client.listTools()).tools.map((t) => t.name).sort();
	const readme = readFileSync(join(__dirname, '../../../README.md'), 'utf8');
	const section = /^Tools \((\d+)[^)]*\):\n([\s\S]*?)\n\nResources:/m.exec(readme);
	expect(section, 'README "Tools (N):" … "Resources:" section').not.toBeNull();
	const listed = [...new Set([...section![2]!.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!))].sort();
	expect(listed).toEqual(tools);
	expect(Number(section![1])).toBe(tools.length);
	await client.close();
});
