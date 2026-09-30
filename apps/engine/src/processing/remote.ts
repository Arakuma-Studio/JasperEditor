// Remote execution over SSH (S07 §5, PRM-001…009). The system OpenSSH client runs with argument arrays (never a
// shell string built from user input); remote command lines are built only from the validated `remoteDir` and
// engine-generated ids, every word single-quoted. Binaries are overridable (JASPER_SSH / JASPER_SCP /
// JASPER_RSYNC) so the tests substitute local shims. Key-based auth only (BatchMode=yes: never a prompt).
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { RemoteExecutorSettings, RemoteProbeResult } from '@jasper/api';
import { PROC_NAME, PROC_VERSION, RECIPE_VERSION } from './proc/recipe.ts';

export const SSH_ENV = { ssh: 'JASPER_SSH', scp: 'JASPER_SCP', rsync: 'JASPER_RSYNC' } as const;
export const REMOTE_CACHE_LIMIT_BYTES = 20 * 1024 ** 3;

export class RemoteError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable = true,
	) {
		super(message);
	}
}

/** POSIX single-quoting of one word. */
export function shq(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

export type ExecResult = { code: number; stdout: string; stderr: string };

export type ExecOptions = {
	stdin?: string | Buffer;
	signal?: AbortSignal;
	onStderr?(chunk: string): void;
	onSpawn?(child: ChildProcess): void;
	/** Kill after this many ms (probe). */
	timeoutMs?: number;
};

function run(bin: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, {
			stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
			detached: process.platform !== 'win32',
			windowsHide: true,
		});
		opts.onSpawn?.(child);
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (d: Buffer) => {
			stdout += d.toString();
			if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000);
		});
		child.stderr?.on('data', (d: Buffer) => {
			const s = d.toString();
			stderr = (stderr + s).slice(-20_000);
			opts.onStderr?.(s);
		});
		const kill = () => {
			try {
				if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
				else child.kill('SIGTERM');
			} catch {
				// gone
			}
		};
		const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : null;
		opts.signal?.addEventListener('abort', kill, { once: true });
		child.on('error', (e) => {
			if (timer) clearTimeout(timer);
			reject(new RemoteError('SSH_UNAVAILABLE', `${bin}: ${e.message}`, false));
		});
		child.on('close', (code, sig) => {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener('abort', kill);
			resolve({ code: code ?? (sig ? 255 : 1), stdout, stderr });
		});
		if (opts.stdin !== undefined) {
			child.stdin?.on('error', () => {});
			child.stdin?.end(opts.stdin);
		}
	});
}

export type RemoteLayout = {
	root: string;
	bin: string;
	models: string;
	jobs: string;
	cache: string;
	ffmpeg: string;
};

export function remoteLayout(remoteDir: string): RemoteLayout {
	const root = remoteDir.replace(/\/+$/, '');
	return {
		root,
		bin: `${root}/bin`,
		models: `${root}/models`,
		jobs: `${root}/jobs`,
		cache: `${root}/cache`,
		ffmpeg: `${root}/ffmpeg`,
	};
}

/** One configured remote host. */
export class SshRemote {
	readonly layout: RemoteLayout;
	private readonly env: Record<string, string | undefined>;
	private rsyncOk: boolean | null = null;

	constructor(
		readonly settings: RemoteExecutorSettings,
		private readonly controlDir: string,
		env: Record<string, string | undefined> = process.env,
	) {
		this.layout = remoteLayout(settings.remoteDir);
		this.env = env;
	}

	get target(): string {
		return `${this.settings.user}@${this.settings.host}`;
	}

	private bin(kind: keyof typeof SSH_ENV): string {
		return this.env[SSH_ENV[kind]] || kind;
	}

	/** Common `-o` options (PRM-002). */
	options(): string[] {
		const s = this.settings;
		return [
			'-o',
			'BatchMode=yes',
			'-o',
			'ServerAliveInterval=30',
			'-o',
			`StrictHostKeyChecking=${s.strictHostKeyChecking}`,
			'-o',
			'ControlMaster=auto',
			'-o',
			`ControlPath=${join(this.controlDir, 'ssh-%C')}`,
			'-o',
			'ControlPersist=60',
			...(s.identityFile ? ['-i', s.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
		];
	}

	sshArgs(command: string): string[] {
		return [...this.options(), '-p', String(this.settings.port), this.target, command];
	}

	async ensureControlDir(): Promise<void> {
		await mkdir(this.controlDir, { recursive: true });
	}

	/** Runs one remote command line (already quoted by the caller from trusted parts). */
	async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
		await this.ensureControlDir();
		return run(this.bin('ssh'), this.sshArgs(command), opts);
	}

	/** Runs and throws on failure; exit 255 = connection problem (retryable). */
	async execOk(command: string, what: string, opts: ExecOptions = {}): Promise<string> {
		const r = await this.exec(command, opts);
		if (opts.signal?.aborted) throw new RemoteError('CANCELLED', 'cancelled');
		if (r.code === 255)
			throw new RemoteError(
				'REMOTE_CONNECTION_LOST',
				`${what}: SSH connection failed: ${r.stderr.trim().slice(-500)}`,
			);
		if (r.code !== 0)
			throw new RemoteError(
				'REMOTE_COMMAND_FAILED',
				`${what} failed (${r.code}): ${r.stderr.trim().slice(-800)}`,
			);
		return r.stdout;
	}

	/** rsync is used when present on both ends (resumable transfers), else scp. */
	async hasRsync(): Promise<boolean> {
		if (this.rsyncOk !== null) return this.rsyncOk;
		const local = await run(this.bin('rsync'), ['--version']).catch(() => ({ code: 1 }) as ExecResult);
		if (local.code !== 0) return (this.rsyncOk = false);
		const remote = await this.exec('command -v rsync >/dev/null 2>&1 && echo yes || echo no').catch(
			() => null,
		);
		this.rsyncOk = !!remote && remote.code === 0 && remote.stdout.trim() === 'yes';
		return this.rsyncOk;
	}

	private rsyncSshCommand(): string {
		const words = [this.bin('ssh'), ...this.options(), '-p', String(this.settings.port)];
		return words.map((w) => (/[\s'"\\]/.test(w) ? `'${w.replace(/'/g, `'\\''`)}'` : w)).join(' ');
	}

	/**
	 * Uploads a local file to `remotePath` (PRM-005). rsync: `--partial --inplace` into `<path>.part`, which a
	 * retry resumes; scp restarts the file. The final rename makes the file appear atomically.
	 */
	async upload(
		local: string,
		remotePath: string,
		opts: ExecOptions & { onProgress?(pct: number): void } = {},
	): Promise<void> {
		const part = `${remotePath}.part`;
		const dir = remotePath.slice(0, remotePath.lastIndexOf('/'));
		await this.execOk(`mkdir -p ${shq(dir)}`, 'mkdir', { signal: opts.signal });
		await this.ensureControlDir();
		let r: ExecResult;
		if (await this.hasRsync()) {
			r = await run(
				this.bin('rsync'),
				[
					'--partial',
					'--inplace',
					'--info=progress2',
					'--no-inc-recursive',
					'-e',
					this.rsyncSshCommand(),
					local,
					`${this.target}:${part}`,
				],
				{ ...opts, onStderr: undefined },
			);
		} else {
			r = await run(
				this.bin('scp'),
				[...this.options(), '-P', String(this.settings.port), '-q', local, `${this.target}:${part}`],
				opts,
			);
		}
		if (opts.signal?.aborted) throw new RemoteError('CANCELLED', 'cancelled');
		if (r.code !== 0)
			throw new RemoteError(
				r.code === 255 ? 'REMOTE_CONNECTION_LOST' : 'UPLOAD_FAILED',
				`upload of ${basename(local)} failed: ${r.stderr.trim().slice(-500)}`,
			);
		await this.execOk(`mv -f ${shq(part)} ${shq(remotePath)}`, 'rename upload', { signal: opts.signal });
	}

	/** Downloads `remotePath` to `local` (resumable with rsync into `<local>.part`). */
	async download(remotePath: string, local: string, opts: ExecOptions = {}): Promise<void> {
		await this.ensureControlDir();
		let r: ExecResult;
		if (await this.hasRsync()) {
			r = await run(
				this.bin('rsync'),
				['--partial', '--inplace', '-e', this.rsyncSshCommand(), `${this.target}:${remotePath}`, local],
				opts,
			);
		} else {
			r = await run(
				this.bin('scp'),
				[...this.options(), '-P', String(this.settings.port), '-q', `${this.target}:${remotePath}`, local],
				opts,
			);
		}
		if (opts.signal?.aborted) throw new RemoteError('CANCELLED', 'cancelled');
		if (r.code !== 0)
			throw new RemoteError(
				r.code === 255 ? 'REMOTE_CONNECTION_LOST' : 'DOWNLOAD_FAILED',
				`download of ${basename(remotePath)} failed: ${r.stderr.trim().slice(-500)}`,
			);
	}

	/** Size of a remote file, or null. */
	async size(remotePath: string, signal?: AbortSignal): Promise<number | null> {
		const out = await this.execOk(
			`if [ -f ${shq(remotePath)} ]; then wc -c < ${shq(remotePath)}; else echo none; fi`,
			'stat',
			{ signal },
		);
		const t = out.trim();
		return t === 'none' ? null : Number(t);
	}

	/** Content-addressed cache trim (LRU by mtime) to `limit` bytes. */
	async trimCache(limit = REMOTE_CACHE_LIMIT_BYTES): Promise<void> {
		const c = shq(this.layout.cache);
		await this.exec(
			`[ -d ${c} ] && cd ${c} && total=$(du -sb . | cut -f1) && for f in $(ls -tr); do [ "$total" -le ${limit} ] && break; s=$(wc -c < "$f"); rm -f -- "$f"; total=$((total - s)); done; true`,
		);
	}

	/** PRM-003: one command that reports node, ffmpeg, GPU, the installed runtime and ONNX providers. */
	async probe(
		opts: { timeoutMs?: number } = {},
	): Promise<RemoteProbeResult & { cpus: number | null; ffmpegPath: string | null }> {
		const L = this.layout;
		const cmd = [
			`echo "node=$(node --version 2>/dev/null)"`,
			`if [ -x ${shq(`${L.ffmpeg}/ffmpeg`)} ]; then echo "ffmpegpath=${L.ffmpeg}/ffmpeg"; echo "ffmpeg=$(${shq(`${L.ffmpeg}/ffmpeg`)} -hide_banner -version 2>/dev/null | head -1)"; else echo "ffmpegpath=$(command -v ffmpeg 2>/dev/null)"; echo "ffmpeg=$(ffmpeg -hide_banner -version 2>/dev/null | head -1)"; fi`,
			`echo "gpu=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"`,
			`echo "cpus=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"`,
			`echo "arch=$(uname -sm 2>/dev/null)"`,
			`if [ -f ${shq(`${L.bin}/jasper-proc.mjs`)} ]; then echo "proc=$(cd ${shq(L.bin)} && node jasper-proc.mjs --version 2>/dev/null | tail -1)"; else echo "proc="; fi`,
			`if [ -w ${shq(L.root)} ] || mkdir -p ${shq(L.root)} 2>/dev/null; then echo "writable=yes"; else echo "writable=no"; fi`,
		].join('; ');
		let r: ExecResult;
		try {
			r = await this.exec(cmd, { timeoutMs: opts.timeoutMs ?? 30_000 });
		} catch (e) {
			return { ...emptyProbe(), message: (e as Error).message };
		}
		if (r.code !== 0) {
			const why = r.stderr.trim().split('\n').slice(-3).join(' ') || `ssh exited with ${r.code}`;
			return { ...emptyProbe(), message: `Cannot connect to ${this.target}: ${why}` };
		}
		const kv = new Map<string, string>();
		for (const line of r.stdout.split('\n')) {
			const i = line.indexOf('=');
			if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim());
		}
		let proc: {
			name?: string;
			version?: string;
			recipeVersion?: number;
			onnx?: { providers?: string[] };
		} | null = null;
		try {
			proc = kv.get('proc') ? JSON.parse(kv.get('proc') as string) : null;
		} catch {
			proc = null;
		}
		const node = kv.get('node') || null;
		const nodeMajor = node ? Number(/^v(\d+)/.exec(node)?.[1] ?? 0) : 0;
		const ffmpeg = kv.get('ffmpeg') || null;
		const gpu = kv.get('gpu') || null;
		const runtimeReady =
			!!proc &&
			proc.name === PROC_NAME &&
			proc.version === PROC_VERSION &&
			proc.recipeVersion === RECIPE_VERSION;
		const providers = proc?.onnx?.providers ?? [];
		const problems: string[] = [];
		if (!node) problems.push('Node.js is not installed');
		else if (nodeMajor < 20) problems.push(`Node ${node} is too old (need ≥ 20)`);
		if (kv.get('arch') && !/Linux x86_64/.test(kv.get('arch') as string))
			problems.push(`unsupported platform ${kv.get('arch')} (need Linux x64)`);
		if (kv.get('writable') === 'no') problems.push(`${L.root} is not writable`);
		if (!runtimeReady)
			problems.push(
				proc ? 'the runtime is outdated: run Set up' : 'the runtime is not installed: run Set up',
			);
		if (!ffmpeg) problems.push('no ffmpeg (Set up uploads the LGPL build)');
		const ok = !!node && nodeMajor >= 20 && kv.get('writable') !== 'no' && runtimeReady && !!ffmpeg;
		return {
			ok,
			message: problems.length ? problems.join('; ') : `Connected to ${this.target}${gpu ? ` (${gpu})` : ''}`,
			node,
			ffmpeg,
			gpu,
			onnxProviders: providers,
			runtimeReady,
			cpus: kv.get('cpus') ? Number(kv.get('cpus')) : null,
			ffmpegPath: kv.get('ffmpegpath') || null,
		};
	}
}

export function emptyProbe(): RemoteProbeResult & { cpus: number | null; ffmpegPath: string | null } {
	return {
		ok: false,
		message: '',
		node: null,
		ffmpeg: null,
		gpu: null,
		onnxProviders: [],
		runtimeReady: false,
		cpus: null,
		ffmpegPath: null,
	};
}

/** The identity file must exist locally (PRM-009). */
export function checkIdentity(s: RemoteExecutorSettings): void {
	if (s.identityFile && !existsSync(s.identityFile))
		throw new RemoteError('INVALID_SETTINGS', `Identity file ${s.identityFile} does not exist`, false);
}
