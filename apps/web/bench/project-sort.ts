// Run: pnpm exec tsx apps/web/bench/project-sort.ts [baseline-module-path]
// The optional original model module is loaded from another checkout, as in timeline-transitions.ts.
// Alternating implementations share the exact fixture, process, warmup and host load.
import { deepStrictEqual } from 'node:assert';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { uiFixtureEnvelope } from '../../../scripts/perf/ui-fixtures.ts';
import { projectRows } from '../src/panels/project/model.ts';

const implementations: { label: string; rows: typeof projectRows }[] = [];
if (process.argv[2]) {
	const baseline = await import(pathToFileURL(resolve(process.argv[2])).href);
	implementations.push({ label: 'baseline', rows: baseline.projectRows });
}
implementations.push({ label: 'current', rows: projectRows });

console.log(
	JSON.stringify({ cpu: cpus()[0]?.model, cores: cpus().length, node: process.version, load: loadavg() }),
);
const ROUNDS = 9;
const WARMUPS = 2;
let checksum = 0;
for (const count of [2000, 5000]) {
	const doc = structuredClone(uiFixtureEnvelope(`items:${count}`).document);
	let seed = 12345;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 2 ** 32;
	};
	const words = ['Shot', 'Árbol', 'clip', 'Café', '取景', 'Take'];
	for (const item of Object.values(doc.items)) {
		if (item.kind === 'media')
			item.name = `${words[Math.floor(random() * words.length)]} ${Math.floor(random() * count)}`;
	}
	const rates = [24, 25, 30, 50, 60, 100, 120];
	for (const media of Object.values(doc.media)) {
		for (const stream of media.probe.streams) {
			if (stream.type === 'video')
				stream.frameRate = { num: rates[Math.floor(random() * rates.length)]!, den: 1 };
		}
	}
	for (const key of ['user', 'name', 'frameRate'] as const) {
		const query = { binId: null, search: '', filter: 'all', sort: { key, dir: 1 } } as const;
		const expected = implementations[0]!.rows(doc, {}, query);
		for (const impl of implementations) deepStrictEqual(impl.rows(doc, {}, query), expected);
		const timings = new Map(implementations.map((impl) => [impl.label, [] as number[]]));
		for (let round = 0; round < ROUNDS + WARMUPS; round++) {
			const order = round % 2 ? implementations : [...implementations].reverse();
			for (const impl of order) {
				const start = performance.now();
				const rows = impl.rows(doc, {}, query);
				const ms = performance.now() - start;
				checksum += rows.length + rows[0]!.name.length;
				if (round >= WARMUPS) timings.get(impl.label)!.push(ms);
			}
		}
		for (const impl of implementations) {
			const samples = timings.get(impl.label)!;
			const sorted = [...samples].sort((a, b) => a - b);
			console.log(
				JSON.stringify({
					count,
					key,
					implementation: impl.label,
					medianMs: sorted[ROUNDS >> 1],
					samplesMs: samples,
				}),
			);
		}
	}
}
console.log(`checksum ${checksum}; load at end ${loadavg().join(' ')}`);
