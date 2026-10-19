import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureLoudness } from '@jasper/audio-dsp';
import { it } from 'vitest';
import { solveDelivery } from '../src/audio/deliver.ts';
import { writeDeliveryWav } from '../src/audio/mixdown.ts';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';
import { TEST_FFMPEG, TEST_FFPROBE } from './helpers.ts';
import { loudMix, typicalMix } from './loud-fixture.ts';

const SR = 48_000;
const ff = new Ffmpeg({ ffmpeg: TEST_FFMPEG, ffprobe: TEST_FFPROBE });
const dir = mkdtempSync(join(tmpdir(), 'jasper-par-'));
for (const [fx, mk] of [['typical', typicalMix], ['loud', loudMix]] as const)
	it(`par ${fx}`, { timeout: 900_000 }, async () => {
		const src = mk(10);
		const n = src[0]!.length;
		const buf = Buffer.alloc(n * 8);
		for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) buf.writeFloatLE(src[c]![i]!, (i * 2 + c) * 4);
		const p1 = { path: join(dir, `p1-${fx}.f32`), headerBytes: 0 };
		writeFileSync(p1.path, buf);
		const before = measureLoudness(src, SR);
		for (const kbps of [256, 128])
			for (const parallel of [1, 3])
				for (let k = 0; k < 2; k++) {
					const wav = join(dir, `o-${fx}.wav`);
					const t = performance.now();
					const o = await solveDelivery({
						ff, pass1: p1, sampleRate: SR, channels: 2, total: n, before, targetLufs: -14, truePeakDb: -1,
						codec: { codec: 'aac', bitrateKbps: kbps, sampleRate: SR, channels: 2 }, soxr: false, scratchDir: dir,
						write: (p, path = wav) => writeDeliveryWav(p1, path, SR, 2, n, p), outPath: wav, parallel,
					});
					console.log(`par ${fx} aac${kbps} p${parallel}: ${(performance.now() - t).toFixed(0)} ms e${o.encodePasses} p${o.passes} ${JSON.stringify(o.timings, (_k, v) => (typeof v === 'number' ? Math.round(v) : v))} ceil ${o.params.ceilingDb}`);
				}
	});
