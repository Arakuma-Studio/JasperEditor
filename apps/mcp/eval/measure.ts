// What the model actually receives from this server, per context, from a real `tools/list`: name, description, input
// schema and instructions. Titles and annotations stay out: harnesses keep them from the model.
//   pnpm --filter @jasper/mcp eval:measure
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createJasperMcpServer } from '../src/server.ts';
import { TOOLSET_NAMES } from '../src/toolsets.ts';

export type ToolWeight = { name: string; description: number; schema: number; total: number };
export type ContextWeight = {
	context: string;
	tools: number;
	names: number;
	descriptions: number;
	schemas: number;
	instructions: number;
	total: number;
};
type Listing = {
	tools: { name: string; description?: string; inputSchema: unknown }[];
	instructions: string;
};

const bytes = (s: string) => Buffer.byteLength(s);

async function listing(toolsets: string): Promise<Listing> {
	const link = {
		target: { url: 'http://engine.measure', token: null, source: 'explicit' as const },
		client: async () => {
			throw new Error('measuring needs no engine');
		},
		invalidate: () => {},
		close: async () => {},
	};
	const { server } = createJasperMcpServer({ link: link as never, agentName: 'measure', toolsets });
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'measure', version: '1' });
	await Promise.all([server.connect(a), client.connect(b)]);
	const { tools } = await client.listTools();
	const instructions = client.getInstructions() ?? '';
	await client.close();
	return { tools, instructions };
}

export function weighTool(t: Listing['tools'][number]): ToolWeight {
	const description = bytes(t.description ?? '');
	const schema = bytes(JSON.stringify(t.inputSchema));
	return { name: t.name, description, schema, total: bytes(t.name) + description + schema };
}

function weighContext(context: string, tools: Listing['tools'], instructions: string): ContextWeight {
	const weights = tools.map(weighTool);
	const sum = (key: 'description' | 'schema' | 'total') => weights.reduce((s, w) => s + w[key], 0);
	return {
		context,
		tools: tools.length,
		names: tools.reduce((s, t) => s + bytes(t.name), 0),
		descriptions: sum('description'),
		schemas: sum('schema'),
		instructions: bytes(instructions),
		total: sum('total') + bytes(instructions),
	};
}

/** Core, what each toolset adds to core, and everything. */
export async function measureContexts(): Promise<{ contexts: ContextWeight[]; tools: ToolWeight[] }> {
	const core = await listing('core');
	const all = await listing('all');
	const coreNames = new Set(core.tools.map((t) => t.name));
	const contexts = [weighContext('core', core.tools, core.instructions)];
	for (const name of TOOLSET_NAMES) {
		if (name === 'core') continue;
		const set = await listing(name);
		contexts.push(
			weighContext(
				`+${name}`,
				set.tools.filter((t) => !coreNames.has(t.name)),
				'',
			),
		);
	}
	contexts.push(weighContext('all', all.tools, all.instructions));
	return { contexts, tools: all.tools.map(weighTool).sort((a, b) => b.total - a.total) };
}

if (process.argv[1]?.endsWith('measure.ts')) {
	const { contexts, tools } = await measureContexts();
	if (process.argv.includes('--write-budget')) {
		const headroom = (n: number) => Math.ceil(n * 1.02);
		const budget = {
			contexts: Object.fromEntries(contexts.map((c) => [c.context, headroom(c.total)])),
			tool: headroom(tools[0]?.total ?? 0),
		};
		writeFileSync(new URL('./budget.json', import.meta.url), `${JSON.stringify(budget, null, '\t')}\n`);
	}
	console.table(contexts.map((c) => ({ ...c, tokens: Math.round(c.total / 4) })));
	console.table(tools.slice(0, 10));
	process.exit(0);
}
