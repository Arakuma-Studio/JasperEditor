// New composition project (S08:MGC-015, P1, local mode): copies the template into `<dir>/<name>`, installs its
// dependencies with the pinned pnpm through corepack and hands the folder to the importer (which watches it).
//
// The install is isolated from whatever surrounds the folder: `corepack pnpm@<pin>` (never the pnpm on PATH, which
// may be another version or a corepack shim that adopts an enclosing project's `packageManager` or its own
// default), `--ignore-workspace` (an enclosing pnpm-workspace.yaml would otherwise take the install), CI=true (no
// prompts) and none of the package-manager settings a launching `pnpm run` exports (`npm_config_*` of its project).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { terminateTree } from '../tools/process.ts';
import { MgBundleError } from './project.ts';
import { TEMPLATE_FILES, TEMPLATE_PACKAGE_MANAGER } from './template/files.ts';

/**
 * Leaves room for the import's bundle within the 180 s per-request deadline of the MCP server and the jasper CLI
 * (apps/mcp/src/link.ts), so they receive MG_INSTALL_TIMEOUT rather than their own timeout.
 */
const INSTALL_TIMEOUT_MS = 150_000;
/** Output kept per stream while the install runs, and the tail of each stream an error carries. */
const OUTPUT_KEEP = 64 * 1024;
const OUTPUT_TAIL = 4000;

const INSTALL_ARGS = [TEMPLATE_PACKAGE_MANAGER, 'install', '--ignore-workspace'];
const INSTALL_DISPLAY = `CI=true corepack ${INSTALL_ARGS.join(' ')}`;

type ScaffoldOptions = {
	install: boolean;
	/** Environment the installer runs in (PATH finds corepack); default `process.env`. */
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	/** Aborting stops the install (its whole process tree). */
	signal?: AbortSignal;
};

function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
	const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
	for (const d of (env.PATH ?? env.Path ?? '').split(delimiter))
		for (const e of exts) if (d && existsSync(join(d, name + e))) return join(d, name + e);
	return null;
}

/**
 * The installer's environment: `env` without the run context a package-manager script exports (and, when the
 * engine was started by one, without that project's `npm_config_*` / `pnpm_config_*` settings), plus no prompts.
 */
function installEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const fromScript = env.npm_lifecycle_event !== undefined || env.npm_command !== undefined;
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined || /^(INIT_CWD|PNPM_SCRIPT_SRC_DIR|PNPM_PACKAGE_NAME|COREPACK_ROOT)$/.test(k))
			continue;
		if (/^(npm|pnpm)_/.test(k) && (fromScript || !/^(npm|pnpm)_config_/.test(k))) continue;
		out[k] = v;
	}
	return { ...out, CI: 'true', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', FORCE_COLOR: '0', NO_COLOR: '1' };
}

/** Collects a stream's last OUTPUT_KEEP bytes. */
function collector() {
	const chunks: Buffer[] = [];
	let size = 0;
	return {
		push(b: Buffer) {
			chunks.push(b);
			size += b.length;
			while (size - (chunks[0]?.length ?? 0) >= OUTPUT_KEEP) size -= chunks.shift()!.length;
		},
		tail(): string {
			const text = Buffer.concat(chunks).toString('utf8').trim();
			return text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text;
		},
	};
}

/** The line that names the failure: pnpm's `ERR_PNPM_*` / an `Error:` line, else the last line written. */
function summary(stderr: string, stdout: string): string {
	const lines = (s: string) =>
		s
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
	const all = [...lines(stderr), ...lines(stdout)];
	const line =
		all.find((l) => /\bERR_[A-Z0-9_]+|^Error\b/.test(l)) ?? lines(stderr).at(-1) ?? lines(stdout).at(-1);
	return line ? line.slice(0, 300) : 'no output';
}

type InstallOutcome =
	| { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
	| { kind: 'spawn-error'; error: Error }
	| { kind: 'timeout' }
	| { kind: 'aborted' };

async function install(dir: string, opts: ScaffoldOptions): Promise<void> {
	const base = opts.env ?? process.env;
	const timeoutMs = opts.timeoutMs ?? INSTALL_TIMEOUT_MS;
	const detail = { dir, command: INSTALL_DISPLAY };
	const corepack = onPath('corepack', base);
	if (!corepack)
		throw new MgBundleError(
			'MG_INSTALL_FAILED',
			`Created ${dir}, but corepack (which runs the pinned ${TEMPLATE_PACKAGE_MANAGER}) was not found on PATH`,
			422,
			{ ...detail, reason: 'corepack-missing' },
			`Install corepack (\`npm install -g corepack\`; Node.js 20–24 include it), run \`${INSTALL_DISPLAY}\` in ${dir}, then import the folder.`,
		);
	const stdout = collector();
	const stderr = collector();
	const outcome = await new Promise<InstallOutcome>((resolve) => {
		let settled: InstallOutcome | null = null;
		const child = spawn(corepack, INSTALL_ARGS, {
			cwd: dir,
			env: installEnv(base),
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: process.platform === 'win32',
			// Its own process group: a timeout or abort ends pnpm and everything it started.
			detached: process.platform !== 'win32',
		});
		const stop = (why: InstallOutcome) => {
			settled ??= why;
			void terminateTree(child);
		};
		const timer = setTimeout(() => stop({ kind: 'timeout' }), timeoutMs);
		const onAbort = () => stop({ kind: 'aborted' });
		if (opts.signal?.aborted) onAbort();
		opts.signal?.addEventListener('abort', onAbort, { once: true });
		// The engine exiting mid-install must not leave a detached install running.
		const onExit = () => {
			if (child.pid !== undefined && child.exitCode === null)
				try {
					process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
				} catch {
					// gone already
				}
		};
		process.once('exit', onExit);
		const finish = (o: InstallOutcome) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			process.removeListener('exit', onExit);
			resolve(settled ?? o);
		};
		child.stdout.on('data', (b: Buffer) => stdout.push(b));
		child.stderr.on('data', (b: Buffer) => stderr.push(b));
		child.once('error', (error) => finish({ kind: 'spawn-error', error }));
		child.once('close', (code, signal) => finish({ kind: 'exit', code, signal }));
	});
	const out = { stderr: stderr.tail(), stdout: stdout.tail() };
	if (outcome.kind === 'exit' && outcome.code === 0) return;
	if (outcome.kind === 'aborted') throw new MgBundleError('JOB_CANCELLED', 'Cancelled', 499, detail);
	if (outcome.kind === 'timeout')
		throw new MgBundleError(
			'MG_INSTALL_TIMEOUT',
			`Created ${dir}, but \`${INSTALL_DISPLAY}\` did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped: ${summary(out.stderr, out.stdout)}`,
			504,
			{ ...detail, reason: 'timeout', timeoutSeconds: Math.round(timeoutMs / 1000), ...out },
			`Run \`${INSTALL_DISPLAY}\` in ${dir} (a slow network or registry needs longer), then import the folder.`,
		);
	if (outcome.kind === 'spawn-error')
		throw new MgBundleError(
			'MG_INSTALL_FAILED',
			`Created ${dir}, but corepack could not be started (${corepack}): ${outcome.error.message}`,
			422,
			{ ...detail, reason: 'spawn', ...out },
			`Check that ${corepack} is executable, run \`${INSTALL_DISPLAY}\` in ${dir}, then import the folder.`,
		);
	const download =
		/corepack/i.test(out.stderr) && /performing the request to|ECONNREFUSED|ENOTFOUND/.test(out.stderr);
	throw new MgBundleError(
		'MG_INSTALL_FAILED',
		`Created ${dir}, but \`${INSTALL_DISPLAY}\` failed (${outcome.code !== null ? `exit ${outcome.code}` : `signal ${outcome.signal}`}): ${summary(out.stderr, out.stdout)}`,
		422,
		{ ...detail, reason: 'exit', exitCode: outcome.code, signal: outcome.signal, ...out },
		download
			? `corepack could not download ${TEMPLATE_PACKAGE_MANAGER}: fix the network, proxy or COREPACK_NPM_REGISTRY, run \`${INSTALL_DISPLAY}\` in ${dir}, then import the folder.`
			: `Fix the error in detail.stderr / detail.stdout, run \`${INSTALL_DISPLAY}\` in ${dir}, then import the folder.`,
	);
}

/** Writes the template into `<parent>/<name>` (must not exist or be empty); optionally installs it. */
export async function scaffoldProject(parent: string, name: string, opts: ScaffoldOptions): Promise<string> {
	if (!isAbsolute(parent)) throw new MgBundleError('BAD_REQUEST', 'dir must be an absolute path');
	const dir = join(parent, name);
	if (existsSync(dir) && (await readdir(dir)).length > 0)
		throw new MgBundleError('BAD_REQUEST', `${dir} already exists and is not empty`, 409);
	for (const [rel, content] of Object.entries(TEMPLATE_FILES)) {
		const file = join(dir, rel);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, content.replaceAll('{{name}}', name));
	}
	if (opts.install) await install(dir, opts);
	return dir;
}
