// Reused-plan control: isolate module/JIT state and allocation order in fresh processes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Fft } from '../src/fft.ts';

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
type Reading = {
	wallMs: number;
	cpuMs: number;
	wallSamplesMs: number[];
	cpuSamplesMs: number[];
	hash: string;
};

if (process.argv[2] === '--worker') {
	const { Fft: Plan } = (await import(pathToFileURL(process.argv[3]!).href)) as { Fft: typeof Fft };
	const n = 1 << 20;
	const inputRe = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.13) * 0.25);
	const inputIm = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.17) * 0.5);
	const re = inputRe.slice();
	const im = inputIm.slice();
	const plan = new Plan(n);
	const run = () => {
		re.set(inputRe);
		im.set(inputIm);
		plan.forward(re, im);
	};
	for (let i = 0; i < 30; i++) run();
	const wallSamplesMs: number[] = [];
	const cpuSamplesMs: number[] = [];
	for (let i = 0; i < 15; i++) {
		const usage = process.cpuUsage();
		const start = performance.now();
		run();
		wallSamplesMs.push(performance.now() - start);
		const used = process.cpuUsage(usage);
		cpuSamplesMs.push((used.user + used.system) / 1000);
	}
	const hash = createHash('sha256')
		.update(new Uint8Array(re.buffer))
		.update(new Uint8Array(im.buffer))
		.digest('hex');
	console.log(
		JSON.stringify({
			wallMs: median(wallSamplesMs),
			cpuMs: median(cpuSamplesMs),
			wallSamplesMs,
			cpuSamplesMs,
			hash,
		}),
	);
} else {
	const ref = process.argv[2];
	if (!ref)
		throw new Error('Usage: pnpm exec tsx packages/audio-dsp/bench/fft-reused.ts <baseline-revision>');
	const dir = mkdtempSync(join(tmpdir(), 'jasper-fft-reused-'));
	const before = execFileSync('git', ['show', `${ref}:packages/audio-dsp/src/fft.ts`], { encoding: 'utf8' });
	const after = readFileSync(new URL('../src/fft.ts', import.meta.url), 'utf8');
	const loadStart = loadavg();
	const readings = { before: [] as Reading[], after: [] as Reading[] };
	try {
		writeFileSync(join(dir, 'before.mts'), before);
		writeFileSync(join(dir, 'after.mts'), after);
		for (let round = 0; round < 3; round++) {
			for (const side of round % 2 ? (['after', 'before'] as const) : (['before', 'after'] as const)) {
				const raw = execFileSync(
					process.execPath,
					[...process.execArgv, fileURLToPath(import.meta.url), '--worker', join(dir, `${side}.mts`)],
					{ encoding: 'utf8' },
				);
				const reading = JSON.parse(raw) as Reading;
				readings[side].push(reading);
				console.log(JSON.stringify({ side, ...reading }));
			}
		}
		for (const reading of [...readings.before, ...readings.after])
			assert.equal(reading.hash, readings.before[0]!.hash);
		console.log(
			JSON.stringify({
				baseline: ref,
				node: process.version,
				cpu: cpus()[0]?.model,
				cores: cpus().length,
				loadStart,
				loadEnd: loadavg(),
				beforeWallMs: median(readings.before.map((r) => r.wallMs)),
				afterWallMs: median(readings.after.map((r) => r.wallMs)),
				beforeCpuMs: median(readings.before.map((r) => r.cpuMs)),
				afterCpuMs: median(readings.after.map((r) => r.cpuMs)),
				exactSamples: true,
			}),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
