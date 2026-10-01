// Page pool (S11:LBK-022, S04:RP-007): the Remotion renders an export needs before its composite (layer bakes, mg
// pre-renders) run side by side inside the export's Remotion page budget instead of one after the other.
//
// The budget is the export's Remotion concurrency (`remotionConcurrency(slots)`: at most half the cores, at most the
// export's granted CPU slots) — the number of browser pages rendering frames at the same time. Every render is
// granted a share of it when it starts (Remotion's concurrency is fixed for a render): one page for a still; the
// masters split the budget in proportion to their frames (`pageShares`: a long master takes more pages, a lone master
// all of them, at most one page per `MIN_FRAMES_PER_PAGE` frames). The pages of the renders in flight never exceed
// the budget, and at most `maxInFlight` renders run at once (each also has fixed costs: its compositor, its ffmpeg
// stitcher, the remux and checks).
//
// Scheduling: largest share first (then frames), backfilling smaller renders into pages a larger one cannot use yet;
// a render starts with fewer pages than it wants only down to half of them (or with what is left when nothing else is
// running). Output does not depend on the schedule: every frame is rendered on its own (ANM-014 repaint per frame),
// so a render's pixels are the same at any page count.
//
// Failure: the first failing render aborts the others (their child jobs are cancelled) and, once every render has
// settled, the pool rejects with that error. Aborting the pool's signal (export cancelled) does the same with
// `JOB_CANCELLED`. Nothing started by the pool outlives it.
import { JobError } from '../jobs/types.ts';

/** A page renders at least this many frames (below it, a page's start-up — creation, bundle, fonts — dominates). */
const MIN_FRAMES_PER_PAGE = 10;
/** Renders in flight at most (whatever the budget). */
export const MAX_RENDERS_IN_FLIGHT = 6;

/**
 * Pages each master wants out of `budget`: the budget split in proportion to the masters' frames (rounded, at least 1,
 * at most one page per `MIN_FRAMES_PER_PAGE` frames). Measured on 8 small bakes: a few pages per master and several
 * masters at once beat whole-budget masters one after the other (every page costs a start-up).
 */
export function pageShares(frames: readonly number[], budget: number): number[] {
	const b = Math.max(1, Math.floor(budget));
	const total = frames.reduce((s, f) => s + Math.max(1, f), 0);
	return frames.map((f) =>
		Math.max(
			1,
			Math.min(b, Math.round((b * Math.max(1, f)) / total), Math.ceil(Math.max(1, f) / MIN_FRAMES_PER_PAGE)),
		),
	);
}

/** What a task gets when it starts. */
export type PageGrant = {
	/** Remotion pages (concurrency) this render may use. */
	pages: number;
	/** Aborted when the pool's signal aborts or another task failed. */
	signal: AbortSignal;
	/** This task's progress, 0…1 (aggregated into the pool's progress). */
	progress(p: number): void;
};

export type PagePoolTask<T> = {
	/** Pages the task can use well (1 for stills; `pageShares` for masters). */
	want: number;
	/** Weight of the task in the aggregated progress (frames, plus a fixed cost per render). */
	weight: number;
	run(grant: PageGrant): Promise<T>;
};

export type PagePoolProgress = {
	/** Tasks finished. */
	done: number;
	/** Tasks running. */
	running: number;
	total: number;
	/** Weighted progress over all tasks, 0…1. */
	fraction: number;
};

export type PagePoolOptions = {
	/** Total pages of the renders in flight (≥ 1). */
	budget: number;
	/** Renders in flight at most (default `min(budget, MAX_RENDERS_IN_FLIGHT)`; 1 = one after the other). */
	maxInFlight?: number;
	signal: AbortSignal;
	onProgress?(p: PagePoolProgress): void;
};

/** The pool's budget split: the order tasks start in and their page grants, without running them (tests, logs). */
function poolOrder(tasks: readonly Pick<PagePoolTask<unknown>, 'want' | 'weight'>[]): number[] {
	return tasks
		.map((_, i) => i)
		.sort((a, b) => tasks[b]!.want - tasks[a]!.want || tasks[b]!.weight - tasks[a]!.weight || a - b);
}

/**
 * Runs `tasks` within the page budget; resolves with their results in input order. Rejects with the first failure
 * (after aborting and settling the others), or `JOB_CANCELLED` when `signal` aborts.
 */
export function runPagePool<T>(tasks: readonly PagePoolTask<T>[], o: PagePoolOptions): Promise<T[]> {
	const budget = Math.max(1, Math.floor(o.budget));
	const maxInFlight = Math.max(1, Math.floor(o.maxInFlight ?? Math.min(budget, MAX_RENDERS_IN_FLIGHT)));
	const results: T[] = new Array(tasks.length);
	const progress = tasks.map(() => 0);
	const totalWeight = tasks.reduce((s, t) => s + Math.max(0, t.weight), 0) || 1;
	const pending = poolOrder(tasks);
	const inner = new AbortController();
	let used = 0;
	let running = 0;
	let done = 0;
	let failure: { error: unknown } | null = null;

	return new Promise<T[]>((resolve, reject) => {
		const report = () =>
			o.onProgress?.({
				done,
				running,
				total: tasks.length,
				fraction:
					tasks.reduce((s, t, i) => s + Math.max(0, t.weight) * Math.min(1, Math.max(0, progress[i]!)), 0) /
					totalWeight,
			});
		const onAbort = () => {
			failure ??= { error: new JobError('JOB_CANCELLED', 'Cancelled') };
			inner.abort();
			settleIfIdle();
		};
		const settleIfIdle = () => {
			if (running > 0) return;
			if (failure) {
				o.signal.removeEventListener('abort', onAbort);
				reject(o.signal.aborted ? new JobError('JOB_CANCELLED', 'Cancelled') : failure.error);
			} else if (pending.length === 0) {
				o.signal.removeEventListener('abort', onAbort);
				resolve(results);
			}
		};
		const start = (i: number, pages: number) => {
			used += pages;
			running++;
			const task = tasks[i]!;
			let p: Promise<T>;
			try {
				p = task.run({
					pages,
					signal: inner.signal,
					progress: (v) => {
						progress[i] = v;
						report();
					},
				});
			} catch (e) {
				p = Promise.reject(e);
			}
			p.then(
				(r) => {
					results[i] = r;
					progress[i] = 1;
					done++;
				},
				(e) => {
					if (!failure) {
						failure = { error: e };
						inner.abort();
					}
				},
			).finally(() => {
				used -= pages;
				running--;
				report();
				pump();
				settleIfIdle();
			});
		};
		const pump = () => {
			if (failure) return;
			for (let k = 0; k < pending.length && running < maxInFlight; ) {
				const free = budget - used;
				if (free <= 0) break;
				const i = pending[k]!;
				const want = Math.max(1, Math.min(budget, Math.floor(tasks[i]!.want)));
				// Down to half of what it wants, or whatever is left when it would run alone.
				const least = running === 0 ? 1 : Math.ceil(want / 2);
				if (free >= least) {
					pending.splice(k, 1);
					start(i, Math.min(want, free));
				} else k++;
			}
		};
		if (o.signal.aborted) {
			reject(new JobError('JOB_CANCELLED', 'Cancelled'));
			return;
		}
		o.signal.addEventListener('abort', onAbort, { once: true });
		report();
		pump();
		settleIfIdle();
	});
}
