import { availableParallelism } from 'node:os';
import type { Transferable, Worker } from 'node:worker_threads';

type Task<Request, Response> = {
	message: Request;
	transfer: readonly Transferable[];
	resolve(response: Response): void;
	reject(error: Error): void;
};

function boundedCount(value: number, maximum: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new RangeError(`${name} must be a positive safe integer`);
	return Math.min(value, maximum);
}

export function framePoolSize(options: { workers: number; slots: number }): {
	workers: number;
	slots: number;
} {
	const workers = boundedCount(options.workers, availableParallelism(), 'worker count');
	return { workers, slots: boundedCount(options.slots, workers + 3, 'frame slot count') };
}

export class ExportWorkerPool<Request, Response> {
	private readonly workers: Worker[] = [];
	private readonly idle: Worker[] = [];
	private readonly queue: Task<Request, Response>[] = [];
	private readonly pending = new Map<Worker, Task<Request, Response>>();
	private failed: Error | null = null;
	private closing: Promise<void> | null = null;

	constructor(
		private readonly name: string,
		count: number,
		createWorker: () => Worker,
	) {
		const workers = boundedCount(count, availableParallelism(), 'worker count');
		try {
			for (let i = 0; i < workers; i++) {
				const worker = createWorker();
				worker.on('message', (response: Response) => {
					const task = this.pending.get(worker);
					if (!task || this.failed || this.closing) return;
					this.pending.delete(worker);
					this.idle.push(worker);
					task.resolve(response);
					this.pump();
				});
				worker.on('error', (error) => this.fail(error));
				worker.on('exit', (code) => {
					if (!this.closing) this.fail(new Error(`${name} worker exited (${code})`));
				});
				this.workers.push(worker);
				this.idle.push(worker);
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
			this.closing = Promise.allSettled(this.workers.map((worker) => worker.terminate())).then(
				() => undefined,
			);
			throw error;
		}
	}

	get size(): number {
		return this.workers.length;
	}

	run(message: Request, transfer: readonly Transferable[] = []): Promise<Response> {
		if (this.closing) return Promise.reject(new Error(`${this.name} pool closed`));
		if (this.failed) return Promise.reject(this.failed);
		return new Promise((resolve, reject) => {
			this.queue.push({ message, transfer, resolve, reject });
			this.pump();
		});
	}

	private pump(): void {
		while (!this.failed && !this.closing && this.idle.length > 0 && this.queue.length > 0) {
			const worker = this.idle.pop()!;
			const task = this.queue.shift()!;
			this.pending.set(worker, task);
			try {
				worker.postMessage(task.message, task.transfer);
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	private fail(error: Error): void {
		this.failed ??= error;
		this.idle.length = 0;
		for (const task of this.queue.splice(0)) task.reject(this.failed);
		for (const task of this.pending.values()) task.reject(this.failed);
		this.pending.clear();
	}

	close(): Promise<void> {
		if (!this.closing) {
			this.fail(new Error(`${this.name} pool closed`));
			this.closing = Promise.all(this.workers.map((worker) => worker.terminate())).then(() => undefined);
		}
		return this.closing;
	}
}
