import { readFileSync } from 'node:fs';
import { isMainThread } from 'node:worker_threads';

/** Actual executing-thread CPU time; other workers and V8 background work are excluded. */
function readThreadCpuMs(): number | null {
	try {
		const ns = Number(readFileSync('/proc/thread-self/schedstat', 'utf8').split(' ')[0]);
		return Number.isFinite(ns) && ns > 0 ? ns / 1e6 : null;
	} catch {
		return null;
	}
}

export function hasThreadCpuTimer(): boolean {
	return readThreadCpuMs() !== null;
}

export function threadCpuMs(): number {
	const cpu = readThreadCpuMs();
	if (cpu !== null) return cpu;
	if (!isMainThread)
		throw new Error('the CPU-time budget needs readable /proc/thread-self/schedstat in the threads pool');
	// Without procfs, forked tests retain their existing process-CPU fallback.
	const processCpu = process.cpuUsage();
	return (processCpu.user + processCpu.system) / 1000;
}
