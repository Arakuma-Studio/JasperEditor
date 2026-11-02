// The server a sample talks to: the real `createJasperMcpServer` of a source checkout (its tool list, instructions,
// toolset filter, strict validation, handlers, hints and errors) over stdio, with only the engine faked. Every
// `tools/call` is appended to the sample's log, which is what the grader reads.
//   node --import tsx apps/mcp/eval/stub.ts <sample.json>
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createFakeEngine, type EngineSetup } from './fake-engine.ts';
import type { McpCall } from './grade.ts';

export type StubConfig = {
	/** Checkout whose `apps/mcp/src/server.ts` is under test (the current one, or a baseline's). */
	sourceRoot: string;
	engine: EngineSetup;
	toolsets?: string;
	log: string;
};

type Handler = (request: unknown, extra: unknown) => Promise<unknown>;

export function errorCodeOf(result: CallToolResult): string | undefined {
	const first = result.content?.[0];
	if (first?.type !== 'text') return undefined;
	try {
		return (JSON.parse(first.text) as { error?: { code?: string } }).error?.code;
	} catch {
		return undefined;
	}
}

/** Starts the stub's server from `config` and returns it unconnected. */
export async function buildStub(config: StubConfig) {
	const { createJasperMcpServer } = (await import(
		join(config.sourceRoot, 'apps/mcp/src/server.ts')
	)) as typeof import('../src/server.ts');
	const engine = createFakeEngine(config.engine);
	const link = {
		target: { url: 'http://engine.eval', token: null, source: 'explicit' as const },
		client: async () => engine.client,
		invalidate: () => {},
		close: async () => {},
	};
	const { server } = createJasperMcpServer({
		link: link as never,
		agentName: 'eval',
		toolsets: config.toolsets ?? 'core',
	});
	const handlers = (server.server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
	const call = handlers.get('tools/call')!;
	handlers.set('tools/call', async (request, extra) => {
		const params = (request as { params: { name: string; arguments?: Record<string, unknown> } }).params;
		const result = (await call(request, extra)) as CallToolResult;
		const inner = params.name === 'call_tool' ? params.arguments : undefined;
		const entry: McpCall = {
			tool: typeof inner?.name === 'string' ? inner.name : params.name,
			args: (inner ? (inner.arguments as Record<string, unknown>) : params.arguments) ?? {},
			isError: result.isError === true,
			...(result.isError ? { errorCode: errorCodeOf(result) } : {}),
			...(inner ? { viaCallTool: true } : {}),
		};
		const unmodelled = engine.takeUnmodelled();
		if (unmodelled.length) entry.unmodelled = unmodelled;
		appendFileSync(config.log, `${JSON.stringify(entry)}\n`);
		return result;
	});
	return { server, engine };
}

if (process.argv[1]?.endsWith('stub.ts')) {
	const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as StubConfig;
	const { server } = await buildStub(config);
	await server.connect(new StdioServerTransport());
}
