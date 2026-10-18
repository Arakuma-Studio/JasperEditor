// The `jasper-clap` child process as the engine sees it (spec 12 P6-E14, WP-E9): started on the first request for an
// installed model, kept while requests come, ended after `idleMs` without one (the towers hold ≈ 0.8 GB). Requests
// are answered one at a time in order. A worker that dies, writes garbage or takes longer than `requestTimeoutMs`
// fails its requests with a typed error and is started again for the next one (AGENTS.md §0.3: never a job left
// running). Cancelling a request (its signal) drops it from the queue; one already running finishes in the worker
// and its answer is discarded.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CLAP_EMBED_DIM } from './frontend.ts';

export class ClapError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

type Window = { startSec: number; endSec: number };
type Input = { path: string; ffmpeg: string; stream?: number };
export type WindowLevels = { startSec: number; endSec: number; headDb: number; tailDb: number; trimmed: boolean };

type Pending = {
	id: number;
	body: Record<string, unknown>;
	resolve(v: Record<string, unknown>): void;
	reject(e: Error): void;
	signal?: AbortSignal;
};

export type ClapRuntimeOptions = {
	command: () => { command: string; args: string[] };
	threads?: number;
	idleMs?: number;
	requestTimeoutMs?: number;
	log?: (m: string) => void;
};

export class ClapRuntime {
	private child: ChildProcessWithoutNullStreams | null = null;
	private childDir: string | null = null;
	private nextId = 1;
	private queue: Pending[] = [];
	private current: Pending | null = null;
	private idleTimer: NodeJS.Timeout | null = null;
	private requestTimer: NodeJS.Timeout | null = null;
	private stderr = '';
	private closed = false;

	constructor(private readonly opts: ClapRuntimeOptions) {}

	/** Unit embeddings of texts (512 floats each). */
	async embedTexts(dir: string, texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
		if (!texts.length) return [];
		const r = await this.request(dir, { op: 'text', texts }, signal);
		return vectors(r.vectors, texts.length);
	}

	/** Unit embeddings of windows of a file (each repeat-padded / cut to 10 s). */
	async embedWindows(dir: string, input: Input, windows: Window[], signal?: AbortSignal): Promise<Float32Array[]> {
		if (!windows.length) return [];
		const r = await this.request(dir, { op: 'audio', input, windows }, signal);
		return vectors(r.vectors, windows.length);
	}

	/** Head / tail levels of windows, shrunk to their sound when `trim`. */
	async levels(
		dir: string,
		input: Input,
		windows: Window[],
		trim: boolean,
		signal?: AbortSignal,
	): Promise<WindowLevels[]> {
		if (!windows.length) return [];
		const r = await this.request(dir, { op: 'levels', input, windows, trim }, signal);
		const list = r.levels;
		if (!Array.isArray(list) || list.length !== windows.length)
			throw new ClapError('CLAP_FAILED', 'jasper-clap answered with the wrong number of windows');
		return list.map((l, i) => {
			const o = (l ?? {}) as Partial<WindowLevels>;
			const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
			return {
				startSec: num(o.startSec, windows[i]!.startSec),
				endSec: num(o.endSec, windows[i]!.endSec),
				headDb: num(o.headDb, 0),
				tailDb: num(o.tailDb, 0),
				trimmed: o.trimmed === true,
			};
		});
	}

	/** Ends the worker (engine shutdown, or the model was removed); queued requests fail with CLAP_STOPPED. */
	close(): void {
		this.stop(new ClapError('CLAP_STOPPED', 'The Describe-it search model was stopped'));
	}

	/** The engine is shutting down: no worker is started any more. */
	dispose(): void {
		this.closed = true;
		this.close();
	}

	get running(): boolean {
		return this.child !== null;
	}

	private request(dir: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
		if (this.closed) return Promise.reject(new ClapError('CLAP_STOPPED', 'The engine is shutting down'));
		if (signal?.aborted) return Promise.reject(new ClapError('JOB_CANCELLED', 'Cancelled'));
		return new Promise((resolve, reject) => {
			const p: Pending = { id: this.nextId++, body: { ...body, dir }, resolve, reject, ...(signal ? { signal } : {}) };
			signal?.addEventListener(
				'abort',
				() => {
					const i = this.queue.indexOf(p);
					if (i >= 0) this.queue.splice(i, 1);
					// queued: dropped; running: its answer is discarded when it comes
					p.resolve = () => undefined;
					p.reject = () => undefined;
					reject(new ClapError('JOB_CANCELLED', 'Cancelled'));
				},
				{ once: true },
			);
			this.queue.push(p);
			this.pump();
		});
	}

	private pump(): void {
		if (this.current || !this.queue.length) return;
		const p = this.queue.shift()!;
		const dir = p.body.dir as string;
		if (this.child && this.childDir !== dir) this.stop(null);
		try {
			if (!this.child) this.start(dir);
		} catch (e) {
			p.reject(new ClapError('CLAP_UNAVAILABLE', (e as Error).message));
			this.pump();
			return;
		}
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
		this.current = p;
		const { dir: _d, ...wire } = p.body;
		this.requestTimer = setTimeout(() => {
			this.stop(new ClapError('CLAP_TIMEOUT', 'The Describe-it search model did not answer in time'));
		}, this.opts.requestTimeoutMs ?? 300_000);
		this.child!.stdin.write(`${JSON.stringify({ id: p.id, ...wire })}\n`);
	}

	private start(dir: string): void {
		const cmd = this.opts.command();
		const child = spawn(cmd.command, [...cmd.args, dir, String(this.opts.threads ?? 2)], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, OMP_NUM_THREADS: String(this.opts.threads ?? 2) },
		});
		this.child = child;
		this.childDir = dir;
		this.stderr = '';
		const rl = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
		rl.on('line', (line) => {
			if (this.child !== child) return;
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(line) as Record<string, unknown>;
			} catch {
				this.opts.log?.(`jasper-clap: ${line.slice(0, 200)}`);
				return;
			}
			const p = this.current;
			if (!p || msg.id !== p.id) return;
			this.finishCurrent();
			if (msg.ok === true) p.resolve(msg);
			else
				p.reject(
					new ClapError(
						typeof msg.code === 'string' ? msg.code : 'CLAP_FAILED',
						typeof msg.message === 'string' ? msg.message : 'jasper-clap failed',
					),
				);
			this.afterRequest();
		});
		child.stderr.on('data', (c: Buffer) => {
			if (this.stderr.length < 8000) this.stderr += c.toString();
		});
		child.on('error', (e) => {
			if (this.child === child) this.stop(new ClapError('CLAP_UNAVAILABLE', `jasper-clap could not start: ${e.message}`));
		});
		child.on('close', (code) => {
			if (this.child !== child) return;
			const why = this.stderr.trim().split('\n').pop() || `jasper-clap exited with ${code}`;
			this.child = null;
			this.childDir = null;
			this.failAll(new ClapError('CLAP_CRASHED', why));
		});
	}

	private finishCurrent(): void {
		this.current = null;
		if (this.requestTimer) clearTimeout(this.requestTimer);
		this.requestTimer = null;
	}

	private afterRequest(): void {
		if (this.queue.length) return this.pump();
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => this.stop(null), this.opts.idleMs ?? 120_000);
		this.idleTimer.unref?.();
	}

	private failAll(err: Error): void {
		const cur = this.current;
		this.finishCurrent();
		cur?.reject(err);
		// queued requests start a fresh worker unless the runtime was stopped on purpose
		if (err instanceof ClapError && (err.code === 'CLAP_STOPPED' || this.closed)) {
			const q = this.queue;
			this.queue = [];
			for (const p of q) p.reject(err);
		} else this.pump();
	}

	private stop(err: Error | null): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
		const child = this.child;
		this.child = null;
		this.childDir = null;
		if (child) {
			child.stdin.end();
			child.kill('SIGTERM');
			const hard = setTimeout(() => child.kill('SIGKILL'), 2000);
			hard.unref?.();
		}
		if (err) this.failAll(err);
		else if (this.current) this.failAll(new ClapError('CLAP_CRASHED', 'jasper-clap was restarted'));
	}
}

function vectors(data: unknown, n: number): Float32Array[] {
	if (typeof data !== 'string') throw new ClapError('CLAP_FAILED', 'jasper-clap returned no vectors');
	const buf = Buffer.from(data, 'base64');
	if (buf.byteLength !== n * CLAP_EMBED_DIM * 4)
		throw new ClapError('CLAP_FAILED', `jasper-clap returned ${buf.byteLength} bytes, expected ${n * CLAP_EMBED_DIM * 4}`);
	const out: Float32Array[] = [];
	for (let i = 0; i < n; i++) {
		const v = new Float32Array(CLAP_EMBED_DIM);
		for (let k = 0; k < CLAP_EMBED_DIM; k++) {
			const x = buf.readFloatLE((i * CLAP_EMBED_DIM + k) * 4);
			if (!Number.isFinite(x)) throw new ClapError('CLAP_FAILED', 'jasper-clap returned a non-finite value');
			v[k] = x;
		}
		out.push(v);
	}
	return out;
}
