// How a sample launches. Each harness gets the real home of the account, an isolated config and the stub as its only
// MCP server, and comes back as the same record: reply, shell commands, errors, cost.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EvalAccount } from './accounts.ts';
import { claudeSessionDir } from './accounts.ts';

export const EVAL_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Tools outside what the eval sandboxes. Web, delegation, scheduling and questions never reach the machine. */
const CLAUDE_DISALLOWED = [
	'Agent',
	'Task',
	'WebFetch',
	'WebSearch',
	'AskUserQuestion',
	'CronCreate',
	'CronDelete',
	'CronList',
	'RemoteTrigger',
	'Monitor',
	'PushNotification',
	'EnterWorktree',
	'ExitWorktree',
	'DesignSync',
	'ScheduleWakeup',
	'Workflow',
	'TaskCreate',
	'TaskUpdate',
	'TaskList',
	'TaskGet',
	'TaskStop',
	'SendMessage',
	'ListAgents',
	'NotebookEdit',
];

export type SampleLaunch = {
	command: string;
	args: string[];
	stdin?: string;
};

export type LaunchInput = {
	account: EvalAccount;
	model: string;
	effort?: string;
	cwd: string;
	workDir: string;
	stubConfig: string;
	maxTurns: number;
	prompt: string;
	resumeSession?: string;
};

/** tsx by absolute path: a stdio server starts in the sample's throwaway cwd, where a bare `tsx` does not resolve. */
const TSX = pathToFileURL(createRequire(join(EVAL_DIR, '../../../package.json')).resolve('tsx')).href;

const stubCommand = (stubConfig: string) => ({
	command: process.execPath,
	args: ['--import', TSX, join(EVAL_DIR, 'stub.ts'), stubConfig],
});

export function claudeLaunch(input: LaunchInput, policyFile: string): SampleLaunch {
	const mcpConfig = join(input.workDir, 'mcp.json');
	const settings = join(input.workDir, 'settings.json');
	const stub = stubCommand(input.stubConfig);
	writeFileSync(
		mcpConfig,
		JSON.stringify({ mcpServers: { jasper: { ...stub, env: { JASPER_MCP_TOOLSETS: '' } } } }),
	);
	writeFileSync(
		settings,
		JSON.stringify({
			env: { JASPER_EVAL_POLICY: policyFile },
			hooks: {
				PreToolUse: [
					{
						matcher: '.*',
						hooks: [
							{
								type: 'command',
								command: `JASPER_EVAL_POLICY=${policyFile} ${process.execPath} ${join(EVAL_DIR, 'sandbox/claude-hook.mjs')}`,
							},
						],
					},
				],
			},
		}),
	);
	return {
		command: 'claude',
		args: [
			'-p',
			'--model',
			input.model,
			...(input.effort ? ['--effort', input.effort] : []),
			'--setting-sources',
			'',
			'--settings',
			settings,
			'--strict-mcp-config',
			'--mcp-config',
			mcpConfig,
			'--permission-mode',
			'bypassPermissions',
			'--disallowed-tools',
			CLAUDE_DISALLOWED.join(','),
			'--output-format',
			'stream-json',
			'--verbose',
			'--max-turns',
			String(input.maxTurns),
			...(input.resumeSession ? ['--resume', input.resumeSession] : ['--no-session-persistence']),
		],
		stdin: input.prompt,
	};
}

/** TOML string for a `-c key=value` override. */
const toml = (value: string) => JSON.stringify(value);

export function codexLaunch(input: LaunchInput, shimDir: string): SampleLaunch {
	const stub = stubCommand(input.stubConfig);
	return {
		command: 'codex',
		args: [
			'exec',
			'--json',
			'--ephemeral',
			'--ignore-user-config',
			'--ignore-rules',
			'--disable',
			'apps',
			'--disable',
			'plugins',
			'--skip-git-repo-check',
			'--sandbox',
			'read-only',
			'--cd',
			input.cwd,
			'--model',
			input.model,
			...(input.effort ? ['-c', `model_reasoning_effort=${toml(input.effort)}`] : []),
			'-c',
			'approval_policy="never"',
			'-c',
			`project_doc_max_bytes=0`,
			'-c',
			`mcp_servers.jasper.command=${toml(stub.command)}`,
			'-c',
			`mcp_servers.jasper.args=[${stub.args.map(toml).join(',')}]`,
			'-c',
			'mcp_servers.jasper.startup_timeout_sec=60',
			'-c',
			'mcp_servers.jasper.required=true',
			'-c',
			'mcp_servers.jasper.default_tools_approval_mode="approve"',
			'-c',
			`shell_environment_policy.set={PATH=${toml(`${shimDir}:${process.env.PATH ?? ''}`)}}`,
			'-',
		],
		stdin: input.prompt,
	};
}

/** Commands a Codex sample's shell finds first, so what the sandbox would not stop still answers from the case. */
const SHIMMED = [
	'ffmpeg',
	'ffprobe',
	'jasper',
	'pnpm',
	'npm',
	'npx',
	'curl',
	'wget',
	'pip',
	'python',
	'python3',
];

export function writeShellShims(shimDir: string, policyFile: string): void {
	mkdirSync(shimDir, { recursive: true });
	const policyModule = join(EVAL_DIR, 'sandbox/shell-policy.mjs');
	for (const name of SHIMMED)
		writeFileSync(
			join(shimDir, name),
			`#!${process.execPath}
import { readFileSync } from 'node:fs';
import { cannedShell } from ${JSON.stringify(policyModule)};
const policy = JSON.parse(readFileSync(${JSON.stringify(policyFile)}, 'utf8'));
process.stdout.write(cannedShell(${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' '), policy.shell ?? []));
`,
			{ mode: 0o755 },
		);
}

export type ParsedRun = {
	reply: string;
	shell: string[];
	toolSearches: string[];
	costUsd?: number;
	turns?: number;
	/** Input tokens over the whole sample, cached ones included, as the model API reports them. */
	inputTokens?: number;
	error?: string;
	model?: string;
};

type StreamEvent = Record<string, unknown>;

const lines = (stdout: string): StreamEvent[] =>
	stdout
		.split('\n')
		.filter((l) => l.startsWith('{'))
		.flatMap((l) => {
			try {
				return [JSON.parse(l) as StreamEvent];
			} catch {
				return [];
			}
		});

export function parseClaude(stdout: string, shellLog: string): ParsedRun {
	const run: ParsedRun = { reply: '', shell: [], toolSearches: [] };
	const texts: string[] = [];
	for (const ev of lines(stdout)) {
		if (ev.type === 'system' && ev.subtype === 'init') run.model = ev.model as string;
		if (ev.type === 'assistant') {
			const content = (
				ev.message as {
					content?: { type: string; text?: string; name?: string; input?: { query?: string } }[];
				}
			)?.content;
			let text = '';
			for (const block of content ?? []) {
				if (block.type === 'text') text += block.text ?? '';
				if (block.type === 'tool_use' && block.name === 'ToolSearch')
					run.toolSearches.push(block.input?.query ?? '');
			}
			if (text) texts.push(text);
		}
		if (ev.type === 'result') {
			if (typeof ev.result === 'string') run.reply = ev.result;
			run.costUsd = ev.total_cost_usd as number | undefined;
			run.turns = ev.num_turns as number | undefined;
			const usage = ev.usage as Record<string, number> | undefined;
			if (usage)
				run.inputTokens =
					(usage.input_tokens ?? 0) +
					(usage.cache_creation_input_tokens ?? 0) +
					(usage.cache_read_input_tokens ?? 0);
			if (ev.is_error) run.error = String(ev.result ?? ev.subtype ?? 'error');
		}
	}
	if (!run.reply) run.reply = texts.at(-1) ?? '';
	try {
		run.shell = readFileSync(shellLog, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l) as string);
	} catch {
		run.shell = [];
	}
	return run;
}

export function parseCodex(stdout: string): ParsedRun {
	const run: ParsedRun = { reply: '', shell: [], toolSearches: [] };
	for (const ev of lines(stdout)) {
		const item = ev.item as { type?: string; text?: string; command?: string } | undefined;
		if (ev.type === 'item.completed' && item?.type === 'agent_message') run.reply = item.text ?? run.reply;
		if (ev.type === 'item.started' && item?.type === 'command_execution' && item.command)
			run.shell.push(item.command);
		if (ev.type === 'turn.failed' || ev.type === 'error') run.error = JSON.stringify(ev).slice(0, 500);
		if (ev.type === 'turn.completed')
			run.inputTokens = (ev.usage as { input_tokens?: number } | undefined)?.input_tokens;
	}
	return run;
}

/** Removes what a Claude sample left in the home: its own per-cwd session directory and nothing else. */
export function claudeSessionDirOf(account: EvalAccount, cwd: string): string {
	return claudeSessionDir(account.home, cwd);
}

/** A throwaway git repo of the case's files, on `main` with one commit. */
export function makeRepo(cwd: string, files: Readonly<Record<string, string>>): void {
	for (const [path, content] of Object.entries(files)) {
		const full = join(cwd, path);
		mkdirSync(join(full, '..'), { recursive: true });
		writeFileSync(full, content);
	}
	const git = (...args: string[]) =>
		execFileSync('git', args, {
			cwd,
			stdio: 'ignore',
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'eval',
				GIT_AUTHOR_EMAIL: 'eval@example.test',
				GIT_COMMITTER_NAME: 'eval',
				GIT_COMMITTER_EMAIL: 'eval@example.test',
			},
		});
	git('init', '-q', '-b', 'main');
	git('add', '-A');
	git('commit', '-q', '--allow-empty', '-m', 'init');
}
