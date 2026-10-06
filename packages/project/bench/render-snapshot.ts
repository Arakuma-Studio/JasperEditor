// Run with: pnpm exec tsx packages/project/bench/render-snapshot.ts
// To compare a revision, extract its src/render/snapshot.ts as src/render/snapshot.baseline.ts,
// pass ../src/render/snapshot.baseline.ts as the first argument, then remove that temporary file.
// Fixture creation, hashing and validation are outside the timed snapshot builds.

import { deepStrictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildRenderSnapshot, type Clip, type SnapshotOptions } from '../src/index.ts';
import { Harness } from '../test/helpers.ts';

function fixture(tracksPerKind: number, clipsPerTrack: number) {
	const h = new Harness();
	const mediaId = h.registerVideo({ seconds: 10 });
	h.ok([{ type: 'clip.place', source: { mediaId }, at: 0 }]);
	const doc = structuredClone(h.doc);
	const seq = doc.sequences[h.seqId]!;
	const video = Object.values(seq.clips).find((c) => c.kind === 'video')!;
	const audio = Object.values(seq.clips).find((c) => c.kind === 'audio')!;
	seq.videoTracks = Array.from({ length: tracksPerKind }, (_, i) => ({
		...seq.videoTracks[0]!,
		id: `v-${i}`,
	}));
	seq.audioTracks = Array.from({ length: tracksPerKind }, (_, i) => ({
		...seq.audioTracks[0]!,
		id: `a-${i}`,
	}));
	seq.clips = {};
	seq.links = {};
	for (let i = clipsPerTrack - 1; i >= 0; i--) {
		for (const track of [...seq.videoTracks, ...seq.audioTracks]) {
			const id = `${track.id}-${i}`;
			seq.clips[id] = {
				...(track.kind === 'video' ? video : audio),
				id,
				trackId: track.id,
				start: i * 30,
				duration: 30,
				linkId: null,
			} as Clip;
		}
	}
	return { doc, sequenceId: seq.id };
}

// An optional baseline module allows alternating before/after samples in the same process.
const baseline: typeof buildRenderSnapshot | undefined = process.argv[2]
	? (await import(process.argv[2])).buildRenderSnapshot
	: undefined;
const results = [];
for (const [tracks, clips] of [
	[2, 10],
	[8, 100],
	[24, 100],
] as const) {
	const { doc, sequenceId } = fixture(tracks, clips);
	for (const narrowRange of [false, true]) {
		const opts: SnapshotOptions = {
			resolveMedia: () => null,
			resolveFont: () => null,
			...(narrowRange ? { range: { start: 60, end: 120 } } : {}),
		};
		const expectedSnapshot = buildRenderSnapshot(doc, sequenceId, opts);
		if (baseline) deepStrictEqual(expectedSnapshot, baseline(doc, sequenceId, opts));
		const expected = createHash('sha256').update(JSON.stringify(expectedSnapshot)).digest('hex');
		const variants = [
			...(baseline ? [{ name: 'baseline', build: baseline }] : []),
			{ name: 'current', build: buildRenderSnapshot },
		].map((variant) => ({
			...variant,
			wallSamples: [] as number[],
			cpuSamples: [] as number[],
			checksum: 0,
		}));
		for (const variant of variants) {
			const warmupUntil = performance.now() + 300;
			while (performance.now() < warmupUntil) variant.build(doc, sequenceId, opts);
		}
		for (let sample = 0; sample < 9; sample++) {
			for (const variant of sample % 2 ? [...variants].reverse() : variants) {
				const start = performance.now();
				const cpuStart = process.cpuUsage();
				let iterations = 0;
				do {
					variant.checksum += variant.build(doc, sequenceId, opts).audioClips.length;
					iterations++;
				} while (performance.now() - start < 200);
				const cpu = process.cpuUsage(cpuStart);
				variant.wallSamples.push((performance.now() - start) / iterations);
				variant.cpuSamples.push((cpu.user + cpu.system) / 1000 / iterations);
			}
		}
		for (const variant of variants) {
			variant.wallSamples.sort((a, b) => a - b);
			variant.cpuSamples.sort((a, b) => a - b);
			results.push({
				variant: variant.name,
				tracks: tracks * 2,
				clips: tracks * clips * 2,
				range: narrowRange ? '60-120' : 'full',
				medianMs: variant.wallSamples[4],
				medianCpuMs: variant.cpuSamples[4],
				minMs: variant.wallSamples[0],
				maxMs: variant.wallSamples[8],
				sha256: expected,
				checksum: variant.checksum,
			});
		}
	}
}
console.log(JSON.stringify({ node: process.version, results }, null, 2));
