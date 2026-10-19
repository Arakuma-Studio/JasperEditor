import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureLoudness } from '@jasper/audio-dsp';
import { it } from 'vitest';
import { measureEncodedAudio, verifyEncodeArgs } from '../src/audio/deliver.ts';
import { writeDeliveryWav } from '../src/audio/mixdown.ts';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';
import { TEST_FFMPEG, TEST_FFPROBE } from './helpers.ts';
import { loudMix } from './loud-fixture.ts';

const SR = 48_000;
const HOP = 480;
const ff = new Ffmpeg({ ffmpeg: TEST_FFMPEG, ffprobe: TEST_FFPROBE });
const dir = mkdtempSync(join(tmpdir(), 'jasper-seg-'));

it('segment vs full', { timeout: 600_000 }, async () => {
	const src = loudMix(10);
	const n = src[0]!.length;
	const buf = Buffer.alloc(n * 2 * 4);
	for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) buf.writeFloatLE(src[c]![i]!, (i * 2 + c) * 4);
	const p1 = { path: join(dir, 'p1.f32'), headerBytes: 0 };
	writeFileSync(p1.path, buf);
	const before = measureLoudness(src, SR);
	for (const [kbps, ceil] of [
		[256, -1.5],
		[128, -2.5],
	] as const) {
		const params = { gainDb: -14 - before.integrated + 0.8, ceilingDb: ceil, correction: null };
		const wav = join(dir, `out${kbps}.wav`);
		await writeDeliveryWav(p1, wav, SR, 2, n, params);
		const codec = { codec: 'aac', bitrateKbps: kbps, sampleRate: SR, channels: 2 };
		let t = performance.now();
		const enc = join(dir, `full${kbps}.m4a`);
		await ff.run(['-y', ...verifyEncodeArgs({ input: wav, output: enc, codec, mixRate: SR, soxr: false })]);
		const full = await measureEncodedAudio({ ff, file: enc, channels: 2, sampleRate: SR });
		console.log(`seg full ${kbps}: ${(performance.now() - t).toFixed(0)} ms I ${full.loudness.integrated.toFixed(2)} TP ${full.loudness.truePeakDb.toFixed(2)}`);
		for (const [K, preSec] of [
			[8, 0.5],
			[8, 1],
			[4, 1],
		] as const) {
			t = performance.now();
			const coreLen = Math.ceil(n / K / HOP) * HOP;
			const pre = Math.round(preSec * SR / HOP) * HOP;
			const post = 4 * HOP;
			const hops = new Float32Array(Math.ceil(n / HOP)).fill(Number.NEGATIVE_INFINITY);
			await Promise.all(
				Array.from({ length: K }, async (_, k) => {
					const a = k * coreLen;
					const b = Math.min(n, a + coreLen);
					const s = Math.max(0, a - pre);
					const e = Math.min(n, b + post);
					const out = join(dir, `seg${kbps}-${K}-${k}.m4a`);
					const args = verifyEncodeArgs({ input: wav, output: out, codec, mixRate: SR, soxr: false });
					const ai = args.indexOf('-af');
					args[ai + 1] = `atrim=start_sample=${s}:end_sample=${e},asetpts=PTS-STARTPTS,${args[ai + 1]}`;
					await ff.run(['-y', ...args]);
					const m = await measureEncodedAudio({ ff, file: out, channels: 2, sampleRate: SR });
					for (let j = 0; j < m.hopTruePeakDb.length; j++) {
						const h = s / HOP + j;
						if (h * HOP >= a && h * HOP < b) hops[h] = m.hopTruePeakDb[j]!;
					}
				}),
			);
			const ms = performance.now() - t;
			let maxDiff = 0;
			let offFull = 0;
			let offSeg = 0;
			let both = 0;
			let maxFull = -99;
			let maxSeg = -99;
			for (let h = 0; h < hops.length && h < full.hopTruePeakDb.length; h++) {
				const f = full.hopTruePeakDb[h]!;
				const g = hops[h]!;
				if (f > -4) maxDiff = Math.max(maxDiff, Math.abs(f - g));
				if (f > -1.1) offFull++;
				if (g > -1.1) offSeg++;
				if (f > -1.1 && g > -1.1) both++;
				maxFull = Math.max(maxFull, f);
				maxSeg = Math.max(maxSeg, g);
			}
			console.log(
				`seg K=${K} pre=${preSec} ${kbps}: ${ms.toFixed(0)} ms, max|diff| ${maxDiff.toFixed(2)} dB, offenders full ${offFull} seg ${offSeg} both ${both}, max full ${maxFull.toFixed(2)} seg ${maxSeg.toFixed(2)}`,
			);
		}
	}
});
