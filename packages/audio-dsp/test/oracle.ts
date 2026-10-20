// Ported from FilmCraft crates/audio-dsp/tests/loudness_oracle.rs and extended.
//
// Each signal is written as a 32-bit float WAV with our own `encodeWav` (WAVE_FORMAT_EXTENSIBLE, channel mask 0x3F
// for 5.1) and measured twice, concurrently: by `LoudnessMeter` (fed in 100 ms blocks) and by
// `ffmpeg -nostats -i file -af ebur128=peak=true+sample:metadata=1:framelog=quiet,ametadata=mode=print:file=- -f null -`
// (three decimals per 100 ms frame on stdout; the one-decimal end-of-stream summary on stderr is parsed as a
// cross-check). The programme edges get a 10 ms raised-cosine fade so a hard start/stop step (whose reconstruction
// genuinely overshoots, and which ffmpeg's and our interpolators resolve differently) does not dominate the true
// peak; it changes M/S/I/LRA by < 0.001 LU.
//
// Tolerances: momentary / short-term (every frame where ffmpeg reads above −70 LUFS, once 400 ms / 3 s have been
// seen), their maxima, integrated loudness and LRA ±0.1 LU; true peak and sample peak ±0.1 dB. Published values:
// Tech 3341 ±0.1 LU (M, S, I) and +0.2/−0.4 dB (true peak); Tech 3342 ±1 LU (LRA).
//
// ffmpeg is found as $JASPER_FFMPEG, else <repo>/vendor/ffmpeg-lgpl/linux-x64/ffmpeg (LD_LIBRARY_PATH = its
// directory), else `ffmpeg` on PATH; the suites are skipped when none works.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { encodeWav, LoudnessMeter } from '../src/index.ts';
import { fadeEdges } from './util.ts';

export const TOL_LU = 0.1;
export const TOL_DB = 0.1;

export type Ffmpeg = { bin: string; env: NodeJS.ProcessEnv };

function tryFfmpeg(bin: string, libDir?: string): Ffmpeg | null {
	const env = { ...process.env };
	if (libDir) env.LD_LIBRARY_PATH = libDir + (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : '');
	const r = spawnSync(bin, ['-hide_banner', '-filters'], { env, encoding: 'utf8', timeout: 20000 });
	if (r.status !== 0 || !/\bebur128\b/.test(r.stdout) || !/\bametadata\b/.test(r.stdout)) return null;
	return { bin, env };
}

export function findFfmpeg(): Ffmpeg | null {
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

type Frame = { m: number; s: number; i: number; lra: number; tp: number; sp: number };
type FfResult = {
	frames: Frame[];
	summary: { i: number; lra: number; samplePeak: number; truePeak: number };
	layout: string;
};

function runEbur128(ff: Ffmpeg, wav: string): Promise<FfResult> {
	const args = [
		'-hide_banner',
		'-nostats',
		'-i',
		wav,
		'-af',
		'ebur128=peak=true+sample:metadata=1:framelog=quiet,ametadata=mode=print:file=-',
		'-f',
		'null',
		'-',
	];
	return new Promise((resolve, reject) => {
		const p = spawn(ff.bin, args, { env: ff.env });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		p.stdout.on('data', (b: Buffer) => out.push(b));
		p.stderr.on('data', (b: Buffer) => err.push(b));
		p.on('error', reject);
		p.on('close', (code) => {
			const stderr = Buffer.concat(err).toString('utf8');
			if (code !== 0) reject(new Error(`ffmpeg failed: ${stderr}`));
			else resolve(parse(Buffer.concat(out).toString('utf8'), stderr));
		});
	});
}

function parse(stdout: string, err: string): FfResult {
	const frames: Frame[] = [];
	let cur: Frame | null = null;
	for (const line of stdout.split('\n')) {
		if (line.startsWith('frame:')) {
			cur = { m: Number.NaN, s: Number.NaN, i: Number.NaN, lra: Number.NaN, tp: Number.NaN, sp: Number.NaN };
			frames.push(cur);
			continue;
		}
		const m = /^lavfi\.r128\.([A-Za-z_]+)=(.*)$/.exec(line.trim());
		if (!cur || !m) continue;
		const raw = m[2].trim();
		const v = /^-inf/i.test(raw)
			? Number.NEGATIVE_INFINITY
			: /^\+?inf/i.test(raw)
				? Number.POSITIVE_INFINITY
				: Number.parseFloat(raw);
		if (m[1] === 'M') cur.m = v;
		else if (m[1] === 'S') cur.s = v;
		else if (m[1] === 'I') cur.i = v;
		else if (m[1] === 'LRA') cur.lra = v;
		else if (m[1] === 'true_peak') cur.tp = v;
		else if (m[1] === 'sample_peak') cur.sp = v;
	}
	// summary: "Integrated loudness: / I: -23.0 LUFS", "Loudness range: / LRA: 10.0 LU",
	// "Sample peak: / Peak: x dBFS", "True peak: / Peak: x dBFS"
	const num = (re: RegExp): number => {
		const mm = re.exec(err);
		return mm ? Number.parseFloat(mm[1]) : Number.NaN;
	};
	const summary = {
		i: num(/Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+|-inf) LUFS/),
		lra: num(/Loudness range:\s*\n\s*LRA:\s*(-?[\d.]+) LU/),
		samplePeak: num(/Sample peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf) dBFS/),
		truePeak: num(/True peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf) dBFS/),
	};
	const layout = /Audio: [^,]+, \d+ Hz, ([^,]+),/.exec(err)?.[1] ?? '?';
	return { frames, summary, layout };
}

type Ours = { m: number[]; s: number[]; meter: LoudnessMeter };

export function ours(ch: Float32Array[], sr: number): Ours {
	const meter = new LoudnessMeter(sr, ch.length);
	const block = Math.round(sr / 10);
	const n = ch[0].length;
	const m: number[] = [];
	const s: number[] = [];
	for (let pos = 0; pos < n; pos += block) {
		meter.process(ch, pos, Math.min(block, n - pos));
		m.push(meter.momentary());
		s.push(meter.shortTerm());
	}
	return { m, s, meter };
}

export type Expect = {
	i?: number;
	m?: number;
	s?: number;
	lra?: number;
	lraTol?: number;
	/** True peak (dBTP), Tech 3341 tolerance +0.2 / −0.4 dB. */
	tp?: number;
	src: string;
};

type Vals = { i: number; lra: number; m: number; s: number; tp: number; sp: number };

export type Row = {
	name: string;
	sr: number;
	nch: number;
	ours: Vals;
	ff: Vals;
	sum: { i: number; lra: number; tp: number; sp: number };
	dM: number;
	dS: number;
	o: Ours;
	exp?: Expect;
};

export class Oracle {
	readonly rows: Row[] = [];
	private tmp = '';

	constructor(readonly ff: Ffmpeg) {}

	async compare(name: string, input: Float32Array[], sr: number, exp?: Expect): Promise<Row> {
		if (!this.tmp) this.tmp = mkdtempSync(join(tmpdir(), 'jasper-audio-dsp-oracle-'));
		const ch = input.map((c) => fadeEdges(c, sr));
		const wav = join(this.tmp, `${name.replace(/[^\w.-]+/g, '_')}_${sr}.wav`);
		writeFileSync(wav, encodeWav(ch, sr, 'f32'));
		const pending = runEbur128(this.ff, wav);
		const o = ours(ch, sr);
		const f = await pending;
		rmSync(wav, { force: true });
		expect(f.frames.length, `${name}: ffmpeg frames vs our blocks`).toBe(o.m.length);
		if (ch.length === 6) expect(f.layout, `${name}: ffmpeg channel layout`).toBe('5.1');
		let dM = 0;
		let dS = 0;
		let nM = 0;
		let ffMaxM = Number.NEGATIVE_INFINITY;
		let ffMaxS = Number.NEGATIVE_INFINITY;
		f.frames.forEach((fr, k) => {
			if (k >= 3) {
				if (!Number.isNaN(fr.m)) ffMaxM = Math.max(ffMaxM, fr.m);
				if (fr.m > -70) {
					const d = Math.abs(fr.m - o.m[k]);
					expect(
						d,
						`${name}: momentary at ${(k + 1) / 10} s: ffmpeg ${fr.m}, ours ${o.m[k]}`,
					).toBeLessThanOrEqual(TOL_LU);
					dM = Math.max(dM, d);
					nM++;
				}
			}
			if (k >= 29) {
				if (!Number.isNaN(fr.s)) ffMaxS = Math.max(ffMaxS, fr.s);
				if (fr.s > -70) {
					const d = Math.abs(fr.s - o.s[k]);
					expect(
						d,
						`${name}: short-term at ${(k + 1) / 10} s: ffmpeg ${fr.s}, ours ${o.s[k]}`,
					).toBeLessThanOrEqual(TOL_LU);
					dS = Math.max(dS, d);
				}
			}
		});
		expect(nM, `${name}: no momentary values compared`).toBeGreaterThan(0);
		const last = f.frames[f.frames.length - 1];
		const m = o.meter;
		const r: Row = {
			name,
			sr,
			nch: ch.length,
			ours: {
				i: m.integrated(),
				lra: m.loudnessRange(),
				m: m.maxMomentary(),
				s: m.maxShortTerm(),
				tp: m.truePeakDb(),
				sp: m.samplePeakDb(),
			},
			ff: {
				i: last.i,
				lra: last.lra,
				m: ffMaxM,
				s: ffMaxS,
				tp: 20 * Math.log10(last.tp),
				sp: 20 * Math.log10(last.sp),
			},
			sum: { i: f.summary.i, lra: f.summary.lra, tp: f.summary.truePeak, sp: f.summary.samplePeak },
			dM,
			dS,
			o,
			exp,
		};
		this.rows.push(r);
		const near = (a: number, b: number, tol: number, what: string): void => {
			expect(Math.abs(a - b), `${name}: ${what} ours ${a} vs ffmpeg ${b}`).toBeLessThanOrEqual(tol);
		};
		near(r.ours.i, r.ff.i, TOL_LU, 'I');
		near(r.ours.lra, r.ff.lra, TOL_LU, 'LRA');
		near(r.ours.m, r.ff.m, TOL_LU, 'max M');
		if (Number.isFinite(r.ff.s) || Number.isFinite(r.ours.s)) near(r.ours.s, r.ff.s, TOL_LU, 'max S');
		// ffmpeg's per-frame peaks are linear with three decimals (0.022 ≙ −33.15 dB for a −33 dBFS peak): where that
		// step is coarser than the one-decimal dB summary, the summary is the reference. The tolerance adds half the
		// reference's quantisation step.
		const peakRef = (lin: number, sumDb: number): { v: number; q: number } => {
			const q = (20 * Math.log10((lin + 0.0005) / Math.max(lin - 0.0005, 1e-9))) / 2;
			return q <= 0.05 || !Number.isFinite(sumDb) ? { v: 20 * Math.log10(lin), q } : { v: sumDb, q: 0.05 };
		};
		const tpRef = peakRef(last.tp, r.sum.tp);
		const spRef = peakRef(last.sp, r.sum.sp);
		r.ff.tp = tpRef.v;
		r.ff.sp = spRef.v;
		near(r.ours.tp, tpRef.v, TOL_DB + tpRef.q, 'true peak');
		near(r.ours.sp, spRef.v, TOL_DB + spRef.q, 'sample peak');
		if (r.ff.i > -70) expect(Math.abs(r.sum.i - r.ff.i), `${name}: summary I`).toBeLessThanOrEqual(0.051);
		expect(Math.abs(r.sum.lra - r.ff.lra), `${name}: summary LRA`).toBeLessThanOrEqual(0.051);
		expect(Math.abs(r.sum.tp - r.ff.tp), `${name}: summary TP`).toBeLessThanOrEqual(0.051 + tpRef.q);
		if (exp) {
			const at = `${name} (${exp.src})`;
			const both = (key: 'i' | 'm' | 's' | 'lra', want: number, tol: number): void => {
				expect(
					Math.abs(r.ours[key] - want),
					`${at}: ${key} ours ${r.ours[key]} vs ${want}`,
				).toBeLessThanOrEqual(tol);
				expect(
					Math.abs(r.ff[key] - want),
					`${at}: ${key} ffmpeg ${r.ff[key]} vs ${want}`,
				).toBeLessThanOrEqual(tol);
			};
			if (exp.i !== undefined) both('i', exp.i, TOL_LU);
			if (exp.m !== undefined) both('m', exp.m, TOL_LU);
			if (exp.s !== undefined) both('s', exp.s, TOL_LU);
			if (exp.lra !== undefined) both('lra', exp.lra, exp.lraTol ?? 1);
			if (exp.tp !== undefined) {
				for (const [who, v] of [
					['ours', r.ours.tp],
					['ffmpeg', r.ff.tp],
				] as const) {
					expect(v - exp.tp, `${at}: TP ${who} ${v} vs ${exp.tp}`).toBeLessThanOrEqual(0.2);
					expect(v - exp.tp, `${at}: TP ${who} ${v} vs ${exp.tp}`).toBeGreaterThanOrEqual(-0.4);
				}
			}
		}
		return r;
	}

	finish(title: string): void {
		if (this.tmp) rmSync(this.tmp, { recursive: true, force: true });
		if (this.rows.length === 0) return;
		const fmt = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : String(v));
		const ex = (v: number | undefined): string => (v === undefined ? '—' : fmt(v, 2));
		const lines = [
			`### ${title}`,
			'| signal | fs | ch | I ours / ffmpeg / exp | LRA ours / ffmpeg / exp | M max ours / ffmpeg / exp | S max ours / ffmpeg / exp | TP ours / ffmpeg / exp | SP ours / ffmpeg | frame max ΔM / ΔS |',
			`|${'---|'.repeat(10)}`,
		];
		for (const r of this.rows) {
			const e = r.exp;
			lines.push(
				`| ${r.name} | ${r.sr} | ${r.nch} | ${fmt(r.ours.i, 3)} / ${fmt(r.ff.i, 3)} / ${ex(e?.i)} | ${fmt(r.ours.lra)} / ${fmt(r.ff.lra)} / ${ex(e?.lra)} | ${fmt(r.ours.m, 3)} / ${fmt(r.ff.m, 3)} / ${ex(e?.m)} | ${fmt(r.ours.s, 3)} / ${fmt(r.ff.s, 3)} / ${ex(e?.s)} | ${fmt(r.ours.tp, 3)} / ${fmt(r.ff.tp, 3)} / ${ex(e?.tp)} | ${fmt(r.ours.sp, 3)} / ${fmt(r.ff.sp, 3)} | ${fmt(r.dM, 3)} / ${fmt(r.dS, 3)} |`,
			);
		}
		const worst = (f: (r: Row) => number): string => fmt(Math.max(...this.rows.map(f)), 3);
		lines.push(
			'',
			`worst |Δ| vs ffmpeg: frame M ${worst((r) => r.dM)}, frame S ${worst((r) => r.dS)}, I ${worst((r) => (Number.isFinite(r.ours.i) ? Math.abs(r.ours.i - r.ff.i) : 0))}, LRA ${worst((r) => Math.abs(r.ours.lra - r.ff.lra))}, M max ${worst((r) => Math.abs(r.ours.m - r.ff.m))}, S max ${worst((r) => (Number.isFinite(r.ours.s) ? Math.abs(r.ours.s - r.ff.s) : 0))} LU; TP ${worst((r) => Math.abs(r.ours.tp - r.ff.tp))} dB, SP ${worst((r) => Math.abs(r.ours.sp - r.ff.sp))} dB`,
		);
		console.log(`\n${lines.join('\n')}\n`);
	}
}

export const dual = (x: Float32Array): Float32Array[] => [x, x.slice()];
