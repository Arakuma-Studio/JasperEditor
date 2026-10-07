// mcp-cli §2: cancelling a job deletes what it wrote. The export's copy to the user's destination is the
// one output outside the appdir: its name is claimed exclusively, registered as a partial before any byte is
// written, and the copy stops when the job is cancelled.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyNoOverwrite } from '../src/export/service.ts';
import { JobQueue } from '../src/jobs/queue.ts';
import { tempAppdir, until } from './helpers.ts';

const queues: JobQueue[] = [];
afterEach(async () => {
	for (const q of queues.splice(0)) await q.shutdown(1000);
});

function makeQueue() {
	const dir = tempAppdir('jasper-cancel-');
	const q = new JobQueue({ journalPath: null, tmpDir: join(dir, 'tmp'), logDir: null, totalSlots: 2 });
	queues.push(q);
	return { q, dir };
}

function bigFile(dir: string, mb: number): string {
	const p = join(dir, 'render.mp4');
	writeFileSync(p, Buffer.alloc(mb * 1024 * 1024, 7));
	return p;
}

describe('copyNoOverwrite', () => {
	it('never overwrites: picks "name (2)", "name (3)" and claims the name exclusively', async () => {
		const dir = tempAppdir('jasper-copy-');
		const src = join(dir, 'src.mp4');
		writeFileSync(src, 'video');
		const out = join(dir, 'out', 'cut.mp4');
		const a = await copyNoOverwrite(src, out);
		const [b, c] = await Promise.all([copyNoOverwrite(src, out), copyNoOverwrite(src, out)]);
		expect(a).toBe(out);
		expect(new Set([b, c])).toEqual(
			new Set([join(dir, 'out', 'cut (2).mp4'), join(dir, 'out', 'cut (3).mp4')]),
		);
		expect(readFileSync(c!, 'utf8')).toBe('video');
	});

	it('reports the claimed path before writing and removes it when the copy is aborted', async () => {
		const dir = tempAppdir('jasper-copy-');
		const src = bigFile(dir, 32);
		const ac = new AbortController();
		const claimed: string[] = [];
		const dest = join(dir, 'final.mp4');
		await expect(
			copyNoOverwrite(src, dest, {
				signal: ac.signal,
				claimed: (p) => {
					claimed.push(p);
					ac.abort();
				},
			}),
		).rejects.toThrow();
		expect(claimed).toEqual([dest]);
		expect(existsSync(dest)).toBe(false);
	});
});

describe('cancelled export copy (job queue)', () => {
	it('a cancel during the copy to the destination deletes the destination file', async () => {
		const { q, dir } = makeQueue();
		const src = bigFile(dir, 64);
		const dest = join(dir, 'exports', 'teaser.mp4');
		mkdirSync(join(dir, 'exports'), { recursive: true });
		let jobId = '';
		q.registerRunner('export', async (ctx) => {
			const path = await copyNoOverwrite(src, dest, {
				signal: ctx.signal,
				claimed: (p) => {
					ctx.addPartial(p);
					// The user cancels right as the copy starts.
					q.cancel(jobId);
				},
			});
			return { path };
		});
		q.start();
		jobId = q.submit({ kind: 'export', title: 'Export', priority: 'user', cpuSlots: 1 }).id;
		await until(() => q.get(jobId)?.state === 'cancelled', 10_000);
		expect(existsSync(dest)).toBe(false);
	});

	it('a cancel after the copy finished (before the job ends) removes the copied file too', async () => {
		const { q, dir } = makeQueue();
		const src = join(dir, 'src.mp4');
		writeFileSync(src, 'video');
		const dest = join(dir, 'done.mp4');
		let jobId = '';
		q.registerRunner('export', async (ctx) => {
			const path = await copyNoOverwrite(src, dest, {
				signal: ctx.signal,
				claimed: (p) => ctx.addPartial(p),
			});
			q.cancel(jobId);
			return { path };
		});
		q.start();
		jobId = q.submit({ kind: 'export', title: 'Export', priority: 'user', cpuSlots: 1 }).id;
		await until(() => q.get(jobId)?.state === 'cancelled', 10_000);
		expect(existsSync(dest)).toBe(false);
	});

	it('a successful job keeps its destination file', async () => {
		const { q, dir } = makeQueue();
		const src = join(dir, 'src.mp4');
		writeFileSync(src, 'video');
		const dest = join(dir, 'kept.mp4');
		q.registerRunner('export', async (ctx) => ({
			path: await copyNoOverwrite(src, dest, { signal: ctx.signal, claimed: (p) => ctx.addPartial(p) }),
		}));
		q.start();
		const id = q.submit({ kind: 'export', title: 'Export', priority: 'user', cpuSlots: 1 }).id;
		const job = await q.wait(id);
		expect(job.state).toBe('succeeded');
		expect(readFileSync(dest, 'utf8')).toBe('video');
	});
});
