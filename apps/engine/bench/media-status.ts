// Run: pnpm exec tsx apps/engine/bench/media-status.ts
// Append --settled for the same readiness checks with no active jobs.
// --queue-baseline <git-ref> instead compares that revision's JobQueue.list with
// the current index, sharing the same jobs and current derivative readiness checks.
// Compares the original status implementation from 8b4c8936 with the current one,
// alternately, using the same queue, media records and real filesystem readiness checks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DerivativeService } from '../src/derivatives/service.ts';
import { Broadcaster } from '../src/events/broadcaster.ts';
import { JobQueue } from '../src/jobs/queue.ts';
import { type MediaRecord, MediaRegistry } from '../src/media/registry.ts';
import { EncoderService } from '../src/tools/encoders.ts';
import { Ffmpeg, resolveBinaries } from '../src/tools/ffmpeg.ts';

const queueBaselineIndex = process.argv.indexOf('--queue-baseline');
const queueBaseline = queueBaselineIndex >= 0;
const BASELINE = queueBaseline ? process.argv[queueBaselineIndex + 1]! : '8b4c8936';
const sourceArea = queueBaseline ? 'jobs/queue' : 'derivatives/service';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'jasper-status-bench-'));
const baselineFile = fileURLToPath(
	new URL(
		`../src/${queueBaseline ? 'jobs' : 'derivatives'}/.status-baseline-${process.pid}.ts`,
		import.meta.url,
	),
);
const kinds = ['keyframes', 'poster', 'sprite', 'peaks', 'proxy-720', 'proxy-540'] as const;
const settled = process.argv.includes('--settled');
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
try {
	const source = execFileSync('git', ['show', `${BASELINE}:apps/engine/src/${sourceArea}.ts`], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 2 * 1024 * 1024,
	});
	await writeFile(baselineFile, source);
	const legacyModule = await import(pathToFileURL(baselineFile).href);
	const Legacy = legacyModule.DerivativeService as typeof DerivativeService | undefined;
	const legacyList = legacyModule.JobQueue?.prototype.list as JobQueue['list'] | undefined;
	console.log(
		JSON.stringify({
			baseline: BASELINE,
			node: process.version,
			cpu: cpus()[0]?.model,
			cores: cpus().length,
			load: loadavg(),
		}),
	);
	const registry = await MediaRegistry.open(join(dir, 'media-index.json'));
	for (const mediaCount of [50, 500]) {
		const queue = new JobQueue({ journalPath: null, tmpDir: join(dir, 'jobs') });
		queue.registerRunner('analysis', async () => null);
		const records: MediaRecord[] = [];
		for (let i = 0; i < mediaCount; i++) {
			const hex = i.toString(16).padStart(64, '0');
			records.push({
				mediaKey: `mk_${i.toString(16).padStart(24, '0')}`,
				fingerprint: `q1:${hex}`,
				originalName: `video-${i}.mp4`,
				sizeBytes: 1,
				mtimeMs: 0,
				container: 'mp4',
				kind: 'video',
				browserPlayable: 'yes',
				storage: { type: 'path', path: join(dir, `source-${i}.mp4`) },
				durationSec: 10,
				display: { width: 1920, height: 1080 },
				hasAudio: true,
				registeredAt: '2026-01-01T00:00:00.000Z',
				probe: {
					streams: [],
					durationFlicks: 7056000000,
					startTimecode: null,
					rotationDegrees: 0,
					hasAlpha: false,
					variableFrameRate: false,
				},
			});
			for (const kind of settled ? [] : kinds) {
				queue.submit({
					kind: 'analysis',
					title: kind,
					priority: 'background',
					cpuSlots: 1,
					dedupeKey: kind.startsWith('proxy-') ? `proxy:${kind.slice(6)}:${hex}` : `${kind}:${hex}`,
				});
			}
		}
		const deps = {
			queue,
			registry,
			cacheDir: join(dir, 'cache'),
			ff: new Ffmpeg(resolveBinaries()),
			broadcaster: new Broadcaster(),
			encoders: new EncoderService({
				encoders: [],
				hwaccels: [],
				hardware: [],
				license: 'lgpl',
				lgplOnly: true,
			}),
		};
		// Both views use the exact same ids, timestamps and states. Only the list implementation differs.
		const baselineQueue: JobQueue = legacyList
			? Object.assign(Object.create(queue), {
					list: (filter: Parameters<JobQueue['list']>[0]) => legacyList.call(queue, filter),
				})
			: queue;
		const services = [
			Legacy ? new Legacy(deps) : new DerivativeService({ ...deps, queue: baselineQueue }),
			new DerivativeService(deps),
		];
		const wall: number[][] = [[], []];
		const cpu: number[][] = [[], []];
		const read = async (service: DerivativeService) => {
			const out: Awaited<ReturnType<DerivativeService['status']>>[] = [];
			let next = 0;
			await Promise.all(
				Array.from({ length: 16 }, async () => {
					for (let i = next++; i < records.length; i = next++) out[i] = await service.status(records[i]!);
				}),
			);
			return out;
		};
		assert.deepEqual(await read(services[0]!), await read(services[1]!));
		for (let round = 0; round < 9; round++) {
			for (const which of round % 2 ? [1, 0] : [0, 1]) {
				const startCpu = process.cpuUsage();
				const start = performance.now();
				const result = await read(services[which]!);
				const elapsed = performance.now() - start;
				const used = process.cpuUsage(startCpu);
				assert.equal(result.length, mediaCount);
				if (round >= 2) {
					wall[which]!.push(elapsed);
					cpu[which]!.push((used.user + used.system) / 1000);
				}
			}
		}
		console.log(
			JSON.stringify({
				mediaCount,
				activeJobs: settled ? 0 : mediaCount * kinds.length,
				concurrency: 16,
				load: loadavg(),
				baseline: {
					medianMs: median(wall[0]!),
					medianCpuMs: median(cpu[0]!),
					samplesMs: wall[0],
					samplesCpuMs: cpu[0],
				},
				filtered: {
					medianMs: median(wall[1]!),
					medianCpuMs: median(cpu[1]!),
					samplesMs: wall[1],
					samplesCpuMs: cpu[1],
				},
			}),
		);
		await queue.shutdown();
	}
} finally {
	await rm(baselineFile, { force: true });
	await rm(dir, { recursive: true, force: true });
}
