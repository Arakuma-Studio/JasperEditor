// Per-key async mutex: serializes read-modify-write sequences (project saves, upload appends, index writes).

export class KeyedMutex {
	private readonly tails = new Map<string, Promise<void>>();

	/** Runs `fn` after every earlier task queued under `key` has settled. */
	run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
		const prev = this.tails.get(key) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		const tail = next.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return next;
	}

	isBusy(key: string): boolean {
		return this.tails.has(key);
	}
}
