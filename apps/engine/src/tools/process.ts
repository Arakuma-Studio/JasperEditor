// Child process spawning for native tools (S04:ENG-002, SC-004): argument arrays only (never a shell),
// each child leads its own process group so cancellation can terminate the whole tree (S04:JB-020):
// SIGTERM to the group, then SIGKILL after a grace period.
import { type ChildProcess, spawn } from 'node:child_process';
import { setPriority } from 'node:os';

const KILL_GRACE_MS = 3000;

/** Signals a whole process group (POSIX), falling back to the single child. */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try {
		if (process.platform !== 'win32') process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// already gone
		}
	}
}

/** Graceful then forced termination of a child's process tree; resolves when the child has exited. */
export function terminateTree(child: ChildProcess, graceMs = KILL_GRACE_MS): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			// The leader is gone; make sure no grandchildren linger in its group.
			signalTree(child, 'SIGKILL');
			resolve();
			return;
		}
		const force = setTimeout(() => signalTree(child, 'SIGKILL'), graceMs);
		child.once('exit', () => {
			clearTimeout(force);
			signalTree(child, 'SIGKILL');
			resolve();
		});
		signalTree(child, 'SIGTERM');
	});
}

export type SpawnOptions = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	/** stdin mode; default 'ignore'. */
	stdin?: 'ignore' | 'pipe';
	/** Lower OS priority (background lane, S04:JB-013). */
	nice?: number;
	/** Called with every spawned child (job contexts track them for cancellation). */
	onSpawn?(child: ChildProcess): void;
};

/**
 * Spawns `bin args` in its own process group. When `signal` aborts, the tree gets SIGTERM, then
 * SIGKILL after 3 s.
 */
export function spawnTool(bin: string, args: readonly string[], opts: SpawnOptions = {}): ChildProcess {
	const child = spawn(bin, [...args], {
		cwd: opts.cwd,
		env: opts.env ?? process.env,
		stdio: [opts.stdin ?? 'ignore', 'pipe', 'pipe'],
		detached: process.platform !== 'win32',
		windowsHide: true,
	});
	if (opts.nice && child.pid !== undefined) {
		try {
			// os.setPriority is per-process; the group's children inherit the niceness.
			setPriority(child.pid, opts.nice);
		} catch {
			// not permitted: ignore
		}
	}
	opts.onSpawn?.(child);
	if (opts.signal) {
		const onAbort = () => void terminateTree(child);
		if (opts.signal.aborted) onAbort();
		else {
			opts.signal.addEventListener('abort', onAbort, { once: true });
			child.once('exit', () => opts.signal?.removeEventListener('abort', onAbort));
		}
	}
	return child;
}

export class ToolError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly detail?: { exitCode?: number | null; stderr?: string },
	) {
		super(message);
		this.name = 'ToolError';
	}
}

/** Runs a tool to completion, collecting stdout (as a string) and the last 64 KB of stderr. */
export function runTool(
	bin: string,
	args: readonly string[],
	opts: SpawnOptions & { maxStdout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawnTool(bin, args, opts);
		} catch (e) {
			reject(new ToolError('BINARY_MISSING', `Cannot start ${bin}: ${(e as Error).message}`));
			return;
		}
		const max = opts.maxStdout ?? 64 * 1024 * 1024;
		const out: Buffer[] = [];
		let outLen = 0;
		let stderr = '';
		child.stdout!.on('data', (c: Buffer) => {
			outLen += c.length;
			if (outLen <= max) out.push(c);
		});
		child.stderr!.setEncoding('utf8').on('data', (c: string) => {
			stderr = (stderr + c).slice(-64_000);
		});
		child.on('error', (e: NodeJS.ErrnoException) =>
			reject(
				new ToolError(e.code === 'ENOENT' ? 'BINARY_MISSING' : 'INTERNAL', `Cannot run ${bin}: ${e.message}`),
			),
		);
		child.on('close', (code, sig) => {
			if (opts.signal?.aborted) {
				reject(new ToolError('JOB_CANCELLED', `${bin} cancelled`, { exitCode: code, stderr }));
			} else if (code === 0) resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr });
			else
				reject(
					new ToolError('TOOL_FAILED', `${bin} exited ${code ?? sig}: ${stderr.trim().slice(-800)}`, {
						exitCode: code,
						stderr,
					}),
				);
		});
	});
}
