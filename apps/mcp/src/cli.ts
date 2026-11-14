// jasper-mcp: the JasperEditor MCP server over stdio for Claude Code, Codex CLI, Cursor and other MCP
// clients. stdout carries the protocol only; logs go to stderr.
//
//   jasper-mcp [--engine-url <url>] [--token <token>] [--appdir <dir>] [--start-engine]
//              [--engine-entry <engine.mjs>] [--engine-port <port>] [--agent-name <name>] [--toolsets <list>]
import { ENV, readFlag } from '@jasper/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EngineLink } from './link.ts';
import { createJasperMcpServer } from './server.ts';
import { parseToolsets, TOOLSET_NAMES } from './toolsets.ts';
import { MCP_SERVER_VERSION } from './version.ts';

const HELP = `jasper-mcp ${MCP_SERVER_VERSION} — JasperEditor MCP server (stdio)

Options:
  --engine-url <url>     Engine origin (default: discovered; env ${ENV.ENGINE_URL})
  --token <token>        Engine token (env ${ENV.ENGINE_TOKEN}; read from the runtime file otherwise)
  --appdir <dir>         Use only the engine of <dir>/engine/runtime.json
  --start-engine         Start a headless engine when none is running (env JASPER_MCP_START_ENGINE=1)
  --engine-entry <file>  Engine bundle to start (env ${ENV.ENGINE_ENTRY}; default: next to this file)
  --engine-port <port>   Port for --start-engine (default: random)
  --agent-name <name>    Name shown in the editor History (default: the MCP client's name)
  --request-timeout <s>  Deadline for one engine request in seconds (default 180)
  --toolsets <list>      Toolsets to advertise: "all" or a comma list (env JASPER_MCP_TOOLSETS; default core,
                         which is always on). Every tool stays reachable with call_tool. Toolsets:
                         ${TOOLSET_NAMES.join(', ')}
  --help, --version

Discovery order: --engine-url/env, then <appdir>/engine/runtime.json for --appdir alone (never another engine),
else ${ENV.APPDIR}, the platform appdir and the desktop app's appdir, then http://127.0.0.1:47900.`;

function log(line: string): void {
	process.stderr.write(`[jasper-mcp] ${line}\n`);
}

/**
 * stdout carries JSON-RPC only. Anything a dependency prints with console.log/info/debug would corrupt
 * the stream, so those go to stderr for the life of the process.
 */
function keepStdoutClean(): void {
	for (const level of ['log', 'info', 'debug'] as const)
		console[level] = (...args: unknown[]) => console.error(...args);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes('--help') || argv.includes('-h')) {
		process.stderr.write(`${HELP}\n`);
		return;
	}
	if (argv.includes('--version')) {
		process.stdout.write(`${MCP_SERVER_VERSION}\n`);
		return;
	}
	keepStdoutClean();
	const env = process.env;
	let toolsets: string[];
	try {
		toolsets = [...parseToolsets(readFlag(argv, 'toolsets') ?? env.JASPER_MCP_TOOLSETS)];
	} catch (e) {
		log((e as Error).message);
		process.exit(2);
	}
	const timeoutSec = Number(readFlag(argv, 'request-timeout'));
	const truthy = (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false';
	const link = new EngineLink({
		url: readFlag(argv, 'engine-url'),
		token: readFlag(argv, 'token'),
		appdir: readFlag(argv, 'appdir'),
		startEngine: argv.includes('--start-engine') || truthy(env.JASPER_MCP_START_ENGINE),
		engineEntry: readFlag(argv, 'engine-entry'),
		enginePort: readFlag(argv, 'engine-port') ? Number(readFlag(argv, 'engine-port')) : undefined,
		requestTimeoutMs: Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : undefined,
		env,
		log,
	});
	const { server } = createJasperMcpServer({ link, agentName: readFlag(argv, 'agent-name'), toolsets });
	const transport = new StdioServerTransport();

	let closing = false;
	const shutdown = async (why: string) => {
		if (closing) return;
		closing = true;
		log(`shutting down (${why})`);
		const force = setTimeout(() => process.exit(0), 6000);
		force.unref();
		await server.close().catch(() => {});
		await link.close();
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.stdin.on('end', () => void shutdown('stdin closed'));
	transport.onclose = () => void shutdown('transport closed');

	await server.connect(transport);
	log(`ready (v${MCP_SERVER_VERSION}); the engine is discovered on the first tool call`);
}

main().catch((e) => {
	log(`failed: ${(e as Error)?.stack ?? e}`);
	process.exit(1);
});
