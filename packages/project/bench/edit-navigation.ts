// Run: pnpm exec tsx packages/project/bench/edit-navigation.ts [baseline-derive-module]
// A baseline module must be beside derive/index.ts so its relative imports resolve.
// Fixture construction, index warm-up and exact output comparisons are not timed.
import { strict as assert } from 'node:assert';
import { cpus, loadavg, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { gapAt, nextEditPoint, prevEditPoint } from '../src/derive/index.ts';
import type { Clip, Sequence } from '../src/schema/sequence.ts';
import { Harness } from '../test/helpers.ts';

const current = { gapAt, nextEditPoint, prevEditPoint };
const baseline: typeof current | undefined = process.argv[2]
	? await import(pathToFileURL(resolve(process.argv[2])).href)
	: undefined;
const loadAtStart = loadavg();
const results = [];
for (const clipCount of [100, 1_000, 5_000, 50_000]) {
	const h = new Harness();
	h.ok([{ type: 'clip.addSolid', at: 0, duration: 20, track: 'V1', color: [1, 0, 0, 1] }]);
	const template = Object.values(h.seq.clips)[0]!;
	const seq: Sequence = { ...h.seq, clips: {} };
	const tracks = seq.videoTracks;
	for (let i = clipCount - 1; i >= 0; i--) {
		const id = `clip-${i}`;
		seq.clips[id] = {
			...template,
			id,
			trackId: tracks[i % tracks.length]!.id,
			start: Math.floor(i / tracks.length) * 30 + 5,
			duration: 20,
		} as Clip;
	}
	const frames = [0, 5, 7, 25, 27, Math.floor(clipCount / tracks.length / 2) * 30 + 27, clipCount * 30];
	for (const operation of ['nextEditPoint', 'prevEditPoint', 'gapAt'] as const) {
		const variants = [
			...(baseline ? [{ name: 'baseline', model: baseline }] : []),
			{ name: 'current', model: current },
		].map((v) => ({ ...v, wall: [] as number[], cpu: [] as number[], checksum: 0 }));
		const query = (model: typeof current, frame: number) =>
			operation === 'gapAt' ? model.gapAt(seq, tracks[0]!.id, frame) : model[operation](seq, frame);
		const outputs = variants.map((v) => frames.map((frame) => query(v.model, frame)));
		for (const output of outputs) assert.deepEqual(output, outputs[0]);
		const run = (v: (typeof variants)[number]) => {
			for (const frame of frames) {
				const result = query(v.model, frame);
				v.checksum += typeof result === 'number' ? result : (result?.end ?? 0);
			}
		};
		for (const v of variants) run(v);
		for (let sample = 0; sample < 7; sample++) {
			for (const v of sample % 2 ? [...variants].reverse() : variants) {
				const start = performance.now();
				const cpuStart = process.cpuUsage();
				let iterations = 0;
				do {
					run(v);
					iterations++;
				} while (performance.now() - start < 100);
				const cpu = process.cpuUsage(cpuStart);
				v.wall.push((performance.now() - start) / (iterations * frames.length));
				v.cpu.push((cpu.user + cpu.system) / (1000 * iterations * frames.length));
			}
		}
		for (const v of variants) {
			const median = (values: number[]) => [...values].sort((a, b) => a - b)[3];
			results.push({
				variant: v.name,
				clipCount,
				operation,
				medianWallMs: median(v.wall),
				medianCpuMs: median(v.cpu),
				wallSamplesMs: v.wall,
				cpuSamplesMs: v.cpu,
				checksum: v.checksum,
			});
		}
	}
}
console.log(
	JSON.stringify(
		{
			machine: {
				cpu: cpus()[0]?.model,
				cores: cpus().length,
				memoryBytes: totalmem(),
				node: process.version,
			},
			loadAtStart,
			loadAtEnd: loadavg(),
			baselineModule: process.argv[2] ?? null,
			results,
		},
		null,
		2,
	),
);
