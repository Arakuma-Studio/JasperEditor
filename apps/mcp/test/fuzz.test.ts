// Every MCP tool's arguments under the never-crash harness (golden-fuzz; docs/testing.md §4): mutated and arbitrary
// arguments are answered with a tool result (`isError` with a message for anything it refuses) or the protocol's
// typed InvalidParams error — never a transport failure, a result without content, or a hang. The tools run against
// an in-memory engine whose document goes through the real command system; every other engine call fails with a
// typed EngineError (the "engine said no" path). Tools are taken from `tools/list`, so new tools are fuzzed
// automatically, with seeds generated from their input schemas.
import { EngineError } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
} from '@jasper/project';
import { describeFuzz, jsonTarget } from '@jasper/testkit/fuzz';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

function engineLink(): EngineConnection {
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Fuzz', preset: 'hd-1080p-30' });
	let revision = 0;
	const known: Record<string, (...a: never[]) => unknown> = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => {
			const r = applyTransaction(
				doc,
				{ protocol: 'jasper.tx/1', ...req.transaction, origin: 'user' } as never,
				{
					ids,
					now: () => '2026-10-08T00:00:00.000Z',
					revision,
					registries: defaultRegistries(),
				},
			);
			if (r.result.ok && !req.transaction.dryRun) {
				doc = r.document;
				revision++;
			}
			return { result: r.result, appliedBy: 'headless' };
		},
	};
	const client = new Proxy(known, {
		get: (t, name: string) =>
			// Not a thenable: `client()` resolves to this object, and a `then` here would swallow the resolution.
			name === 'then'
				? undefined
				: (t[name] ??
					(async () => {
						throw new EngineError('NOT_FOUND', `the fuzz engine does not answer ${name}`, { status: 404 });
					})),
	});
	return {
		target: { url: 'http://engine.fuzz', token: null, source: 'explicit' },
		client: async () => client as never,
		invalidate: () => {},
		close: async () => {},
	};
}

const { server } = createJasperMcpServer({ link: engineLink(), agentName: 'fuzz' });
const [x, y] = InMemoryTransport.createLinkedPair();
await server.connect(x);
const client = new Client({ name: 'fuzz', version: '1' });
await client.connect(y);
afterAll(async () => {
	await client.close();
});
const { tools } = await client.listTools();

type JsonSchema = {
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	enum?: unknown[];
};

/** A plausible value of a JSON schema (first enum value, a sample per type). */
function sample(s: JsonSchema | undefined, depth = 0): unknown {
	if (!s || depth > 4) return null;
	if (s.enum?.length) return s.enum[0];
	const t = Array.isArray(s.type) ? s.type[0] : s.type;
	if (t === 'string') return 'x';
	if (t === 'number' || t === 'integer') return 1;
	if (t === 'boolean') return true;
	if (t === 'array') return [sample(s.items, depth + 1)];
	if (t === 'object' || s.properties)
		return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sample(v, depth + 1)]));
	return null;
}

/** A tool call that has not answered after this long counts as a hang. */
const CALL_TIMEOUT_MS = 10_000;

async function call(name: string, args: unknown): Promise<void> {
	try {
		const r = await client.callTool({ name, arguments: args as Record<string, unknown> }, undefined, {
			timeout: CALL_TIMEOUT_MS,
		});
		if (!Array.isArray(r.content) || r.content.length === 0)
			throw new Error(`${name}: a result without content`);
	} catch (e) {
		if (e instanceof McpError && e.code === ErrorCode.RequestTimeout)
			throw new Error(
				`${name}: no answer within ${CALL_TIMEOUT_MS} ms (args ${JSON.stringify(args)?.slice(0, 200)})`,
			);
		if (e instanceof McpError) return; // InvalidParams and friends: the protocol's typed refusal
		throw e;
	}
}

describeFuzz(
	'@jasper/mcp tool arguments',
	tools.map((t) =>
		jsonTarget(
			t.name,
			[{}, sample(t.inputSchema as JsonSchema) ?? {}, { projectId: 'prj_0000000000000001' }],
			(args) => call(t.name, args),
			undefined,
			{ iterations: 20, properties: 6, slowMs: 12_000 },
		),
	),
	600_000,
);

// The harness itself: tools answer (a refusal is still an answer), so the targets above exercise real handlers.
it('the in-memory engine reaches the tool handlers', async () => {
	const r = await client.callTool({ name: 'get_document', arguments: { projectId: 'prj_0000000000000001' } });
	expect(Array.isArray(r.content) && r.content.length > 0).toBe(true);
	const refused = await client.callTool({ name: 'list_projects', arguments: {} });
	expect(refused.isError).toBe(true);
	expect(JSON.stringify(refused.content)).toMatch(/fuzz engine does not answer/);
});
