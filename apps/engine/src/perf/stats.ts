// Performance instrumentation of the engine (workstream `previews`, docs/performance.md): `GET /api/perf` and the MCP
// `perf_stats` tool. Cheap enough to run always: process CPU and memory, event-loop delay (perf_hooks histogram),
// host load, the job queue, and the throughput of recent renders (exports, stills, previews) from the job journal.
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';
import { type IntervalHistogram, monitorEventLoopDelay } from 'node:perf_hooks';
import type { EngineJob } from '@jasper/api';
import type { JobQueue } from '../jobs/queue.ts';

export type EnginePerfStats = {
	at: string;
	uptimeSec: number;
	process: { cpuPercent: number; rssMB: number; heapUsedMB: number; heapTotalMB: number; externalMB: number };
	/** Event-loop delay since the last read (ms): a busy engine answers HTTP late. */
	eventLoop: { meanMs: number; p50Ms: number; p99Ms: number; maxMs: number };
	host: {
		cores: number;
		load1: number;
		load5: number;
		load15: number;
		freeMemMB: number;
		totalMemMB: number;
	};
	jobs: {
		running: number;
		queued: number;
		slotsTotal: number;
		byKind: Record<string, { running: number; queued: number }>;
	};
	/** Recent finished renders: frames per second of wall time (newest first, at most 10 per kind). */
	renders: {
		kind: string;
		jobId: string;
		frames: number;
		seconds: number;
		fps: number;
		path?: string;
		finishedAt: string;
	}[];
	/** Render previews: files and size per preview format directory (filled by the preview service). */
	previews?: { formats: number; files: number; mb: number };
};

const MB = 1024 * 1024;
const r1 = (v: number) => Math.round(v * 10) / 10;

export class PerfMonitor {
	private readonly loop: IntervalHistogram;
	private lastCpu = process.cpuUsage();
	private lastAt = performance.now();
	private readonly started = Date.now();
	/** Extra sections contributed by services (previews). */
	private readonly providers = new Map<
		string,
		() => Promise<Record<string, unknown>> | Record<string, unknown>
	>();

	constructor(private readonly queue: JobQueue) {
		this.loop = monitorEventLoopDelay({ resolution: 10 });
		this.loop.enable();
	}

	close(): void {
		this.loop.disable();
	}

	provide(name: string, fn: () => Promise<Record<string, unknown>> | Record<string, unknown>): () => void {
		this.providers.set(name, fn);
		return () => this.providers.delete(name);
	}

	async stats(): Promise<EnginePerfStats & Record<string, unknown>> {
		const now = performance.now();
		const cpu = process.cpuUsage(this.lastCpu);
		const wallMs = Math.max(1, now - this.lastAt);
		this.lastCpu = process.cpuUsage();
		this.lastAt = now;
		const mem = process.memoryUsage();
		const ns = (v: number) => (Number.isFinite(v) ? r1(v / 1e6) : 0);
		const eventLoop = {
			meanMs: ns(this.loop.mean),
			p50Ms: ns(this.loop.percentile(50)),
			p99Ms: ns(this.loop.percentile(99)),
			maxMs: ns(this.loop.max),
		};
		this.loop.reset();
		const [l1, l5, l15] = loadavg();
		const jobs = this.queue.list({});
		const byKind: EnginePerfStats['jobs']['byKind'] = {};
		let running = 0;
		let queued = 0;
		for (const j of jobs) {
			if (j.state !== 'running' && j.state !== 'queued') continue;
			const k = (byKind[j.kind] ??= { running: 0, queued: 0 });
			if (j.state === 'running') {
				k.running++;
				running++;
			} else {
				k.queued++;
				queued++;
			}
		}
		const out: EnginePerfStats & Record<string, unknown> = {
			at: new Date().toISOString(),
			uptimeSec: Math.round((Date.now() - this.started) / 1000),
			process: {
				cpuPercent: r1(((cpu.user + cpu.system) / 1000 / wallMs) * 100),
				rssMB: r1(mem.rss / MB),
				heapUsedMB: r1(mem.heapUsed / MB),
				heapTotalMB: r1(mem.heapTotal / MB),
				externalMB: r1(mem.external / MB),
			},
			eventLoop,
			host: {
				cores: availableParallelism(),
				load1: r1(l1 ?? 0),
				load5: r1(l5 ?? 0),
				load15: r1(l15 ?? 0),
				freeMemMB: Math.round(freemem() / MB),
				totalMemMB: Math.round(totalmem() / MB),
			},
			jobs: { running, queued, slotsTotal: this.queue.totalSlots, byKind },
			renders: recentRenders(jobs),
		};
		for (const [name, fn] of this.providers) {
			try {
				out[name] = await fn();
			} catch (e) {
				out[name] = { error: e instanceof Error ? e.message : String(e) };
			}
		}
		return out;
	}
}

/** Throughput of finished renders from their results (frames) and timestamps. */
export function recentRenders(jobs: readonly EngineJob[]): EnginePerfStats['renders'] {
	const out: EnginePerfStats['renders'] = [];
	const per = new Map<string, number>();
	const done = jobs
		.filter(
			(j) =>
				j.state === 'succeeded' &&
				(j.kind === 'export' || j.kind === 'preview') &&
				j.finishedAt &&
				j.startedAt,
		)
		.sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
	for (const j of done) {
		const n = per.get(j.kind) ?? 0;
		if (n >= 10) continue;
		const res = (j.result ?? {}) as { frames?: number; renderPath?: string; paths?: Record<string, number> };
		const frames = typeof res.frames === 'number' ? res.frames : 0;
		const seconds = (Date.parse(j.finishedAt!) - Date.parse(j.startedAt!)) / 1000;
		if (!(seconds > 0) || frames <= 0) continue;
		per.set(j.kind, n + 1);
		out.push({
			kind: j.kind,
			jobId: j.id,
			frames,
			seconds: r1(seconds),
			fps: r1(frames / seconds),
			...(res.renderPath
				? { path: res.renderPath }
				: res.paths
					? { path: Object.keys(res.paths).join('+') }
					: {}),
			finishedAt: j.finishedAt!,
		});
	}
	return out;
}
