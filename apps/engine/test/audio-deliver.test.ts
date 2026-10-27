// The delivery of a normalised mix (apps/engine/src/audio/deliver.ts; wp-note sound-design "Fix: lossy-codec true-peak
// headroom and loudness convergence"): the codec headroom table, the click-free local corrections, the loudness
// convergence under the ceiling (a loud mix the one-pass delivery left ≈ 0.7 LU under), the "physically impossible"
// report and reuse of solved deliveries.
// The exported AAC/Opus file matrix in export-lossy-true-peak.test.ts owns decoded-codec delivery accuracy.
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { limitBuffer, measureLoudness } from '@jasper/audio-dsp';
import { describe, expect, it } from 'vitest';
import { codecHeadroomDb, solveDelivery } from '../src/audio/deliver.ts';
import { WAV_F32_HEADER_BYTES, writeDeliveryWav } from '../src/audio/mixdown.ts';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';
import { TEST_FFMPEG, TEST_FFPROBE } from './fixtures.ts';
import { loudMix } from './loud-fixture.ts';
import { tempAppdir } from './temp.ts';

const SR = 48_000;
const ff = new Ffmpeg({ ffmpeg: TEST_FFMPEG, ffprobe: TEST_FFPROBE });
const dir = tempAppdir('jasper-deliver-');

/** A raw interleaved float32 pass-1 file (as Sound Check writes it). */
function pass1Of(name: string, planar: Float32Array[]): { path: string; headerBytes: number } {
	const n = planar[0]!.length;
	const buf = Buffer.alloc(n * planar.length * 4);
	for (let i = 0; i < n; i++)
		for (let c = 0; c < planar.length; c++) buf.writeFloatLE(planar[c]![i]!, (i * planar.length + c) * 4);
	const path = join(dir, name);
	writeFileSync(path, buf);
	return { path, headerBytes: 0 };
}

async function readWav(path: string, channels: number): Promise<Float32Array[]> {
	const b = await readFile(path);
	const n = (b.length - WAV_F32_HEADER_BYTES) / 4 / channels;
	const out = Array.from({ length: channels }, () => new Float32Array(n));
	for (let i = 0; i < n; i++)
		for (let c = 0; c < channels; c++)
			out[c]![i] = b.readFloatLE(WAV_F32_HEADER_BYTES + (i * channels + c) * 4);
	return out;
}

describe('codec headroom (the documented table)', () => {
	it('is 0 for PCM and grows as the bit rate falls; 5.1 is judged per channel pair', () => {
		expect(codecHeadroomDb({ codec: 'pcm_s24le', bitrateKbps: 1536, channels: 2 })).toBe(0);
		expect(codecHeadroomDb({ codec: 'aac', bitrateKbps: 320, channels: 2 })).toBe(0.5);
		expect(codecHeadroomDb({ codec: 'aac', bitrateKbps: 256, channels: 2 })).toBe(0.5);
		expect(codecHeadroomDb({ codec: 'aac', bitrateKbps: 192, channels: 2 })).toBe(1);
		expect(codecHeadroomDb({ codec: 'aac', bitrateKbps: 128, channels: 2 })).toBe(1.5);
		expect(codecHeadroomDb({ codec: 'aac', bitrateKbps: 64, channels: 2 })).toBe(2);
		expect(codecHeadroomDb({ codec: 'libopus', bitrateKbps: 160, channels: 2 })).toBe(0.5);
		expect(codecHeadroomDb({ codec: 'libopus', bitrateKbps: 96, channels: 2 })).toBe(1);
		expect(codecHeadroomDb({ codec: 'libopus', bitrateKbps: 64, channels: 2 })).toBe(2);
		// 384 kb/s over six channels = 128 per pair
		expect(codecHeadroomDb({ codec: 'aac', bitrateKbps: 384, channels: 6 })).toBe(1.5);
	});
});

describe('local corrections', () => {
	it('attenuates the corrected audio locally with click-free ramps', async () => {
		const input = [new Float32Array(SR / 2).fill(0.5)];
		const correction = new Float32Array(50);
		correction[20] = 3;
		const out = join(dir, 'corrected.wav');
		await writeDeliveryWav(pass1Of('correction.f32', input), out, SR, 1, SR / 2, {
			gainDb: 0,
			ceilingDb: -1,
			correction,
		});
		const [audio] = await readWav(out, 1);
		expect(audio![0]).toBe(0.5);
		expect(audio![Math.round(0.205 * SR)]).toBeCloseTo(0.353973, 6);
		expect(audio![Math.round(0.4 * SR)]).toBe(0.5);
		let step = 0;
		for (let i = 1; i < audio!.length; i++) step = Math.max(step, Math.abs(audio![i]! - audio![i - 1]!));
		expect(step).toBeLessThan(0.001);
	});
});

describe('loudness convergence under the true-peak ceiling', () => {
	it('lands a loud mix within 0.1 LU of the target where one pass fell ≈ 0.7 LU short; the ceiling holds', async () => {
		const mix = loudMix(12, SR);
		const before = measureLoudness(mix, SR);
		const p1 = pass1Of('loud.f32', mix);
		// the one-pass delivery (before this fix): gain = target − measured, then the limiter
		const g = 10 ** ((-14 - before.integrated) / 20);
		const onePass = measureLoudness(
			limitBuffer(
				mix.map((c) => c.map((v) => v * g)),
				SR,
				{ ceilingDb: -1, lookaheadMs: 5, releaseMs: 100 },
			),
			SR,
		);
		expect(onePass.integrated).toBeLessThan(-14.3);
		const out = join(dir, 'loud.wav');
		const r = await solveDelivery({
			ff,
			pass1: p1,
			sampleRate: SR,
			channels: 2,
			total: mix[0]!.length,
			before,
			targetLufs: -14,
			truePeakDb: -1,
			codec: null,
			soxr: false,
			scratchDir: dir,
			outPath: out,
			write: (params, path = out) => writeDeliveryWav(p1, path, SR, 2, mix[0]!.length, params),
		});
		console.log(
			'convergence',
			JSON.stringify({
				onePass: onePass.integrated,
				after: r.pcm.integrated,
				passes: r.passes,
				gainDb: r.params.gainDb,
				initial: r.initialGainDb,
			}),
		);
		expect(r.written).toBe(true);
		expect(r.passes).toBeGreaterThan(1);
		expect(r.passes).toBeLessThanOrEqual(9);
		expect(r.ceilingLimited).toBe(false);
		expect(Math.abs(r.pcm.integrated + 14)).toBeLessThanOrEqual(0.1);
		expect(r.params.gainDb).toBeGreaterThan(r.initialGainDb);
		expect(r.params.ceilingDb).toBe(-1);
		// the file written is the converged pass
		const wav = await readWav(out, 2);
		const m = measureLoudness(wav, SR);
		expect(m.integrated).toBeCloseTo(r.pcm.integrated, 6);
		expect(m.truePeakDb).toBeLessThanOrEqual(-1 + 0.05);
	}, 300_000);

	it('says when the ceiling makes the target impossible (a steady tone pushed into the limiter)', async () => {
		const n = SR * 4;
		const tone = [0, 1].map(() =>
			Float32Array.from({ length: n }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 500 * i) / SR)),
		);
		const before = measureLoudness(tone, SR);
		const r = await solveDelivery({
			ff,
			pass1: pass1Of('tone.f32', tone),
			sampleRate: SR,
			channels: 2,
			total: n,
			before,
			targetLufs: -2,
			truePeakDb: -6,
			codec: null,
			soxr: false,
			scratchDir: dir,
		});
		expect(r.ceilingLimited).toBe(true);
		expect(r.pcm.integrated).toBeLessThan(-2.5);
		expect(r.pcm.truePeakDb).toBeLessThanOrEqual(-6 + 0.05);
		expect(r.passes).toBeLessThanOrEqual(8);
	}, 120_000);
});

describe('delivery speed (wp-note "Fix: preview loudness parity, codec-aware Sound Check, delivery speed")', () => {
	it('the limiter is scale-invariant: gain g at ceiling c is c × gain g − c at 0 dBFS (the alternatives’ gain prediction)', () => {
		const mix = loudMix(2, SR);
		const at = (gainDb: number, ceilingDb: number) =>
			limitBuffer(
				mix.map((c) => Float32Array.from(c, (v) => v * 10 ** (gainDb / 20))),
				SR,
				{ ceilingDb, lookaheadMs: 5, releaseMs: 100 },
			);
		const a = at(6, -1.5);
		const b = at(7.5, 0).map((c) => Float32Array.from(c, (v) => v * 10 ** (-1.5 / 20)));
		let worst = 0;
		for (let ch = 0; ch < 2; ch++)
			for (let i = 0; i < a[0]!.length; i++) worst = Math.max(worst, Math.abs(a[ch]![i]! - b[ch]![i]!));
		expect(worst).toBeLessThan(1e-6);
	});

	it('a second delivery of the same mix starts from the first (one pass, one encode, the same result); the decoded result is unchanged', async () => {
		const mix = loudMix(6, SR);
		const before = measureLoudness(mix, SR);
		const p1 = pass1Of('cache.f32', mix);
		const out = join(dir, 'cache.wav');
		const solve = (targetLufs = -14) =>
			solveDelivery({
				ff,
				pass1: p1,
				sampleRate: SR,
				channels: 2,
				total: mix[0]!.length,
				before,
				targetLufs,
				truePeakDb: -1,
				codec: { codec: 'aac', bitrateKbps: 192, sampleRate: SR, channels: 2 },
				soxr: false,
				scratchDir: dir,
				outPath: out,
				write: (params, path = out) => writeDeliveryWav(p1, path, SR, 2, mix[0]!.length, params),
				contentHash: 'test-content-hash',
			});
		const first = await solve();
		expect(first.cached).toBe(false);
		expect(first.truePeakMet).toBe(true);
		const second = await solve();
		expect(second.cached).toBe(true);
		expect(second.passes).toBe(1);
		expect(second.encodePasses).toBe(1);
		expect(second.params.gainDb).toBe(first.params.gainDb);
		expect(second.params.ceilingDb).toBe(first.params.ceilingDb);
		// the encoder is deterministic: the same delivery decodes the same
		expect(second.decoded!.truePeakDb).toBe(first.decoded!.truePeakDb);
		expect(second.decoded!.integrated).toBe(first.decoded!.integrated);
		// A new target must not reuse the gain solved for the old one.
		const changed = await solve(-16);
		expect(changed.cached).toBe(false);
		expect(Math.abs(changed.decoded!.integrated + 16)).toBeLessThanOrEqual(0.5);
	}, 600_000);

	it('an encode failure rejects delivery without an unhandled rejection', async () => {
		const mix = loudMix(4, SR);
		const before = measureLoudness(mix, SR);
		const p1 = pass1Of('fail.f32', mix);
		const out = join(dir, 'fail.wav');
		const flaky = Object.create(ff) as Ffmpeg;
		flaky.run = async (args, opts) => {
			const codec = args.indexOf('-c:a');
			if (codec >= 0 && args[codec + 1] === 'aac') throw new Error('encoder exploded');
			return ff.run(args, opts);
		};
		const r = solveDelivery({
			ff: flaky,
			pass1: p1,
			sampleRate: SR,
			channels: 2,
			total: mix[0]!.length,
			before,
			targetLufs: -14,
			truePeakDb: -1,
			codec: { codec: 'aac', bitrateKbps: 128, sampleRate: SR, channels: 2 },
			soxr: false,
			scratchDir: dir,
			outPath: out,
			write: (params, path = out) => writeDeliveryWav(p1, path, SR, 2, mix[0]!.length, params),
			parallel: 2,
		});
		await expect(r).rejects.toThrow('encoder exploded');
	}, 300_000);
});
