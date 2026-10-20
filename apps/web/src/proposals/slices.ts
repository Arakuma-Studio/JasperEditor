// Runs a generator in slices of at most `sliceMs` of work, yielding to the event loop between them (a large
// proposal's preview never blocks the editor; Phase 3 verification). Cancel to stop it; the promise then never settles.
export function runInSlices<T>(
	run: Generator<unknown, T, void>,
	opts: { sliceMs?: number; schedule?: (fn: () => void) => unknown; clock?: () => number } = {},
): { promise: Promise<T>; cancel(): void } {
	const sliceMs = opts.sliceMs ?? 8;
	const schedule = opts.schedule ?? ((fn: () => void) => setTimeout(fn, 0));
	const clock = opts.clock ?? (() => performance.now());
	let cancelled = false;
	const promise = new Promise<T>((resolve, reject) => {
		const step = () => {
			if (cancelled) return;
			const start = clock();
			try {
				for (;;) {
					const r = run.next();
					if (r.done) {
						resolve(r.value);
						return;
					}
					if (cancelled) return;
					if (clock() - start >= sliceMs) break;
				}
			} catch (e) {
				reject(e);
				return;
			}
			schedule(step);
		};
		step();
	});
	return {
		promise,
		cancel() {
			cancelled = true;
		},
	};
}
