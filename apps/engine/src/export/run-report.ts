// What an export job reports about its own run (docs/wp-notes/export-performance.md): wall-clock phases (ms from the
// job's start, summed when a phase runs more than once) and the composite pipeline that ran (`ExportPipeline`). One
// report per job; the export service keeps it by job context and puts it into the job result.
import type { ExportPipeline, ExportTimings } from '@jasper/api';

export class ExportRunReport {
	private readonly t0 = performance.now();
	private readonly phases = new Map<string, { startMs: number; ms: number }>();
	/** The composite pipeline that ran (native / hybrid); null on other paths. */
	pipeline: ExportPipeline | null = null;

	/** Starts `phase`; the returned function ends it (idempotent). */
	begin(phase: string): () => void {
		const start = performance.now();
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			const end = performance.now();
			const prev = this.phases.get(phase);
			const startMs = start - this.t0;
			this.phases.set(phase, {
				startMs: prev ? Math.min(prev.startMs, startMs) : startMs,
				ms: (prev?.ms ?? 0) + (end - start),
			});
		};
	}

	/** Runs `work` as `phase` (ended whether it resolves or rejects). */
	async time<T>(phase: string, work: () => Promise<T>): Promise<T> {
		const end = this.begin(phase);
		try {
			return await work();
		} finally {
			end();
		}
	}

	timings(): ExportTimings {
		const round = (n: number) => Math.max(0, Math.round(n));
		const phases: ExportTimings['phases'] = {};
		for (const [k, v] of this.phases) phases[k] = { startMs: round(v.startMs), ms: round(v.ms) };
		return { totalMs: round(performance.now() - this.t0), phases };
	}

	/** One log line: `timings: audio 1234 ms @0, bake …`. */
	summary(): string {
		const t = this.timings();
		const parts = Object.entries(t.phases)
			.sort((a, b) => a[1].startMs - b[1].startMs)
			.map(([k, v]) => `${k} ${v.ms} ms @${v.startMs}`);
		return `timings (total ${t.totalMs} ms): ${parts.join(', ')}`;
	}
}
