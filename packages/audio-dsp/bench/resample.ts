// Compare the current resampler with the actual source at a supplied git revision.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ResampleQuality, resample } from '../src/resample.ts';

const ref = process.argv[2];
if (!ref) throw new Error('Usage: pnpm exec tsx packages/audio-dsp/bench/resample.ts <baseline-revision>');
const baselineSource = execFileSync('git', ['show', `${ref}:packages/audio-dsp/src/resample.ts`], {
	encoding: 'utf8',
});
const dir = mkdtempSync(join(tmpdir(), 'jasper-resample-bench-'));
const sourcePath = join(dir, 'baseline.mts');
writeFileSync(
	sourcePath,
	baselineSource.replace(
		"'./oversample.ts'",
		JSON.stringify(new URL('../src/oversample.ts', import.meta.url).href),
	),
);

type Scenario = { name: string; from: number; to: number; quality: ResampleQuality; length: number };
const scenarios: Scenario[] = [
	{ name: 'scrub 44.1→48k fast / 256 samples', from: 44100, to: 48000, quality: 'fast', length: 256 },
	{ name: 'scrub 48→44.1k fast / 4096 samples', from: 48000, to: 44100, quality: 'fast', length: 4096 },
	{ name: 'speed 1.001× fast / 256 samples', from: 48048, to: 48000, quality: 'fast', length: 256 },
	{ name: 'dense speed fast / 256 samples', from: 48000.5, to: 48000, quality: 'fast', length: 256 },
	{ name: 'one second 44.1→48k high', from: 44100, to: 48000, quality: 'high', length: 44100 },
];
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
let checksum = 0;
try {
	const before: typeof resample = (await import(pathToFileURL(sourcePath).href)).resample;
	console.log(
		JSON.stringify({
			baseline: ref,
			node: process.version,
			platform: platform(),
			arch: arch(),
			cpu: cpus()[0]?.model,
			cores: cpus().length,
			load: loadavg(),
		}),
	);
	for (const s of scenarios) {
		const input = Array.from({ length: 2 }, (_, c) =>
			Float32Array.from({ length: s.length }, (_, i) => Math.sin(i * 0.17 + c) * 0.5),
		);
		const args = [input, s.from, s.to, s.quality] as const;
		const a = before(...args);
		const b = resample(...args);
		for (let c = 0; c < a.length; c++) {
			const x = new Uint8Array(a[c]!.buffer);
			const y = new Uint8Array(b[c]!.buffer);
			if (x.length !== y.length || x.some((v, i) => v !== y[i])) throw new Error(`${s.name}: samples differ`);
		}
		// Alternate order per round on the same input to reduce shared-host drift.
		const times = { before: [] as number[], after: [] as number[] };
		for (let round = 0; round < 11; round++) {
			for (const which of round % 2 ? (['after', 'before'] as const) : (['before', 'after'] as const)) {
				const start = performance.now();
				const out = (which === 'before' ? before : resample)(...args);
				times[which].push(performance.now() - start);
				checksum += out[0]![Math.floor(out[0]!.length / 2)]!;
			}
		}
		const oldMs = median(times.before);
		const newMs = median(times.after);
		// Separate fresh module instances exercise cache misses, excluding module loading from the timer.
		const cold = { before: [] as number[], after: [] as number[] };
		for (let round = 0; round < 5; round++) {
			const suffix = `?cold=${scenarios.indexOf(s)}-${round}`;
			const fns = {
				before: (await import(pathToFileURL(sourcePath).href + suffix)).resample as typeof resample,
				after: (await import(new URL('../src/resample.ts', import.meta.url).href + suffix))
					.resample as typeof resample,
			};
			for (const which of round % 2 ? (['after', 'before'] as const) : (['before', 'after'] as const)) {
				const start = performance.now();
				const out = fns[which](...args);
				cold[which].push(performance.now() - start);
				checksum += out[0]![Math.floor(out[0]!.length / 2)]!;
			}
		}
		console.log(
			JSON.stringify({
				scenario: s.name,
				beforeMedianMs: oldMs,
				afterMedianMs: newMs,
				speedup: oldMs / newMs,
				beforeMs: times.before,
				afterMs: times.after,
				coldBeforeMedianMs: median(cold.before),
				coldAfterMedianMs: median(cold.after),
				coldBeforeMs: cold.before,
				coldAfterMs: cold.after,
				exactSamples: true,
			}),
		);
	}
	console.log(JSON.stringify({ checksum, loadEnd: loadavg() }));
} finally {
	rmSync(dir, { recursive: true, force: true });
}
