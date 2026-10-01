// M2 animation contracts in the MCP server (ARCHITECTURE §20.7): tools/animation.ts and tools/shapes.ts are
// wired in server.ts; animation contributes nothing until wp-m2-text-anim lands.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FixedEngineLink } from '../src/link.ts';
import { createJasperMcpServer, EDITING_GUIDE } from '../src/server.ts';
import { ANIMATION_GUIDE } from '../src/tools/animation.ts';
import { SHAPES_GUIDE } from '../src/tools/shapes.ts';

describe('animation and shapes tool modules', () => {
	it('are registered; shapes (wp-m2-shapes) add add_shape and their guide section', async () => {
		expect(ANIMATION_GUIDE).toBe('');
		expect(SHAPES_GUIDE).toMatch(/^Shapes/);
		const { server } = createJasperMcpServer({
			link: new FixedEngineLink('http://127.0.0.1:9', 'token'),
			agentName: 'anime-contracts',
		});
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const client = new Client({ name: 'anime-contracts', version: '1' });
		await client.connect(b);
		const names = (await client.listTools()).tools.map((t) => t.name);
		for (const n of ['list_text_animations', 'set_text_animation']) expect(names).not.toContain(n);
		expect(names).toContain('add_shape');
		expect(new Set(names).size).toBe(names.length);
		const instructions = client.getInstructions() ?? '';
		expect(instructions.startsWith(EDITING_GUIDE)).toBe(true);
		expect(instructions).toContain(SHAPES_GUIDE);
		expect(instructions).not.toMatch(/\n\n\n/);
		await client.close();
	});
});
