// Run: pnpm exec tsx packages/project/bench/timeline-find.ts [baseline-module-relative-to-repo-root]
// Extract the original find/index.ts beside the current one to preserve its relative imports.
// Fixture creation and output comparison are outside the measured searches.
import { createHash } from 'node:crypto';
import { cpus, loadavg, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { type FindQuery, findTimelineHits, type TimelineFindField } from '../src/find/index.ts';
import type { Clip } from '../src/schema/sequence.ts';
import { Harness } from '../test/helpers.ts';

const baseline: typeof findTimelineHits | undefined = process.argv[2]
	? (await import(pathToFileURL(resolve(process.argv[2])).href)).findTimelineHits
	: undefined;

const loadAtStart = loadavg();
const results = [];
for (const [clipCount, mediaCount] of [
	[100, 100],
	[1_000, 1_000],
	[5_000, 2_000],
] as const) {
	const h = new Harness();
	const mediaId = h.registerVideo({ audio: false });
	h.ok([{ type: 'clip.place', source: { mediaId }, at: 0 }]);
	const doc = structuredClone(h.doc);
	const seq = doc.sequences[h.seqId]!;
	const video = Object.values(seq.clips)[0]!;
	const asset = doc.media[mediaId]!;
	const item = Object.values(doc.items).find((i) => i.kind === 'media')!;
	doc.media = {};
	doc.items = {};
	seq.clips = {};
	for (let i = 0; i < mediaCount; i++) {
		const id = `media-${i}`;
		doc.media[id] = { ...asset, id, originalName: `Original ${i}.mp4` };
		doc.items[`item-${i}`] = { ...item, id: `item-${i}`, mediaId: id, name: `Library ${i}` };
	}
	for (let i = 0; i < clipCount; i++) {
		const id = `clip-${i}`;
		seq.clips[id] = {
			...video,
			id,
			mediaId: `media-${i % mediaCount}`,
			name: `Timeline ${i}`,
			start: i * 30,
			duration: 30,
		} as Clip;
	}
	for (const field of ['sourceName', 'any', 'clipName'] as const) {
		const query: FindQuery<TimelineFindField> = {
			criteria: [{ field, operator: 'contains', value: field === 'clipName' ? 'Timeline' : 'Library' }],
		};
		const variants = [
			...(baseline ? [{ name: 'baseline', search: baseline }] : []),
			{ name: 'current', search: findTimelineHits },
		].map((v) => ({ ...v, wall: [] as number[], cpu: [] as number[], checksum: 0 }));
		const outputs = variants.map((v) => JSON.stringify(v.search(doc, seq.id, query)));
		if (outputs.some((output) => output !== outputs[0])) throw new Error('Search results differ');
		for (const v of variants) v.search(doc, seq.id, query);
		for (let sample = 0; sample < 7; sample++) {
			for (const v of sample % 2 ? [...variants].reverse() : variants) {
				const start = performance.now();
				const cpuStart = process.cpuUsage();
				let iterations = 0;
				do {
					v.checksum += v.search(doc, seq.id, query).length;
					iterations++;
				} while (performance.now() - start < 100);
				const cpu = process.cpuUsage(cpuStart);
				v.wall.push((performance.now() - start) / iterations);
				v.cpu.push((cpu.user + cpu.system) / (1000 * iterations));
			}
		}
		for (const [i, v] of variants.entries()) {
			const median = (values: number[]) => [...values].sort((a, b) => a - b)[3];
			results.push({
				variant: v.name,
				clipCount,
				mediaCount,
				field,
				medianWallMs: median(v.wall),
				medianCpuMs: median(v.cpu),
				wallSamplesMs: v.wall,
				cpuSamplesMs: v.cpu,
				sha256: createHash('sha256').update(outputs[i]!).digest('hex'),
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
