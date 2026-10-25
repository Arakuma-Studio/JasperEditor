// The export destination is the only output outside the appdir: its name is claimed exclusively,
// registered as a partial before any byte is written, and copying stops on cancellation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyNoOverwrite } from '../src/export/service.ts';
import { JobQueue } from '../src/jobs/queue.ts';
import { tempAppdir } from './temp.ts';

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
		const src = join(dir, 'render.mp4');
		writeFileSync(src, 'video');
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
		).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
		expect(claimed).toEqual([dest]);
		expect(existsSync(dest)).toBe(false);
	});
});

describe('cancelled export copy (job queue)', () => {
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
		expect((await q.wait(jobId)).state).toBe('cancelled');
		expect(existsSync(dest)).toBe(false);
	});
});
