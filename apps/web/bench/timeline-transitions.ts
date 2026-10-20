// Run with: pnpm exec tsx apps/web/bench/timeline-transitions.ts [baseline-module-path]
// The optional baseline module is resolved relative to the working directory.

import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
	hitTransition,
	transitionIndex,
	transitionsInRange,
} from '../src/panels/timeline/model/transitions.ts';
import { transitionSequence } from '../test/transition-performance-fixture.ts';

type Implementation = {
	label: string;
	transitionIndex: typeof transitionIndex;
	transitionsInRange: typeof transitionsInRange;
	hitTransition: typeof hitTransition;
	checksum: number;
};
const implementations: Implementation[] = [];
if (process.argv[2]) {
	const baseline = await import(pathToFileURL(resolve(process.argv[2])).href);
	implementations.push({ label: 'baseline', ...baseline, checksum: 0 });
}
implementations.push({ label: 'current', transitionIndex, transitionsInRange, hitTransition, checksum: 0 });
function measure(label: string, operation: (i: number) => number, iterations = 2000) {
	let checksum = 0;
	for (let i = 0; i < 1000; i++) checksum += operation(i);
	const samples: number[] = [];
	for (let batch = 0; batch < 9; batch++) {
		const start = performance.now();
		for (let i = 0; i < iterations; i++) checksum += operation(i);
		samples.push(((performance.now() - start) * 1000) / iterations);
	}
	samples.sort((a, b) => a - b);
	console.log(`${label}: median ${samples[4]!.toFixed(3)} us/op (9 batches x ${iterations})`);
	return checksum;
}
for (const count of [100, 1000, 10000]) {
	const { seq, media, row } = transitionSequence(count);
	const buildSamples = new Map(implementations.map((impl) => [impl.label, [] as number[]]));
	for (let i = 0; i < 40; i++) {
		// Alternate order to expose both implementations to the same process/host conditions.
		const order = i % 2 ? implementations : [...implementations].reverse();
		for (const impl of order) {
			// New record identity forces a rebuild. Allocate it before the timer.
			const fresh = { ...seq, transitions: { ...seq.transitions } };
			const start = performance.now();
			impl.transitionIndex(fresh, media);
			const elapsed = (performance.now() - start) * 1000;
			if (i >= 10) buildSamples.get(impl.label)!.push(elapsed);
		}
	}
	for (const impl of implementations) {
		const samples = buildSamples.get(impl.label)!;
		samples.sort((a, b) => a - b);
		console.log(
			`${count} transitions / ${impl.label} index build: median ${samples[15]!.toFixed(3)} us (30 builds after 10 warmups)`,
		);
		const index = impl.transitionIndex(seq, media);
		const frame = (i: number) => ((i * 37) % count) * 100;
		impl.checksum += measure(
			`${count} transitions / ${impl.label} viewport query`,
			(i) => impl.transitionsInRange(index, row.trackId, frame(i), frame(i) + 1200).length,
		);
		impl.checksum += measure(
			`${count} transitions / ${impl.label} pointer hit`,
			(i) =>
				impl.hitTransition(index, row, { scrollFrame: frame(i), pxPerFrame: 1, width: 1200 }, 10, 20)?.geom
					.start ?? 0,
		);
	}
}
for (const impl of implementations) console.log(`${impl.label} checksum: ${impl.checksum}`);
