import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureLoudness } from '@jasper/audio-dsp';
import { it } from 'vitest';
import { DELIVERY_CEILING_STEPS_DB as DELIVERY_ALTERNATIVES, DELIVERY_LIMITS, solveDelivery } from '../src/audio/deliver.ts';
import { writeDeliveryWav } from '../src/audio/mixdown.ts';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';
import { TEST_FFMPEG, TEST_FFPROBE } from './helpers.ts';
import { loudMix, typicalMix } from './loud-fixture.ts';

const SR = 48_000;
const ff = new Ffmpeg({ ffmpeg: TEST_FFMPEG, ffprobe: TEST_FFPROBE });
const dir = mkdtempSync(join(tmpdir(), 'jasper-var-'));
const VARIANTS: Record<string, Partial<Record<keyof typeof DELIVERY_LIMITS, number>>> = JSON.parse(
	process.env.VARIANTS ?? '{"base":{}}',
);
const CODECS: [string, number][] = JSON.parse(
	process.env.CODECS ?? '[["aac",128],["aac",192],["aac",256],["aac",320],["libopus",96],["libopus",160]]',
);

for (const [fx, mk] of [
	['loud', loudMix],
	['typical', typicalMix],
] as const)
	it(`variants ${fx}`, { timeout: 1_800_000 }, async () => {
		const src = mk(10);
		const n = src[0]!.length;
		const buf = Buffer.alloc(n * 2 * 4);
		for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) buf.writeFloatLE(src[c]![i]!, (i * 2 + c) * 4);
		const p1 = { path: join(dir, `p1-${fx}.f32`), headerBytes: 0 };
		writeFileSync(p1.path, buf);
		const before = measureLoudness(src, SR);
		const orig = { ...DELIVERY_LIMITS };
		const origAlts = [...DELIVERY_ALTERNATIVES];
		for (const [name, v0] of Object.entries(VARIANTS)) {
			const { alts, ...v } = v0 as Record<string, unknown>;
			Object.assign(DELIVERY_LIMITS, orig, v);
			(DELIVERY_ALTERNATIVES as unknown as unknown[]).splice(0, Infinity, ...((alts as unknown[]) ?? origAlts));
			let encs = 0;
			let ms = 0;
			const rows: string[] = [];
			for (const [codec, kbps] of CODECS) {
				const wav = join(dir, `o-${fx}.wav`);
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
					codec: { codec, bitrateKbps: kbps, sampleRate: SR, channels: 2 },
					soxr: false,
					scratchDir: dir,
					write: (p, path = wav) => writeDeliveryWav(p1, path, SR, 2, n, p),
					outPath: wav,
				});
				ms += performance.now() - t;
				encs += o.encodePasses;
				rows.push(
					`${codec}${kbps}:${o.encodePasses}e/${o.passes}p I${o.decoded?.integrated.toFixed(2)} TP${o.decoded?.truePeakDb.toFixed(2)} c${o.corrections.hops}/${o.corrections.maxDb.toFixed(1)} ceil${o.params.ceilingDb}${o.truePeakMet ? '' : ' MISS'}`,
				);
			}
			console.log(`var ${fx} ${name}: encodes ${encs}, ${(ms / 1000).toFixed(1)} s | ${rows.join(' | ')}`);
		}
		Object.assign(DELIVERY_LIMITS, orig);
	});
