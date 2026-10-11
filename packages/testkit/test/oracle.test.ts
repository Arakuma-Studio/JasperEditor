import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	compareTables,
	compareVideos,
	decodeFrames,
	ffmpeg,
	findToolIn,
	measureLoudness,
	oraclesAvailable,
	parseEbur128,
	probeFrames,
	probePackets,
	requireTool,
	skipOracle,
} from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'testkit-oracle-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('tool discovery', () => {
	it('explicit path wins; a wrong explicit path is an error', () => {
		const f = join(dir, 'my-ffmpeg');
		writeFileSync(f, '');
		expect(findToolIn('ffmpeg', f, undefined, [])).toBe(f);
		expect(() => findToolIn('ffmpeg', join(dir, 'nope'), undefined, [])).toThrow(/JASPER_FFMPEG is set/);
	});

	it('PATH order, .exe names and the known-directory fallback', () => {
		const a = join(dir, 'a');
		const b = join(dir, 'b');
		mkdirSync(a);
		mkdirSync(b);
		writeFileSync(join(b, 'ffprobe.exe'), '');
		chmodSync(join(b, 'ffprobe.exe'), 0o755);
		expect(findToolIn('ffprobe', undefined, [a, b].join(':'), [], 'linux')).toBe(join(b, 'ffprobe.exe'));
		writeFileSync(join(a, 'ffprobe'), '');
		expect(findToolIn('ffprobe', undefined, [a, b].join(':'), [], 'linux')).toBe(join(a, 'ffprobe'));
		expect(findToolIn('ffprobe', undefined, '', [b], 'linux')).toBe(join(b, 'ffprobe.exe'));
		expect(findToolIn('nothing-here', undefined, '', [a], 'linux')).toBeNull();
	});

	it.skipIf(process.platform === 'win32')('skips cyclic symlinks before a usable PATH candidate', () => {
		const cyclic = join(dir, 'cyclic');
		const usable = join(dir, 'usable');
		mkdirSync(cyclic);
		mkdirSync(usable);
		symlinkSync('ffmpeg', join(cyclic, 'ffmpeg'));
		const executable = join(usable, 'ffmpeg');
		writeFileSync(executable, '');
		expect(findToolIn('ffmpeg', undefined, [cyclic, usable].join(':'), [], 'linux')).toBe(executable);
	});

	it('JASPER_REQUIRE_ORACLES=1 turns a skip into a failure', () => {
		const before = process.env.JASPER_REQUIRE_ORACLES;
		try {
			process.env.JASPER_REQUIRE_ORACLES = '1';
			expect(() => skipOracle('ctx', 'ffmpeg not found')).toThrow(/forbids skipping/);
			delete process.env.JASPER_REQUIRE_ORACLES;
			let skipped = '';
			skipOracle('ctx', 'ffmpeg not found', { skip: (n) => void (skipped = n ?? '') });
			expect(skipped).toBe('ffmpeg not found');
		} finally {
			if (before === undefined) delete process.env.JASPER_REQUIRE_ORACLES;
			else process.env.JASPER_REQUIRE_ORACLES = before;
		}
	});
});

describe('ebur128 log parsing', () => {
	it('reads the 100 ms frames and the summary', () => {
		const log = [
			'[Parsed_ebur128_0 @ 0x1] t: 0.4        TARGET:-23 LUFS    M: -20.1 S:-120.7     I: -20.1 LUFS       LRA:   0.0 LU  FTPK:  -20.0 dBFS  TPK:  -20.0 dBFS',
			'[Parsed_ebur128_0 @ 0x1] t: 0.5        TARGET:-23 LUFS    M: -inf S:-inf     I: -20.0 LUFS       LRA:   0.0 LU',
			'[Parsed_ebur128_0 @ 0x1] Summary:',
			'',
			'  Integrated loudness:',
			'    I:         -20.0 LUFS',
			'    Threshold: -30.0 LUFS',
			'',
			'  Loudness range:',
			'    LRA:         0.0 LU',
			'    Threshold:   0.0 LUFS',
			'',
			'  True peak:',
			'    Peak:      -19.9 dBFS',
		].join('\n');
		const l = parseEbur128(log);
		expect([l.integrated, l.threshold, l.lra, l.truePeak]).toEqual([-20, -30, 0, -19.9]);
		expect(l.frames).toHaveLength(2);
		expect(l.frames[0]).toEqual({ t: 0.4, momentary: -20.1, shortTerm: -120.7, integrated: -20.1, lra: 0 });
		expect(l.frames[1]!.momentary).toBe(Number.NEGATIVE_INFINITY);
	});
});

describe.runIf(oraclesAvailable('ffmpeg', 'ffprobe'))('ffmpeg oracles', () => {
	it('loudness of a 1 kHz stereo sine at −20 dBFS peak is −20.0 LUFS (EBU Tech 3341 style)', () => {
		const wav = join(dir, 'sine.wav');
		ffmpeg([
			'-f',
			'lavfi',
			'-i',
			'aevalsrc=0.1*sin(2*PI*1000*t)|0.1*sin(2*PI*1000*t):s=48000:d=5',
			'-c:a',
			'pcm_f32le',
			wav,
		]);
		const l = measureLoudness(wav);
		expect(Math.abs(l.integrated - -20)).toBeLessThanOrEqual(0.1);
		expect(Math.abs(l.truePeak! - -20)).toBeLessThanOrEqual(0.2);
		expect(l.frames.length).toBeGreaterThan(40);
	});

	it('PSNR/SSIM: identical files are ∞ / 1; a distorted copy scores lower', () => {
		const a = join(dir, 'a.mkv');
		const b = join(dir, 'b.mkv');
		ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10:d=1', '-c:v', 'ffv1', a]);
		ffmpeg(['-i', a, '-vf', 'noise=alls=20:allf=t', '-c:v', 'ffv1', b]);
		const same = compareVideos(a, a);
		expect(same.psnr).toBe(Number.POSITIVE_INFINITY);
		expect(same.ssim).toBeCloseTo(1, 6);
		expect(same.frames).toHaveLength(10);
		const noisy = compareVideos(a, b);
		expect(noisy.psnr).toBeLessThan(35);
		expect(noisy.ssim).toBeLessThan(0.99);
	});

	it('packet and frame tables, compared field by field; decoded frames', (ctx) => {
		if (!requireTool('ffprobe', 'oracle test', ctx)) return;
		const f = join(dir, 'p.mkv');
		ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=5:d=2', '-c:v', 'ffv1', '-g', '1', f]);
		const packets = probePackets(f, 'v:0');
		expect(packets).toHaveLength(10);
		expect(packets.every((p) => p.key && p.size > 0)).toBe(true);
		const frames = probeFrames(f, 'v:0');
		expect(frames).toHaveLength(10);
		expect(frames[0]).toMatchObject({ width: 64, height: 36, key: true });
		expect(compareTables(packets, packets, ['pts', 'size', 'key'])).toEqual([]);
		const shifted = packets.map((p, i) => (i === 3 ? { ...p, size: p.size + 1 } : p));
		expect(compareTables(packets, shifted, ['pts', 'size'])).toEqual([
			`#3.size: ${packets[3]!.size + 1}, expected ${packets[3]!.size}`,
		]);
		const rgba = decodeFrames(f, { frames: 2 });
		expect(rgba).toHaveLength(2);
		expect([rgba[0]!.width, rgba[0]!.height]).toEqual([64, 36]);
	});
});
