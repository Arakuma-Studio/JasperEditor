// Run: pnpm exec tsx apps/engine/bench/job-lookups.ts [--baseline <git-ref>]
// Alternates real baseline/current queues on identical jobs and checks ordered results.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JobQueue } from '../src/jobs/queue.ts';

const baselineIndex = process.argv.indexOf('--baseline');
const baseline = baselineIndex < 0 ? 'eb28696c' : process.argv[baselineIndex + 1]!;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'jasper-job-lookups-'));
const sourceFile = fileURLToPath(new URL(`../src/jobs/.lookup-baseline-${process.pid}.ts`, import.meta.url));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
try {
	await writeFile(
		sourceFile,
		execFileSync('git', ['show', `${baseline}:apps/engine/src/jobs/queue.ts`], {
			cwd: root,
			encoding: 'utf8',
			maxBuffer: 2 * 1024 * 1024,
		}),
	);
	const Legacy = (await import(pathToFileURL(sourceFile).href)).JobQueue as typeof JobQueue;
	console.log(
		JSON.stringify({
			baseline,
			node: process.version,
			cpu: cpus()[0]?.model,
			cores: cpus().length,
			load: loadavg(),
		}),
	);
	for (const mediaCount of [50, 500, 2000]) {
		const constructors = [Legacy, JobQueue];
		const queues = constructors.map(
			(Ctor) => new Ctor({ journalPath: null, tmpDir: dir, now: () => new Date('2026-10-27T00:00:00.000Z') }),
		);
		const keys: Set<string>[] = [];
		for (let i = 0; i < mediaCount; i++) {
			const wanted = new Set<string>();
			for (const kind of ['keyframes', 'poster', 'sprite', 'peaks', 'proxy-720', 'proxy-540']) {
				const key = `${kind}:${i}`;
				wanted.add(key);
				for (const queue of queues) {
					queue.registerRunner('analysis', async () => null);
					queue.submit({ kind: 'analysis', title: key, priority: 'background', cpuSlots: 1, dedupeKey: key });
				}
			}
			keys.push(wanted);
		}
		const read = (queue: JobQueue) => keys.map((dedupeKeys) => queue.list({ active: true, dedupeKeys }));
		const normalize = (jobs: ReturnType<typeof read>) =>
			jobs.map((group) => group.map(({ id: _id, ...job }) => job));
		assert.deepEqual(normalize(read(queues[0]!)), normalize(read(queues[1]!)));
		const wall: number[][] = [[], []];
		const cpu: number[][] = [[], []];
		for (let round = 0; round < 9; round++)
			for (const which of round % 2 ? [1, 0] : [0, 1]) {
				const cpuStart = process.cpuUsage();
				const start = performance.now();
				const result = read(queues[which]!);
				const elapsed = performance.now() - start;
				const used = process.cpuUsage(cpuStart);
				assert.equal(result.length, mediaCount);
				if (round >= 2) {
					wall[which]!.push(elapsed);
					cpu[which]!.push((used.user + used.system) / 1000);
				}
			}
		console.log(
			JSON.stringify({
				mediaCount,
				jobs: mediaCount * 6,
				load: loadavg(),
				baseline: { medianMs: median(wall[0]!), medianCpuMs: median(cpu[0]!), samplesMs: wall[0] },
				current: { medianMs: median(wall[1]!), medianCpuMs: median(cpu[1]!), samplesMs: wall[1] },
			}),
		);
		for (const queue of queues) await queue.shutdown();
	}
} finally {
	await rm(sourceFile, { force: true });
	await rm(dir, { recursive: true, force: true });
}
