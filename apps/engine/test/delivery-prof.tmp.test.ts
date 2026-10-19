import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultChannelWeights, LoudnessMeter, measureLoudness } from '@jasper/audio-dsp';
import { it } from 'vitest';
import { measureEncodedAudio, runDeliveryPass, solveDelivery, verifyEncodeArgs } from '../src/audio/deliver.ts';
import { writeDeliveryWav } from '../src/audio/mixdown.ts';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';
import { TEST_FFMPEG, TEST_FFPROBE } from './helpers.ts';
import { loudMix, typicalMix } from './loud-fixture.ts';

const SR = 48_000;
const ff = new Ffmpeg({ ffmpeg: TEST_FFMPEG, ffprobe: TEST_FFPROBE });
const dir = mkdtempSync(join(tmpdir(), 'jasper-prof-'));

for (const [fx, mk] of [['loud', loudMix], ['typical', typicalMix]] as const)
it(`profile ${fx}`, { timeout: 600_000 }, async () => {
	const src = mk(10);
	const n = src[0]!.length;
	const buf = Buffer.alloc(n * 2 * 4);
	for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) buf.writeFloatLE(src[c]![i]!, (i * 2 + c) * 4);
	const p1 = { path: join(dir, `p1-${fx}.f32`), headerBytes: 0 };
	writeFileSync(p1.path, buf);
	const before = measureLoudness(src, SR);
	const params = { gainDb: -14 - before.integrated, ceilingDb: -1.5, correction: null };
	const T = async (name: string, f: () => Promise<unknown>) => {
		const t = performance.now();
		await f();
		console.log(`prof ${fx} ${name}: ${(performance.now() - t).toFixed(0)} ms`);
	};
	await T('measure pass', async () => {
		const meter = new LoudnessMeter(SR, 2, { weights: defaultChannelWeights(2) });
		await runDeliveryPass({
			pass1: p1,
			sampleRate: SR,
			channels: 2,
			total: n,
			params,
			sink: (v, m) => meter.process(v, 0, m),
		});
	});
	await T('measure pass (no meter)', async () => {
		await runDeliveryPass({ pass1: p1, sampleRate: SR, channels: 2, total: n, params, sink: () => {} });
	});
	const wav = join(dir, 'out.wav');
	await T('write wav', () => writeDeliveryWav(p1, wav, SR, 2, n, params));
	const codec = { codec: 'aac', bitrateKbps: 256, sampleRate: SR, channels: 2 };
	const enc = join(dir, 'v.m4a');
	for (let k = 0; k < 3; k++)
		await T('encode aac 256', () =>
			ff.run(['-y', ...verifyEncodeArgs({ input: wav, output: enc, codec, mixRate: SR, soxr: false })]),
		);
	await T('encode aac 256 plain', () => ff.run(['-y', '-i', wav, '-c:a', 'aac', '-b:a', '256k', `${enc}.m4a`]));
	await T('encode aac 256 fast', () =>
		ff.run(['-y', '-i', wav, '-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '256k', `${enc}.2.m4a`]),
	);
	await T('encode opus 160', () => ff.run(['-y', '-i', wav, '-c:a', 'libopus', '-b:a', '160k', `${enc}.webm`]));
	await T('decode+meter', () => measureEncodedAudio({ ff, file: enc, channels: 2, sampleRate: SR }));
	console.log(`prof ${fx} before I ${before.integrated.toFixed(2)} TP ${before.truePeakDb.toFixed(2)}`);
	for (const c of [codec, { ...codec, bitrateKbps: 128 }, { ...codec, codec: 'libopus', bitrateKbps: 160 }, null]) {
		const t = performance.now();
		const o = await solveDelivery({
			ff,
			pass1: p1,
			sampleRate: SR,
			channels: 2,
			total: n,
			before,
			targetLufs: -14,
			truePeakDb: -1,
			codec: c,
			soxr: false,
			scratchDir: dir,
			write: (p, path = wav) => writeDeliveryWav(p1, path, SR, 2, n, p),
			outPath: wav,
		});
		console.log(
			`prof ${fx} solve ${c?.codec ?? 'pcm'} ${c?.bitrateKbps ?? ''}: ${(performance.now() - t).toFixed(0)} ms, passes ${o.passes}, encodes ${o.encodePasses}, decoded ${o.decoded?.integrated.toFixed(2)} / ${o.decoded?.truePeakDb.toFixed(2)}`,
		);
	}
});
