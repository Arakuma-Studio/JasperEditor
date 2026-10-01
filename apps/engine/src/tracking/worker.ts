// Tracking worker threads (S09:TRK-011): OpenCV.js (WASM) is loaded once per worker and the trackers run there, so
// the engine's main thread never blocks. Like derivatives/peaks.ts, the worker evaluates the source text of the
// tracker functions (geometry.ts, planar.ts, point.ts, `workerMain` below): the same code runs in tests, in `tsx`
// and in the esbuild bundle without a separate worker entry point. Loaded workers are pooled (a few idle ones are
// kept for a minute) so short jobs such as "step forward" do not pay the ~0.3–1 s OpenCV start-up every time.
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import * as Geometry from './geometry.ts';
import { createPlanarTracker, type FrameResult, type PlanarConfig } from './planar.ts';
import { createPointTracker, type PointConfig } from './point.ts';

export type TrackerConfig = PlanarConfig | PointConfig;

type WorkerRequest =
	| { type: 'init'; cfg: TrackerConfig }
	| { type: 'reference' | 'frame'; frame: number; buf: ArrayBuffer }
	| { type: 'release' };

type WorkerReply =
	| { type: 'ready' }
	| { type: 'ok' }
	| ({ type: 'result'; frame: number } & FrameResult)
	| { type: 'error'; message: string };

/** Worker entry point (evaluated from its source text: parameters and globals only). */
function workerMain(
	threads: any,
	/** The worker's CommonJS `require`, passed in from the source string: a literal `require(...)` here would be
	 * rewritten by esbuild's ESM bundling into its `__require` shim, which does not exist inside the worker. */
	load: (id: string) => any,
	cvPath: string,
	G: typeof Geometry,
	makePlanar: typeof createPlanarTracker,
	makePoint: typeof createPointTracker,
): void {
	const port = threads.parentPort;
	const cvModule: any = load(cvPath);
	let cv: any = null;
	let tracker: ReturnType<typeof makePlanar> | null = null;
	const pending: WorkerRequest[] = [];
	const errorText = (e: unknown): string => {
		if (typeof e === 'number' && cv?.exceptionFromPtr) {
			try {
				return `OpenCV: ${cv.exceptionFromPtr(e).msg}`;
			} catch {
				return `OpenCV exception ${e}`;
			}
		}
		return String((e as Error)?.message ?? e);
	};
	const handle = (m: WorkerRequest): void => {
		try {
			if (m.type === 'init') {
				tracker?.dispose();
				tracker = null;
				tracker = m.cfg.kind === 'planar' ? makePlanar(cv, G, m.cfg) : makePoint(cv, m.cfg);
				port.postMessage({ type: 'ok' });
			} else if (m.type === 'reference' || m.type === 'frame') {
				if (!tracker) throw new Error('tracker not initialised');
				const img = new Uint8Array(m.buf);
				const r = m.type === 'reference' ? tracker.reference(img) : tracker.track(img);
				port.postMessage({ type: 'result', frame: m.frame, ...r });
			} else if (m.type === 'release') {
				tracker?.dispose();
				tracker = null;
				port.postMessage({ type: 'ok' });
			}
		} catch (e) {
			port.postMessage({ type: 'error', message: errorText(e) });
		}
	};
	port.on('message', (m: WorkerRequest) => {
		if (cv) handle(m);
		else pending.push(m);
	});
	cvModule.then(() => {
		cv = cvModule;
		port.postMessage({ type: 'ready' });
		for (const m of pending.splice(0)) handle(m);
	});
}

let cachedSource: string | null = null;

/** Where OpenCV.js lives (resolved from the engine package). Throws when it is not installed. */
export function openCvPath(): string {
	return createRequire(import.meta.url).resolve('@techstark/opencv-js');
}

function workerSource(): string {
	if (cachedSource) return cachedSource;
	const geo = Object.entries(Geometry).filter(([, v]) => typeof v === 'function') as [
		string,
		() => unknown,
	][];
	cachedSource = [
		// esbuild's keepNames helper, in case the transpiler that produced these functions inserted it.
		'var __name = (f) => f;',
		...geo.map(([, f]) => f.toString()),
		createPlanarTracker.toString(),
		createPointTracker.toString(),
		workerMain.toString(),
		`const G = { ${geo.map(([k, f]) => `${k}: ${f.name}`).join(', ')} };`,
		`${workerMain.name}(require('node:worker_threads'), require, ${JSON.stringify(openCvPath())}, G, ${createPlanarTracker.name}, ${createPointTracker.name});`,
	].join('\n');
	return cachedSource;
}

/** One worker thread with OpenCV loaded; requests are answered in order. */
export class TrackingWorker {
	private readonly worker: Worker;
	private readonly waiters: { resolve(v: WorkerReply): void; reject(e: Error): void }[] = [];
	readonly ready: Promise<void>;
	private dead = false;
	private idleTimer: NodeJS.Timeout | null = null;

	constructor() {
		this.worker = new Worker(workerSource(), { eval: true });
		let onReady!: () => void;
		let onFail!: (e: Error) => void;
		this.ready = new Promise<void>((res, rej) => {
			onReady = res;
			onFail = rej;
		});
		this.ready.catch(() => undefined);
		this.worker.on('message', (m: WorkerReply) => {
			if (m.type === 'ready') return onReady();
			const w = this.waiters.shift();
			if (!w) return;
			if (m.type === 'error') w.reject(new Error(m.message));
			else w.resolve(m);
		});
		const fail = (e: Error) => {
			this.dead = true;
			onFail(e);
			for (const w of this.waiters.splice(0)) w.reject(e);
		};
		this.worker.on('error', (e) => fail(e));
		this.worker.on('exit', (code) => fail(new Error(`tracking worker exited (${code})`)));
	}

	get alive(): boolean {
		return !this.dead;
	}

	/** Sends a request; resolves with its reply (in order). `transfer` moves frame buffers without copying. */
	call(msg: WorkerRequest, transfer: ArrayBuffer[] = []): Promise<WorkerReply> {
		if (this.dead) return Promise.reject(new Error('tracking worker is not running'));
		return new Promise((resolve, reject) => {
			this.waiters.push({ resolve, reject });
			this.worker.postMessage(msg, transfer);
		});
	}

	async result(msg: WorkerRequest, transfer: ArrayBuffer[] = []): Promise<FrameResult> {
		const r = await this.call(msg, transfer);
		if (r.type !== 'result') throw new Error(`unexpected tracking worker reply ${r.type}`);
		return r;
	}

	terminate(): void {
		this.dead = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		void this.worker.terminate();
	}

	/** Pool bookkeeping. */
	park(ms: number, onExpire: () => void): void {
		this.worker.unref();
		this.idleTimer = setTimeout(onExpire, ms);
		this.idleTimer.unref();
	}

	unpark(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
		this.worker.ref();
	}
}

const IDLE_MS = 60_000;
const MAX_IDLE = 2;
const idle: TrackingWorker[] = [];

/** A loaded worker from the pool, or a new one (its `ready` resolves once OpenCV is initialised). */
export function acquireWorker(): TrackingWorker {
	for (;;) {
		const w = idle.pop();
		if (!w) return new TrackingWorker();
		if (!w.alive) continue;
		w.unpark();
		return w;
	}
}

/** Returns a worker to the pool after a successful job (its tracker is released first). */
export async function releaseWorker(w: TrackingWorker): Promise<void> {
	if (!w.alive) return;
	try {
		await w.call({ type: 'release' });
	} catch {
		w.terminate();
		return;
	}
	if (idle.length >= MAX_IDLE) return w.terminate();
	idle.push(w);
	w.park(IDLE_MS, () => {
		const i = idle.indexOf(w);
		if (i >= 0) idle.splice(i, 1);
		w.terminate();
	});
}

/** Terminates the idle workers (engine shutdown). */
export function shutdownWorkers(): void {
	for (const w of idle.splice(0)) w.terminate();
}
