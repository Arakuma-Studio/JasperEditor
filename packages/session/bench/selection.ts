// Run: pnpm exec tsx packages/session/bench/selection.ts [path-to-baseline-selection.ts]
// The optional baseline is imported and measured in alternating order in the same process.

import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { emptySelection, filterSelection } from '../src/selection.ts';
import { EditorSession } from '../src/session.ts';

const ids = createCounterIdSource(1);
const session = new EditorSession({
	projectId: 'selection-benchmark',
	document: createEmptyProject({ ids, name: 'Selection benchmark', preset: 'hd-1080p-30' }),
	ctx: { ids, now: () => '2026-10-06T00:00:00.000Z', registries: defaultRegistries() },
});
session.apply({
	label: 'Seed',
	origin: 'user',
	commands: [{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] }],
});
const seed = Object.values(session.getCommitted().sequences)[0]!;
const clip = Object.values(seed.clips)[0]!;
const variants: [string, typeof filterSelection][] = [['current', filterSelection]];
if (process.argv[2]) {
	const baseline = await import(pathToFileURL(resolve(process.argv[2])).href);
	variants.unshift(['baseline', baseline.filterSelection]);
}
for (const [size, sequenceCount] of [
	[1_000, 1],
	[10_000, 1],
	[10_000, 100],
] as const) {
	const doc = structuredClone(session.getCommitted());
	doc.sequences = {};
	const allIds: string[] = [];
	for (let sequence = 0; sequence < sequenceCount; sequence++) {
		const seq = { ...structuredClone(seed), id: `seq_bench_${sequence}`, clips: {} as typeof seed.clips };
		doc.sequences[seq.id] = seq;
		for (let i = 0; i < size / sequenceCount; i++) {
			const id = `clp_bench_${sequence}_${i}`;
			seq.clips[id] = { ...clip, id, start: i * 30 };
			allIds.push(id);
		}
	}
	for (const [name, selected] of [
		['empty', []],
		['one clip', [allIds[allIds.length - 1]!]],
		['all clips', allIds],
	] as const) {
		const selection = emptySelection();
		selection.timeline.clips = [...selected];
		selection.timeline.primaryClip = selected[0] ?? null;
		const samples = new Map(variants.map(([variant]) => [variant, [] as number[]]));
		const cpuSamples = new Map(variants.map(([variant]) => [variant, [] as number[]]));
		const checksums = new Map(variants.map(([variant]) => [variant, 0]));
		for (const [, filter] of variants) for (let i = 0; i < 20; i++) filter(selection, doc);
		for (let run = 0; run < 7; run++) {
			for (const [variant, filter] of run % 2 ? [...variants].reverse() : variants) {
				let checksum = 0;
				const cpuStart = process.cpuUsage();
				const start = performance.now();
				for (let i = 0; i < 100; i++) {
					checksum += filter(selection, doc).timeline.clips.length;
				}
				samples.get(variant)!.push((performance.now() - start) / 100);
				const cpu = process.cpuUsage(cpuStart);
				cpuSamples.get(variant)!.push((cpu.user + cpu.system) / 100_000);
				checksums.set(variant, checksums.get(variant)! + checksum);
			}
		}
		for (const [variant, timings] of samples) {
			timings.sort((a, b) => a - b);
			const cpuTimings = cpuSamples.get(variant)!.sort((a, b) => a - b);
			console.log(
				JSON.stringify({
					variant,
					clips: size,
					sequences: sequenceCount,
					selection: name,
					checksum: checksums.get(variant),
					medianMs: timings[3],
					medianCpuMs: cpuTimings[3],
					samplesCpuMs: cpuTimings,
					samplesMs: timings,
				}),
			);
		}
	}
}
