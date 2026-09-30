// Job queue (S04 §17): lanes, slots, dedupe, cancel within 5 s with no child left (QA-007), retry,
// journal + restart recovery (QA-008), throttled job.updated events.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineJob, EventEnvelope } from '@jasper/api';
import { afterEach, describe, expect, it } from 'vitest';
import { Broadcaster } from '../src/events/broadcaster.ts';
import { JobQueue } from '../src/jobs/queue.ts';
import { JobError, type JobRunner } from '../src/jobs/types.ts';
import { Ffmpeg, resolveBinaries } from '../src/tools/ffmpeg.ts';
import { isAlive, spawnTool } from '../src/tools/process.ts';
import { closeApps, H, makeApp, tempAppdir, until } from './helpers.ts';

const queues: JobQueue[] = [];
afterEach(async () => {
	for (const q of queues.splice(0)) await q.shutdown(1000);
	await closeApps();
});

function makeQueue(opts: { slots?: number; journal?: string | null; broadcaster?: Broadcaster } = {}) {
	const dir = tempAppdir('jasper-jobs-');
	const q = new JobQueue({
		journalPath: opts.journal === undefined ? join(dir, 'jobs.jsonl') : opts.journal,
		tmpDir: join(dir, 'tmp'),
		logDir: join(dir, 'logs'),
		totalSlots: opts.slots ?? 4,
		broadcaster: opts.broadcaster ?? null,
	});
	queues.push(q);
	return q;
}

/** Resolves when the runner is told to stop (never finishes on its own). */
const hang: JobRunner = (ctx) =>
	new Promise((_res, rej) =>
		ctx.signal.addEventListener('abort', () => rej(new JobError('JOB_CANCELLED', 'x')), { once: true }),
	);

function groupMembers(pgid: number): number[] {
	const r = spawnSync('ps', ['-o', 'pid=', '-g', String(pgid)]);
	return r.stdout
		.toString()
		.split('\n')
		.map((s) => Number(s.trim()))
		.filter((n) => n > 0);
}

describe('scheduling (S04:JB-011/012/014)', () => {
	it('runs lanes in priority order within the CPU slots and dedupes by key', async () => {
		const q = makeQueue({ slots: 2 });
		const order: string[] = [];
		const gates = new Map<string, () => void>();
		q.registerRunner('analysis', (ctx) => {
			order.push(ctx.job.title);
			return new Promise<void>((res) => gates.set(ctx.job.title, res));
		});
		q.start();
		const a = q.submit({ kind: 'analysis', title: 'bg-1', priority: 'background', cpuSlots: 2 });
		await until(() => order.length === 1);
		q.submit({ kind: 'analysis', title: 'bg-2', priority: 'background', cpuSlots: 1 });
		q.submit({ kind: 'analysis', title: 'user-1', priority: 'user', cpuSlots: 1 });
		q.submit({ kind: 'analysis', title: 'int-1', priority: 'interactive', cpuSlots: 1 });
		const d1 = q.submit({
			kind: 'analysis',
			title: 'int-2',
			priority: 'interactive',
			cpuSlots: 1,
			dedupeKey: 'k',
		});
		const d2 = q.submit({
			kind: 'analysis',
			title: 'int-2 again',
			priority: 'interactive',
			cpuSlots: 1,
			dedupeKey: 'k',
		});
		expect(d2.id).toBe(d1.id);
		expect(q.usedSlots).toBe(2);
		gates.get('bg-1')!();
		await q.wait(a.id);
		await until(() => order.length === 3);
		expect(order).toEqual(['bg-1', 'int-1', 'int-2']);
		for (const t of ['int-1', 'int-2']) gates.get(t)!();
		await until(() => order.length === 5);
		expect(order.slice(3)).toEqual(['user-1', 'bg-2']);
		for (const t of ['user-1', 'bg-2']) gates.get(t)!();
		await until(() => q.list({ active: true }).length === 0);
	});

	it('starts exports with at least half the slots and pauses the background lane meanwhile (JB-012/013)', async () => {
		const q = makeQueue({ slots: 4 });
		const started: { title: string; slots: number }[] = [];
		const gates: (() => void)[] = [];
		const runner: JobRunner = (ctx) => {
			started.push({ title: ctx.job.title, slots: ctx.slots });
			return new Promise<void>((res) => gates.push(res));
		};
		q.registerRunner('analysis', runner);
		q.registerRunner('export', runner);
		q.start();
		q.submit({ kind: 'analysis', title: 'probe', priority: 'interactive', cpuSlots: 1 });
		const exp = q.submit({ kind: 'export', title: 'export', priority: 'user', cpuSlots: 4, minSlots: 2 });
		await until(() => started.length === 2);
		expect(started[1]).toEqual({ title: 'export', slots: 3 });
		q.submit({ kind: 'analysis', title: 'bg', priority: 'background', cpuSlots: 0 });
		await new Promise((r) => setTimeout(r, 100));
		expect(started.map((s) => s.title)).toEqual(['probe', 'export']); // background paused during export
		gates[1]!();
		await q.wait(exp.id);
		await until(() => started.length === 3);
		for (const g of gates) g();
	});

	it('fails with a retryable error, keeps a log, and retries as a new job', async () => {
		const q = makeQueue();
		let attempt = 0;
		q.registerRunner('analysis', async (ctx) => {
			attempt++;
			if (attempt === 1) throw new JobError('TOOL_FAILED', 'boom', true);
			ctx.progress(0.5, { stage: 'half' });
			return { ok: attempt };
		});
		q.start();
		const j = q.submit({ kind: 'analysis', title: 't', priority: 'user', cpuSlots: 1, input: { x: 1 } });
		const failed = await q.wait(j.id);
		expect(failed.state).toBe('failed');
		expect(failed.error).toMatchObject({ code: 'TOOL_FAILED', retryable: true, logRef: `jobs/${j.id}.log` });
		const again = q.retry(j.id);
		expect(again.id).not.toBe(j.id);
		const ok = await q.wait(again.id);
		expect(ok).toMatchObject({ state: 'succeeded', progress: 1, result: { ok: 2 } });
		expect(() => q.retry(again.id)).toThrow(/cannot be retried/);
		q.registerRunner('gc', async () => {
			throw new JobError('BINARY_MISSING', 'no ffmpeg');
		});
		const nr = await q.wait(q.submit({ kind: 'gc', title: 'gc', priority: 'background', cpuSlots: 1 }).id);
		expect(nr.error?.retryable).toBe(false);
		expect(() => q.retry(nr.id)).toThrow(/cannot be retried/);
	});

	it('throttles job.updated to 4/s per job and always sends the final state (JB-040)', async () => {
		const b = new Broadcaster();
		const events: EventEnvelope[] = [];
		b.subscribe((e) => events.push(e));
		const q = makeQueue({ broadcaster: b });
		q.registerRunner('analysis', async (ctx) => {
			for (let i = 1; i <= 200; i++) {
				ctx.progress(i / 200);
				if (i % 20 === 0) await new Promise((r) => setTimeout(r, 25));
			}
			return null;
		});
		q.start();
		const t0 = Date.now();
		const j = q.submit({ kind: 'analysis', title: 't', priority: 'user', cpuSlots: 1 });
		await q.wait(j.id);
		const elapsed = (Date.now() - t0) / 1000;
		const updates = events.filter((e) => e.type === 'job.updated');
		// running + throttled progress + final: bounded by 4/s plus the forced state changes.
		expect(updates.length).toBeLessThanOrEqual(Math.ceil(elapsed * 4) + 4);
		expect((updates.at(-1)!.payload as EngineJob).state).toBe('succeeded');
		expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['job.created', 'job.finished']));
		expect(events.at(-1)!.type).toBe('job.finished');
	});
});

describe('cancellation (S04:JB-020, QA-007)', () => {
	it('cancels a running ffmpeg job within 5 s with no child process left and removes partials', async () => {
		const ff = new Ffmpeg(resolveBinaries());
		const q = makeQueue();
		const dir = tempAppdir('jasper-cancel-');
		const partial = join(dir, 'out.partial.mp4');
		let pgids: number[] = [];
		q.registerRunner('analysis', async (ctx) => {
			ctx.addPartial(partial);
			// A child that ignores SIGTERM (forces the SIGKILL escalation) plus a real ffmpeg encode.
			const stubborn = spawnTool('bash', ['-c', 'trap "" TERM; sleep 60 & wait'], {
				signal: ctx.signal,
				onSpawn: ctx.trackChild,
			});
			pgids.push(stubborn.pid!);
			await ff.run(
				[
					'-f',
					'lavfi',
					'-i',
					'testsrc2=size=1280x720:rate=30:duration=600',
					'-c:v',
					'libx264',
					'-preset',
					'ultrafast',
					'-f',
					'mp4',
					partial,
				],
				{
					signal: ctx.signal,
					onSpawn: (c) => {
						ctx.trackChild(c);
						pgids.push(c.pid!);
					},
					onProgress: (p) => ctx.progress(p.outTimeUs / 600e6),
				},
			);
		});
		q.start();
		const job = q.submit({ kind: 'analysis', title: 'long encode', priority: 'user', cpuSlots: 1 });
		await until(() => pgids.length === 2 && existsSync(partial), 10_000);
		await until(() => (q.get(job.id)?.progress ?? 0) > 0, 10_000);
		const t0 = Date.now();
		expect(q.cancel(job.id)?.state).toBe('cancelling');
		const done = await q.wait(job.id);
		const took = Date.now() - t0;
		expect(done.state).toBe('cancelled');
		expect(took).toBeLessThan(5000);
		for (const g of pgids) {
			expect(isAlive(g)).toBe(false);
			expect(groupMembers(g)).toEqual([]);
		}
		expect(existsSync(partial)).toBe(false);
		pgids = [];
	}, 20_000);

	it('cancels queued jobs immediately and cascades to child jobs', async () => {
		const q = makeQueue({ slots: 1 });
		q.registerRunner('analysis', hang);
		q.start();
		const parent = q.submit({ kind: 'analysis', title: 'parent', priority: 'user', cpuSlots: 1 });
		const child = q.submit({
			kind: 'analysis',
			title: 'child',
			priority: 'user',
			cpuSlots: 1,
			parentId: parent.id,
		});
		expect(q.get(child.id)?.state).toBe('queued');
		q.cancel(parent.id);
		expect(q.get(child.id)?.state).toBe('cancelled');
		expect((await q.wait(parent.id)).state).toBe('cancelled');
	});

	it('cancels over HTTP (POST /api/jobs/:id/cancel)', async () => {
		const app = await makeApp();
		const { coreServices } = await import('../src/tools/services.ts');
		const core = coreServices(app);
		core.queue.registerRunner('analysis', hang);
		const job = core.queue.submit({ kind: 'analysis', title: 'x', priority: 'user', cpuSlots: 1 });
		await until(() => core.queue.get(job.id)?.state === 'running');
		const r = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: H });
		expect(r.statusCode).toBe(200);
		expect(['cancelling', 'cancelled']).toContain(r.json().state);
		await until(
			async () =>
				(await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: H })).json().state ===
				'cancelled',
		);
		const list = (await app.inject({ method: 'GET', url: '/api/jobs?active=1', headers: H })).json();
		expect(list.jobs.some((j: EngineJob) => j.id === job.id)).toBe(false);
		const retried = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry`, headers: H });
		expect(retried.statusCode).toBe(200);
		expect(retried.json().id).not.toBe(job.id);
		expect(
			(await app.inject({ method: 'GET', url: '/api/jobs/job_0000000000000000', headers: H })).json().code,
		).toBe('JOB_NOT_FOUND');
	});
});

describe('journal and restart recovery (S04:JB-030, QA-008)', () => {
	it('marks a running job interrupted after a crash, restores queued jobs and re-queues artifact jobs', async () => {
		const dir = tempAppdir('jasper-journal-');
		mkdirSync(dir, { recursive: true });
		const journal = join(dir, 'jobs.jsonl');
		const first = makeQueue({ journal, slots: 1 });
		first.registerRunner('export', hang);
		first.registerRunner('proxy', hang);
		first.start();
		const exp = first.submit({
			kind: 'export',
			title: 'export',
			priority: 'user',
			cpuSlots: 1,
			input: { request: 'r1' },
		});
		const proxy = first.submit({
			kind: 'proxy',
			title: 'proxy',
			priority: 'background',
			cpuSlots: 1,
			input: { mediaKey: 'mk_1' },
		});
		await until(() => first.get(exp.id)?.state === 'running');
		expect(first.get(proxy.id)?.state).toBe('queued');

		// "Crash": a new engine reads the same journal while the first never shut down.
		const second = makeQueue({ journal, slots: 1 });
		second.registerRunner('export', hang);
		const proxyInputs: unknown[] = [];
		second.registerRunner('proxy', async (ctx) => {
			proxyInputs.push(ctx.input);
			return null;
		});
		second.start();
		const recovered = second.get(exp.id)!;
		expect(recovered.state).toBe('interrupted');
		expect(recovered.error).toMatchObject({ code: 'INTERRUPTED', retryable: true });
		// The queued proxy job is restored (same id) and runs.
		expect((await second.wait(proxy.id)).state).toBe('succeeded');
		expect(proxyInputs).toEqual([{ mediaKey: 'mk_1' }]);
		// Interrupted exports are offered for retry.
		const retry = second.retry(exp.id);
		expect(retry.kind).toBe('export');

		// A running artifact job interrupted by a crash is re-queued automatically on the next start.
		const third = makeQueue({ journal: join(dir, 'b.jsonl'), slots: 1 });
		third.registerRunner('proxy', hang);
		third.start();
		const p = third.submit({
			kind: 'proxy',
			title: 'proxy 2',
			priority: 'background',
			cpuSlots: 1,
			input: { mediaKey: 'mk_2' },
		});
		await until(() => third.get(p.id)?.state === 'running');
		const fourth = makeQueue({ journal: join(dir, 'b.jsonl'), slots: 1 });
		const seen: unknown[] = [];
		fourth.registerRunner('proxy', async (ctx) => {
			seen.push(ctx.input);
			return null;
		});
		fourth.start();
		expect(fourth.get(p.id)?.state).toBe('interrupted');
		await until(() => seen.length === 1);
		expect(seen).toEqual([{ mediaKey: 'mk_2' }]);
		// …and only once.
		const fifth = makeQueue({ journal: join(dir, 'b.jsonl'), slots: 1 });
		fifth.registerRunner('proxy', async () => {
			seen.push('again');
			return null;
		});
		fifth.start();
		await new Promise((r) => setTimeout(r, 100));
		expect(seen).toEqual([{ mediaKey: 'mk_2' }]);
	});

	it('graceful shutdown records running jobs as interrupted (S04:ENG-004)', async () => {
		const dir = tempAppdir('jasper-journal-');
		const journal = join(dir, 'jobs.jsonl');
		writeFileSync(journal, '{"torn line');
		const q = new JobQueue({ journalPath: journal, tmpDir: join(dir, 'tmp'), totalSlots: 2 });
		q.registerRunner('export', hang);
		q.start();
		const j = q.submit({ kind: 'export', title: 'e', priority: 'user', cpuSlots: 1 });
		await until(() => q.get(j.id)?.state === 'running');
		await q.shutdown();
		expect(q.get(j.id)?.state).toBe('interrupted');
		const again = new JobQueue({ journalPath: journal, tmpDir: join(dir, 'tmp'), totalSlots: 2 });
		again.start();
		expect(again.get(j.id)?.state).toBe('interrupted');
		await again.shutdown();
	});
});
