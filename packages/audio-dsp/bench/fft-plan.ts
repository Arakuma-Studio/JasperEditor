// Alternate the actual git baseline and current FFT on identical inputs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Fft, fft } from '../src/fft.ts';
import { findOffset } from '../src/sync.ts';

const ref = process.argv[2];
if (!ref) throw new Error('Usage: pnpm exec tsx packages/audio-dsp/bench/fft-plan.ts <baseline-revision>');
const dir = mkdtempSync(join(tmpdir(), 'jasper-fft-plan-'));
const source = (path: string) => execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8' });
writeFileSync(join(dir, 'fft.mts'), source('packages/audio-dsp/src/fft.ts'));
writeFileSync(
	join(dir, 'sync.mts'),
	source('packages/audio-dsp/src/sync.ts').replace("'./fft.ts'", "'./fft.mts'"),
);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
let checksum = 0;
let lastPlan: Fft | undefined;

function paired(name: string, before: () => void, after: () => void, rounds = 11): void {
	for (let i = 0; i < 10; i++) {
		before();
		after();
	}
	const times = { before: [] as number[], after: [] as number[] };
	for (let round = 0; round < rounds; round++) {
		for (const side of round % 2 ? (['after', 'before'] as const) : (['before', 'after'] as const)) {
			const start = performance.now();
			(side === 'before' ? before : after)();
			times[side].push(performance.now() - start);
		}
	}
	const beforeMedianMs = median(times.before);
	const afterMedianMs = median(times.after);
	console.log(
		JSON.stringify({
			name,
			beforeMedianMs,
			afterMedianMs,
			speedup: beforeMedianMs / afterMedianMs,
			beforeMs: times.before,
			afterMs: times.after,
		}),
	);
}

try {
	const old = (await import(pathToFileURL(join(dir, 'fft.mts')).href)) as {
		Fft: typeof Fft;
		fft: typeof fft;
	};
	const oldSync = (await import(pathToFileURL(join(dir, 'sync.mts')).href)) as {
		findOffset: typeof findOffset;
	};
	console.log(
		JSON.stringify({
			baseline: ref,
			node: process.version,
			cpu: cpus()[0]?.model,
			cores: cpus().length,
			loadStart: loadavg(),
			currentSourceBytes: readFileSync(new URL('../src/fft.ts', import.meta.url)).length,
		}),
	);
	for (const n of [2048, 1 << 18, 1 << 20]) {
		// A transform on a fresh plan also verifies its private index table without exposing it.
		const inputRe = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.13) * 0.25);
		const inputIm = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.17) * 0.5);
		const reA = inputRe.slice();
		const imA = inputIm.slice();
		const reB = inputRe.slice();
		const imB = inputIm.slice();
		const oldPlan = new old.Fft(n);
		const newPlan = new Fft(n);
		oldPlan.forward(reA, imA);
		newPlan.forward(reB, imB);
		assert.deepEqual(new Uint8Array(reA.buffer), new Uint8Array(reB.buffer));
		assert.deepEqual(new Uint8Array(imA.buffer), new Uint8Array(imB.buffer));
		oldPlan.inverse(reA, imA);
		newPlan.inverse(reB, imB);
		assert.deepEqual(new Uint8Array(reA.buffer), new Uint8Array(reB.buffer));
		assert.deepEqual(new Uint8Array(imA.buffer), new Uint8Array(imB.buffer));
		const reps = n === 2048 ? 100 : 1;
		paired(
			`construct ${n} points (${reps} plans)`,
			() => {
				for (let i = 0; i < reps; i++) {
					lastPlan = new old.Fft(n);
					checksum += lastPlan.n;
				}
			},
			() => {
				for (let i = 0; i < reps; i++) {
					lastPlan = new Fft(n);
					checksum += lastPlan.n;
				}
			},
		);
		if (n === 1 << 20) {
			paired(
				`reused plan fft ${n} points`,
				() => {
					reA.set(inputRe);
					imA.set(inputIm);
					oldPlan.forward(reA, imA);
					checksum += reA[0]!;
				},
				() => {
					reB.set(inputRe);
					imB.set(inputIm);
					newPlan.forward(reB, imB);
					checksum += reB[0]!;
				},
			);
			// >2^18 is deliberately uncached by fft(): include setup and one real transform.
			paired(
				`uncached fft ${n} points`,
				() => {
					reA.set(inputRe);
					imA.set(inputIm);
					old.fft(reA, imA);
					checksum += reA[0]!;
				},
				() => {
					reB.set(inputRe);
					imB.set(inputIm);
					fft(reB, imB);
					checksum += reB[0]!;
				},
			);
			assert.deepEqual(new Uint8Array(reA.buffer), new Uint8Array(reB.buffer));
			assert.deepEqual(new Uint8Array(imA.buffer), new Uint8Array(imB.buffer));
		}
	}
	// Thirty seconds at the coarse 8 kHz rate makes a 2^19-point sync FFT.
	const a = Float32Array.from(
		{ length: 240_000 },
		(_, i) => Math.sin(i * 0.123 + Math.sin(i * 0.0003)) * Math.sin(i * 0.0037),
	);
	const b = a.slice(1234, 231_234);
	const expected = oldSync.findOffset(a, b, 8000);
	assert.deepEqual(findOffset(a, b, 8000), expected);
	paired(
		'findOffset 30-second 8 kHz pair',
		() => {
			checksum += oldSync.findOffset(a, b, 8000)!.lag;
		},
		() => {
			checksum += findOffset(a, b, 8000)!.lag;
		},
	);
	console.log(
		JSON.stringify({
			checksum,
			lastPlanSize: lastPlan?.n,
			exactSamples: true,
			exactSync: true,
			loadEnd: loadavg(),
		}),
	);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
