// Help ▸ Connect an AI Agent… (ARCHITECTURE §11): JasperEditor has no in-app agent; external coding
// agents (Claude Code, Codex CLI, Cursor…) drive it through the `jasper-mcp` MCP server. This dialog shows
// copyable configuration with the real paths: the desktop app provides them through its preload bridge,
// otherwise the engine reports where its sibling bundle lives (GET /api/agent/mcp-info). The engine token
// is never shown: jasper-mcp reads it from <appdir>/engine/runtime.json on the user's machine.
import type { AgentMcpInfo } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { Dialog, type HostedDialogProps, Icon, registerDialog, toast } from '@jasper/ui';
import { useEffect, useState } from 'react';
import { type DesktopMcpInfo, getDesktopBridge } from '../runtime/platform.ts';

export const CONNECT_AGENT_DIALOG = 'shell.connectAgent';

/** Shown when the bundle path is unknown (web build served by a remote or older engine). */
const MCP_ENTRY_PLACEHOLDER = '/absolute/path/to/JasperEditor/apps/mcp/dist/jasper-mcp.mjs';

export type McpLaunch = {
	/** Absolute path of jasper-mcp.mjs (or the placeholder). */
	entry: string;
	/** True when `entry` is a real path on this machine. */
	entryKnown: boolean;
	command: string;
	env: Record<string, string>;
	/** Engine Streamable HTTP endpoint, offered only when it needs no token. */
	httpUrl: string | null;
};

export type AgentSnippet = {
	id: 'claude-cli' | 'claude-json' | 'codex-cli' | 'codex-toml' | 'cursor-json' | 'claude-http';
	client: 'Claude Code' | 'Codex CLI' | 'Cursor';
	/** Where the text goes. */
	where: string;
	text: string;
};

/**
 * Quotes a shell word when it needs it. Double quotes work in POSIX shells, PowerShell and cmd; backslashes
 * stay as they are so Windows paths survive (inside POSIX double quotes `\P` is a literal backslash + P).
 */
function shellWord(s: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["$`])/g, '\\$1')}"`;
}

/** Merges what the desktop bridge and the engine know into one launch description. */
export function resolveMcpLaunch(desktop: DesktopMcpInfo | null, engine: AgentMcpInfo | null): McpLaunch {
	const entry = desktop?.entry ?? engine?.stdioEntry ?? null;
	// The desktop's runner (the app binary with ELECTRON_RUN_AS_NODE) only applies to its own bundle.
	const useDesktopRunner = !!desktop?.entry;
	return {
		entry: entry ?? MCP_ENTRY_PLACEHOLDER,
		entryKnown: entry !== null,
		command: useDesktopRunner ? desktop!.command : 'node',
		env: useDesktopRunner ? desktop!.env : {},
		httpUrl: engine && !engine.tokenRequired ? engine.httpUrl : null,
	};
}

export function buildAgentSnippets(l: McpLaunch): AgentSnippet[] {
	const envPairs = Object.entries(l.env);
	const json = JSON.stringify(
		{
			mcpServers: {
				jasper: {
					command: l.command,
					args: [l.entry],
					...(envPairs.length ? { env: l.env } : {}),
				},
			},
		},
		null,
		2,
	);
	const run = `${shellWord(l.command)} ${shellWord(l.entry)}`;
	const envFlags = envPairs.map(([k, v]) => `--env ${shellWord(`${k}=${v}`)} `).join('');
	const toml = [
		'[mcp_servers.jasper]',
		`command = ${JSON.stringify(l.command)}`,
		`args = [${JSON.stringify(l.entry)}]`,
		...(envPairs.length
			? [`env = { ${envPairs.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')} }`]
			: []),
	].join('\n');
	const out: AgentSnippet[] = [
		{
			id: 'claude-cli',
			client: 'Claude Code',
			where: 'Run in a terminal (add --scope user to use it in every project)',
			// The name comes first: Claude Code's `--env` takes several values and would swallow it.
			text: `claude mcp add jasper ${envFlags}-- ${run}`,
		},
		{
			id: 'claude-json',
			client: 'Claude Code',
			where: '.mcp.json in a project folder (shared with the project)',
			text: json,
		},
		{
			id: 'codex-cli',
			client: 'Codex CLI',
			where: 'Run in a terminal',
			text: `codex mcp add ${envFlags}jasper -- ${run}`,
		},
		{ id: 'codex-toml', client: 'Codex CLI', where: '~/.codex/config.toml', text: toml },
		{
			id: 'cursor-json',
			client: 'Cursor',
			where: '.cursor/mcp.json in a project folder (or ~/.cursor/mcp.json)',
			text: json,
		},
	];
	if (l.httpUrl)
		out.push({
			id: 'claude-http',
			client: 'Claude Code',
			where: 'Alternative without a local process: the engine’s Streamable HTTP endpoint',
			text: `claude mcp add --transport http jasper ${l.httpUrl}`,
		});
	return out;
}

async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// Clipboard API unavailable (insecure context, denied permission): fall back to a hidden field.
		try {
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.setAttribute('readonly', '');
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();
			const ok = document.execCommand('copy');
			ta.remove();
			return ok;
		} catch {
			return false;
		}
	}
}

function Snippet({ s }: { s: AgentSnippet }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const t = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(t);
	}, [copied]);
	return (
		<div className="flex flex-col gap-1" data-testid={`agent-snippet-${s.id}`}>
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 text-pr-small text-pr-muted">{s.where}</span>
				<button
					type="button"
					className="inline-flex h-6 shrink-0 items-center gap-1 rounded-pr-control border border-pr-border-strong px-2 text-pr-small hover:bg-pr-hover"
					aria-label={`Copy: ${s.where}`}
					data-testid={`agent-snippet-copy-${s.id}`}
					onClick={() =>
						void copyText(s.text).then((ok) => {
							if (ok) setCopied(true);
							else toast({ kind: 'warning', title: 'Could not copy; select the text instead' });
						})
					}
				>
					<Icon id={copied ? 'app.check' : 'app.copy'} size={12} />
					{copied ? 'Copied' : 'Copy'}
				</button>
			</div>
			<pre className="max-h-64 overflow-auto rounded-pr-control bg-pr-field-deep p-2 font-pr-mono text-pr-small whitespace-pre-wrap break-all text-pr-text select-text">
				{s.text}
			</pre>
		</div>
	);
}

type Loaded = { desktop: DesktopMcpInfo | null; engine: AgentMcpInfo | null };

function ConnectAgentDialog(props: HostedDialogProps<{ engine?: EngineClient | null }>) {
	const [info, setInfo] = useState<Loaded | null>(null);
	const engine = props.engine ?? null;
	useEffect(() => {
		let cancelled = false;
		void Promise.all([
			getDesktopBridge()
				?.mcpInfo?.()
				.catch(() => null) ?? null,
			engine?.agentMcpInfo().catch(() => null) ?? null,
		]).then(([desktop, eng]) => {
			if (!cancelled) setInfo({ desktop: desktop ?? null, engine: eng ?? null });
		});
		return () => {
			cancelled = true;
		};
	}, [engine]);

	const launch = info ? resolveMcpLaunch(info.desktop, info.engine) : null;
	const snippets = launch ? buildAgentSnippets(launch) : [];
	const clients = ['Claude Code', 'Codex CLI', 'Cursor'] as const;
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Connect an AI Agent"
			size="large"
			data-testid="connect-agent-dialog"
		>
			<div className="flex flex-col gap-4">
				<p className="text-pr-text">
					JasperEditor is driven by external coding agents through its MCP server, <code>jasper-mcp</code>.
					Add it to your agent once; it then finds this running editor by itself. Edits appear here live as
					“Agent: …” History entries that you can undo, and deleting tracks or items asks for your approval in
					this window.
				</p>
				{launch === null ? (
					<p className="text-pr-muted" data-testid="connect-agent-loading">
						Looking for the MCP server…
					</p>
				) : (
					<>
						{launch.entryKnown ? null : (
							<p className="text-pr-warning" role="status" data-testid="connect-agent-missing">
								The MCP server bundle was not found next to the engine. In a source checkout build it with{' '}
								<code>pnpm mcp:build</code>, then replace the placeholder path below with the absolute path of{' '}
								<code>apps/mcp/dist/jasper-mcp.mjs</code>.
							</p>
						)}
						{clients.map((c) => (
							<section key={c} className="flex flex-col gap-2">
								<h3 className="font-semibold text-pr-strong">{c}</h3>
								{snippets
									.filter((s) => s.client === c)
									.map((s) => (
										<Snippet key={s.id} s={s} />
									))}
							</section>
						))}
						<p className="text-pr-small text-pr-muted">
							Requires Node.js 20 or newer on the PATH when the command is <code>node</code>. The server talks
							only to the engine on this computer (127.0.0.1); add <code>--start-engine</code> to its
							arguments to let agents work while JasperEditor is closed. After connecting, ask the agent to
							call <code>engine_status</code>.
						</p>
					</>
				)}
			</div>
		</Dialog>
	);
}

let registered = false;
/** Registers the dialog with the dialog host (idempotent). */
export function registerConnectAgentDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(CONNECT_AGENT_DIALOG, ConnectAgentDialog);
}
