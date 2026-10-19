// The delivery of a normalised mix (apps/engine/src/audio/deliver.ts; wp-note sound-design "Fix: lossy-codec true-peak
// headroom and loudness convergence"): the codec headroom table, the click-free local corrections, the loudness
// convergence under the ceiling (a loud mix the one-pass delivery left ≈ 0.7 LU under), the "physically impossible"
// report, sample-exact one-pass output where nothing needs it, and the decoded check of a lossy encode.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limitBuffer, measureLoudness } from '@jasper/audio-dsp';
import { describe, expect, it } from 'vitest';
import {
	CODEC_HEADROOM_TABLE,
	codecHeadroomDb,
	correctionGains,
	DELIVERY_LIMITS,
	type DeliveryParams,
	measureEncodedAudio,
	solveDelivery,
} from '../src/audio/deliver.ts';
import { WAV_F32_HEADER_BYTES, writeDeliveryWav } from '../src/audio/mixdown.ts';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';
import { TEST_FFMPEG, TEST_FFPROBE } from './helpers.ts';
import { loudMix, quietMix } from './loud-fixture.ts';

const SR = 48_000;
const ff = new Ffmpeg({ ffmpeg: TEST_FFMPEG, ffprobe: TEST_FFPROBE });
const dir = mkdtempSync(join(tmpdir(), 'jasper-deliver-'));

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
		for (const fam of ['aac', 'libopus'] as const) {
			const rows = CODEC_HEADROOM_TABLE.filter((r) => r.codec === fam);
			expect(rows.at(-1)!.minKbps).toBe(0);
			for (let i = 1; i < rows.length; i++)
				expect(rows[i]!.headroomDb).toBeGreaterThan(rows[i - 1]!.headroomDb);
		}
	});
});

describe('local corrections', () => {
	it('hold the corrected hop fully down over ±3 hops and ramp in and out without a step', () => {
		const hops = 50;
		const c = new Float32Array(hops);
		c[20] = 3;
		const g = correctionGains(c, SR);
		const hop = SR * DELIVERY_LIMITS.hopSec;
		const down = 10 ** (-3 / 20);
		// the corrected hop and its hold (the outermost held hops carry the ramps): fully down
		for (let s = 17 * hop; s < 23 * hop; s++) expect(g(s)).toBeCloseTo(down, 6);
		expect(g(16 * hop + hop / 2)).toBeLessThan(1);
		expect(g(23 * hop + hop / 2)).toBeLessThan(1);
		// far away: untouched
		expect(g(0)).toBe(1);
		expect(g(40 * hop)).toBe(1);
		// no click: the largest per-sample change is one hop's ramp
		let step = 0;
		for (let s = 1; s < hops * hop; s++) step = Math.max(step, Math.abs(g(s) - g(s - 1)));
		expect(step).toBeLessThanOrEqual((1 - down) / hop + 1e-9);
		// no correction: unity
		const none = correctionGains(new Float32Array(hops), SR);
		for (let s = 0; s < hops * hop; s += 97) expect(none(s)).toBe(1);
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
		expect(r.passes).toBeLessThanOrEqual(DELIVERY_LIMITS.maxLoudnessPasses + 1);
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
		expect(r.passes).toBeLessThanOrEqual(DELIVERY_LIMITS.maxLoudnessPasses);
	}, 120_000);

	it('a mix that needs no limiting is delivered sample-exact as before (one pass: gain, limiter idle)', async () => {
		const mix = quietMix(6, SR);
		const before = measureLoudness(mix, SR);
		const p1 = pass1Of('quiet.f32', mix);
		const out = join(dir, 'quiet.wav');
		const r = await solveDelivery({
			ff,
			pass1: p1,
			sampleRate: SR,
			channels: 2,
			total: mix[0]!.length,
			before,
			targetLufs: -16,
			truePeakDb: -1,
			codec: { codec: 'pcm_s24le', bitrateKbps: 1536, sampleRate: SR, channels: 2 },
			soxr: false,
			scratchDir: dir,
			outPath: out,
			write: (params, path = out) => writeDeliveryWav(p1, path, SR, 2, mix[0]!.length, params),
		});
		expect(r.passes).toBe(1);
		expect(r.encodePasses).toBe(0);
		expect(r.params.gainDb).toBe(r.initialGainDb);
		const g = 10 ** (r.initialGainDb / 20);
		const expected = limitBuffer(
			mix.map((c) => {
				const x = new Float32Array(c.length);
				for (let i = 0; i < c.length; i++) x[i] = c[i]! * g;
				return x;
			}),
			SR,
			{ ceilingDb: -1, lookaheadMs: 5, releaseMs: 100 },
		);
		const got = await readWav(out, 2);
		let maxDiff = 0;
		for (let c = 0; c < 2; c++)
			for (let i = 0; i < got[c]!.length; i++)
				maxDiff = Math.max(maxDiff, Math.abs(got[c]![i]! - expected[c]![i]!));
		expect(maxDiff).toBe(0);
	}, 120_000);
});

describe('the decoded check of a lossy encode', () => {
	for (const [codec, kbps] of [
		['aac', 128],
		['libopus', 96],
	] as const)
		it(`${codec} ${kbps} kb/s: the decoded audio meets −1 dBTP and lands within ±0.5 LU of −14 LUFS`, async () => {
			const mix = loudMix(12, SR);
			const before = measureLoudness(mix, SR);
			const p1 = pass1Of(`${codec}.f32`, mix);
			const out = join(dir, `${codec}.wav`);
			const params: DeliveryParams[] = [];
			const r = await solveDelivery({
				ff,
				pass1: p1,
				sampleRate: SR,
				channels: 2,
				total: mix[0]!.length,
				before,
				targetLufs: -14,
				truePeakDb: -1,
				codec: { codec, bitrateKbps: kbps, sampleRate: SR, channels: 2 },
				soxr: false,
				scratchDir: dir,
				outPath: out,
				write: (p, path = out) => {
					params.push(p);
					return writeDeliveryWav(p1, path, SR, 2, mix[0]!.length, p);
				},
			});
			console.log(
				'decoded',
				codec,
				kbps,
				JSON.stringify({
					ceiling: r.params.ceilingDb,
					headroom: r.codecHeadroomDb,
					decodedTp: r.decoded?.truePeakDb,
					decodedI: r.decoded?.integrated,
					pcmTp: r.pcm.truePeakDb,
					pcmI: r.pcm.integrated,
					passes: r.passes,
					encodes: r.encodePasses,
					corrections: r.corrections,
				}),
			);
			// the table's ceiling, or under it by the steps an encode with fresh offenders takes (DELIVERY_ALTERNATIVES)
			expect(r.params.ceilingDb).toBeLessThanOrEqual(-1 - codecHeadroomDb({ codec, bitrateKbps: kbps, channels: 2 }));
			expect(r.params.ceilingDb).toBeGreaterThanOrEqual(-1 - DELIVERY_LIMITS.maxCodecHeadroomDb);
			expect(r.encodePasses).toBeGreaterThanOrEqual(1);
			expect(r.decoded).not.toBeNull();
			expect(r.truePeakMet).toBe(true);
			expect(r.decoded!.truePeakDb).toBeLessThanOrEqual(-1 - DELIVERY_LIMITS.truePeakMarginDb);
			expect(Math.abs(r.decoded!.integrated + 14)).toBeLessThanOrEqual(0.5);
			// the written WAV is the last pass, the one the decoded numbers are of: encoding it again decodes the same
			expect(r.written).toBe(true);
			const enc = join(dir, `${codec}-again.${codec === 'aac' ? 'm4a' : 'webm'}`);
			await ff.run([
				'-y',
				'-i',
				out,
				'-af',
				'aformat=sample_fmts=fltp:channel_layouts=stereo',
				'-c:a',
				codec,
				'-b:a',
				`${kbps}k`,
				'-ar',
				'48000',
				'-ac',
				'2',
				enc,
			]);
			const again = await measureEncodedAudio({ ff, file: enc, channels: 2, sampleRate: SR });
			expect(again.loudness.truePeakDb).toBeCloseTo(r.decoded!.truePeakDb, 3);
			// the checked encode is kept for the mux (stream copy): it decodes to exactly the delivered numbers
			expect(r.encoded).not.toBeNull();
			const kept = await measureEncodedAudio({ ff, file: r.encoded!, channels: 2, sampleRate: SR });
			expect(kept.loudness.truePeakDb).toBe(r.decoded!.truePeakDb);
			expect(kept.loudness.integrated).toBe(r.decoded!.integrated);
		}, 600_000);
});
