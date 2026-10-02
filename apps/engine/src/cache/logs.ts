// Engine logs and the job journal (M3, wp-m3-cachegc, S04:CA-020): not caches, but they must not grow forever.
//   <appdir>/engine/logs/YYYY-MM-DD.log, logs/jobs/<jobId>.log, logs/mg-bundles/<jobId>.log … — log files: removed
//       when older than `logs.maxAgeDays` (default 30), then oldest first while the folder exceeds `logs.maxBytes`
//       (default 256 MB);
//   logs/remotion-usage.jsonl — the Remotion licence-reporting log (S04:LC-004, counts per month): lines older than
//       400 days are dropped once the file exceeds 1 MB (13 months always kept); never removed by the size limit;
//   engine/jobs.jsonl — the job journal: compacted by the queue (`JobQueue.prune`: finished jobs older than 7 days
//       beyond the newest 500) whenever it exceeds 2 MB.
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppdirPaths } from '@jasper/config';
import { atomicWriteFile } from '../tools/fs.ts';

const DAY = 24 * 3600 * 1000;
export const USAGE_LOG = 'remotion-usage.jsonl';
const USAGE_LOG_KEEP_MS = 400 * DAY;
const USAGE_LOG_TRIM_BYTES = 1024 * 1024;
export const JOURNAL_COMPACT_BYTES = 2 * 1024 * 1024;

type LogFile = { path: string; bytes: number; mtimeMs: number };

async function walk(dir: string, out: LogFile[] = []): Promise<LogFile[]> {
	let names: import('node:fs').Dirent[];
	try {
		names = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const d of names) {
		const p = join(dir, d.name);
		if (d.isDirectory()) await walk(p, out);
		else if (d.isFile()) {
			const st = await stat(p).catch(() => null);
			if (st) out.push({ path: p, bytes: st.size, mtimeMs: st.mtimeMs });
		}
	}
	return out;
}

export type LogsUsage = { bytes: number; files: number; journalBytes: number };

export async function logsUsage(paths: AppdirPaths): Promise<LogsUsage> {
	const files = await walk(paths.logsDir);
	const journal = await stat(paths.jobsJournal).catch(() => null);
	return {
		bytes: files.reduce((s, f) => s + f.bytes, 0) + (journal?.size ?? 0),
		files: files.length + (journal ? 1 : 0),
		journalBytes: journal?.size ?? 0,
	};
}

/** Drops usage-log lines older than 400 days once the file passes 1 MB. Returns the bytes saved. */
export async function trimUsageLog(file: string, now: number): Promise<number> {
	const st = await stat(file).catch(() => null);
	if (!st || st.size <= USAGE_LOG_TRIM_BYTES) return 0;
	const text = await readFile(file, 'utf8');
	const kept = text.split('\n').filter((line) => {
		if (!line.trim()) return false;
		try {
			const t = Date.parse((JSON.parse(line) as { at?: string }).at ?? '');
			return !Number.isFinite(t) || now - t <= USAGE_LOG_KEEP_MS;
		} catch {
			return false;
		}
	});
	const next = kept.length ? `${kept.join('\n')}\n` : '';
	await atomicWriteFile(file, next);
	return st.size - Buffer.byteLength(next);
}

/** Retention for the log folder. Returns what was removed. */
export async function maintainLogs(
	paths: AppdirPaths,
	limits: { maxAgeDays: number | null; maxBytes: number | null },
	now = Date.now(),
): Promise<{ removedFiles: number; removedBytes: number }> {
	let removedFiles = 0;
	let removedBytes = 0;
	const usageLog = join(paths.logsDir, USAGE_LOG);
	removedBytes += await trimUsageLog(usageLog, now).catch(() => 0);
	const files = (await walk(paths.logsDir)).filter((f) => f.path !== usageLog);
	const drop = async (f: LogFile) => {
		try {
			await rm(f.path, { force: true });
			removedFiles++;
			removedBytes += f.bytes;
			return true;
		} catch {
			return false;
		}
	};
	const left: LogFile[] = [];
	for (const f of files) {
		if (limits.maxAgeDays !== null && now - f.mtimeMs > limits.maxAgeDays * DAY) await drop(f);
		else left.push(f);
	}
	if (limits.maxBytes !== null) {
		let total = left.reduce((s, f) => s + f.bytes, 0);
		for (const f of left.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
			if (total <= limits.maxBytes) break;
			// Today's engine log stays (it is being written).
			if (now - f.mtimeMs < 60_000) continue;
			if (await drop(f)) total -= f.bytes;
		}
	}
	return { removedFiles, removedBytes };
}
