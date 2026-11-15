// The dependency install of a new composition project (S08:MGC-015): the command, its environment, its failures.
// A stand-in `corepack` on PATH records what it was run with, so nothing here touches the network.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scaffoldProject } from '../src/mg-bundles/scaffold.ts';
import { tempAppdir } from './temp.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPO_PNPM = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).packageManager as string;

/** A PATH whose first entry holds a `corepack` running `body`; the rest of PATH supplies the shell's tools. */
function fakeCorepack(body: string, mode = 0o755): { env: NodeJS.ProcessEnv; dir: string } {
	const dir = tempAppdir('jasper-corepack-');
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'corepack'), `#!/bin/sh\n${body}\n`);
	chmodSync(join(bin, 'corepack'), mode);
	return { dir, env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } };
}

/** True when the process is gone (or only a zombie awaiting its reaper). */
function gone(pid: number): boolean {
	try {
		return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z') ?? true;
	} catch {
		return true;
	}
}

describe.skipIf(process.platform === 'win32')('new composition project install (S08:MGC-015)', () => {
	it('runs the repository-pinned pnpm through corepack, outside any enclosing workspace, without prompts', async () => {
		const { dir, env } = fakeCorepack(
			'{ pwd; printf "%s\\n" "$@"; echo "CI=$CI"; echo "PROMPT=$COREPACK_ENABLE_DOWNLOAD_PROMPT";' +
				' printenv npm_config_frozen_lockfile || echo unset; printenv npm_config_registry || echo unset; } > "$PWD/../install.log"',
		);
		// An enclosing pnpm workspace that pins another package manager, and an engine started by its `pnpm dev`.
		const ws = join(dir, 'ws');
		mkdirSync(join(ws, 'sub'), { recursive: true });
		writeFileSync(join(ws, 'pnpm-workspace.yaml'), 'packages:\n  - "**"\n');
		writeFileSync(join(ws, 'package.json'), '{"name":"ws","packageManager":"yarn@4.5.0"}');
		const project = await scaffoldProject(join(ws, 'sub'), 'gfx', {
			install: true,
			env: {
				...env,
				COREPACK_ENABLE_DOWNLOAD_PROMPT: '1',
				npm_lifecycle_event: 'dev',
				npm_config_frozen_lockfile: 'true',
				npm_config_registry: 'https://registry.npmjs.org/',
			},
		});
		const log = readFileSync(join(ws, 'sub', 'install.log'), 'utf8')
			.trim()
			.split('\n');
		expect(log).toEqual([
			project,
			REPO_PNPM,
			'install',
			'--ignore-workspace',
			'CI=true',
			'PROMPT=0',
			'unset',
			'unset',
		]);
		expect(JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).packageManager).toBe(REPO_PNPM);
	});

	it('fails with the exit code and the capped tails of stderr and stdout, naming the error line', async () => {
		const { dir, env } = fakeCorepack(
			'i=0; while [ $i -lt 3000 ]; do echo "progress line $i of the resolver output" >&2; i=$((i+1)); done\n' +
				'echo " ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/nope: Not Found - 404"\nexit 3',
		);
		const err = await scaffoldProject(dir, 'gfx', { install: true, env }).catch((e) => e);
		expect(err).toMatchObject({ code: 'MG_INSTALL_FAILED', status: 422 });
		expect(err.message).toContain('exit 3');
		expect(err.message).toContain('ERR_PNPM_FETCH_404');
		expect(err.detail).toMatchObject({ dir: join(dir, 'gfx'), reason: 'exit', exitCode: 3 });
		expect(err.detail.stderr.length).toBeLessThanOrEqual(4001);
		expect(err.detail.stderr).toMatch(/progress line 2999 of the resolver output$/);
		expect(err.detail.stdout).toContain('ERR_PNPM_FETCH_404');
		expect(err.hint).toContain(`corepack ${REPO_PNPM} install --ignore-workspace`);
		expect(existsSync(join(dir, 'gfx', 'package.json'))).toBe(true);
	});

	it('stops an install that runs out of time with every process it started, reporting what it printed', async () => {
		const { dir, env } = fakeCorepack(
			'echo "Progress: resolved 12, reused 0, downloaded 3" >&2\nsleep 300 &\necho $! > "$PWD/../sleep.pid"\nwait',
		);
		const err = await scaffoldProject(dir, 'gfx', { install: true, env, timeoutMs: 2000 }).catch((e) => e);
		expect(err).toMatchObject({ code: 'MG_INSTALL_TIMEOUT', status: 504 });
		expect(err.detail).toMatchObject({ reason: 'timeout', timeoutSeconds: 2 });
		expect(err.detail.stderr).toContain('Progress: resolved 12');
		expect(err.message).toContain('within 2 s');
		expect(gone(Number(readFileSync(join(dir, 'sleep.pid'), 'utf8')))).toBe(true);
	});

	it('names the fix when corepack is missing or cannot be started', async () => {
		const parent = tempAppdir('jasper-scaffold-');
		const missing = await scaffoldProject(parent, 'a', { install: true, env: { PATH: parent } }).catch(
			(e) => e,
		);
		expect(missing).toMatchObject({ code: 'MG_INSTALL_FAILED', detail: { reason: 'corepack-missing' } });
		expect(missing.hint).toContain('npm install -g corepack');
		const { dir, env } = fakeCorepack('exit 0', 0o644);
		const broken = await scaffoldProject(dir, 'b', { install: true, env }).catch((e) => e);
		expect(broken).toMatchObject({ code: 'MG_INSTALL_FAILED', detail: { reason: 'spawn' } });
	});
});
