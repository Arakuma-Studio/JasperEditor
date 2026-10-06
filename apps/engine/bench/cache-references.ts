// Run from the repository root: pnpm exec tsx apps/engine/bench/cache-references.ts
// Append --baseline to measure the original lookup with the same generated inputs.
// Includes index construction in every sample. No disk I/O: isolates the synchronous
// classification work that otherwise blocks the engine while scanning cache usage.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { EntryRef } from '../src/cache/layout.ts';
import type { ProjectCacheRefs } from '../src/cache/project-refs.ts';
import { indexProjectCacheRefs } from '../src/cache/reference-index.ts';

const hex = (n: number) => n.toString(16).padStart(64, '0');

// Original implementation from b56f7d4, retained to reproduce the baseline after optimization.
const baseline: typeof indexProjectCacheRefs = (computed, recorded) => (entry) => {
	const out = new Set(recorded.get(entry.id) ?? []);
	for (const [projectId, refs] of computed) {
		if (entry.kind === 'media-cache' || entry.kind === 'proxies') {
			if (refs.fingerprints.has(entry.key.slice(0, 64))) out.add(projectId);
		} else if (entry.kind === 'mg-renders') {
			if (refs.mgRenderKeys.has(entry.key)) out.add(projectId);
		} else if (entry.kind === 'mg-posters') {
			if (refs.bundleHashes.has(entry.key)) out.add(projectId);
		}
	}
	return out;
};
const implementation = process.argv.includes('--baseline') ? baseline : indexProjectCacheRefs;

for (const projectCount of [30, 300]) {
	const computed = new Map<string, ProjectCacheRefs>();
	const recorded = new Map<string, Set<string>>();
	const entries: EntryRef[] = [];
	for (let p = 0; p < projectCount; p++) {
		const fingerprints = new Set<string>();
		for (let m = 0; m < 100; m++) {
			const fingerprint = hex(p * 100 + m);
			fingerprints.add(fingerprint);
			const key = `${fingerprint}/poster-v1.jpg`;
			entries.push({ id: `media-cache:${key}`, kind: 'media-cache', key });
		}
		computed.set(`project-${p}`, { fingerprints, mgRenderKeys: new Set(), bundleHashes: new Set() });
	}
	const times: number[] = [];
	const cpuTimes: number[] = [];
	for (let run = 0; run < 9; run++) {
		const cpuStart = process.cpuUsage();
		const start = performance.now();
		const refsOf = implementation(computed, recorded);
		let references = 0;
		for (const entry of entries) references += refsOf(entry).size;
		const duration = performance.now() - start;
		const cpu = process.cpuUsage(cpuStart);
		assert.equal(references, entries.length);
		if (run >= 2) {
			times.push(duration);
			cpuTimes.push((cpu.user + cpu.system) / 1000);
		}
	}
	times.sort((a, b) => a - b);
	cpuTimes.sort((a, b) => a - b);
	console.log(
		JSON.stringify({
			implementation: implementation === baseline ? 'baseline' : 'indexed',
			projectCount,
			entries: entries.length,
			medianMs: times[3],
			medianCpuMs: cpuTimes[3],
			samplesMs: times,
		}),
	);
}
