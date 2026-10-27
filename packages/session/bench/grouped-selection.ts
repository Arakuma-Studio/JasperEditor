// Run: pnpm exec tsx packages/session/bench/grouped-selection.ts [baseline-selection.ts]
// Alternates actual baseline/current implementations on identical, invariant-checked projects.
import { deepStrictEqual, ok } from 'node:assert';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
	checkInvariants,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
} from '@jasper/project';
import { expandClipSelection } from '../src/selection.ts';
import { EditorSession } from '../src/session.ts';

const variants: [string, typeof expandClipSelection][] = [['current', expandClipSelection]];
if (process.argv[2])
	variants.unshift([
		'baseline',
		(await import(pathToFileURL(resolve(process.argv[2])).href)).expandClipSelection,
	]);

console.log(
	JSON.stringify({ machine: cpus()[0]?.model, cores: cpus().length, node: process.version, load: loadavg() }),
);

const ids = createCounterIdSource(1);
const registries = defaultRegistries();
const seedSession = new EditorSession({
	projectId: 'grouped-selection-benchmark',
	document: createEmptyProject({ ids, name: 'Grouped selection', preset: 'hd-1080p-30' }),
	ctx: { ids, now: () => '2026-10-27T00:00:00.000Z', registries },
});
ok(
	seedSession.apply({
		label: 'Seed',
		origin: 'user',
		commands: [{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] }],
	}).ok,
);

for (const [size, groupSize, selectedCount] of [
	[1, 0, 1],
	[5000, 0, 5000],
	[5000, 10, 5000],
	[1000, 1000, 1000],
	[5000, 5000, 5000],
	[5000, 5000, 1],
] as const) {
	const document = structuredClone(seedSession.getCommitted());
	const sequence = Object.values(document.sequences)[0]!;
	const seedClip = Object.values(sequence.clips)[0]!;
	sequence.clips = {};
	const clipIds: string[] = [];
	for (let i = 0; i < size; i++) {
		const id = ids.next('clp');
		sequence.clips[id] = { ...seedClip, id, start: i * 30 };
		clipIds.push(id);
	}
	if (groupSize) {
		for (let i = 0; i < size; i += groupSize) {
			const groupId = ids.next('grp');
			const members = clipIds.slice(i, i + groupSize);
			sequence.groups[groupId] = { id: groupId, members };
			for (const id of members) sequence.clips[id]!.groupId = groupId;
		}
	}
	deepStrictEqual(checkInvariants(document, registries), []);
	const selected = clipIds.slice(0, selectedCount);
	const expected = variants[0]![1](document, selected, true);
	for (const [, expand] of variants) deepStrictEqual(expand(document, selected, true), expected);
	const iterations = size === 1 ? 10000 : groupSize === 5000 && selectedCount === 5000 ? 5 : 20;
	const samples = new Map(variants.map(([name]) => [name, [] as { wallMs: number; cpuMs: number }[]]));
	for (const [, expand] of variants) for (let i = 0; i < 5; i++) expand(document, selected, true);
	for (let round = 0; round < 7; round++) {
		for (const [name, expand] of round % 2 ? [...variants].reverse() : variants) {
			const cpuStart = process.cpuUsage();
			const start = performance.now();
			let checksum = 0;
			for (let i = 0; i < iterations; i++) checksum += expand(document, selected, true).length;
			const wallMs = (performance.now() - start) / iterations;
			const cpu = process.cpuUsage(cpuStart);
			deepStrictEqual(checksum, expected.length * iterations);
			samples.get(name)!.push({ wallMs, cpuMs: (cpu.user + cpu.system) / 1000 / iterations });
		}
	}
	for (const [variant, times] of samples) {
		const median = (key: 'wallMs' | 'cpuMs') => times.map((x) => x[key]).sort((a, b) => a - b)[3];
		console.log(
			JSON.stringify({
				variant,
				clips: size,
				groupSize,
				selectedCount,
				iterations,
				medianMs: median('wallMs'),
				medianCpuMs: median('cpuMs'),
				samples: times,
			}),
		);
	}
}
