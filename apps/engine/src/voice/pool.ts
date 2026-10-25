// Voice analysis feature blocks off the engine's main thread (spec 14 TC-001; docs/wp-notes/transcript-cleanup.md
// "Voice analysis"): a job starts up to `threads` worker threads (`VoiceFeatureExtractor` of @jasper/audio-dsp) and
// hands them 10 s blocks of decoded samples; the frames of a block depend only on its samples, so any split gives the
// same bytes as one pass. The worker module is `JASPER_VOICE_WORKER` (a path, or `off` for in-thread), else
// `voice-worker.mjs` next to the engine bundle, else — in a dev engine under tsx — `worker.ts`. A worker that cannot
// start (vitest, a missing file) means in-thread analysis between yields (logged); a worker that fails after it
// started (an exception, an exit, a crash) fails every pending block with `VOICE_ANALYSIS_FAILED` (retryable), and
// the job with it. `close()` ends the workers (always called when the job ends, also on cancel).
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { VoiceFeatureExtractor, type VoiceFeaturePlanes } from '@jasper/audio-dsp';
import { JobError } from '../jobs/types.ts';

export const VOICE_WORKER_ENV = 'JASPER_VOICE_WORKER';
const START_TIMEOUT_MS = 60_000;

/** Samples `[signalStart, signalStart + signal.length)` and the frames to compute from them. */
export type FeatureBlock = { signal: Float32Array; signalStart: number; firstFrame: number; count: number };

export type VoiceWorkerRequest = { id: number } & FeatureBlock;
export type VoiceWorkerResponse =
	| ({ id: number; ok: true } & VoiceFeaturePlanes)
	| { id: number; ok: false; message: string }
	| { id: 0; ready: true };

/** The worker module to use, or null to analyse in-thread. */
export function resolveVoiceWorker(env: Record<string, string | undefined> = process.env): URL | null {
	const o = env[VOICE_WORKER_ENV];
	if (o === 'off' || o === '0') return null;
	if (o) return o.startsWith('file:') ? new URL(o) : pathToFileURL(o);
	const bundled = new URL('./voice-worker.mjs', import.meta.url);
	if (existsSync(fileURLToPath(bundled))) return bundled;
	if (process.execArgv.some((a) => a.includes('tsx'))) {
		const ts = new URL('./worker.ts', import.meta.url);
		if (existsSync(fileURLToPath(ts))) return ts;
	}
	return null;
}

/** A worker running a TypeScript module from the source tree registers tsx's hooks itself (Node 20). */
function tsxBootstrap(url: URL): string {
	const api = import.meta.resolve('tsx/esm/api');
	return `import(${JSON.stringify(api)}).then((m) => { m.register(); return import(${JSON.stringify(url.href)}); })`;
}

/** Computes a block in this thread (the fallback, and the reference the workers must equal). */
export function computeBlock(ex: VoiceFeatureExtractor, b: FeatureBlock): VoiceFeaturePlanes {
	const out: VoiceFeaturePlanes = {
		level: new Uint8Array(b.count),
		voicing: new Uint8Array(b.count),
		flatness: new Uint8Array(b.count),
	};
	ex.compute(b.signal, b.signalStart, b.firstFrame, b.count, out);
	return out;
}

type Pending = { resolve(r: VoiceFeaturePlanes): void; reject(e: Error): void };

type Slot = {
	worker: Worker;
	ready: Promise<void>;
	pending: Map<number, Pending>;
	dead: boolean;
};

const failed = (message: string) =>
	new JobError('VOICE_ANALYSIS_FAILED', `Voice analysis worker failed: ${message}`, true);

export class VoiceFeatureRunner {
	private readonly slots: Slot[] = [];
	private nextId = 1;
	private inThread: VoiceFeatureExtractor | null = null;
	private failure: JobError | null = null;
	private closed = false;
	/** A worker could not start: no further ones are tried. */
	private startFailed = false;

	constructor(
		private readonly url: URL | null,
		private readonly threads: number,
		private readonly log: (m: string) => void = () => {},
	) {
		if (!url) this.inThread = new VoiceFeatureExtractor();
	}

	/** Whether blocks run on worker threads (false: in-thread fallback). */
	get threaded(): boolean {
		return !this.inThread;
	}

	async run(block: FeatureBlock): Promise<VoiceFeaturePlanes> {
		if (this.closed) throw new JobError('JOB_CANCELLED', 'Cancelled');
		if (this.failure) throw this.failure;
		if (!this.inThread) {
			let slot: Slot;
			try {
				slot = await this.pick();
			} catch (e) {
				if (!(e instanceof StartError)) throw e;
				if (this.closed) throw new JobError('JOB_CANCELLED', 'Cancelled');
				this.startFailed = true;
				// another worker that did start takes the block; with none, analyse in-thread
				const live = this.slots.filter((x) => !x.dead);
				if (live.length) slot = live.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
				else {
					if (!this.inThread) this.log(`voice analysis: no worker thread (${e.message}); analysing in-thread`);
					this.inThread ??= new VoiceFeatureExtractor();
					return this.run(block);
				}
			}
			return this.post(slot, block);
		}
		// yield between blocks so the engine keeps answering while it analyses
		await new Promise<void>((r) => setImmediate(r));
		if (this.closed) throw new JobError('JOB_CANCELLED', 'Cancelled');
		return computeBlock(this.inThread!, block);
	}

	/** Ends the workers; pending blocks reject with `JOB_CANCELLED`. */
	async close(): Promise<void> {
		this.closed = true;
		const ends = this.slots.map((s) => this.end(s, new JobError('JOB_CANCELLED', 'Cancelled')));
		this.slots.length = 0;
		await Promise.all(ends);
	}

	private async pick(): Promise<Slot> {
		const live = this.slots.filter((s) => !s.dead);
		const idle = live.find((s) => s.pending.size === 0);
		const slot =
			idle ??
			(live.length < Math.max(1, this.threads) && !(this.startFailed && live.length > 0)
				? this.start()
				: live.reduce((a, b) => (b.pending.size < a.pending.size ? b : a)));
		await slot.ready;
		return slot;
	}

	private post(slot: Slot, block: FeatureBlock): Promise<VoiceFeaturePlanes> {
		if (slot.dead) return Promise.reject(this.failure ?? failed('the worker stopped'));
		const id = this.nextId++;
		return new Promise<VoiceFeaturePlanes>((resolve, reject) => {
			slot.pending.set(id, { resolve, reject });
			// the samples are transferred: copy a view that does not own its whole buffer first
			const own =
				block.signal.byteOffset === 0 && block.signal.byteLength === block.signal.buffer.byteLength
					? block.signal
					: block.signal.slice();
			const msg: VoiceWorkerRequest = { id, ...block, signal: own };
			slot.worker.postMessage(msg, [own.buffer as ArrayBuffer]);
		});
	}

	private start(): Slot {
		const url = this.url!;
		let worker: Worker;
		try {
			worker = url.pathname.endsWith('.ts') ? new Worker(tsxBootstrap(url), { eval: true }) : new Worker(url);
		} catch (e) {
			const slot: Slot = {
				worker: null as unknown as Worker,
				ready: Promise.reject(new StartError((e as Error).message)),
				pending: new Map(),
				dead: true,
			};
			slot.ready.catch(() => {});
			return slot;
		}
		worker.unref();
		const slot: Slot = { worker, ready: null as unknown as Promise<void>, pending: new Map(), dead: false };
		this.slots.push(slot);
		let started = false;
		slot.ready = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (started) return;
				void this.end(slot, new JobError('JOB_CANCELLED', 'Cancelled'));
				reject(new StartError('the worker did not start'));
			}, START_TIMEOUT_MS);
			timer.unref?.();
			worker.on('message', (m: VoiceWorkerResponse) => {
				if (slot.dead) return;
				if ('ready' in m) {
					started = true;
					clearTimeout(timer);
					resolve();
					return;
				}
				const p = slot.pending.get(m.id);
				if (!p) return;
				slot.pending.delete(m.id);
				if (m.ok) p.resolve({ level: m.level, voicing: m.voicing, flatness: m.flatness });
				else this.fail(slot, failed(m.message));
			});
			const onDeath = (why: string) => {
				if (slot.dead) return;
				clearTimeout(timer);
				if (!started) {
					slot.dead = true;
					void worker.terminate();
					reject(new StartError(why));
					return;
				}
				this.fail(slot, failed(why));
			};
			worker.on('error', (e) => onDeath(e.message));
			worker.on('exit', (code) => onDeath(`it exited with code ${code}`));
		});
		slot.ready.catch(() => {});
		return slot;
	}

	/** A started worker failed: the whole run fails (the frames of a failed block are unknown). */
	private fail(slot: Slot, e: JobError): void {
		this.failure ??= e;
		void this.end(slot, e);
		for (const s of this.slots) if (s !== slot) void this.end(s, e);
	}

	private async end(slot: Slot, e: Error): Promise<void> {
		const pending = [...slot.pending.values()];
		slot.pending.clear();
		slot.dead = true;
		for (const p of pending) p.reject(e);
		await slot.worker?.terminate().catch(() => 0);
	}
}

class StartError extends Error {}
