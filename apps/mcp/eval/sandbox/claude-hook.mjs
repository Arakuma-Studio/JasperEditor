#!/usr/bin/env node
// PreToolUse hook of a Claude sample: nothing a sample does reaches the machine. Shell commands get canned output (or
// run when they only read inside the throwaway cwd), file tools stay in the cwd. JASPER_EVAL_POLICY names the policy.
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { cannedShell, isReadOnlyCommand } from './shell-policy.mjs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const policy = JSON.parse(readFileSync(process.env.JASPER_EVAL_POLICY, 'utf8'));
const cwd = realpathSync(policy.cwd);

const answer = (decision, extra = {}) => {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, ...extra },
		}),
	);
	process.exit(0);
};

const inside = (path) => {
	const rel = relative(cwd, resolve(cwd, path));
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const tool = input.tool_name;
const args = input.tool_input ?? {};
if (tool === 'Bash') {
	const command = String(args.command ?? '');
	appendFileSync(policy.shellLog, `${JSON.stringify(command)}\n`);
	if (isReadOnlyCommand(command, cwd)) answer('allow');
	const output = cannedShell(command, policy.shell ?? []);
	const dir = mkdtempSync(join(tmpdir(), 'jasper-mcp-eval-shell-'));
	const file = join(dir, 'output.txt');
	writeFileSync(file, output);
	answer('allow', { updatedInput: { ...args, command: `cat ${file}` } });
}
const path = args.file_path ?? args.path ?? args.notebook_path;
if (typeof path === 'string' && !inside(path))
	answer('deny', { permissionDecisionReason: `Only files under ${cwd} are available here.` });
answer('allow');
