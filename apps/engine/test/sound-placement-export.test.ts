// P2-R4 (spec 12 §2.3): sounds placed with `soundDesign.place` land with their peak on the cue frame to the sample in
// the EXPORTED audio, at every sequence rate. Each sound is a single-sample click that starts right away (its head is
// not quiet), padded with lead silence by the engine's own register code (`writePaddedSound`, the copy a library sound
// gets), with sample-exact descriptors; the export (native path, 24-bit PCM in MOV) is decoded with ffmpeg and each
// click is found by its largest sample.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LibraryProvenance, libraryLeadSilenceSamples } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePaddedSound } from '../src/sounds/pad.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, TEST_FFMPEG, type TestApp } from './helpers.ts';

const SR = 48_000;
/** Click positions in the unpadded sounds (samples): heads of < 50 ms, so registering pads them. */
const CLICKS = [37, 611, 1203, 1999];
const LENGTH = SR / 2;

let app: TestApp;
let dir: string;
/** Padded files and their click sample (lead included). */
const sounds: { path: string; peak: number; samples: number }[] = [];

/** 16-bit stereo WAV: silence with one click (0.9) at `at`. */
function clickWav(path: string, at: number): void {
	const data = Buffer.alloc(LENGTH * 4);
	data.writeInt16LE(29_491, at * 4);
	data.writeInt16LE(29_491, at * 4 + 2);
	const h = Buffer.alloc(44);
	h.write('RIFF', 0, 'ascii');
	h.writeUInt32LE(36 + data.length, 4);
	h.write('WAVEfmt ', 8, 'ascii');
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(2, 22);
	h.writeUInt32LE(SR, 24);
	h.writeUInt32LE(SR * 4, 28);
	h.writeUInt16LE(4, 32);
	h.writeUInt16LE(16, 34);
	h.write('data', 36, 'ascii');
	h.writeUInt32LE(data.length, 40);
	writeFileSync(path, Buffer.concat([h, data]));
}

beforeAll(async () => {
	app = await makeApp();
	dir = mkdtempSync(join(tmpdir(), 'jasper-sfx-place-'));
	const ff = coreServices(app).ffmpeg;
	for (const [i, at] of CLICKS.entries()) {
		const src = join(dir, `click-${i}.wav`);
		clickWav(src, at);
		const lead = libraryLeadSilenceSamples({ headQuietSec: at / SR, durationSec: LENGTH / SR }, SR);
		expect(lead).toBe(2400);
		const path = await writePaddedSound(ff, { path: src, samples: lead, codec: 'pcm_s16le', tmpDir: dir });
		sounds.push({ path, peak: lead + at, samples: lead + LENGTH });
	}
}, 120_000);
afterAll(closeApps);

const RATES: [string, { num: number; den: number }, boolean][] = [
	['23.976', { num: 24000, den: 1001 }, false],
	['25', { num: 25, den: 1 }, false],
	['29.97', { num: 30000, den: 1001 }, true],
	['30', { num: 30, den: 1 }, false],
	['50', { num: 50, den: 1 }, false],
	['59.94', { num: 60000, den: 1001 }, false],
	['60', { num: 60, den: 1 }, false],
];

function pcm(file: string): Float32Array {
	const r = spawnSync(TEST_FFMPEG, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], {
		maxBuffer: 256 * 1024 * 1024,
	});
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	const b = r.stdout;
	return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

describe('soundDesign.place on exported audio (P2-R4)', () => {
	it.each(RATES)('%s fps: every click peak lands on its cue frame with 0 samples of error', async (label, fps, df) => {
		const d = new DocBuilder(`hd-1080p-${label}`);
		if (df) d.tx([{ type: 'sequence.updateSettings', settings: { dropFrame: true } }]);
		expect(d.doc.sequences[d.seqId]!.settings.frameRate).toEqual(fps);
		const cues: { frame: number; peak: number }[] = [];
		for (const [i, s] of sounds.entries()) {
			const mediaId = d.addMedia(await register(app, s.path));
			const library: LibraryProvenance = {
				soundId: `snd_00000000000000c${i}`,
				title: `Click ${i}`,
				types: ['click'],
				source: { type: 'starter' },
				license: 'LicenseRef-JasperEditor',
				author: 'test',
				attribution: null,
				descriptors: {
					peakSec: s.peak / SR,
					onsetSec: s.peak / SR,
					headQuietSec: s.peak / SR,
					durationSec: s.samples / SR,
					octaveBandsDb: [-60, -60, -60, -60, -60, -60, -60],
					centroidHz: 10_000,
					maxMomentaryLufs: -40,
				},
				leadSilenceSec: 2400 / SR,
			};
			d.tx([{ type: 'media.setLibraryInfo', mediaId, library }]);
			// cues ≈ 0.7 s apart, on frames that are not whole seconds
			const frame = Math.round((0.6 + 0.7 * i) * (fps.num / fps.den)) + i;
			const r = d.tx([
				{
					type: 'soundCue.add',
					cues: [{ frame, kind: 'cut', weight: 'support', source: 'user', align: 'peak', ref: '$c' }],
				},
				{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId }] },
			]);
			const placed = (r.results[1] as { clips: { errorFlicks: number }[] }).clips[0]!;
			expect(placed.errorFlicks).toBe(0);
			cues.push({ frame, peak: s.peak });
		}
		const settings = {
			sequenceId: d.seqId,
			range: { type: 'entire' },
			container: 'mov',
			video: {
				codec: 'h264',
				width: 320,
				height: 180,
				frameRate: fps,
				scaling: 'fit',
				quality: { mode: 'crf', value: 35 },
				encoderSpeed: 'fast',
			},
			audio: { codec: 'pcm', sampleRate: SR, channels: 2 },
			engine: 'native',
		};
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
		});
		expect(start.statusCode, start.body).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error).toBeUndefined();
		const file = (await coreServices(app).exports.outputFile(start.json().id))!;
		const x = pcm(file);
		const errors: number[] = [];
		for (const c of cues) {
			// the cue frame's time in samples (no rate here puts it exactly on a half sample)
			const expected = Math.round((c.frame * fps.den * SR) / fps.num);
			let best = -1;
			let max = 0;
			for (let i = Math.max(0, expected - 4000); i < Math.min(x.length, expected + 4000); i++)
				if (Math.abs(x[i]!) > max) {
					max = Math.abs(x[i]!);
					best = i;
				}
			expect(max).toBeGreaterThan(0.5);
			errors.push(best - expected);
		}
		expect(errors, `${label} fps: measured − expected click sample per cue`).toEqual(cues.map(() => 0));
	}, 180_000);
});
