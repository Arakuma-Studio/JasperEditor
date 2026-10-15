// Oracle: `analyzeSound` against ffmpeg's `aspectralstats` (centroid, 85 % rolloff) and `ebur128` (integrated loudness,
// maximum momentary loudness, true peak).
//
// aspectralstats averages per-frame MAGNITUDE spectra; our descriptors use the frame-averaged POWER spectrum, so they
// are compared on signals where the two definitions agree: flat (white, band-limited white) and equal-amplitude line
// spectra (a sine, two equal sines). ffmpeg's first and last frames (a half-empty window) are skipped. Tolerance 3 %
// (measured: two equal tones read 1.9 % lower in ffmpeg, its magnitude weighting of the Hann main lobes).
// Loudness and true peak: ±0.1 LU (EBU Tech 3341), true peak ±0.2 dB.
//
// ffmpeg: $JASPER_FFMPEG, else <repo>/vendor/ffmpeg-lgpl/linux-x64/ffmpeg, else `ffmpeg` on PATH. Without one the
// suite is skipped, unless JASPER_REQUIRE_ORACLES=1, which makes a missing oracle a failure (as @jasper/testkit's
// oracles do).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav } from '@jasper/audio-dsp';
import { afterAll, describe, expect, it } from 'vitest';
import { Prng } from '../src/core/util.ts';
import { analyzeSound } from '../src/index.ts';
import { noise, SR, sine } from './util.ts';

type Ff = { bin: string; env: NodeJS.ProcessEnv };

function tryFfmpeg(bin: string, libDir?: string): Ff | null {
	const env = { ...process.env };
	if (libDir) env.LD_LIBRARY_PATH = libDir + (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : '');
	const r = spawnSync(bin, ['-hide_banner', '-filters'], { env, encoding: 'utf8', timeout: 20_000 });
	if (r.status !== 0 || !/\baspectralstats\b/.test(r.stdout) || !/\bebur128\b/.test(r.stdout)) return null;
	return { bin, env };
}

function findFfmpeg(): Ff | null {
	const fromEnv = process.env.JASPER_FFMPEG;
	if (fromEnv) return tryFfmpeg(fromEnv, dirname(fromEnv));
	const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
	const vendored = join(repo, 'vendor', 'ffmpeg-lgpl', 'linux-x64', 'ffmpeg');
	if (existsSync(vendored)) {
		const f = tryFfmpeg(vendored, dirname(vendored));
		if (f) return f;
	}
	return tryFfmpeg('ffmpeg');
}

const FF = findFfmpeg();
const REQUIRED = /^(1|true|yes)$/i.test(process.env.JASPER_REQUIRE_ORACLES ?? '');

if (!FF && REQUIRED)
	describe('sound descriptor oracle', () => {
		it('needs ffmpeg with aspectralstats and ebur128', () => {
			throw new Error('ffmpeg (with aspectralstats and ebur128) not found and JASPER_REQUIRE_ORACLES=1');
		});
	});

/** Run ffmpeg on a WAV with an audio filter whose metadata `ametadata` prints; returns the per-frame key/values. */
function metadataFrames(ff: Ff, wav: string, filter: string): Record<string, number>[] {
	const r = spawnSync(
		ff.bin,
		[
			'-hide_banner',
			'-nostats',
			'-i',
			wav,
			'-af',
			`${filter},ametadata=mode=print:file=-`,
			'-f',
			'null',
			'-',
		],
		{ env: ff.env, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 120_000 },
	);
	if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
	const frames: Record<string, number>[] = [];
	for (const line of r.stdout.split('\n')) {
		if (line.startsWith('frame:')) {
			frames.push({});
			continue;
		}
		const m = /^lavfi\.([\w.]+)=(.*)$/.exec(line.trim());
		if (!m || frames.length === 0) continue;
		const raw = m[2]!.trim();
		frames[frames.length - 1]![m[1]!] = /^-inf/i.test(raw)
			? Number.NEGATIVE_INFINITY
			: Number.parseFloat(raw);
	}
	return frames;
}

describe.skipIf(!FF)(
	'sound descriptor oracle: ffmpeg aspectralstats and ebur128',
	{ timeout: 300_000 },
	() => {
		const ff = FF as Ff;
		const dir = mkdtempSync(join(tmpdir(), 'jasper-sound-oracle-'));
		afterAll(() => rmSync(dir, { recursive: true, force: true }));
		const write = (name: string, chs: Float32Array[]): string => {
			const f = join(dir, `${name}.wav`);
			writeFileSync(f, encodeWav(chs, SR, 'f32'));
			return f;
		};
		const rows: string[] = [];
		afterAll(() => console.log(`\nsound descriptor oracle (ours / ffmpeg):\n${rows.join('\n')}\n`));

		const bandNoise = (seed: number, n: number, lo: number, hi: number): Float32Array => {
			// flat band: white noise through a brick-wall in the frequency domain, built from random-phase bins
			const r = new Prng(seed);
			const x = new Float32Array(n);
			const bins: [number, number, number][] = [];
			for (let f = lo; f <= hi; f += 4) bins.push([f, r.unit() * 2 * Math.PI, 1]);
			for (let i = 0; i < n; i++) {
				let s = 0;
				for (const [f, ph] of bins) s += Math.sin((2 * Math.PI * f * i) / SR + ph);
				x[i] = s;
			}
			let p = 0;
			for (const v of x) p = Math.max(p, Math.abs(v));
			for (let i = 0; i < n; i++) x[i] = (0.5 * x[i]!) / p;
			return x;
		};

		const twoTone = (n: number): Float32Array => {
			const a = sine(500, 0.3, SR, n);
			const b = sine(3000, 0.3, SR, n, 1);
			return a.map((v, i) => v + b[i]!);
		};

		const signals: Record<string, () => Float32Array> = {
			'white noise': () => noise(21, SR * 3, 0.5),
			'1 kHz sine': () => sine(1000, 0.5, SR, SR * 2),
			'500 Hz + 3 kHz, equal': () => twoTone(SR * 2),
			'flat band 1–4 kHz': () => bandNoise(22, SR, 1000, 4000),
		};

		it.each(Object.keys(signals))('centroid and rolloff of %s', (name) => {
			const x = signals[name]!();
			const wav = write(name.replace(/\W+/g, '_'), [x]);
			const frames = metadataFrames(
				ff,
				wav,
				'aspectralstats=win_size=2048:overlap=0.5:measure=centroid+rolloff',
			).slice(1, -1);
			expect(frames.length).toBeGreaterThan(10);
			const mean = (k: string) => frames.reduce((s, f) => s + f[k]!, 0) / frames.length;
			const ffC = mean('aspectralstats.1.centroid');
			const ffR = mean('aspectralstats.1.rolloff');
			const d = analyzeSound([x], SR);
			rows.push(
				`${name}: centroid ${d.centroidHz} / ${ffC.toFixed(1)} Hz, rolloff ${d.rolloff85Hz} / ${ffR.toFixed(1)} Hz`,
			);
			expect(
				Math.abs(d.centroidHz - ffC) / ffC,
				`${name}: centroid ${d.centroidHz} vs ffmpeg ${ffC}`,
			).toBeLessThan(0.03);
			expect(
				Math.abs(d.rolloff85Hz - ffR) / ffR,
				`${name}: rolloff ${d.rolloff85Hz} vs ffmpeg ${ffR}`,
			).toBeLessThan(0.03);
		});

		it('integrated loudness, maximum momentary loudness and true peak match ebur128', () => {
			const n = SR * 3;
			const r = new Prng(23);
			const hit = new Float32Array(n);
			const right = new Float32Array(n);
			for (let i = 0; i < n; i++) {
				const t = i / SR;
				const env = t < 0.5 ? 0.05 : 0.05 + 0.8 * Math.exp(-(t - 0.5) / 0.3);
				hit[i] = env * (0.6 * r.uniform() + 0.4 * Math.sin(2 * Math.PI * 180 * t));
				right[i] = 0.7 * hit[i]! + 0.1 * r.uniform() * env;
			}
			// raised-cosine edges (10 ms), as the audio-dsp oracle does, so a step does not dominate the true peak
			const fade = Math.round(0.01 * SR);
			for (const c of [hit, right])
				for (let i = 0; i < fade; i++) {
					const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
					c[i]! *= g;
					c[n - 1 - i]! *= g;
				}
			const wav = write('loudness', [hit, right]);
			const frames = metadataFrames(ff, wav, 'ebur128=peak=true:metadata=1:framelog=quiet');
			const last = frames[frames.length - 1]!;
			const ffI = last['r128.I']!;
			const ffM = Math.max(...frames.slice(3).map((f) => f['r128.M']!));
			const ffTp = 20 * Math.log10(Math.max(...frames.map((f) => f['r128.true_peak'] ?? 0)));
			const d = analyzeSound([hit, right], SR);
			rows.push(
				`loudness: I ${d.integratedLufs} / ${ffI} LUFS, max M ${d.maxMomentaryLufs} / ${ffM} LUFS, TP ${d.truePeakDb} / ${ffTp.toFixed(2)} dBTP`,
			);
			expect(Math.abs(d.integratedLufs! - ffI)).toBeLessThanOrEqual(0.1);
			expect(Math.abs(d.maxMomentaryLufs! - ffM)).toBeLessThanOrEqual(0.1);
			// ffmpeg's per-frame true peak has three decimals (linear): ±0.01 dB at this level, inside the tolerance
			expect(Math.abs(d.truePeakDb! - ffTp)).toBeLessThanOrEqual(0.2);
		});
	},
);
