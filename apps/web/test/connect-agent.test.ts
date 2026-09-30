// Help ▸ Connect an AI Agent… (wp-mcp): the configuration snippets for Claude Code, Codex CLI and Cursor.
import { describe, expect, it } from 'vitest';
import {
	buildAgentSnippets,
	MCP_ENTRY_PLACEHOLDER,
	resolveMcpLaunch,
	shellWord,
} from '../src/shell/connect-agent.tsx';

const byId = (l: Parameters<typeof buildAgentSnippets>[0]) =>
	Object.fromEntries(buildAgentSnippets(l).map((s) => [s.id, s.text]));

describe('resolveMcpLaunch', () => {
	it('uses the engine-reported bundle with plain node (web / dev checkout)', () => {
		const l = resolveMcpLaunch(null, {
			stdioEntry: '/home/me/JasperEditor/apps/mcp/dist/jasper-mcp.mjs',
			httpUrl: 'http://127.0.0.1:47900/mcp',
			tokenRequired: false,
		});
		expect(l).toEqual({
			entry: '/home/me/JasperEditor/apps/mcp/dist/jasper-mcp.mjs',
			entryKnown: true,
			command: 'node',
			env: {},
			httpUrl: 'http://127.0.0.1:47900/mcp',
		});
	});

	it('prefers the desktop bridge (packaged app runs the bundle with its own binary) and hides token-mode HTTP', () => {
		const l = resolveMcpLaunch(
			{
				entry: '/opt/JasperEditor/resources/mcp/jasper-mcp.mjs',
				command: '/opt/JasperEditor/jasper-editor',
				env: { ELECTRON_RUN_AS_NODE: '1' },
			},
			{ stdioEntry: '/elsewhere/jasper-mcp.mjs', httpUrl: 'http://127.0.0.1:51234/mcp', tokenRequired: true },
		);
		expect(l.entry).toBe('/opt/JasperEditor/resources/mcp/jasper-mcp.mjs');
		expect(l.command).toBe('/opt/JasperEditor/jasper-editor');
		expect(l.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
		// The desktop engine's token changes on every launch: a URL config would go stale.
		expect(l.httpUrl).toBeNull();
	});

	it('falls back to the engine path with node when the desktop has no bundle, and to a placeholder', () => {
		const viaEngine = resolveMcpLaunch(
			{ entry: null, command: '/opt/app', env: { ELECTRON_RUN_AS_NODE: '1' } },
			{ stdioEntry: '/x/jasper-mcp.mjs', httpUrl: 'http://127.0.0.1:1/mcp', tokenRequired: true },
		);
		expect(viaEngine).toMatchObject({ entry: '/x/jasper-mcp.mjs', command: 'node', env: {} });
		expect(resolveMcpLaunch(null, null)).toEqual({
			entry: MCP_ENTRY_PLACEHOLDER,
			entryKnown: false,
			command: 'node',
			env: {},
			httpUrl: null,
		});
	});
});

describe('buildAgentSnippets', () => {
	it('gives exact commands and config files for a checkout', () => {
		const entry = '/home/me/JasperEditor/apps/mcp/dist/jasper-mcp.mjs';
		const s = byId({
			entry,
			entryKnown: true,
			command: 'node',
			env: {},
			httpUrl: 'http://127.0.0.1:47900/mcp',
		});
		expect(s['claude-cli']).toBe(`claude mcp add jasper -- node ${entry}`);
		expect(s['codex-cli']).toBe(`codex mcp add jasper -- node ${entry}`);
		expect(s['codex-toml']).toBe(`[mcp_servers.jasper]\ncommand = "node"\nargs = ["${entry}"]`);
		expect(JSON.parse(s['claude-json']!)).toEqual({
			mcpServers: { jasper: { command: 'node', args: [entry] } },
		});
		expect(s['cursor-json']).toBe(s['claude-json']);
		expect(s['claude-http']).toBe('claude mcp add --transport http jasper http://127.0.0.1:47900/mcp');
	});

	it('quotes paths with spaces, escapes Windows paths in JSON/TOML and carries the environment', () => {
		const s = byId({
			entry: 'C:\\Program Files\\JasperEditor\\resources\\mcp\\jasper-mcp.mjs',
			entryKnown: true,
			command: 'C:\\Program Files\\JasperEditor\\JasperEditor.exe',
			env: { ELECTRON_RUN_AS_NODE: '1' },
			httpUrl: null,
		});
		expect(s['claude-cli']).toBe(
			'claude mcp add jasper --env ELECTRON_RUN_AS_NODE=1 -- ' +
				'"C:\\Program Files\\JasperEditor\\JasperEditor.exe" "C:\\Program Files\\JasperEditor\\resources\\mcp\\jasper-mcp.mjs"',
		);
		expect(JSON.parse(s['cursor-json']!).mcpServers.jasper).toEqual({
			command: 'C:\\Program Files\\JasperEditor\\JasperEditor.exe',
			args: ['C:\\Program Files\\JasperEditor\\resources\\mcp\\jasper-mcp.mjs'],
			env: { ELECTRON_RUN_AS_NODE: '1' },
		});
		expect(s['codex-toml']).toContain('env = { ELECTRON_RUN_AS_NODE = "1" }');
		expect(s['codex-toml']).toContain('command = "C:\\\\Program Files\\\\JasperEditor\\\\JasperEditor.exe"');
		expect(s['claude-http']).toBeUndefined();
	});

	it('shellWord leaves plain words alone and quotes the rest', () => {
		expect(shellWord('/usr/bin/node')).toBe('/usr/bin/node');
		expect(shellWord('/Applications/Jasper Editor.app/x')).toBe('"/Applications/Jasper Editor.app/x"');
		expect(shellWord('a"b$c')).toBe('"a\\"b\\$c"');
	});
});
