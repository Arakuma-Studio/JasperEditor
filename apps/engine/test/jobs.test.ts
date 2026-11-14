import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineJob, EventEnvelope } from '@jasper/api';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Broadcaster } from '../src/events/broadcaster.ts';
import { JobQueue } from '../src/jobs/queue.ts';
import { type JobContext, JobError, type JobRunner } from '../src/jobs/types.ts';
import { Ffmpeg, resolveBinaries } from '../src/tools/ffmpeg.ts';
import { spawnTool } from '../src/tools/process.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	H,
	JSON_H,
	makeApp,
	register,
	tempAppdir,
} from './helpers.ts';

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

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
	it('filters dedupe keys and returns detached jobs from internal and external sources', () => {
		const q = makeQueue({ journal: null });
		q.registerRunner('analysis', hang);
		const a = q.submit({
			kind: 'analysis',
			title: 'a',
			priority: 'user',
			cpuSlots: 1,
			dedupeKey: 'wanted',
		});
		const b = q.submit({ kind: 'analysis', title: 'b', priority: 'user', cpuSlots: 1, dedupeKey: 'other' });
		q.submit({ kind: 'analysis', title: 'no key', priority: 'user', cpuSlots: 1 });
		const external: EngineJob[] = [
			{ ...a, id: 'external-a', state: 'running', createdAt: a.createdAt, progress: 0.5 },
			{ ...a, id: 'external-b', state: 'succeeded', finishedAt: a.createdAt },
			{ ...a, id: 'external-c', dedupeKey: 'other', createdAt: '2099-01-01T00:00:00.000Z' },
		];
		q.registerExternalSource({
			owns: (id) => id.startsWith('external-'),
			list: () => external,
			get: () => null,
			cancel: () => null,
		});
		const found = q.list({ dedupeKeys: new Set(['wanted']) });
		expect(found.map((job) => job.id)).toEqual([a.id, 'external-a', 'external-b']);
		expect(q.list({ active: true, dedupeKeys: new Set(['wanted']) }).map((job) => job.id)).toEqual([
			a.id,
			'external-a',
		]);
		expect(q.list({ dedupeKeys: new Set(['other', 'unknown']) }).map((job) => job.id)).toEqual([
			'external-c',
			b.id,
		]);
		expect(q.list({ dedupeKeys: new Set() })).toEqual([]);
		for (const job of found) job.title = 'changed by caller';
		expect(q.get(a.id)?.title).toBe('a');
		expect(external[0]?.title).toBe('a');
	});

	it('lists retained attempts in insertion order and applies filters to keyed history', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-27T00:00:00Z'));
		try {
			const q = makeQueue({ journal: null });
			q.registerRunner('analysis', hang);
			const spec = { kind: 'analysis' as const, priority: 'user' as const, cpuSlots: 1 };
			const first = q.submit({ ...spec, title: 'first', dedupeKey: 'a', projectId: 'p1' });
			const second = q.submit({ ...spec, title: 'second', dedupeKey: 'b', projectId: 'p2' });
			q.cancel(first.id);
			const retried = q.retry(first.id);
			const dedupeKeys = new Set(['b', 'missing', 'a']);
			for (const [filter, ids] of [
				[{ dedupeKeys }, [first.id, second.id, retried.id]],
				[{ dedupeKeys, active: true }, [second.id, retried.id]],
				[{ dedupeKeys, projectId: 'p1' }, [first.id, retried.id]],
				[{ dedupeKeys, kind: 'export' }, []],
				[{ dedupeKeys, since: '2099-01-01T00:00:00Z' }, [second.id, retried.id]],
				[{ dedupeKeys: new Set(['a']) }, [first.id, retried.id]],
				[{ dedupeKeys: new Set(['a']), active: true }, [retried.id]],
			] as const)
				expect(q.list(filter).map((job) => job.id)).toEqual(ids);
		} finally {
			vi.useRealTimers();
		}
	});

	it('restores keyed journal history in stable order and drops pruned keys from lookups', async () => {
		const dir = tempAppdir('jasper-lookup-journal-');
		const journal = join(dir, 'jobs.jsonl');
		let time = Date.parse('2026-09-01T00:00:00Z');
		const q = new JobQueue({
			journalPath: journal,
			tmpDir: join(dir, 'tmp'),
			now: () => new Date(time),
			totalSlots: 1,
		});
		queues.push(q);
		q.registerRunner('analysis', hang);
		const spec = { kind: 'analysis' as const, priority: 'user' as const, cpuSlots: 1 };
		const first = q.submit({ ...spec, title: 'before start', dedupeKey: 'same' });
		const other = q.submit({ ...spec, title: 'other', dedupeKey: 'other' });
		const duplicate = { ...first, id: 'job_duplicate_key' };
		// Fresh terminal records survive recovery; eight days later only the newest 500 remain (S04 CA-020).
		const finished = Array.from({ length: 501 }, (_, i) => ({
			...first,
			id: `job_finished_${i}`,
			title: `finished-${i}`,
			dedupeKey: `finished:${i}`,
			state: 'succeeded',
			progress: 1,
			finishedAt: first.createdAt,
		}));
		writeFileSync(
			journal,
			`${[first, duplicate, other, ...finished].map((job) => JSON.stringify({ job })).join('\n')}\n`,
		);
		q.start();
		const restored = [first.id, other.id, duplicate.id];
		expect(q.list({ dedupeKeys: new Set(['other', 'same']) }).map((job) => job.id)).toEqual(restored);
		for (const id of restored) q.cancel(id);
		await Promise.all(restored.map((id) => q.wait(id)));
		time += 8 * 24 * 3600 * 1000;
		expect(q.prune()).toBe(4);
		expect(q.list({ dedupeKeys: new Set(['same', 'other', 'finished:0']) })).toEqual([]);
		expect(q.list({ dedupeKeys: new Set(['finished:500']) }).map((job) => job.id)).toEqual([
			'job_finished_500',
		]);
	});

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
		await drain();
		expect(order).toHaveLength(1);
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
		// int-1 takes the interactive headroom (one slot of two) while bg-1 holds both slots
		expect(order).toEqual(['bg-1', 'int-1']);
		expect(q.usedSlots).toBe(3);
		gates.get('bg-1')!();
		await q.wait(a.id);
		await drain();
		expect(order).toEqual(['bg-1', 'int-1', 'int-2']);
		for (const t of ['int-1', 'int-2']) gates.get(t)!();
		await drain();
		expect(order.slice(3)).toEqual(['user-1', 'bg-2']);
		for (const t of ['user-1', 'bg-2']) gates.get(t)!();
		await Promise.all(q.list({ active: true }).map((job) => q.wait(job.id)));
	});

	it('starts exports with at least half the slots and pauses the background lane meanwhile (JB-012/013)', async () => {
		const q = makeQueue({ slots: 4 });
		const started: { title: string; slots: number }[] = [];
		const gates: (() => void)[] = [];
		const backgroundSawExport: boolean[] = [];
		const runner: JobRunner = (ctx) => {
			started.push({ title: ctx.job.title, slots: ctx.slots });
			if (ctx.job.priority === 'background')
				backgroundSawExport.push(
					q.list({ active: true }).some((j) => j.kind === 'export' && j.state === 'running'),
				);
			return new Promise<void>((res) => gates.push(res));
		};
		q.registerRunner('analysis', runner);
		q.registerRunner('export', runner);
		q.start();
		q.submit({ kind: 'analysis', title: 'probe', priority: 'interactive', cpuSlots: 1 });
		const exp = q.submit({ kind: 'export', title: 'export', priority: 'user', cpuSlots: 4, minSlots: 2 });
		await drain();
		expect(started).toHaveLength(2);
		expect(started[1]).toEqual({ title: 'export', slots: 3 });
		q.submit({ kind: 'analysis', title: 'bg', priority: 'background', cpuSlots: 0 });
		gates[1]!();
		await q.wait(exp.id);
		await drain();
		expect(started).toHaveLength(3);
		expect(backgroundSawExport).toEqual([false]);
		for (const g of gates) g();
	});

	it("starts an import's probe while an export holds every CPU slot", async () => {
		ensureFixtures();
		const app = await makeApp({ totalSlots: 4 });
		const core = coreServices(app);
		const d = new DocBuilder('hd-720p-30');
		d.tx([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0.2, 0.4, 1, 1] }]);
		// the export holds its slots until the import's probe is queued, then ends
		let release: () => void = () => undefined;
		core.queue.registerRunner('export', () => new Promise<void>((res) => (release = res)));
		const exportStateWhenProbeRan: string[] = [];
		let exportId = '';
		core.broadcaster.subscribe((e) => {
			const j = e.payload as EngineJob;
			if (j.kind !== 'probe') return;
			if (e.type === 'job.created') setImmediate(() => release());
			if (e.type === 'job.updated' && j.state === 'running')
				exportStateWhenProbeRan.push(core.queue.get(exportId)!.state);
		});
		const r = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: {
					sequenceId: d.seqId,
					range: { type: 'entire' },
					container: 'mp4',
					engine: 'native',
					video: {
						codec: 'h264',
						width: 640,
						height: 360,
						frameRate: { num: 30, den: 1 },
						scaling: 'fit',
						quality: { mode: 'crf', value: 23 },
						encoderSpeed: 'fast',
					},
					audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
				},
			},
		});
		expect(r.statusCode, r.body).toBe(202);
		exportId = r.json().id;
		expect(core.queue.usedSlots).toBe(core.queue.totalSlots);
		await register(app, fixture('clip-b.mp4'));
		expect(exportStateWhenProbeRan).toEqual(['running']);
		await core.queue.wait(exportId);
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

	it.each([null, undefined, 42, 'worker disconnected', { message: 42, code: false }, Object.create(null)])(
		'finishes jobs whose runner rejects with %j',
		async (reason: unknown) => {
			const q = makeQueue({ slots: 1 });
			q.registerRunner('analysis', async () => Promise.reject(reason));
			q.start();
			const job = q.submit({ kind: 'analysis', title: 'invalid failure', priority: 'user', cpuSlots: 1 });
			const failed = await q.wait(job.id);
			expect(failed.state).toBe('failed');
			expect(failed.error).toMatchObject({ code: 'INTERNAL', message: expect.any(String) });
			expect(q.usedSlots).toBe(0);
		},
	);

	it('throttles job.updated to 4/s per job and always sends the final state (JB-040)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-16T10:00:00.000Z'));
		try {
			const events: EventEnvelope[] = [];
			const b = new Broadcaster();
			b.subscribe((e) => events.push(e));
			const q = makeQueue({ broadcaster: b, journal: null });
			let ctx!: JobContext;
			let finish!: () => void;
			let entered!: () => void;
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			q.registerRunner('analysis', (jobContext) => {
				ctx = jobContext;
				entered();
				return new Promise<void>((resolve) => {
					finish = resolve;
				});
			});
			q.start();
			const job = q.submit({ kind: 'analysis', title: 't', priority: 'user', cpuSlots: 1 });
			await started;
			const updates = () => events.filter((e) => e.type === 'job.updated').map((e) => e.payload as EngineJob);
			for (let i = 1; i <= 200; i++) {
				ctx.progress(i / 250);
				if (i % 5 === 0) await vi.advanceTimersByTimeAsync(i === 200 ? 24 : 25);
			}
			// This 999 ms window allows at most four progress events, plus the forced running state.
			expect(updates().length).toBeLessThanOrEqual(5);
			expect(
				updates().some(
					(j) => j.state === 'running' && j.progress !== null && j.progress > 0 && j.progress < 1,
				),
			).toBe(true);
			ctx.progress(0.9); // the final state must bypass a pending throttled update
			finish();
			await q.wait(job.id);
			expect(updates().at(-1)).toMatchObject({ state: 'succeeded', progress: 1 });
			expect(updates().length).toBeLessThanOrEqual(6);
			expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['job.created', 'job.finished']));
			expect(events.at(-1)!.type).toBe('job.finished');
			const finishedEvents = events.length;
			await vi.advanceTimersByTimeAsync(1000);
			expect(events).toHaveLength(finishedEvents);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('cancellation (S04:JB-020, QA-007)', () => {
	it('cancels a running ffmpeg job, kills its child processes and removes partials', async () => {
		const ff = new Ffmpeg(resolveBinaries());
		const q = makeQueue();
		const dir = tempAppdir('jasper-cancel-');
		const partial = join(dir, 'out.partial.mp4');
		let pgids: number[] = [];
		let progressed!: () => void;
		const encoding = new Promise<void>((resolve) => {
			progressed = resolve;
		});
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
					// a long real encode with an LGPL encoder (any FFmpeg build has mpeg4)
					'-c:v',
					'mpeg4',
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
					onProgress: (p) => {
						ctx.progress(p.outTimeUs / 600e6);
						if (p.outTimeUs > 0) progressed();
					},
				},
			);
		});
		q.start();
		const job = q.submit({ kind: 'analysis', title: 'long encode', priority: 'user', cpuSlots: 1 });
		await encoding;
		expect(pgids).toHaveLength(2);
		expect(existsSync(partial)).toBe(true);
		try {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			expect(q.cancel(job.id)?.state).toBe('cancelling');
			await vi.advanceTimersByTimeAsync(3000);
			expect((await q.wait(job.id)).state).toBe('cancelled');
			for (const g of pgids) {
				expect(() => process.kill(g, 0)).toThrow('ESRCH');
				expect(groupMembers(g)).toEqual([]);
			}
			expect(existsSync(partial)).toBe(false);
		} finally {
			vi.useRealTimers();
			for (const g of pgids) {
				try {
					process.kill(-g, 'SIGKILL');
				} catch {
					// The assertions above already require the owned process group to be gone.
				}
			}
			pgids = [];
		}
	}, 180_000);

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
		await drain();
		expect(core.queue.get(job.id)?.state).toBe('running');
		const r = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: H });
		expect(r.statusCode).toBe(200);
		expect(['cancelling', 'cancelled']).toContain(r.json().state);
		await core.queue.wait(job.id);
		expect((await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: H })).json().state).toBe(
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
	it('does not restore malformed journal records as runnable jobs', async () => {
		const job: EngineJob = {
			id: 'job_invalid',
			kind: 'analysis',
			title: 'Persisted job',
			origin: { type: 'user' },
			state: 'queued',
			progress: null,
			createdAt: new Date().toISOString(),
			priority: 'user',
			cpuSlots: 1,
		};
		const valid = { ...job, id: `${job.id}_healthy` };
		await fc.assert(
			fc.asyncProperty(
				fc.oneof(
					fc.integer({ max: -1 }).map((cpuSlots) => ({ job: { ...job, cpuSlots } })),
					fc.integer({ min: 2 }).map((progress) => ({ job: { ...job, progress } })),
					fc.string().map((kind) => ({ job: { ...job, kind: `invalid-${kind}` } })),
					fc.string().map((state) => ({ job: { ...job, state: `invalid-${state}` } })),
					fc.integer().map((agentRunId) => ({ job: { ...job, origin: { type: 'agent', agentRunId } } })),
					fc.string().map((requeued) => ({ job, requeued })),
				),
				async (invalid) => {
					const dir = tempAppdir('jasper-invalid-journal-');
					const journal = join(dir, 'jobs.jsonl');
					writeFileSync(journal, [JSON.stringify(invalid), JSON.stringify({ job: valid })].join('\n'));
					const q = makeQueue({ journal });
					const ran: string[] = [];
					q.registerRunner('analysis', async (ctx) => {
						ran.push(ctx.job.id);
					});
					q.start();
					await q.wait(valid.id);
					expect(q.list().map((restored) => restored.id)).toEqual([valid.id]);
					expect(ran).toEqual([valid.id]);
					await q.shutdown(1000);
				},
			),
			{ numRuns: 30 },
		);
	});

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
		await drain();
		expect(first.get(exp.id)?.state).toBe('running');
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
		expect((await second.wait(proxy.id)).state).toBe('succeeded');
		expect(proxyInputs).toEqual([{ mediaKey: 'mk_1' }]);
		const retry = second.retry(exp.id);
		expect(retry.kind).toBe('export');

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
		await drain();
		expect(third.get(p.id)?.state).toBe('running');
		const fourth = makeQueue({ journal: join(dir, 'b.jsonl'), slots: 1 });
		const seen: unknown[] = [];
		fourth.registerRunner('proxy', async (ctx) => {
			seen.push(ctx.input);
			return null;
		});
		fourth.start();
		expect(fourth.get(p.id)?.state).toBe('interrupted');
		await drain();
		expect(seen).toEqual([{ mediaKey: 'mk_2' }]);
		const fifth = makeQueue({ journal: join(dir, 'b.jsonl'), slots: 1 });
		fifth.registerRunner('proxy', async () => {
			seen.push('again');
			return null;
		});
		fifth.start();
		// Allow any incorrectly re-queued work to enter its runner.
		await new Promise<void>((resolve) => setImmediate(resolve));
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
		await drain();
		expect(q.get(j.id)?.state).toBe('running');
		await q.shutdown();
		expect(q.get(j.id)?.state).toBe('interrupted');
		const again = new JobQueue({ journalPath: journal, tmpDir: join(dir, 'tmp'), totalSlots: 2 });
		again.start();
		expect(again.get(j.id)?.state).toBe('interrupted');
		await again.shutdown();
	});
});
