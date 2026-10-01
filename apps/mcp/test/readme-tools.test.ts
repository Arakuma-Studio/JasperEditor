// S11:FIX-006: the README's MCP tool list names every tool the server registers, and its count is right.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FixedEngineLink } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../README.md'), 'utf8');

describe('README tool list (S11:FIX-006)', () => {
	it('lists every registered tool and states the right count', async () => {
		const { server } = createJasperMcpServer({
			link: new FixedEngineLink('http://127.0.0.1:9', 'token'),
			agentName: 'readme-tools',
		});
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const client = new Client({ name: 'readme-tools', version: '1' });
		await client.connect(b);
		const names = (await client.listTools()).tools.map((t) => t.name);
		await client.close();
		expect(names.filter((n) => !readme.includes(`\`${n}\``))).toEqual([]);
		expect(readme).toContain(`Tools (${names.length};`);
	});
});
