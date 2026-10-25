// Run: pnpm exec tsx packages/session/bench/bulk-selection.ts [baseline-selection.ts]
// Pass the original source file to alternate actual before/after functions in one process.
import { deepStrictEqual } from 'node:assert';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createCounterIdSource, createEmptyProject, type ProjectDocument } from '@jasper/project';
import { combine, expandClipSelection } from '../src/selection.ts';

const variants: [string, { combine: typeof combine; expandClipSelection: typeof expandClipSelection }][] = [
	['current', { combine, expandClipSelection }],
];
if (process.argv[2])
	variants.unshift(['baseline', await import(pathToFileURL(resolve(process.argv[2])).href)]);
console.log(
	JSON.stringify({ machine: cpus()[0]?.model, cores: cpus().length, node: process.version, load: loadavg() }),
);

function measure(name: string, iterations: number, run: (v: (typeof variants)[number][1]) => string[]) {
	const expected = run(variants[0]![1]);
	for (const [, v] of variants) deepStrictEqual(run(v), expected);
	const samples = new Map(variants.map(([variant]) => [variant, [] as { wallMs: number; cpuMs: number }[]]));
	for (const [, v] of variants) for (let i = 0; i < 5; i++) run(v);
	for (let round = 0; round < 7; round++) {
		for (const [variant, v] of round % 2 ? [...variants].reverse() : variants) {
			const cpuStart = process.cpuUsage();
			const start = performance.now();
			let checksum = 0;
			for (let i = 0; i < iterations; i++) checksum += run(v).length;
			const wallMs = (performance.now() - start) / iterations;
			const cpu = process.cpuUsage(cpuStart);
			if (checksum !== expected.length * iterations) throw new Error('Selection changed during benchmark');
			samples.get(variant)!.push({ wallMs, cpuMs: (cpu.user + cpu.system) / 1000 / iterations });
		}
	}
	for (const [variant, times] of samples) {
		const median = (key: 'wallMs' | 'cpuMs') => times.map((x) => x[key]).sort((a, b) => a - b)[3];
		console.log(
			JSON.stringify({
				name,
				variant,
				iterations,
				medianMs: median('wallMs'),
				medianCpuMs: median('cpuMs'),
				samples: times,
			}),
		);
	}
}

for (const size of [1, 16, 1000, 10_000]) {
	const selected = Array.from({ length: size }, (_, i) => `clp_${i.toString().padStart(8, '0')}`);
	const removed = selected.filter((_, i) => i % 2 === 0);
	measure(`remove half of ${size}`, size >= 1000 ? 10 : 10_000, (v) =>
		v.combine(selected, removed, 'remove'),
	);
}

// Selection expansion needs only clip link/group IDs; no render or command work is timed.
const document = createEmptyProject({
	ids: createCounterIdSource(1),
	name: 'Expansion',
	preset: 'hd-1080p-30',
});
const seed = Object.values(document.sequences)[0]!;
for (const count of [1, 200]) {
	const doc: ProjectDocument = { ...document, sequences: {} };
	const clipIds: string[] = [];
	for (let n = 0; n < count; n++) {
		const clips: typeof seed.clips = {};
		for (let i = 0; i < 5000 / count; i++) {
			const id = `clp_bench_${n}_${i}`;
			clips[id] = { id, linkId: null, groupId: null } as (typeof clips)[string];
			clipIds.push(id);
		}
		doc.sequences[`seq_bench_${n}`] = { ...seed, id: `seq_bench_${n}`, clips };
	}
	measure(`expand 5000 clips / ${count} sequences`, 10, (v) => v.expandClipSelection(doc, clipIds, true));
}
